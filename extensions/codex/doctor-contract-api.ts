/** Doctor contract hooks for Codex config, state migration, and route ownership. */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasRetiredDynamicToolsProfile(value: unknown): boolean {
  return Object.hasOwn(asRecord(value) ?? {}, "codexDynamicToolsProfile");
}

function hasLegacyPluginDestructivePolicy(value: unknown): boolean {
  const codexPlugins = asRecord(value);
  if (!codexPlugins) {
    return false;
  }
  if (codexPlugins.allow_destructive_actions === "on-request") {
    return true;
  }
  const plugins = asRecord(codexPlugins.plugins);
  return Object.values(plugins ?? {}).some(
    (plugin) => asRecord(plugin)?.allow_destructive_actions === "on-request",
  );
}

/** Legacy Codex config keys that doctor should report or repair. */
export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "codex", "config"],
    message:
      'plugins.entries.codex.config.codexDynamicToolsProfile is retired; Codex app-server always keeps Codex-native workspace tools native. Run "openclaw doctor --fix".',
    match: hasRetiredDynamicToolsProfile,
  },
  {
    path: ["plugins", "entries", "codex", "config", "codexPlugins"],
    message:
      'plugins.entries.codex.config.codexPlugins.allow_destructive_actions="on-request" was renamed to "auto". Run "openclaw doctor --fix".',
    match: hasLegacyPluginDestructivePolicy,
  },
];

/** Removes retired Codex plugin config keys while preserving unrelated config. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const rawEntry = asRecord(cfg.plugins?.entries?.codex);
  const rawPluginConfig = asRecord(rawEntry?.config);
  const rawCodexPlugins = asRecord(rawPluginConfig?.codexPlugins);
  const shouldRemoveDynamicToolsProfile =
    rawPluginConfig !== null && hasRetiredDynamicToolsProfile(rawPluginConfig);
  const shouldRewriteDestructivePolicy = hasLegacyPluginDestructivePolicy(rawCodexPlugins);
  if (!rawPluginConfig || (!shouldRemoveDynamicToolsProfile && !shouldRewriteDestructivePolicy)) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg) as OpenClawConfig & {
    plugins?: Record<string, unknown>;
  };
  const nextPluginConfig = asRecord(
    asRecord(asRecord(asRecord(nextConfig.plugins)?.entries)?.codex)?.config,
  );
  if (!nextPluginConfig) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  if (shouldRemoveDynamicToolsProfile) {
    delete nextPluginConfig.codexDynamicToolsProfile;
    changes.push(
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
    );
  }

  if (shouldRewriteDestructivePolicy) {
    const nextCodexPlugins = asRecord(nextPluginConfig.codexPlugins);
    if (nextCodexPlugins?.allow_destructive_actions === "on-request") {
      nextCodexPlugins.allow_destructive_actions = "auto";
    }
    const nextPluginPolicies = asRecord(nextCodexPlugins?.plugins);
    for (const plugin of Object.values(nextPluginPolicies ?? {})) {
      const nextPlugin = asRecord(plugin);
      if (nextPlugin?.allow_destructive_actions === "on-request") {
        nextPlugin.allow_destructive_actions = "auto";
      }
    }
    changes.push(
      'Renamed plugins.entries.codex.config.codexPlugins allow_destructive_actions="on-request" values to "auto".',
    );
  }

  return {
    config: nextConfig,
    changes,
  };
}

/** Session/auth ownership metadata used by doctor route-state checks. */
export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "codex",
    label: "Codex",
    providerIds: ["codex", "codex-cli", "openai-codex"],
    runtimeIds: ["codex", "codex-cli"],
    cliSessionKeys: ["codex-cli"],
    authProfilePrefixes: ["codex:", "codex-cli:", "openai-codex:"],
  },
];

export { stateMigrations } from "./src/migration/session-binding-sidecars.js";
