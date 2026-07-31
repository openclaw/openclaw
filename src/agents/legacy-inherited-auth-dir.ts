import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { tryGetLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentDir, tryResolveSoleAgentId } from "./agent-scope-config.js";

/** Resolves the shared auth owner used until H2-2 relocates inherited credentials. */
export function resolveLegacyInheritedAuthAgentId(config: OpenClawConfig): string {
  // H2-2 owns credential relocation; this upgrade-only binding prevents marker retirement
  // from switching inherited credentials before that relocation completes.
  return (
    normalizeOptionalString(config.agents?.defaults?.authInheritance?.agentId) ??
    tryGetLegacyDefaultAgentId(config) ??
    tryResolveSoleAgentId(config) ??
    "main"
  );
}

/** Resolves the shared auth store used until H2-2 relocates inherited credentials. */
export function resolveLegacyInheritedAuthDir(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveAgentDir(config, resolveLegacyInheritedAuthAgentId(config), env);
}

/** Pins the current auth owner before a sole/fleet topology transition can change its fallback. */
export function pinLegacyInheritedAuthOwnerForRosterTransition(
  sourceConfig: OpenClawConfig,
  targetConfig: OpenClawConfig,
): OpenClawConfig {
  const sourceOwner = resolveLegacyInheritedAuthAgentId(sourceConfig);
  if (sourceOwner === resolveLegacyInheritedAuthAgentId(targetConfig)) {
    return targetConfig;
  }
  // H2-2 owns credential relocation; topology edits must not move the shared store first.
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
