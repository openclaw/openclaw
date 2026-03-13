import {
  createScopedPairingAccess,
  dispatchInboundReplyWithBase,
  formatTextWithAttachmentLinks,
  issuePairingChallenge,
  readStoreAllowFromForDmPolicy,
  resolveOutboundMediaUrls,
  type OutboundReplyPayload,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/pilot";
import type { ResolvedPilotAccount } from "./accounts.js";
import { normalizePilotAllowlist, resolvePilotAllowlistMatch } from "./normalize.js";
import { getPilotRuntime } from "./runtime.js";
import { sendPilotMessage } from "./send.js";
import type { CoreConfig, PilotInboundMessage } from "./types.js";

const CHANNEL_ID = "pilot" as const;

async function deliverPilotReply(params: {
  payload: OutboundReplyPayload;
  target: string;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  const combined = formatTextWithAttachmentLinks(
    params.payload.text,
    resolveOutboundMediaUrls(params.payload),
  );
  if (!combined) {
    return;
  }
  await sendPilotMessage(params.target, combined, {
    accountId: params.accountId,
    replyTo: params.payload.replyToId,
  });
  params.statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handlePilotInbound(params: {
  message: PilotInboundMessage;
  account: ResolvedPilotAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getPilotRuntime();
  const pairing = createScopedPairingAccess({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = normalizePilotAllowlist(account.config.allowFrom);

  // DM-only protocol: no group handling needed.
  if (dmPolicy === "disabled") {
    runtime.log?.(`pilot: drop DM sender=${message.sender} (dmPolicy=disabled)`);
    return;
  }

  if (dmPolicy !== "open") {
    const storeAllowFrom = normalizePilotAllowlist(
      await readStoreAllowFromForDmPolicy({
        provider: CHANNEL_ID,
        accountId: account.accountId,
        dmPolicy,
        readStore: pairing.readStoreForDmPolicy,
      }),
    );
    const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];

    const dmAllowed = resolvePilotAllowlistMatch({
      allowFrom: effectiveAllowFrom,
      sender: message.sender,
      senderHostname: message.senderHostname,
    }).allowed;

    if (!dmAllowed) {
      if (dmPolicy === "pairing") {
        await issuePairingChallenge({
          channel: CHANNEL_ID,
          senderId: message.sender.toLowerCase(),
          senderIdLine: `Your Pilot address: ${message.sender}${message.senderHostname ? ` (${message.senderHostname})` : ""}`,
          meta: { name: message.senderHostname || undefined },
          upsertPairingRequest: pairing.upsertPairingRequest,
          sendPairingReply: async (text) => {
            await deliverPilotReply({
              payload: { text },
              target: message.sender,
              accountId: account.accountId,
              statusSink,
            });
          },
          onReplyError: (err) => {
            runtime.error?.(`pilot: pairing reply failed for ${message.sender}: ${String(err)}`);
          },
        });
      }
      runtime.log?.(`pilot: drop DM sender=${message.sender} (dmPolicy=${dmPolicy})`);
      return;
    }
  }

  const peerId = message.sender;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: peerId,
    },
  });

  const senderLabel = message.senderHostname
    ? `${message.senderHostname} (${message.sender})`
    : message.sender;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Pilot",
    from: senderLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `pilot:${message.sender}`,
    To: `pilot:${account.hostname}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: senderLabel,
    SenderName: message.senderHostname || undefined,
    SenderId: message.sender,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `pilot:${peerId}`,
    CommandAuthorized: true,
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
      await deliverPilotReply({
        payload,
        target: peerId,
        accountId: account.accountId,
        statusSink,
      });
    },
    onRecordError: (err) => {
      runtime.error?.(`pilot: failed updating session meta: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`pilot ${info.kind} reply failed: ${String(err)}`);
    },
    replyOptions: {
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
