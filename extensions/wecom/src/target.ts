/**
 * WeCom Target Resolver
 *
 * Parses OpenClaw's `to` field (raw target string) and converts it into
 * specific WeCom recipient objects.
 * Supports explicit prefixes (party:, tag:, etc.) and rule-based heuristic inference.
 *
 * **Relationship between "target sending" and "message records" (Target vs Inbound):**
 * - **Outbound**: Supports one-to-many broadcasting (Party/Tag).
 *   For example, sending to `party:1` will reach all members under that department.
 * - **Inbound**: Always comes from a specific **User** or **Chat (group)**.
 *   When a member replies to a department broadcast message, it can be treated as
 *   a new DM conversation or a reply within the member's existing DM.
 *   Therefore, the Outbound Target (e.g. Party) and Inbound Source (User) do not
 *   need and cannot have a 1:1 strict match.
 *   Broadcasting is a "fire-and-forget" notification mode, while replies are
 *   specific conversation interactions.
 */

export interface WecomTarget {
  touser?: string;
  toparty?: string;
  totag?: string;
  chatid?: string;
}

/**
 * Parses a raw target string into a WeComTarget object.
 *
 * Logic:
 * 1. Remove standard namespace prefixes (wecom:, qywx:, etc.).
 * 2. Check for explicit type prefixes (party:, tag:, group:, user:).
 * 3. Heuristic fallback (when no prefix):
 *    - Starts with "wr" or "wc" -> Chat ID (group chat)
 *    - Pure digits -> Party ID (department)
 *    - Otherwise -> User ID
 *
 * @param raw - The raw target string (e.g. "party:1", "zhangsan", "wecom:wr123")
 */
export function resolveWecomTarget(raw: string | undefined): WecomTarget | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  // 1. Remove standard namespace prefixes
  let clean = raw.trim().replace(/^(wecom-agent|wecom|wechatwork|wework|qywx):/i, "");

  // 2. Explicit type prefixes
  if (/^party:/i.test(clean)) {
    return { toparty: clean.replace(/^party:/i, "").trim() };
  }
  if (/^dept:/i.test(clean)) {
    return { toparty: clean.replace(/^dept:/i, "").trim() };
  }
  if (/^tag:/i.test(clean)) {
    return { totag: clean.replace(/^tag:/i, "").trim() };
  }
  if (/^group:/i.test(clean)) {
    return { chatid: clean.replace(/^group:/i, "").trim() };
  }
  if (/^chat:/i.test(clean)) {
    return { chatid: clean.replace(/^chat:/i, "").trim() };
  }
  if (/^user:/i.test(clean)) {
    return { touser: clean.replace(/^user:/i, "").trim() };
  }

  // 3. Heuristics

  // Chat ID typically starts with 'wr' (external group) or 'wc'
  if (/^(wr|wc)/i.test(clean)) {
    return { chatid: clean };
  }

  // Pure digits are treated as Department IDs (Parties) for ops convenience
  // (e.g. "1" represents the root department).
  // To send to a user with a numeric ID, use the explicit prefix "user:1001".
  if (/^\d+$/.test(clean)) {
    return { toparty: clean };
  }

  // Default to User
  return { touser: clean };
}
