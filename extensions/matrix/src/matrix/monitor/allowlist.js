import {
  compileAllowlist,
  normalizeStringEntries,
  resolveCompiledAllowlistMatch
} from "openclaw/plugin-sdk/matrix";
function normalizeAllowList(list) {
  return normalizeStringEntries(list);
}
function normalizeMatrixUser(raw) {
  const value = (raw ?? "").trim();
  if (!value) {
    return "";
  }
  if (!value.startsWith("@") || !value.includes(":")) {
    return value.toLowerCase();
  }
  const withoutAt = value.slice(1);
  const splitIndex = withoutAt.indexOf(":");
  if (splitIndex === -1) {
    return value.toLowerCase();
  }
  const localpart = withoutAt.slice(0, splitIndex).toLowerCase();
  const server = withoutAt.slice(splitIndex + 1).toLowerCase();
  if (!server) {
    return value.toLowerCase();
  }
  return `@${localpart}:${server.toLowerCase()}`;
}
function normalizeMatrixUserId(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("matrix:")) {
    return normalizeMatrixUser(trimmed.slice("matrix:".length));
  }
  if (lowered.startsWith("user:")) {
    return normalizeMatrixUser(trimmed.slice("user:".length));
  }
  return normalizeMatrixUser(trimmed);
}
function normalizeMatrixAllowListEntry(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return trimmed;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("matrix:")) {
    return `matrix:${normalizeMatrixUser(trimmed.slice("matrix:".length))}`;
  }
  if (lowered.startsWith("user:")) {
    return `user:${normalizeMatrixUser(trimmed.slice("user:".length))}`;
  }
  return normalizeMatrixUser(trimmed);
}
function normalizeMatrixAllowList(list) {
  return normalizeAllowList(list).map((entry) => normalizeMatrixAllowListEntry(entry));
}
function resolveMatrixAllowListMatch(params) {
  const compiledAllowList = compileAllowlist(params.allowList);
  const userId = normalizeMatrixUser(params.userId);
  const candidates = [
    { value: userId, source: "id" },
    { value: userId ? `matrix:${userId}` : "", source: "prefixed-id" },
    { value: userId ? `user:${userId}` : "", source: "prefixed-user" }
  ];
  return resolveCompiledAllowlistMatch({
    compiledAllowlist: compiledAllowList,
    candidates
  });
}
function resolveMatrixAllowListMatches(params) {
  return resolveMatrixAllowListMatch(params).allowed;
}
export {
  normalizeMatrixAllowList,
  normalizeMatrixUserId,
  resolveMatrixAllowListMatch,
  resolveMatrixAllowListMatches
};
