import { pathToFileURL } from "node:url";
import crypto from "node:crypto";

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import type { ResolvedAgentAccount } from "../types/index.js";
import type { WecomInboundMessage, WecomInboundQuote } from "../types.js";
import { resolveWecomMediaMaxBytes, resolveWecomEgressProxyUrl } from "../config/index.js";
import { decryptWecomMediaWithHttp } from "../media.js";
import { wecomFetch } from "../http.js";
import { buildWecomUnauthorizedCommandPrompt, resolveWecomCommandAuthorization } from "../shared/command-auth.js";
import { generateAgentId, shouldUseDynamicAgent, ensureDynamicAgentListed } from "../dynamic-agent.js";
import { getWecomRuntime } from "../runtime.js";
import { LIMITS, monitorState } from "./state.js";
import type { PendingInbound, StreamState, WecomWebhookTarget } from "./types.js";

const streamStore = monitorState.streamStore;

export type WecomMonitorProcessingDeps = {
  logVerbose: (target: WecomWebhookTarget, message: string) => void;
  logInfo: (target: WecomWebhookTarget, message: string) => void;
  resolveWecomSenderUserId: (msg: WecomInboundMessage) => string | undefined;
  computeTaskKey: (target: WecomWebhookTarget, msg: WecomInboundMessage) => string | undefined;
  resolveAgentAccountOrUndefined: (cfg: OpenClawConfig) => ResolvedAgentAccount | undefined;
  buildFallbackPrompt: (params: {
    kind: "media" | "timeout" | "error";
    agentConfigured: boolean;
    userId?: string;
    filename?: string;
    chatType?: "group" | "direct";
  }) => string;
  sendBotFallbackPromptNow: (params: { streamId: string; text: string }) => Promise<void>;
  sendAgentDmText: (params: {
    agent: ResolvedAgentAccount;
    userId: string;
    text: string;
    core: PluginRuntime;
  }) => Promise<void>;
  sendAgentDmMedia: (params: {
    agent: ResolvedAgentAccount;
    userId: string;
    mediaUrlOrPath: string;
    contentType?: string;
    filename: string;
  }) => Promise<void>;
  extractLocalImagePathsFromText: (params: { text: string; mustAlsoAppearIn: string }) => string[];
  extractLocalFilePathsFromText: (text: string) => string[];
  guessContentTypeFromPath: (filePath: string) => string | undefined;
  looksLikeSendLocalFileIntent: (rawBody: string) => boolean;
  getActiveReplyUrl: (streamId: string) => string | undefined;
  useActiveReplyOnce: (
    streamId: string,
    fn: (params: { responseUrl: string; proxyUrl?: string }) => Promise<void>,
  ) => Promise<void>;
  buildStreamReplyFromState: (state: StreamState) => {
    msgtype: "stream";
    stream: {
      id: string;
      finish: boolean;
      content: string;
      msg_item?: Array<{ msgtype: "image"; image: { base64: string; md5: string } }>;
    };
  };
  appendDmContent: (state: StreamState, text: string) => void;
  truncateUtf8Bytes: (text: string, maxBytes: number) => string;
  STREAM_MAX_BYTES: number;
  BOT_WINDOW_MS: number;
  BOT_SWITCH_MARGIN_MS: number;
};

