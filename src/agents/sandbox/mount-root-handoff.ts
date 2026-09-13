/**
 * Mount-root handoff for host directories the sandbox layer maps container paths to.
 *
 * `sessions.create` refuses a sandboxed session cwd outside the configured agent
 * workspace. The sandbox cwd mapping layer translates a recorded container path
 * back through the source session's mount table, and the directory it lands on can
 * be an isolated sandbox workspace or an external bind target, which that guard
 * rejects. The mapping layer hands the owning root over with this marker so that
 * creation can admit exactly the host directories the sandbox layer owns; the
 * consumer re-derives those roots here instead of trusting the marker, so callers
 * that do not hand a verified root keep the original containment check.
 */
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { SANDBOX_STATE_DIR } from "./constants.js";
import { resolveSandboxBindHostRoots } from "./fs-paths.js";

export type SandboxMountRootHandoff = {
  kind: "sandbox-mount-root";
  /** Agent whose sandbox config owns the mounted root. */
  agentId: string;
  /** Host root the source session's mount table maps the container cwd onto. */
  hostRoot: string;
};

function realpathIfPresent(candidate: string): string | undefined {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Host roots the sandbox layer may mount into a container for this agent: every
 * isolated workspace copy under the configured sandbox workspace root, the
 * materialized skills workspaces, and each declared bind host directory. The
 * agent workspace itself stays out of this list; the caller checks it first.
 */
export function resolveSandboxOwnedHostRoots(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string[] {
  const sandbox = resolveSandboxConfigForAgent(params.cfg, params.agentId);
  return [
    resolveUserPath(sandbox.workspaceRoot),
    path.join(SANDBOX_STATE_DIR, "skills-workspaces"),
    ...resolveSandboxBindHostRoots(sandbox.docker.binds),
  ];
}

/**
 * Admit a handed-over root only when it names a directory the sandbox layer owns
 * for this agent and covers the requested cwd. Missing roots and a handoff for
 * another agent stay rejected, so a forged or stale marker cannot widen the
 * sandboxed session root past what the sandbox itself would mount.
 */
export function isVerifiedSandboxMountRootHandoff(params: {
  cfg: OpenClawConfig;
  agentId: string;
  /** Canonical (realpath) session cwd resolved for the creation request. */
  hostPath: string;
  handoff?: SandboxMountRootHandoff;
}): boolean {
  const handoff = params.handoff;
  if (!handoff || handoff.kind !== "sandbox-mount-root") {
    return false;
  }
  if (normalizeAgentId(handoff.agentId) !== normalizeAgentId(params.agentId)) {
    return false;
  }
  const hostRoot = realpathIfPresent(handoff.hostRoot);
  if (!hostRoot || !isPathInside(hostRoot, params.hostPath)) {
    return false;
  }
  return resolveSandboxOwnedHostRoots({ cfg: params.cfg, agentId: params.agentId }).some((root) => {
    const owned = realpathIfPresent(root);
    return owned !== undefined && isPathInside(owned, hostRoot);
  });
}
