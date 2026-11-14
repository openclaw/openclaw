import {
  resolveAllowlistMatchByCandidates,
  type AllowlistMatch,
} from "openclaw/plugin-sdk/allow-from";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  expandAllowFromWithAccessGroups,
  parseAccessGroupAllowFromEntry,
} from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-normalization-runtime";

function normalizeMatrixUser(raw?: string | null): string {
  const value = (raw ?? "").trim();
  if (!value) {
    return "";
  }
  if (!value.startsWith("@") || !value.includes(":")) {
    return normalizeLowercaseStringOrEmpty(value);
  }
  return value;
}

export function normalizeMatrixUserId(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
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
  // Access groups stay symbolic: the ingress resolver expands them against the
  // configured group, so lower-casing the reference would make it unresolvable.
  if (parseAccessGroupAllowFromEntry(trimmed) != null) {
    return trimmed;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (lowered.startsWith("matrix:")) {
    return `matrix:${normalizeMatrixUser(trimmed.slice("matrix:".length))}`;
  }
  if (lowered.startsWith("user:")) {
    return `user:${normalizeMatrixUser(trimmed.slice("user:".length))}`;
  }
  return normalizeMatrixUser(trimmed);
}

export function normalizeMatrixAllowList(list?: Array<string | number>) {
  return normalizeStringEntries(list).map(normalizeMatrixAllowListEntry);
}

type MatrixAllowListMatch = AllowlistMatch<"wildcard" | "id" | "prefixed-id" | "prefixed-user">;

type MatrixAllowListMatchSource = NonNullable<MatrixAllowListMatch["matchSource"]>;

export function resolveMatrixAllowListMatch(params: {
  allowList: string[];
  userId?: string;
}): MatrixAllowListMatch {
  const allowList = params.allowList;
  const userId = normalizeMatrixUser(params.userId);
  const candidates: Array<{ value?: string; source: MatrixAllowListMatchSource }> = [
    { value: userId, source: "id" },
    { value: userId ? `matrix:${userId}` : "", source: "prefixed-id" },
    { value: userId ? `user:${userId}` : "", source: "prefixed-user" },
  ];
  return resolveAllowlistMatchByCandidates<MatrixAllowListMatchSource>({ allowList, candidates });
}

/**
 * Resolves a supplemental-context sender against a room allowlist that may keep
 * `accessGroup:` references symbolic. Literal ids and wildcards match first; group
 * references are expanded with the shared membership owner for this one sender.
 */
export async function resolveMatrixContextSenderAllowed(params: {
  cfg?: Pick<OpenClawConfig, "accessGroups">;
  allowList: string[];
  accountId: string;
  senderId?: string;
}): Promise<boolean> {
  const { cfg, allowList, accountId, senderId } = params;
  if (!senderId || allowList.length === 0) {
    return true;
  }
  const matches = (entries: string[]) =>
    resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(entries),
      userId: senderId,
    }).allowed;
  if (matches(allowList)) {
    return true;
  }
  if (!cfg) {
    return false;
  }
  const expanded = await expandAllowFromWithAccessGroups({
    // SAFETY: CoreConfig is the runtime OpenClawConfig view; expansion reads only accessGroups.
    cfg: cfg as OpenClawConfig,
    allowFrom: allowList,
    channel: "matrix",
    accountId,
    senderId,
    isSenderAllowed: (candidateSenderId, entries) =>
      resolveMatrixAllowListMatch({
        allowList: normalizeMatrixAllowList(entries),
        userId: candidateSenderId,
      }).allowed,
  });
  return matches(expanded);
}
