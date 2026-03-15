import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { logger } from "../logger.js";
import { agentDownloadMedia, agentUploadMedia, getAccessToken } from "./agent-api.js";
import { AGENT_API_REQUEST_TIMEOUT_MS } from "./constants.js";
import {
  buildKfPeerKey,
  getKfPeerDispatchVersion,
  getRuntime,
  nextKfPeerDispatchVersion,
  streamContext,
} from "./state.js";
import { resolveAgentWorkspaceDirLocal } from "./workspace-template.js";

const KF_API_ENDPOINTS = {
  SYNC_MSG: "https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg",
  SEND_MSG: "https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg",
};

const CURSOR_MAX_PAGES = 10;
const RECENT_MSGID_TTL_MS = 10 * 60 * 1000;
const KF_SESSION_VERSION = "kf-v2";
const cursorByAccountAndKf = new Map();
const recentKfMsgIds = new Map();
const kfDispatchQueues = new Map();

function cursorKey(accountId, openKfId) {
  return `${accountId || "default"}:${openKfId}`;
}

function normalizeMediaPathForAgent(mediaUrl, agentId) {
  let path = String(mediaUrl || "").trim();
  if (!path) return "";
  if (path.startsWith("sandbox:")) {
    path = path.replace(/^sandbox:\/{0,2}/, "");
    if (!path.startsWith("/")) path = `/${path}`;
  }
  if (agentId && path.startsWith("/workspace/")) {
    const relative = path.slice("/workspace/".length);
    path = join(resolveAgentWorkspaceDirLocal(agentId), relative);
  }
  return path;
}

