import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  buildAgentMediaPayload,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  recordPendingHistoryEntryIfEnabled,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { tryRecordMessagePersistent } from "./dedup.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { downloadMessageResourceFeishu } from "./media.js";
import {
  escapeRegExp,
  extractMentionTargets,
  extractMessageBody,
  isMentionForwardRequest,
} from "./mention.js";
import {
  resolveFeishuGroupConfig,
  resolveFeishuReplyPolicy,
  resolveFeishuAllowlistMatch,
  isFeishuGroupAllowed,
} from "./policy.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, sendMessageFeishu } from "./send.js";
import type { FeishuMessageContext, FeishuMediaInfo, ResolvedFeishuAccount } from "./types.js";
import type { DynamicAgentCreationConfig } from "./types.js";

// --- Permission error extraction ---
// Extract permission grant URL from Feishu API error response.
type PermissionError = {
  code: number;
  message: string;
  grantUrl?: string;
};

function extractPermissionError(err: unknown): PermissionError | null {
  if (!err || typeof err !== "object") return null;

  // Axios error structure: err.response.data contains the Feishu error
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") return null;

  const feishuErr = data as {
    code?: number;
    msg?: string;
    error?: { permission_violations?: Array<{ uri?: string }> };
  };

  // Feishu permission error code: 99991672
  if (feishuErr.code !== 99991672) return null;

  // Extract the grant URL from the error message (contains the direct link)
  const msg = feishuErr.msg ?? "";
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  const grantUrl = urlMatch?.[0];

  return {
    code: feishuErr.code,
    message: msg,
    grantUrl,
  };
}

// --- Sender name resolution (so the agent can distinguish who is speaking in group chats) ---
// Cache display names by open_id to avoid an API call on every message.
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

// Cache permission errors to avoid spamming the user with repeated notifications.
// Key: appId or "default", Value: timestamp of last notification
const permissionErrorNotifiedAt = new Map<string, number>();
const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

type SenderNameResult = {
  name?: string;
  permissionError?: PermissionError;
};

async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderOpenId: string;
  log: (...args: any[]) => void;
}): Promise<SenderNameResult> {
  const { account, senderOpenId, log } = params;
  if (!account.configured) return {};
  if (!senderOpenId) return {};

  const cached = senderNameCache.get(senderOpenId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return { name: cached.name };

  try {
    const client = createFeishuClient(account);

    // contact/v3/users/:user_id?user_id_type=open_id
    const res: any = await client.contact.user.get({
      path: { user_id: senderOpenId },
      params: { user_id_type: "open_id" },
    });

    const name: string | undefined =
      res?.data?.user?.name ||
      res?.data?.user?.display_name ||
      res?.data?.user?.nickname ||
      res?.data?.user?.en_name;

    if (name && typeof name === "string") {
      senderNameCache.set(senderOpenId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return { name };
    }

    return {};
  } catch (err) {
    // Check if this is a permission error
    const permErr = extractPermissionError(err);
    if (permErr) {
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }

    // Best-effort. Don't fail message handling if name lookup fails.
    log(`feishu: failed to resolve sender name for ${senderOpenId}: ${String(err)}`);
    return {};
  }
}

export type FeishuMessageEvent = {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: "p2p" | "group";
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
};

export type FeishuBotAddedEvent = {
  chat_id: string;
  operator_id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  external: boolean;
  operator_tenant_key?: string;
};

function parseMessageContent(content: string, messageType: string): string {
  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") {
      return parsed.text || "";
    }
    if (messageType === "post") {
      // Extract text content from rich text post
      const { textContent } = parsePostContent(content);
      return textContent;
    }
    return content;
  } catch {
    return content;
  }
}

function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
  if (!botOpenId) return false;
  const mentions = event.message.mentions ?? [];
  if (mentions.length > 0) {
    return mentions.some((m) => m.id.open_id === botOpenId);
  }
  // Post (rich text) messages may have empty message.mentions when they contain docs/paste
  if (event.message.message_type === "post") {
    const { mentionedOpenIds } = parsePostContent(event.message.content);
    return mentionedOpenIds.some((id) => id === botOpenId);
  }
  return false;
}

