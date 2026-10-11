import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import { createDedupeCache } from "../../../infra/dedupe.js";
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

type ChildAuthorityEntry = Pick<
  SubagentRunRecord,
  "childSessionKey" | "childAgentId" | "childSessionIdentity"
> &
  Partial<Pick<SubagentRunRecord, "requesterSessionKey" | "requesterAgentId">>;
type SessionIdentity = { sessionId?: string; lifecycleRevision?: string };
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
  if (
    currentSession !== undefined &&
    ((original?.sessionId && original.sessionId !== currentSession?.sessionId) ||
      (original?.lifecycleRevision &&
        original.lifecycleRevision !== currentSession?.lifecycleRevision))
  ) {
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

const legacyWarnings = createDedupeCache({ ttlMs: 0, maxSize: 4096 });
export function warnLegacySubagentAuthority(
  entry: SubagentRunRecord,
  warn: (message: string, meta?: Record<string, unknown>) => void,
): void {
  if (
    resolveSubagentChildAuthority(entry).status !== "legacy-unverified" ||
    legacyWarnings.check(JSON.stringify([entry.runId, entry.createdAt, entry.generation]))
  ) {
    return;
  }
  warn(
    "Subagent original session identity or lifecycle revision is unavailable; requester work continues with child-session effects suppressed.",
    { runId: entry.runId },
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
