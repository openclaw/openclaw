import { statSync } from "node:fs";
import path from "node:path";
import { safePathSegmentHashed } from "@openclaw/fs-safe/advanced";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveConfigDir, resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { codexOrphanedSessionBindingMigration } from "./src/migration/session-binding-orphans.js";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

function isStaleManagedCodexGenerationCommand(command: unknown): boolean {
  try {
    if (typeof command !== "string") {
      return false;
    }
    const trimmed = command.trim();
    const hasHomePrefix = trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\");
    if (!trimmed || (!path.isAbsolute(trimmed) && !hasHomePrefix)) {
      return false;
    }

    const resolved = resolveUserPath(trimmed);
    const projectsDir = path.join(resolveConfigDir(process.env), "npm", "projects");
    const relative = path.relative(projectsDir, resolved);
    const [name, ...remainingSegments] = relative.split(path.sep);
    if (!name || remainingSegments.length === 0) {
      return false;
    }
    const projectDir = path.join(projectsDir, name);
    if (path.dirname(projectDir) !== projectsDir) {
      return false;
    }

    // The generation directory shape is owned by src/plugins/install-paths.ts.
    const generationPrefix = `${safePathSegmentHashed("@openclaw/codex")}__openclaw-generation__`;
    if (
      !name.startsWith(generationPrefix) ||
      !/^g-[a-f0-9]{16}$/u.test(name.slice(generationPrefix.length))
    ) {
      return false;
    }

    try {
      statSync(projectDir);
      return false;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      return code === "ENOENT" || code === "ENOTDIR";
    }
  } catch {
    return false;
  }
}

function hasRetiredDynamicToolsProfile(value: unknown): boolean {
  return Object.hasOwn(asNullableRecord(value) ?? {}, "codexDynamicToolsProfile");
}

function hasRetiredCyberFailoverModel(value: unknown): boolean {
  return Object.hasOwn(asNullableRecord(value) ?? {}, "model");
}

function hasLegacyPluginDestructivePolicy(value: unknown): boolean {
  const codexPlugins = asNullableRecord(value);
  if (!codexPlugins) {
    return false;
  }
  if (codexPlugins.allow_destructive_actions === "on-request") {
    return true;
  }
  const plugins = asNullableRecord(codexPlugins.plugins);
  return Object.values(plugins ?? {}).some(
    (plugin) => asNullableRecord(plugin)?.allow_destructive_actions === "on-request",
  );
}

function hasRetiredApprovalPolicy(value: unknown): boolean {
  const approvalPolicy = asNullableRecord(value)?.approvalPolicy;
  return approvalPolicy === "on-failure" || approvalPolicy === "untrusted";
}

function hasBlankNetworkProxyOptionalFields(value: unknown): boolean {
  const appServer = asNullableRecord(value);
  const networkProxy = asNullableRecord(appServer?.networkProxy);
  return (
    networkProxy?.enabled === true &&
    [networkProxy.profileName, appServer?.remoteWorkspaceRoot].some(
      (field) => typeof field === "string" && !field.trim(),
    )
  );
}

// These keys shipped in v2026.8.1; only Doctor consumes them after retirement.
const RETIRED_TURN_IDLE_TIMEOUT_KEYS = [
  "turnCompletionIdleTimeoutMs",
  "turnAssistantCompletionIdleTimeoutMs",
  "postToolRawAssistantCompletionIdleTimeoutMs",
] as const;

