import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WecomCrypto } from "./crypto.js";
import {
  generateAgentId,
  getDynamicAgentConfig,
  shouldUseDynamicAgent,
  shouldTriggerGroupResponse,
  extractGroupMessageContent,
} from "./dynamic-agent.js";
import { logger } from "./logger.js";
import { streamManager } from "./stream-manager.js";
import { WecomWebhook } from "./webhook.js";

const DEFAULT_ACCOUNT_ID = "default";

// Placeholder shown while the LLM is processing or the message is queued.
const THINKING_PLACEHOLDER = "思考中...";

// Image cache directory.
const MEDIA_CACHE_DIR = join(process.env.HOME || "/tmp", ".openclaw", "media", "wecom");

// =============================================================================
// Command allowlist configuration
// =============================================================================

// Slash commands that are allowed by default.
const DEFAULT_COMMAND_ALLOWLIST = ["/new", "/compact", "/help", "/status"];

// Default message shown when a command is blocked.
const DEFAULT_COMMAND_BLOCK_MESSAGE = `⚠️ 该命令不可用。

支持的命令：
• **/new** - 新建会话
• **/compact** - 压缩会话（保留上下文摘要）
• **/help** - 查看帮助
• **/status** - 查看状态`;

/**
 * Read command allowlist settings from config.
 */
function getCommandConfig(config) {
  const wecom = config?.channels?.wecom || {};
  const commands = wecom.commands || {};
  return {
    allowlist: commands.allowlist || DEFAULT_COMMAND_ALLOWLIST,
    blockMessage: commands.blockMessage || DEFAULT_COMMAND_BLOCK_MESSAGE,
    enabled: commands.enabled !== false,
  };
}

/**
 * Check whether a slash command is allowed.
 * @param {string} message - User message
 * @param {Object} config - OpenClaw config
 * @returns {{ isCommand: boolean, allowed: boolean, command: string | null }}
 */
function checkCommandAllowlist(message, config) {
  const trimmed = message.trim();

  // Not a slash command.
  if (!trimmed.startsWith("/")) {
    return { isCommand: false, allowed: true, command: null };
  }

  // Use the first token as the command.
  const command = trimmed.split(/\s+/)[0].toLowerCase();

  const cmdConfig = getCommandConfig(config);

  // Allow all commands when command gating is disabled.
  if (!cmdConfig.enabled) {
    return { isCommand: true, allowed: true, command };
  }

  // Require explicit allowlist match.
  const allowed = cmdConfig.allowlist.some((cmd) => cmd.toLowerCase() === command);

  return { isCommand: true, allowed, command };
}

/**
 * Read admin user list from channels.wecom.adminUsers.
 * Admins bypass the command allowlist and skip dynamic agent routing.
 */
