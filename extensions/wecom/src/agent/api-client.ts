/**
 * WeCom Agent API 客户端
 * 管理 AccessToken 缓存和 API 调用
 */

import crypto from "node:crypto";
import { API_ENDPOINTS, LIMITS } from "../types/constants.js";
import type { ResolvedAgentAccount } from "../types/index.js";
import { readResponseBodyAsBuffer, wecomFetch } from "../http.js";

function resolveWecomEgressProxyUrlFromNetwork(network: any): string | undefined {
    return network?.egressProxyUrl;
}

/**
 * **TokenCache (AccessToken 缓存结构)**
 * 
 * 用于缓存企业微信 API 调用所需的 AccessToken。
 * @property token 缓存的 Token 字符串
 * @property expiresAt 过期时间戳 (ms)
 * @property refreshPromise 当前正在进行的刷新 Promise (防止并发刷新)
 */
type TokenCache = {
    token: string;
    expiresAt: number;
    refreshPromise: Promise<string> | null;
};

const tokenCaches = new Map<string, TokenCache>();

function normalizeUploadFilename(filename: string): string {
    const trimmed = filename.trim();
    if (!trimmed) return "file.bin";
    const ext = trimmed.includes(".") ? `.${trimmed.split(".").pop()!.toLowerCase()}` : "";
    const base = ext ? trimmed.slice(0, -ext.length) : trimmed;
    const sanitizedBase = base
        .replace(/[^\x20-\x7e]/g, "_")
        .replace(/["\\\/;=]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    const safeBase = sanitizedBase || "file";
    const safeExt = ext.replace(/[^a-z0-9.]/g, "");
    return `${safeBase}${safeExt || ".bin"}`;
}

function guessUploadContentType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const contentTypeMap: Record<string, string> = {
        // image
        jpg: "image/jpg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
        // audio / video
        amr: "voice/amr", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime",
        // documents
        txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json",
        xml: "application/xml", yaml: "application/yaml", yml: "application/yaml",
        pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        rtf: "application/rtf", odt: "application/vnd.oasis.opendocument.text",
        // archives
        zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed",
        gz: "application/gzip", tgz: "application/gzip", tar: "application/x-tar",
    };
    return contentTypeMap[ext] || "application/octet-stream";
}

function requireAgentId(agent: ResolvedAgentAccount): number {
    if (typeof agent.agentId === "number" && Number.isFinite(agent.agentId)) return agent.agentId;
    throw new Error(`wecom agent account=${agent.accountId} missing agentId; sending via cgi-bin/message/send requires agentId`);
}

/**
 * **getAccessToken (获取 AccessToken)**
 * 
 * 获取企业微信 API 调用所需的 AccessToken。
 * 具备自动缓存和过期刷新机制。
 * 
 * @param agent Agent 账号信息
 * @returns 有效的 AccessToken
 */
export async function getAccessToken(agent: ResolvedAgentAccount): Promise<string> {
    const cacheKey = `${agent.corpId}:${String(agent.agentId ?? "na")}`;
    let cache = tokenCaches.get(cacheKey);

    if (!cache) {
        cache = { token: "", expiresAt: 0, refreshPromise: null };
        tokenCaches.set(cacheKey, cache);
    }

    const now = Date.now();
    if (cache.token && cache.expiresAt > now + LIMITS.TOKEN_REFRESH_BUFFER_MS) {
        return cache.token;
    }

    // 防止并发刷新
    if (cache.refreshPromise) {
        return cache.refreshPromise;
    }

    cache.refreshPromise = (async () => {
        try {
            const url = `${API_ENDPOINTS.GET_TOKEN}?corpid=${encodeURIComponent(agent.corpId)}&corpsecret=${encodeURIComponent(agent.corpSecret)}`;
            const res = await wecomFetch(url, undefined, { proxyUrl: resolveWecomEgressProxyUrlFromNetwork(agent.network), timeoutMs: LIMITS.REQUEST_TIMEOUT_MS });
            const json = await res.json() as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };

            if (!json?.access_token) {
                throw new Error(`gettoken failed: ${json?.errcode} ${json?.errmsg}`);
            }

            cache!.token = json.access_token;
            cache!.expiresAt = Date.now() + (json.expires_in ?? 7200) * 1000;
            return cache!.token;
        } finally {
            cache!.refreshPromise = null;
        }
    })();

    return cache.refreshPromise;
}

/**
 * **sendText (发送文本消息)**
 * 
 * 调用 `message/send` (Agent) 或 `appchat/send` (群聊) 发送文本。
 * 
 * @param params.agent 发送方 Agent
 * @param params.toUser 接收用户 ID (单聊可选，可与 toParty/toTag 同时使用)
 * @param params.toParty 接收部门 ID (单聊可选)
 * @param params.toTag 接收标签 ID (单聊可选)
 * @param params.chatId 接收群 ID (群聊模式必填，互斥)
 * @param params.text 消息内容
 */
