import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  buildMediaPayload,
  logInboundDrop,
  recordInboundSession,
  resolveControlCommandGate,
} from "openclaw/plugin-sdk/channel-runtime";
import {
  createNormalizedOutboundDeliverer,
  sendPayloadWithChunkedTextAndMedia,
} from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { readStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/security-runtime";
import {
  buildWechatLinuxBodyForAgent,
  normalizeWechatLinuxAllowlist,
  resolveWechatLinuxAllowlistMatch,
} from "./normalize.js";
import { getWechatLinuxRuntime } from "./runtime.js";
import {
  resolveWechatLinuxTextChunkLimit,
  sendWechatLinuxMedia,
  sendWechatLinuxText,
} from "./send.js";
import type {
  CoreConfig,
  BridgeMessage,
  GroupPolicy,
  ResolvedWechatLinuxAccount,
} from "./types.js";

const CHANNEL_ID = "wechat-linux" as const;
const GROUP_POLICY_BLOCKED_LABEL = "group messages";
const warnedMissingProviderGroupPolicy = new Set<string>();

function resolveDefaultGroupPolicy(cfg: CoreConfig): GroupPolicy | undefined {
  const defaults = (cfg.channels as Record<string, unknown> | undefined)?.defaults;
  if (!defaults || typeof defaults !== "object") {
    return undefined;
  }
  const groupPolicy = (defaults as Record<string, unknown>).groupPolicy;
  return groupPolicy === "allowlist" || groupPolicy === "open" || groupPolicy === "disabled"
    ? groupPolicy
    : undefined;
}

function resolveRuntimeGroupPolicy(params: {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
}): { groupPolicy: GroupPolicy; providerMissingFallbackApplied: boolean } {
  const groupPolicy = params.providerConfigPresent
    ? (params.groupPolicy ?? params.defaultGroupPolicy ?? "allowlist")
    : (params.groupPolicy ?? "allowlist");
  return {
    groupPolicy,
    providerMissingFallbackApplied:
      !params.providerConfigPresent && params.groupPolicy === undefined,
  };
}

function warnMissingProviderGroupPolicyFallbackOnce(params: {
  providerMissingFallbackApplied: boolean;
  accountId: string;
  log: (message: string) => void;
}) {
  if (!params.providerMissingFallbackApplied) {
    return;
  }
  const key = `${CHANNEL_ID}:${params.accountId}`;
  if (warnedMissingProviderGroupPolicy.has(key)) {
    return;
  }
  warnedMissingProviderGroupPolicy.add(key);
  params.log(
    `${CHANNEL_ID}: channels.${CHANNEL_ID} is missing; defaulting groupPolicy to "allowlist" (${GROUP_POLICY_BLOCKED_LABEL} blocked until explicitly configured).`,
  );
}

function resolveDirectAccess(params: {
  dmPolicy: string;
  allowFrom: string[];
  senderId: string;
}): "allow" | "pairing" | "block" {
  if (params.dmPolicy === "disabled") {
    return "block";
  }
  if (params.dmPolicy === "open") {
    return "allow";
  }
  if (
    resolveWechatLinuxAllowlistMatch({ allowFrom: params.allowFrom, senderId: params.senderId })
      .allowed
  ) {
    return "allow";
  }
  return params.dmPolicy === "pairing" ? "pairing" : "block";
}

function resolveGroupAccess(params: {
  groupPolicy: GroupPolicy;
  groupAllowFrom: string[];
  senderId: string;
}): boolean {
  if (params.groupPolicy === "disabled") {
    return false;
  }
  if (params.groupPolicy === "open") {
    return true;
  }
  return resolveWechatLinuxAllowlistMatch({
    allowFrom: params.groupAllowFrom,
    senderId: params.senderId,
  }).allowed;
}

function collectReadableMedia(message: BridgeMessage) {
  const mediaList = (message.media_paths ?? [])
    .map((entry, index) => ({
      path: entry,
      contentType: message.media_types?.[index],
    }))
    .filter((entry) => Boolean(entry.path));
  return mediaList.length > 0
    ? buildMediaPayload(mediaList, { preserveMediaTypeCardinality: true })
    : {};
}

export async function handleWechatLinuxInbound(params: {
  message: BridgeMessage;
  account: ResolvedWechatLinuxAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getWechatLinuxRuntime();
  const rawBody = buildWechatLinuxBodyForAgent(message);
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const isGroup = message.chat_type === "group";
  const senderId = message.sender_id;
  const senderName = message.sender_display || message.sender_username || senderId;
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const { groupPolicy, providerMissingFallbackApplied } = resolveRuntimeGroupPolicy({
    providerConfigPresent:
      ((config.channels as Record<string, unknown> | undefined)?.["wechat-linux"] ?? undefined) !==
      undefined,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(config),
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    accountId: account.accountId,
    log: (line) => runtime.log?.(line),
  });

  const configAllowFrom = normalizeWechatLinuxAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeWechatLinuxAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = normalizeWechatLinuxAllowlist(
    await readStoreAllowFromForDmPolicy({
      provider: CHANNEL_ID,
      accountId: account.accountId,
      dmPolicy,
      readStore: pairing.readStoreForDmPolicy,
    }),
  );
  const effectiveAllowFrom = Array.from(new Set([...configAllowFrom, ...storeAllowFrom]));
  const effectiveGroupAllowFrom = configGroupAllowFrom;

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config,
    surface: CHANNEL_ID,
  });
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config);
  const useAccessGroups =
    ((config.commands as Record<string, unknown> | undefined)?.useAccessGroups ?? true) !== false;
  const commandAllowlist = isGroup ? configGroupAllowFrom : effectiveAllowFrom;
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: commandAllowlist.length > 0,
        allowed: resolveWechatLinuxAllowlistMatch({
          allowFrom: commandAllowlist,
          senderId,
        }).allowed,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  if (isGroup) {
    if (!resolveGroupAccess({ groupPolicy, groupAllowFrom: effectiveGroupAllowFrom, senderId })) {
      runtime.log?.(`${CHANNEL_ID}: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
    if (commandGate.shouldBlock) {
      logInboundDrop({
        log: (line) => runtime.log?.(line),
        channel: CHANNEL_ID,
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }
  } else {
    const dmAccess = resolveDirectAccess({
      dmPolicy,
      allowFrom: effectiveAllowFrom,
      senderId,
    });
    if (dmAccess !== "allow") {
      if (dmAccess === "pairing") {
        await pairing.issueChallenge({
          senderId,
          senderIdLine: `Your WeChat sender id: ${senderId}`,
          meta: { name: senderName || undefined },
          sendPairingReply: async (text) => {
            await sendWechatLinuxText({
              cfg: config,
              to: message.chat_id,
              text,
              accountId: account.accountId,
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          onReplyError: (error) => {
            runtime.error?.(
              `${CHANNEL_ID}: pairing reply failed for ${senderId}: ${String(error)}`,
            );
          },
        });
      }
      runtime.log?.(`${CHANNEL_ID}: drop DM sender ${senderId} (dmPolicy=${dmPolicy})`);
      return;
    }
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config);
  const wasMentioned = mentionRegexes.length
    ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
    : false;
  if (isGroup && !wasMentioned && !(hasControlCommand && allowTextCommands && commandAuthorized)) {
    runtime.log?.(`${CHANNEL_ID}: drop group ${message.chat_id} (no mention)`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: message.chat_id,
    },
  });

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeChat",
    from: isGroup ? message.chat_name || message.chat_id : senderName,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: core.channel.reply.resolveEnvelopeFormatOptions(config),
    body: rawBody,
  });
  const mediaPayload = collectReadableMedia(message);

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: message.content,
    CommandBody: rawBody,
    From: isGroup ? `wechat-linux:group:${message.chat_id}` : `wechat-linux:${senderId}`,
    To: `wechat-linux:${message.chat_id}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: message.chat_name || message.chat_id,
    SenderName: senderName || undefined,
    SenderId: senderId,
    SenderUsername: message.sender_username || undefined,
    GroupSubject: isGroup ? message.chat_name || message.chat_id : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: String(message.local_id),
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `wechat-linux:${message.chat_id}`,
    CommandAuthorized: commandAuthorized,
    ...mediaPayload,
  });

  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (error) => {
      runtime.error?.(`${CHANNEL_ID}: failed updating session meta: ${String(error)}`);
    },
  });

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: config,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });
  const deliver = createNormalizedOutboundDeliverer(async (payload) => {
    await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload },
      textChunkLimit: resolveWechatLinuxTextChunkLimit(config, account.accountId),
      chunker: (text, limit) => core.channel.text.chunkMarkdownText(text, limit),
      sendText: async ({ text }) => {
        await sendWechatLinuxText({
          cfg: config,
          to: message.chat_id,
          text,
          accountId: account.accountId,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      },
      sendMedia: async ({ text, mediaUrl }) => {
        await sendWechatLinuxMedia({
          cfg: config,
          to: message.chat_id,
          text,
          mediaUrl,
          accountId: account.accountId,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      },
      emptyResult: undefined,
    });
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...replyPipeline,
      deliver,
      onError: (error, info) => {
        runtime.error?.(`${CHANNEL_ID} ${info.kind} reply failed: ${String(error)}`);
      },
    },
    replyOptions: {
      onModelSelected,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
