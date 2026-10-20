import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentDir, tryResolveLegacyDataOwnerAgentId } from "./agent-scope-config.js";
import { getPreparedSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "./auth-profiles/shared-main-dir.js";

export function resolveLegacyInheritedAuthAgentId(config: OpenClawConfig): string {
  return (
    normalizeOptionalString(config.agents?.defaults?.authInheritance?.agentId) ??
    tryResolveLegacyDataOwnerAgentId(config) ??
    "main"
  );
}

export function resolveLegacyInheritedAuthAgentDir(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveAgentDir(config, resolveLegacyInheritedAuthAgentId(config), env);
}

/** Select the legacy source that shared-store cutover must preserve for inherited auth. */
export function resolveLegacyInheritedAuthSourceAgentDir(
  config: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.OPENCLAW_AGENT_DIR?.trim() || !config
    ? resolveSharedMainAuthAgentDir(env)
    : resolveLegacyInheritedAuthAgentDir(config, env);
}

export function resolveLegacyInheritedAuthDir(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  preparedLegacyAgentDir?: () => string | undefined,
): string | undefined {
  return getPreparedSharedAuthStoreOwnership(env)?.location === "legacy-main"
    ? (preparedLegacyAgentDir?.() ?? resolveLegacyInheritedAuthAgentDir(config, env))
    : undefined;
}

export function pinLegacyInheritedAuthOwnerForRosterTransition(
  sourceConfig: OpenClawConfig,
  targetConfig: OpenClawConfig,
): OpenClawConfig {
  const sourceOwner = resolveLegacyInheritedAuthAgentId(sourceConfig);
  if (sourceOwner === resolveLegacyInheritedAuthAgentId(targetConfig)) {
    return targetConfig;
  }
  return {
    ...targetConfig,
    agents: {
      ...targetConfig.agents,
      defaults: {
        ...targetConfig.agents?.defaults,
        authInheritance: {
          ...targetConfig.agents?.defaults?.authInheritance,
          agentId: sourceOwner,
        },
      },
    },
  };
}

export function assertSafeLegacyInheritedAuthDirTransition(
  sourceConfig: OpenClawConfig,
  targetConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const sourceOwner = resolveLegacyInheritedAuthAgentId(sourceConfig);
  const sourceDir = resolveAgentDir(sourceConfig, sourceOwner, env);
  const conventionalDir = path.join(
    resolveStateDir(env),
    "agents",
    normalizeAgentId(sourceOwner),
    "agent",
  );
  const targetDir = resolveAgentDir(targetConfig, sourceOwner, env);
  if (path.resolve(sourceDir) === path.resolve(conventionalDir) || targetDir === sourceDir) {
    return;
  }
  throw Object.assign(
    new Error(
      `Config write refused: inherited auth for agent "${sourceOwner}" is stored in custom agentDir ${JSON.stringify(sourceDir)}, but this roster change removes or changes that directory. Relocate the credentials to ${JSON.stringify(conventionalDir)} or set agents.defaults.authInheritance explicitly for the destination owner, then retry.`,
    ),
    { code: "CONFIG_WRITE_REJECTED" },
  );
}
