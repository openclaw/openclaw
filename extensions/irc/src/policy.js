import { normalizeIrcAllowlist, resolveIrcAllowlistMatch } from "./normalize.js";
function resolveIrcGroupMatch(params) {
  const groups = params.groups ?? {};
  const hasConfiguredGroups = Object.keys(groups).length > 0;
  const direct = groups[params.target];
  if (direct) {
    return {
      // "allowed" means the target matched an allowlisted key.
      // Explicit disables are handled later by resolveIrcGroupAccessGate.
      allowed: true,
      groupConfig: direct,
      wildcardConfig: groups["*"],
      hasConfiguredGroups
    };
  }
  const targetLower = params.target.toLowerCase();
  const directKey = Object.keys(groups).find((key) => key.toLowerCase() === targetLower);
  if (directKey) {
    const matched = groups[directKey];
    if (matched) {
      return {
        // "allowed" means the target matched an allowlisted key.
        // Explicit disables are handled later by resolveIrcGroupAccessGate.
        allowed: true,
        groupConfig: matched,
        wildcardConfig: groups["*"],
        hasConfiguredGroups
      };
    }
  }
  const wildcard = groups["*"];
  if (wildcard) {
    return {
      // "allowed" means the target matched an allowlisted key.
      // Explicit disables are handled later by resolveIrcGroupAccessGate.
      allowed: true,
      wildcardConfig: wildcard,
      hasConfiguredGroups
    };
  }
  return {
    allowed: false,
    hasConfiguredGroups
  };
}
function resolveIrcGroupAccessGate(params) {
  const policy = params.groupPolicy ?? "allowlist";
  if (policy === "disabled") {
    return { allowed: false, reason: "groupPolicy=disabled" };
  }
  if (policy === "allowlist") {
    if (!params.groupMatch.hasConfiguredGroups) {
      return {
        allowed: false,
        reason: "groupPolicy=allowlist and no groups configured"
      };
    }
    if (!params.groupMatch.allowed) {
      return { allowed: false, reason: "not allowlisted" };
    }
  }
  if (params.groupMatch.groupConfig?.enabled === false || params.groupMatch.wildcardConfig?.enabled === false) {
    return { allowed: false, reason: "disabled" };
  }
  return { allowed: true, reason: policy === "open" ? "open" : "allowlisted" };
}
function resolveIrcRequireMention(params) {
  if (params.groupConfig?.requireMention !== void 0) {
    return params.groupConfig.requireMention;
  }
  if (params.wildcardConfig?.requireMention !== void 0) {
    return params.wildcardConfig.requireMention;
  }
  return true;
}
function resolveIrcMentionGate(params) {
  if (!params.isGroup) {
    return { shouldSkip: false, reason: "direct" };
  }
  if (!params.requireMention) {
    return { shouldSkip: false, reason: "mention-not-required" };
  }
  if (params.wasMentioned) {
    return { shouldSkip: false, reason: "mentioned" };
  }
  if (params.hasControlCommand && params.allowTextCommands && params.commandAuthorized) {
    return { shouldSkip: false, reason: "authorized-command" };
  }
  return { shouldSkip: true, reason: "missing-mention" };
}
function resolveIrcGroupSenderAllowed(params) {
  const policy = params.groupPolicy ?? "allowlist";
  const inner = normalizeIrcAllowlist(params.innerAllowFrom);
  const outer = normalizeIrcAllowlist(params.outerAllowFrom);
  if (inner.length > 0) {
    return resolveIrcAllowlistMatch({
      allowFrom: inner,
      message: params.message,
      allowNameMatching: params.allowNameMatching
    }).allowed;
  }
  if (outer.length > 0) {
    return resolveIrcAllowlistMatch({
      allowFrom: outer,
      message: params.message,
      allowNameMatching: params.allowNameMatching
    }).allowed;
  }
  return policy === "open";
}
export {
  resolveIrcGroupAccessGate,
  resolveIrcGroupMatch,
  resolveIrcGroupSenderAllowed,
  resolveIrcMentionGate,
  resolveIrcRequireMention
};
