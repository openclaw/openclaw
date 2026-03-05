import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import { basename, join } from "node:path";
import { logger } from "../logger.js";
import { streamManager } from "../stream-manager.js";
import {
  agentSendMedia,
  agentSendText,
  agentUploadMedia,
  getAccessToken,
} from "./agent-api.js";
import {
  listAccountIds,
  resolveAccount,
  detectAccountConflicts,
} from "./accounts.js";
import {
  AGENT_API_REQUEST_TIMEOUT_MS,
  DEFAULT_ACCOUNT_ID,
  THINKING_PLACEHOLDER,
} from "./constants.js";
import { parseResponseUrlResult } from "./response-url.js";
import {
  buildKfPeerKey,
  getKfPeerDispatchVersion,
  messageBuffers,
  resolveAgentConfig,
  resolveWebhookUrl,
  responseUrls,
  streamContext,
  streamMeta,
} from "./state.js";
import {
  resolveRecoverableStream,
  unregisterActiveStream,
} from "./stream-utils.js";
import { resolveWecomTarget } from "./target.js";
import {
  webhookSendImage,
  webhookSendText,
  webhookUploadFile,
  webhookSendFile,
} from "./webhook-bot.js";
import { registerWebhookTarget } from "./webhook-targets.js";
import { resolveAgentWorkspaceDirLocal } from "./workspace-template.js";

const AGENT_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "bmp"]);
const WECOM_SIMPLE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const WECOM_KF_SEND_MSG_ENDPOINT =
  "https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg";

export function resolveAgentMediaTypeFromFilename(filename) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return AGENT_IMAGE_EXTS.has(ext) ? "image" : "file";
}

function normalizeLocalMediaPath(rawMediaUrl) {
  let normalized = String(rawMediaUrl || "").trim();
  if (normalized.startsWith("sandbox:")) {
    normalized = normalized.replace(/^sandbox:\/{0,2}/, "");
    if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  }
  return normalized;
}

/** Allowed base directories for local file access. */
const ALLOWED_LOCAL_PREFIXES = ["/tmp/", "/var/tmp/"];

function isAllowedLocalPath(absPath) {
  for (const prefix of ALLOWED_LOCAL_PREFIXES) {
    if (absPath.startsWith(prefix)) return true;
  }
  const homeDir = process.env.HOME || "";
  if (homeDir && absPath.startsWith(join(homeDir, ".openclaw/"))) return true;
  return false;
}

function isAllowedRemoteUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function loadMediaForUpload(rawMediaUrl) {
  const mediaUrl = normalizeLocalMediaPath(rawMediaUrl);
  if (mediaUrl.startsWith("/")) {
    if (!isAllowedLocalPath(mediaUrl)) {
      throw new Error(`local path not allowed: ${mediaUrl}`);
    }
    return {
      buffer: await readFile(mediaUrl),
      filename: basename(mediaUrl) || "file",
      contentType: "",
      normalizedUrl: mediaUrl,
    };
  }
  if (!isAllowedRemoteUrl(mediaUrl)) {
    throw new Error(`remote URL not allowed: ${mediaUrl}`);
  }
  const res = await fetch(mediaUrl, {
    signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`download media failed: ${res.status}`);
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    filename: basename(new URL(mediaUrl).pathname) || "file",
    contentType: res.headers.get("content-type") || "",
    normalizedUrl: mediaUrl,
  };
}

