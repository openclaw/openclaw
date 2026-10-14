/** Applies persisted ACP ownership to agent runtime classification. */

/**
 * Leaf type for agent runtime classification. Defined here so that
 * agent-runtime-metadata.ts can import applyAcpRuntimeOverlay without
 * creating a circular dependency (agent-runtime-metadata → acp-runtime-overlay
 * → agent-runtime-metadata).
 */
export type AgentRuntimeMetadata = {
  id: string;
  source: "implicit" | "model" | "provider" | "session" | "session-key";
};

/** Persisted ACP ownership is authoritative even for ordinary session keys. */
export function applyAcpRuntimeOverlay(
  meta: AgentRuntimeMetadata,
  acpRuntime: boolean | undefined,
  acpBackend?: string,
): AgentRuntimeMetadata {
  if (acpRuntime === true) {
    const id = acpBackend && acpBackend.length > 0 ? acpBackend : "acpx";
    return { id, source: "session-key" };
  }
  return meta;
}
