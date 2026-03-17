function toGroupCandidate(value) {
  return value?.trim() ?? "";
}
function normalizeZalouserGroupSlug(raw) {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function buildZalouserGroupCandidates(params) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  const push = (value) => {
    const normalized = toGroupCandidate(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    out.push(normalized);
  };
  const groupId = toGroupCandidate(params.groupId);
  const groupChannel = toGroupCandidate(params.groupChannel);
  const groupName = toGroupCandidate(params.groupName);
  push(groupId);
  if (params.includeGroupIdAlias === true && groupId) {
    push(`group:${groupId}`);
  }
  if (params.allowNameMatching !== false) {
    push(groupChannel);
    push(groupName);
    if (groupName) {
      push(normalizeZalouserGroupSlug(groupName));
    }
  }
  if (params.includeWildcard !== false) {
    push("*");
  }
  return out;
}
function findZalouserGroupEntry(groups, candidates) {
  if (!groups) {
    return void 0;
  }
  for (const candidate of candidates) {
    const entry = groups[candidate];
    if (entry) {
      return entry;
    }
  }
  return void 0;
}
function isZalouserGroupEntryAllowed(entry) {
  if (!entry) {
    return false;
  }
  return entry.allow !== false && entry.enabled !== false;
}
export {
  buildZalouserGroupCandidates,
  findZalouserGroupEntry,
  isZalouserGroupEntryAllowed,
  normalizeZalouserGroupSlug
};
