import {
  GROUP_POLICY_BLOCKED_LABEL,
  createScopedPairingAccess,
  dispatchInboundReplyWithBase,
  formatTextWithAttachmentLinks,
  issuePairingChallenge,
  logInboundDrop,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithCommandGate,
  resolveOutboundMediaUrls,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce
} from "openclaw/plugin-sdk/nextcloud-talk";
import {
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkGroupAllow,
  resolveNextcloudTalkMentionGate,
  resolveNextcloudTalkRequireMention,
  resolveNextcloudTalkRoomMatch
} from "./policy.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { sendMessageNextcloudTalk } from "./send.js";
const CHANNEL_ID = "nextcloud-talk";
async function deliverNextcloudTalkReply(params) {
  const { payload, roomToken, accountId, statusSink } = params;
  const combined = formatTextWithAttachmentLinks(payload.text, resolveOutboundMediaUrls(payload));
  if (!combined) {
    return;
  }
  await sendMessageNextcloudTalk(roomToken, combined, {
    accountId,
    replyTo: payload.replyToId
  });
  statusSink?.({ lastOutboundAt: Date.now() });
}
async function handleNextcloudTalkInbound(params) {
  const { message, account, config, runtime, statusSink } = params;
  const core = getNextcloudTalkRuntime();
  const pairing = createScopedPairingAccess({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId
  });
  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }
  const roomKind = await resolveNextcloudTalkRoomKind({
    account,
    roomToken: message.roomToken,
    runtime
  });
  const isGroup = roomKind === "direct" ? false : roomKind === "group" ? true : message.isGroupChat;
  const senderId = message.senderId;
  const senderName = message.senderName;
  const roomToken = message.roomToken;
  const roomName = message.roomName;
  statusSink?.({ lastInboundAt: message.timestamp });
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: (config.channels?.["nextcloud-talk"] ?? void 0) !== void 0,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "nextcloud-talk",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message2) => runtime.log?.(message2)
  });
  const configAllowFrom = normalizeNextcloudTalkAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeNextcloudTalkAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy
  });
  const storeAllowList = normalizeNextcloudTalkAllowlist(storeAllowFrom);
  const roomMatch = resolveNextcloudTalkRoomMatch({
    rooms: account.config.rooms,
    roomToken,
    roomName
  });
  const roomConfig = roomMatch.roomConfig;
  if (isGroup && !roomMatch.allowed) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (not allowlisted)`);
    return;
  }
  if (roomConfig?.enabled === false) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (disabled)`);
    return;
  }
  const roomAllowFrom = normalizeNextcloudTalkAllowlist(roomConfig?.allowFrom);
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config,
    surface: CHANNEL_ID
  });
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config);
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom: storeAllowList,
    isSenderAllowed: (allowFrom) => resolveNextcloudTalkAllowlistMatch({
      allowFrom,
      senderId
    }).allowed,
    command: {
      useAccessGroups,
      allowTextCommands,
      hasControlCommand
    }
  });
  const commandAuthorized = access.commandAuthorized;
  const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;
  if (isGroup) {
    if (access.decision !== "allow") {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (reason=${access.reason})`);
      return;
    }
    const groupAllow = resolveNextcloudTalkGroupAllow({
      groupPolicy,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: roomAllowFrom,
      senderId
    });
    if (!groupAllow.allowed) {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (access.decision !== "allow") {
      if (access.decision === "pairing") {
        await issuePairingChallenge({
          channel: CHANNEL_ID,
          senderId,
          senderIdLine: `Your Nextcloud user id: ${senderId}`,
          meta: { name: senderName || void 0 },
          upsertPairingRequest: pairing.upsertPairingRequest,
          sendPairingReply: async (text) => {
            await sendMessageNextcloudTalk(roomToken, text, { accountId: account.accountId });
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          onReplyError: (err) => {
            runtime.error?.(`nextcloud-talk: pairing reply failed for ${senderId}: ${String(err)}`);
          }
        });
      }
      runtime.log?.(`nextcloud-talk: drop DM sender ${senderId} (reason=${access.reason})`);
      return;
    }
  }
  if (access.shouldBlockControlCommand) {
    logInboundDrop({
      log: (message2) => runtime.log?.(message2),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId
    });
    return;
  }
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config);
  const wasMentioned = mentionRegexes.length ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) : false;
  const shouldRequireMention = isGroup ? resolveNextcloudTalkRequireMention({
    roomConfig,
    wildcardConfig: roomMatch.wildcardConfig
  }) : false;
  const mentionGate = resolveNextcloudTalkMentionGate({
    isGroup,
    requireMention: shouldRequireMention,
    wasMentioned,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized
  });
  if (isGroup && mentionGate.shouldSkip) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (no mention)`);
    return;
  }
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? roomToken : senderId
    }
  });
  const fromLabel = isGroup ? `room:${roomName || roomToken}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(
    config.session?.store,
    {
      agentId: route.agentId
    }
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Nextcloud Talk",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody
  });
  const groupSystemPrompt = roomConfig?.systemPrompt?.trim() || void 0;
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `nextcloud-talk:room:${roomToken}` : `nextcloud-talk:${senderId}`,
    To: `nextcloud-talk:${roomToken}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || void 0,
    SenderId: senderId,
    GroupSubject: isGroup ? roomName || roomToken : void 0,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : void 0,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? wasMentioned : void 0,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `nextcloud-talk:${roomToken}`,
    CommandAuthorized: commandAuthorized
  });
  await dispatchInboundReplyWithBase({
    cfg: config,
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
        statusSink
      });
    },
    onRecordError: (err) => {
      runtime.error?.(`nextcloud-talk: failed updating session meta: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`nextcloud-talk ${info.kind} reply failed: ${String(err)}`);
    },
    replyOptions: {
      skillFilter: roomConfig?.skills,
      disableBlockStreaming: typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : void 0
    }
  });
}
export {
  handleNextcloudTalkInbound
};