function hasRetiredTurnIdleTimeout(value: unknown): boolean {
  const appServer = asNullableRecord(value);
  return (
    appServer !== null &&
    RETIRED_TURN_IDLE_TIMEOUT_KEYS.some((key) => Object.hasOwn(appServer, key))
  );
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "codex", "config", "appServer", "cyberFailover"],
    message:
      'plugins.entries.codex.config.appServer.cyberFailover.model is retired; automatic cyber-policy retries use the active model through approved Daybreak access. Run "openclaw doctor --fix" to remove it.',
    match: hasRetiredCyberFailoverModel,
  },
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
  {
    path: ["plugins", "entries", "codex", "config", "appServer"],
    message:
      'plugins.entries.codex.config.appServer.approvalPolicy values "on-failure" and "untrusted" are retired; use "on-request". Run "openclaw doctor --fix".',
    match: hasRetiredApprovalPolicy,
  },
  {
    path: ["plugins", "entries", "codex", "config", "appServer"],
    message:
      'Codex app-server turn idle timeouts are retired; native Codex owns provider liveness and turn completion. The existing agents.defaults.timeoutSeconds run limit remains unchanged. Run "openclaw doctor --fix" to remove the old settings.',
    match: hasRetiredTurnIdleTimeout,
  },
  {
    path: ["plugins", "entries", "codex", "config", "appServer"],
    message:
      'Blank plugins.entries.codex.config.appServer.networkProxy.profileName or appServer.remoteWorkspaceRoot must be removed to use the defaults with network restrictions. Run "openclaw doctor --fix".',
    match: hasBlankNetworkProxyOptionalFields,
  },
];