export function stripBotMention(
  text: string,
  mentions?: FeishuMessageEvent["message"]["mentions"],
): string {
  if (!mentions || mentions.length === 0) return text;
  let result = text;
  for (const mention of mentions) {
    result = result.replace(new RegExp(`@${escapeRegExp(mention.name)}\\s*`, "g"), "");
    result = result.replace(new RegExp(escapeRegExp(mention.key), "g"), "");
  }
  return result.trim();
}

/**
 * Parse media keys from message content based on message type.
 */
function parseMediaKeys(
  content: string,
  messageType: string,
): {
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
} {
  try {
    const parsed = JSON.parse(content);
    const imageKey = normalizeFeishuExternalKey(parsed.image_key);
    const fileKey = normalizeFeishuExternalKey(parsed.file_key);
    switch (messageType) {
      case "image":
        return { imageKey };
      case "file":
        return { fileKey, fileName: parsed.file_name };
      case "audio":
        return { fileKey };
      case "video":
        // Video has both file_key (video) and image_key (thumbnail)
        return { fileKey, imageKey };
      case "sticker":
        return { fileKey };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

/**
 * Parse post (rich text) content and extract embedded image keys.
 * Post structure: { title?: string, content: [[{ tag, text?, image_key?, ... }]] }
 */
function parsePostContent(content: string): {
  textContent: string;
  imageKeys: string[];
  mentionedOpenIds: string[];
} {
  try {
    const parsed = JSON.parse(content);
    const title = parsed.title || "";
    const contentBlocks = parsed.content || [];
    let textContent = title ? `${title}\n\n` : "";
    const imageKeys: string[] = [];
    const mentionedOpenIds: string[] = [];

    for (const paragraph of contentBlocks) {
      if (Array.isArray(paragraph)) {
        for (const element of paragraph) {
          if (element.tag === "text") {
            textContent += element.text || "";
          } else if (element.tag === "a") {
            // Link: show text or href
            textContent += element.text || element.href || "";
          } else if (element.tag === "at") {
            // Mention: @username
            textContent += `@${element.user_name || element.user_id || ""}`;
            if (element.user_id) {
              mentionedOpenIds.push(element.user_id);
            }
          } else if (element.tag === "img" && element.image_key) {
            // Embedded image
            const imageKey = normalizeFeishuExternalKey(element.image_key);
            if (imageKey) {
              imageKeys.push(imageKey);
            }
          }
        }
        textContent += "\n";
      }
    }

    return {
      textContent: textContent.trim() || "[Rich text message]",
      imageKeys,
      mentionedOpenIds,
    };
  } catch {
    return { textContent: "[Rich text message]", imageKeys: [], mentionedOpenIds: [] };
  }
}

/**
 * Infer placeholder text based on message type.
 */
function inferPlaceholder(messageType: string): string {
  switch (messageType) {
    case "image":
      return "<media:image>";
    case "file":
      return "<media:document>";
    case "audio":
      return "<media:audio>";
    case "video":
      return "<media:video>";
    case "sticker":
      return "<media:sticker>";
    default:
      return "<media:document>";
  }
}

/**
 * Resolve media from a Feishu message, downloading and saving to disk.
 * Similar to Discord's resolveMediaList().
 */
async function resolveFeishuMediaList(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  messageType: string;
  content: string;
  maxBytes: number;
  log?: (msg: string) => void;
  accountId?: string;
}): Promise<FeishuMediaInfo[]> {
  const { cfg, messageId, messageType, content, maxBytes, log, accountId } = params;

  // Only process media message types (including post for embedded images)
  const mediaTypes = ["image", "file", "audio", "video", "sticker", "post"];
  if (!mediaTypes.includes(messageType)) {
    return [];
  }

  const out: FeishuMediaInfo[] = [];
  const core = getFeishuRuntime();

  // Handle post (rich text) messages with embedded images
  if (messageType === "post") {
    const { imageKeys } = parsePostContent(content);
    if (imageKeys.length === 0) {
      return [];
    }

    log?.(`feishu: post message contains ${imageKeys.length} embedded image(s)`);

    for (const imageKey of imageKeys) {
      try {
        // Embedded images in post use messageResource API with image_key as file_key
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: imageKey,
          type: "image",
          accountId,
        });

        let contentType = result.contentType;
        if (!contentType) {
          contentType = await core.media.detectMime({ buffer: result.buffer });
        }

        const saved = await core.channel.media.saveMediaBuffer(
          result.buffer,
          contentType,
          "inbound",
          maxBytes,
        );

        out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:image>",
        });

        log?.(`feishu: downloaded embedded image ${imageKey}, saved to ${saved.path}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded image ${imageKey}: ${String(err)}`);
      }
    }

    return out;
  }

  // Handle other media types
  const mediaKeys = parseMediaKeys(content, messageType);
  if (!mediaKeys.imageKey && !mediaKeys.fileKey) {
    return [];
  }

  try {
    let buffer: Buffer;
    let contentType: string | undefined;
    let fileName: string | undefined;

    // For message media, always use messageResource API
    // The image.get API is only for images uploaded via im/v1/images, not for message attachments
    const fileKey = mediaKeys.imageKey || mediaKeys.fileKey;
    if (!fileKey) {
      return [];
    }

    const resourceType = messageType === "image" ? "image" : "file";
    const result = await downloadMessageResourceFeishu({
      cfg,
      messageId,
      fileKey,
      type: resourceType,
      accountId,
    });
    buffer = result.buffer;
    contentType = result.contentType;
    fileName = result.fileName || mediaKeys.fileName;

    // Detect mime type if not provided
    if (!contentType) {
      contentType = await core.media.detectMime({ buffer });
    }

    // Save to disk using core's saveMediaBuffer
    const saved = await core.channel.media.saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      maxBytes,
      fileName,
    );

    out.push({
      path: saved.path,
      contentType: saved.contentType,
      placeholder: inferPlaceholder(messageType),
    });

    log?.(`feishu: downloaded ${messageType} media, saved to ${saved.path}`);
  } catch (err) {
    log?.(`feishu: failed to download ${messageType} media: ${String(err)}`);
  }

  return out;
}

