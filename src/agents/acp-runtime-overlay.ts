import { isAcpSessionKey } from "../routing/session-key.js";

/**
 * Leaf type for agent runtime classification. Defined here so that
 * agent-runtime-metadata.ts can import applyAcpRuntimeOverlay without
 * creating a circular dependency (agent-runtime-metadata → acp-runtime-overlay
 * → agent-runtime-metadata).  agent-runtime-metadata.ts re-exports this type
 * so all existing consumers remain unaffected.
 */
export type AgentRuntimeMetadata = {
  id: string;
  source: "implicit" | "model" | "provider" | "session-key";
};

/**
 * When a session key unambiguously identifies an ACP session (contains the `:acp:`
 * segment), override the resolved runtime metadata to report the ACP runtime id
 * with a "session-key" source — regardless of what the agent-config policy
 * resolved to.  Without this overlay, callers that only have agent-config context
 * (no model/provider) fall back to `id: "pi"` even though the session key makes
 * the actual runtime unambiguous.
 *
 * Callers that already have model/provider context (resolveModelAgentRuntimeMetadata)
 * still benefit here because the model-runtime policy chain does not inspect session
 * keys for the ACP indicator.
 *
 * When `acpBackend` is provided and non-empty, it is used as the runtime id so that
 * sessions backed by a configured non-default ACP backend (e.g. a custom registered
 * backend) are reported faithfully instead of always being labelled "acpx".
 * Falls back to "acpx" when no backend is known.
 */
export function applyAcpRuntimeOverlay(
  meta: AgentRuntimeMetadata,
  sessionKey: string | undefined | null,
  acpBackend?: string,
): AgentRuntimeMetadata {
  if (isAcpSessionKey(sessionKey)) {
    const id = acpBackend && acpBackend.length > 0 ? acpBackend : "acpx";
    return { id, source: "session-key" };
  }
  return meta;
}