export async function sendText(params: {
    agent: ResolvedAgentAccount;
    toUser?: string;
    toParty?: string;
    toTag?: string;
    chatId?: string;
    text: string;
}): Promise<void> {
    const { agent, toUser, toParty, toTag, chatId, text } = params;
    const token = await getAccessToken(agent);

    const useChat = Boolean(chatId);
    const url = useChat
        ? `${API_ENDPOINTS.SEND_APPCHAT}?access_token=${encodeURIComponent(token)}`
        : `${API_ENDPOINTS.SEND_MESSAGE}?access_token=${encodeURIComponent(token)}`;

    const body = useChat
        ? { chatid: chatId, msgtype: "text", text: { content: text } }
        : {
            touser: toUser,
            toparty: toParty,
            totag: toTag,
            msgtype: "text",
            agentid: requireAgentId(agent),
            text: { content: text }
        };

    const res = await wecomFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }, { proxyUrl: resolveWecomEgressProxyUrlFromNetwork(agent.network), timeoutMs: LIMITS.REQUEST_TIMEOUT_MS });
    const json = await res.json() as {
        errcode?: number;
        errmsg?: string;
        invaliduser?: string;
        invalidparty?: string;
        invalidtag?: string;
    };

    if (json?.errcode !== 0) {
        throw new Error(`send failed: ${json?.errcode} ${json?.errmsg}`);
    }

    if (json?.invaliduser || json?.invalidparty || json?.invalidtag) {
        const details = [
            json.invaliduser ? `invaliduser=${json.invaliduser}` : "",
            json.invalidparty ? `invalidparty=${json.invalidparty}` : "",
            json.invalidtag ? `invalidtag=${json.invalidtag}` : ""
        ].filter(Boolean).join(", ");
        throw new Error(`send partial failure: ${details}`);
    }
}

/**
 * **uploadMedia (上传媒体文件)**
 * 
 * 上传临时素材到企业微信。
 * 素材有效期为 3 天。
 * 
 * @param params.type 媒体类型 (image, voice, video, file)
 * @param params.buffer 文件二进制数据
 * @param params.filename 文件名 (需包含正确扩展名)
 * @returns 媒体 ID (media_id)
 */
