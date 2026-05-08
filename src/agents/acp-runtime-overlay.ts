import { isAcpSessionKey } from "../routing/session-key.js";
import type { AgentRuntimeMetadata } from "./agent-runtime-metadata.js";

/**
 * When a session key unambiguously identifies an ACP session (contains the `:acp:`
 * segment), override the resolved runtime metadata to report the ACP runtime id
 * ("acpx") with a "session-key" source — regardless of what the agent-config policy
 * resolved to.  Without this overlay, callers that only have agent-config context
 * (no model/provider) fall back to `id: "pi"` even though the session key makes
 * the actual runtime unambiguous.
 *
 * Callers that already have model/provider context (resolveModelAgentRuntimeMetadata)
 * still benefit here because the model-runtime policy chain does not inspect session
 * keys for the ACP indicator.
 */
export function applyAcpRuntimeOverlay(
  meta: AgentRuntimeMetadata,
  sessionKey: string | undefined | null,
): AgentRuntimeMetadata {
  if (isAcpSessionKey(sessionKey)) {
    return { id: "acpx", source: "session-key" };
  }
  return meta;
}
