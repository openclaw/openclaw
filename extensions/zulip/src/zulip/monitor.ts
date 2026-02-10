import type {
  ChannelAccountSnapshot,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logInboundDrop,
  logTypingFailure,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  resolveControlCommandGate,
  resolveChannelMediaMaxBytes,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipAccount } from "./accounts.js";
import {
  createZulipClient,
  fetchZulipMe,
  fetchZulipStream,
  normalizeZulipBaseUrl,
  registerZulipQueue,
  getZulipEventsWithRetry,
  deleteZulipQueue,
  sendZulipTyping,
  addZulipReaction,
  removeZulipReaction,
  type ZulipMessage,
  type ZulipStream,
} from "./client.js";
import {
  createDedupeCache,
  formatInboundFromLabel,
  resolveThreadSessionKeys,
} from "./monitor-helpers.js";
import { sendMessageZulip } from "./send.js";
import { downloadZulipUpload, extractZulipUploadUrls, normalizeEmojiName } from "./uploads.js";

export type MonitorZulipOpts = {
  apiKey?: string;
  email?: string;
  baseUrl?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

const RECENT_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MESSAGE_MAX = 2000;
const DEFAULT_ONCHAR_PREFIXES = [">", "!"];
const DEFAULT_TOPIC = "general";

const recentInboundMessages = createDedupeCache({
  ttlMs: RECENT_MESSAGE_TTL_MS,
  maxSize: RECENT_MESSAGE_MAX,
});

function resolveRuntime(opts: MonitorZulipOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/@\*\*([^*]+)\*\*/g, "@$1")
    .trim();
}