export function createWecomMonitorProcessor(deps: WecomMonitorProcessingDeps) {
  const {
    logVerbose,
    logInfo,
    resolveWecomSenderUserId,
    computeTaskKey,
    resolveAgentAccountOrUndefined,
    buildFallbackPrompt,
    sendBotFallbackPromptNow,
    sendAgentDmText,
    sendAgentDmMedia,
    extractLocalImagePathsFromText,
    extractLocalFilePathsFromText,
    guessContentTypeFromPath,
    looksLikeSendLocalFileIntent,
    getActiveReplyUrl,
    useActiveReplyOnce,
    buildStreamReplyFromState,
    appendDmContent,
    truncateUtf8Bytes,
    STREAM_MAX_BYTES,
    BOT_WINDOW_MS,
    BOT_SWITCH_MARGIN_MS,
  } = deps;

async function processInboundMessage(target: WecomWebhookTarget, msg: WecomInboundMessage): Promise<InboundResult> {
  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const aesKey = target.account.encodingAESKey;
  const maxBytes = resolveWecomMediaMaxBytes(target.config);
  const proxyUrl = resolveWecomEgressProxyUrl(target.config);

  // 图片消息处理：如果存在 url 且配置了 aesKey，则尝试解密下载
  if (msgtype === "image") {
    const url = String((msg as any).image?.url ?? "").trim();
    if (url && aesKey) {
      try {
        const buf = await decryptWecomMediaWithHttp(url, aesKey, { maxBytes, http: { proxyUrl } });
        return {
          body: "[image]",
          media: {
            buffer: buf,
            contentType: "image/jpeg", // WeCom images are usually generic; safest assumption or could act as generic
            filename: "image.jpg",
          }
        };
      } catch (err) {
        target.runtime.error?.(`Failed to decrypt inbound image: ${String(err)}`);
        target.runtime.error?.(
          `图片解密失败: ${String(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
        );
        return { body: `[image] (decryption failed: ${typeof err === 'object' && err ? (err as any).message : String(err)})` };
      }
    }
  }

  if (msgtype === "file") {
    const url = String((msg as any).file?.url ?? "").trim();
    if (url && aesKey) {
      try {
        const buf = await decryptWecomMediaWithHttp(url, aesKey, { maxBytes, http: { proxyUrl } });
        return {
          body: "[file]",
          media: {
            buffer: buf,
            contentType: "application/octet-stream",
            filename: "file.bin", // WeCom doesn't guarantee filename in webhook payload always, defaulting
          }
        };
      } catch (err) {
        target.runtime.error?.(
          `Failed to decrypt inbound file: ${String(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
        );
        return { body: `[file] (decryption failed: ${typeof err === 'object' && err ? (err as any).message : String(err)})` };
      }
    }
  }

  // Mixed message handling: extract first media if available
  if (msgtype === "mixed") {
    const items = (msg as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      let foundMedia: InboundResult["media"] | undefined = undefined;
      let bodyParts: string[] = [];

      for (const item of items) {
        const t = String(item.msgtype ?? "").toLowerCase();
        if (t === "text") {
          const content = String(item.text?.content ?? "").trim();
          if (content) bodyParts.push(content);
        } else if ((t === "image" || t === "file") && !foundMedia && aesKey) {
          // Found first media, try to download
          const url = String(item[t]?.url ?? "").trim();
          if (url) {
            try {
              const buf = await decryptWecomMediaWithHttp(url, aesKey, { maxBytes, http: { proxyUrl } });
              foundMedia = {
                buffer: buf,
                contentType: t === "image" ? "image/jpeg" : "application/octet-stream",
                filename: t === "image" ? "image.jpg" : "file.bin"
              };
              bodyParts.push(`[${t}]`);
            } catch (err) {
              target.runtime.error?.(
                `Failed to decrypt mixed ${t}: ${String(err)}; 可调大 channels.wecom.media.maxBytes（当前=${maxBytes}）例如：openclaw config set channels.wecom.media.maxBytes ${50 * 1024 * 1024}`,
              );
              bodyParts.push(`[${t}] (decryption failed)`);
            }
          } else {
            bodyParts.push(`[${t}]`);
          }
        } else {
          // Other items or already found media -> just placeholder
          bodyParts.push(`[${t}]`);
        }
      }
      return {
        body: bodyParts.join("\n"),
        media: foundMedia
      };
    }
  }

  return { body: buildInboundBody(msg) };
}

async function flushPending(pending: PendingInbound): Promise<void> {
  const { streamId, target, msg, contents, msgids, conversationKey, batchKey } = pending;

  // Merge all message contents (each is already formatted by buildInboundBody)
  const mergedContents = contents.filter(c => c.trim()).join("\n").trim();

  let core: PluginRuntime | null = null;
  try {
    core = getWecomRuntime();
  } catch (err) {
    logVerbose(target, `flush pending: runtime not ready: ${String(err)}`);
    streamStore.markFinished(streamId);
    logInfo(target, `queue: runtime not ready，结束批次并推进 streamId=${streamId}`);
    streamStore.onStreamFinished(streamId);
    return;
  }

  if (core) {
    streamStore.markStarted(streamId);
    const enrichedTarget: WecomWebhookTarget = { ...target, core };
    logInfo(target, `flush pending: start batch streamId=${streamId} batchKey=${batchKey} conversationKey=${conversationKey} mergedCount=${contents.length}`);
    logVerbose(target, `防抖结束: 开始处理聚合消息 数量=${contents.length} streamId=${streamId}`);

    // Pass the first msg (with its media structure), and mergedContents for multi-message context
    startAgentForStream({
      target: enrichedTarget,
      accountId: target.account.accountId,
      msg,
      streamId,
      mergedContents: contents.length > 1 ? mergedContents : undefined,
      mergedMsgids: msgids.length > 1 ? msgids : undefined,
    }).catch((err) => {
      streamStore.updateStream(streamId, (state) => {
        state.error = err instanceof Error ? err.message : String(err);
        state.content = state.content || `Error: ${state.error}`;
        state.finished = true;
      });
      target.runtime.error?.(`[${target.account.accountId}] wecom agent failed (处理失败): ${String(err)}`);
      streamStore.onStreamFinished(streamId);
    });
  }
}

async function startAgentForStream(params: {
  target: WecomWebhookTarget;
  accountId: string;
  msg: WecomInboundMessage;
  streamId: string;
  mergedContents?: string; // Combined content from debounced messages
  mergedMsgids?: string[];
}): Promise<void> {
  const { target, msg, streamId } = params;
  const core = target.core;
  const config = target.config;
  const account = target.account;

  const userid = resolveWecomSenderUserId(msg) || "unknown";
  const chatType = msg.chattype === "group" ? "group" : "direct";
  const chatId = msg.chattype === "group" ? (msg.chatid?.trim() || "unknown") : userid;
  const taskKey = computeTaskKey(target, msg);
  const aibotid = String((msg as any).aibotid ?? "").trim() || undefined;

  // 更新 Stream 状态：记录上下文信息（用户ID、ChatType等）
  streamStore.updateStream(streamId, (s) => {
    s.userId = userid;
    s.chatType = chatType === "group" ? "group" : "direct";
    s.chatId = chatId;
    s.taskKey = taskKey;
    s.aibotid = aibotid;
  });

  // 1. 处理入站消息 (Decrypt media if any)
  // 解析消息体，若是图片/文件则自动解密
  let { body: rawBody, media } = await processInboundMessage(target, msg);

  // 若存在从防抖逻辑聚合来的多条消息内容，则覆盖 rawBody
  if (params.mergedContents) {
    rawBody = params.mergedContents;
  }

  // P0: 群聊/私聊里“让 Bot 发送本机图片/文件路径”的场景，优先走 Bot 原会话交付（图片），
  // 非图片文件则走 Agent 私信兜底，并确保 Bot 会话里有中文提示。
  //
  // 典型背景：Agent 主动发群 chatId（wr/wc...）在很多情况下会 86008，无论怎么“修复”都发不出去；
  // 这种请求如果能被动回复图片，就必须由 Bot 在群内交付。
  const directLocalPaths = extractLocalFilePathsFromText(rawBody);
  if (directLocalPaths.length) {
    logVerbose(
      target,
      `local-path: 检测到用户消息包含本机路径 count=${directLocalPaths.length} intent=${looksLikeSendLocalFileIntent(rawBody)}`,
    );
  }
  if (directLocalPaths.length && looksLikeSendLocalFileIntent(rawBody)) {
    const fs = await import("node:fs/promises");
    const pathModule = await import("node:path");
    const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

    const imagePaths: string[] = [];
    const otherPaths: string[] = [];
    for (const p of directLocalPaths) {
      const ext = pathModule.extname(p).slice(1).toLowerCase();
      if (imageExts.has(ext)) imagePaths.push(p);
      else otherPaths.push(p);
    }

    // 1) 图片：优先 Bot 群内/原会话交付（被动/流式 msg_item）
    if (imagePaths.length > 0 && otherPaths.length === 0) {
      const loaded: Array<{ base64: string; md5: string; path: string }> = [];
      for (const p of imagePaths) {
        try {
          const buf = await fs.readFile(p);
          const base64 = buf.toString("base64");
          const md5 = crypto.createHash("md5").update(buf).digest("hex");
          loaded.push({ base64, md5, path: p });
        } catch (err) {
          target.runtime.error?.(`local-path: 读取图片失败 path=${p}: ${String(err)}`);
        }
      }

      if (loaded.length > 0) {
        streamStore.updateStream(streamId, (s) => {
          s.images = loaded.map(({ base64, md5 }) => ({ base64, md5 }));
          s.content = loaded.length === 1
            ? `已发送图片（${pathModule.basename(loaded[0]!.path)}）`
            : `已发送 ${loaded.length} 张图片`;
          s.finished = true;
        });

        const responseUrl = getActiveReplyUrl(streamId);
        if (responseUrl) {
          try {
            const finalReply = buildStreamReplyFromState(streamStore.getStream(streamId)!) as unknown as Record<string, unknown>;
            await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
              const res = await wecomFetch(
                responseUrl,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(finalReply),
                },
                { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
              );
              if (!res.ok) throw new Error(`local-path image push failed: ${res.status}`);
            });
            logVerbose(target, `local-path: 已通过 Bot response_url 推送图片 frames=final images=${loaded.length}`);
          } catch (err) {
            target.runtime.error?.(`local-path: Bot 主动推送图片失败（将依赖 stream_refresh 拉取）: ${String(err)}`);
          }
        } else {
          logVerbose(target, `local-path: 无 response_url，等待 stream_refresh 拉取最终图片`);
        }
        // 该消息已完成，推进队列处理下一批
        streamStore.onStreamFinished(streamId);
        return;
      }
    }

    // 2) 非图片文件：Bot 会话里提示 + Agent 私信兜底（目标锁定 userId）
    if (otherPaths.length > 0) {
      const agentCfg = resolveAgentAccountOrUndefined(config);
      const agentOk = Boolean(agentCfg);

      const filename = otherPaths.length === 1 ? otherPaths[0]!.split("/").pop()! : `${otherPaths.length} 个文件`;
      const prompt = buildFallbackPrompt({
        kind: "media",
        agentConfigured: agentOk,
        userId: userid,
        filename,
        chatType,
      });

      streamStore.updateStream(streamId, (s) => {
        s.fallbackMode = "media";
        s.finished = true;
        s.content = prompt;
        s.fallbackPromptSentAt = s.fallbackPromptSentAt ?? Date.now();
      });

      try {
        await sendBotFallbackPromptNow({ streamId, text: prompt });
        logVerbose(target, `local-path: 文件兜底提示已推送`);
      } catch (err) {
        target.runtime.error?.(`local-path: 文件兜底提示推送失败: ${String(err)}`);
      }

      if (!agentCfg) {
        streamStore.onStreamFinished(streamId);
        return;
      }
      if (!userid || userid === "unknown") {
        target.runtime.error?.(`local-path: 无法识别触发者 userId，无法 Agent 私信发送文件`);
        streamStore.onStreamFinished(streamId);
        return;
      }

      for (const p of otherPaths) {
        const alreadySent = streamStore.getStream(streamId)?.agentMediaKeys?.includes(p);
        if (alreadySent) continue;
        try {
          await sendAgentDmMedia({
            agent: agentCfg,
            userId: userid,
            mediaUrlOrPath: p,
            contentType: guessContentTypeFromPath(p),
            filename: p.split("/").pop() || "file",
          });
          streamStore.updateStream(streamId, (s) => {
            s.agentMediaKeys = Array.from(new Set([...(s.agentMediaKeys ?? []), p]));
          });
          logVerbose(target, `local-path: 文件已通过 Agent 私信发送 user=${userid} path=${p}`);
        } catch (err) {
          target.runtime.error?.(`local-path: Agent 私信发送文件失败 path=${p}: ${String(err)}`);
        }
      }
      streamStore.onStreamFinished(streamId);
      return;
    }
  }

  // 2. Save media if present
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (media) {
    try {
      const maxBytes = resolveWecomMediaMaxBytes(target.config);
      const saved = await core.channel.media.saveMediaBuffer(
        media.buffer,
        media.contentType,
        "inbound",
        maxBytes,
        media.filename
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
      logVerbose(target, `saved inbound media to ${mediaPath} (${mediaType})`);
    } catch (err) {
      target.runtime.error?.(`Failed to save inbound media: ${String(err)}`);
    }
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: { kind: chatType === "group" ? "group" : "dm", id: chatId },
  });

  // ===== 动态 Agent 路由注入 =====
  const useDynamicAgent = shouldUseDynamicAgent({
    chatType: chatType === "group" ? "group" : "dm",
    senderId: userid,
    config,
  });

  if (useDynamicAgent) {
    const targetAgentId = generateAgentId(
      chatType === "group" ? "group" : "dm",
      chatId
    );
    route.agentId = targetAgentId;
    route.sessionKey = `agent:${targetAgentId}:${chatType === "group" ? "group" : "dm"}:${chatId}`;
    // 异步添加到 agents.list（不阻塞）
    ensureDynamicAgentListed(targetAgentId, core).catch(() => {});
    logVerbose(target, `dynamic agent routing: ${targetAgentId}, sessionKey=${route.sessionKey}`);
  }
  // ===== 动态 Agent 路由注入结束 =====

  logVerbose(target, `starting agent processing (streamId=${streamId}, agentId=${route.agentId}, peerKind=${chatType}, peerId=${chatId})`);
  logVerbose(target, `启动 Agent 处理: streamId=${streamId} 路由=${route.agentId} 类型=${chatType} ID=${chatId}`);

  const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${userid}`;
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
    body: rawBody,
  });

  const authz = await resolveWecomCommandAuthorization({
    core,
    cfg: config,
    accountConfig: account.config,
    rawBody,
    senderUserId: userid,
  });
  const commandAuthorized = authz.commandAuthorized;
  logVerbose(
    target,
    `authz: dmPolicy=${authz.dmPolicy} shouldCompute=${authz.shouldComputeAuth} sender=${userid.toLowerCase()} senderAllowed=${authz.senderAllowed} authorizerConfigured=${authz.authorizerConfigured} commandAuthorized=${String(authz.commandAuthorized)}`,
  );

  // 命令门禁：如果这是命令且未授权，必须给用户一个明确的中文回复（不能静默忽略）
  if (authz.shouldComputeAuth && authz.commandAuthorized !== true) {
    const prompt = buildWecomUnauthorizedCommandPrompt({ senderUserId: userid, dmPolicy: authz.dmPolicy, scope: "bot" });
    streamStore.updateStream(streamId, (s) => {
      s.finished = true;
      s.content = prompt;
    });
    try {
      await sendBotFallbackPromptNow({ streamId, text: prompt });
      logInfo(target, `authz: 未授权命令已提示用户 streamId=${streamId}`);
    } catch (err) {
      target.runtime.error?.(`authz: 未授权命令提示推送失败 streamId=${streamId}: ${String(err)}`);
    }
    streamStore.onStreamFinished(streamId);
    return;
  }

  const rawBodyNormalized = rawBody.trim();
  const isResetCommand = /^\/(new|reset)(?:\s|$)/i.test(rawBodyNormalized);
  const resetCommandKind = isResetCommand ? (rawBodyNormalized.match(/^\/(new|reset)/i)?.[1]?.toLowerCase() ?? "new") : null;

  const attachments = mediaPath ? [{
    name: media?.filename || "file",
    mimeType: mediaType,
    url: pathToFileURL(mediaPath).href
  }] : undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    Attachments: attachments,
    From: chatType === "group" ? `wecom:group:${chatId}` : `wecom:${userid}`,
    To: `wecom:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: userid,
    SenderId: userid,
    Provider: "wecom",
    Surface: "wecom",
    MessageSid: msg.msgid,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom:${chatId}`,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath, // Local path for now
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      target.runtime.error?.(`wecom: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
  });

  // WeCom Bot 会话交付约束：
  // - 图片应尽量由 Bot 在原会话交付（流式最终帧 msg_item）。
  // - 非图片文件走 Agent 私信兜底（本文件中实现），并由 Bot 给出提示。
  //
  // 重要：message 工具不是 sandbox 工具，必须通过 cfg.tools.deny 禁用。
  // 否则 Agent 可能直接通过 message 工具私信/发群，绕过 Bot 交付链路，导致群里“没有任何提示”。
  const cfgForDispatch = (() => {
    const baseTools = (config as any)?.tools ?? {};
    const baseSandbox = (baseTools as any)?.sandbox ?? {};
    const baseSandboxTools = (baseSandbox as any)?.tools ?? {};
    const existingDeny = Array.isArray((baseSandboxTools as any).deny) ? ((baseSandboxTools as any).deny as string[]) : [];
    const deny = Array.from(new Set([...existingDeny, "message"]));
    return {
      ...(config as any),
      tools: {
        ...baseTools,
        sandbox: {
          ...baseSandbox,
          tools: {
            ...baseSandboxTools,
            deny,
          },
        },
      },
    } as OpenClawConfig;
  })();
  logVerbose(target, `tool-policy: WeCom Bot 会话已禁用 message 工具（tools.sandbox.tools.deny += message，防止绕过 Bot 交付）`);

  // 调度 Agent 回复
  // 使用 dispatchReplyWithBufferedBlockDispatcher 可以处理流式输出 buffer
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: cfgForDispatch,
    dispatcherOptions: {
      deliver: async (payload) => {
        let text = payload.text ?? "";

        // 保护 <think> 标签不被 markdown 表格转换破坏
        const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
        const thinks: string[] = [];
        text = text.replace(thinkRegex, (match: string) => {
          thinks.push(match);
          return `__THINK_PLACEHOLDER_${thinks.length - 1}__`;
        });

        // [A2UI] Detect template_card JSON output from Agent
        const trimmedText = text.trim();
        if (trimmedText.startsWith("{") && trimmedText.includes('"template_card"')) {
          try {
            const parsed = JSON.parse(trimmedText);
            if (parsed.template_card) {
              const isSingleChat = msg.chattype !== "group";
              const responseUrl = getActiveReplyUrl(streamId);

              if (responseUrl && isSingleChat) {
                // 单聊且有 response_url：发送卡片
                await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
                  const res = await wecomFetch(
                    responseUrl,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        msgtype: "template_card",
                        template_card: parsed.template_card,
                      }),
                    },
                    { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
                  );
                  if (!res.ok) {
                    throw new Error(`template_card send failed: ${res.status}`);
                  }
                });
                logVerbose(target, `sent template_card: task_id=${parsed.template_card.task_id}`);
                streamStore.updateStream(streamId, (s) => {
                  s.finished = true;
                  s.content = "[已发送交互卡片]";
                });
                target.statusSink?.({ lastOutboundAt: Date.now() });
                return;
              } else {
                // 群聊 或 无 response_url：降级为文本描述
                logVerbose(target, `template_card fallback to text (group=${!isSingleChat}, hasUrl=${!!responseUrl})`);
                const cardTitle = parsed.template_card.main_title?.title || "交互卡片";
                const cardDesc = parsed.template_card.main_title?.desc || "";
                const buttons = parsed.template_card.button_list?.map((b: any) => b.text).join(" / ") || "";
                text = `📋 **${cardTitle}**${cardDesc ? `\n${cardDesc}` : ""}${buttons ? `\n\n选项: ${buttons}` : ""}`;
              }
            }
          } catch { /* parse fail, use normal text */ }
        }

        text = core.channel.text.convertMarkdownTables(text, tableMode);

        // Restore <think> tags
        thinks.forEach((think, i) => {
          text = text.replace(`__THINK_PLACEHOLDER_${i}__`, think);
        });

        const current = streamStore.getStream(streamId);
        if (!current) return;

        if (!current.images) current.images = [];
        if (!current.agentMediaKeys) current.agentMediaKeys = [];

        logVerbose(
          target,
          `deliver: chatType=${current.chatType ?? chatType} user=${current.userId ?? userid} textLen=${text.length} mediaCount=${(payload.mediaUrls?.length ?? 0) + (payload.mediaUrl ? 1 : 0)}`,
        );

        // If the model referenced a local image path in its reply but did not emit mediaUrl(s),
        // we can still deliver it via Bot *only* when that exact path appeared in the user's
        // original message (rawBody). This prevents the model from exfiltrating arbitrary files.
        if (!payload.mediaUrl && !(payload.mediaUrls?.length ?? 0) && text.includes("/")) {
          const candidates = extractLocalImagePathsFromText({ text, mustAlsoAppearIn: rawBody });
          if (candidates.length > 0) {
            logVerbose(target, `media: 从输出文本推断到本机图片路径（来自用户原消息）count=${candidates.length}`);
            for (const p of candidates) {
              try {
                const fs = await import("node:fs/promises");
                const pathModule = await import("node:path");
                const buf = await fs.readFile(p);
                const ext = pathModule.extname(p).slice(1).toLowerCase();
                const imageExts: Record<string, string> = {
                  jpg: "image/jpeg",
                  jpeg: "image/jpeg",
                  png: "image/png",
                  gif: "image/gif",
                  webp: "image/webp",
                  bmp: "image/bmp",
                };
                const contentType = imageExts[ext] ?? "application/octet-stream";
                if (!contentType.startsWith("image/")) {
                  continue;
                }
                const base64 = buf.toString("base64");
                const md5 = crypto.createHash("md5").update(buf).digest("hex");
                current.images.push({ base64, md5 });
                logVerbose(target, `media: 已加载本机图片用于 Bot 交付 path=${p}`);
              } catch (err) {
                target.runtime.error?.(`media: 读取本机图片失败 path=${p}: ${String(err)}`);
              }
            }
          }
        }

        // Always accumulate content for potential Agent DM fallback (not limited by STREAM_MAX_BYTES).
        if (text.trim()) {
          streamStore.updateStream(streamId, (s) => {
            appendDmContent(s, text);
          });
        }

        // Timeout fallback (group only): near 6min window, stop bot stream and switch to Agent DM.
        const now = Date.now();
        const deadline = current.createdAt + BOT_WINDOW_MS;
        const switchAt = deadline - BOT_SWITCH_MARGIN_MS;
        const nearTimeout = !current.fallbackMode && !current.finished && now >= switchAt;
        if (nearTimeout) {
          const agentCfg = resolveAgentAccountOrUndefined(config);
          const agentOk = Boolean(agentCfg);
          const prompt = buildFallbackPrompt({
            kind: "timeout",
            agentConfigured: agentOk,
            userId: current.userId,
            chatType: current.chatType,
          });
          logVerbose(
            target,
            `fallback(timeout): 触发切换（接近 6 分钟）chatType=${current.chatType} agentConfigured=${agentOk} hasResponseUrl=${Boolean(getActiveReplyUrl(streamId))}`,
          );
          streamStore.updateStream(streamId, (s) => {
            s.fallbackMode = "timeout";
            s.finished = true;
            s.content = prompt;
            s.fallbackPromptSentAt = s.fallbackPromptSentAt ?? Date.now();
          });
          try {
            await sendBotFallbackPromptNow({ streamId, text: prompt });
            logVerbose(target, `fallback(timeout): 群内提示已推送`);
          } catch (err) {
            target.runtime.error?.(`wecom bot fallback prompt push failed (timeout) streamId=${streamId}: ${String(err)}`);
          }
          return;
        }

        const mediaUrls = payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []);
        for (const mediaPath of mediaUrls) {
          try {
            let buf: Buffer;
            let contentType: string | undefined;
            let filename: string;

            const looksLikeUrl = /^https?:\/\//i.test(mediaPath);

            if (looksLikeUrl) {
              const loaded = await core.channel.media.fetchRemoteMedia({ url: mediaPath });
              buf = loaded.buffer;
              contentType = loaded.contentType;
              filename = loaded.fileName ?? "attachment";
            } else {
              const fs = await import("node:fs/promises");
              const pathModule = await import("node:path");
              buf = await fs.readFile(mediaPath);
              filename = pathModule.basename(mediaPath);
              const ext = pathModule.extname(mediaPath).slice(1).toLowerCase();
              const imageExts: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
              contentType = imageExts[ext] ?? "application/octet-stream";
            }

            if (contentType?.startsWith("image/")) {
              const base64 = buf.toString("base64");
              const md5 = crypto.createHash("md5").update(buf).digest("hex");
              current.images.push({ base64, md5 });
              logVerbose(target, `media: 识别为图片 contentType=${contentType} filename=${filename}`);
            } else {
              // Non-image media: Bot 不支持原样发送（尤其群聊），统一切换到 Agent 私信兜底，并在 Bot 会话里提示用户。
              const agentCfg = resolveAgentAccountOrUndefined(config);
              const agentOk = Boolean(agentCfg);
              const alreadySent = current.agentMediaKeys.includes(mediaPath);
              logVerbose(
                target,
                `fallback(media): 检测到非图片文件 chatType=${current.chatType} contentType=${contentType ?? "unknown"} filename=${filename} agentConfigured=${agentOk} alreadySent=${alreadySent} hasResponseUrl=${Boolean(getActiveReplyUrl(streamId))}`,
              );

              if (agentCfg && !alreadySent && current.userId) {
                try {
                  await sendAgentDmMedia({
                    agent: agentCfg,
                    userId: current.userId,
                    mediaUrlOrPath: mediaPath,
                    contentType,
                    filename,
                  });
                  logVerbose(target, `fallback(media): 文件已通过 Agent 私信发送 user=${current.userId}`);
                  streamStore.updateStream(streamId, (s) => {
                    s.agentMediaKeys = Array.from(new Set([...(s.agentMediaKeys ?? []), mediaPath]));
                  });
                } catch (err) {
                  target.runtime.error?.(`wecom agent dm media failed: ${String(err)}`);
                }
              }

              if (!current.fallbackMode) {
                const prompt = buildFallbackPrompt({
                  kind: "media",
                  agentConfigured: agentOk,
                  userId: current.userId,
                  filename,
                  chatType: current.chatType,
                });
                streamStore.updateStream(streamId, (s) => {
                  s.fallbackMode = "media";
                  s.finished = true;
                  s.content = prompt;
                  s.fallbackPromptSentAt = s.fallbackPromptSentAt ?? Date.now();
                });
                try {
                  await sendBotFallbackPromptNow({ streamId, text: prompt });
                  logVerbose(target, `fallback(media): 群内提示已推送`);
                } catch (err) {
                  target.runtime.error?.(`wecom bot fallback prompt push failed (media) streamId=${streamId}: ${String(err)}`);
                }
              }
              return;
            }
          } catch (err) {
            target.runtime.error?.(`Failed to process outbound media: ${mediaPath}: ${String(err)}`);
          }
        }

        // If we are in fallback mode, do not continue updating the bot stream content.
        const mode = streamStore.getStream(streamId)?.fallbackMode;
        if (mode) return;

        const nextText = current.content
          ? `${current.content}\n\n${text}`.trim()
          : text.trim();

        streamStore.updateStream(streamId, (s) => {
          s.content = truncateUtf8Bytes(nextText, STREAM_MAX_BYTES);
          if (current.images?.length) s.images = current.images; // ensure images are saved
        });
        target.statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        target.runtime.error?.(`[${account.accountId}] wecom ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  // /new /reset：OpenClaw 核心会通过 routeReply 发送英文回执（✅ New session started...），
  // 但 WeCom 双模式下这条回执可能会走 Agent 私信，导致“从 Bot 发，却在 Agent 再回一条”。
  // 该英文回执已在 wecom outbound 层做抑制/改写；这里补一个“同会话中文回执”，保证用户可理解。
  if (isResetCommand) {
    const current = streamStore.getStream(streamId);
    const hasAnyContent = Boolean(current?.content?.trim());
    if (current && !hasAnyContent) {
      const ackText = resetCommandKind === "reset" ? "✅ 已重置会话。" : "✅ 已开启新会话。";
      streamStore.updateStream(streamId, (s) => {
        s.content = ackText;
        s.finished = true;
      });
    }
  }

  streamStore.markFinished(streamId);

  // Timeout fallback final delivery (Agent DM): send once after the agent run completes.
  const finishedState = streamStore.getStream(streamId);
  if (finishedState?.fallbackMode === "timeout" && !finishedState.finalDeliveredAt) {
    const agentCfg = resolveAgentAccountOrUndefined(config);
    if (!agentCfg) {
      // Agent not configured - group prompt already explains the situation.
      streamStore.updateStream(streamId, (s) => { s.finalDeliveredAt = Date.now(); });
    } else if (finishedState.userId) {
      const dmText = (finishedState.dmContent ?? "").trim();
      if (dmText) {
        try {
          logVerbose(target, `fallback(timeout): 开始通过 Agent 私信发送剩余内容 user=${finishedState.userId} len=${dmText.length}`);
          await sendAgentDmText({ agent: agentCfg, userId: finishedState.userId, text: dmText, core });
          logVerbose(target, `fallback(timeout): Agent 私信发送完成 user=${finishedState.userId}`);
        } catch (err) {
          target.runtime.error?.(`wecom agent dm text failed (timeout): ${String(err)}`);
        }
      }
      streamStore.updateStream(streamId, (s) => { s.finalDeliveredAt = Date.now(); });
    }
  }

  // Bot 群聊图片兜底：
  // 依赖企业微信的“流式消息刷新”回调来拉取最终消息有时会出现客户端未能及时拉取到最后一帧的情况，
  // 导致最终的图片(msg_item)没有展示。若存在 response_url，则在流结束后主动推送一次最终 stream 回复。
  // 注：该行为以 response_url 是否可用为准；失败则仅记录日志，不影响原有刷新链路。
  if (chatType === "group") {
    const state = streamStore.getStream(streamId);
    const hasImages = Boolean(state?.images?.length);
    const responseUrl = getActiveReplyUrl(streamId);
    if (state && hasImages && responseUrl) {
      const finalReply = buildStreamReplyFromState(state) as unknown as Record<string, unknown>;
      try {
        await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
          const res = await wecomFetch(
            responseUrl,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(finalReply),
            },
            { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
          );
          if (!res.ok) {
            throw new Error(`final stream push failed: ${res.status}`);
          }
        });
        logVerbose(target, `final stream pushed via response_url (group) streamId=${streamId}, images=${state.images?.length ?? 0}`);
      } catch (err) {
        target.runtime.error?.(`final stream push via response_url failed (group) streamId=${streamId}: ${String(err)}`);
      }
    }
  }

  // 推进会话队列：如果 2/3 已排队，当前批次结束后自动开始下一批次
  logInfo(target, `queue: 当前批次结束，尝试推进下一批 streamId=${streamId}`);

  // 体验优化：如果本批次中有“回执流”(ack stream)（例如 3 被合并到 2），则在批次结束时更新这些回执流，
  // 避免它们永久停留在“已合并排队处理中…”。
  const ackStreamIds = streamStore.drainAckStreamsForBatch(streamId);
  if (ackStreamIds.length > 0) {
    const mergedDoneHint = "✅ 已合并处理完成，请查看上一条回复。";
    for (const ackId of ackStreamIds) {
      streamStore.updateStream(ackId, (s) => {
        s.content = mergedDoneHint;
        s.finished = true;
      });
    }
    logInfo(target, `queue: 已更新回执流 count=${ackStreamIds.length} batchStreamId=${streamId}`);
  }

  streamStore.onStreamFinished(streamId);
}

function formatQuote(quote: WecomInboundQuote): string {
  const type = quote.msgtype ?? "";
  if (type === "text") return quote.text?.content || "";
  if (type === "image") return `[引用: 图片] ${quote.image?.url || ""}`;
  if (type === "mixed" && quote.mixed?.msg_item) {
    const items = quote.mixed.msg_item.map((item) => {
      if (item.msgtype === "text") return item.text?.content;
      if (item.msgtype === "image") return `[图片] ${item.image?.url || ""}`;
      return "";
    }).filter(Boolean).join(" ");
    return `[引用: 图文] ${items}`;
  }
  if (type === "voice") return `[引用: 语音] ${quote.voice?.content || ""}`;
  if (type === "file") return `[引用: 文件] ${quote.file?.url || ""}`;
  return "";
}

function buildInboundBody(msg: WecomInboundMessage): string {
  let body = "";
  const msgtype = String(msg.msgtype ?? "").toLowerCase();

  if (msgtype === "text") body = (msg as any).text?.content || "";
  else if (msgtype === "voice") body = (msg as any).voice?.content || "[voice]";
  else if (msgtype === "mixed") {
    const items = (msg as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      body = items.map((item: any) => {
        const t = String(item?.msgtype ?? "").toLowerCase();
        if (t === "text") return item?.text?.content || "";
        if (t === "image") return `[image] ${item?.image?.url || ""}`;
        return `[${t || "item"}]`;
      }).filter(Boolean).join("\n");
    } else body = "[mixed]";
  } else if (msgtype === "image") body = `[image] ${(msg as any).image?.url || ""}`;
  else if (msgtype === "file") body = `[file] ${(msg as any).file?.url || ""}`;
  else if (msgtype === "event") body = `[event] ${(msg as any).event?.eventtype || ""}`;
  else if (msgtype === "stream") body = `[stream_refresh] ${(msg as any).stream?.id || ""}`;
  else body = msgtype ? `[${msgtype}]` : "";

  const quote = (msg as any).quote;
  if (quote) {
    const quoteText = formatQuote(quote).trim();
    if (quoteText) body += `\n\n> ${quoteText}`;
  }
  return body;
}

  return {
    flushPending,
    startAgentForStream,
    buildInboundBody,
  };
}
