/**
 * WeCom Agent Webhook 处理器
 * 处理 XML 格式回调
 */

import { pathToFileURL } from "node:url";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import type { ResolvedAgentAccount } from "../types/index.js";
import { LIMITS } from "../types/constants.js";
import { decryptWecomEncrypted, verifyWecomSignature, computeWecomMsgSignature, encryptWecomPlaintext } from "../crypto/index.js";
import { extractEncryptFromXml, buildEncryptedXmlResponse } from "../crypto/xml.js";
import { parseXml, extractMsgType, extractFromUser, extractContent, extractChatId, extractMediaId, extractMsgId, extractFileName } from "../shared/xml-parser.js";
import { sendText, downloadMedia } from "./api-client.js";
import { getWecomRuntime } from "../runtime.js";
import type { WecomAgentInboundMessage } from "../types/index.js";
import { buildWecomUnauthorizedCommandPrompt, resolveWecomCommandAuthorization } from "../shared/command-auth.js";
import { resolveWecomMediaMaxBytes } from "../config/index.js";
import { generateAgentId, shouldUseDynamicAgent, ensureDynamicAgentListed } from "../dynamic-agent.js";

/** 错误提示信息 */
const ERROR_HELP = "\n\n遇到问题？联系作者: YanHaidao (微信: YanHaidao)";

// Agent webhook 幂等去重池（防止企微回调重试导致重复回复）
// 注意：这是进程内内存去重，重启会清空；但足以覆盖企微的短周期重试。
const RECENT_MSGID_TTL_MS = 10 * 60 * 1000;
const recentAgentMsgIds = new Map<string, number>();

function rememberAgentMsgId(msgId: string): boolean {
    const now = Date.now();
    const existing = recentAgentMsgIds.get(msgId);
    if (existing && now - existing < RECENT_MSGID_TTL_MS) return false;
    recentAgentMsgIds.set(msgId, now);
    // 简单清理：只在写入时做一次线性 prune，避免无界增长
    for (const [k, ts] of recentAgentMsgIds) {
        if (now - ts >= RECENT_MSGID_TTL_MS) recentAgentMsgIds.delete(k);
    }
    return true;
}

function looksLikeTextFile(buffer: Buffer): boolean {
    const sampleSize = Math.min(buffer.length, 4096);
    if (sampleSize === 0) return true;
    let bad = 0;
    for (let i = 0; i < sampleSize; i++) {
        const b = buffer[i]!;
        const isWhitespace = b === 0x09 || b === 0x0a || b === 0x0d; // \t \n \r
        const isPrintable = b >= 0x20 && b !== 0x7f;
        if (!isWhitespace && !isPrintable) bad++;
    }
    // 非可打印字符占比太高，基本可判断为二进制
    return bad / sampleSize <= 0.02;
}

function analyzeTextHeuristic(buffer: Buffer): { sampleSize: number; badCount: number; badRatio: number } {
    const sampleSize = Math.min(buffer.length, 4096);
    if (sampleSize === 0) return { sampleSize: 0, badCount: 0, badRatio: 0 };
    let badCount = 0;
    for (let i = 0; i < sampleSize; i++) {
        const b = buffer[i]!;
        const isWhitespace = b === 0x09 || b === 0x0a || b === 0x0d;
        const isPrintable = b >= 0x20 && b !== 0x7f;
        if (!isWhitespace && !isPrintable) badCount++;
    }
    return { sampleSize, badCount, badRatio: badCount / sampleSize };
}

function previewHex(buffer: Buffer, maxBytes = 32): string {
    const n = Math.min(buffer.length, maxBytes);
    if (n <= 0) return "";
    return buffer
        .subarray(0, n)
        .toString("hex")
        .replace(/(..)/g, "$1 ")
        .trim();
}

