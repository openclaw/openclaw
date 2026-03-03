import {
  createNormalizedOutboundDeliverer,
  createReplyPrefixOptions,
  createScopedPairingAccess,
  formatTextWithAttachmentLinks,
  logInboundDrop,
  readStoreAllowFromForDmPolicy,
  resolveControlCommandGate,
  resolveEffectiveAllowFromLists,
  resolveOutboundMediaUrls,
  type OpenClawConfig,
  type OutboundReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import {
  normalizeInstagramAllowlist,
  normalizeInstagramUsername,
  resolveInstagramAllowlistMatch,
  resolveInstagramGroupAccessGate,
  resolveInstagramGroupMatch,
  resolveInstagramGroupSenderAllowed,
  resolveInstagramMentionGate,
  resolveInstagramRequireMention,
} from "./normalize.js";
import { getInstagramRuntime } from "./runtime.js";
import { sendMessageInstagram } from "./client.js";
import type { CoreConfig, InstagramInboundMessage, ResolvedInstagramAccount } from "./types.js";

const CHANNEL_ID = "instagram" as const;

function resolveInstagramEffectiveAllowlists(params: {
  configAllowFrom: string[];
  configGroupAllowFrom: string[];
  storeAllowList: string[];
  dmPolicy: string;
}) {
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: params.configAllowFrom,
    groupAllowFrom: params.configGroupAllowFrom,
    storeAllowFrom: params.storeAllowList,
    dmPolicy: params.dmPolicy,
    groupAllowFromFallbackToAllowFrom: false,
  });
  return { effectiveAllowFrom, effectiveGroupAllowFrom };
}

