import {
  MAX_IMAGE_BYTES,
  fetchRemoteMedia,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  createChannelPairingController,
  deliverFormattedTextWithAttachments,
  dispatchInboundReplyWithBase,
  logInboundDrop,
  logTypingFailure,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithCommandGate,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  type OutboundReplyPayload,
  type OpenClawConfig,
  type RuntimeEnv,
} from "../runtime-api.js";
import type { ResolvedRoamAccount } from "./accounts.js";
import {
  normalizeRoamAllowlist,
  resolveRoamAllowlistMatch,
  resolveRoamGroupAllow,
  resolveRoamGroupMatch,
  resolveRoamMentionGate,
  resolveRoamRequireMention,
} from "./policy.js";
import { getRoamRuntime } from "./runtime.js";
import { sendMessageRoam, sendTypingRoam } from "./send.js";
import type { CoreConfig, RoamInboundMessage } from "./types.js";

const CHANNEL_ID = "roam" as const;

/** Strip Roam mention syntax for the bot's own user ID. */
function stripBotMention(text: string, botId?: string): string {
  if (botId) {
    // Only strip the bot's own mention, preserve other user mentions
    const escaped = botId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`<!?@${escaped}>`, "gi"), "").trim();
  }
  // Fallback: strip all <@xxx> mentions when bot ID is unknown
  return text.replace(/<!?@[0-9a-f-]+>/gi, "").trim();
}

/** Check if the bot was mentioned in the message. */
function wasBotMentioned(text: string, botId?: string): boolean {
  if (botId) {
    const escaped = botId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`<!?@${escaped}>`, "i").test(text);
  }
  // Without a known botId, we cannot reliably detect bot mentions.
  // Return false to avoid waking the bot on arbitrary user mentions.
  return false;
}

/** Download media URLs to local files for the media understanding pipeline. */
async function downloadMediaToLocal(
  mediaUrls: string[],
  mediaTypes: string[],
): Promise<{ paths: string[]; urls: string[]; types: string[] }> {
  const paths: string[] = [];
  const urls: string[] = [];
  const types: string[] = [];
  for (let i = 0; i < mediaUrls.length; i++) {
    const url = mediaUrls[i];
    const mime = mediaTypes[i];
    try {
      const fetched = await fetchRemoteMedia({ url, maxBytes: MAX_IMAGE_BYTES });
      const saved = await saveMediaBuffer(fetched.buffer, mime ?? fetched.contentType, "inbound");
      paths.push(saved.path);
      urls.push(url);
      types.push(mime ?? fetched.contentType ?? "application/octet-stream");
    } catch {
      // Skip failed downloads; don't block message processing.
    }
  }
  return { paths, urls, types };
}

