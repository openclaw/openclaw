import type {
  ChannelAccountSnapshot,
  ChatType,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
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
import { getRocketchatRuntime } from "../runtime.js";
import { resolveRocketchatAccount } from "./accounts.js";
import {
  createRocketchatClient,
  fetchRocketchatMe,
  fetchRocketchatRoom,
  fetchRocketchatUser,
  normalizeRocketchatBaseUrl,
  type RocketchatMessage,
  type RocketchatRoom,
  type RocketchatUser,
} from "./client.js";
import {
  createDedupeCache,
  formatInboundFromLabel,
  resolveThreadSessionKeys,
} from "./monitor-helpers.js";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";
import {
  createRocketchatConnectOnce,
  type RocketchatWebSocketFactory,
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";
import { sendMessageRocketchat } from "./send.js";

export type MonitorRocketchatOpts = {
  authToken?: string;
  userId?: string;
  baseUrl?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  webSocketFactory?: RocketchatWebSocketFactory;
};

type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

const RECENT_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MESSAGE_MAX = 2000;
const ROOM_CACHE_TTL_MS = 5 * 60_000;
const USER_CACHE_TTL_MS = 10 * 60_000;

const recentInboundMessages = createDedupeCache({
  ttlMs: RECENT_MESSAGE_TTL_MS,
  maxSize: RECENT_MESSAGE_MAX,
});

function resolveRuntime(opts: MonitorRocketchatOpts): RuntimeEnv {
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

function normalizeMention(text: string, mention: string | undefined): string {
  if (!mention) {
    return text.trim();
  }
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${escaped}\\b`, "gi");
  return text.replace(re, " ").replace(/\s+/g, " ").trim();
}

function roomKind(roomType?: string | null): ChatType {
  if (!roomType) {
    return "channel";
  }
  const normalized = roomType.trim().toLowerCase();
  if (normalized === "d") {
    return "direct";
  }
  if (normalized === "p") {
    return "group";
  }
  return "channel";
}

function roomChatType(kind: ChatType): "direct" | "group" | "channel" {
  if (kind === "direct") {
    return "direct";
  }
  if (kind === "group") {
    return "group";
  }
  return "channel";
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
    .replace(/^(rocketchat|user):/i, "")
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

type RocketchatMediaInfo = {
  path: string;
  contentType?: string;
  kind: MediaKind;
};

function buildAttachmentPlaceholder(mediaList: RocketchatMediaInfo[]): string {
  if (mediaList.length === 0) {
    return "";
  }
  if (mediaList.length === 1) {
    const kind = mediaList[0].kind === "unknown" ? "document" : mediaList[0].kind;
    return `<media:${kind}>`;
  }
  const allImages = mediaList.every((media) => media.kind === "image");
  const label = allImages ? "image" : "file";
  const suffix = mediaList.length === 1 ? label : `${label}s`;
  const tag = allImages ? "<media:image>" : "<media:document>";
  return `${tag} (${mediaList.length} ${suffix})`;
}

function buildMediaPayload(mediaList: RocketchatMediaInfo[]): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean) as string[];
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

function buildWsUrl(baseUrl: string): string {
  const normalized = normalizeRocketchatBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Rocket.Chat baseUrl is required");
  }
  const wsBase = normalized.replace(/^http/i, "ws");
  return `${wsBase}/websocket`;
}

export async function monitorRocketchatProvider(opts: MonitorRocketchatOpts = {}): Promise<void> {
  const core = getRocketchatRuntime();
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveRocketchatAccount({
    cfg,
    accountId: opts.accountId,
  });
  const authToken = opts.authToken?.trim() || account.authToken?.trim();
  if (!authToken) {
    throw new Error(
      `Rocket.Chat auth token missing for account "${account.accountId}" (set channels.rocketchat.accounts.${account.accountId}.authToken or ROCKETCHAT_AUTH_TOKEN for default).`,
    );
  }
  const rcUserId = opts.userId?.trim() || account.userId?.trim();
  if (!rcUserId) {
    throw new Error(
      `Rocket.Chat user ID missing for account "${account.accountId}" (set channels.rocketchat.accounts.${account.accountId}.userId or ROCKETCHAT_USER_ID for default).`,
    );
  }
  const baseUrl = normalizeRocketchatBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Rocket.Chat baseUrl missing for account "${account.accountId}" (set channels.rocketchat.accounts.${account.accountId}.baseUrl or ROCKETCHAT_URL for default).`,
    );
  }

  const client = createRocketchatClient({ baseUrl, authToken, userId: rcUserId });
  const botUser = await fetchRocketchatMe(client);
  const botUserId = botUser._id;
  const botUsername = botUser.username?.trim() || undefined;
  runtime.log?.(`rocketchat connected as ${botUsername ? `@${botUsername}` : botUserId}`);

  // Fetch rooms the bot is a member of to subscribe to
  const roomsData = await client.request<{ update: RocketchatRoom[] }>(
    `/rooms.get?updatedSince=${new Date(0).toISOString()}`,
  );
  const roomIds = (roomsData.update ?? []).map((room) => room._id).filter(Boolean);

  const roomCache = new Map<string, { value: RocketchatRoom | null; expiresAt: number }>();
  const userCache = new Map<string, { value: RocketchatUser | null; expiresAt: number }>();
  const logger = core.logging.getChildLogger({ module: "rocketchat" });
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    logger.debug?.(message);
  };
  const mediaMaxBytes =
    resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: () => undefined,
      accountId: account.accountId,
    }) ?? 8 * 1024 * 1024;
  const historyLimit = Math.max(
    0,
    cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const channelHistories = new Map<string, HistoryEntry[]>();

  const fetchWithAuth: FetchLike = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-Auth-Token", client.authToken);
    headers.set("X-User-Id", client.userId);
    return fetch(input, { ...init, headers });
  };

  const resolveMedia = async (message: RocketchatMessage): Promise<RocketchatMediaInfo[]> => {
    const files = message.files ?? (message.file ? [message.file] : []);
    if (files.length === 0) {
      return [];
    }
    const out: RocketchatMediaInfo[] = [];
    for (const file of files) {
      if (!file._id) {
        continue;
      }
      try {
        const fileUrl = `${client.apiBaseUrl}/e2e.fetchMyKeys`; // placeholder
        // Rocket.Chat file URLs follow the pattern: /file-upload/{fileId}/{fileName}
        const downloadUrl = `${client.baseUrl}/file-upload/${file._id}/${encodeURIComponent(file.name ?? "file")}`;
        const fetched = await core.channel.media.fetchRemoteMedia({
          url: downloadUrl,
          fetchImpl: fetchWithAuth,
          filePathHint: file.name ?? file._id,
          maxBytes: mediaMaxBytes,
        });
        const saved = await core.channel.media.saveMediaBuffer(
          fetched.buffer,
          fetched.contentType ?? undefined,
          "inbound",
          mediaMaxBytes,
        );
        const contentType = saved.contentType ?? fetched.contentType ?? undefined;
        out.push({
          path: saved.path,
          contentType,
          kind: core.media.mediaKindFromMime(contentType),
        });
        void fileUrl; // suppress unused
      } catch (err) {
        logger.debug?.(`rocketchat: failed to download file ${file._id}: ${String(err)}`);
      }
    }
    return out;
  };

  const resolveRoomInfo = async (roomId: string): Promise<RocketchatRoom | null> => {
    const cached = roomCache.get(roomId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const info = await fetchRocketchatRoom(client, roomId);
      roomCache.set(roomId, {
        value: info,
        expiresAt: Date.now() + ROOM_CACHE_TTL_MS,
      });
      return info;
    } catch (err) {
      logger.debug?.(`rocketchat: room lookup failed: ${String(err)}`);
      roomCache.set(roomId, {
        value: null,
        expiresAt: Date.now() + ROOM_CACHE_TTL_MS,
      });
      return null;
    }
  };

  const resolveUserInfo = async (userId: string): Promise<RocketchatUser | null> => {
    const cached = userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const info = await fetchRocketchatUser(client, userId);
      userCache.set(userId, {
        value: info,
        expiresAt: Date.now() + USER_CACHE_TTL_MS,
      });
      return info;
    } catch (err) {
      logger.debug?.(`rocketchat: user lookup failed: ${String(err)}`);
      userCache.set(userId, {
        value: null,
        expiresAt: Date.now() + USER_CACHE_TTL_MS,
      });
      return null;
    }
  };

  const handleMessage = async (
    message: RocketchatMessage,
    eventRoomId: string,
    messageIds?: string[],
  ) => {
    const roomId = message.rid ?? eventRoomId;
    if (!roomId) {
      return;
    }

    const allMessageIds = messageIds?.length ? messageIds : message._id ? [message._id] : [];
    if (allMessageIds.length === 0) {
      return;
    }
    const dedupeEntries = allMessageIds.map((id) =>
      recentInboundMessages.check(`${account.accountId}:${id}`),
    );
    if (dedupeEntries.length > 0 && dedupeEntries.every(Boolean)) {
      return;
    }

    const senderId = message.u?._id;
    if (!senderId) {
      return;
    }
    if (senderId === botUserId) {
      return;
    }

    const roomInfo = await resolveRoomInfo(roomId);
    const roomType = roomInfo?.t ?? undefined;
    const kind = roomKind(roomType);
    const chatType = roomChatType(kind);

    const senderName =
      message.u?.username?.trim() ||
      (await resolveUserInfo(senderId))?.username?.trim() ||
      senderId;
    const rawText = message.msg?.trim() || "";
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
    const configAllowFrom = normalizeAllowList(account.config.allowFrom ?? []);
    const configGroupAllowFrom = normalizeAllowList(account.config.groupAllowFrom ?? []);
    const storeAllowFrom = normalizeAllowList(
      await core.channel.pairing.readAllowFromStore("rocketchat").catch(() => []),
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
      surface: "rocketchat",
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
      kind === "direct"
        ? dmPolicy === "open" || senderAllowedForCommands
        : commandGate.commandAuthorized;

    if (kind === "direct") {
      if (dmPolicy === "disabled") {
        logVerboseMessage(`rocketchat: drop dm (dmPolicy=disabled sender=${senderId})`);
        return;
      }
      if (dmPolicy !== "open" && !senderAllowedForCommands) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "rocketchat",
            id: senderId,
            meta: { name: senderName },
          });
          logVerboseMessage(`rocketchat: pairing request sender=${senderId} created=${created}`);
          if (created) {
            try {
              await sendMessageRocketchat(
                `user:${senderId}`,
                core.channel.pairing.buildPairingReply({
                  channel: "rocketchat",
                  idLine: `Your Rocket.Chat user id: ${senderId}`,
                  code,
                }),
                { accountId: account.accountId },
              );
              opts.statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerboseMessage(`rocketchat: pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logVerboseMessage(`rocketchat: drop dm sender=${senderId} (dmPolicy=${dmPolicy})`);
        }
        return;
      }
    } else {
      if (groupPolicy === "disabled") {
        logVerboseMessage("rocketchat: drop group message (groupPolicy=disabled)");
        return;
      }
      if (groupPolicy === "allowlist") {
        if (effectiveGroupAllowFrom.length === 0) {
          logVerboseMessage("rocketchat: drop group message (no group allowlist)");
          return;
        }
        if (!groupAllowedForCommands) {
          logVerboseMessage(`rocketchat: drop group sender=${senderId} (not in groupAllowFrom)`);
          return;
        }
      }
    }

    if (kind !== "direct" && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerboseMessage,
        channel: "rocketchat",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    const roomName = roomInfo?.name ?? "";
    const roomDisplay = roomInfo?.fname ?? roomName;
    const roomLabel = roomName ? `#${roomName}` : roomDisplay || `#${roomId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "rocketchat",
      accountId: account.accountId,
      peer: {
        kind,
        id: kind === "direct" ? senderId : roomId,
      },
    });

    const baseSessionKey = route.sessionKey;
    const threadId = message.tmid?.trim() || undefined;
    const threadKeys = resolveThreadSessionKeys({
      baseSessionKey,
      threadId,
      parentSessionKey: threadId ? baseSessionKey : undefined,
    });
    const sessionKey = threadKeys.sessionKey;
    const historyKey = kind === "direct" ? null : sessionKey;

    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
    const wasMentioned =
      kind !== "direct" &&
      ((botUsername ? rawText.toLowerCase().includes(`@${botUsername.toLowerCase()}`) : false) ||
        core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));
    const pendingBody =
      rawText ||
      ((message.files?.length ?? (message.file ? 1 : 0)) > 0
        ? `[Rocket.Chat ${(message.files?.length ?? 1) === 1 ? "file" : "files"}]`
        : "");
    const pendingSender = senderName;
    const recordPendingHistory = () => {
      const trimmed = pendingBody.trim();
      const timestamp = message.ts?.$date;
      recordPendingHistoryEntryIfEnabled({
        historyMap: channelHistories,
        limit: historyLimit,
        historyKey: historyKey ?? "",
        entry:
          historyKey && trimmed
            ? {
                sender: pendingSender,
                body: trimmed,
                timestamp: typeof timestamp === "number" ? timestamp : undefined,
                messageId: message._id ?? undefined,
              }
            : null,
      });
    };

    const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
    const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
    const oncharResult = oncharEnabled
      ? stripOncharPrefix(rawText, oncharPrefixes)
      : { triggered: false, stripped: rawText };
    const oncharTriggered = oncharResult.triggered;

    const shouldRequireMention =
      kind !== "direct" &&
      core.channel.groups.resolveRequireMention({
        cfg,
        channel: "rocketchat",
        accountId: account.accountId,
        groupId: roomId,
      });
    const shouldBypassMention =
      isControlCommand && shouldRequireMention && !wasMentioned && commandAuthorized;
    const effectiveWasMentioned = wasMentioned || shouldBypassMention || oncharTriggered;
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;

    if (oncharEnabled && !oncharTriggered && !wasMentioned && !isControlCommand) {
      recordPendingHistory();
      return;
    }

    if (kind !== "direct" && shouldRequireMention && canDetectMention) {
      if (!effectiveWasMentioned) {
        recordPendingHistory();
        return;
      }
    }
    const mediaList = await resolveMedia(message);
    const mediaPlaceholder = buildAttachmentPlaceholder(mediaList);
    const bodySource = oncharTriggered ? oncharResult.stripped : rawText;
    const baseText = [bodySource, mediaPlaceholder].filter(Boolean).join("\n").trim();
    const bodyText = normalizeMention(baseText, botUsername);
    if (!bodyText) {
      return;
    }

    core.channel.activity.record({
      channel: "rocketchat",
      accountId: account.accountId,
      direction: "inbound",
    });

    const fromLabel = formatInboundFromLabel({
      isGroup: kind !== "direct",
      groupLabel: roomDisplay || roomLabel,
      groupId: roomId,
      groupFallback: roomLabel || "Channel",
      directLabel: senderName,
      directId: senderId,
    });

    const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel =
      kind === "direct"
        ? `Rocket.Chat DM from ${senderName}`
        : `Rocket.Chat message in ${roomLabel} from ${senderName}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `rocketchat:message:${roomId}:${message._id ?? "unknown"}`,
    });

    const textWithId = `${bodyText}\n[rocketchat message id: ${message._id ?? "unknown"} room: ${roomId}]`;
    const timestamp = message.ts?.$date;
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Rocket.Chat",
      from: fromLabel,
      timestamp: typeof timestamp === "number" ? timestamp : undefined,
      body: textWithId,
      chatType,
      sender: { name: senderName, id: senderId },
    });
    let combinedBody = body;
    if (historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatInboundEnvelope({
            channel: "Rocket.Chat",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.body}${
              entry.messageId ? ` [id:${entry.messageId} room:${roomId}]` : ""
            }`,
            chatType,
            senderLabel: entry.sender,
          }),
      });
    }

    const to = kind === "direct" ? `user:${senderId}` : `channel:${roomId}`;
    const mediaPayloadData = buildMediaPayload(mediaList);
    const inboundHistory =
      historyKey && historyLimit > 0
        ? (channelHistories.get(historyKey) ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }))
        : undefined;
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: bodyText,
      InboundHistory: inboundHistory,
      RawBody: bodyText,
      CommandBody: bodyText,
      From:
        kind === "direct"
          ? `rocketchat:${senderId}`
          : kind === "group"
            ? `rocketchat:group:${roomId}`
            : `rocketchat:channel:${roomId}`,
      To: to,
      SessionKey: sessionKey,
      ParentSessionKey: threadKeys.parentSessionKey,
      AccountId: route.accountId,
      ChatType: chatType,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "direct" ? roomDisplay || roomLabel : undefined,
      GroupChannel: roomName ? `#${roomName}` : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "rocketchat" as const,
      Surface: "rocketchat" as const,
      MessageSid: message._id ?? undefined,
      MessageSids: allMessageIds.length > 1 ? allMessageIds : undefined,
      MessageSidFirst: allMessageIds.length > 1 ? allMessageIds[0] : undefined,
      MessageSidLast:
        allMessageIds.length > 1 ? allMessageIds[allMessageIds.length - 1] : undefined,
      ReplyToId: threadId,
      MessageThreadId: threadId,
      Timestamp: typeof timestamp === "number" ? timestamp : undefined,
      WasMentioned: kind !== "direct" ? effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "rocketchat" as const,
      OriginatingTo: to,
      ...mediaPayloadData,
    });

    if (kind === "direct") {
      const sessionCfg = cfg.session;
      const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId,
      });
      await core.channel.session.updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: {
          channel: "rocketchat",
          to,
          accountId: route.accountId,
        },
      });
    }

    const previewLine = bodyText.slice(0, 200).replace(/\n/g, "\\n");
    logVerboseMessage(
      `rocketchat inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`,
    );

    const textLimit = core.channel.text.resolveTextChunkLimit(
      cfg,
      "rocketchat",
      account.accountId,
      {
        fallbackLimit: account.textChunkLimit ?? 4000,
      },
    );
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "rocketchat",
      accountId: account.accountId,
    });

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "rocketchat",
      accountId: account.accountId,
    });

    const typingCallbacks = createTypingCallbacks({
      start: async () => {
        // Rocket.Chat typing via REST is not directly supported;
        // the WebSocket subscription handles it transparently.
      },
      onStartError: (err) => {
        logTypingFailure({
          log: (msg) => logger.debug?.(msg),
          channel: "rocketchat",
          target: roomId,
          error: err,
        });
      },
    });
    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...prefixOptions,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload: ReplyPayload) => {
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const replyText = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
          if (mediaUrls.length === 0) {
            const chunkMode = core.channel.text.resolveChunkMode(
              cfg,
              "rocketchat",
              account.accountId,
            );
            const chunks = core.channel.text.chunkMarkdownTextWithMode(
              replyText,
              textLimit,
              chunkMode,
            );
            for (const chunk of chunks.length > 0 ? chunks : [replyText]) {
              if (!chunk) {
                continue;
              }
              await sendMessageRocketchat(to, chunk, {
                accountId: account.accountId,
                replyToId: threadId,
              });
            }
          } else {
            let first = true;
            for (const url of mediaUrls) {
              const caption = first ? replyText : "";
              first = false;
              await sendMessageRocketchat(to, caption, {
                accountId: account.accountId,
                mediaUrl: url,
                replyToId: threadId,
              });
            }
          }
          runtime.log?.(`delivered reply to ${to}`);
        },
        onError: (err, info) => {
          runtime.error?.(`rocketchat ${info.kind} reply failed: ${String(err)}`);
        },
        onReplyStart: typingCallbacks.onReplyStart,
      });

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
    markDispatchIdle();
    if (historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
      });
    }
  };

  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "rocketchat",
  });
  const debouncer = core.channel.debounce.createInboundDebouncer<{
    message: RocketchatMessage;
    roomId: string;
  }>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const rid = entry.message.rid ?? entry.roomId;
      if (!rid) {
        return null;
      }
      const threadId = entry.message.tmid?.trim();
      const threadKey = threadId ? `thread:${threadId}` : "channel";
      return `rocketchat:${account.accountId}:${rid}:${threadKey}`;
    },
    shouldDebounce: (entry) => {
      const hasFiles = (entry.message.files?.length ?? (entry.message.file ? 1 : 0)) > 0;
      if (hasFiles) {
        return false;
      }
      const text = entry.message.msg?.trim() ?? "";
      if (!text) {
        return false;
      }
      return !core.channel.text.hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleMessage(last.message, last.roomId);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.message.msg?.trim() ?? "")
        .filter(Boolean)
        .join("\n");
      const mergedMessage: RocketchatMessage = {
        ...last.message,
        msg: combinedText,
        files: [],
        file: undefined,
      };
      const ids = entries.map((entry) => entry.message._id).filter(Boolean);
      await handleMessage(mergedMessage, last.roomId, ids.length > 0 ? ids : undefined);
    },
    onError: (err) => {
      runtime.error?.(`rocketchat debounce flush failed: ${String(err)}`);
    },
  });

  const wsUrl = buildWsUrl(baseUrl);
  let idCounter = 1;
  const connectOnce = createRocketchatConnectOnce({
    wsUrl,
    authToken,
    userId: rcUserId,
    abortSignal: opts.abortSignal,
    statusSink: opts.statusSink,
    runtime,
    webSocketFactory: opts.webSocketFactory,
    nextId: () => String(idCounter++),
    roomIds,
    onMessage: async (message, roomId) => {
      await debouncer.enqueue({ message, roomId });
    },
  });

  await runWithReconnect(connectOnce, {
    abortSignal: opts.abortSignal,
    jitterRatio: 0.2,
    onError: (err) => {
      runtime.error?.(`rocketchat connection failed: ${String(err)}`);
      opts.statusSink?.({ lastError: String(err), connected: false });
    },
    onReconnect: (delayMs) => {
      runtime.log?.(`rocketchat reconnecting in ${Math.round(delayMs / 1000)}s`);
    },
  });
}