async function deliverInstagramReply(params: {
  payload: OutboundReplyPayload;
  target: string;
  account: ResolvedInstagramAccount;
  sendReply?: (target: string, text: string) => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  const combined = formatTextWithAttachmentLinks(
    params.payload.text,
    resolveOutboundMediaUrls(params.payload),
  );
  if (!combined) {
    return;
  }
  if (params.sendReply) {
    await params.sendReply(params.target, combined);
  } else {
    await sendMessageInstagram(params.target, combined, {
      account: params.account,
    });
  }
  params.statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handleInstagramInbound(params: {
  message: InstagramInboundMessage;
  account: ResolvedInstagramAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  sendReply?: (target: string, text: string) => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  const config = params.config;
  const account = params.account;
  const runtime = params.runtime;
  const core = getInstagramRuntime();
  const message = params.message;
  const rawBody = message.text.trim();
  if (!rawBody) {
    return;
  }

  const storeAllowList = await readStoreAllowFromForDmPolicy({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    cfg: config as OpenClawConfig,
  });
  const pairing = createScopedPairingAccess({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    env: process.env,
  });
  const configAllowFrom = normalizeInstagramAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeInstagramAllowlist(account.config.groupAllowFrom);
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const groupPolicy = account.config.groupPolicy ?? "disabled";
  const groupMatch = resolveInstagramGroupMatch({
    threadId: message.threadId,
    groups: account.config.groups,
  });

  if (message.isGroup) {
    const groupAccess = resolveInstagramGroupAccessGate({ groupPolicy, groupMatch });
    if (!groupAccess.allowed) {
      runtime.log?.(`instagram: drop thread ${message.threadId} (${groupAccess.reason})`);
      return;
    }
  }

  const directGroupAllowFrom = normalizeInstagramAllowlist(groupMatch.groupConfig?.allowFrom);
  const wildcardGroupAllowFrom = normalizeInstagramAllowlist(groupMatch.wildcardConfig?.allowFrom);
  const groupAllowFrom =
    directGroupAllowFrom.length > 0 ? directGroupAllowFrom : wildcardGroupAllowFrom;

  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveInstagramEffectiveAllowlists({
    configAllowFrom,
    configGroupAllowFrom,
    storeAllowList,
    dmPolicy,
  });

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = resolveInstagramAllowlistMatch({
    allowFrom: message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
    message,
  }).allowed;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: (message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom).length > 0,
        allowed: senderAllowedForCommands,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  const senderId = normalizeInstagramUsername(message.senderUsername);
  if (message.isGroup) {
    const senderAllowed = resolveInstagramGroupSenderAllowed({
      groupPolicy,
      message,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: groupAllowFrom,
    });
    if (!senderAllowed) {
      runtime.log?.(`instagram: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (dmPolicy === "disabled") {
      runtime.log?.(`instagram: drop DM sender=${senderId} (dmPolicy=disabled)`);
      return;
    }
    if (dmPolicy !== "open") {
      const dmAllowed = resolveInstagramAllowlistMatch({
        allowFrom: effectiveAllowFrom,
        message,
      }).allowed;
      if (!dmAllowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await pairing.upsertPairingRequest({
            id: senderId,
            meta: { name: senderId || undefined },
          });
          if (created) {
            try {
              const reply = core.channel.pairing.buildPairingReply({
                channel: CHANNEL_ID,
                idLine: `Your Instagram id: ${senderId}`,
                code,
              });
              await deliverInstagramReply({
                payload: { text: reply },
                target: message.threadId,
                account,
                sendReply: params.sendReply,
                statusSink: params.statusSink,
              });
            } catch (error) {
              runtime.error?.(`instagram: pairing reply failed for ${senderId}: ${String(error)}`);
            }
          }
        }
        runtime.log?.(`instagram: drop DM sender ${senderId} (dmPolicy=${dmPolicy})`);
        return;
      }
    }
  }

  if (message.isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (line) => runtime.log?.(line),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const explicitMentionRegex = account.sessionUsername
    ? new RegExp(`(^|\\s)@?${account.sessionUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b|\\s|:|,)`, "i")
    : null;
  const wasMentioned =
    core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) ||
    (explicitMentionRegex ? explicitMentionRegex.test(rawBody) : false);
  const requireMention = message.isGroup
    ? resolveInstagramRequireMention({
        groupConfig: groupMatch.groupConfig,
        wildcardConfig: groupMatch.wildcardConfig,
      })
    : false;
  const mentionGate = resolveInstagramMentionGate({
    isGroup: message.isGroup,
    requireMention,
    wasMentioned,
    hasControlCommand,
    allowTextCommands,
    commandAuthorized,
  });
  if (mentionGate.shouldSkip) {
    runtime.log?.(`instagram: drop thread ${message.threadId} (${mentionGate.reason})`);
    return;
  }

  const peerId = message.isGroup ? message.threadId : senderId;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const fromLabel = message.isGroup ? message.title || message.threadId : `@${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Instagram",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });
  const groupSystemPrompt = groupMatch.groupConfig?.systemPrompt?.trim() || undefined;
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: message.isGroup ? `instagram:thread:${message.threadId}` : `instagram:${senderId}`,
    To: `instagram:thread:${message.threadId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderId,
    SenderId: senderId,
    GroupSubject: message.isGroup ? fromLabel : undefined,
    GroupSystemPrompt: message.isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: message.isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `instagram:thread:${message.threadId}`,
    CommandAuthorized: commandAuthorized,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (error) => {
      runtime.error?.(`instagram: failed updating session meta: ${String(error)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });
  const deliverReply = createNormalizedOutboundDeliverer(async (payload) => {
    await deliverInstagramReply({
      payload,
      target: message.threadId,
      account,
      sendReply: params.sendReply,
      statusSink: params.statusSink,
    });
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config as OpenClawConfig,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: deliverReply,
      onError: (error, info) => {
        runtime.error?.(`instagram ${info.kind} reply failed: ${String(error)}`);
      },
    },
    replyOptions: {
      skillFilter: groupMatch.groupConfig?.skills,
      onModelSelected,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
