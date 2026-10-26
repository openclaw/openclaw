import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import { isValidAgentId, normalizeAgentIdStrict } from "../../../routing/session-key.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function resolveSubagentChildAgentId(entry: {
  childSessionKey?: string;
  childAgentId?: string;
}): string | undefined {
  const key = entry.childSessionKey?.trim();
  if (!key) {
    return undefined;
  }
  const qualified = /^agent:/i.test(key);
  const parsed = parseAgentSessionKeyParts(key);
  if (qualified && (!parsed || !isValidAgentId(parsed.agentId))) {
    return undefined;
  }
  const keyOwner = parsed?.agentId.toLowerCase();
  if (entry.childAgentId === undefined) {
    return keyOwner;
  }
  if (typeof entry.childAgentId !== "string" || !isValidAgentId(entry.childAgentId)) {
    return undefined;
  }
  const owner = normalizeAgentIdStrict(entry.childAgentId);
  return owner.ok && (!keyOwner || keyOwner === owner.value) ? owner.value : undefined;
}

export function resolveRecordedRequester(entry: {
  requesterSessionKey: string;
  requesterAgentId?: string;
}): string | undefined {
  return resolveSubagentChildAgentId({
    childSessionKey: entry.requesterSessionKey,
    childAgentId: entry.requesterAgentId,
  });
}

type ChildAuthorityEntry = Pick<
  SubagentRunRecord,
  "childSessionKey" | "childAgentId" | "childSessionIdentity"
> &
  Partial<Pick<SubagentRunRecord, "requesterSessionKey" | "requesterAgentId">>;
type SessionIdentity = { sessionId?: string; lifecycleRevision?: string };

export function matchesSubagentChildSessionIdentity(
  entry: Pick<SubagentRunRecord, "childSessionIdentity">,
  currentSession: SessionIdentity | null,
): boolean {
  const original = entry.childSessionIdentity;
  return (
    (!original?.sessionId || original.sessionId === currentSession?.sessionId) &&
    (!original?.lifecycleRevision ||
      original.lifecycleRevision === currentSession?.lifecycleRevision)
  );
}

type SubagentChildAuthority =
  | {
      status: "verified";
      childAgentId: string;
      requesterAgentId?: string;
      sessionIdentity: { sessionId: string; lifecycleRevision: string };
    }
  | { status: "legacy-unverified"; childAgentId: string; requesterAgentId: string; error: string }
  | { status: "mismatch"; error: string };

export function resolveSubagentChildAuthority(
  entry: ChildAuthorityEntry,
  currentSession?: SessionIdentity | null,
): SubagentChildAuthority {
  const refusal = (reason: string) =>
    `Cannot operate on this subagent because its ${reason}. No child work was changed. Inspect the retained record and original execution evidence before retrying.`;
  const childAgentId = resolveSubagentChildAgentId(entry);
  if (!childAgentId) {
    return { status: "mismatch", error: refusal("owning agent is unresolved") };
  }
  const original = entry.childSessionIdentity;
  const sessionId = original?.sessionId?.trim();
  const lifecycleRevision = original?.lifecycleRevision?.trim();
  if (currentSession !== undefined && !matchesSubagentChildSessionIdentity(entry, currentSession)) {
    return { status: "mismatch", error: refusal("original session incarnation changed") };
  }
  const requesterAgentId = resolveSubagentChildAgentId({
    childSessionKey: entry.requesterSessionKey,
    childAgentId: entry.requesterAgentId,
  });
  if (!sessionId || !lifecycleRevision) {
    return requesterAgentId
      ? {
          status: "legacy-unverified",
          childAgentId,
          requesterAgentId,
          error: refusal("original session incarnation is unresolved"),
        }
      : { status: "mismatch", error: refusal("requester ownership is unresolved") };
  }
  return {
    status: "verified",
    childAgentId,
    requesterAgentId,
    sessionIdentity: { sessionId, lifecycleRevision },
  };
}

// New runs record ownership; report unsettled legacy work once per process.
let warnedLegacyAuthority = false;
export function warnLegacySubagentAuthority(
  entries: Iterable<SubagentRunRecord>,
  warn: (message: string, meta?: Record<string, unknown>) => void,
): void {
  if (warnedLegacyAuthority) {
    return;
  }
  const runIds = new Set<string>();
  const sampleRunIds: string[] = [];
  for (const entry of entries) {
    if (
      !entry.requesterSettleWake &&
      (entry.cleanupCompletedAt !== undefined ||
        (entry.execution.status === "terminal" && entry.suppressCompletionDelivery))
    ) {
      continue;
    }
    if (
      !runIds.has(entry.runId) &&
      resolveSubagentChildAuthority(entry).status === "legacy-unverified"
    ) {
      runIds.add(entry.runId);
      if (sampleRunIds.length < 3) {
        sampleRunIds.push(entry.runId);
      }
    }
  }
  if (runIds.size === 0) {
    return;
  }
  warnedLegacyAuthority = true;
  warn(
    "Subagent original session identity or lifecycle revision is unavailable; requester work continues with child-session effects suppressed.",
    { count: runIds.size, sampleRunIds },
  );
}

// Leaf module: registry memory, queries, and generation helpers import this, so it
// must not depend on config or agent-scope (that closes an import cycle).
export function matchesSubagentChildSessionOwner(
  entry: { childSessionKey?: string; childAgentId?: string },
  childSessionKey: string,
  childAgentId?: string,
): boolean {
  if (entry.childSessionKey !== childSessionKey) {
    return false;
  }
  const owner = resolveSubagentChildAgentId(entry);
  return (
    owner !== undefined && owner === resolveSubagentChildAgentId({ childSessionKey, childAgentId })
  );
}
