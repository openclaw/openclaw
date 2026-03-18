import {
  compileAllowlist,
  normalizeStringEntries,
  resolveCompiledAllowlistMatch,
  type AllowlistMatch,
} from "../../../runtime-api.js";

function normalizeAllowList(list?: Array<string | number>) {
  return normalizeStringEntries(list);
}

function normalizeMatrixUser(raw?: string | null): string {
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

export function normalizeMatrixUserId(raw?: string | null): string {
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

function normalizeMatrixAllowListEntry(raw: string): string {
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

export function normalizeMatrixAllowList(list?: Array<string | number>) {
  return normalizeAllowList(list).map((entry) => normalizeMatrixAllowListEntry(entry));
}

export type MatrixAllowListMatch = AllowlistMatch<
  "wildcard" | "id" | "prefixed-id" | "prefixed-user"
>;
type MatrixAllowListSource = Exclude<MatrixAllowListMatch["matchSource"], undefined>;

export function resolveMatrixAllowListMatch(params: {
  allowList: string[];
  userId?: string;
}): MatrixAllowListMatch {
  const compiledAllowList = compileAllowlist(params.allowList);
  const userId = normalizeMatrixUser(params.userId);
  const candidates: Array<{ value?: string; source: MatrixAllowListSource }> = [
    { value: userId, source: "id" },
    { value: userId ? `matrix:${userId}` : "", source: "prefixed-id" },
    { value: userId ? `user:${userId}` : "", source: "prefixed-user" },
  ];
  return resolveCompiledAllowlistMatch({
    compiledAllowlist: compiledAllowList,
    candidates,
  });
}

export function resolveMatrixAllowListMatches(params: { allowList: string[]; userId?: string }) {
  return resolveMatrixAllowListMatch(params).allowed;
}
