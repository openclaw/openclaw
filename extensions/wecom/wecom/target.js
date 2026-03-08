/**
 * WeCom Target Resolver
 *
 * Parses an OpenClaw `to` field (raw target string) into a concrete WeCom
 * recipient object ({ toUser, toParty, toTag, chatId }).
 *
 * Supports explicit prefixes (party:, tag:, etc.) and heuristic fallback.
 */

/**
 * @param {string|undefined} raw
 * @returns {{ webhook?: string, toUser?: string, toParty?: string, toTag?: string, chatId?: string } | undefined}
 */
export function resolveWecomTarget(raw) {
  if (!raw?.trim()) return undefined;

  // 0. Webhook bot target (before namespace stripping).
  if (/^webhook:/i.test(raw.trim())) {
    return { webhook: raw.trim().replace(/^webhook:/i, "").trim() };
  }

  // 1. Remove standard namespace prefixes.
  let clean = raw.trim().replace(/^(wecom-agent|wecom|wechatwork|wework|qywx):/i, "");

  // 2. Explicit type prefixes.
  if (/^party:/i.test(clean)) {
    return { toParty: clean.replace(/^party:/i, "").trim() };
  }
  if (/^dept:/i.test(clean)) {
    return { toParty: clean.replace(/^dept:/i, "").trim() };
  }
  if (/^tag:/i.test(clean)) {
    return { toTag: clean.replace(/^tag:/i, "").trim() };
  }
  if (/^group:/i.test(clean)) {
    return { chatId: clean.replace(/^group:/i, "").trim() };
  }
  if (/^chat:/i.test(clean)) {
    return { chatId: clean.replace(/^chat:/i, "").trim() };
  }
  if (/^user:/i.test(clean)) {
    return { toUser: clean.replace(/^user:/i, "").trim() };
  }

  // 3. Heuristics (no explicit prefix).
  // Chat IDs typically start with "wr" (external) or "wc".
  if (/^(wr|wc)/i.test(clean)) {
    return { chatId: clean };
  }
  // Pure digits are likely department (party) IDs.
  if (/^\d+$/.test(clean)) {
    return { toParty: clean };
  }

  // Default: treat as user ID.
  return { toUser: clean };
}
