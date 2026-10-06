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

export function resolveSubagentChildAuthorityError(
  entry: Pick<SubagentRunRecord, "childSessionKey" | "childAgentId" | "childSessionIdentity">,
): string | undefined {
  const missing = !resolveSubagentChildAgentId(entry)
    ? "owning agent"
    : !entry.childSessionIdentity?.sessionId?.trim()
      ? "original session incarnation"
      : undefined;
  return missing
    ? `Cannot operate on this subagent because its ${missing} is unresolved. No child work was changed. Inspect the retained record and original execution evidence before retrying.`
    : undefined;
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
