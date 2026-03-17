import {
  GROUP_POLICY_BLOCKED_LABEL,
  createScopedPairingAccess,
  dispatchInboundReplyWithBase,
  formatTextWithAttachmentLinks,
  issuePairingChallenge,
  logInboundDrop,
  isDangerousNameMatchingEnabled,
  readStoreAllowFromForDmPolicy,
  resolveControlCommandGate,
  resolveOutboundMediaUrls,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveEffectiveAllowFromLists,
  warnMissingProviderGroupPolicyFallbackOnce
} from "openclaw/plugin-sdk/irc";
import { normalizeIrcAllowlist, resolveIrcAllowlistMatch } from "./normalize.js";
import {
  resolveIrcMentionGate,
  resolveIrcGroupAccessGate,
  resolveIrcGroupMatch,
  resolveIrcGroupSenderAllowed,
  resolveIrcRequireMention
} from "./policy.js";
import { getIrcRuntime } from "./runtime.js";
import { sendMessageIrc } from "./send.js";
const CHANNEL_ID = "irc";
const escapeIrcRegexLiteral = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function resolveIrcEffectiveAllowlists(params) {
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: params.configAllowFrom,
    groupAllowFrom: params.configGroupAllowFrom,
    storeAllowFrom: params.storeAllowList,
    dmPolicy: params.dmPolicy,
    // IRC intentionally requires explicit groupAllowFrom; do not fallback to allowFrom.
    groupAllowFromFallbackToAllowFrom: false
  });
  return { effectiveAllowFrom, effectiveGroupAllowFrom };
}
async function deliverIrcReply(params) {
  const combined = formatTextWithAttachmentLinks(
    params.payload.text,
    resolveOutboundMediaUrls(params.payload)
  );
  if (!combined) {
    return;
  }
  if (params.sendReply) {
    await params.sendReply(params.target, combined, params.payload.replyToId);
  } else {
    await sendMessageIrc(params.target, combined, {
      accountId: params.accountId,
      replyTo: params.payload.replyToId
    });
  }
  params.statusSink?.({ lastOutboundAt: Date.now() });
}
async function handleIrcInbound(params) {
  const { message, account, config, runtime, connectedNick, statusSink } = params;
  const core = getIrcRuntime();
  const pairing = createScopedPairingAccess({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId
  });
  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }
  statusSink?.({ lastInboundAt: message.timestamp });
  const senderDisplay = message.senderHost ? `${message.senderNick}!${message.senderUser ?? "?"}@${message.senderHost}` : message.senderNick;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: config.channels?.irc !== void 0,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "irc",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (message2) => runtime.log?.(message2)
  });
  const configAllowFrom = normalizeIrcAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeIrcAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy
  });
  const storeAllowList = normalizeIrcAllowlist(storeAllowFrom);
  const groupMatch = resolveIrcGroupMatch({
    groups: account.config.groups,
    target: message.target
  });
  if (message.isGroup) {
    const groupAccess = resolveIrcGroupAccessGate({ groupPolicy, groupMatch });
    if (!groupAccess.allowed) {
      runtime.log?.(`irc: drop channel ${message.target} (${groupAccess.reason})`);
      return;
    }
  }
  const directGroupAllowFrom = normalizeIrcAllowlist(groupMatch.groupConfig?.allowFrom);
  const wildcardGroupAllowFrom = normalizeIrcAllowlist(groupMatch.wildcardConfig?.allowFrom);
  const groupAllowFrom = directGroupAllowFrom.length > 0 ? directGroupAllowFrom : wildcardGroupAllowFrom;
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveIrcEffectiveAllowlists({
    configAllowFrom,
    configGroupAllowFrom,
    storeAllowList,
    dmPolicy
  });
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config,
    surface: CHANNEL_ID
  });
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = resolveIrcAllowlistMatch({
    allowFrom: message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
    message,
    allowNameMatching
  }).allowed;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: (message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom).length > 0,
        allowed: senderAllowedForCommands
      }
    ],
    allowTextCommands,
    hasControlCommand
  });
  const commandAuthorized = commandGate.commandAuthorized;
  if (message.isGroup) {
    const senderAllowed = resolveIrcGroupSenderAllowed({
      groupPolicy,
      message,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: groupAllowFrom,
      allowNameMatching
    });
    if (!senderAllowed) {
      runtime.log?.(`irc: drop group sender ${senderDisplay} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (dmPolicy === "disabled") {
      runtime.log?.(`irc: drop DM sender=${senderDisplay} (dmPolicy=disabled)`);
      return;
    }
    if (dmPolicy !== "open") {
      const dmAllowed = resolveIrcAllowlistMatch({
        allowFrom: effectiveAllowFrom,
        message,
        allowNameMatching
      }).allowed;
      if (!dmAllowed) {
        if (dmPolicy === "pairing") {
          await issuePairingChallenge({
            channel: CHANNEL_ID,
            senderId: senderDisplay.toLowerCase(),
            senderIdLine: `Your IRC id: ${senderDisplay}`,
            meta: { name: message.senderNick || void 0 },
            upsertPairingRequest: pairing.upsertPairingRequest,
            sendPairingReply: async (text) => {
              await deliverIrcReply({
                payload: { text },
                target: message.senderNick,
                accountId: account.accountId,
                sendReply: params.sendReply,
                statusSink
              });
            },
            onReplyError: (err) => {
              runtime.error?.(`irc: pairing reply failed for ${senderDisplay}: ${String(err)}`);
            }
          });
        }
        runtime.log?.(`irc: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
        return;
      }
    }
  }
  if (message.isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (line) => runtime.log?.(line),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderDisplay
    });
    return;
  }
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config);
  const mentionNick = connectedNick?.trim() || account.nick;
  const explicitMentionRegex = mentionNick ? new RegExp(`\\b${escapeIrcRegexLiteral(mentionNick)}\\b[:,]?`, "i") : null;
  const wasMentioned = core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) || (explicitMentionRegex ? explicitMentionRegex.test(rawBody) : false);
  const requireMention = message.isGroup ? resolveIrcRequireMention({
    groupConfig: groupMatch.groupConfig,
    wildcardConfig: groupMatch.wildcardConfig
  }) : false;
  const mentionGate = resolveIrcMentionGate({
    isGroup: message.isGroup,
    requireMention,
    wasMentioned,
    hasControlCommand,
    allowTextCommands,
    commandAuthorized
  });
  if (mentionGate.shouldSkip) {
    runtime.log?.(`irc: drop channel ${message.target} (${mentionGate.reason})`);
    return;
  }
  const peerId = message.isGroup ? message.target : message.senderNick;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId
    }
  });
  const fromLabel = message.isGroup ? message.target : senderDisplay;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "IRC",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody
  });
  const groupSystemPrompt = groupMatch.groupConfig?.systemPrompt?.trim() || void 0;
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: message.isGroup ? `irc:channel:${message.target}` : `irc:${senderDisplay}`,
    To: `irc:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderNick || void 0,
    SenderId: senderDisplay,
    GroupSubject: message.isGroup ? message.target : void 0,
    GroupSystemPrompt: message.isGroup ? groupSystemPrompt : void 0,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: message.isGroup ? wasMentioned : void 0,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `irc:${peerId}`,
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
      await deliverIrcReply({
        payload,
        target: peerId,
        accountId: account.accountId,
        sendReply: params.sendReply,
        statusSink
      });
    },
    onRecordError: (err) => {
      runtime.error?.(`irc: failed updating session meta: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`irc ${info.kind} reply failed: ${String(err)}`);
    },
    replyOptions: {
      skillFilter: groupMatch.groupConfig?.skills,
      disableBlockStreaming: typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : void 0
    }
  });
}
const __testing = {
  resolveIrcEffectiveAllowlists
};
export {
  __testing,
  handleIrcInbound
};
