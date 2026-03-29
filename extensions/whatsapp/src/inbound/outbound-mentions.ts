/**
 * Result of outbound mention extraction, containing both the JIDs for Baileys'
 * `mentions` field and an updated text where phone-number tokens have been
 * replaced with the corresponding LID numbers when necessary.
 */
export interface OutboundMentionResult {
  /** JIDs suitable for Baileys' `mentions` field */
  jids: string[];
  /** Updated text with phone tokens replaced to match the mention JIDs */
  text: string;
}

/**
 * Extract native WhatsApp mention JIDs from outbound message text.
 *
 * Scans for `@+<digits>` or `@<digits>` patterns (7–25 digits, covers both
 * E.164 phone numbers and WhatsApp LID identifiers) and returns a deduplicated
 * array of JIDs suitable for Baileys' `mentions` field.
 *
 * When a `participantJidMap` is provided and a match resolves to a LID JID,
 * the text token is rewritten (e.g. `@+85251159218` → `@60065218322686`) so
 * the mention number in the text matches the JID — WhatsApp requires this for
 * mentions to render as clickable.
 *
 * Requires both a leading token boundary (whitespace or start-of-string) and a
 * trailing token boundary (whitespace, punctuation, or end-of-string) to avoid
 * false positives on pasted JIDs like `@123456:1@lid` or `@1234567890abc`.
 * Tokens inside backtick code spans are skipped.
 */
export function extractOutboundMentions(
  text: string,
  participantJidMap?: Map<string, string>,
): OutboundMentionResult {
  // Replace inline code spans (single, double, and triple backtick) with
  // underscores (a non-boundary char) so that adjacent tokens don't merge
  // into false mentions and content inside code spans is never matched.
  const cleaned = text.replace(/(`{1,3})[\s\S]*?\1/g, (m) => "_".repeat(m.length));
  const pattern = /(?<=^|[\s({\[<])@\+?(\d{7,25})(?![:\d@\p{L}\p{N}_\-/])(?!\.[\p{L}\d])/gu;
  const jids = new Set<string>();
  // Track text replacements: original token → replacement token
  const replacements: Array<{ from: string; to: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    const fullToken = match[0]!; // e.g. "@+85251159218"
    const digits = match[1]!; // e.g. "85251159218"
    const normalized = `+${digits}`;
    const originalJid = participantJidMap?.get(normalized);
    if (originalJid && originalJid.endsWith("@lid")) {
      // LID participant: use LID JID and rewrite text token to match
      jids.add(originalJid);
      const lidDigits = originalJid.replace(/@.*/, "");
      const newToken = `@${lidDigits}`;
      if (fullToken !== newToken) {
        replacements.push({ from: fullToken, to: newToken });
      }
    } else {
      // Phone participant or no map: use phone JID
      jids.add(originalJid ?? `${digits}@s.whatsapp.net`);
    }
  }
  // Apply text replacements
  let updatedText = text;
  for (const { from, to } of replacements) {
    updatedText = updatedText.replace(from, to);
  }
  return { jids: Array.from(jids), text: updatedText };
}
