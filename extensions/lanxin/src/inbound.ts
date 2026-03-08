import {
  buildAgentMediaPayload,
  GROUP_POLICY_BLOCKED_LABEL,
  createNormalizedOutboundDeliverer,
  createReplyPrefixOptions,
  createScopedPairingAccess,
  formatTextWithAttachmentLinks,
  logInboundDrop,
  readStoreAllowFromForDmPolicy,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithCommandGate,
  resolveOutboundMediaUrls,
  warnMissingProviderGroupPolicyFallbackOnce,
  type OpenClawConfig,
  type OutboundReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/lanxin";
import { downloadLanxinMedia } from "./media.js";
import { resolveLanxinAllowlistMatch } from "./policy.js";
import { getLanxinRuntime } from "./runtime.js";
import { sendLanxinByConversation } from "./send.js";
import { parseLanxinTarget } from "./targets.js";
import type { LanxinInboundMessage, ResolvedLanxinAccount } from "./types.js";

const CHANNEL_ID = "lanxin" as const;

async function deliverLanxinReply(params: {
  payload: OutboundReplyPayload;
  target: string;
  cfg: OpenClawConfig;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const combined = formatTextWithAttachmentLinks(
    params.payload.text,
    resolveOutboundMediaUrls(params.payload),
  );
  if (!combined) return;
  const target = parseLanxinTarget(params.target);
  if (!target) throw new Error(`Invalid Lanxin reply target: ${params.target}`);
  await sendLanxinByConversation({
    cfg: params.cfg,
    accountId: params.accountId,
    target,
    text: combined,
  });
  params.statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handleLanxinInbound(params: {
  message: LanxinInboundMessage;
  account: ResolvedLanxinAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getLanxinRuntime();
  const pairing = createScopedPairingAccess({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  const mediaMaxBytes =
    typeof config.agents?.defaults?.mediaMaxMb === "number" && config.agents.defaults.mediaMaxMb > 0
      ? Math.floor(config.agents.defaults.mediaMaxMb * 1024 * 1024)
      : 8 * 1024 * 1024;
  const mediaList: Array<{ path: string; contentType?: string | null }> = [];
  for (const mediaId of message.mediaIds) {
    try {
      const downloaded = await downloadLanxinMedia({
        cfg: config,
        accountId: account.accountId,
        mediaId,
      });
      const detectedType =
        downloaded.contentType || (await core.media.detectMime({ buffer: downloaded.buffer }));
      const saved = await core.channel.media.saveMediaBuffer(
        downloaded.buffer,
        detectedType,
        "inbound",
        mediaMaxBytes,
        downloaded.fileName,
      );
      mediaList.push({
        path: saved.path,
        contentType: saved.contentType,
      });
    } catch (err) {
      runtime.error?.(`lanxin: failed downloading media ${mediaId}: ${String(err)}`);
    }
  }
  const mediaPayload = buildAgentMediaPayload(mediaList);
  const mediaHint =
    message.mediaIds.length > 0
      ? [
          "[Lanxin attachment metadata]",
          `- incoming_msg_type: ${message.msgType}`,
          `- media_ids: ${message.mediaIds.join(", ")}`,
          `- downloaded_count: ${mediaList.length}`,
          ...(mediaList.length > 0
            ? [
                `- downloaded_content_types: ${mediaList.map((m) => m.contentType ?? "unknown").join(", ")}`,
              ]
            : []),
        ].join("\n")
      : "";
  const effectiveRawBody =
    rawBody && mediaHint ? `${rawBody}\n\n${mediaHint}` : rawBody || mediaHint;
  if (!effectiveRawBody) return;
  statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.lanxin !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: CHANNEL_ID,
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (line) => runtime.log?.(line),
  });

  const configAllowFrom = account.config.allowFrom ?? [];
  const configGroupAllowFrom = account.config.groupAllowFrom ?? [];
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config,
    surface: CHANNEL_ID,
  });
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const hasControlCommand = core.channel.text.hasControlCommand(effectiveRawBody, config);
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup: message.isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: configAllowFrom.map(String),
    groupAllowFrom: configGroupAllowFrom.map(String),
    storeAllowFrom: storeAllowFrom.map(String),
    isSenderAllowed: (allowFrom) =>
      resolveLanxinAllowlistMatch({
        allowFrom,
        senderId: message.senderId,
      }).allowed,
    command: {
      useAccessGroups,
      allowTextCommands,
      hasControlCommand,
    },
  });
  const commandAuthorized = access.commandAuthorized;

  if (message.isGroup) {
    if (access.decision !== "allow") {
      runtime.log?.(`lanxin: drop group sender ${message.senderId} (reason=${access.reason})`);
      return;
    }
  } else if (access.decision !== "allow") {
    if (access.decision === "pairing") {
      const { code, created } = await pairing.upsertPairingRequest({
        id: message.senderId,
        meta: { name: message.senderName || undefined },
      });
      if (created) {
        try {
          await sendLanxinByConversation({
            cfg: config,
            accountId: account.accountId,
            target: {
              kind: "direct",
              userId: message.userId,
              entryId: message.entryId,
            },
            text: core.channel.pairing.buildPairingReply({
              channel: CHANNEL_ID,
              idLine: `Your Lanxin user id: ${message.senderId}`,
              code,
            }),
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        } catch (err) {
          runtime.error?.(`lanxin: pairing reply failed for ${message.senderId}: ${String(err)}`);
        }
      }
    }
    runtime.log?.(`lanxin: drop DM sender ${message.senderId} (reason=${access.reason})`);
    return;
  }

  if (access.shouldBlockControlCommand) {
    logInboundDrop({
      log: (line) => runtime.log?.(line),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: message.senderId,
    });
    return;
  }

  const peerId = message.isGroup
    ? `${message.groupId ?? "unknown"}:${message.entryId}`
    : `${message.userId}:${message.entryId}`;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const fromLabel = message.isGroup
    ? `group:${message.groupId ?? "unknown"}`
    : message.senderName || `user:${message.senderId}`;
  const toTarget = message.isGroup
    ? `group:${message.groupId ?? ""}:${message.entryId}:${message.userId}`
    : `user:${message.userId}:${message.entryId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Lanxin",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: effectiveRawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: effectiveRawBody,
    RawBody: effectiveRawBody,
    CommandBody: effectiveRawBody,
    From: message.isGroup ? `lanxin:group:${message.groupId}` : `lanxin:${message.senderId}`,
    To: `lanxin:${toTarget}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderName || undefined,
    SenderId: message.senderId,
    GroupSubject: message.isGroup ? message.groupId : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `lanxin:${toTarget}`,
    CommandAuthorized: commandAuthorized,
    ...mediaPayload,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`lanxin: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });
  const deliverReply = createNormalizedOutboundDeliverer(async (payload) => {
    await deliverLanxinReply({
      payload,
      target: toTarget,
      cfg: config,
      accountId: account.accountId,
      statusSink,
    });
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: deliverReply,
      onError: (err, info) => {
        runtime.error?.(`lanxin ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}
