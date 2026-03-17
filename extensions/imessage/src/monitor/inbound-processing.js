import { hasControlCommand } from "../../../../src/auto-reply/command-detection.js";
import {
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions
} from "../../../../src/auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled
} from "../../../../src/auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../../../src/auto-reply/reply/inbound-context.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns
} from "../../../../src/auto-reply/reply/mentions.js";
import { resolveDualTextControlCommandGate } from "../../../../src/channels/command-gating.js";
import { logInboundDrop } from "../../../../src/channels/logging.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention
} from "../../../../src/config/group-policy.js";
import { resolveAgentRoute } from "../../../../src/routing/resolve-route.js";
import {
  DM_GROUP_ACCESS_REASON,
  resolveDmGroupAccessWithLists
} from "../../../../src/security/dm-policy-shared.js";
import { sanitizeTerminalText } from "../../../../src/terminal/safe-text.js";
import { truncateUtf16Safe } from "../../../../src/utils.js";
import {
  formatIMessageChatTarget,
  isAllowedIMessageSender,
  normalizeIMessageHandle
} from "../targets.js";
import { detectReflectedContent } from "./reflection-guard.js";
function normalizeReplyField(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : void 0;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return void 0;
}
function describeReplyContext(message) {
  const body = normalizeReplyField(message.reply_to_text);
  if (!body) {
    return null;
  }
  const id = normalizeReplyField(message.reply_to_id);
  const sender = normalizeReplyField(message.reply_to_sender);
  return { body, id, sender };
}
function resolveIMessageInboundDecision(params) {
  const senderRaw = params.message.sender ?? "";
  const sender = senderRaw.trim();
  if (!sender) {
    return { kind: "drop", reason: "missing sender" };
  }
  const senderNormalized = normalizeIMessageHandle(sender);
  const chatId = params.message.chat_id ?? void 0;
  const chatGuid = params.message.chat_guid ?? void 0;
  const chatIdentifier = params.message.chat_identifier ?? void 0;
  const createdAt = params.message.created_at ? Date.parse(params.message.created_at) : void 0;
  const groupIdCandidate = chatId !== void 0 ? String(chatId) : void 0;
  const groupListPolicy = groupIdCandidate ? resolveChannelGroupPolicy({
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
    groupId: groupIdCandidate
  }) : {
    allowlistEnabled: false,
    allowed: true,
    groupConfig: void 0,
    defaultConfig: void 0
  };
  const treatAsGroupByConfig = Boolean(
    groupIdCandidate && groupListPolicy.allowlistEnabled && groupListPolicy.groupConfig
  );
  const isGroup = Boolean(params.message.is_group) || treatAsGroupByConfig;
  const selfChatLookup = {
    accountId: params.accountId,
    isGroup,
    chatId,
    sender,
    text: params.bodyText,
    createdAt
  };
  if (params.message.is_from_me) {
    params.selfChatCache?.remember(selfChatLookup);
    return { kind: "drop", reason: "from me" };
  }
  if (isGroup && !chatId) {
    return { kind: "drop", reason: "group without chat_id" };
  }
  const groupId = isGroup ? groupIdCandidate : void 0;
  const accessDecision = resolveDmGroupAccessWithLists({
    isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    storeAllowFrom: params.storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowFrom) => isAllowedIMessageSender({
      allowFrom,
      sender,
      chatId,
      chatGuid,
      chatIdentifier
    })
  });
  const effectiveDmAllowFrom = accessDecision.effectiveAllowFrom;
  const effectiveGroupAllowFrom = accessDecision.effectiveGroupAllowFrom;
  if (accessDecision.decision !== "allow") {
    if (isGroup) {
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
        params.logVerbose?.("Blocked iMessage group message (groupPolicy: disabled)");
        return { kind: "drop", reason: "groupPolicy disabled" };
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
        params.logVerbose?.(
          "Blocked iMessage group message (groupPolicy: allowlist, no groupAllowFrom)"
        );
        return { kind: "drop", reason: "groupPolicy allowlist (empty groupAllowFrom)" };
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
        params.logVerbose?.(`Blocked iMessage sender ${sender} (not in groupAllowFrom)`);
        return { kind: "drop", reason: "not in groupAllowFrom" };
      }
      params.logVerbose?.(`Blocked iMessage group message (${accessDecision.reason})`);
      return { kind: "drop", reason: accessDecision.reason };
    }
    if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
      return { kind: "drop", reason: "dmPolicy disabled" };
    }
    if (accessDecision.decision === "pairing") {
      return { kind: "pairing", senderId: senderNormalized };
    }
    params.logVerbose?.(`Blocked iMessage sender ${sender} (dmPolicy=${params.dmPolicy})`);
    return { kind: "drop", reason: "dmPolicy blocked" };
  }
  if (isGroup && groupListPolicy.allowlistEnabled && !groupListPolicy.allowed) {
    params.logVerbose?.(
      `imessage: skipping group message (${groupId ?? "unknown"}) not in allowlist`
    );
    return { kind: "drop", reason: "group id not in allowlist" };
  }
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? String(chatId ?? "unknown") : senderNormalized
    }
  });
  const mentionRegexes = buildMentionRegexes(params.cfg, route.agentId);
  const messageText = params.messageText.trim();
  const bodyText = params.bodyText.trim();
  if (!bodyText) {
    return { kind: "drop", reason: "empty body" };
  }
  if (params.selfChatCache?.has({
    ...selfChatLookup,
    text: bodyText
  })) {
    const preview = sanitizeTerminalText(truncateUtf16Safe(bodyText, 50));
    params.logVerbose?.(`imessage: dropping self-chat reflected duplicate: "${preview}"`);
    return { kind: "drop", reason: "self-chat echo" };
  }
  const inboundMessageId = params.message.id != null ? String(params.message.id) : void 0;
  if (params.echoCache && (messageText || inboundMessageId)) {
    const echoScope = buildIMessageEchoScope({
      accountId: params.accountId,
      isGroup,
      chatId,
      sender
    });
    if (params.echoCache.has(echoScope, {
      text: messageText || void 0,
      messageId: inboundMessageId
    })) {
      params.logVerbose?.(
        describeIMessageEchoDropLog({ messageText, messageId: inboundMessageId })
      );
      return { kind: "drop", reason: "echo" };
    }
  }
  const reflection = detectReflectedContent(messageText);
  if (reflection.isReflection) {
    params.logVerbose?.(
      `imessage: dropping reflected assistant content (markers: ${reflection.matchedLabels.join(", ")})`
    );
    return { kind: "drop", reason: "reflected assistant content" };
  }
  const replyContext = describeReplyContext(params.message);
  const historyKey = isGroup ? String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown") : void 0;
  const mentioned = isGroup ? matchesMentionPatterns(messageText, mentionRegexes) : true;
  const requireMention = resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
    groupId,
    requireMentionOverride: params.opts?.requireMention,
    overrideOrder: "before-config"
  });
  const canDetectMention = mentionRegexes.length > 0;
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const commandDmAllowFrom = isGroup ? params.allowFrom : effectiveDmAllowFrom;
  const ownerAllowedForCommands = commandDmAllowFrom.length > 0 ? isAllowedIMessageSender({
    allowFrom: commandDmAllowFrom,
    sender,
    chatId,
    chatGuid,
    chatIdentifier
  }) : false;
  const groupAllowedForCommands = effectiveGroupAllowFrom.length > 0 ? isAllowedIMessageSender({
    allowFrom: effectiveGroupAllowFrom,
    sender,
    chatId,
    chatGuid,
    chatIdentifier
  }) : false;
  const hasControlCommandInMessage = hasControlCommand(messageText, params.cfg);
  const { commandAuthorized, shouldBlock } = resolveDualTextControlCommandGate({
    useAccessGroups,
    primaryConfigured: commandDmAllowFrom.length > 0,
    primaryAllowed: ownerAllowedForCommands,
    secondaryConfigured: effectiveGroupAllowFrom.length > 0,
    secondaryAllowed: groupAllowedForCommands,
    hasControlCommand: hasControlCommandInMessage
  });
  if (isGroup && shouldBlock) {
    if (params.logVerbose) {
      logInboundDrop({
        log: params.logVerbose,
        channel: "imessage",
        reason: "control command (unauthorized)",
        target: sender
      });
    }
    return { kind: "drop", reason: "control command (unauthorized)" };
  }
  const shouldBypassMention = isGroup && requireMention && !mentioned && commandAuthorized && hasControlCommandInMessage;
  const effectiveWasMentioned = mentioned || shouldBypassMention;
  if (isGroup && requireMention && canDetectMention && !mentioned && !shouldBypassMention) {
    params.logVerbose?.(`imessage: skipping group message (no mention)`);
    recordPendingHistoryEntryIfEnabled({
      historyMap: params.groupHistories,
      historyKey: historyKey ?? "",
      limit: params.historyLimit,
      entry: historyKey ? {
        sender: senderNormalized,
        body: bodyText,
        timestamp: createdAt,
        messageId: params.message.id ? String(params.message.id) : void 0
      } : null
    });
    return { kind: "drop", reason: "no mention" };
  }
  return {
    kind: "dispatch",
    isGroup,
    chatId,
    chatGuid,
    chatIdentifier,
    groupId,
    historyKey,
    sender,
    senderNormalized,
    route,
    bodyText,
    createdAt,
    replyContext,
    effectiveWasMentioned,
    commandAuthorized,
    effectiveDmAllowFrom,
    effectiveGroupAllowFrom
  };
}
function buildIMessageInboundContext(params) {
  const envelopeOptions = params.envelopeOptions ?? resolveEnvelopeFormatOptions(params.cfg);
  const { decision } = params;
  const chatId = decision.chatId;
  const chatTarget = decision.isGroup && chatId != null ? formatIMessageChatTarget(chatId) : void 0;
  const replySuffix = decision.replyContext ? `

[Replying to ${decision.replyContext.sender ?? "unknown sender"}${decision.replyContext.id ? ` id:${decision.replyContext.id}` : ""}]
${decision.replyContext.body}
[/Replying]` : "";
  const fromLabel = formatInboundFromLabel({
    isGroup: decision.isGroup,
    groupLabel: params.message.chat_name ?? void 0,
    groupId: chatId !== void 0 ? String(chatId) : "unknown",
    groupFallback: "Group",
    directLabel: decision.senderNormalized,
    directId: decision.sender
  });
  const body = formatInboundEnvelope({
    channel: "iMessage",
    from: fromLabel,
    timestamp: decision.createdAt,
    body: `${decision.bodyText}${replySuffix}`,
    chatType: decision.isGroup ? "group" : "direct",
    sender: { name: decision.senderNormalized, id: decision.sender },
    previousTimestamp: params.previousTimestamp,
    envelope: envelopeOptions
  });
  let combinedBody = body;
  if (decision.isGroup && decision.historyKey) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: params.groupHistories,
      historyKey: decision.historyKey,
      limit: params.historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) => formatInboundEnvelope({
        channel: "iMessage",
        from: fromLabel,
        timestamp: entry.timestamp,
        body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
        chatType: "group",
        senderLabel: entry.sender,
        envelope: envelopeOptions
      })
    });
  }
  const imessageTo = (decision.isGroup ? chatTarget : void 0) || `imessage:${decision.sender}`;
  const inboundHistory = decision.isGroup && decision.historyKey && params.historyLimit > 0 ? (params.groupHistories.get(decision.historyKey) ?? []).map((entry) => ({
    sender: entry.sender,
    body: entry.body,
    timestamp: entry.timestamp
  })) : void 0;
  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: decision.bodyText,
    InboundHistory: inboundHistory,
    RawBody: decision.bodyText,
    CommandBody: decision.bodyText,
    From: decision.isGroup ? `imessage:group:${chatId ?? "unknown"}` : `imessage:${decision.sender}`,
    To: imessageTo,
    SessionKey: decision.route.sessionKey,
    AccountId: decision.route.accountId,
    ChatType: decision.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    GroupSubject: decision.isGroup ? params.message.chat_name ?? void 0 : void 0,
    GroupMembers: decision.isGroup ? (params.message.participants ?? []).filter(Boolean).join(", ") : void 0,
    SenderName: decision.senderNormalized,
    SenderId: decision.sender,
    Provider: "imessage",
    Surface: "imessage",
    MessageSid: params.message.id ? String(params.message.id) : void 0,
    ReplyToId: decision.replyContext?.id,
    ReplyToBody: decision.replyContext?.body,
    ReplyToSender: decision.replyContext?.sender,
    Timestamp: decision.createdAt,
    MediaPath: params.media?.path,
    MediaType: params.media?.type,
    MediaUrl: params.media?.path,
    MediaPaths: params.media?.paths && params.media.paths.length > 0 ? params.media.paths : void 0,
    MediaTypes: params.media?.types && params.media.types.length > 0 ? params.media.types : void 0,
    MediaUrls: params.media?.paths && params.media.paths.length > 0 ? params.media.paths : void 0,
    MediaRemoteHost: params.remoteHost,
    WasMentioned: decision.effectiveWasMentioned,
    CommandAuthorized: decision.commandAuthorized,
    OriginatingChannel: "imessage",
    OriginatingTo: imessageTo
  });
  return { ctxPayload, fromLabel, chatTarget, imessageTo, inboundHistory };
}
function buildIMessageEchoScope(params) {
  return `${params.accountId}:${params.isGroup ? formatIMessageChatTarget(params.chatId) : `imessage:${params.sender}`}`;
}
function describeIMessageEchoDropLog(params) {
  const preview = truncateUtf16Safe(params.messageText, 50);
  const messageIdPart = params.messageId ? ` id=${params.messageId}` : "";
  return `imessage: skipping echo message${messageIdPart}: "${preview}"`;
}
export {
  buildIMessageEchoScope,
  buildIMessageInboundContext,
  describeIMessageEchoDropLog,
  resolveIMessageInboundDecision
};
