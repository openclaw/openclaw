/**
 * WeCom Agent API 客户端
 * 管理 AccessToken 缓存和 API 调用
 */

import crypto from "node:crypto";
import { API_ENDPOINTS, LIMITS } from "../types/constants.js";
import type { ResolvedAgentAccount } from "../types/index.js";
import { readResponseBodyAsBuffer, wecomFetch } from "../http.js";
import { resolveWecomEgressProxyUrlFromNetwork } from "../config/index.js";

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
    const cacheKey = `${agent.corpId}:${agent.agentId}`;
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
export async function sendWecomAgentText(params: {
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
            agentid: agent.agentId,
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

export { sendWecomAgentText as sendText };

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
    const token = await getAccessToken(agent);
    // 添加 debug=1 参数获取更多错误信息
    const url = `${API_ENDPOINTS.UPLOAD_MEDIA}?access_token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}&debug=1`;

    // DEBUG: 输出上传信息
    console.log(`[wecom-upload] Uploading media: type=${type}, filename=${filename}, size=${buffer.length} bytes`);

    // 手动构造 multipart/form-data 请求体
    // 企业微信要求包含 filename 和 filelength
    const boundary = `----WebKitFormBoundary${crypto.randomBytes(16).toString("hex")}`;

    // 根据文件类型设置 Content-Type
    const contentTypeMap: Record<string, string> = {
        jpg: "image/jpg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
        bmp: "image/bmp", amr: "voice/amr", mp4: "video/mp4",
    };
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const fileContentType = contentTypeMap[ext] || "application/octet-stream";

    // 构造 multipart body
    const header = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="media"; filename="${filename}"; filelength=${buffer.length}\r\n` +
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
    }, { proxyUrl: resolveWecomEgressProxyUrlFromNetwork(agent.network), timeoutMs: LIMITS.REQUEST_TIMEOUT_MS });
    const json = await res.json() as { media_id?: string; errcode?: number; errmsg?: string };

    // DEBUG: 输出完整响应
    console.log(`[wecom-upload] Response:`, JSON.stringify(json));

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
            agentid: agent.agentId,
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
