import { normalizeAgentIdStrict } from "../../../routing/session-key.js";

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
  // Unbound legacy rows and callers without an owner retain raw-key matching.
  if (!entry.childAgentId || childAgentId === undefined) {
    return true;
  }
  const owner = normalizeAgentIdStrict(childAgentId);
  return owner.ok && entry.childAgentId === owner.value;
}