function buildTextFilePreview(buffer: Buffer, maxChars: number): string | undefined {
    if (!looksLikeTextFile(buffer)) return undefined;
    const text = buffer.toString("utf8");
    if (!text.trim()) return undefined;
    const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}\n…(已截断)` : text;
    return truncated;
}

/**
 * **AgentWebhookParams (Webhook 处理器参数)**
 * 
 * 传递给 Agent Webhook 处理函数的上下文参数集合。
 * @property req Node.js 原始请求对象
 * @property res Node.js 原始响应对象
 * @property agent 解析后的 Agent 账号信息
 * @property config 全局插件配置
 * @property core OpenClaw 插件运行时
 * @property log 可选日志输出函数
 * @property error 可选错误输出函数
 */
export type AgentWebhookParams = {
    req: IncomingMessage;
    res: ServerResponse;
    agent: ResolvedAgentAccount;
    config: OpenClawConfig;
    core: PluginRuntime;
    log?: (msg: string) => void;
    error?: (msg: string) => void;
};

/**
 * **resolveQueryParams (解析查询参数)**
 * 
 * 辅助函数：从 IncomingMessage 中解析 URL 查询字符串，用于获取签名、时间戳等参数。
 */
function resolveWecomAgentQueryParams(req: IncomingMessage): URLSearchParams {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams;
}

/**
 * **readRawBody (读取原始请求体)**
 * 
 * 异步读取 HTTP POST 请求的原始 BODY 数据（XML 字符串）。
 * 包含最大体积限制检查，防止内存溢出攻击。
 */
async function readWecomAgentRawBody(req: IncomingMessage, maxSize: number = LIMITS.MAX_REQUEST_BODY_SIZE): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxSize) {
                reject(new Error("Request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
        });

        req.on("error", reject);
    });
}

/**
 * **handleUrlVerification (处理 URL 验证)**
 * 
 * 处理企业微信 Agent 配置时的 GET 请求验证。
 * 流程：
 * 1. 验证 msg_signature 签名。
 * 2. 解密 echostr 参数。
 * 3. 返回解密后的明文 echostr。
 */
async function handleUrlVerification(
    req: IncomingMessage,
    res: ServerResponse,
    agent: ResolvedAgentAccount,
): Promise<boolean> {
    const query = resolveWecomAgentQueryParams(req);
    const timestamp = query.get("timestamp") ?? "";
    const nonce = query.get("nonce") ?? "";
    const echostr = query.get("echostr") ?? "";
    const signature = query.get("msg_signature") ?? "";
    const remote = req.socket?.remoteAddress ?? "unknown";

    // 不输出敏感参数内容，仅输出存在性
    // 用于排查：是否有请求打到 /wecom/agent
    // 以及是否带齐 timestamp/nonce/msg_signature/echostr
    // eslint-disable-next-line no-unused-vars
    const _debug = { remote, hasTimestamp: Boolean(timestamp), hasNonce: Boolean(nonce), hasSig: Boolean(signature), hasEchostr: Boolean(echostr) };

    const valid = verifyWecomSignature({
        token: agent.token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature,
    });

    if (!valid) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(`unauthorized - 签名验证失败，请检查 Token 配置${ERROR_HELP}`);
        return true;
    }

    try {
        const plain = decryptWecomEncrypted({
            encodingAESKey: agent.encodingAESKey,
            receiveId: agent.corpId,
            encrypt: echostr,
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(plain);
        return true;
    } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(`decrypt failed - 解密失败，请检查 EncodingAESKey 配置${ERROR_HELP}`);
        return true;
    }
}

/**
 * 处理消息回调 (POST)
 */
async function handleMessageCallback(params: AgentWebhookParams): Promise<boolean> {
    const { req, res, agent, config, core, log, error } = params;

    try {
        log?.(`[wecom-agent] inbound: method=${req.method ?? "UNKNOWN"} remote=${req.socket?.remoteAddress ?? "unknown"}`);
        const rawXml = await readWecomAgentRawBody(req);
        log?.(`[wecom-agent] inbound: rawXmlBytes=${Buffer.byteLength(rawXml, "utf8")}`);
        const encrypted = extractEncryptFromXml(rawXml);
        log?.(`[wecom-agent] inbound: hasEncrypt=${Boolean(encrypted)} encryptLen=${encrypted ? String(encrypted).length : 0}`);

        const query = resolveWecomAgentQueryParams(req);
        const timestamp = query.get("timestamp") ?? "";
        const nonce = query.get("nonce") ?? "";
        const signature = query.get("msg_signature") ?? "";
        log?.(
            `[wecom-agent] inbound: query timestamp=${timestamp ? "yes" : "no"} nonce=${nonce ? "yes" : "no"} msg_signature=${signature ? "yes" : "no"}`,
        );

        // 验证签名
        const valid = verifyWecomSignature({
            token: agent.token,
            timestamp,
            nonce,
            encrypt: encrypted,
            signature,
        });

        if (!valid) {
            error?.(`[wecom-agent] inbound: signature invalid`);
            res.statusCode = 401;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(`unauthorized - 签名验证失败${ERROR_HELP}`);
            return true;
        }

        // 解密
        const decrypted = decryptWecomEncrypted({
            encodingAESKey: agent.encodingAESKey,
            receiveId: agent.corpId,
            encrypt: encrypted,
        });
        log?.(`[wecom-agent] inbound: decryptedBytes=${Buffer.byteLength(decrypted, "utf8")}`);

        // 解析 XML
        const msg = parseXml(decrypted);
        const msgType = extractMsgType(msg);
        const fromUser = extractFromUser(msg);
        const chatId = extractChatId(msg);
        const msgId = extractMsgId(msg);
        if (msgId) {
            const ok = rememberAgentMsgId(msgId);
            if (!ok) {
                log?.(`[wecom-agent] duplicate msgId=${msgId} from=${fromUser} chatId=${chatId ?? "N/A"} type=${msgType}; skipped`);
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end("success");
                return true;
            }
        }
        const content = String(extractContent(msg) ?? "");

        const preview = content.length > 100 ? `${content.slice(0, 100)}…` : content;
        log?.(`[wecom-agent] ${msgType} from=${fromUser} chatId=${chatId ?? "N/A"} msgId=${msgId ?? "N/A"} content=${preview}`);

        // 先返回 success (Agent 模式使用 API 发送回复，不用被动回复)
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("success");

        // 异步处理消息
        processAgentMessage({
            agent,
            config,
            core,
            fromUser,
            chatId,
            msgType,
            content,
            msg,
            log,
            error,
        }).catch((err) => {
            error?.(`[wecom-agent] process failed: ${String(err)}`);
        });

        return true;
    } catch (err) {
        error?.(`[wecom-agent] callback failed: ${String(err)}`);
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(`error - 回调处理失败${ERROR_HELP}`);
        return true;
    }
}

/**
 * **processAgentMessage (处理 Agent 消息)**
 * 
 * 异步处理解密后的消息内容，并触发 OpenClaw Agent。
 * 流程：
 * 1. 路由解析：根据 userid或群ID 确定 Agent 路由。
 * 2. 媒体处理：如果是图片/文件等，下载资源。
 * 3. 上下文构建：创建 Inbound Context。
 * 4. 会话记录：更新 Session 状态。
 * 5. 调度回复：将 Agent 的响应通过 `api-client` 发送回企业微信。
 */
async function processAgentMessage(params: {
    agent: ResolvedAgentAccount;
    config: OpenClawConfig;
    core: PluginRuntime;
    fromUser: string;
    chatId?: string;
    msgType: string;
    content: string;
    msg: WecomAgentInboundMessage;
    log?: (msg: string) => void;
    error?: (msg: string) => void;
}): Promise<void> {
    const { agent, config, core, fromUser, chatId, content, msg, msgType, log, error } = params;

    const isGroup = Boolean(chatId);
    const peerId = isGroup ? chatId! : fromUser;
    const mediaMaxBytes = resolveWecomMediaMaxBytes(config);

    // 处理媒体文件
    const attachments: any[] = []; // TODO: define specific type
    let finalContent = content;
    let mediaPath: string | undefined;
    let mediaType: string | undefined;

    if (["image", "voice", "video", "file"].includes(msgType)) {
        const mediaId = extractMediaId(msg);
        if (mediaId) {
            try {
                log?.(`[wecom-agent] downloading media: ${mediaId} (${msgType})`);
                const { buffer, contentType, filename: headerFileName } = await downloadMedia({ agent, mediaId, maxBytes: mediaMaxBytes });
                const xmlFileName = extractFileName(msg);
                const originalFileName = (xmlFileName || headerFileName || `${mediaId}.bin`).trim();
                const heuristic = analyzeTextHeuristic(buffer);

                // 推断文件名后缀
                const extMap: Record<string, string> = {
                    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
                    "audio/amr": "amr", "audio/speex": "speex", "video/mp4": "mp4",
                };
                const textPreview = msgType === "file" ? buildTextFilePreview(buffer, 12_000) : undefined;
                const looksText = Boolean(textPreview);
                const originalExt = path.extname(originalFileName).toLowerCase();
                const normalizedContentType =
                    looksText && originalExt === ".md" ? "text/markdown" :
                    looksText && (!contentType || contentType === "application/octet-stream")
                        ? "text/plain; charset=utf-8"
                        : contentType;

                const ext = extMap[normalizedContentType] || (looksText ? "txt" : "bin");
                const filename = `${mediaId}.${ext}`;

                log?.(
                    `[wecom-agent] file meta: msgType=${msgType} mediaId=${mediaId} size=${buffer.length} maxBytes=${mediaMaxBytes} ` +
                    `contentType=${contentType} normalizedContentType=${normalizedContentType} originalFileName=${originalFileName} ` +
                    `xmlFileName=${xmlFileName ?? "N/A"} headerFileName=${headerFileName ?? "N/A"} ` +
                    `textHeuristic(sample=${heuristic.sampleSize}, bad=${heuristic.badCount}, ratio=${heuristic.badRatio.toFixed(4)}) ` +
                    `headHex="${previewHex(buffer)}"`,
                );

                // 使用 Core SDK 保存媒体文件
                const saved = await core.channel.media.saveMediaBuffer(
                    buffer,
                    normalizedContentType,
                    "inbound", // context/scope
                    mediaMaxBytes, // limit
                    originalFileName
                );

                log?.(`[wecom-agent] media saved to: ${saved.path}`);
                mediaPath = saved.path;
                mediaType = normalizedContentType;

                // 构建附件
                attachments.push({
                    name: originalFileName,
                    mimeType: normalizedContentType,
                    url: pathToFileURL(saved.path).href, // 使用跨平台安全的文件 URL
                });

                // 更新文本提示
                if (textPreview) {
                    finalContent = [
                        content,
                        "",
                        "文件内容预览：",
                        "```",
                        textPreview,
                        "```",
                        `(已下载 ${buffer.length} 字节)`,
                    ].join("\n");
                } else {
                    if (msgType === "file") {
                        finalContent = [
                            content,
                            "",
                            `已收到文件：${originalFileName}`,
                            `文件类型：${normalizedContentType || contentType || "未知"}`,
                            "提示：当前仅对文本/Markdown/JSON/CSV/HTML/PDF（可选）做内容抽取；其他二进制格式请转为 PDF 或复制文本内容。",
                            `(已下载 ${buffer.length} 字节)`,
                        ].join("\n");
                    } else {
                        finalContent = `${content} (已下载 ${buffer.length} 字节)`;
                    }
                }
                log?.(`[wecom-agent] file preview: enabled=${looksText} finalContentLen=${finalContent.length} attachments=${attachments.length}`);
            } catch (err) {
                error?.(`[wecom-agent] media processing failed: ${String(err)}`);
                finalContent = [
                    content,
                    "",
                    `媒体处理失败：${String(err)}`,
                    `提示：可在 OpenClaw 配置中提高 channels.wecom.media.maxBytes（当前=${mediaMaxBytes}）`,
                    `例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
                ].join("\n");
            }
        } else {
            const keys = Object.keys((msg as unknown as Record<string, unknown>) ?? {}).slice(0, 50).join(",");
            error?.(`[wecom-agent] mediaId not found for ${msgType}; keys=${keys}`);
        }
    }

    // 解析路由
    const route = core.channel.routing.resolveAgentRoute({
        cfg: config,
        channel: "wecom",
        accountId: agent.accountId,
        peer: { kind: isGroup ? "group" : "dm", id: peerId },
    });

    // ===== 动态 Agent 路由注入 =====
    const useDynamicAgent = shouldUseDynamicAgent({
        chatType: isGroup ? "group" : "dm",
        senderId: fromUser,
        config,
    });

    if (useDynamicAgent) {
        const targetAgentId = generateAgentId(
            isGroup ? "group" : "dm",
            peerId
        );
        route.agentId = targetAgentId;
        route.sessionKey = `agent:${targetAgentId}:${isGroup ? "group" : "dm"}:${peerId}`;
        // 异步添加到 agents.list（不阻塞）
        ensureDynamicAgentListed(targetAgentId, core).catch(() => {});
        log?.(`[wecom-agent] dynamic agent routing: ${targetAgentId}, sessionKey=${route.sessionKey}`);
    }
    // ===== 动态 Agent 路由注入结束 =====

    // 构建上下文
    const fromLabel = isGroup ? `group:${peerId}` : `user:${fromUser}`;
    const storePath = core.channel.session.resolveStorePath(config.session?.store, {
        agentId: route.agentId,
    });
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
    const previousTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
    });
    const body = core.channel.reply.formatAgentEnvelope({
        channel: "WeCom",
        from: fromLabel,
        previousTimestamp,
        envelope: envelopeOptions,
        body: finalContent,
    });

    const authz = await resolveWecomCommandAuthorization({
        core,
        cfg: config,
        // Agent 门禁应读取 channels.wecom.agent.dm（即 agent.config.dm），而不是 channels.wecom.dm（不存在）
        accountConfig: agent.config as any,
        rawBody: finalContent,
        senderUserId: fromUser,
    });
    log?.(`[wecom-agent] authz: dmPolicy=${authz.dmPolicy} shouldCompute=${authz.shouldComputeAuth} sender=${fromUser.toLowerCase()} senderAllowed=${authz.senderAllowed} authorizerConfigured=${authz.authorizerConfigured} commandAuthorized=${String(authz.commandAuthorized)}`);

    // 命令门禁：未授权时必须明确回复（Agent 侧用私信提示）
    if (authz.shouldComputeAuth && authz.commandAuthorized !== true) {
        const prompt = buildWecomUnauthorizedCommandPrompt({ senderUserId: fromUser, dmPolicy: authz.dmPolicy, scope: "agent" });
        try {
            await sendText({ agent, toUser: fromUser, chatId: undefined, text: prompt });
            log?.(`[wecom-agent] unauthorized command: replied via DM to ${fromUser}`);
        } catch (err: unknown) {
            error?.(`[wecom-agent] unauthorized command reply failed: ${String(err)}`);
        }
        return;
    }

    const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: finalContent,
        CommandBody: finalContent,
        Attachments: attachments.length > 0 ? attachments : undefined,
        From: isGroup ? `wecom:group:${peerId}` : `wecom:${fromUser}`,
        To: `wecom:${peerId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        ConversationLabel: fromLabel,
        SenderName: fromUser,
        SenderId: fromUser,
        Provider: "wecom",
        Surface: "wecom",
        OriginatingChannel: "wecom",
        // 标记为 Agent 会话的回复路由目标，避免与 Bot 会话混淆：
        // - 用于让 /new /reset 这类命令回执不被 Bot 侧策略拦截
        // - 群聊场景也统一路由为私信触发者（与 deliver 策略一致）
        OriginatingTo: `wecom-agent:${fromUser}`,
        CommandAuthorized: authz.commandAuthorized ?? true,
        MediaPath: mediaPath,
        MediaType: mediaType,
        MediaUrl: mediaPath,
    });

    // 记录会话
    await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err: unknown) => {
            error?.(`[wecom-agent] session record failed: ${String(err)}`);
        },
    });

    // 调度回复
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: {
            deliver: async (payload: { text?: string }, info: { kind: string }) => {
                const text = payload.text ?? "";
                if (!text) return;

                try {
                    // 统一策略：Agent 模式在群聊场景默认只私信触发者（避免 wr/wc chatId 86008）
                    await sendText({ agent, toUser: fromUser, chatId: undefined, text });
                    log?.(`[wecom-agent] reply delivered (${info.kind}) to ${fromUser}`);
                } catch (err: unknown) {
                    error?.(`[wecom-agent] reply failed: ${String(err)}`);
                }
            },
            onError: (err: unknown, info: { kind: string }) => {
                error?.(`[wecom-agent] ${info.kind} reply error: ${String(err)}`);
            },
        },
        replyOptions: {
            disableBlockStreaming: true,
        },
    });
}

/**
 * **handleAgentWebhook (Agent Webhook 入口)**
 * 
 * 统一处理 Agent 模式的 Webhook 请求。
 * 根据 HTTP 方法分发到 URL 验证 (GET) 或 消息处理 (POST)。
 */
export async function handleAgentWebhook(params: AgentWebhookParams): Promise<boolean> {
    const { req } = params;

    if (req.method === "GET") {
        return handleUrlVerification(req, params.res, params.agent);
    }

    if (req.method === "POST") {
        return handleMessageCallback(params);
    }

    return false;
}
