import type {
  ChannelAccountSnapshot,
  ChatType,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import {
  buildAgentMediaPayload,
  DM_GROUP_ACCESS_REASON,
  createScopedPairingAccess,
  createReplyPrefixOptions,
  createTypingCallbacks,
  logInboundDrop,
  logTypingFailure,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  isDangerousNameMatchingEnabled,
  resolveControlCommandGate,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveChannelMediaMaxBytes,
  warnMissingProviderGroupPolicyFallbackOnce,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import { getMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostMe,
  fetchMattermostUser,
  normalizeMattermostBaseUrl,
  sendMattermostTyping,
  type MattermostChannel,
  type MattermostPost,
  type MattermostUser,
} from "./client.js";
import { isMattermostSenderAllowed, normalizeMattermostAllowList } from "./monitor-auth.js";
import {
  createDedupeCache,
  formatInboundFromLabel,
  resolveThreadSessionKeys,
} from "./monitor-helpers.js";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";
import {
  createMattermostConnectOnce,
  type MattermostEventPayload,
  type MattermostWebSocketFactory,
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";
import { sendMessageMattermost } from "./send.js";

export type MonitorMattermostOpts = {
  botToken?: string;
  baseUrl?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  webSocketFactory?: MattermostWebSocketFactory;
};

type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

type MattermostReaction = {
  user_id?: string;
  post_id?: string;
  emoji_name?: string;
  create_at?: number;
};
const RECENT_MATTERMOST_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MATTERMOST_MESSAGE_MAX = 2000;
const CHANNEL_CACHE_TTL_MS = 5 * 60_000;
const USER_CACHE_TTL_MS = 10 * 60_000;

const recentInboundMessages = createDedupeCache({
  ttlMs: RECENT_MATTERMOST_MESSAGE_TTL_MS,
  maxSize: RECENT_MATTERMOST_MESSAGE_MAX,
});

function resolveRuntime(opts: MonitorMattermostOpts): RuntimeEnv {
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

function isSystemPost(post: MattermostPost): boolean {
  const type = post.type?.trim();
  return Boolean(type);
}

function channelKind(channelType?: string | null): ChatType {
  if (!channelType) {
    return "channel";
  }
  const normalized = channelType.trim().toUpperCase();
  if (normalized === "D") {
    return "direct";
  }
  if (normalized === "G") {
    return "group";
  }
  return "channel";
}

function channelChatType(kind: ChatType): "direct" | "group" | "channel" {
  if (kind === "direct") {
    return "direct";
  }
  if (kind === "group") {
    return "group";
  }
  return "channel";
}

type MattermostMediaInfo = {
  path: string;
  contentType?: string;
  kind: MediaKind;
};

function buildMattermostAttachmentPlaceholder(mediaList: MattermostMediaInfo[]): string {
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

function buildMattermostWsUrl(baseUrl: string): string {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Mattermost baseUrl is required");
  }
  const wsBase = normalized.replace(/^http/i, "ws");
  return `${wsBase}/api/v4/websocket`;
}

export async function monitorMattermostProvider(opts: MonitorMattermostOpts = {}): Promise<void> {
  const core = getMattermostRuntime();
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveMattermostAccount({
    cfg,
    accountId: opts.accountId,
  });
  const pairing = createScopedPairingAccess({
    core,
    channel: "mattermost",
    accountId: account.accountId,
  });
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  const botToken = opts.botToken?.trim() || account.botToken?.trim();
  if (!botToken) {
    throw new Error(
      `Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`,
    );
  }
  const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`,
    );
  }

  const client = createMattermostClient({ baseUrl, botToken });
  const botUser = await fetchMattermostMe(client);
  const botUserId = botUser.id;
  const botUsername = botUser.username?.trim() || undefined;
  runtime.log?.(`mattermost connected as ${botUsername ? `@${botUsername}` : botUserId}`);

  const channelCache = new Map<string, { value: MattermostChannel | null; expiresAt: number }>();
  const userCache = new Map<string, { value: MattermostUser | null; expiresAt: number }>();
  const logger = core.logging.getChildLogger({ module: "mattermost" });
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
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.mattermost !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "mattermost",
    accountId: account.accountId,
    log: (message) => logVerboseMessage(message),
  });

  const resolveMattermostMedia = async (
    fileIds?: string[] | null,
  ): Promise<MattermostMediaInfo[]> => {
    const ids = (fileIds ?? []).map((id) => id?.trim()).filter(Boolean);
    if (ids.length === 0) {
      return [];
    }
    const out: MattermostMediaInfo[] = [];
    for (const fileId of ids) {
      try {
        const fetched = await core.channel.media.fetchRemoteMedia({
          url: `${client.apiBaseUrl}/files/${fileId}`,
          requestInit: {
            headers: {
              Authorization: `Bearer ${client.token}`,
            },
          },
          filePathHint: fileId,
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
      } catch (err) {
        logger.debug?.(`mattermost: failed to download file ${fileId}: ${String(err)}`);
      }
    }
    return out;
  };

  const sendTypingIndicator = async (channelId: string, parentId?: string) => {
    await sendMattermostTyping(client, { channelId, parentId });
  };

  const resolveChannelInfo = async (channelId: string): Promise<MattermostChannel | null> => {
    const cached = channelCache.get(channelId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const info = await fetchMattermostChannel(client, channelId);
      channelCache.set(channelId, {
        value: info,
        expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS,
      });
      return info;
    } catch (err) {
      logger.debug?.(`mattermost: channel lookup failed: ${String(err)}`);
      channelCache.set(channelId, {
        value: null,
        expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS,
      });
      return null;
    }
  };

  const resolveUserInfo = async (userId: string): Promise<MattermostUser | null> => {
    const cached = userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const info = await fetchMattermostUser(client, userId);
      userCache.set(userId, {
        value: info,
        expiresAt: Date.now() + USER_CACHE_TTL_MS,
      });
      return info;
    } catch (err) {
      logger.debug?.(`mattermost: user lookup failed: ${String(err)}`);
      userCache.set(userId, {
        value: null,
        expiresAt: Date.now() + USER_CACHE_TTL_MS,
      });
      return null;
    }
  };

  const handlePost = async (
    post: MattermostPost,
    payload: MattermostEventPayload,
    messageIds?: string[],
  ) => {
    const channelId = post.channel_id ?? payload.data?.channel_id ?? payload.broadcast?.channel_id;
    if (!channelId) {
      return;
    }

    const allMessageIds = messageIds?.length ? messageIds : post.id ? [post.id] : [];
    if (allMessageIds.length === 0) {
      return;
    }
    const dedupeEntries = allMessageIds.map((id) =>
      recentInboundMessages.check(`${account.accountId}:${id}`),
    );
    if (dedupeEntries.length > 0 && dedupeEntries.every(Boolean)) {
      return;
    }

    const senderId = post.user_id ?? payload.broadcast?.user_id;
    if (!senderId) {
      return;
    }
    if (senderId === botUserId) {
      return;
    }
    if (isSystemPost(post)) {
      return;
    }

    const channelInfo = await resolveChannelInfo(channelId);
    const channelType = payload.data?.channel_type ?? channelInfo?.type ?? undefined;
    const kind = channelKind(channelType);
    const chatType = channelChatType(kind);

    const senderName =
      payload.data?.sender_name?.trim() ||
      (await resolveUserInfo(senderId))?.username?.trim() ||
      senderId;
    const rawText = post.message?.trim() || "";
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const normalizedAllowFrom = normalizeMattermostAllowList(account.config.allowFrom ?? []);
    const normalizedGroupAllowFrom = normalizeMattermostAllowList(
      account.config.groupAllowFrom ?? [],
    );
    const storeAllowFrom = normalizeMattermostAllowList(
      await readStoreAllowFromForDmPolicy({
        provider: "mattermost",
        accountId: account.accountId,
        dmPolicy,
        readStore: pairing.readStoreForDmPolicy,
      }),
    );
    const accessDecision = resolveDmGroupAccessWithLists({
      isGroup: kind !== "direct",
      dmPolicy,
      groupPolicy,
      allowFrom: normalizedAllowFrom,
      groupAllowFrom: normalizedGroupAllowFrom,
      storeAllowFrom,
      isSenderAllowed: (allowFrom) =>
        isMattermostSenderAllowed({
          senderId,
          senderName,
          allowFrom,
          allowNameMatching,
        }),
    });
    const effectiveAllowFrom = accessDecision.effectiveAllowFrom;
    const effectiveGroupAllowFrom = accessDecision.effectiveGroupAllowFrom;
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(rawText, cfg);
    const isControlCommand = allowTextCommands && hasControlCommand;
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const commandDmAllowFrom = kind === "direct" ? effectiveAllowFrom : normalizedAllowFrom;
    const senderAllowedForCommands = isMattermostSenderAllowed({
      senderId,
      senderName,
      allowFrom: commandDmAllowFrom,
      allowNameMatching,
    });
    const groupAllowedForCommands = isMattermostSenderAllowed({
      senderId,
      senderName,
      allowFrom: effectiveGroupAllowFrom,
      allowNameMatching,
    });
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: commandDmAllowFrom.length > 0, allowed: senderAllowedForCommands },
        {
          configured: effectiveGroupAllowFrom.length > 0,
          allowed: groupAllowedForCommands,
        },
      ],
      allowTextCommands,
      hasControlCommand,
    });
    const commandAuthorized = commandGate.commandAuthorized;

    if (accessDecision.decision !== "allow") {
      if (kind === "direct") {
        if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
          logVerboseMessage(`mattermost: drop dm (dmPolicy=disabled sender=${senderId})`);
          return;
        }
        if (accessDecision.decision === "pairing") {
          const { code, created } = await pairing.upsertPairingRequest({
            id: senderId,
            meta: { name: senderName },
          });
          logVerboseMessage(`mattermost: pairing request sender=${senderId} created=${created}`);
          if (created) {
            try {
              await sendMessageMattermost(
                `user:${senderId}`,
                core.channel.pairing.buildPairingReply({
                  channel: "mattermost",
                  idLine: `Your Mattermost user id: ${senderId}`,
                  code,
                }),
                { accountId: account.accountId },
              );
              opts.statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerboseMessage(`mattermost: pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
          return;
        }
        logVerboseMessage(`mattermost: drop dm sender=${senderId} (dmPolicy=${dmPolicy})`);
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
        logVerboseMessage("mattermost: drop group message (groupPolicy=disabled)");
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
        logVerboseMessage("mattermost: drop group message (no group allowlist)");
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
        logVerboseMessage(`mattermost: drop group sender=${senderId} (not in groupAllowFrom)`);
        return;
      }
      logVerboseMessage(
        `mattermost: drop group message (groupPolicy=${groupPolicy} reason=${accessDecision.reason})`,
      );
      return;
    }

    if (kind !== "direct" && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerboseMessage,
        channel: "mattermost",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    const teamId = payload.data?.team_id ?? channelInfo?.team_id ?? undefined;
    const channelName = payload.data?.channel_name ?? channelInfo?.name ?? "";
    const channelDisplay =
      payload.data?.channel_display_name ?? channelInfo?.display_name ?? channelName;
    const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
      teamId,
      peer: {
        kind,
        id: kind === "direct" ? senderId : channelId,
      },
    });

    const baseSessionKey = route.sessionKey;
    const threadRootId = post.root_id?.trim() || undefined;
    const threadKeys = resolveThreadSessionKeys({
      baseSessionKey,
      threadId: threadRootId,
      parentSessionKey: threadRootId ? baseSessionKey : undefined,
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
      (post.file_ids?.length
        ? `[Mattermost ${post.file_ids.length === 1 ? "file" : "files"}]`
        : "");
    const pendingSender = senderName;
    const recordPendingHistory = () => {
      const trimmed = pendingBody.trim();
      recordPendingHistoryEntryIfEnabled({
        historyMap: channelHistories,
        limit: historyLimit,
        historyKey: historyKey ?? "",
        entry:
          historyKey && trimmed
            ? {
                sender: pendingSender,
                body: trimmed,
                timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
                messageId: post.id ?? undefined,
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
        channel: "mattermost",
        accountId: account.accountId,
        groupId: channelId,
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
    const mediaList = await resolveMattermostMedia(post.file_ids);
    const mediaPlaceholder = buildMattermostAttachmentPlaceholder(mediaList);
    const bodySource = oncharTriggered ? oncharResult.stripped : rawText;
    const baseText = [bodySource, mediaPlaceholder].filter(Boolean).join("\n").trim();
    const bodyText = normalizeMention(baseText, botUsername);
    if (!bodyText) {
      return;
    }

    core.channel.activity.record({
      channel: "mattermost",
      accountId: account.accountId,
      direction: "inbound",
    });

    const fromLabel = formatInboundFromLabel({
      isGroup: kind !== "direct",
      groupLabel: channelDisplay || roomLabel,
      groupId: channelId,
      groupFallback: roomLabel || "Channel",
      directLabel: senderName,
      directId: senderId,
    });

    const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel =
      kind === "direct"
        ? `Mattermost DM from ${senderName}`
        : `Mattermost message in ${roomLabel} from ${senderName}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `mattermost:message:${channelId}:${post.id ?? "unknown"}`,
    });

    const textWithId = `${bodyText}\n[mattermost message id: ${post.id ?? "unknown"} channel: ${channelId}]`;
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Mattermost",
      from: fromLabel,
      timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
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
            channel: "Mattermost",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.body}${
              entry.messageId ? ` [id:${entry.messageId} channel:${channelId}]` : ""
            }`,
            chatType,
            senderLabel: entry.sender,
          }),
      });
    }

    const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
    const mediaPayload = buildAgentMediaPayload(mediaList);
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
          ? `mattermost:${senderId}`
          : kind === "group"
            ? `mattermost:group:${channelId}`
            : `mattermost:channel:${channelId}`,
      To: to,
      SessionKey: sessionKey,
      ParentSessionKey: threadKeys.parentSessionKey,
      AccountId: route.accountId,
      ChatType: chatType,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
      GroupChannel: channelName ? `#${channelName}` : undefined,
      GroupSpace: teamId,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "mattermost" as const,
      Surface: "mattermost" as const,
      MessageSid: post.id ?? undefined,
      MessageSids: allMessageIds.length > 1 ? allMessageIds : undefined,
      MessageSidFirst: allMessageIds.length > 1 ? allMessageIds[0] : undefined,
      MessageSidLast:
        allMessageIds.length > 1 ? allMessageIds[allMessageIds.length - 1] : undefined,
      ReplyToId: threadRootId,
      MessageThreadId: threadRootId,
      Timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
      WasMentioned: kind !== "direct" ? effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "mattermost" as const,
      OriginatingTo: to,
      ...mediaPayload,
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
          channel: "mattermost",
          to,
          accountId: route.accountId,
        },
      });
    }

    const previewLine = bodyText.slice(0, 200).replace(/\n/g, "\\n");
    logVerboseMessage(
      `mattermost inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`,
    );

    const textLimit = core.channel.text.resolveTextChunkLimit(
      cfg,
      "mattermost",
      account.accountId,
      {
        fallbackLimit: account.textChunkLimit ?? 4000,
      },
    );
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
    });

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "mattermost",
      accountId: account.accountId,
    });

    const typingCallbacks = createTypingCallbacks({
      start: () => sendTypingIndicator(channelId, threadRootId),
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => logger.debug?.(message),
          channel: "mattermost",
          target: channelId,
          error: err,
        });
      },
    });
    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...prefixOptions,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        typingCallbacks,
        deliver: async (payload: ReplyPayload) => {
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
          if (mediaUrls.length === 0) {
            const chunkMode = core.channel.text.resolveChunkMode(
              cfg,
              "mattermost",
              account.accountId,
            );
            const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
            for (const chunk of chunks.length > 0 ? chunks : [text]) {
              if (!chunk) {
                continue;
              }
              await sendMessageMattermost(to, chunk, {
                accountId: account.accountId,
                replyToId: threadRootId,
              });
            }
          } else {
            let first = true;
            for (const mediaUrl of mediaUrls) {
              const caption = first ? text : "";
              first = false;
              await sendMessageMattermost(to, caption, {
                accountId: account.accountId,
                mediaUrl,
                replyToId: threadRootId,
              });
            }
          }
          runtime.log?.(`delivered reply to ${to}`);
        },
        onError: (err, info) => {
          runtime.error?.(`mattermost ${info.kind} reply failed: ${String(err)}`);
        },
      });

    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        markDispatchIdle();
      },
      run: () =>
        core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            disableBlockStreaming:
              typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
            onModelSelected,
          },
        }),
    });
    if (historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
      });
    }
  };

  const handleReactionEvent = async (payload: MattermostEventPayload) => {
    const reactionData = payload.data?.reaction;
    if (!reactionData) {
      return;
    }
    let reaction: MattermostReaction | null = null;
    if (typeof reactionData === "string") {
      try {
        reaction = JSON.parse(reactionData) as MattermostReaction;
      } catch {
        return;
      }
    } else if (typeof reactionData === "object") {
      reaction = reactionData as MattermostReaction;
    }
    if (!reaction) {
      return;
    }

    const userId = reaction.user_id?.trim();
    const postId = reaction.post_id?.trim();
    const emojiName = reaction.emoji_name?.trim();
    if (!userId || !postId || !emojiName) {
      return;
    }

    // Skip reactions from the bot itself
    if (userId === botUserId) {
      return;
    }

    const isRemoved = payload.event === "reaction_removed";
    const action = isRemoved ? "removed" : "added";

    const senderInfo = await resolveUserInfo(userId);
    const senderName = senderInfo?.username?.trim() || userId;

    // Resolve the channel from broadcast or post to route to the correct agent session
    const channelId = payload.broadcast?.channel_id;
    if (!channelId) {
      // Without a channel id we cannot verify DM/group policies — drop to be safe
      logVerboseMessage(
        `mattermost: drop reaction (no channel_id in broadcast, cannot enforce policy)`,
      );
      return;
    }
    const channelInfo = await resolveChannelInfo(channelId);
    if (!channelInfo?.type) {
      // Cannot determine channel type — drop to avoid policy bypass
      logVerboseMessage(`mattermost: drop reaction (cannot resolve channel type for ${channelId})`);
      return;
    }
    const kind = channelKind(channelInfo.type);

    // Enforce DM/group policy and allowlist checks (same as normal messages)
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const storeAllowFrom = normalizeMattermostAllowList(
      await readStoreAllowFromForDmPolicy({
        provider: "mattermost",
        accountId: account.accountId,
        dmPolicy,
        readStore: pairing.readStoreForDmPolicy,
      }),
    );
    const reactionAccess = resolveDmGroupAccessWithLists({
      isGroup: kind !== "direct",
      dmPolicy,
      groupPolicy,
      allowFrom: normalizeMattermostAllowList(account.config.allowFrom ?? []),
      groupAllowFrom: normalizeMattermostAllowList(account.config.groupAllowFrom ?? []),
      storeAllowFrom,
      isSenderAllowed: (allowFrom) =>
        isMattermostSenderAllowed({
          senderId: userId,
          senderName,
          allowFrom,
          allowNameMatching,
        }),
    });
    if (reactionAccess.decision !== "allow") {
      if (kind === "direct") {
        logVerboseMessage(
          `mattermost: drop reaction (dmPolicy=${dmPolicy} sender=${userId} reason=${reactionAccess.reason})`,
        );
      } else {
        logVerboseMessage(
          `mattermost: drop reaction (groupPolicy=${groupPolicy} sender=${userId} reason=${reactionAccess.reason} channel=${channelId})`,
        );
      }
      return;
    }

    const teamId = channelInfo?.team_id ?? undefined;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "mattermost",
      accountId: account.accountId,
      teamId,
      peer: {
        kind,
        id: kind === "direct" ? userId : channelId,
      },
    });
    const sessionKey = route.sessionKey;

    const eventText = `Mattermost reaction ${action}: :${emojiName}: by @${senderName} on post ${postId} in channel ${channelId}`;

    core.system.enqueueSystemEvent(eventText, {
      sessionKey,
      contextKey: `mattermost:reaction:${postId}:${emojiName}:${userId}:${action}`,
    });

    logVerboseMessage(
      `mattermost reaction: ${action} :${emojiName}: by ${senderName} on ${postId}`,
    );
  };

  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "mattermost",
  });
  const debouncer = core.channel.debounce.createInboundDebouncer<{
    post: MattermostPost;
    payload: MattermostEventPayload;
  }>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const channelId =
        entry.post.channel_id ??
        entry.payload.data?.channel_id ??
        entry.payload.broadcast?.channel_id;
      if (!channelId) {
        return null;
      }
      const threadId = entry.post.root_id?.trim();
      const threadKey = threadId ? `thread:${threadId}` : "channel";
      return `mattermost:${account.accountId}:${channelId}:${threadKey}`;
    },
    shouldDebounce: (entry) => {
      if (entry.post.file_ids && entry.post.file_ids.length > 0) {
        return false;
      }
      const text = entry.post.message?.trim() ?? "";
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
        await handlePost(last.post, last.payload);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.post.message?.trim() ?? "")
        .filter(Boolean)
        .join("\n");
      const mergedPost: MattermostPost = {
        ...last.post,
        message: combinedText,
        file_ids: [],
      };
      const ids = entries.map((entry) => entry.post.id).filter(Boolean);
      await handlePost(mergedPost, last.payload, ids.length > 0 ? ids : undefined);
    },
    onError: (err) => {
      runtime.error?.(`mattermost debounce flush failed: ${String(err)}`);
    },
  });

  const wsUrl = buildMattermostWsUrl(baseUrl);
  let seq = 1;
  const connectOnce = createMattermostConnectOnce({
    wsUrl,
    botToken,
    abortSignal: opts.abortSignal,
    statusSink: opts.statusSink,
    runtime,
    webSocketFactory: opts.webSocketFactory,
    nextSeq: () => seq++,
    onPosted: async (post, payload) => {
      await debouncer.enqueue({ post, payload });
    },
    onReaction: async (payload) => {
      await handleReactionEvent(payload);
    },
  });

  await runWithReconnect(connectOnce, {
    abortSignal: opts.abortSignal,
    jitterRatio: 0.2,
    onError: (err) => {
      runtime.error?.(`mattermost connection failed: ${String(err)}`);
      opts.statusSink?.({ lastError: String(err), connected: false });
    },
    onReconnect: (delayMs) => {
      runtime.log?.(`mattermost reconnecting in ${Math.round(delayMs / 1000)}s`);
    },
  });
}