async function deliverRoamReply(params: {
  payload: OutboundReplyPayload;
  chatId: string;
  accountId: string;
  threadKey?: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, chatId, accountId, threadKey, statusSink } = params;
  await deliverFormattedTextWithAttachments({
    payload,
    send: async ({ text }) => {
      await sendMessageRoam(chatId, text, { accountId, threadKey });
      statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

export async function handleRoamInbound(params: {
  message: RoamInboundMessage;
  account: ResolvedRoamAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  /** Bot's chat address ID for self-message filtering. */
  botId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, botId, statusSink } = params;
  const core = getRoamRuntime();

  // Drop messages sent by the bot itself to prevent infinite loops.
  if (botId && message.senderId === botId) {
    runtime.log?.(`roam: drop self-message from bot ${botId}`);
    return;
  }
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  const isGroup = message.chatType === "group";
  const senderId = message.senderId;
  const senderName = message.senderName;
  const chatId = message.chatId;

  statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config as OpenClawConfig);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent:
        ((config.channels as Record<string, unknown> | undefined)?.roam ?? undefined) !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "roam",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message) => runtime.log?.(message),
  });

  const configAllowFrom = normalizeRoamAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeRoamAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const storeAllowList = normalizeRoamAllowlist(storeAllowFrom);

  const groupMatch = resolveRoamGroupMatch({
    groups: account.config.groups,
    chatId,
  });
  const groupConfig = groupMatch.groupConfig;
  if (isGroup && !groupMatch.allowed) {
    runtime.log?.(`roam: drop chat ${chatId} (not allowlisted)`);
    return;
  }
  if (groupConfig?.enabled === false) {
    runtime.log?.(`roam: drop chat ${chatId} (disabled)`);
    return;
  }

  const groupAllowFrom = normalizeRoamAllowlist(groupConfig?.allowFrom);

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups =
    (config.commands as Record<string, unknown> | undefined)?.useAccessGroups !== false;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom: storeAllowList,
    isSenderAllowed: (allowFrom) => resolveRoamAllowlistMatch({ allowFrom, senderId }).allowed,
    command: {
      useAccessGroups,
      allowTextCommands,
      hasControlCommand,
    },
  });
  const commandAuthorized = access.commandAuthorized;
  const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;

  if (isGroup) {
    if (access.decision !== "allow") {
      runtime.log?.(`roam: drop group sender ${senderId} (reason=${access.reason})`);
      return;
    }
    const groupAllow = resolveRoamGroupAllow({
      groupPolicy,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: groupAllowFrom,
      senderId,
    });
    if (!groupAllow.allowed) {
      runtime.log?.(`roam: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (access.decision !== "allow") {
      if (access.decision === "pairing") {
        await pairing.issueChallenge({
          senderId,
          senderIdLine: `Your Roam user id: ${senderId}`,
          meta: { name: senderName || undefined },
          sendPairingReply: async (text) => {
            await sendMessageRoam(chatId, text, { accountId: account.accountId });
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          onReplyError: (err) => {
            runtime.error?.(`roam: pairing reply failed for ${senderId}: ${String(err)}`);
          },
        });
      }
      runtime.log?.(`roam: drop DM sender ${senderId} (reason=${access.reason})`);
      return;
    }
  }

  if (access.shouldBlockControlCommand) {
    logInboundDrop({
      log: (message) => runtime.log?.(message),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  // Strip bot mentions from body before processing
  const bodyForAgent = stripBotMention(rawBody, botId);

  // If the message was only a bot mention with no actual content, drop it.
  if (!bodyForAgent && !hasControlCommand) {
    runtime.log?.(`roam: drop mention-only message from ${senderId}`);
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = mentionRegexes.length
    ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
    : wasBotMentioned(rawBody, botId);
  const shouldRequireMention = isGroup
    ? resolveRoamRequireMention({
        groupConfig,
        wildcardConfig: groupMatch.wildcardConfig,
      })
    : false;
  const mentionGate = resolveRoamMentionGate({
    isGroup,
    requireMention: shouldRequireMention,
    wasMentioned,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  });
  if (isGroup && mentionGate.shouldSkip) {
    runtime.log?.(`roam: drop chat ${chatId} (no mention)`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? chatId : senderId,
    },
  });

  const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(
    (config.session as Record<string, unknown> | undefined)?.store as string | undefined,
    { agentId: route.agentId },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Roam",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForAgent || rawBody,
  });

  const groupSystemPrompt = groupConfig?.systemPrompt?.trim() || undefined;

  // Use session key as threadKey for Roam threading (max 64 chars).
  // Roam does not support threads in DMs, so only set for groups.
  const threadKey = isGroup ? route.sessionKey?.slice(0, 64) : undefined;

  // Download media attachments to local files so the media understanding pipeline can process them.
  let mediaPaths: string[] | undefined;
  let mediaUrls: string[] | undefined;
  let mediaTypes: string[] | undefined;
  if (message.mediaUrls?.length) {
    const downloaded = await downloadMediaToLocal(message.mediaUrls, message.mediaTypes ?? []);
    if (downloaded.paths.length > 0) {
      mediaPaths = downloaded.paths;
      mediaUrls = downloaded.urls;
      mediaTypes = downloaded.types;
    }
  }

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent || rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `roam:group:${chatId}` : `roam:${senderId}`,
    To: `roam:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    GroupSubject: isGroup ? chatId : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `roam:${chatId}`,
    CommandAuthorized: commandAuthorized,
    MediaPaths: mediaPaths,
    MediaUrls: mediaUrls,
    MediaTypes: mediaTypes,
  });

  await dispatchInboundReplyWithBase({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    route,
    storePath,
    ctxPayload,
    core,
    deliver: async (payload) => {
      await deliverRoamReply({
        payload,
        chatId,
        accountId: account.accountId,
        threadKey,
        statusSink,
      });
    },
    onRecordError: (err) => {
      runtime.error?.(`roam: failed updating session meta: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`roam ${info.kind} reply failed: ${String(err)}`);
    },
    typing: {
      start: () => sendTypingRoam(chatId, { accountId: account.accountId }),
      onStartError: (err) => {
        logTypingFailure({
          log: (msg) => runtime.log?.(msg),
          channel: CHANNEL_ID,
          target: chatId,
          error: err,
        });
      },
    },
    replyOptions: {
      skillFilter: groupConfig?.skills,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