async function readOutboundMediaBuffer(mediaUrl, agentId) {
  const normalized = normalizeMediaPathForAgent(mediaUrl, agentId);
  if (normalized.startsWith("/")) {
    const buffer = await readFile(normalized);
    return {
      buffer,
      filename: basename(normalized) || "file",
    };
  }

  const res = await fetch(String(mediaUrl), {
    signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`download media failed: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  let filename = "file";
  try {
    filename = basename(new URL(String(mediaUrl)).pathname) || "file";
  } catch {
    filename = "file";
  }
  return { buffer, filename };
}

function resolveUploadTypeFromFilename(filename) {
  const ext = String(filename || "").split(".").pop()?.toLowerCase() || "";
  const imageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp"]);
  return imageExts.has(ext) ? "image" : "file";
}

function rememberKfMsgId(msgId) {
  const now = Date.now();
  const existing = recentKfMsgIds.get(msgId);
  if (existing && now - existing < RECENT_MSGID_TTL_MS) return false;
  recentKfMsgIds.set(msgId, now);
  for (const [key, ts] of recentKfMsgIds) {
    if (now - ts >= RECENT_MSGID_TTL_MS) {
      recentKfMsgIds.delete(key);
    }
  }
  return true;
}

function isCustomerMessage(msg) {
  return Number(msg?.origin) === 3 && Boolean(msg?.external_userid);
}

function isSimpleGreeting(text) {
  const normalized = String(text || "").trim();
  return /^(你好|您好|hi|hello)[!！。,.，\s😊😄👋]*$/i.test(normalized);
}

async function enqueueKfDispatch(peerKey, task) {
  const previous = kfDispatchQueues.get(peerKey) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  kfDispatchQueues.set(peerKey, run);
  try {
    return await run;
  } finally {
    if (kfDispatchQueues.get(peerKey) === run) {
      kfDispatchQueues.delete(peerKey);
    }
  }
}

function nextPeerDispatchVersion(peerKey) {
  return nextKfPeerDispatchVersion(peerKey);
}

function extractKfMediaId(msg) {
  const msgType = String(msg?.msgtype || "").toLowerCase();
  switch (msgType) {
    case "image":
      return String(msg?.image?.media_id || "").trim();
    case "voice":
      return String(msg?.voice?.media_id || "").trim();
    case "video":
      return String(msg?.video?.media_id || "").trim();
    case "file":
      return String(msg?.file?.media_id || "").trim();
    default:
      return "";
  }
}

function guessExtFromMime(contentType, fallback = "bin") {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("jpeg")) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("bmp")) return "bmp";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("amr")) return "amr";
  if (ct.includes("silk")) return "silk";
  if (ct.includes("mpeg")) return "mp3";
  if (ct.includes("wav")) return "wav";
  if (ct.includes("mp4")) return "mp4";
  if (ct.includes("quicktime")) return "mov";
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("sheet")) return "xlsx";
  if (ct.includes("word")) return "docx";
  if (ct.includes("zip")) return "zip";
  if (ct.includes("text/plain")) return "txt";
  return fallback;
}

async function resolveKfMediaAttachments({ agent, msg }) {
  const mediaId = extractKfMediaId(msg);
  if (!mediaId) {
    return { mediaPaths: [], mediaTypes: [], attachSummary: "" };
  }

  const msgType = String(msg?.msgtype || "").toLowerCase() || "file";
  const { buffer, contentType } = await agentDownloadMedia({
    agent,
    mediaId,
  });

  const runtime = getRuntime();
  const core = runtime.channel;
  const ext = guessExtFromMime(contentType);
  const fallbackName = `${msgType}-${mediaId.slice(0, 12) || "media"}.${ext}`;
  const saved = await core.media.saveMediaBuffer(
    buffer,
    contentType || "application/octet-stream",
    "inbound",
    25 * 1024 * 1024,
    fallbackName,
  );

  logger.info("[kf-bridge] inbound media saved", {
    msgType,
    mediaId,
    bytes: buffer.length,
    path: saved.path,
  });

  return {
    mediaPaths: [saved.path],
    mediaTypes: [contentType || "application/octet-stream"],
    attachSummary: `\n\n[已附加客户发送的${msgType}媒体文件，可直接读取分析]`,
  };
}

function extractKfText(msg) {
  const msgType = String(msg?.msgtype || "").toLowerCase();
  switch (msgType) {
    case "text":
      return String(msg?.text?.content || "");
    case "image":
      return "[客户发送了一张图片]";
    case "voice":
      return "[客户发送了一条语音]";
    case "video":
      return "[客户发送了一条视频]";
    case "file":
      return `[客户发送了文件] ${msg?.file?.filename || ""}`.trim();
    case "location":
      return `[客户发送了位置] ${msg?.location?.address || ""}`.trim();
    case "link":
      return `[客户发送了链接] ${msg?.link?.title || ""}`.trim();
    case "miniprogram":
      return "[客户发送了小程序消息]";
    case "event":
      return "";
    default:
      return msgType ? `[客户消息类型: ${msgType}]` : "";
  }
}

async function syncKfMessages({
  agent,
  accountId,
  openKfId,
  syncToken,
}) {
  const accessToken = await getAccessToken(agent);
  const key = cursorKey(accountId, openKfId);
  let cursor = cursorByAccountAndKf.get(key) || "";
  let hasMore = true;
  let pages = 0;
  const allMessages = [];

  while (hasMore && pages < CURSOR_MAX_PAGES) {
    const body = {
      open_kfid: openKfId,
      limit: 1000,
    };
    if (cursor) body.cursor = cursor;
    if (syncToken) body.token = syncToken;

    const res = await fetch(
      `${KF_API_ENDPOINTS.SYNC_MSG}?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
      },
    );
    const json = await res.json();
    if (json?.errcode !== 0) {
      throw new Error(`kf sync_msg failed: ${json?.errcode} ${json?.errmsg}`);
    }

    if (json?.next_cursor) {
      cursor = json.next_cursor;
      cursorByAccountAndKf.set(key, cursor);
    }

    if (Array.isArray(json?.msg_list) && json.msg_list.length > 0) {
      allMessages.push(...json.msg_list);
    }

    hasMore = Number(json?.has_more || 0) === 1;
    pages += 1;
  }

  return allMessages;
}

async function sendKfText({
  agent,
  openKfId,
  externalUserId,
  text,
}) {
  const accessToken = await getAccessToken(agent);
  const payload = {
    touser: externalUserId,
    open_kfid: openKfId,
    msgtype: "text",
    text: {
      content: text,
    },
  };
  const res = await fetch(
    `${KF_API_ENDPOINTS.SEND_MSG}?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
    },
  );
  const json = await res.json();
  if (json?.errcode !== 0) {
    throw new Error(`kf send_msg failed: ${json?.errcode} ${json?.errmsg}`);
  }
}

async function sendKfMedia({
  agent,
  openKfId,
  externalUserId,
  mediaType,
  mediaId,
}) {
  const accessToken = await getAccessToken(agent);
  const payload = {
    touser: externalUserId,
    open_kfid: openKfId,
    msgtype: mediaType,
    [mediaType]: {
      media_id: mediaId,
    },
  };
  const res = await fetch(
    `${KF_API_ENDPOINTS.SEND_MSG}?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
    },
  );
  const json = await res.json();
  if (json?.errcode !== 0) {
    throw new Error(`kf send_msg ${mediaType} failed: ${json?.errcode} ${json?.errmsg}`);
  }
}

