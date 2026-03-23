/**
 * Extract native WhatsApp mention JIDs from outbound message text.
 *
 * Scans for `@+<digits>` or `@<digits>` patterns (7–25 digits, covers both
 * E.164 phone numbers and WhatsApp LID identifiers) and returns a deduplicated
 * array of JIDs suitable for Baileys' `mentions` field.
 *
 * When a `participantJidMap` is provided (mapping normalized "+digits" to the
 * participant's original JID), the original JID is used — this ensures LID
 * participants get `<lid>@lid` instead of the incorrect `<lid>@s.whatsapp.net`.
 */
export function extractOutboundMentions(
  text: string,
  participantJidMap?: Map<string, string>,
): string[] {
  const pattern = /(?<![^\s])@\+?(\d{7,25})/g;
  const jids = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const digits = match[1]!;
    const normalized = `+${digits}`;
    const originalJid = participantJidMap?.get(normalized);
    jids.add(originalJid ?? `${digits}@s.whatsapp.net`);
  }
  return Array.from(jids);
}