async function sendKfMessage({
  agent,
  openKfId,
  externalUserId,
  msgtype,
  payload,
}) {
  const accessToken = await getAccessToken(agent);
  const res = await fetch(
    `${WECOM_KF_SEND_MSG_ENDPOINT}?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: externalUserId,
        open_kfid: openKfId,
        msgtype,
        [msgtype]: payload,
      }),
      signal: AbortSignal.timeout(AGENT_API_REQUEST_TIMEOUT_MS),
    },
  );
  const json = await res.json();
  if (json?.errcode !== 0) {
    throw new Error(
      `kf send ${msgtype} failed: ${json?.errcode} ${json?.errmsg}`,
    );
  }
}

function normalizeWecomMessagingTarget(raw) {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const clean = trimmed
    .replace(/^(wecom-agent|wecom|wechatwork|wework|qywx):/i, "")
    .trim();
  return clean || undefined;
}

function looksLikeWecomTargetId(raw, normalized) {
  const candidate =
    typeof normalized === "string" && normalized.trim()
      ? normalized.trim()
      : normalizeWecomMessagingTarget(raw);
  if (!candidate) return false;

  if (/^(user|dm|group|chat|party|dept|tag|webhook):/i.test(candidate)) {
    return true;
  }
  if (/^(wr|wc)/i.test(candidate)) {
    return true;
  }
  return WECOM_SIMPLE_ID_REGEX.test(candidate);
}

function isStaleKfDispatch(ctx, op) {
  if (!ctx?.kfOpenKfId || !ctx?.kfExternalUserId) return false;
  const dispatchVersion = Number(ctx.kfDispatchVersion || 0);
  if (!dispatchVersion) return false;
  const peerKey =
    ctx.kfPeerQueueKey ||
    buildKfPeerKey(ctx.accountId, ctx.kfOpenKfId, ctx.kfExternalUserId);
  if (!peerKey) return false;
  const latestVersion = getKfPeerDispatchVersion(peerKey);
  if (latestVersion > dispatchVersion) {
    logger.info("WeCom: skip stale KF outbound", {
      op,
      openKfId: ctx.kfOpenKfId,
      externalUserId: ctx.kfExternalUserId,
      dispatchVersion,
      latestVersion,
    });
    return true;
  }
  return false;
}

export const wecomChannelPlugin = {
  id: "wecom",
  meta: {
    id: "wecom",
    label: "Enterprise WeChat",
    selectionLabel: "Enterprise WeChat (AI Bot)",
    docsPath: "/channels/wecom",
    blurb: "Enterprise WeChat AI Bot channel plugin.",
    aliases: ["wecom", "wework"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true, // WeCom AI Bot requires stream-style responses.
  },
  messaging: {
    normalizeTarget: (raw) => normalizeWecomMessagingTarget(raw),
    targetResolver: {
      looksLikeId: (raw, normalized) => looksLikeWecomTargetId(raw, normalized),
      hint: "<userId|chat:chatId|party:id|tag:id|webhook:name>",
    },
  },
  reload: { configPrefixes: ["channels.wecom"] },
  configSchema: {
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          description: "Enable WeCom channel",
          default: true,
        },
        token: {
          type: "string",
          description: "WeCom bot token from admin console",
        },
        encodingAesKey: {
          type: "string",
          description: "WeCom message encryption key (43 characters)",
          minLength: 43,
          maxLength: 43,
        },
        commands: {
          type: "object",
          description: "Command whitelist configuration",
          additionalProperties: false,
          properties: {
            enabled: {
              type: "boolean",
              description: "Enable command whitelist filtering",
              default: true,
            },
            allowlist: {
              type: "array",
              description: "Allowed commands (e.g., /new, /status, /help)",
              items: {
                type: "string",
              },
              default: ["/new", "/status", "/help", "/compact"],
            },
          },
        },
        dynamicAgents: {
          type: "object",
          description: "Dynamic agent routing configuration",
          additionalProperties: false,
          properties: {
            enabled: {
              type: "boolean",
              description: "Enable per-user/per-group agent isolation",
              default: true,
            },
          },
        },
        dm: {
          type: "object",
          description: "Direct message (private chat) configuration",
          additionalProperties: false,
          properties: {
            createAgentOnFirstMessage: {
              type: "boolean",
              description: "Create separate agent for each user",
              default: true,
            },
          },
        },
        groupChat: {
          type: "object",
          description: "Group chat configuration",
          additionalProperties: false,
          properties: {
            enabled: {
              type: "boolean",
              description: "Enable group chat support",
              default: true,
            },
            requireMention: {
              type: "boolean",
              description: "Only respond when @mentioned in groups",
              default: true,
            },
          },
        },
        adminUsers: {
          type: "array",
          description:
            "Admin users who bypass command allowlist (routing unchanged)",
          items: { type: "string" },
          default: [],
        },
        workspaceTemplate: {
          type: "string",
          description:
            "Directory with custom bootstrap templates (AGENTS.md, BOOTSTRAP.md, etc.)",
        },
        agent: {
          type: "object",
          description:
            "Agent mode (self-built application) configuration for outbound messaging and inbound callbacks",
          additionalProperties: false,
          properties: {
            corpId: { type: "string", description: "Enterprise Corp ID" },
            corpSecret: { type: "string", description: "Application Secret" },
            agentId: { type: "number", description: "Application Agent ID" },
            token: {
              type: "string",
              description: "Callback Token for Agent inbound",
            },
            encodingAesKey: {
              type: "string",
              description:
                "Callback Encoding AES Key for Agent inbound (43 characters)",
              minLength: 43,
              maxLength: 43,
            },
          },
        },
        webhooks: {
          type: "object",
          description:
            "Webhook bot URLs for group notifications (key: name, value: webhook URL or key)",
          additionalProperties: { type: "string" },
        },
        instances: {
          type: "array",
          description:
            "Additional bot / agent accounts. Each entry inherits top-level fields it does not override.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: {
                type: "string",
                description:
                  "Unique account slug (lowercase, a-z0-9_- only). Used as accountId and in webhook paths.",
                pattern: "^[a-z0-9_-]+$",
              },
              enabled: { type: "boolean", default: true },
              token: {
                type: "string",
                description: "Bot Token (overrides top-level)",
              },
              encodingAesKey: {
                type: "string",
                description: "Encoding AES Key (overrides top-level)",
                minLength: 43,
                maxLength: 43,
              },
              agent: {
                type: "object",
                description:
                  "Agent configuration for this instance (full replacement, not merged with top-level)",
                properties: {
                  corpId: { type: "string" },
                  corpSecret: { type: "string" },
                  agentId: { type: "number" },
                  token: { type: "string" },
                  encodingAesKey: {
                    type: "string",
                    minLength: 43,
                    maxLength: 43,
                  },
                },
              },
              webhooks: {
                type: "object",
                description: "Webhook bot URLs for this instance",
                additionalProperties: { type: "string" },
              },
              webhookPath: {
                type: "string",
                description:
                  "Custom webhook path (default: /webhooks/wecom/{name})",
              },
            },
          },
        },
      },
    },
    uiHints: {
      token: {
        sensitive: true,
        label: "Bot Token",
      },
      encodingAesKey: {
        sensitive: true,
        label: "Encoding AES Key",
        help: "43-character encryption key from WeCom admin console",
      },
      "agent.corpSecret": {
        sensitive: true,
        label: "Application Secret",
      },
      "agent.token": {
        sensitive: true,
        label: "Agent Callback Token",
      },
      "agent.encodingAesKey": {
        sensitive: true,
        label: "Agent Callback Encoding AES Key",
        help: "43-character encryption key for Agent inbound callbacks",
      },
    },
  },
  config: {
    listAccountIds: (cfg) => listAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
    defaultAccountId: (cfg) => {
      const ids = listAccountIds(cfg);
      return ids.length > 0 ? ids[0] : null;
    },
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels.wecom) cfg.channels.wecom = {};
      const wecom = cfg.channels.wecom;
      if (!accountId || accountId === DEFAULT_ACCOUNT_ID) {
        // Legacy single-account: toggle top-level enabled.
        wecom.enabled = enabled;
      } else if (wecom[accountId] && typeof wecom[accountId] === "object") {
        // Dictionary mode: toggle per-account enabled.
        wecom[accountId].enabled = enabled;
      }
      return cfg;
    },
    deleteAccount: ({ cfg, accountId }) => {
      if (!accountId || accountId === DEFAULT_ACCOUNT_ID) {
        if (cfg.channels?.wecom) delete cfg.channels.wecom;
      } else if (cfg.channels?.wecom) {
        delete cfg.channels.wecom[accountId];
      }
      return cfg;
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  // Outbound adapter: all replies are streamed for WeCom AI Bot compatibility.
  outbound: {
    sendText: async ({ cfg: _cfg, to, text, accountId }) => {
      // `to` format: "wecom:userid" or "userid".
      const userId = to.replace(/^wecom:/, "");

      // Prefer stream from async context (correct for concurrent processing).
      const ctx = streamContext.getStore();
      if (isStaleKfDispatch(ctx, "sendText")) {
        return {
          channel: "wecom",
          messageId: `msg_kf_stale_skip_${Date.now()}`,
        };
      }
      const kfOpenKfId = ctx?.kfOpenKfId;
      const kfExternalUserId = ctx?.kfExternalUserId;
      const streamId = ctx?.streamId ?? resolveRecoverableStream(userId);

      // Layer 1: Active stream (normal path)
      if (
        streamId &&
        streamManager.hasStream(streamId) &&
        !streamManager.getStream(streamId)?.finished
      ) {
        logger.debug("Appending outbound text to stream", {
          userId,
          streamId,
          source: ctx ? "asyncContext" : "activeStreams",
          text: text.substring(0, 30),
        });
        // Replace placeholder or append content.
        streamManager.replaceIfPlaceholder(
          streamId,
          text,
          THINKING_PLACEHOLDER,
        );

        return {
          channel: "wecom",
          messageId: `msg_stream_${Date.now()}`,
        };
      }

      // Layer 2: Fallback via response_url
      // response_url is valid for 1 hour and can be used only once.
      // responseUrls is keyed by streamKey (fromUser for DM, chatId for group).
      const saved = responseUrls.get(ctx?.streamKey ?? userId);
      if (saved && !saved.used && Date.now() < saved.expiresAt) {
        try {
          const response = await fetch(saved.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ msgtype: "text", text: { content: text } }),
          });
          const responseBody = await response.text().catch(() => "");
          const result = parseResponseUrlResult(response, responseBody);
          if (!result.accepted) {
            logger.error("WeCom: response_url fallback rejected", {
              userId,
              status: response.status,
              statusText: response.statusText,
              errcode: result.errcode,
              errmsg: result.errmsg,
              bodyPreview: result.bodyPreview,
            });
          } else {
            saved.used = true;
            logger.info("WeCom: sent via response_url fallback", {
              userId,
              status: response.status,
              errcode: result.errcode,
            });
            return {
              channel: "wecom",
              messageId: `msg_response_url_${Date.now()}`,
            };
          }
        } catch (err) {
          logger.error("WeCom: response_url fallback failed", {
            userId,
            error: err.message,
          });
        }
      }

      // Layer 3a: WeCom KF fallback (customer service session)
      if (kfOpenKfId && kfExternalUserId) {
        const agentConfig = resolveAgentConfig(accountId);
        if (agentConfig) {
          try {
            await sendKfMessage({
              agent: agentConfig,
              openKfId: kfOpenKfId,
              externalUserId: kfExternalUserId,
              msgtype: "text",
              payload: { content: text },
            });
            logger.info("WeCom: sent via KF API fallback (sendText)", {
              kfOpenKfId,
              externalUserId: kfExternalUserId,
              contentPreview: text.substring(0, 50),
            });
            return {
              channel: "wecom",
              messageId: `msg_kf_text_${Date.now()}`,
            };
          } catch (err) {
            logger.error("WeCom: KF API fallback failed (sendText)", {
              kfOpenKfId,
              externalUserId: kfExternalUserId,
              error: err.message,
            });
          }
        } else {
          logger.warn("WeCom: KF sendText skipped (agent config missing)", {
            kfOpenKfId,
            externalUserId: kfExternalUserId,
          });
        }
      }

      // Layer 3a: Webhook Bot (group notifications via webhook:name target)
      const target = resolveWecomTarget(to);
      if (target?.webhook) {
        const webhookUrl = resolveWebhookUrl(target.webhook, accountId);
        if (webhookUrl) {
          try {
            await webhookSendText({ url: webhookUrl, content: text });
            logger.info("WeCom: sent via Webhook Bot (sendText)", {
              webhookName: target.webhook,
              contentPreview: text.substring(0, 50),
            });
            return {
              channel: "wecom",
              messageId: `msg_webhook_${Date.now()}`,
            };
          } catch (err) {
            logger.error("WeCom: Webhook Bot sendText failed", {
              webhookName: target.webhook,
              error: err.message,
            });
          }
        } else {
          logger.warn("WeCom: webhook name not found in config", {
            webhookName: target.webhook,
          });
        }
      }

      // Layer 3b: Agent API fallback (stream closed + response_url unavailable)
      const agentConfig = resolveAgentConfig(accountId);
      if (agentConfig) {
        try {
          const agentTarget =
            target && !target.webhook ? target : { toUser: userId };
          await agentSendText({ agent: agentConfig, ...agentTarget, text });
          logger.info("WeCom: sent via Agent API fallback (sendText)", {
            userId,
            to,
            contentPreview: text.substring(0, 50),
          });
          return {
            channel: "wecom",
            messageId: `msg_agent_${Date.now()}`,
          };
        } catch (err) {
          logger.error("WeCom: Agent API fallback failed (sendText)", {
            userId,
            error: err.message,
          });
        }
      }

      logger.warn(
        "WeCom outbound: no delivery channel available (all layers exhausted)",
        {
          userId,
        },
      );

      return {
        channel: "wecom",
        messageId: `fake_${Date.now()}`,
      };
    },
    sendMedia: async ({ cfg: _cfg, to, text, mediaUrl, accountId }) => {
      const userId = to.replace(/^wecom:/, "");
      const isLikelyGroupChatId = /^(wr|wc)/i.test(userId);

      // Prefer stream from async context (correct for concurrent processing).
      const ctx = streamContext.getStore();
      if (isStaleKfDispatch(ctx, "sendMedia")) {
        return {
          channel: "wecom",
          messageId: `msg_kf_stale_skip_${Date.now()}`,
        };
      }
      const kfOpenKfId = ctx?.kfOpenKfId;
      const kfExternalUserId = ctx?.kfExternalUserId;
      const streamId = ctx?.streamId ?? resolveRecoverableStream(userId);
      const streamSenderId =
        ctx?.senderId ||
        (streamId ? streamMeta.get(streamId)?.senderId : undefined);
      const dmUserId = streamSenderId || (isLikelyGroupChatId ? "" : userId);

      if (streamId && streamManager.hasStream(streamId)) {
        // Check if mediaUrl is a local path (sandbox: prefix or absolute path)
        const isLocalPath =
          mediaUrl.startsWith("sandbox:") || mediaUrl.startsWith("/");

        if (isLocalPath) {
          // Convert sandbox: URLs to absolute paths.
          // sandbox:///tmp/a -> /tmp/a, sandbox://tmp/a -> /tmp/a, sandbox:/tmp/a -> /tmp/a
          let absolutePath = mediaUrl;
          if (absolutePath.startsWith("sandbox:")) {
            absolutePath = absolutePath.replace(/^sandbox:\/{0,2}/, "");
            // Ensure the result is an absolute path.
            if (!absolutePath.startsWith("/")) {
              absolutePath = "/" + absolutePath;
            }
          }

          const fileFilename = basename(absolutePath);
          const fileExt = fileFilename.split(".").pop()?.toLowerCase() || "";
          const streamImageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp"]);

          if (!streamImageExts.has(fileExt)) {
            // Non-image file: WeCom Bot stream API does not support files.
            // Send via Agent DM and post a hint in the group stream.
            logger.debug(
              "Non-image file in active stream, routing via Agent DM",
              {
                userId,
                streamId,
                absolutePath,
                fileExt,
              },
            );
            const agentCfgForFile = resolveAgentConfig(accountId);
            if (agentCfgForFile) {
              try {
                if (!dmUserId) {
                  throw new Error("无法确定群聊发起人的企业微信userid");
                }
                const fileBuf = await readFile(absolutePath);
                const fileMediaId = await agentUploadMedia({
                  agent: agentCfgForFile,
                  type: "file",
                  buffer: fileBuf,
                  filename: fileFilename,
                });
                await agentSendMedia({
                  agent: agentCfgForFile,
                  toUser: dmUserId,
                  mediaId: fileMediaId,
                  mediaType: "file",
                });
                const fileHint = text
                  ? `${text}\n\n📎 文件已通过私信发送给您：${fileFilename}`
                  : `📎 文件已通过私信发送给您：${fileFilename}`;
                streamManager.replaceIfPlaceholder(
                  streamId,
                  fileHint,
                  THINKING_PLACEHOLDER,
                );
                logger.info(
                  "WeCom: sent non-image file via Agent DM (active stream)",
                  {
                    userId: dmUserId,
                    filename: fileFilename,
                  },
                );
              } catch (fileErr) {
                logger.error(
                  "WeCom: Agent DM file send failed (active stream)",
                  {
                    userId: dmUserId,
                    filename: fileFilename,
                    error: fileErr.message,
                  },
                );
                const errHint = text
                  ? `${text}\n\n⚠️ 文件发送失败（${fileFilename}）：${fileErr.message}`
                  : `⚠️ 文件发送失败（${fileFilename}）：${fileErr.message}`;
                streamManager.replaceIfPlaceholder(
                  streamId,
                  errHint,
                  THINKING_PLACEHOLDER,
                );
              }
            } else {
              // No Agent API configured — post a notice in stream.
              const noAgentHint = text
                ? `${text}\n\n⚠️ 无法发送文件 ${fileFilename}（未配置 Agent API）`
                : `⚠️ 无法发送文件 ${fileFilename}（未配置 Agent API）`;
              streamManager.replaceIfPlaceholder(
                streamId,
                noAgentHint,
                THINKING_PLACEHOLDER,
              );
            }
            return {
              channel: "wecom",
              messageId: `msg_stream_file_${Date.now()}`,
            };
          }

          logger.debug("Queueing local image for stream", {
            userId,
            streamId,
            mediaUrl,
            absolutePath,
          });

          // Queue the image for processing when stream finishes
          const queued = streamManager.queueImage(streamId, absolutePath);

          if (queued) {
            // Append text content to stream (without markdown image)
            if (text) {
              streamManager.replaceIfPlaceholder(
                streamId,
                text,
                THINKING_PLACEHOLDER,
              );
            }

            // Append placeholder indicating image will follow
            const imagePlaceholder = "\n\n[图片]";
            streamManager.appendStream(streamId, imagePlaceholder);

            return {
              channel: "wecom",
              messageId: `msg_stream_img_${Date.now()}`,
            };
          } else {
            logger.warn("Failed to queue image, falling back to markdown", {
              userId,
              streamId,
              mediaUrl,
            });
            // Fallback to old behavior
          }
        }

        // OLD BEHAVIOR: For external URLs or if queueing failed, use markdown
        const content = text
          ? `${text}\n\n![image](${mediaUrl})`
          : `![image](${mediaUrl})`;
        logger.debug("Appending outbound media to stream (markdown)", {
          userId,
          streamId,
          mediaUrl,
        });

        // Replace placeholder or append media markdown to the current stream content.
        streamManager.replaceIfPlaceholder(
          streamId,
          content,
          THINKING_PLACEHOLDER,
        );

        return {
          channel: "wecom",
          messageId: `msg_stream_${Date.now()}`,
        };
      }

      logger.warn(
        "WeCom outbound sendMedia: no active stream, trying fallbacks",
        { userId },
      );

      // Layer 2a: WeCom KF fallback (customer service session)
      if (kfOpenKfId && kfExternalUserId) {
        const agentConfig = resolveAgentConfig(accountId);
        if (agentConfig) {
          try {
            const { buffer, filename, contentType, normalizedUrl } =
              await loadMediaForUpload(mediaUrl);
            let uploadType = resolveAgentMediaTypeFromFilename(filename);
            if (
              uploadType === "file" &&
              contentType.toLowerCase().startsWith("image/")
            ) {
              uploadType = "image";
            }
            const mediaId = await agentUploadMedia({
              agent: agentConfig,
              type: uploadType,
              buffer,
              filename,
            });
            await sendKfMessage({
              agent: agentConfig,
              openKfId: kfOpenKfId,
              externalUserId: kfExternalUserId,
              msgtype: uploadType,
              payload: { media_id: mediaId },
            });
            if (text) {
              await sendKfMessage({
                agent: agentConfig,
                openKfId: kfOpenKfId,
                externalUserId: kfExternalUserId,
                msgtype: "text",
                payload: { content: text },
              });
            }
            logger.info("WeCom: sent media via KF API fallback (sendMedia)", {
              kfOpenKfId,
              externalUserId: kfExternalUserId,
              mediaType: uploadType,
              filename,
              mediaUrl: normalizedUrl.substring(0, 80),
            });
            return {
              channel: "wecom",
              messageId: `msg_kf_media_${Date.now()}`,
            };
          } catch (err) {
            logger.error("WeCom: KF API media fallback failed", {
              kfOpenKfId,
              externalUserId: kfExternalUserId,
              error: err.message,
            });
          }
        } else {
          logger.warn("WeCom: KF sendMedia skipped (agent config missing)", {
            kfOpenKfId,
            externalUserId: kfExternalUserId,
          });
        }
      }

      // Layer 2a: Webhook Bot fallback for media (group notifications)
      const target = resolveWecomTarget(to);
      if (target?.webhook) {
        const webhookUrl = resolveWebhookUrl(target.webhook, accountId);
        if (webhookUrl) {
          try {
            // Resolve file to buffer
            let buffer;
            let filename;
            let absolutePath = mediaUrl;
            if (absolutePath.startsWith("sandbox:")) {
              absolutePath = absolutePath.replace(/^sandbox:\/{0,2}/, "");
              if (!absolutePath.startsWith("/"))
                absolutePath = "/" + absolutePath;
            }

            if (absolutePath.startsWith("/")) {
              buffer = await readFile(absolutePath);
              filename = basename(absolutePath);
            } else {
              const res = await fetch(mediaUrl);
              buffer = Buffer.from(await res.arrayBuffer());
              filename = basename(new URL(mediaUrl).pathname) || "image.png";
            }

            // Try image (base64) for common image types, otherwise upload as file
            const ext = filename.split(".").pop()?.toLowerCase() || "";
            const imageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp"]);

            if (imageExts.has(ext)) {
              const base64 = buffer.toString("base64");
              const md5 = crypto.createHash("md5").update(buffer).digest("hex");
              await webhookSendImage({ url: webhookUrl, base64, md5 });
            } else {
              const mediaId = await webhookUploadFile({
                url: webhookUrl,
                buffer,
                filename,
              });
              await webhookSendFile({ url: webhookUrl, mediaId });
            }

            // Send accompanying text if present
            if (text) {
              await webhookSendText({ url: webhookUrl, content: text });
            }

            logger.info("WeCom: sent media via Webhook Bot (sendMedia)", {
              webhookName: target.webhook,
              mediaUrl: mediaUrl.substring(0, 80),
            });
            return {
              channel: "wecom",
              messageId: `msg_webhook_media_${Date.now()}`,
            };
          } catch (err) {
            logger.error("WeCom: Webhook Bot sendMedia failed", {
              webhookName: target.webhook,
              error: err.message,
            });
          }
        } else {
          logger.warn("WeCom: webhook name not found in config (sendMedia)", {
            webhookName: target.webhook,
          });
        }
      }

      // Layer 2b: Agent API fallback for media
      const agentConfig = resolveAgentConfig(accountId);
      if (agentConfig) {
        try {
          // For group-triggered media fallback, prefer DM to the real sender.
          const inferredDmTarget = dmUserId ? { toUser: dmUserId } : null;
          const agentTarget =
            inferredDmTarget ||
            (target && !target.webhook
              ? target
              : resolveWecomTarget(to) || { toUser: userId });
          let deliveredFilename = "file";

          // Determine if mediaUrl is a local file path.
          let absolutePath = mediaUrl;
          if (absolutePath.startsWith("sandbox:")) {
            absolutePath = absolutePath.replace(/^sandbox:\/{0,2}/, "");
            if (!absolutePath.startsWith("/"))
              absolutePath = "/" + absolutePath;
          }

          if (absolutePath.startsWith("/")) {
            // Upload local file then send via Agent API.
            const buffer = await readFile(absolutePath);
            const filename = basename(absolutePath);
            deliveredFilename = filename;
            const uploadType = resolveAgentMediaTypeFromFilename(filename);
            const mediaId = await agentUploadMedia({
              agent: agentConfig,
              type: uploadType,
              buffer,
              filename,
            });
            await agentSendMedia({
              agent: agentConfig,
              ...agentTarget,
              mediaId,
              mediaType: uploadType,
            });
          } else {
            // For external URLs, download first then upload.
            const res = await fetch(mediaUrl);
            if (!res.ok) {
              throw new Error(`download media failed: ${res.status}`);
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            const filename = basename(new URL(mediaUrl).pathname) || "file";
            deliveredFilename = filename;
            let uploadType = resolveAgentMediaTypeFromFilename(filename);
            const contentType = res.headers.get("content-type") || "";
            if (
              uploadType === "file" &&
              contentType.toLowerCase().startsWith("image/")
            ) {
              uploadType = "image";
            }
            const mediaId = await agentUploadMedia({
              agent: agentConfig,
              type: uploadType,
              buffer,
              filename,
            });
            await agentSendMedia({
              agent: agentConfig,
              ...agentTarget,
              mediaId,
              mediaType: uploadType,
            });
          }

          // Also send accompanying text if present.
          if (text) {
            await agentSendText({ agent: agentConfig, ...agentTarget, text });
          }

          // Best-effort stream recovery: when async context is missing and the
          // active stream mapping was already cleaned, still clear "thinking..."
          // in the most recent stream for this user.
          const recoverStreamId = resolveRecoverableStream(userId);
          if (recoverStreamId && streamManager.hasStream(recoverStreamId)) {
            const recoverStream = streamManager.getStream(recoverStreamId);
            if (recoverStream && !recoverStream.finished) {
              const deliveryHint = text
                ? `${text}\n\n📎 文件已通过私信发送给您：${deliveredFilename}`
                : `📎 文件已通过私信发送给您：${deliveredFilename}`;
              streamManager.replaceIfPlaceholder(
                recoverStreamId,
                deliveryHint,
                THINKING_PLACEHOLDER,
              );
              await streamManager.finishStream(recoverStreamId);
              unregisterActiveStream(userId, recoverStreamId);
              logger.info(
                "WeCom: recovered and finished stream after media fallback",
                {
                  userId,
                  streamId: recoverStreamId,
                },
              );
            }
          }

          logger.info("WeCom: sent media via Agent API fallback (sendMedia)", {
            userId: dmUserId,
            to,
            mediaUrl: mediaUrl.substring(0, 80),
          });
          return {
            channel: "wecom",
            messageId: `msg_agent_media_${Date.now()}`,
          };
        } catch (err) {
          logger.error("WeCom: Agent API media fallback failed", {
            userId,
            error: err.message,
          });
        }
      }

      return {
        channel: "wecom",
        messageId: `fake_${Date.now()}`,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      logger.info("WeCom gateway starting", {
        accountId: account.accountId,
        webhookPath: account.webhookPath,
      });

      // Conflict detection: warn about duplicate tokens / agent IDs.
      const conflicts = detectAccountConflicts(ctx.cfg);
      for (const conflict of conflicts) {
        logger.error(`WeCom config conflict: ${conflict.message}`, {
          type: conflict.type,
          accounts: conflict.accounts,
        });
      }

      const unregister = registerWebhookTarget({
        path: account.webhookPath || "/webhooks/wecom",
        account,
        config: ctx.cfg,
      });

      // Register Agent inbound webhook if agent inbound is fully configured.
      let unregisterAgent;
      // Per-account agent path: /webhooks/app for default, /webhooks/app/{accountId} for others.
      const agentInboundPath =
        account.accountId === DEFAULT_ACCOUNT_ID
          ? "/webhooks/app"
          : `/webhooks/app/${account.accountId}`;
      const botPath = account.webhookPath || "/webhooks/wecom";
      if (account.agentInboundConfigured) {
        if (botPath === agentInboundPath) {
          logger.error(
            "WeCom: Agent inbound path conflicts with Bot webhook path, skipping Agent registration",
            {
              path: agentInboundPath,
            },
          );
        } else {
          const agentCfg = account.config.agent;
          unregisterAgent = registerWebhookTarget({
            path: agentInboundPath,
            account: {
              ...account,
              // Agent inbound uses its own token/encodingAesKey for callback verification.
              agentInbound: {
                accountId: account.accountId,
                token: agentCfg.token,
                encodingAesKey: agentCfg.encodingAesKey,
                corpId: agentCfg.corpId,
                corpSecret: agentCfg.corpSecret,
                agentId: agentCfg.agentId,
              },
            },
            config: ctx.cfg,
          });
          logger.info("WeCom Agent inbound webhook registered", {
            path: agentInboundPath,
          });
        }
      }

      const shutdown = async () => {
        logger.info("WeCom gateway shutting down");
        // Clear pending debounce timers to prevent post-shutdown dispatches.
        for (const [, buf] of messageBuffers) {
          clearTimeout(buf.timer);
        }
        messageBuffers.clear();
        unregister();
        if (unregisterAgent) unregisterAgent();
      };

      // Backward compatibility: older runtime may not pass abortSignal.
      // In that case, keep legacy behavior and expose explicit shutdown.
      if (!ctx.abortSignal) {
        return { shutdown };
      }

      if (ctx.abortSignal.aborted) {
        await shutdown();
        return;
      }

      await new Promise((resolve) => {
        ctx.abortSignal.addEventListener("abort", resolve, { once: true });
      });

      await shutdown();
    },
  },
};
