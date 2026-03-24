import {
  dispatchInboundReplyWithBase,
  deliverFormattedTextWithAttachments,
  type OutboundReplyPayload,
  type OpenClawConfig,
  type RuntimeEnv,
} from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkGroupAllow,
  resolveNextcloudTalkRoomMatch,
} from "./policy.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig, GroupPolicy, NextcloudTalkInboundReaction } from "./types.js";

const CHANNEL_ID = "nextcloud-talk" as const;

async function deliverNextcloudTalkReply(params: {
  payload: OutboundReplyPayload;
  roomToken: string;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, roomToken, accountId, statusSink } = params;
  await deliverFormattedTextWithAttachments({
    payload,
    send: async ({ text, replyToId }) => {
      await sendMessageNextcloudTalk(roomToken, text, {
        accountId,
        replyTo: replyToId,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

export async function handleNextcloudTalkInboundReaction(params: {
  reaction: NextcloudTalkInboundReaction;
  account: ResolvedNextcloudTalkAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { reaction, account, config, runtime, statusSink } = params;
  const core = getNextcloudTalkRuntime();

  statusSink?.({ lastInboundAt: reaction.timestamp });

  const roomToken = reaction.roomToken;
  const roomName = reaction.roomName;
  const actorId = reaction.actorId;

  // Check room allowlist
  const roomMatch = resolveNextcloudTalkRoomMatch({
    rooms: account.config.rooms,
    roomToken,
  });
  if (!roomMatch.allowed) {
    runtime.log?.(`nextcloud-talk: reaction drop room ${roomToken} (not allowlisted)`);
    return;
  }
  if (roomMatch.roomConfig?.enabled === false) {
    runtime.log?.(`nextcloud-talk: reaction drop room ${roomToken} (disabled)`);
    return;
  }

  // Treat all rooms as group for allowlist checks (safe default — reactions are rarely in DMs)
  const groupPolicy = (account.config.groupPolicy ?? "allowlist") as GroupPolicy;
  const configGroupAllowFrom = normalizeNextcloudTalkAllowlist(account.config.groupAllowFrom);
  const roomAllowFrom = normalizeNextcloudTalkAllowlist(roomMatch.roomConfig?.allowFrom);

  const groupAllow = resolveNextcloudTalkGroupAllow({
    groupPolicy,
    outerAllowFrom: configGroupAllowFrom,
    innerAllowFrom: roomAllowFrom,
    senderId: actorId,
  });
  if (!groupAllow.allowed) {
    // Also check configAllowFrom (DM allowlist) as a fallback
    const configAllowFrom = normalizeNextcloudTalkAllowlist(account.config.allowFrom);
    const dmAllow = resolveNextcloudTalkAllowlistMatch({
      allowFrom: configAllowFrom,
      senderId: actorId,
    });
    if (!dmAllow.allowed) {
      runtime.log?.(`nextcloud-talk: reaction drop actor ${actorId} (not allowed)`);
      return;
    }
  }

  // Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "group",
      id: roomToken,
    },
  });

  const conversationLabel = `room:${roomName || roomToken}`;

  // Build reaction body text
  const reactionBody = `[Reaction] ${reaction.actorName} reacted with ${reaction.emoji} (${reaction.operation}) on message ${reaction.messageId}`;

  const storePath = core.channel.session.resolveStorePath(
    (config.session as Record<string, unknown> | undefined)?.store as string | undefined,
    {
      agentId: route.agentId,
    },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Nextcloud Talk",
    from: conversationLabel,
    timestamp: reaction.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: reactionBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: reactionBody,
    RawBody: reactionBody,
    CommandBody: reactionBody,
    From: `nextcloud-talk:room:${roomToken}`,
    To: `nextcloud-talk:${roomToken}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "group",
    ConversationLabel: conversationLabel,
    SenderName: reaction.actorName || undefined,
    SenderId: actorId,
    GroupSubject: roomName || roomToken,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: false,
    MessageSid: reaction.messageId,
    Timestamp: reaction.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `nextcloud-talk:${roomToken}`,
    CommandAuthorized: false,
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
      await deliverNextcloudTalkReply({
        payload,
        roomToken,
        accountId: account.accountId,
        statusSink,
      });
    },
    onRecordError: (err) => {
      runtime.error?.(`nextcloud-talk: reaction failed updating session meta: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`nextcloud-talk reaction ${info.kind} reply failed: ${String(err)}`);
    },
    replyOptions: {
      skillFilter: roomMatch.roomConfig?.skills,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