async function dispatchToAgentAndReply({
  config,
  accountId,
  openKfId,
  externalUserId,
  inboundText,
  mediaPaths = [],
  mediaTypes = [],
  agent,
  peerQueueKey,
  dispatchVersion,
}) {
  const runtime = getRuntime();
  const core = runtime.channel;
  const peerId = `kf:${openKfId}:${externalUserId}`;
  const route = core.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: accountId || "default",
    peer: { kind: "dm", id: peerId },
  });
  if (typeof route.sessionKey === "string" && !route.sessionKey.endsWith(`:${KF_SESSION_VERSION}`)) {
    route.sessionKey = `${route.sessionKey}:${KF_SESSION_VERSION}`;
  }

  const storePath = core.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = core.reply.formatAgentEnvelope({
    channel: "Enterprise WeChat Customer Service",
    from: externalUserId,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: core.reply.resolveEnvelopeFormatOptions(config),
    body: inboundText,
  });

  const ctxPayload = core.reply.finalizeInboundContext({
    Body: body,
    RawBody: inboundText,
    CommandBody: inboundText,
    From: `wecom-kf:${externalUserId}`,
    To: `wecom-kf:${openKfId}:${externalUserId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: `KF ${openKfId}`,
    SenderName: externalUserId,
    SenderId: externalUserId,
    Provider: "wecom",
    Surface: "wecom-kf",
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom-kf:${openKfId}`,
    CommandAuthorized: false,
    ...(mediaPaths.length > 0 && { MediaPaths: mediaPaths }),
    ...(mediaTypes.length > 0 && { MediaTypes: mediaTypes }),
  });

  void core.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      logger.error("[kf-bridge] session record failed", { error: err.message });
    });

  await streamContext.run(
    {
      accountId: route.accountId,
      agentId: route.agentId,
      senderId: externalUserId,
      kfOpenKfId: openKfId,
      kfExternalUserId: externalUserId,
      kfPeerQueueKey: peerQueueKey,
      kfDispatchVersion: dispatchVersion,
    },
    async () => {
      await core.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        replyOptions: {
          disableBlockStreaming: true,
        },
        dispatcherOptions: {
          deliver: async (payload, info) => {
            if (info.kind !== "final") return;
            const latestVersion = getKfPeerDispatchVersion(peerQueueKey) || dispatchVersion;
            if (latestVersion > dispatchVersion) {
              logger.info("[kf-bridge] skip stale reply", {
                openKfId,
                externalUserId,
                dispatchVersion,
                latestVersion,
              });
              return;
            }

            const mediaList = payload?.mediaUrls?.length
              ? payload.mediaUrls
              : (payload?.mediaUrl ? [payload.mediaUrl] : []);

            for (const mediaUrl of mediaList) {
              try {
                const { buffer, filename } = await readOutboundMediaBuffer(mediaUrl, route.agentId);
                const uploadType = resolveUploadTypeFromFilename(filename);
                const mediaId = await agentUploadMedia({
                  agent,
                  type: uploadType,
                  buffer,
                  filename,
                });
                await sendKfMedia({
                  agent,
                  openKfId,
                  externalUserId,
                  mediaType: uploadType,
                  mediaId,
                });
                logger.info("[kf-bridge] media delivered", {
                  openKfId,
                  externalUserId,
                  mediaType: uploadType,
                  filename,
                });
              } catch (mediaErr) {
                logger.error("[kf-bridge] media delivery failed", {
                  openKfId,
                  externalUserId,
                  mediaUrl: String(mediaUrl || "").slice(0, 120),
                  error: mediaErr.message,
                });
              }
            }

            const text = String(payload?.text || "").trim();
            if (text) {
              await sendKfText({
                agent,
                openKfId,
                externalUserId,
                text,
              });
            }

            logger.info("[kf-bridge] reply delivered", {
              openKfId,
              externalUserId,
              textPreview: text.substring(0, 80),
              mediaCount: mediaList.length,
            });
          },
          onError: (err, info) => {
            logger.error("[kf-bridge] dispatch error", {
              kind: info.kind,
              error: err.message,
            });
          },
        },
      });
    },
  );
}

