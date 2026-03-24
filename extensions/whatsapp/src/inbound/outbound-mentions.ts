/**
 * Extract native WhatsApp mention JIDs from outbound message text.
 *
 * Scans for `@+<digits>` or `@<digits>` patterns (7–25 digits, covers both
 * E.164 phone numbers and WhatsApp LID identifiers) and returns a deduplicated
 * array of JIDs suitable for Baileys' `mentions` field.
 *
 * Requires both a leading token boundary (whitespace or start-of-string) and a
 * trailing token boundary (whitespace, punctuation, or end-of-string) to avoid
 * false positives on pasted JIDs like `@123456:1@lid` or `@1234567890abc`.
 * Tokens inside backtick code spans are skipped.
 *
 * When a `participantJidMap` is provided (mapping normalized "+digits" to the
 * participant's original JID), the original JID is used — this ensures LID
 * participants get `<lid>@lid` instead of the incorrect `<lid>@s.whatsapp.net`.
 */
export function extractOutboundMentions(
  text: string,
  participantJidMap?: Map<string, string>,
): string[] {
  // Replace inline code spans (single, double, and triple backtick) with
  // underscores (a non-boundary char) so that adjacent tokens don't merge
  // into false mentions and content inside code spans is never matched.
  const cleaned = text.replace(/(`{1,3})[\s\S]*?\1/g, (m) => "_".repeat(m.length));
  const pattern = /(?<=^|[\s({\[<])@\+?(\d{7,25})(?![:\d@\p{L}_\-/])(?!\.[\p{L}\d])/gu;
  const jids = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    const digits = match[1]!;
    const normalized = `+${digits}`;
    const originalJid = participantJidMap?.get(normalized);
    jids.add(originalJid ?? `${digits}@s.whatsapp.net`);
  }
  return Array.from(jids);
}