function normalizeMention(text: string, mention: string | undefined): string {
  if (!mention) {
    return text.trim();
  }
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${escaped}\\b`, "gi");
  return text.replace(re, " ").replace(/\s+/g, " ").trim();
}

function resolveOncharPrefixes(prefixes: string[] | undefined): string[] {
  const cleaned = prefixes?.map((entry) => entry.trim()).filter(Boolean) ?? DEFAULT_ONCHAR_PREFIXES;
  return cleaned.length > 0 ? cleaned : DEFAULT_ONCHAR_PREFIXES;
}

function stripOncharPrefix(
  text: string,
  prefixes: string[],
): { triggered: boolean; stripped: string } {
  const trimmed = text.trimStart();
  for (const prefix of prefixes) {
    if (!prefix) {
      continue;
    }
    if (trimmed.startsWith(prefix)) {
      return {
        triggered: true,
        stripped: trimmed.slice(prefix.length).trimStart(),
      };
    }
  }
  return { triggered: false, stripped: text };
}

function extractZulipTopicDirective(text: string): { text: string; topic?: string } {
  const match = text.match(/^\s*\[\[zulip_topic:\s*([^\]]+?)\s*\]\]\s*/i);
  if (!match) {
    return { text };
  }
  const topic = match[1]?.trim();
  if (!topic) {
    return { text: text.slice(match[0].length).trimStart() };
  }
  return {
    text: text.slice(match[0].length).trimStart(),
    topic,
  };
}

function normalizeAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed
    .replace(/^(zulip|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function normalizeAllowList(entries: Array<string | number>): string[] {
  const normalized = entries.map((entry) => normalizeAllowEntry(String(entry))).filter(Boolean);
  return Array.from(new Set(normalized));
}

function isSenderAllowed(params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
}): boolean {
  const allowFrom = params.allowFrom;
  if (allowFrom.length === 0) {
    return false;
  }
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = normalizeAllowEntry(params.senderId);
  const normalizedSenderName = params.senderName ? normalizeAllowEntry(params.senderName) : "";
  return allowFrom.some(
    (entry) =>
      entry === normalizedSenderId || (normalizedSenderName && entry === normalizedSenderName),
  );
}

async function saveZulipMediaBuffer(params: {
  core: ReturnType<typeof getZulipRuntime>;
  buffer: Buffer;
  contentType: string;
  filename: string;
  maxBytes: number;
}): Promise<{ path: string; contentType: string } | null> {
  const { core, buffer, contentType, filename, maxBytes } = params;
  if (core.channel.media?.saveMediaBuffer) {
    const saved = await core.channel.media.saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      maxBytes,
      filename,
    );
    return {
      path: saved.path,
      contentType: saved.contentType ?? contentType,
    };
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-upload-"));
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, buffer);
  return { path: filePath, contentType };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function monitorZulipProvider(opts: MonitorZulipOpts = {}): Promise<void> {
  const core = getZulipRuntime();
  const cfg = opts.config ?? core.config.loadConfig();
  const runtime = resolveRuntime(opts);
  const account = resolveZulipAccount({
    cfg,
    accountId: opts.accountId,
  });

  const apiKey = opts.apiKey?.trim() || account.apiKey?.trim();
  const email = opts.email?.trim() || account.email?.trim();
  if (!apiKey || !email) {
    throw new Error(
      `Zulip apiKey/email missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.apiKey/email or ZULIP_API_KEY/ZULIP_EMAIL for default).`,
    );
  }
  const baseUrl = normalizeZulipBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Zulip url missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.url or ZULIP_URL for default).`,
    );
  }

  const client = createZulipClient({ baseUrl, email, apiKey });
  const botUser = await fetchZulipMe(client);
  const botUserId = botUser.id;
  const botEmail = botUser.email ?? "";
  const botUsername = botUser.full_name ?? "";

  runtime.log?.(`zulip connected as ${botUsername ? botUsername : botUserId} (${botEmail})`);

  const logger = core.logging.getChildLogger({ module: "zulip" });
  const logVerboseMessage = core.logging.shouldLogVerbose()
    ? (message: string) => logger.debug?.(message)
    : () => {};

  const oncharPrefixes = resolveOncharPrefixes(account.oncharPrefixes);
  const oncharEnabled = account.chatmode === "onchar";
  const channelHistories = new Map<string, HistoryEntry[]>();

  const mediaMaxBytes =
    resolveChannelMediaMaxBytes({
      cfg,
      accountId: account.accountId,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        (
          cfg.channels?.zulip as {
            mediaMaxMb?: number;
            accounts?: Record<string, { mediaMaxMb?: number }>;
          }
        )?.accounts?.[accountId]?.mediaMaxMb ??
        (cfg.channels?.zulip as { mediaMaxMb?: number })?.mediaMaxMb,
    }) ?? 5 * 1024 * 1024;

  const reactionConfig = account.config.reactions ?? {};
  const reactionsEnabled = reactionConfig.enabled !== false;
  const reactionClearOnFinish = reactionConfig.clearOnFinish !== false;
  const reactionStart = normalizeEmojiName(reactionConfig.onStart ?? "eyes");
  const reactionSuccess = normalizeEmojiName(reactionConfig.onSuccess ?? "check_mark");
  const reactionError = normalizeEmojiName(reactionConfig.onError ?? "warning");

  const handleMessage = async (message: ZulipMessage) => {
    const messageId = String(message.id ?? "");
    if (!messageId) {
      return;
    }
    const dedupeKey = `${account.accountId}:${messageId}`;
    if (recentInboundMessages.check(dedupeKey)) {
      return;
    }

    const senderId = message.sender_email || String(message.sender_id ?? "");
    if (!senderId) {
      return;
    }
    if (senderId === botEmail || String(message.sender_id) === botUserId) {
      return;
    }

    const senderName = message.sender_full_name?.trim() || senderId;
    const isDM = message.type === "private";
    const kind = isDM ? "dm" : "channel";
    const chatType = isDM ? "direct" : "channel";

    let streamName = "";
    let streamId = "";
    let topic = DEFAULT_TOPIC;
    let channelId = "";

    if (isDM) {
      channelId = senderId;
    } else {
      streamId = String(message.stream_id ?? "");
      channelId = streamId;
      if (typeof message.display_recipient === "string") {
        streamName = message.display_recipient;
      }
      topic = message.subject?.trim() || DEFAULT_TOPIC;
    }

    const rawText = stripHtmlToText(message.content ?? "");
    const oncharResult = stripOncharPrefix(rawText, oncharPrefixes);

    const uploadUrls = extractZulipUploadUrls(message.content ?? "", baseUrl);
    const mediaPaths: string[] = [];
    const mediaTypes: string[] = [];
    const mediaUrls: string[] = [];
    if (uploadUrls.length > 0) {
      for (const uploadUrl of uploadUrls) {
        try {
          const downloaded = await downloadZulipUpload(uploadUrl, baseUrl, client.authHeader, mediaMaxBytes);
          const saved = await saveZulipMediaBuffer({
            core,
            buffer: downloaded.buffer,
            contentType: downloaded.contentType,
            filename: downloaded.filename,
            maxBytes: mediaMaxBytes,
          });
          if (saved) {
            mediaPaths.push(saved.path);
            mediaTypes.push(saved.contentType);
            mediaUrls.push(uploadUrl);
          }
        } catch (err) {}
      }
    }
    const oncharTriggered = oncharEnabled && oncharResult.triggered;

    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, "main");
    const wasMentioned =
      !isDM &&
      (rawText.toLowerCase().includes(`@${botUsername.toLowerCase()}`) ||
        core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));

    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
    const configAllowFrom = normalizeAllowList(account.config.allowFrom ?? []);
    const configGroupAllowFrom = normalizeAllowList(account.config.groupAllowFrom ?? []);
    const storeAllowFrom = normalizeAllowList(
      await core.channel.pairing.readAllowFromStore("zulip").catch(() => []),
    );
    const effectiveAllowFrom = Array.from(new Set([...configAllowFrom, ...storeAllowFrom]));
    const effectiveGroupAllowFrom = Array.from(
      new Set([
        ...(configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom),
        ...storeAllowFrom,
      ]),
    );

    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "zulip",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(rawText, cfg);
    const isControlCommand = allowTextCommands && hasControlCommand;
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const senderAllowedForCommands = isSenderAllowed({
      senderId,
      senderName,
      allowFrom: effectiveAllowFrom,
    });
    const groupAllowedForCommands = isSenderAllowed({
      senderId,
      senderName,
      allowFrom: effectiveGroupAllowFrom,
    });
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
        {
          configured: effectiveGroupAllowFrom.length > 0,
          allowed: groupAllowedForCommands,
        },
      ],
      allowTextCommands,
      hasControlCommand,
    });
    const commandAuthorized =
      kind === "dm"
        ? dmPolicy === "open" || senderAllowedForCommands
        : commandGate.commandAuthorized;

    if (kind === "dm") {
      if (dmPolicy === "disabled") {
        logVerboseMessage(`zulip: drop dm (dmPolicy=disabled sender=${senderId})`);
        return;
      }
      if (dmPolicy !== "open" && !senderAllowedForCommands) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "zulip",
            id: senderId,
            meta: { name: senderName },
          });
          logVerboseMessage(`zulip: pairing request sender=${senderId} created=${created}`);
          if (created) {
            try {
              await sendMessageZulip(
                `user:${senderId}`,
                core.channel.pairing.buildPairingReply({
                  channel: "zulip",
                  idLine: `Your Zulip email: ${senderId}`,
                  code,
                }),
                { accountId: account.accountId },
              );
              opts.statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerboseMessage(`zulip: pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logVerboseMessage(`zulip: drop dm sender=${senderId} (dmPolicy=${dmPolicy})`);
        }
        return;
      }
    } else {
      if (groupPolicy === "disabled") {
        logVerboseMessage("zulip: drop group message (groupPolicy=disabled)");
        return;
      }
      if (groupPolicy === "allowlist") {
        if (effectiveGroupAllowFrom.length === 0) {
          logVerboseMessage("zulip: drop group message (no group allowlist)");
          return;
        }
        if (!groupAllowedForCommands) {
          logVerboseMessage(`zulip: drop group sender=${senderId} (not in groupAllowFrom)`);
          return;
        }
      }
    }

    if (kind !== "dm" && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerboseMessage,
        channel: "zulip",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    const shouldRequireMention =
      kind !== "dm" &&
      core.channel.groups.resolveRequireMention({
        cfg,
        channel: "zulip",
        accountId: account.accountId,
        groupId: channelId,
        requireMentionOverride: account.config.requireMention,
      });
    const shouldBypassMention =
      isControlCommand && shouldRequireMention && !wasMentioned && commandAuthorized;
    const effectiveWasMentioned = wasMentioned || shouldBypassMention || oncharTriggered;
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;

    if (oncharEnabled && !oncharTriggered && !wasMentioned && !isControlCommand) {
      return;
    }

    if (kind !== "dm" && shouldRequireMention && canDetectMention) {
      if (!effectiveWasMentioned) {
        return;
      }
    }

    const bodySource = oncharTriggered ? oncharResult.stripped : rawText;
    const bodyText = normalizeMention(bodySource, botUsername);
    if (!bodyText) {
      return;
    }

    core.channel.activity.record({
      channel: "zulip",
      accountId: account.accountId,
      direction: "inbound",
    });

    const roomLabel = streamName ? `#${streamName}` : `stream:${streamId}`;
    const fromLabel = formatInboundFromLabel({
      isGroup: kind !== "dm",
      groupLabel: roomLabel,
      groupId: channelId,
      groupFallback: "Stream",
      directLabel: senderName,
      directId: senderId,
    });

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
      teamId: undefined,
      peer: {
        kind,
        id: kind === "dm" ? senderId : channelId,
      },
    });

    // Use the SDK-provided session key (includes agent: prefix from routing)
    const baseSessionKey = route.sessionKey ?? `zulip:${account.accountId}:${channelId}`;
    const threadKeys = resolveThreadSessionKeys({
      baseSessionKey,
      threadId: topic !== DEFAULT_TOPIC ? topic : undefined,
    });
    const sessionKey = threadKeys.sessionKey;
    const historyKey = kind === "dm" ? null : sessionKey;

    const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel =
      kind === "dm"
        ? `Zulip DM from ${senderName}`
        : `Zulip message in ${roomLabel} from ${senderName}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `zulip:message:${messageId}`,
    });

    const timestamp = message.timestamp ? message.timestamp * 1000 : undefined;
    const textWithId = `${bodyText}\n[zulip message id: ${messageId}]`;
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Zulip",
      from: fromLabel,
      timestamp,
      body: textWithId,
      chatType,
      sender: { name: senderName, id: senderId },
    });

    const to = kind === "dm" ? `user:${senderId}` : `stream:${streamName || streamId}:${topic}`;
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: bodyText,
      CommandBody: bodyText,
      From: kind === "dm" ? `zulip:${senderId}` : `zulip:channel:${channelId}`,
      To: to,
      SessionKey: sessionKey,
      ParentSessionKey: threadKeys.parentSessionKey,
      AccountId: route.accountId,
      ChatType: chatType,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "dm" ? roomLabel : undefined,
      GroupChannel: streamName ? `#${streamName}` : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "zulip" as const,
      Surface: "zulip" as const,
      MessageSid: messageId,
      ReplyToId: topic !== DEFAULT_TOPIC ? topic : undefined,
      MessageThreadId: topic !== DEFAULT_TOPIC ? topic : undefined,
      Timestamp: timestamp,
      WasMentioned: kind !== "dm" ? effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "zulip" as const,
      OriginatingTo: to,
      MediaPath: mediaPaths[0],
      MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      MediaUrl: mediaUrls[0],
      MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      MediaType: mediaTypes[0],
      MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    });

    if (kind === "dm") {
      const sessionCfg = cfg.session;
      const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId,
      });
      await core.channel.session.updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: {
          channel: "zulip",
          to,
          accountId: route.accountId,
        },
      });
    }

    const previewLine = bodyText.slice(0, 200).replace(/\n/g, "\\n");
    logVerboseMessage(
      `zulip inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`,
    );

    const addReactionSafe = async (emojiName: string) => {
      if (!reactionsEnabled || !emojiName) {
        return;
      }
      try {
        await addZulipReaction(client, { messageId, emojiName });
      } catch (err) {
        logVerboseMessage(`zulip: failed to add reaction ${emojiName}: ${String(err)}`);
      }
    };
    const removeReactionSafe = async (emojiName: string) => {
      if (!reactionsEnabled || !emojiName) {
        return;
      }
      try {
        await removeZulipReaction(client, { messageId, emojiName });
      } catch (err) {
        logVerboseMessage(`zulip: failed to remove reaction ${emojiName}: ${String(err)}`);
      }
    };

    if (reactionsEnabled) {
      await addReactionSafe(reactionStart);
    }

    const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "zulip", account.accountId, {
      fallbackLimit: account.textChunkLimit ?? 4000,
    });
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
    });

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "zulip",
      accountId: account.accountId,
    });

    const typingParams = isDM
      ? { op: "start" as const, type: "direct" as const, to: [Number(message.sender_id)] }
      : streamId
        ? { op: "start" as const, type: "stream" as const, streamId: Number(streamId), topic }
        : null;

    const typingCallbacks = createTypingCallbacks({
      start: async () => {
        if (typingParams) {
          await sendZulipTyping(client, typingParams);
        }
      },
      stop: async () => {
        if (typingParams) {
          await sendZulipTyping(client, { ...typingParams, op: "stop" });
        }
      },
      onStartError: (err) => {
        logTypingFailure({
          log: logVerboseMessage,
          channel: "zulip",
          target: isDM ? senderId : `stream:${streamId}:${topic}`,
          error: err,
        });
      },
      onStopError: (err) => {
        logTypingFailure({
          log: logVerboseMessage,
          channel: "zulip",
          target: isDM ? senderId : `stream:${streamId}:${topic}`,
          error: err,
        });
      },
    });

    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...prefixOptions,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        onReplyStart: typingCallbacks.onReplyStart,
        deliver: async (payload: ReplyPayload) => {
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const rawText = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
          const { text, topic: topicOverride } = extractZulipTopicDirective(rawText);
          const resolvedTopic = topicOverride ? topicOverride.slice(0, 60) : topic;
          if (mediaUrls.length === 0) {
            const chunkMode = core.channel.text.resolveChunkMode(cfg, "zulip", account.accountId);
            const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
            for (const chunk of chunks.length > 0 ? chunks : [text]) {
              if (!chunk) {
                continue;
              }
              await sendMessageZulip(to, chunk, {
                accountId: account.accountId,
                topic: resolvedTopic,
              });
            }
          } else {
            let first = true;
            for (const mediaUrl of mediaUrls) {
              const caption = first ? text : "";
              first = false;
              await sendMessageZulip(to, caption, {
                accountId: account.accountId,
                mediaUrl,
                topic: resolvedTopic,
              });
            }
          }
          opts.statusSink?.({ lastOutboundAt: Date.now() });
        },
        onError: (err: unknown) => {
          runtime.error?.(`zulip reply failed: ${String(err)}`);
        },
      });

    let dispatchError: unknown;
    try {
      await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming:
            typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
          onModelSelected,
        },
      });
    } catch (err) {
      dispatchError = err;
      runtime.error?.(`zulip reply failed: ${String(err)}`);
    } finally {
      markDispatchIdle();
    }

    if (reactionsEnabled) {
      if (reactionClearOnFinish) {
        await removeReactionSafe(reactionStart);
      }
      if (dispatchError) {
        await addReactionSafe(reactionError);
      } else {
        await addReactionSafe(reactionSuccess);
      }
    }

    if (historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: channelHistories,
        historyKey,
        limit: DEFAULT_GROUP_HISTORY_LIMIT,
      });
    }

    opts.statusSink?.({ lastInboundAt: Date.now() });
  };

  // Register event queue
  const streams = account.streams ?? ["*"];
  const queue = await registerZulipQueue(client, {
    eventTypes: ["message"],
    streams, // Pass ["*"] to trigger all_public_streams=true in registerZulipQueue
  });
  let queueId = queue.queueId;
  let lastEventId = queue.lastEventId;
  let pollBackoffMs = 0;

  runtime.log?.(`zulip event queue registered: ${queueId}`);

  const resetPollBackoff = () => {
    pollBackoffMs = 0;
  };

  const processMessage = async (message: ZulipMessage): Promise<void> => {
    try {
      await handleMessage(message);
    } catch (err) {
      runtime.error?.(`zulip message handler failed: ${String(err)}`);
    }
  };

  // Long-polling loop
  while (!opts.abortSignal?.aborted) {
    try {
      const response = await getZulipEventsWithRetry(client, {
        queueId,
        lastEventId,
        timeoutMs: 90000,
        retryBaseDelayMs: 1000,
      });

      if (response.result === "error") {
        const msg = response.msg ?? "";
        const isBadQueue =
          response.code === "BAD_EVENT_QUEUE_ID" || msg.toLowerCase().includes("bad event queue");
        if (isBadQueue) {
          runtime.log?.("zulip: queue expired, re-registering...");
          const newQueue = await registerZulipQueue(client, {
            eventTypes: ["message"],
            streams, // Pass ["*"] to trigger all_public_streams=true in registerZulipQueue
          });
          queueId = newQueue.queueId;
          lastEventId = newQueue.lastEventId;
          runtime.log?.(`zulip event queue re-registered: ${queueId}`);
          resetPollBackoff();
          continue;
        }
        throw new Error(`Zulip events error: ${response.msg}`);
      }

      const events = response.events ?? [];
      if (events.length > 0) {
        opts.statusSink?.({
          connected: true,
          lastConnectedAt: Date.now(),
        });
      }

      if (events.length === 0) {
        await sleep(1000);
      }

      resetPollBackoff();

      for (const event of events) {
        if (event.type === "message" && event.message) {
          await processMessage(event.message);
        }
        const nextEventId = Number((event as { id?: unknown })?.id);
        if (!Number.isNaN(nextEventId) && nextEventId > 0) {
          lastEventId = nextEventId;
        }
      }
    } catch (err) {
      if (opts.abortSignal?.aborted) {
        break;
      }
      const errStr = String(err);
      if (errStr.toLowerCase().includes("bad event queue")) {
        runtime.log?.("zulip: bad event queue error thrown; re-registering...");
        const newQueue = await registerZulipQueue(client, {
          eventTypes: ["message"],
          streams,
        });
        queueId = newQueue.queueId;
        lastEventId = newQueue.lastEventId;
        runtime.log?.(`zulip event queue re-registered: ${queueId}`);
        resetPollBackoff();
        continue;
      }
      const status = (err as { status?: number })?.status;
      const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;
      runtime.error?.(`zulip polling error: ${String(err)}`);
      opts.statusSink?.({
        connected: false,
        lastError: String(err),
      });
      const baseDelay = status === 429 ? 10000 : 1000;
      if (!pollBackoffMs) {
        pollBackoffMs = baseDelay;
      } else {
        pollBackoffMs = Math.min(30000, pollBackoffMs * 2);
      }
      const delay =
        retryAfterMs && retryAfterMs > 0 ? Math.min(30000, retryAfterMs) : pollBackoffMs;
      await sleep(delay);
    }
  }

  // Cleanup
  await deleteZulipQueue(client, queueId);
  runtime.log?.("zulip monitor stopped");
}
