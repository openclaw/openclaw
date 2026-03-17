import {
  evaluateSenderGroupAccessForPolicy,
  isDangerousNameMatchingEnabled,
  resolveAllowlistMatchSimple,
  resolveControlCommandGate,
  resolveEffectiveAllowFromLists
} from "openclaw/plugin-sdk/mattermost";
function normalizeMattermostAllowEntry(entry) {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed.replace(/^(mattermost|user):/i, "").replace(/^@/, "").toLowerCase();
}
function normalizeMattermostAllowList(entries) {
  const normalized = entries.map((entry) => normalizeMattermostAllowEntry(String(entry))).filter(Boolean);
  return Array.from(new Set(normalized));
}
function resolveMattermostEffectiveAllowFromLists(params) {
  return resolveEffectiveAllowFromLists({
    allowFrom: normalizeMattermostAllowList(params.allowFrom ?? []),
    groupAllowFrom: normalizeMattermostAllowList(params.groupAllowFrom ?? []),
    storeAllowFrom: normalizeMattermostAllowList(params.storeAllowFrom ?? []),
    dmPolicy: params.dmPolicy
  });
}
function isMattermostSenderAllowed(params) {
  const allowFrom = normalizeMattermostAllowList(params.allowFrom);
  if (allowFrom.length === 0) {
    return false;
  }
  const match = resolveAllowlistMatchSimple({
    allowFrom,
    senderId: normalizeMattermostAllowEntry(params.senderId),
    senderName: params.senderName ? normalizeMattermostAllowEntry(params.senderName) : void 0,
    allowNameMatching: params.allowNameMatching
  });
  return match.allowed;
}
function mapMattermostChannelKind(channelType) {
  const normalized = channelType?.trim().toUpperCase();
  if (normalized === "D") {
    return "direct";
  }
  if (normalized === "G" || normalized === "P") {
    return "group";
  }
  return "channel";
}
function authorizeMattermostCommandInvocation(params) {
  const {
    account,
    cfg,
    senderId,
    senderName,
    channelId,
    channelInfo,
    storeAllowFrom,
    allowTextCommands,
    hasControlCommand
  } = params;
  if (!channelInfo) {
    return {
      ok: false,
      denyReason: "unknown-channel",
      commandAuthorized: false,
      channelInfo: null,
      kind: "channel",
      chatType: "channel",
      channelName: "",
      channelDisplay: "",
      roomLabel: `#${channelId}`
    };
  }
  const kind = mapMattermostChannelKind(channelInfo.type);
  const chatType = kind;
  const channelName = channelInfo.name ?? "";
  const channelDisplay = channelInfo.display_name ?? channelName;
  const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  const configAllowFrom = normalizeMattermostAllowList(account.config.allowFrom ?? []);
  const configGroupAllowFrom = normalizeMattermostAllowList(account.config.groupAllowFrom ?? []);
  const normalizedStoreAllowFrom = normalizeMattermostAllowList(storeAllowFrom ?? []);
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveMattermostEffectiveAllowFromLists({
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom: normalizedStoreAllowFrom,
    dmPolicy
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const commandDmAllowFrom = kind === "direct" ? effectiveAllowFrom : configAllowFrom;
  const commandGroupAllowFrom = kind === "direct" ? effectiveGroupAllowFrom : configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom;
  const senderAllowedForCommands = isMattermostSenderAllowed({
    senderId,
    senderName,
    allowFrom: commandDmAllowFrom,
    allowNameMatching
  });
  const groupAllowedForCommands = isMattermostSenderAllowed({
    senderId,
    senderName,
    allowFrom: commandGroupAllowFrom,
    allowNameMatching
  });
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      { configured: commandDmAllowFrom.length > 0, allowed: senderAllowedForCommands },
      {
        configured: commandGroupAllowFrom.length > 0,
        allowed: groupAllowedForCommands
      }
    ],
    allowTextCommands,
    hasControlCommand: allowTextCommands && hasControlCommand
  });
  const commandAuthorized = kind === "direct" ? dmPolicy === "open" || senderAllowedForCommands : commandGate.commandAuthorized;
  if (kind === "direct") {
    if (dmPolicy === "disabled") {
      return {
        ok: false,
        denyReason: "dm-disabled",
        commandAuthorized: false,
        channelInfo,
        kind,
        chatType,
        channelName,
        channelDisplay,
        roomLabel
      };
    }
    if (dmPolicy !== "open" && !senderAllowedForCommands) {
      return {
        ok: false,
        denyReason: dmPolicy === "pairing" ? "dm-pairing" : "unauthorized",
        commandAuthorized: false,
        channelInfo,
        kind,
        chatType,
        channelName,
        channelDisplay,
        roomLabel
      };
    }
  } else {
    const senderGroupAccess = evaluateSenderGroupAccessForPolicy({
      groupPolicy,
      groupAllowFrom: effectiveGroupAllowFrom,
      senderId,
      isSenderAllowed: (_senderId, allowFrom) => isMattermostSenderAllowed({
        senderId,
        senderName,
        allowFrom,
        allowNameMatching
      })
    });
    if (!senderGroupAccess.allowed && senderGroupAccess.reason === "disabled") {
      return {
        ok: false,
        denyReason: "channels-disabled",
        commandAuthorized: false,
        channelInfo,
        kind,
        chatType,
        channelName,
        channelDisplay,
        roomLabel
      };
    }
    if (!senderGroupAccess.allowed && senderGroupAccess.reason === "empty_allowlist") {
      return {
        ok: false,
        denyReason: "channel-no-allowlist",
        commandAuthorized: false,
        channelInfo,
        kind,
        chatType,
        channelName,
        channelDisplay,
        roomLabel
      };
    }
    if (!senderGroupAccess.allowed && senderGroupAccess.reason === "sender_not_allowlisted") {
      return {
        ok: false,
        denyReason: "unauthorized",
        commandAuthorized: false,
        channelInfo,
        kind,
        chatType,
        channelName,
        channelDisplay,
        roomLabel
      };
    }
    if (commandGate.shouldBlock) {
      return {
        ok: false,
        denyReason: "unauthorized",
        commandAuthorized: false,
        channelInfo,
        kind,
        chatType,
        channelName,
        channelDisplay,
        roomLabel
      };
    }
  }
  return {
    ok: true,
    commandAuthorized,
    channelInfo,
    kind,
    chatType,
    channelName,
    channelDisplay,
    roomLabel
  };
}
export {
  authorizeMattermostCommandInvocation,
  isMattermostSenderAllowed,
  normalizeMattermostAllowEntry,
  normalizeMattermostAllowList,
  resolveMattermostEffectiveAllowFromLists
};