/**
 * Repairs legacy Codex plugin config while preserving unrelated config.
 */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const rawEntry = asNullableRecord(cfg.plugins?.entries?.codex);
  const rawPluginConfig = asNullableRecord(rawEntry?.config);
  const rawCodexPlugins = asNullableRecord(rawPluginConfig?.codexPlugins);
  const rawAppServer = asNullableRecord(rawPluginConfig?.appServer);
  const hasStaleManagedCodexGenerationCommand = isStaleManagedCodexGenerationCommand(
    rawAppServer?.command,
  );

  if (
    !rawPluginConfig ||
    (!hasRetiredDynamicToolsProfile(rawPluginConfig) &&
      !hasLegacyPluginDestructivePolicy(rawCodexPlugins) &&
      !hasRetiredApprovalPolicy(rawAppServer) &&
      !hasRetiredTurnIdleTimeout(rawAppServer) &&
      !hasRetiredCyberFailoverModel(rawAppServer?.cyberFailover) &&
      !hasBlankNetworkProxyOptionalFields(rawAppServer) &&
      !hasStaleManagedCodexGenerationCommand)
  ) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg);
  const nextPluginConfig = nextConfig.plugins!.entries!.codex!.config!;

  const changes: string[] = [];
  if (hasRetiredDynamicToolsProfile(nextPluginConfig)) {
    delete nextPluginConfig.codexDynamicToolsProfile;
    changes.push(
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
    );
  }

  const nextCodexPlugins = asNullableRecord(nextPluginConfig.codexPlugins);
  if (hasLegacyPluginDestructivePolicy(nextCodexPlugins)) {
    if (nextCodexPlugins?.allow_destructive_actions === "on-request") {
      nextCodexPlugins.allow_destructive_actions = "auto";
    }
    const nextPluginPolicies = asNullableRecord(nextCodexPlugins?.plugins);
    for (const plugin of Object.values(nextPluginPolicies ?? {})) {
      const nextPlugin = asNullableRecord(plugin);
      if (nextPlugin?.allow_destructive_actions === "on-request") {
        nextPlugin.allow_destructive_actions = "auto";
      }
    }
    changes.push(
      'Renamed plugins.entries.codex.config.codexPlugins allow_destructive_actions="on-request" values to "auto".',
    );
  }

  const nextAppServer = asNullableRecord(nextPluginConfig.appServer);
  if (nextAppServer && hasStaleManagedCodexGenerationCommand) {
    delete nextAppServer.command;
    changes.push(
      "Removed plugins.entries.codex.config.appServer.command; it pointed into an OpenClaw-managed Codex plugin generation that no longer exists. Without it, stdio Codex app-server starts use managed binary selection (or OPENCLAW_CODEX_APP_SERVER_BIN when set).",
    );
  }

  const nextCyberFailover = asNullableRecord(nextAppServer?.cyberFailover);
  if (nextCyberFailover && hasRetiredCyberFailoverModel(nextCyberFailover)) {
    delete nextCyberFailover.model;
    changes.push(
      "Removed retired plugins.entries.codex.config.appServer.cyberFailover.model; automatic cyber-policy retries use the active model through approved Daybreak access. Existing mode and cooloffMs settings were not changed.",
    );
  }

  if (nextAppServer && hasRetiredTurnIdleTimeout(nextAppServer)) {
    for (const key of RETIRED_TURN_IDLE_TIMEOUT_KEYS) {
      if (Object.hasOwn(nextAppServer, key)) {
        delete nextAppServer[key];
        changes.push(
          `Removed retired plugins.entries.codex.config.appServer.${key}; native Codex owns provider liveness and turn completion. agents.defaults.timeoutSeconds was not changed.`,
        );
      }
    }
  }

  if (nextAppServer && hasBlankNetworkProxyOptionalFields(nextAppServer)) {
    const nextNetworkProxy = asNullableRecord(nextAppServer.networkProxy);
    for (const [target, key, configPath] of [
      [nextNetworkProxy, "profileName", "networkProxy.profileName"],
      [nextAppServer, "remoteWorkspaceRoot", "remoteWorkspaceRoot"],
    ] as const) {
      if (target && typeof target[key] === "string" && !target[key].trim()) {
        delete target[key];
        changes.push(
          `Removed blank plugins.entries.codex.config.appServer.${configPath}; the default now applies.`,
        );
      }
    }
  }

  if (nextAppServer && hasRetiredApprovalPolicy(nextAppServer)) {
    nextAppServer.approvalPolicy = "on-request";
    changes.push(
      'Renamed retired plugins.entries.codex.config.appServer.approvalPolicy to "on-request".',
    );
  }

  return {
    config: nextConfig,
    changes,
  };
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "codex-app-server-sidecars-to-plugin-state",
    label: "Codex app-server thread bindings",
    // Config normalization loads this artifact too; state-only imports belong
    // behind the inventory, detection, and migration callbacks.
    collectBackupResources: async (params) =>
      (
        await import("./src/migration/session-binding-sidecars.js")
      ).collectLegacySessionBindingBackupResources(params),
    detectLegacyState: async (params) =>
      (
        await import("./src/migration/session-binding-sidecars.js")
      ).detectLegacySessionBindingSidecars(params),
    migrateLegacyState: async (params) =>
      (
        await import("./src/migration/session-binding-sidecars.js")
      ).migrateLegacySessionBindingSidecars(params),
  },
  {
    id: "codex-native-task-assignments",
    label: "Codex native pending assignments",
    sqliteOnly: { family: "state" },
    collectBackupResources: async (params) =>
      (
        await import("./src/migration/native-task-assignments.js")
      ).codexNativeTaskAssignmentMigration.collectBackupResources(params),
    detectLegacyState: async (params) =>
      (
        await import("./src/migration/native-task-assignments.js")
      ).codexNativeTaskAssignmentMigration.detectLegacyState(params),
    migrateLegacyState: async (params) =>
      (
        await import("./src/migration/native-task-assignments.js")
      ).codexNativeTaskAssignmentMigration.migrateLegacyState(params),
  },
  {
    id: "codex-native-assignment-repair",
    label: "Codex native pending assignment repair",
    doctorOnly: true,
    phase: "after-session-repair",
    collectBackupResources: () => [],
    detectLegacyState: async (params) =>
      (
        await import("./src/migration/native-assignment-repair.js")
      ).codexNativeAssignmentRepair.detectLegacyState(params),
    migrateLegacyState: async (params) =>
      (
        await import("./src/migration/native-assignment-repair.js")
      ).codexNativeAssignmentRepair.migrateLegacyState(params),
  },
  codexOrphanedSessionBindingMigration,
];
