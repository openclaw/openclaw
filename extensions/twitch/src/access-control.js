function checkTwitchAccessControl(params) {
  const { message, account, botUsername } = params;
  if (account.requireMention ?? true) {
    const mentions = extractMentions(message.message);
    if (!mentions.includes(botUsername.toLowerCase())) {
      return {
        allowed: false,
        reason: "message does not mention the bot (requireMention is enabled)"
      };
    }
  }
  if (account.allowFrom && account.allowFrom.length > 0) {
    const allowFrom = account.allowFrom;
    const senderId = message.userId;
    if (!senderId) {
      return {
        allowed: false,
        reason: "sender user ID not available for allowlist check"
      };
    }
    if (allowFrom.includes(senderId)) {
      return {
        allowed: true,
        matchKey: senderId,
        matchSource: "allowlist"
      };
    }
    return {
      allowed: false,
      reason: "sender is not in allowFrom allowlist"
    };
  }
  if (account.allowedRoles && account.allowedRoles.length > 0) {
    const allowedRoles = account.allowedRoles;
    if (allowedRoles.includes("all")) {
      return {
        allowed: true,
        matchKey: "all",
        matchSource: "role"
      };
    }
    const hasAllowedRole = checkSenderRoles({
      message,
      allowedRoles
    });
    if (!hasAllowedRole) {
      return {
        allowed: false,
        reason: `sender does not have any of the required roles: ${allowedRoles.join(", ")}`
      };
    }
    return {
      allowed: true,
      matchKey: allowedRoles.join(","),
      matchSource: "role"
    };
  }
  return {
    allowed: true
  };
}
function checkSenderRoles(params) {
  const { message, allowedRoles } = params;
  const { isMod, isOwner, isVip, isSub } = message;
  for (const role of allowedRoles) {
    switch (role) {
      case "moderator":
        if (isMod) {
          return true;
        }
        break;
      case "owner":
        if (isOwner) {
          return true;
        }
        break;
      case "vip":
        if (isVip) {
          return true;
        }
        break;
      case "subscriber":
        if (isSub) {
          return true;
        }
        break;
    }
  }
  return false;
}
function extractMentions(message) {
  const mentionRegex = /@(\w+)/g;
  const mentions = [];
  let match;
  while ((match = mentionRegex.exec(message)) !== null) {
    const username = match[1];
    if (username) {
      mentions.push(username.toLowerCase());
    }
  }
  return mentions;
}
export {
  checkTwitchAccessControl,
  extractMentions
};
