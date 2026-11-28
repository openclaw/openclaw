import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentIdStrict } from "../../routing/session-key.js";
import { listAgentIds } from "../agent-scope-config.js";
import { resolveLegacyInheritedAuthAgentDir } from "../legacy-inherited-auth-dir.js";
import { getPreparedSharedAuthStoreOwnership } from "./path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";

/** Explicit recovery of the canonical shared owner after its agent left the roster. */
export function resolveSharedMainAuthLoginTarget(
  config: OpenClawConfig,
  requestedAgentId: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { agentId: string; agentDir: string } | undefined {
  if (typeof requestedAgentId !== "string") {
    return undefined;
  }
  const requested = normalizeAgentIdStrict(requestedAgentId.trim());
  if (
    !requested.ok ||
    requested.value !== LEGACY_IMPLICIT_AGENT_ID ||
    config.agents?.defaults?.authInheritance?.agentId?.trim() !== LEGACY_IMPLICIT_AGENT_ID ||
    listAgentIds(config).includes(LEGACY_IMPLICIT_AGENT_ID)
  ) {
    return undefined;
  }
  const agentDir = resolveSharedMainAuthAgentDir(env);
  // Before relocation, a custom inherited directory is a different credential owner.
  if (
    getPreparedSharedAuthStoreOwnership(env)?.location !== "state-db" &&
    path.resolve(resolveLegacyInheritedAuthAgentDir(config, env)) !== path.resolve(agentDir)
  ) {
    return undefined;
  }
  return { agentId: LEGACY_IMPLICIT_AGENT_ID, agentDir };
}
