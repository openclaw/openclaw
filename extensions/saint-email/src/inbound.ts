import {
  createReplyPrefixOptions,
  resolveControlCommandGate,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { CoreConfig, ResolvedSaintEmailAccount, SaintEmailInboundMessage } from "./types.js";
import { getSaintEmailRuntime } from "./runtime.js";
import { sendSaintEmail } from "./send.js";
import { SAINT_EMAIL_CHANNEL_ID } from "./types.js";

function normalizeAllowlist(values: string[]): string[] {
  return values.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function matchAllowlist(allowFrom: string[], senderEmail: string): boolean {
  const normalized = senderEmail.trim().toLowerCase();
  return allowFrom.includes(normalized);
}

export async function handleSaintEmailInbound(params: {
  message: SaintEmailInboundMessage;
  account: ResolvedSaintEmailAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getSaintEmailRuntime();
  statusSink?.({ lastInboundAt: message.timestamp });

  const allowFrom = normalizeAllowlist(account.allowFrom);
  const allowed = matchAllowlist(allowFrom, message.fromEmail);

  if (account.dmPolicy === "disabled") {
    return;
  }
  if (account.dmPolicy !== "open" && !allowed) {
    if (account.dmPolicy === "pairing") {
      await core.channel.pairing.upsertPairingRequest({
        channel: SAINT_EMAIL_CHANNEL_ID,
        id: message.fromEmail,
        meta: {
          name: message.from,
        },
      });
    }
    return;
  }

  const commandGate = resolveControlCommandGate({
    useAccessGroups: true,
    authorizers: [{ configured: allowFrom.length > 0, allowed }],
    allowTextCommands: core.channel.commands.shouldHandleTextCommands({
      cfg: config as OpenClawConfig,
      surface: SAINT_EMAIL_CHANNEL_ID,
    }),
    hasControlCommand: core.channel.text.hasControlCommand(message.text, config as OpenClawConfig),
  });
  if (commandGate.shouldBlock) {
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: SAINT_EMAIL_CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: message.fromEmail,
    },
  });

  const mediaPaths = message.attachments.map((attachment) => attachment.path).filter(Boolean);
  const mediaTypes = message.attachments
    .map((attachment) => attachment.mimeType)
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Email",
    from: message.from,
    timestamp: message.timestamp,
    previousTimestamp: undefined,
    envelope: core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig),
    body: message.text,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: message.text,
    RawBody: message.text,
    CommandBody: message.text,
    From: `email:${message.fromEmail}`,
    To: `email:${account.address}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: message.from,
    SenderName: message.from,
    SenderId: message.fromEmail,
    Provider: SAINT_EMAIL_CHANNEL_ID,
    Surface: SAINT_EMAIL_CHANNEL_ID,
    MessageSid: message.id,
    Timestamp: message.timestamp,
    MediaPath: mediaPaths[0],
    MediaUrl: mediaPaths[0],
    MediaType: mediaTypes[0],
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    OriginatingChannel: SAINT_EMAIL_CHANNEL_ID,
    OriginatingTo: `email:${account.address}`,
    CommandAuthorized: commandGate.commandAuthorized,
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: SAINT_EMAIL_CHANNEL_ID,
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config as OpenClawConfig,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await sendSaintEmail({
          account,
          to: message.fromEmail,
          payload: {
            ...(payload as {
              text?: string;
              mediaUrl?: string;
              mediaUrls?: string[];
              channelData?: Record<string, unknown>;
            }),
            channelData: {
              ...((payload as { channelData?: Record<string, unknown> }).channelData ?? {}),
              threadId: message.threadId,
              subject: message.subject.startsWith("Re:")
                ? message.subject
                : `Re: ${message.subject}`,
            },
          },
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        runtime.error?.(`email ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}