/**
 * Build media payload for inbound context.
 * Similar to Discord's buildDiscordMediaPayload().
 */
export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
): FeishuMessageContext {
  const rawContent = parseMessageContent(event.message.content, event.message.message_type);
  const mentionedBot = checkBotMentioned(event, botOpenId);
  const content = stripBotMention(rawContent, event.message.mentions);

  const ctx: FeishuMessageContext = {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    senderId: event.sender.sender_id.user_id || event.sender.sender_id.open_id || "",
    senderOpenId: event.sender.sender_id.open_id || "",
    chatType: event.message.chat_type,
    mentionedBot,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    content,
    contentType: event.message.message_type,
  };

  // Detect mention forward request: message mentions bot + at least one other user
  if (isMentionForwardRequest(event, botOpenId)) {
    const mentionTargets = extractMentionTargets(event, botOpenId);
    if (mentionTargets.length > 0) {
      ctx.mentionTargets = mentionTargets;
      // Extract message body (remove all @ placeholders)
      const allMentionKeys = (event.message.mentions ?? []).map((m) => m.key);
      ctx.mentionMessageBody = extractMessageBody(content, allMentionKeys);
    }
  }

  return ctx;
}

export async function handleFeishuMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, botOpenId, runtime, chatHistories, accountId } = params;

  // Resolve account with merged config
  const account = resolveFeishuAccount({ cfg, accountId });
  const feishuCfg = account.config;

  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Dedup check: skip if this message was already processed (memory + disk).
  const messageId = event.message.message_id;
  if (!(await tryRecordMessagePersistent(messageId, account.accountId, log))) {
    log(`feishu: skipping duplicate message ${messageId}`);
    return;
  }

  let ctx = parseFeishuMessageEvent(event, botOpenId);
  const isGroup = ctx.chatType === "group";

  // Resolve sender display name (best-effort) so the agent can attribute messages correctly.
  const senderResult = await resolveFeishuSenderName({
    account,
    senderOpenId: ctx.senderOpenId,
    log,
  });
  if (senderResult.name) ctx = { ...ctx, senderName: senderResult.name };

  // Track permission error to inform agent later (with cooldown to avoid repetition)
  let permissionErrorForAgent: PermissionError | undefined;
  if (senderResult.permissionError) {
    const appKey = account.appId ?? "default";
    const now = Date.now();
    const lastNotified = permissionErrorNotifiedAt.get(appKey) ?? 0;

    if (now - lastNotified > PERMISSION_ERROR_COOLDOWN_MS) {
      permissionErrorNotifiedAt.set(appKey, now);
      permissionErrorForAgent = senderResult.permissionError;
    }
  }

  log(
    `feishu[${account.accountId}]: received message from ${ctx.senderOpenId} in ${ctx.chatId} (${ctx.chatType})`,
  );

  // Log mention targets if detected
  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const names = ctx.mentionTargets.map((t) => t.name).join(", ");
    log(`feishu[${account.accountId}]: detected @ forward request, targets: [${names}]`);
  }

  const historyLimit = Math.max(
    0,
    feishuCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupConfig = isGroup
    ? resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId })
    : undefined;
  const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const configAllowFrom = feishuCfg?.allowFrom ?? [];
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;

  if (isGroup) {
    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.feishu !== undefined,
      groupPolicy: feishuCfg?.groupPolicy,
      defaultGroupPolicy,
    });
    warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied,
      providerKey: "feishu",
      accountId: account.accountId,
      log,
    });
    const groupAllowFrom = feishuCfg?.groupAllowFrom ?? [];
    // DEBUG: log(`feishu[${account.accountId}]: groupPolicy=${groupPolicy}`);

    // Check if this GROUP is allowed (groupAllowFrom contains group IDs like oc_xxx, not user IDs)
    const groupAllowed = isFeishuGroupAllowed({
      groupPolicy,
      allowFrom: groupAllowFrom,
      senderId: ctx.chatId, // Check group ID, not sender ID
      senderName: undefined,
    });

    if (!groupAllowed) {
      log(`feishu[${account.accountId}]: sender ${ctx.senderOpenId} not in group allowlist`);
      return;
    }

    // Additional sender-level allowlist check if group has specific allowFrom config
    const senderAllowFrom = groupConfig?.allowFrom ?? [];
    if (senderAllowFrom.length > 0) {
      const senderAllowed = isFeishuGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: senderAllowFrom,
        senderId: ctx.senderOpenId,
        senderName: ctx.senderName,
      });
      if (!senderAllowed) {
        log(`feishu: sender ${ctx.senderOpenId} not in group ${ctx.chatId} sender allowlist`);
        return;
      }
    }

    const { requireMention } = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      globalConfig: feishuCfg,
      groupConfig,
    });

    if (requireMention && !ctx.mentionedBot) {
      log(
        `feishu[${account.accountId}]: message in group ${ctx.chatId} did not mention bot, recording to history`,
      );
      if (chatHistories) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: ctx.chatId,
          limit: historyLimit,
          entry: {
            sender: ctx.senderOpenId,
            body: `${ctx.senderName ?? ctx.senderOpenId}: ${ctx.content}`,
            timestamp: Date.now(),
            messageId: ctx.messageId,
          },
        });
      }
      return;
    }
  } else {
  }

  try {
    const core = getFeishuRuntime();
    const shouldComputeCommandAuthorized = core.channel.commands.shouldComputeCommandAuthorized(
      ctx.content,
      cfg,
    );
    const storeAllowFrom =
      !isGroup &&
      dmPolicy !== "allowlist" &&
      (dmPolicy !== "open" || shouldComputeCommandAuthorized)
        ? await core.channel.pairing.readAllowFromStore("feishu").catch(() => [])
        : [];
    const effectiveDmAllowFrom = [...configAllowFrom, ...storeAllowFrom];
    const dmAllowed = resolveFeishuAllowlistMatch({
      allowFrom: effectiveDmAllowFrom,
      senderId: ctx.senderOpenId,
      senderName: ctx.senderName,
    }).allowed;

    if (!isGroup && dmPolicy !== "open" && !dmAllowed) {
      if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: "feishu",
          id: ctx.senderOpenId,
          meta: { name: ctx.senderName },
        });
        if (created) {
          log(`feishu[${account.accountId}]: pairing request sender=${ctx.senderOpenId}`);
          try {
            await sendMessageFeishu({
              cfg,
              to: `user:${ctx.senderOpenId}`,
              text: core.channel.pairing.buildPairingReply({
                channel: "feishu",
                idLine: `Your Feishu user id: ${ctx.senderOpenId}`,
                code,
              }),
              accountId: account.accountId,
            });
          } catch (err) {
            log(
              `feishu[${account.accountId}]: pairing reply failed for ${ctx.senderOpenId}: ${String(err)}`,
            );
          }
        }
      } else {
        log(
          `feishu[${account.accountId}]: blocked unauthorized sender ${ctx.senderOpenId} (dmPolicy=${dmPolicy})`,
        );
      }
      return;
    }

    const commandAllowFrom = isGroup ? (groupConfig?.allowFrom ?? []) : effectiveDmAllowFrom;
    const senderAllowedForCommands = resolveFeishuAllowlistMatch({
      allowFrom: commandAllowFrom,
      senderId: ctx.senderOpenId,
      senderName: ctx.senderName,
    }).allowed;
    const commandAuthorized = shouldComputeCommandAuthorized
      ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
          useAccessGroups,
          authorizers: [
            { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
          ],
        })
      : undefined;

    // In group chats, the session is scoped to the group, but the *speaker* is the sender.
    // Using a group-scoped From causes the agent to treat different users as the same person.
    const feishuFrom = `feishu:${ctx.senderOpenId}`;
    const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;

    // Resolve peer ID for session routing
    // When topicSessionMode is enabled, messages within a topic (identified by root_id)
    // get a separate session from the main group chat.
    let peerId = isGroup ? ctx.chatId : ctx.senderOpenId;
    if (isGroup && ctx.rootId) {
      const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId });
      const topicSessionMode =
        groupConfig?.topicSessionMode ?? feishuCfg?.topicSessionMode ?? "disabled";
      if (topicSessionMode === "enabled") {
        // Use chatId:topic:rootId as peer ID for topic-scoped sessions
        peerId = `${ctx.chatId}:topic:${ctx.rootId}`;
        log(`feishu[${account.accountId}]: topic session isolation enabled, peer=${peerId}`);
      }
    }

    let route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "feishu",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: peerId,
      },
    });

    // Dynamic agent creation for DM users
    // When enabled, creates a unique agent instance with its own workspace for each DM user.
    let effectiveCfg = cfg;
    if (!isGroup && route.matchedBy === "default") {
      const dynamicCfg = feishuCfg?.dynamicAgentCreation as DynamicAgentCreationConfig | undefined;
      if (dynamicCfg?.enabled) {
        const runtime = getFeishuRuntime();
        const result = await maybeCreateDynamicAgent({
          cfg,
          runtime,
          senderOpenId: ctx.senderOpenId,
          dynamicCfg,
          log: (msg) => log(msg),
        });
        if (result.created) {
          effectiveCfg = result.updatedCfg;
          // Re-resolve route with updated config
          route = core.channel.routing.resolveAgentRoute({
            cfg: result.updatedCfg,
            channel: "feishu",
            accountId: account.accountId,
            peer: { kind: "direct", id: ctx.senderOpenId },
          });
          log(
            `feishu[${account.accountId}]: dynamic agent created, new route: ${route.sessionKey}`,
          );
        }
      }
    }

    const preview = ctx.content.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isGroup
      ? `Feishu[${account.accountId}] message in group ${ctx.chatId}`
      : `Feishu[${account.accountId}] DM from ${ctx.senderOpenId}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `feishu:message:${ctx.chatId}:${ctx.messageId}`,
    });

    // Resolve media from message
    const mediaMaxBytes = (feishuCfg?.mediaMaxMb ?? 30) * 1024 * 1024; // 30MB default
    const mediaList = await resolveFeishuMediaList({
      cfg,
      messageId: ctx.messageId,
      messageType: event.message.message_type,
      content: event.message.content,
      maxBytes: mediaMaxBytes,
      log,
      accountId: account.accountId,
    });
    const mediaPayload = buildAgentMediaPayload(mediaList);

    // Fetch quoted/replied message content if parentId exists
    let quotedContent: string | undefined;
    if (ctx.parentId) {
      try {
        const quotedMsg = await getMessageFeishu({
          cfg,
          messageId: ctx.parentId,
          accountId: account.accountId,
        });
        if (quotedMsg) {
          quotedContent = quotedMsg.content;
          log(
            `feishu[${account.accountId}]: fetched quoted message: ${quotedContent?.slice(0, 100)}`,
          );
        }
      } catch (err) {
        log(`feishu[${account.accountId}]: failed to fetch quoted message: ${String(err)}`);
      }
    }

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);

    // Build message body with quoted content if available
    let messageBody = ctx.content;
    if (quotedContent) {
      messageBody = `[Replying to: "${quotedContent}"]\n\n${ctx.content}`;
    }

    // Include a readable speaker label so the model can attribute instructions.
    // (DMs already have per-sender sessions, but the prefix is still useful for clarity.)
    const speaker = ctx.senderName ?? ctx.senderOpenId;
    messageBody = `${speaker}: ${messageBody}`;

    // If there are mention targets, inform the agent that replies will auto-mention them
    if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
      const targetNames = ctx.mentionTargets.map((t) => t.name).join(", ");
      messageBody += `\n\n[System: Your reply will automatically @mention: ${targetNames}. Do not write @xxx yourself.]`;
    }

    const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderOpenId}` : ctx.senderOpenId;

    // If there's a permission error, dispatch a separate notification first
    if (permissionErrorForAgent) {
      const grantUrl = permissionErrorForAgent.grantUrl ?? "";
      const permissionNotifyBody = `[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: ${grantUrl}]`;

      const permissionBody = core.channel.reply.formatAgentEnvelope({
        channel: "Feishu",
        from: envelopeFrom,
        timestamp: new Date(),
        envelope: envelopeOptions,
        body: permissionNotifyBody,
      });

      const permissionCtx = core.channel.reply.finalizeInboundContext({
        Body: permissionBody,
        BodyForAgent: permissionNotifyBody,
        RawBody: permissionNotifyBody,
        CommandBody: permissionNotifyBody,
        From: feishuFrom,
        To: feishuTo,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? ctx.chatId : undefined,
        SenderName: "system",
        SenderId: "system",
        Provider: "feishu" as const,
        Surface: "feishu" as const,
        MessageSid: `${ctx.messageId}:permission-error`,
        Timestamp: Date.now(),
        WasMentioned: false,
        CommandAuthorized: commandAuthorized,
        OriginatingChannel: "feishu" as const,
        OriginatingTo: feishuTo,
      });

      const {
        dispatcher: permDispatcher,
        replyOptions: permReplyOptions,
        markDispatchIdle: markPermIdle,
      } = createFeishuReplyDispatcher({
        cfg,
        agentId: route.agentId,
        runtime: runtime as RuntimeEnv,
        chatId: ctx.chatId,
        replyToMessageId: ctx.messageId,
        accountId: account.accountId,
      });

      log(`feishu[${account.accountId}]: dispatching permission error notification to agent`);

      await core.channel.reply.dispatchReplyFromConfig({
        ctx: permissionCtx,
        cfg,
        dispatcher: permDispatcher,
        replyOptions: permReplyOptions,
      });

      markPermIdle();
    }

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Feishu",
      from: envelopeFrom,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: messageBody,
    });

    let combinedBody = body;
    const historyKey = isGroup ? ctx.chatId : undefined;

    if (isGroup && historyKey && chatHistories) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatAgentEnvelope({
            channel: "Feishu",
            // Preserve speaker identity in group history as well.
            from: `${ctx.chatId}:${entry.sender}`,
            timestamp: entry.timestamp,
            body: entry.body,
            envelope: envelopeOptions,
          }),
      });
    }

    const inboundHistory =
      isGroup && historyKey && historyLimit > 0 && chatHistories
        ? (chatHistories.get(historyKey) ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }))
        : undefined;

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: ctx.content,
      InboundHistory: inboundHistory,
      RawBody: ctx.content,
      CommandBody: ctx.content,
      From: feishuFrom,
      To: feishuTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? ctx.chatId : undefined,
      SenderName: ctx.senderName ?? ctx.senderOpenId,
      SenderId: ctx.senderOpenId,
      Provider: "feishu" as const,
      Surface: "feishu" as const,
      MessageSid: ctx.messageId,
      ReplyToBody: quotedContent ?? undefined,
      Timestamp: Date.now(),
      WasMentioned: ctx.mentionedBot,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "feishu" as const,
      OriginatingTo: feishuTo,
      ...mediaPayload,
    });

    const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
      cfg,
      agentId: route.agentId,
      runtime: runtime as RuntimeEnv,
      chatId: ctx.chatId,
      replyToMessageId: ctx.messageId,
      mentionTargets: ctx.mentionTargets,
      accountId: account.accountId,
    });

    log(`feishu[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);

    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    if (isGroup && historyKey && chatHistories) {
      clearHistoryEntriesIfEnabled({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
      });
    }

    log(
      `feishu[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`,
    );
  } catch (err) {
    error(`feishu[${account.accountId}]: failed to dispatch message: ${String(err)}`);
  }
}
