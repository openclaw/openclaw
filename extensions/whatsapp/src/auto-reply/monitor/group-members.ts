import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";

export function noteGroupMember(
  groupMemberNames: Map<string, Map<string, string>>,
  conversationId: string,
  e164?: string,
  name?: string,
) {
  if (!e164 || !name) {
    return;
  }
  const key = normalizeE164(e164);
  if (!key) {
    return;
  }
  let roster = groupMemberNames.get(conversationId);
  if (!roster) {
    roster = new Map();
    groupMemberNames.set(conversationId, roster);
  }
  roster.set(key, name);
}

export function formatGroupMembers(params: {
  participants: string[] | undefined;
  roster: Map<string, string> | undefined;
  fallbackE164?: string;
}) {
  const { participants, roster, fallbackE164 } = params;
  const ordered = uniqueStrings(
    [...(participants ?? []), ...(roster?.keys() ?? [])].map(normalizeE164).filter(Boolean),
  );
  if (ordered.length === 0 && fallbackE164) {
    const normalized = normalizeE164(fallbackE164);
    if (normalized) {
      ordered.push(normalized);
    }
  }
  if (ordered.length === 0) {
    return undefined;
  }
  return ordered
    .map((entry) => {
      const name = roster?.get(entry);
      return name ? `${name} (${entry})` : entry;
    })
    .join(", ");
}
