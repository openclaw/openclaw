export interface AccessCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether a sender is allowed to reach the agent based on the
 * account's dmPolicy and allowFrom list.
 *
 * - "open" policy: allow all senders
 * - "pairing" or "closed" policy: check sender against allowFrom entries
 *   - Exact email match (case-insensitive)
 *   - Domain wildcard match: `*@example.com` allows any sender @example.com
 */
export function checkSenderAccess(
  senderEmail: string,
  dmPolicy: "open" | "pairing" | "closed",
  allowFrom: Array<string | number>,
): AccessCheckResult {
  if (dmPolicy === "open") {
    return { allowed: true };
  }

  const sender = senderEmail.toLowerCase().trim();
  if (!sender) {
    return { allowed: false, reason: "Empty sender address" };
  }

  const senderDomain = sender.split("@")[1];

  for (const entry of allowFrom) {
    const rule = String(entry).toLowerCase().trim();
    if (!rule) continue;

    // Exact match
    if (rule === sender) {
      return { allowed: true };
    }

    // Domain wildcard: *@example.com
    if (rule.startsWith("*@") && senderDomain) {
      const wildcardDomain = rule.slice(2);
      if (wildcardDomain === senderDomain) {
        return { allowed: true };
      }
    }
  }

  return {
    allowed: false,
    reason: `Sender ${sender} is not in the allowlist`,
  };
}
