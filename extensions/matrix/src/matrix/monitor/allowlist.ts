import type { AllowlistMatch } from "openclaw/plugin-sdk";

function normalizeAllowList(list?: Array<string | number>) {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

<<<<<<< HEAD
export function normalizeAllowListLower(list?: Array<string | number>) {
  return normalizeAllowList(list).map((entry) => entry.toLowerCase());
}

function normalizeMatrixUser(raw?: string | null): string {
  return (raw ?? "").trim().toLowerCase();
}

export type MatrixAllowListMatch = AllowlistMatch<
  "wildcard" | "id" | "prefixed-id" | "prefixed-user" | "name" | "localpart"
=======
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
>>>>>>> upstream/main
>;

export function resolveMatrixAllowListMatch(params: {
  allowList: string[];
  userId?: string;
<<<<<<< HEAD
  userName?: string;
=======
>>>>>>> upstream/main
}): MatrixAllowListMatch {
  const allowList = params.allowList;
  if (allowList.length === 0) {
    return { allowed: false };
  }
  if (allowList.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  const userId = normalizeMatrixUser(params.userId);
<<<<<<< HEAD
  const userName = normalizeMatrixUser(params.userName);
  const localPart = userId.startsWith("@") ? (userId.slice(1).split(":")[0] ?? "") : "";
=======
>>>>>>> upstream/main
  const candidates: Array<{ value?: string; source: MatrixAllowListMatch["matchSource"] }> = [
    { value: userId, source: "id" },
    { value: userId ? `matrix:${userId}` : "", source: "prefixed-id" },
    { value: userId ? `user:${userId}` : "", source: "prefixed-user" },
<<<<<<< HEAD
    { value: userName, source: "name" },
    { value: localPart, source: "localpart" },
=======
>>>>>>> upstream/main
  ];
  for (const candidate of candidates) {
    if (!candidate.value) {
      continue;
    }
    if (allowList.includes(candidate.value)) {
      return {
        allowed: true,
        matchKey: candidate.value,
        matchSource: candidate.source,
      };
    }
  }
  return { allowed: false };
}

<<<<<<< HEAD
export function resolveMatrixAllowListMatches(params: {
  allowList: string[];
  userId?: string;
  userName?: string;
}) {
=======
export function resolveMatrixAllowListMatches(params: { allowList: string[]; userId?: string }) {
>>>>>>> upstream/main
  return resolveMatrixAllowListMatch(params).allowed;
}
