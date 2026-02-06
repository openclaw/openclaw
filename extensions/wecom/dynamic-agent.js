/**
 * Dynamic agent helpers.
 *
 * This plugin only computes deterministic agent ids/session keys.
 * Workspace/bootstrap creation is handled by OpenClaw core.
 */

/**
 * Build a deterministic agent id for dm/group contexts.
 *
 * @param {string} chatType - "dm" or "group"
 * @param {string} peerId - user id or group id
 * @returns {string} agentId
 */
export function generateAgentId(chatType, peerId) {
  const sanitizedId = String(peerId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  if (chatType === "group") {
    return `wecom-group-${sanitizedId}`;
  }
  return `wecom-dm-${sanitizedId}`;
}

/**
 * Resolve runtime dynamic-agent settings from config.
 */
export function getDynamicAgentConfig(config) {
  const wecom = config?.channels?.wecom || {};
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