export async function processKfCallbackEvent({
  agent,
  config,
  accountId,
  openKfId,
  syncToken,
}) {
  const messages = await syncKfMessages({
    agent,
    accountId,
    openKfId,
    syncToken,
  });

  const latestIndexByUser = new Map();
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    if (!isCustomerMessage(current)) continue;
    const externalUserId = String(current?.external_userid || "").trim();
    if (!externalUserId) continue;
    const text = extractKfText(current).trim();
    if (!text) continue;
    latestIndexByUser.set(externalUserId, index);
  }

  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    const msgId = String(msg?.msgid || "").trim();
    if (msgId && !rememberKfMsgId(msgId)) continue;
    if (!isCustomerMessage(msg)) continue;

    const externalUserId = String(msg.external_userid || "").trim();
    if (!externalUserId) continue;

    let inboundText = extractKfText(msg).trim();
    if (!inboundText) continue;
    const msgType = String(msg?.msgtype || "").toLowerCase();
    const latestIndex = latestIndexByUser.get(externalUserId);
    if (msgType === "text" && typeof latestIndex === "number" && index < latestIndex) {
      logger.info("[kf-bridge] skip stale text in same sync batch", {
        openKfId,
        externalUserId,
        msgId: msgId || "N/A",
        text: inboundText.slice(0, 80),
      });
      continue;
    }
    if (isSimpleGreeting(inboundText) && typeof latestIndex === "number" && index < latestIndex) {
      logger.info("[kf-bridge] skip stale greeting in same sync batch", {
        openKfId,
        externalUserId,
        msgId: msgId || "N/A",
        msgType,
        text: inboundText,
      });
      continue;
    }

    let mediaPaths = [];
    let mediaTypes = [];
    try {
      const media = await resolveKfMediaAttachments({ agent, msg });
      mediaPaths = media.mediaPaths;
      mediaTypes = media.mediaTypes;
      if (media.attachSummary) {
        inboundText += media.attachSummary;
      }
    } catch (mediaErr) {
      logger.error("[kf-bridge] media download failed", {
        openKfId,
        externalUserId,
        msgId: msgId || "N/A",
        msgType: String(msg?.msgtype || "").toLowerCase(),
        error: mediaErr.message,
      });
      inboundText += `\n\n[媒体下载失败：${mediaErr.message}]`;
    }

    const peerQueueKey = buildKfPeerKey(accountId, openKfId, externalUserId);
    const dispatchVersion = nextPeerDispatchVersion(peerQueueKey);
    try {
      logger.info("[kf-bridge] inbound customer message", {
        openKfId,
        externalUserId,
        msgId: msgId || "N/A",
        msgType,
        textPreview: inboundText.slice(0, 120),
        mediaCount: mediaPaths.length,
        dispatchVersion,
      });
      await enqueueKfDispatch(peerQueueKey, async () => {
        await dispatchToAgentAndReply({
          config,
          accountId,
          openKfId,
          externalUserId,
          inboundText,
          mediaPaths,
          mediaTypes,
          agent,
          peerQueueKey,
          dispatchVersion,
        });
      });
    } catch (err) {
      logger.error("[kf-bridge] failed handling customer message", {
        openKfId,
        externalUserId,
        msgId: msgId || "N/A",
        error: err.message,
      });
      try {
        const latestVersion = getKfPeerDispatchVersion(peerQueueKey) || 0;
        if (latestVersion > dispatchVersion) {
          logger.info("[kf-bridge] skip fallback text for stale/overridden dispatch", {
            openKfId,
            externalUserId,
            dispatchVersion,
            latestVersion,
          });
          continue;
        }
        await sendKfText({
          agent,
          openKfId,
          externalUserId,
          text: "抱歉，我这边暂时繁忙，请稍后再试。",
        });
      } catch (sendErr) {
        logger.error("[kf-bridge] failed sending fallback text", {
          openKfId,
          externalUserId,
          error: sendErr.message,
        });
      }
    }
  }
}