export async function uploadMedia(params: {
    agent: ResolvedAgentAccount;
    type: "image" | "voice" | "video" | "file";
    buffer: Buffer;
    filename: string;
}): Promise<string> {
    const { agent, type, buffer, filename } = params;
    const safeFilename = normalizeUploadFilename(filename);
    const token = await getAccessToken(agent);
    const proxyUrl = resolveWecomEgressProxyUrlFromNetwork(agent.network);
    // 添加 debug=1 参数获取更多错误信息
    const url = `${API_ENDPOINTS.UPLOAD_MEDIA}?access_token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}&debug=1`;

    // DEBUG: 输出上传信息
    console.log(`[wecom-upload] Uploading media: type=${type}, filename=${safeFilename}, size=${buffer.length} bytes`);

    const uploadOnce = async (fileContentType: string) => {
        // 手动构造 multipart/form-data 请求体
        // 企业微信要求包含 filename 和 filelength
        const boundary = `----WebKitFormBoundary${crypto.randomBytes(16).toString("hex")}`;

        const header = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="media"; filename="${safeFilename}"; filelength=${buffer.length}\r\n` +
            `Content-Type: ${fileContentType}\r\n\r\n`
        );
        const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([header, buffer, footer]);

        console.log(`[wecom-upload] Multipart body size=${body.length}, boundary=${boundary}, fileContentType=${fileContentType}`);

        const res = await wecomFetch(url, {
            method: "POST",
            headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": String(body.length),
            },
            body: body,
        }, { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS });
        const json = await res.json() as { media_id?: string; errcode?: number; errmsg?: string };
        console.log(`[wecom-upload] Response:`, JSON.stringify(json));
        return json;
    };

    const preferredContentType = guessUploadContentType(safeFilename);
    let json = await uploadOnce(preferredContentType);

    // 某些文件类型在严格网关/企业微信校验下可能失败，回退到通用类型再试一次。
    if (!json?.media_id && preferredContentType !== "application/octet-stream") {
        console.warn(
            `[wecom-upload] Upload failed with ${preferredContentType}, retrying as application/octet-stream: ${json?.errcode} ${json?.errmsg}`,
        );
        json = await uploadOnce("application/octet-stream");
    }

    if (!json?.media_id) {
        throw new Error(`upload failed: ${json?.errcode} ${json?.errmsg}`);
    }
    return json.media_id;
}

/**
 * **sendMedia (发送媒体消息)**
 * 
 * 发送图片、音频、视频或文件。需先通过 `uploadMedia` 获取 media_id。
 * 
 * @param params.agent 发送方 Agent
 * @param params.toUser 接收用户 ID (单聊可选)
 * @param params.toParty 接收部门 ID (单聊可选)
 * @param params.toTag 接收标签 ID (单聊可选)
 * @param params.chatId 接收群 ID (群聊模式必填)
 * @param params.mediaId 媒体 ID
 * @param params.mediaType 媒体类型
 * @param params.title 视频标题 (可选)
 * @param params.description 视频描述 (可选)
 */
export async function sendMedia(params: {
    agent: ResolvedAgentAccount;
    toUser?: string;
    toParty?: string;
    toTag?: string;
    chatId?: string;
    mediaId: string;
    mediaType: "image" | "voice" | "video" | "file";
    title?: string;
    description?: string;
}): Promise<void> {
    const { agent, toUser, toParty, toTag, chatId, mediaId, mediaType, title, description } = params;
    const token = await getAccessToken(agent);

    const useChat = Boolean(chatId);
    const url = useChat
        ? `${API_ENDPOINTS.SEND_APPCHAT}?access_token=${encodeURIComponent(token)}`
        : `${API_ENDPOINTS.SEND_MESSAGE}?access_token=${encodeURIComponent(token)}`;

    const mediaPayload = mediaType === "video"
        ? { media_id: mediaId, title: title ?? "Video", description: description ?? "" }
        : { media_id: mediaId };

    const body = useChat
        ? { chatid: chatId, msgtype: mediaType, [mediaType]: mediaPayload }
        : {
            touser: toUser,
            toparty: toParty,
            totag: toTag,
            msgtype: mediaType,
            agentid: requireAgentId(agent),
            [mediaType]: mediaPayload
        };

    const res = await wecomFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }, { proxyUrl: resolveWecomEgressProxyUrlFromNetwork(agent.network), timeoutMs: LIMITS.REQUEST_TIMEOUT_MS });
    const json = await res.json() as {
        errcode?: number;
        errmsg?: string;
        invaliduser?: string;
        invalidparty?: string;
        invalidtag?: string;
    };

    if (json?.errcode !== 0) {
        throw new Error(`send ${mediaType} failed: ${json?.errcode} ${json?.errmsg}`);
    }

    if (json?.invaliduser || json?.invalidparty || json?.invalidtag) {
        const details = [
            json.invaliduser ? `invaliduser=${json.invaliduser}` : "",
            json.invalidparty ? `invalidparty=${json.invalidparty}` : "",
            json.invalidtag ? `invalidtag=${json.invalidtag}` : ""
        ].filter(Boolean).join(", ");
        throw new Error(`send ${mediaType} partial failure: ${details}`);
    }
}

/**
 * **downloadMedia (下载媒体文件)**
 * 
 * 通过 media_id 从企业微信服务器下载临时素材。
 * 
 * @returns { buffer, contentType }
 */
export async function downloadMedia(params: {
    agent: ResolvedAgentAccount;
    mediaId: string;
    maxBytes?: number;
}): Promise<{ buffer: Buffer; contentType: string; filename?: string }> {
    const { agent, mediaId } = params;
    const token = await getAccessToken(agent);
    const url = `${API_ENDPOINTS.DOWNLOAD_MEDIA}?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`;

    const res = await wecomFetch(url, undefined, { proxyUrl: resolveWecomEgressProxyUrlFromNetwork(agent.network), timeoutMs: LIMITS.REQUEST_TIMEOUT_MS });

    if (!res.ok) {
        throw new Error(`download failed: ${res.status}`);
    }

    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const disposition = res.headers.get("content-disposition") || "";
    const filename = (() => {
        // 兼容：filename="a.md" / filename=a.md / filename*=UTF-8''a%2Eb.md
        const mStar = disposition.match(/filename\*\s*=\s*([^;]+)/i);
        if (mStar) {
            const raw = mStar[1]!.trim().replace(/^"(.*)"$/, "$1");
            const parts = raw.split("''");
            const encoded = parts.length === 2 ? parts[1]! : raw;
            try {
                return decodeURIComponent(encoded);
            } catch {
                return encoded;
            }
        }
        const m = disposition.match(/filename\s*=\s*([^;]+)/i);
        if (!m) return undefined;
        return m[1]!.trim().replace(/^"(.*)"$/, "$1") || undefined;
    })();

    // 检查是否返回了错误 JSON
    if (contentType.includes("application/json")) {
        const json = await res.json() as { errcode?: number; errmsg?: string };
        throw new Error(`download failed: ${json?.errcode} ${json?.errmsg}`);
    }

    const buffer = await readResponseBodyAsBuffer(res, params.maxBytes);
    return { buffer, contentType, filename };
}
