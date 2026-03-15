/**
 * Dynamic agent helpers.
 *
 * This plugin only computes deterministic agent ids/session keys.
 * Workspace/bootstrap creation is handled by OpenClaw core.
 */

/**
 * Build a deterministic agent id for dm/group contexts.
 *
 * When running in multi-account mode the accountId is embedded as a
 * namespace segment so each account's conversations stay isolated:
 *   default  → wecom-dm-{peerId}         (backward compatible)
 *   "sales"  → wecom-sales-dm-{peerId}
 *
 * @param {string} chatType - "dm" or "group"
 * @param {string} peerId - user id or group id
 * @param {string} [accountId] - optional account namespace ("default" is omitted)
 * @returns {string} agentId
 */
export function generateAgentId(chatType, peerId, accountId) {
  const sanitizedId = String(peerId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  // Only embed the account prefix for non-default accounts so existing
  // single-account deployments keep identical agent ids (zero breaking change).
  const ns = accountId && accountId !== "default" ? `${accountId}-` : "";
  if (chatType === "group") {
    return `wecom-${ns}group-${sanitizedId}`;
  }
  return `wecom-${ns}dm-${sanitizedId}`;
}

/**
 * Resolve runtime dynamic-agent settings from config.
 *
 * Accepts either the full openclaw config (legacy) or a per-account wecom
 * config block directly (multi-account).  Detection: if the object has
 * `channels.wecom`, unwrap it; otherwise treat the object itself as the
 * wecom account config.
 */
export function getDynamicAgentConfig(config) {
  const wecom = config?.channels?.wecom ?? config ?? {};
  return {
    enabled: wecom.dynamicAgents?.enabled !== false,
    dmCreateAgent: wecom.dm?.createAgentOnFirstMessage !== false,
    groupEnabled: wecom.groupChat?.enabled !== false,
    groupRequireMention: wecom.groupChat?.requireMention !== false,
    groupMentionPatterns: wecom.groupChat?.mentionPatterns || ["@"],
  };
}

/**
 * Decide whether this message context should route to a dynamic agent.
 */
export function shouldUseDynamicAgent({ chatType, config }) {
  const dynamicConfig = getDynamicAgentConfig(config);
  if (!dynamicConfig.enabled) {
    return false;
  }
  if (chatType === "group") {
    return dynamicConfig.groupEnabled;
  }
  return dynamicConfig.dmCreateAgent;
}

/**
 * Decide whether a group message should trigger a response.
 */
export function shouldTriggerGroupResponse(content, config) {
  const dynamicConfig = getDynamicAgentConfig(config);

  if (!dynamicConfig.groupEnabled) {
    return false;
  }

  if (!dynamicConfig.groupRequireMention) {
    return true;
  }

  // Match any configured mention marker in the original message content.
  // Use word-boundary check to avoid false positives on email addresses.
  const patterns = dynamicConfig.groupMentionPatterns;
  for (const pattern of patterns) {
    const escaped = escapeRegExp(pattern);
    // @ must NOT be preceded by a word char (avoids user@domain false matches).
    const re = new RegExp(`(?:^|(?<=\\s|[^\\w]))${escaped}`, "u");
    if (re.test(content)) {
      return true;
    }
  }

  return false;
}

/**
 * Remove configured mention markers from group message text.
 */
export function extractGroupMessageContent(content, config) {
  const dynamicConfig = getDynamicAgentConfig(config);
  let cleanContent = content;

  const patterns = dynamicConfig.groupMentionPatterns;
  for (const pattern of patterns) {
    const escapedPattern = escapeRegExp(pattern);
    // Only strip @name tokens that are NOT part of email-style addresses.
    // Require the pattern to be preceded by start-of-string or whitespace.
    const regex = new RegExp(`(?:^|(?<=\\s))${escapedPattern}\\S*\\s*`, "gu");
    cleanContent = cleanContent.replace(regex, "");
  }

  return cleanContent.trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