function getWecomAdminUsers(config) {
  const raw = config?.channels?.wecom?.adminUsers;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((u) =>
      String(u ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function isWecomAdmin(userId, config) {
  if (!userId) {
    return false;
  }
  const admins = getWecomAdminUsers(config);
  return admins.length > 0 && admins.includes(String(userId).trim().toLowerCase());
}

/**
 * Download and decrypt a WeCom encrypted image.
 * @param {string} imageUrl - Encrypted image URL from WeCom
 * @param {string} encodingAesKey - AES key
 * @param {string} token - Token
 * @returns {Promise<string>} Local path to decrypted image
 */
async function downloadAndDecryptImage(imageUrl, encodingAesKey, token) {
  if (!existsSync(MEDIA_CACHE_DIR)) {
    mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  }

  logger.info("Downloading encrypted image", { url: imageUrl.substring(0, 80) });
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }
  const encryptedBuffer = Buffer.from(await response.arrayBuffer());
  logger.debug("Downloaded encrypted image", { size: encryptedBuffer.length });

  const wecomCrypto = new WecomCrypto(token, encodingAesKey);
  const decryptedBuffer = wecomCrypto.decryptMedia(encryptedBuffer);

  // Detect image type via magic bytes.
  let ext = "jpg";
  if (decryptedBuffer[0] === 0x89 && decryptedBuffer[1] === 0x50) {
    ext = "png";
  } else if (decryptedBuffer[0] === 0x47 && decryptedBuffer[1] === 0x49) {
    ext = "gif";
  }

  const filename = `wecom_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
  const localPath = join(MEDIA_CACHE_DIR, filename);
  writeFileSync(localPath, decryptedBuffer);

  const mimeType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
  logger.info("Image decrypted and saved", {
    path: localPath,
    size: decryptedBuffer.length,
    mimeType,
  });
  return { localPath, mimeType };
}

/**
 * Download a file from WeCom (not encrypted, unlike images).
 * @param {string} fileUrl - File download URL
 * @param {string} fileName - Original file name
 * @returns {Promise<string>} Local path to downloaded file
 */
async function downloadWecomFile(fileUrl, fileName) {
  if (!existsSync(MEDIA_CACHE_DIR)) {
    mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  }

  logger.info("Downloading file", { url: fileUrl.substring(0, 80), name: fileName });
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const safeName = (fileName || `file_${Date.now()}`).replace(/[/\\:*?"<>|]/g, "_");
  const localPath = join(MEDIA_CACHE_DIR, `${Date.now()}_${safeName}`);
  writeFileSync(localPath, buffer);

  logger.info("File downloaded and saved", { path: localPath, size: buffer.length });
  return localPath;
}

/**
 * Guess MIME type from file extension.
 */
function guessMimeType(fileName) {
  const ext = (fileName || "").split(".").pop()?.toLowerCase() || "";
  const mimeMap = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    zip: "application/zip",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
  };
  return mimeMap[ext] || "application/octet-stream";
}

// Runtime state (module-level singleton)
let _runtime = null;
let _openclawConfig = null;
const ensuredDynamicAgentIds = new Set();
let ensureDynamicAgentWriteQueue = Promise.resolve();

// Per-user dispatch serialization lock.
const dispatchLocks = new Map();

// Per-user message debounce buffer.
// Collects messages arriving within DEBOUNCE_MS into a single dispatch.
const DEBOUNCE_MS = 2000;
const messageBuffers = new Map();

/**
 * Handle stream error: replace placeholder with error message, finish stream, unregister.
 */
async function handleStreamError(streamId, streamKey, errorMessage) {
  if (!streamId) {
    return;
  }
  const stream = streamManager.getStream(streamId);
  if (stream && !stream.finished) {
    if (stream.content.trim() === THINKING_PLACEHOLDER.trim()) {
      streamManager.replaceIfPlaceholder(streamId, errorMessage, THINKING_PLACEHOLDER);
    }
    await streamManager.finishStream(streamId);
  }
  unregisterActiveStream(streamKey, streamId);
}

/**
 * Set the plugin runtime (called during plugin registration)
 */
function setRuntime(runtime) {
  _runtime = runtime;
}

function getRuntime() {
  if (!_runtime) {
    throw new Error("[wecom] Runtime not initialized");
  }
  return _runtime;
}

function upsertAgentIdOnlyEntry(cfg, agentId) {
  const normalizedId = String(agentId || "")
    .trim()
    .toLowerCase();
  if (!normalizedId) {
    return false;
  }

  if (!cfg.agents || typeof cfg.agents !== "object") {
    cfg.agents = {};
  }

  const currentList = Array.isArray(cfg.agents.list) ? cfg.agents.list : [];
  const existingIds = new Set(
    currentList
      .map((entry) => (entry && typeof entry.id === "string" ? entry.id.trim().toLowerCase() : ""))
      .filter(Boolean),
  );

  let changed = false;
  const nextList = [...currentList];

  // Keep "main" as the explicit default when creating agents.list for the first time.
  if (nextList.length === 0) {
    nextList.push({ id: "main" });
    existingIds.add("main");
    changed = true;
  }

  if (!existingIds.has(normalizedId)) {
    nextList.push({ id: normalizedId });
    changed = true;
  }

  if (changed) {
    cfg.agents.list = nextList;
  }

  return changed;
}

async function ensureDynamicAgentListed(agentId) {
  const normalizedId = String(agentId || "")
    .trim()
    .toLowerCase();
  if (!normalizedId) {
    return;
  }
  if (ensuredDynamicAgentIds.has(normalizedId)) {
    return;
  }

  const runtime = getRuntime();
  const configRuntime = runtime?.config;
  if (!configRuntime?.loadConfig || !configRuntime?.writeConfigFile) {
    return;
  }

  ensureDynamicAgentWriteQueue = ensureDynamicAgentWriteQueue
    .then(async () => {
      if (ensuredDynamicAgentIds.has(normalizedId)) {
        return;
      }

      const latestConfig = configRuntime.loadConfig();
      if (!latestConfig || typeof latestConfig !== "object") {
        return;
      }

      const changed = upsertAgentIdOnlyEntry(latestConfig, normalizedId);
      if (changed) {
        await configRuntime.writeConfigFile(latestConfig);
        logger.info("WeCom: dynamic agent added to agents.list", { agentId: normalizedId });
      }

      // Keep runtime in-memory config aligned to avoid stale reads in this process.
      if (_openclawConfig && typeof _openclawConfig === "object") {
        upsertAgentIdOnlyEntry(_openclawConfig, normalizedId);
      }

      ensuredDynamicAgentIds.add(normalizedId);
    })
    .catch((err) => {
      logger.warn("WeCom: failed to sync dynamic agent into agents.list", {
        agentId: normalizedId,
        error: err?.message || String(err),
      });
    });

  await ensureDynamicAgentWriteQueue;
}

// Webhook targets registry (similar to Google Chat)
const webhookTargets = new Map();

// Track active stream for each user, so outbound messages (like reset confirmation)
// can be added to the correct stream instead of using response_url
const activeStreams = new Map();
const activeStreamHistory = new Map();

// AsyncLocalStorage for propagating the correct streamId through the async
// processing chain. Prevents outbound adapter from resolving the wrong stream
// when multiple messages from the same user are in flight.
const streamContext = new AsyncLocalStorage();

function getMessageStreamKey(message) {
  if (!message || typeof message !== "object") {
    return "";
  }
  const chatType = message.chatType || "single";
  const chatId = message.chatId || "";
  if (chatType === "group" && chatId) {
    return chatId;
  }
  return message.fromUser || "";
}

function registerActiveStream(streamKey, streamId) {
  if (!streamKey || !streamId) {
    return;
  }

  const history = activeStreamHistory.get(streamKey) ?? [];
  const deduped = history.filter((id) => id !== streamId);
  deduped.push(streamId);
  activeStreamHistory.set(streamKey, deduped);
  activeStreams.set(streamKey, streamId);
}

function unregisterActiveStream(streamKey, streamId) {
  if (!streamKey || !streamId) {
    return;
  }

  const history = activeStreamHistory.get(streamKey);
  if (!history || history.length === 0) {
    if (activeStreams.get(streamKey) === streamId) {
      activeStreams.delete(streamKey);
    }
    return;
  }

  const remaining = history.filter((id) => id !== streamId);
  if (remaining.length === 0) {
    activeStreamHistory.delete(streamKey);
    activeStreams.delete(streamKey);
    return;
  }

  activeStreamHistory.set(streamKey, remaining);
  activeStreams.set(streamKey, remaining[remaining.length - 1]);
}

function resolveActiveStream(streamKey) {
  if (!streamKey) {
    return null;
  }

  const history = activeStreamHistory.get(streamKey);
  if (!history || history.length === 0) {
    activeStreams.delete(streamKey);
    return null;
  }

  const remaining = history.filter((id) => streamManager.hasStream(id));
  if (remaining.length === 0) {
    activeStreamHistory.delete(streamKey);
    activeStreams.delete(streamKey);
    return null;
  }

  activeStreamHistory.set(streamKey, remaining);
  const latest = remaining[remaining.length - 1];
  activeStreams.set(streamKey, latest);
  return latest;
}

function normalizeWecomAllowFromEntry(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed
    .replace(/^(wecom|wework):/i, "")
    .replace(/^user:/i, "")
    .toLowerCase();
}

function resolveWecomAllowFrom(cfg, accountId) {
  const wecom = cfg?.channels?.wecom;
  if (!wecom) {
    return [];
  }

  const normalizedAccountId = String(accountId || DEFAULT_ACCOUNT_ID)
    .trim()
    .toLowerCase();
  const accounts = wecom.accounts;
  const account =
    accounts && typeof accounts === "object"
      ? (accounts[accountId] ??
        accounts[
          Object.keys(accounts).find((key) => key.toLowerCase() === normalizedAccountId) ?? ""
        ])
      : undefined;

  const allowFromRaw =
    account?.dm?.allowFrom ?? account?.allowFrom ?? wecom.dm?.allowFrom ?? wecom.allowFrom ?? [];

  if (!Array.isArray(allowFromRaw)) {
    return [];
  }

  return allowFromRaw.map(normalizeWecomAllowFromEntry).filter((entry) => Boolean(entry));
}

function resolveWecomCommandAuthorized({ cfg, accountId, senderId }) {
  const sender = String(senderId ?? "")
    .trim()
    .toLowerCase();
  if (!sender) {
    return false;
  }

  const allowFrom = resolveWecomAllowFrom(cfg, accountId);
  if (allowFrom.includes("*") || allowFrom.length === 0) {
    return true;
  }
  return allowFrom.includes(sender);
}

function normalizeWebhookPath(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function registerWebhookTarget(target) {
  const key = normalizeWebhookPath(target.path);
  const entry = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  webhookTargets.set(key, [...existing, entry]);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((e) => e !== entry);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

// =============================================================================
// Channel Plugin Definition
// =============================================================================

const wecomChannelPlugin = {
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
          description: "Admin users who bypass command allowlist and dynamic agent routing",
          items: { type: "string" },
          default: [],
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
    },
  },
  config: {
    listAccountIds: (cfg) => {
      const wecom = cfg?.channels?.wecom;
      if (!wecom || !wecom.enabled) {
        return [];
      }
      return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
      const wecom = cfg?.channels?.wecom;
      if (!wecom) {
        return null;
      }
      return {
        id: accountId || DEFAULT_ACCOUNT_ID,
        accountId: accountId || DEFAULT_ACCOUNT_ID,
        enabled: wecom.enabled !== false,
        token: wecom.token || "",
        encodingAesKey: wecom.encodingAesKey || "",
        webhookPath: wecom.webhookPath || "/webhooks/wecom",
        config: wecom,
      };
    },
    defaultAccountId: (cfg) => {
      const wecom = cfg?.channels?.wecom;
      if (!wecom || !wecom.enabled) {
        return null;
      }
      return DEFAULT_ACCOUNT_ID;
    },
    setAccountEnabled: ({ cfg, accountId: _accountId, enabled }) => {
      if (!cfg.channels) {
        cfg.channels = {};
      }
      if (!cfg.channels.wecom) {
        cfg.channels.wecom = {};
      }
      cfg.channels.wecom.enabled = enabled;
      return cfg;
    },
    deleteAccount: ({ cfg, accountId: _accountId }) => {
      if (cfg.channels?.wecom) {
        delete cfg.channels.wecom;
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
    sendText: async ({ cfg: _cfg, to, text, accountId: _accountId }) => {
      // `to` format: "wecom:userid" or "userid".
      const userId = to.replace(/^wecom:/, "");

      // Prefer stream from async context (correct for concurrent processing).
      const ctx = streamContext.getStore();
      const streamId = ctx?.streamId ?? resolveActiveStream(userId);

      if (streamId && streamManager.hasStream(streamId)) {
        logger.debug("Appending outbound text to stream", {
          userId,
          streamId,
          source: ctx ? "asyncContext" : "activeStreams",
          text: text.substring(0, 30),
        });
        // Replace placeholder or append content.
        streamManager.replaceIfPlaceholder(streamId, text, THINKING_PLACEHOLDER);

        return {
          channel: "wecom",
          messageId: `msg_stream_${Date.now()}`,
        };
      }

      // No active stream means nothing can be delivered right now.
      logger.warn("WeCom outbound: no active stream for user", { userId });

      return {
        channel: "wecom",
        messageId: `fake_${Date.now()}`,
      };
    },
    sendMedia: async ({ cfg: _cfg, to, text, mediaUrl, accountId: _accountId }) => {
      const userId = to.replace(/^wecom:/, "");

      // Prefer stream from async context (correct for concurrent processing).
      const ctx = streamContext.getStore();
      const streamId = ctx?.streamId ?? resolveActiveStream(userId);

      if (streamId && streamManager.hasStream(streamId)) {
        // Check if mediaUrl is a local path (sandbox: prefix or absolute path)
        const isLocalPath = mediaUrl.startsWith("sandbox:") || mediaUrl.startsWith("/");

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
              streamManager.replaceIfPlaceholder(streamId, text, THINKING_PLACEHOLDER);
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
        const content = text ? `${text}\n\n![image](${mediaUrl})` : `![image](${mediaUrl})`;
        logger.debug("Appending outbound media to stream (markdown)", {
          userId,
          streamId,
          mediaUrl,
        });

        // Replace placeholder or append media markdown to the current stream content.
        streamManager.replaceIfPlaceholder(streamId, content, THINKING_PLACEHOLDER);

        return {
          channel: "wecom",
          messageId: `msg_stream_${Date.now()}`,
        };
      }

      logger.warn("WeCom outbound sendMedia: no active stream", { userId });

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

      const unregister = registerWebhookTarget({
        path: account.webhookPath || "/webhooks/wecom",
        account,
        config: ctx.cfg,
      });

      return {
        shutdown: async () => {
          logger.info("WeCom gateway shutting down");
          // Clear pending debounce timers to prevent post-shutdown dispatches.
          for (const [, buf] of messageBuffers) {
            clearTimeout(buf.timer);
          }
          messageBuffers.clear();
          unregister();
        },
      };
    },
  },
};

// =============================================================================
// HTTP Webhook Handler
// =============================================================================

async function wecomHttpHandler(req, res) {
  const url = new URL(req.url || "", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);

  if (!targets || targets.length === 0) {
    return false; // Not handled by this plugin
  }

  const query = Object.fromEntries(url.searchParams);
  logger.debug("WeCom HTTP request", { method: req.method, path });

  // GET: URL Verification
  if (req.method === "GET") {
    const target = targets[0]; // Use first target for verification
    if (!target) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("No webhook target configured");
      return true;
    }

    const webhook = new WecomWebhook({
      token: target.account.token,
      encodingAesKey: target.account.encodingAesKey,
    });

    const echo = webhook.handleVerify(query);
    if (echo) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(echo);
      logger.info("WeCom URL verification successful");
      return true;
    }

    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Verification failed");
    logger.warn("WeCom URL verification failed");
    return true;
  }

  // POST: Message handling
  if (req.method === "POST") {
    const target = targets[0];
    if (!target) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("No webhook target configured");
      return true;
    }

    // Read request body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf-8");
    logger.debug("WeCom message received", { bodyLength: body.length });

    const webhook = new WecomWebhook({
      token: target.account.token,
      encodingAesKey: target.account.encodingAesKey,
    });

    const result = await webhook.handleMessage(query, body);
    if (result === WecomWebhook.DUPLICATE) {
      // Duplicate message — ACK 200 to prevent platform retry storm.
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("success");
      return true;
    }
    if (!result) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return true;
    }

    // Handle text message
    if (result.message) {
      const msg = result.message;
      const { timestamp, nonce } = result.query;
      const content = (msg.content || "").trim();

      // Use stream responses for every inbound message, including commands.
      // WeCom AI Bot response_url is single-use, so streaming is mandatory.
      const streamId = `stream_${crypto.randomUUID()}`;
      streamManager.createStream(streamId);
      streamManager.appendStream(streamId, THINKING_PLACEHOLDER);

      // Passive reply: return stream id immediately in the sync response.
      // Include the placeholder so the client displays it right away.
      const streamResponse = webhook.buildStreamResponse(
        streamId,
        THINKING_PLACEHOLDER,
        false,
        timestamp,
        nonce,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(streamResponse);

      logger.info("Stream initiated", {
        streamId,
        from: msg.fromUser,
        isCommand: content.startsWith("/"),
      });

      const streamKey = getMessageStreamKey(msg);
      const isCommand = content.startsWith("/");

      // Commands bypass debounce — process immediately.
      if (isCommand) {
        processInboundMessage({
          message: msg,
          streamId,
          timestamp,
          nonce,
          account: target.account,
          config: target.config,
        }).catch(async (err) => {
          logger.error("WeCom message processing failed", { error: err.message });
          await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
        });
        return true;
      }

      // Debounce: buffer non-command messages per user/group.
      // If multiple messages arrive within DEBOUNCE_MS, merge into one dispatch.
      const existing = messageBuffers.get(streamKey);
      if (existing) {
        // A previous message is still buffered — merge this one in.
        existing.messages.push(msg);
        existing.streamIds.push(streamId);
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => flushMessageBuffer(streamKey, target), DEBOUNCE_MS);
        logger.info("WeCom: message buffered for merge", {
          streamKey,
          streamId,
          buffered: existing.messages.length,
        });
      } else {
        // First message — start a new buffer with a debounce timer.
        const buffer = {
          messages: [msg],
          streamIds: [streamId],
          target,
          timestamp,
          nonce,
          timer: setTimeout(() => flushMessageBuffer(streamKey, target), DEBOUNCE_MS),
        };
        messageBuffers.set(streamKey, buffer);
        logger.info("WeCom: message buffered (first)", { streamKey, streamId });
      }

      return true;
    }

    // Handle stream refresh - return current stream state
    if (result.stream) {
      const { timestamp, nonce } = result.query;
      const streamId = result.stream.id;

      // Return latest stream state.
      const stream = streamManager.getStream(streamId);

      if (!stream) {
        // Stream already expired or missing.
        logger.warn("Stream not found for refresh", { streamId });
        const streamResponse = webhook.buildStreamResponse(
          streamId,
          "会话已过期",
          true,
          timestamp,
          nonce,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(streamResponse);
        return true;
      }

      // Return current stream payload.
      const streamResponse = webhook.buildStreamResponse(
        streamId,
        stream.content,
        stream.finished,
        timestamp,
        nonce,
        // Pass msgItem when stream is finished and has images
        stream.finished && stream.msgItem.length > 0 ? { msgItem: stream.msgItem } : {},
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(streamResponse);

      logger.debug("Stream refresh response sent", {
        streamId,
        contentLength: stream.content.length,
        finished: stream.finished,
      });

      // Clean up completed streams after a short delay.
      if (stream.finished) {
        setTimeout(() => {
          streamManager.deleteStream(streamId);
        }, 30 * 1000);
      }

      return true;
    }

    // Handle event
    if (result.event) {
      logger.info("WeCom event received", { event: result.event });

      // Handle enter_chat with an immediate welcome stream.
      if (result.event?.event_type === "enter_chat") {
        const { timestamp, nonce } = result.query;
        const fromUser = result.event?.from?.userid || "";

        // Welcome message body.
        const welcomeMessage = `你好！👋 我是 AI 助手。

你可以使用下面的指令管理会话：
• **/new** - 新建会话（清空上下文）
• **/compact** - 压缩会话（保留上下文摘要）
• **/help** - 查看更多命令

有什么我可以帮你的吗？`;

        // Build and finish stream in a single pass.
        const streamId = `welcome_${crypto.randomUUID()}`;
        streamManager.createStream(streamId);
        streamManager.appendStream(streamId, welcomeMessage);
        await streamManager.finishStream(streamId);

        const streamResponse = webhook.buildStreamResponse(
          streamId,
          welcomeMessage,
          true,
          timestamp,
          nonce,
        );

        logger.info("Sending welcome message", { fromUser, streamId });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(streamResponse);
        return true;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("success");
      return true;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("success");
    return true;
  }

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method Not Allowed");
  return true;
}

// =============================================================================
// Inbound Message Processing (triggers AI response)
// =============================================================================

/**
 * Flush the debounce buffer for a given streamKey.
 * Merges buffered messages into a single dispatch call.
 * The first message's stream receives the LLM response.
 * Subsequent streams get "消息已合并到第一条回复" and finish immediately.
 */
function flushMessageBuffer(streamKey, target) {
  const buffer = messageBuffers.get(streamKey);
  if (!buffer) {
    return;
  }
  messageBuffers.delete(streamKey);

  const { messages, streamIds } = buffer;
  const primaryStreamId = streamIds[0];
  const primaryMsg = messages[0];

  // Merge content from all buffered messages.
  if (messages.length > 1) {
    const mergedContent = messages
      .map((m) => m.content || "")
      .filter(Boolean)
      .join("\n");
    primaryMsg.content = mergedContent;

    // Merge image attachments.
    const allImageUrls = messages.flatMap((m) => m.imageUrls || []);
    if (allImageUrls.length > 0) {
      primaryMsg.imageUrls = allImageUrls;
    }
    const singleImages = messages.map((m) => m.imageUrl).filter(Boolean);
    if (singleImages.length > 0 && !primaryMsg.imageUrl) {
      primaryMsg.imageUrl = singleImages[0];
      if (singleImages.length > 1) {
        primaryMsg.imageUrls = [...(primaryMsg.imageUrls || []), ...singleImages.slice(1)];
      }
    }

    // Finish extra streams with merge notice.
    for (let i = 1; i < streamIds.length; i++) {
      const extraStreamId = streamIds[i];
      streamManager.replaceIfPlaceholder(
        extraStreamId,
        "消息已合并到第一条回复中。",
        THINKING_PLACEHOLDER,
      );
      void streamManager.finishStream(extraStreamId).then(() => {
        unregisterActiveStream(streamKey, extraStreamId);
      });
    }

    logger.info("WeCom: flushing merged messages", {
      streamKey,
      count: messages.length,
      primaryStreamId,
      mergedContentPreview: mergedContent.substring(0, 60),
    });
  } else {
    logger.info("WeCom: flushing single message", { streamKey, primaryStreamId });
  }

  // Dispatch the merged message.
  processInboundMessage({
    message: primaryMsg,
    streamId: primaryStreamId,
    timestamp: buffer.timestamp,
    nonce: buffer.nonce,
    account: target.account,
    config: target.config,
  }).catch(async (err) => {
    logger.error("WeCom message processing failed", { error: err.message });
    await handleStreamError(primaryStreamId, streamKey, "处理消息时出错，请稍后再试。");
  });
}

async function processInboundMessage({
  message,
  streamId,
  timestamp: _timestamp,
  nonce: _nonce,
  account,
  config,
}) {
  const runtime = getRuntime();
  const core = runtime.channel;

  const senderId = message.fromUser;
  const imageUrl = message.imageUrl || "";
  const imageUrls = message.imageUrls || [];
  const fileUrl = message.fileUrl || "";
  const fileName = message.fileName || "";
  const rawContent = message.content || "";
  const chatType = message.chatType || "single";
  const chatId = message.chatId || "";
  const isGroupChat = chatType === "group" && chatId;

  // Use chat id for group sessions and sender id for direct messages.
  const peerId = isGroupChat ? chatId : senderId;
  const peerKind = isGroupChat ? "group" : "dm";
  const conversationId = isGroupChat ? `wecom:group:${chatId}` : `wecom:${senderId}`;

  // Track active stream by chat context for outbound adapter callbacks.
  const streamKey = isGroupChat ? chatId : senderId;
  if (streamId) {
    registerActiveStream(streamKey, streamId);
  }

  // Apply group mention gating rules.
  let rawBody = rawContent;
  if (isGroupChat) {
    if (!shouldTriggerGroupResponse(rawContent, config)) {
      logger.debug("WeCom: group message ignored (no mention)", { chatId, senderId });
      if (streamId) {
        streamManager.replaceIfPlaceholder(streamId, "请@提及我以获取回复。", THINKING_PLACEHOLDER);
        await streamManager.finishStream(streamId);
        unregisterActiveStream(streamKey, streamId);
      }
      return;
    }
    // Strip mention markers from the effective prompt.
    rawBody = extractGroupMessageContent(rawContent, config);
  }

  const commandAuthorized = resolveWecomCommandAuthorized({
    cfg: config,
    accountId: account.accountId,
    senderId,
  });

  // Skip empty messages, but allow image/mixed/file messages.
  if (!rawBody.trim() && !imageUrl && imageUrls.length === 0 && !fileUrl) {
    logger.debug("WeCom: empty message, skipping");
    if (streamId) {
      await streamManager.finishStream(streamId);
      unregisterActiveStream(streamKey, streamId);
    }
    return;
  }

  // ========================================================================
  // Command allowlist enforcement
  // Admins bypass the allowlist entirely.
  // ========================================================================
  const senderIsAdmin = isWecomAdmin(senderId, config);
  const commandCheck = checkCommandAllowlist(rawBody, config);

  if (commandCheck.isCommand && !commandCheck.allowed && !senderIsAdmin) {
    // Return block message when command is outside the allowlist.
    const cmdConfig = getCommandConfig(config);
    logger.warn("WeCom: blocked command", {
      command: commandCheck.command,
      from: senderId,
      chatType: peerKind,
    });

    // Send blocked-command response through the same stream.
    if (streamId) {
      streamManager.replaceIfPlaceholder(streamId, cmdConfig.blockMessage, THINKING_PLACEHOLDER);
      await streamManager.finishStream(streamId);
      unregisterActiveStream(streamKey, streamId);
    }
    return;
  }

  if (commandCheck.isCommand && !commandCheck.allowed && senderIsAdmin) {
    logger.info("WeCom: admin bypassed command allowlist", {
      command: commandCheck.command,
      from: senderId,
    });
  }

  logger.info("WeCom processing message", {
    from: senderId,
    chatType: peerKind,
    peerId,
    content: rawBody.substring(0, 50),
    streamId,
    isCommand: commandCheck.isCommand,
    command: commandCheck.command,
  });

  // ========================================================================
  // Dynamic agent routing
  // Admins route to the main agent directly.
  // ========================================================================
  const dynamicConfig = getDynamicAgentConfig(config);

  // Compute deterministic agent target for this conversation.
  const targetAgentId =
    !senderIsAdmin && dynamicConfig.enabled && shouldUseDynamicAgent({ chatType: peerKind, config })
      ? generateAgentId(peerKind, peerId)
      : null;

  if (targetAgentId) {
    await ensureDynamicAgentListed(targetAgentId);
    logger.debug("Using dynamic agent", { agentId: targetAgentId, chatType: peerKind, peerId });
  } else if (senderIsAdmin) {
    logger.debug("Admin user, routing to main agent", { senderId });
  }

  // ========================================================================
  // Resolve route and override with dynamic agent when enabled
  // ========================================================================
  const route = core.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: {
      kind: peerKind,
      id: peerId,
    },
  });

  // Override default route with deterministic dynamic agent session key.
  if (targetAgentId) {
    route.agentId = targetAgentId;
    route.sessionKey = `agent:${targetAgentId}:${peerKind}:${peerId}`;
  }

  // Build inbound context
  const storePath = core.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Prefix sender id in group contexts so attribution stays explicit.
  const senderLabel = isGroupChat ? `[${senderId}]` : senderId;
  const body = core.reply.formatAgentEnvelope({
    channel: isGroupChat ? "Enterprise WeChat Group" : "Enterprise WeChat",
    from: senderLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  // Build context payload with optional image attachment.
  const ctxBase = {
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `wecom:${senderId}`,
    To: conversationId,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroupChat ? "group" : "direct",
    ConversationLabel: isGroupChat ? `Group ${chatId}` : senderId,
    SenderName: senderId,
    SenderId: senderId,
    GroupId: isGroupChat ? chatId : undefined,
    Provider: "wecom",
    Surface: "wecom",
    OriginatingChannel: "wecom",
    OriginatingTo: conversationId,
    CommandAuthorized: commandAuthorized,
  };

  // Download, decrypt, and attach media when present.
  const allImageUrls = imageUrl ? [imageUrl] : imageUrls;

  if (allImageUrls.length > 0) {
    const mediaPaths = [];
    const mediaTypes = [];
    const fallbackUrls = [];

    for (const url of allImageUrls) {
      try {
        const result = await downloadAndDecryptImage(url, account.encodingAesKey, account.token);
        mediaPaths.push(result.localPath);
        mediaTypes.push(result.mimeType);
      } catch (e) {
        logger.warn("Image decryption failed, using URL fallback", {
          error: e.message,
          url: url.substring(0, 80),
        });
        fallbackUrls.push(url);
        mediaTypes.push("image/jpeg");
      }
    }

    if (mediaPaths.length > 0) {
      ctxBase.MediaPaths = mediaPaths;
    }
    if (fallbackUrls.length > 0) {
      ctxBase.MediaUrls = fallbackUrls;
    }
    ctxBase.MediaTypes = mediaTypes;

    logger.info("Image attachments prepared", {
      decrypted: mediaPaths.length,
      fallback: fallbackUrls.length,
    });

    // For image-only messages (no text), set a placeholder body.
    if (!rawBody.trim()) {
      const count = allImageUrls.length;
      ctxBase.Body = count > 1 ? `[用户发送了${count}张图片]` : "[用户发送了一张图片]";
      ctxBase.RawBody = "[图片]";
      ctxBase.CommandBody = "";
    }
  }

  // Handle file attachment.
  if (fileUrl) {
    try {
      const localFilePath = await downloadWecomFile(fileUrl, fileName);
      ctxBase.MediaPaths = [...(ctxBase.MediaPaths || []), localFilePath];
      ctxBase.MediaTypes = [...(ctxBase.MediaTypes || []), guessMimeType(fileName)];
      logger.info("File attachment prepared", { path: localFilePath, name: fileName });
    } catch (e) {
      logger.warn("File download failed", { error: e.message });
      // Inform the agent about the file via text.
      const label = fileName ? `[文件: ${fileName}]` : "[文件]";
      if (!rawBody.trim()) {
        ctxBase.Body = `[用户发送了文件] ${label}`;
        ctxBase.RawBody = label;
        ctxBase.CommandBody = "";
      }
    }
    if (!rawBody.trim() && !ctxBase.Body) {
      const label = fileName ? `[文件: ${fileName}]` : "[文件]";
      ctxBase.Body = `[用户发送了文件] ${label}`;
      ctxBase.RawBody = label;
      ctxBase.CommandBody = "";
    }
  }

  const ctxPayload = core.reply.finalizeInboundContext(ctxBase);

  // Record session meta
  void core.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      logger.error("WeCom: failed updating session meta", { error: err.message });
    });

  // Serialize dispatches per user/group. Each message gets its own full dispatch
  // cycle with proper deliver callbacks.
  const prevLock = dispatchLocks.get(streamKey) ?? Promise.resolve();
  const currentDispatch = prevLock
    .then(async () => {
      // Dispatch reply with AI processing.
      // Wrap in streamContext so outbound adapters resolve the correct stream.
      await streamContext.run({ streamId, streamKey }, async () => {
        await core.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: config,
          dispatcherOptions: {
            deliver: async (payload, info) => {
              logger.info("Dispatcher deliver called", {
                kind: info.kind,
                hasText: !!(payload.text && payload.text.trim()),
                textPreview: (payload.text || "").substring(0, 50),
              });

              await deliverWecomReply({
                payload,
                senderId: streamKey,
                streamId,
              });

              // Mark stream complete on final payload.
              if (streamId && info.kind === "final") {
                await streamManager.finishStream(streamId);
                logger.info("WeCom stream finished", { streamId });
              }
            },
            onError: async (err, info) => {
              logger.error("WeCom reply failed", { error: err.message, kind: info.kind });
              await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
            },
          },
        });
      });

      // Safety net: ensure stream finishes after dispatch.
      if (streamId) {
        const stream = streamManager.getStream(streamId);
        if (!stream || stream.finished) {
          unregisterActiveStream(streamKey, streamId);
        } else {
          await streamManager.finishStream(streamId);
          unregisterActiveStream(streamKey, streamId);
          logger.info("WeCom stream finished (safety net)", { streamId });
        }
      }
    })
    .catch(async (err) => {
      logger.error("WeCom dispatch chain error", { streamId, streamKey, error: err.message });
      await handleStreamError(streamId, streamKey, "处理消息时出错，请稍后再试。");
    });

  dispatchLocks.set(streamKey, currentDispatch);
  await currentDispatch;
  if (dispatchLocks.get(streamKey) === currentDispatch) {
    dispatchLocks.delete(streamKey);
  }
}

// =============================================================================
// Outbound Reply Delivery (Stream-only mode)
// =============================================================================

async function deliverWecomReply({ payload, senderId, streamId }) {
  const text = payload.text || "";

  logger.debug("deliverWecomReply called", {
    hasText: !!text.trim(),
    textPreview: text.substring(0, 50),
    streamId,
    senderId,
  });

  // Handle absolute-path MEDIA lines manually; OpenClaw rejects these paths upstream.
  const mediaRegex = /^MEDIA:\s*(.+)$/gm;
  const mediaMatches = [];
  let match;
  while ((match = mediaRegex.exec(text)) !== null) {
    const mediaPath = match[1].trim();
    // Only intercept absolute filesystem paths.
    if (mediaPath.startsWith("/")) {
      mediaMatches.push({
        fullMatch: match[0],
        path: mediaPath,
      });
      logger.debug("Detected absolute path MEDIA line", {
        streamId,
        mediaPath,
        line: match[0],
      });
    }
  }

  // Queue absolute-path images and remove corresponding MEDIA lines from text.
  let processedText = text;
  if (mediaMatches.length > 0 && streamId) {
    for (const media of mediaMatches) {
      const queued = streamManager.queueImage(streamId, media.path);
      if (queued) {
        // Remove this MEDIA line once image was queued.
        processedText = processedText.replace(media.fullMatch, "").trim();
        logger.info("Queued absolute path image for stream", {
          streamId,
          imagePath: media.path,
        });
      }
    }
  }

  // All outbound content is sent via stream updates.
  if (!processedText.trim()) {
    logger.debug("WeCom: empty block after processing, skipping stream update");
    return;
  }

  // Helper: append content with duplicate suppression and placeholder awareness.
  const appendToStream = (targetStreamId, content) => {
    const stream = streamManager.getStream(targetStreamId);
    if (!stream) {
      return false;
    }

    // If stream still has the placeholder, replace it entirely.
    if (stream.content.trim() === THINKING_PLACEHOLDER.trim()) {
      streamManager.replaceIfPlaceholder(targetStreamId, content, THINKING_PLACEHOLDER);
      return true;
    }

    // Skip duplicate chunks (for example, block + final overlap).
    if (stream.content.includes(content.trim())) {
      logger.debug("WeCom: duplicate content, skipping", {
        streamId: targetStreamId,
        contentPreview: content.substring(0, 30),
      });
      return true;
    }

    const separator = stream.content.length > 0 ? "\n\n" : "";
    streamManager.appendStream(targetStreamId, separator + content);
    return true;
  };

  if (!streamId) {
    // Try async context first, then fallback to active stream map.
    const ctx = streamContext.getStore();
    const contextStreamId = ctx?.streamId;
    const activeStreamId = contextStreamId ?? resolveActiveStream(senderId);

    if (activeStreamId && streamManager.hasStream(activeStreamId)) {
      appendToStream(activeStreamId, processedText);
      logger.debug("WeCom stream appended (via context/activeStreams)", {
        streamId: activeStreamId,
        source: contextStreamId ? "asyncContext" : "activeStreams",
        contentLength: processedText.length,
      });
      return;
    }
    logger.warn("WeCom: no active stream for this message", { senderId });
    return;
  }

  if (!streamManager.hasStream(streamId)) {
    logger.warn("WeCom: stream not found, cannot update", { streamId });
    return;
  }

  appendToStream(streamId, processedText);
  logger.debug("WeCom stream appended", {
    streamId,
    contentLength: processedText.length,
    to: senderId,
  });
}

// =============================================================================
// Plugin Registration
// =============================================================================

const plugin = {
  // Plugin id should match `openclaw.plugin.json` id (and config.plugins.entries key).
  id: "wecom",
  name: "Enterprise WeChat",
  description: "Enterprise WeChat AI Bot channel plugin for OpenClaw",
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  register(api) {
    logger.info("WeCom plugin registering...");

    // Save runtime for message processing
    setRuntime(api.runtime);
    _openclawConfig = api.config;

    // Register channel
    api.registerChannel({ plugin: wecomChannelPlugin });
    logger.info("WeCom channel registered");

    // Register HTTP handler for webhooks
    api.registerHttpHandler(wecomHttpHandler);
    logger.info("WeCom HTTP handler registered");
  },
};

export default plugin;
export const register = (api) => plugin.register(api);
