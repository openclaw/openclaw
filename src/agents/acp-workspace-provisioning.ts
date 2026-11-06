/**
 * Turn-level ACP workspace provisioning resolution (#92015).
 *
 * Resolves the provisioning mode for one concrete invocation by using the
 * invocation's own cwd — the live session's ACP meta cwd first, then the
 * configured ACP binding that owns the session key — instead of an agent-wide
 * binding scan, so mixed-binding agents and workspace-equal cwds keep standard
 * bootstrap behavior.
 */
import { resolveAcpSessionCwd } from "@openclaw/acp-core/runtime/session-identifiers";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  isImplicitAcpWorkspaceCandidate,
  resolveAgentWorkspaceProvisioning,
  type AgentWorkspaceProvisioning,
} from "./agent-scope-config.js";

export async function resolveAcpAgentWorkspaceProvisioningForTurn(params: {
  cfg: OpenClawConfig;
  agentId: string;
  /** Workspace directory being provisioned for this turn, when already known. */
  workspaceDir?: string;
  /** Effective cwd explicitly selected for this invocation, when already known. */
  cwd?: string;
  /** Session key for this invocation, when already known. */
  sessionKey?: string;
  /** Live session entry carrying ACP meta, when already at hand. */
  sessionEntry?: { acp?: SessionAcpMeta };
}): Promise<AgentWorkspaceProvisioning> {
  if (!isImplicitAcpWorkspaceCandidate(params.cfg, params.agentId)) {
    return "standard";
  }
  const invocation = params.workspaceDir ? { workspaceDir: params.workspaceDir } : undefined;
  // A live ACP session carries this invocation's effective cwd.
  let cwd = params.cwd || resolveAcpSessionCwd(params.sessionEntry?.acp);
  // Configured conversation bindings are conversation-scoped: resolve the one
  // binding that owns this session key rather than scanning every binding.
  if (!cwd && params.sessionKey) {
    const { resolveConfiguredAcpBindingSpecBySessionKey } =
      await import("../acp/persistent-bindings.resolve.js");
    cwd = resolveConfiguredAcpBindingSpecBySessionKey({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    })?.cwd;
  }
  // No invocation cwd known: the agent-global runtime acp.cwd default (if any)
  // still applies; otherwise the run falls back to the workspace as cwd.
  return resolveAgentWorkspaceProvisioning(
    params.cfg,
    params.agentId,
    cwd ? { ...invocation, cwd } : invocation,
  );
}
