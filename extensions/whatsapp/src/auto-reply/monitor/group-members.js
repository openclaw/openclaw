import { normalizeE164 } from "../../../../../src/utils.js";
function appendNormalizedUnique(entries, seen, ordered) {
  for (const entry of entries) {
    const normalized = normalizeE164(entry) ?? entry;
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
}
function noteGroupMember(groupMemberNames, conversationId, e164, name) {
  if (!e164 || !name) {
    return;
  }
  const normalized = normalizeE164(e164);
  const key = normalized ?? e164;
  if (!key) {
    return;
  }
  let roster = groupMemberNames.get(conversationId);
  if (!roster) {
    roster = /* @__PURE__ */ new Map();
    groupMemberNames.set(conversationId, roster);
  }
  roster.set(key, name);
}
function formatGroupMembers(params) {
  const { participants, roster, fallbackE164 } = params;
  const seen = /* @__PURE__ */ new Set();
  const ordered = [];
  if (participants?.length) {
    appendNormalizedUnique(participants, seen, ordered);
  }
  if (roster) {
    appendNormalizedUnique(roster.keys(), seen, ordered);
  }
  if (ordered.length === 0 && fallbackE164) {
    const normalized = normalizeE164(fallbackE164) ?? fallbackE164;
    if (normalized) {
      ordered.push(normalized);
    }
  }
  if (ordered.length === 0) {
    return void 0;
  }
  return ordered.map((entry) => {
    const name = roster?.get(entry);
    return name ? `${name} (${entry})` : entry;
  }).join(", ");
}
export {
  formatGroupMembers,
  noteGroupMember
};
