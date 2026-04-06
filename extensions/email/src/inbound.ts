import type { ResolvedEmailAccount } from "./accounts.js";
import {
  createChannelPairingController,
  deliverFormattedTextWithAttachments,
  dispatchInboundReplyWithBase,
  logInboundDrop,
  readStoreAllowFromForDmPolicy,
  resolveControlCommandGate,
  resolveEffectiveAllowFromLists,
  type OpenClawConfig,
  type OutboundReplyPayload,
  type RuntimeEnv,
} from "./runtime-api.js";
import { getEmailRuntime } from "./runtime.js";
import { sendEmail, buildReplySubject } from "./send.js";
import type { CoreConfig, EmailInboundMessage } from "./types.js";

const CHANNEL_ID = "email" as const;

type ConversationState = {
  lastSubject: string;
  lastMessageId: string;
};

const conversationState = new Map<string, ConversationState>();

export function recordInboundConversation(
  from: string,
  subject: string,
  messageId: string,
): void {
  conversationState.set(from, { lastSubject: subject, lastMessageId: messageId });
}

export async function handleEmailInbound(params: {
  message: EmailInboundMessage;
  account: ResolvedEmailAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getEmailRuntime();

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) return;

  statusSink?.({ lastInboundAt: message.timestamp });

  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const dmPolicy = account.dmPolicy ?? "allowlist";
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });

  const { effectiveAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: account.allowFrom,
    groupAllowFrom: [],
    storeAllowFrom,
    dmPolicy,
    groupAllowFromFallbackToAllowFrom: false,
  });

  const senderAllowed =
    effectiveAllowFrom.includes("*") ||
    effectiveAllowFrom.some(
      (entry) =>
        entry.toLowerCase() === message.from ||
        (entry.startsWith("*@") && message.from.endsWith(entry.slice(1))),
    );

  if (!senderAllowed) {
    logInboundDrop({
      log: (line) => runtime.log?.(line),
      channel: CHANNEL_ID,
      reason: `dmPolicy=${dmPolicy}: sender not in allowFrom`,
      target: message.from,
    });
    return;
  }

  recordInboundConversation(message.from, message.subject, message.messageId);

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });

  const hasControlCommand = core.channel.text.hasControlCommand(
    rawBody,
    config as OpenClawConfig,
  );

  const commandGate = resolveControlCommandGate({
    useAccessGroups: (config as any).commands?.useAccessGroups !== false,
    authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowed }],
    allowTextCommands,
    hasControlCommand,
  });

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: message.from },
  });

  const storePath = core.channel.session.resolveStorePath(
    (config as any).session?.store,
    { agentId: route.agentId },
  );

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(
    config as OpenClawConfig,
  );
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const formattedBody = core.channel.reply.formatAgentEnvelope({
    channel: "Email",
    from: message.from,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: message.text,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: formattedBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `email:${message.from}`,
    To: `email:${account.imapUsername}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: message.from,
    SenderName: message.from,
    SenderId: message.from,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.messageId || message.uid,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `email:${account.imapUsername}`,
    CommandAuthorized: commandGate.commandAuthorized,
  });

  const state = conversationState.get(message.from);

  await dispatchInboundReplyWithBase({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    route,
    storePath,
    ctxPayload,
    core,
    deliver: async (payload: OutboundReplyPayload) => {
      await deliverEmailReply({
        payload,
        to: message.from,
        account,
        state,
        statusSink,
      });
    },
    onRecordError: (err) => {
      runtime.error?.(`email: failed updating session meta: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`email ${info.kind} reply failed: ${String(err)}`);
    },
  });
}

async function deliverEmailReply(params: {
  payload: OutboundReplyPayload;
  to: string;
  account: ResolvedEmailAccount;
  state: ConversationState | undefined;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, to, account, state, statusSink } = params;

  if (!account.consentGranted) return;
  if (!account.smtpHost || !account.smtpUsername) return;

  const baseSubject = state?.lastSubject ?? "OpenClaw reply";
  const subject = buildReplySubject(baseSubject, account.subjectPrefix);

  await deliverFormattedTextWithAttachments({
    payload,
    send: async ({ text }) => {
      await sendEmail({
        account,
        to,
        text,
        subject,
        inReplyTo: state?.lastMessageId,
        references: state?.lastMessageId,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}
