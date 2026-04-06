import {
  CLAUDE_CLI_BACKEND_ID,
  buildAnthropicCliBackend,
  normalizeClaudeBackendConfig,
} from "../../extensions/anthropic/cli-backend-api.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "./cli-watchdog-defaults.js";
import { normalizeProviderId } from "./model-selection.js";

export type ResolvedCliBackend = {
  id: string;
  config: CliBackendConfig;
  bundleMcp: boolean;
  pluginId?: string;
};

export { normalizeClaudeBackendConfig };

type FallbackCliBackendPolicy = {
  bundleMcp: boolean;
  baseConfig?: CliBackendConfig;
  normalizeConfig?: (config: CliBackendConfig) => CliBackendConfig;
};

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-4.6": "opus",
  "opus-4.5": "opus",
  "opus-4": "opus",
  "claude-opus-4-6": "opus",
  "claude-opus-4-5": "opus",
  "claude-opus-4": "opus",
  sonnet: "sonnet",
  "sonnet-4.6": "sonnet",
  "sonnet-4.5": "sonnet",
  "sonnet-4.1": "sonnet",
  "sonnet-4.0": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-1": "sonnet",
  "claude-sonnet-4-0": "sonnet",
  haiku: "haiku",
  "haiku-3.5": "haiku",
  "claude-haiku-3-5": "haiku",
};

const CLAUDE_LEGACY_SKIP_PERMISSIONS_ARG = "--dangerously-skip-permissions";
const CLAUDE_PERMISSION_MODE_ARG = "--permission-mode";

const DEFAULT_CODEX_BACKEND: CliBackendConfig = {
  command: "codex",
  args: [
    "exec",
    "--json",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
  ],
  resumeArgs: [
    "exec",
    "resume",
    "{sessionId}",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
  ],
  output: "jsonl",
  resumeOutput: "text",
  input: "arg",
  modelArg: "--model",
  sessionIdFields: ["thread_id"],
  sessionMode: "existing",
  imageArg: "--image",
  imageMode: "repeat",
  reliability: {
    watchdog: {
      fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
      resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
    },
  },
  serialize: true,
};

const FALLBACK_CLI_BACKEND_POLICIES: Record<string, FallbackCliBackendPolicy> = {
  [CLAUDE_CLI_BACKEND_ID]: {
    // Claude CLI consumes explicit MCP config overlays even when the runtime
    // plugin registry is not initialized yet (for example direct runner tests
    // or narrow non-gateway entrypoints).
    bundleMcp: true,
    baseConfig: {
      ...buildAnthropicCliBackend().config,
      modelAliases: CLAUDE_MODEL_ALIASES,
      mcp: {
        enabled: true,
        strict: true,
      },
    },
    normalizeConfig: normalizeClaudeBackendConfig,
  },
  "codex-cli": {
    bundleMcp: false,
    baseConfig: DEFAULT_CODEX_BACKEND,
  },
};

function resolveFallbackCliBackendPolicy(provider: string): FallbackCliBackendPolicy | undefined {
  return FALLBACK_CLI_BACKEND_POLICIES[provider];
}

function normalizeBackendKey(key: string): string {
  return normalizeProviderId(key);
}

function pickBackendConfig(
  config: Record<string, CliBackendConfig>,
  normalizedId: string,
): CliBackendConfig | undefined {
  const directKey = Object.keys(config).find((key) => key.trim().toLowerCase() === normalizedId);
  if (directKey) {
    return config[directKey];
  }
  for (const [key, entry] of Object.entries(config)) {
    if (normalizeBackendKey(key) === normalizedId) {
      return entry;
    }
  }
  return undefined;
}

function resolveRegisteredBackend(provider: string) {
  const normalized = normalizeBackendKey(provider);
  return resolveRuntimeCliBackends().find((entry) => normalizeBackendKey(entry.id) === normalized);
}

function mergeBackendConfig(base: CliBackendConfig, override?: CliBackendConfig): CliBackendConfig {
  if (!override) {
    return { ...base };
  }
  const baseFresh = base.reliability?.watchdog?.fresh ?? {};
  const baseResume = base.reliability?.watchdog?.resume ?? {};
  const overrideFresh = override.reliability?.watchdog?.fresh ?? {};
  const overrideResume = override.reliability?.watchdog?.resume ?? {};
  const baseMcp = base.mcp ?? {};
  const overrideMcp = override.mcp ?? {};
  const mergedMcp = (() => {
    const mergedServers = {
      ...baseMcp.servers,
      ...overrideMcp.servers,
    };
    const next = {
      ...baseMcp,
      ...overrideMcp,
      ...(Object.keys(mergedServers).length ? { servers: mergedServers } : {}),
    };
    return Object.keys(next).length ? next : undefined;
  })();
  return {
    ...base,
    ...override,
    args: override.args ?? base.args,
    env: { ...base.env, ...override.env },
    modelAliases: { ...base.modelAliases, ...override.modelAliases },
    clearEnv: Array.from(new Set([...(base.clearEnv ?? []), ...(override.clearEnv ?? [])])),
    sessionIdFields: override.sessionIdFields ?? base.sessionIdFields,
    sessionArgs: override.sessionArgs ?? base.sessionArgs,
    resumeArgs: override.resumeArgs ?? base.resumeArgs,
    reliability: {
      ...base.reliability,
      ...override.reliability,
      watchdog: {
        ...base.reliability?.watchdog,
        ...override.reliability?.watchdog,
        fresh: {
          ...baseFresh,
          ...overrideFresh,
        },
        resume: {
          ...baseResume,
          ...overrideResume,
        },
      },
    },
    mcp: mergedMcp,
  };
}

function normalizeClaudePermissionArgs(args?: string[]): string[] | undefined {
  if (!args) {
    return args;
  }
  const normalized: string[] = [];
  let hasPermissionMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === CLAUDE_LEGACY_SKIP_PERMISSIONS_ARG) {
      continue;
    }
    if (arg === CLAUDE_PERMISSION_MODE_ARG) {
      const maybeValue = args[i + 1];
      if (
        typeof maybeValue === "string" &&
        maybeValue.trim().length > 0 &&
        !maybeValue.startsWith("-")
      ) {
        hasPermissionMode = true;
        normalized.push(arg, maybeValue);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_PERMISSION_MODE_ARG}=`)) {
      hasPermissionMode = true;
    }
    normalized.push(arg);
  }
  if (!hasPermissionMode) {
    normalized.push(CLAUDE_LEGACY_SKIP_PERMISSIONS_ARG);
  }
  return normalized;
}

export function resolveCliBackendIds(cfg?: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  for (const backend of resolveRuntimeCliBackends()) {
    ids.add(normalizeBackendKey(backend.id));
  }
  // Always include built-in fallback backends
  for (const key of Object.keys(FALLBACK_CLI_BACKEND_POLICIES)) {
    ids.add(normalizeBackendKey(key));
  }
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  for (const key of Object.keys(configured)) {
    ids.add(normalizeBackendKey(key));
  }
  return ids;
}

export function resolveCliBackendConfig(
  provider: string,
  cfg?: OpenClawConfig,
): ResolvedCliBackend | null {
  const normalized = normalizeBackendKey(provider);
  const fallbackPolicy = resolveFallbackCliBackendPolicy(normalized);
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  const override = pickBackendConfig(configured, normalized);
  const registered = resolveRegisteredBackend(normalized);
  if (registered) {
    const registeredBase = fallbackPolicy?.baseConfig
      ? mergeBackendConfig(fallbackPolicy.baseConfig, registered.config)
      : registered.config;
    const merged = mergeBackendConfig(registeredBase, override);
    const config = registered.normalizeConfig ? registered.normalizeConfig(merged) : merged;
    const command = config.command?.trim();
    if (!command) {
      return null;
    }
    return {
      id: normalized,
      config: { ...config, command },
      bundleMcp: registered.bundleMcp === true,
      pluginId: registered.pluginId,
    };
  }

  if (!override) {
    if (!fallbackPolicy?.baseConfig) {
      return null;
    }
    const baseConfig = fallbackPolicy.normalizeConfig
      ? fallbackPolicy.normalizeConfig(fallbackPolicy.baseConfig)
      : fallbackPolicy.baseConfig;
    // Apply permission arg normalization for claude-cli even in fallback mode
    const normalizedBase =
      normalized === normalizeBackendKey(CLAUDE_CLI_BACKEND_ID)
        ? {
            ...baseConfig,
            args: normalizeClaudePermissionArgs(baseConfig.args),
            resumeArgs: normalizeClaudePermissionArgs(baseConfig.resumeArgs),
          }
        : baseConfig;
    const command = normalizedBase.command?.trim();
    if (!command) {
      return null;
    }
    return {
      id: normalized,
      config: { ...normalizedBase, command },
      bundleMcp: fallbackPolicy.bundleMcp,
    };
  }
  const mergedFallback = fallbackPolicy?.baseConfig
    ? mergeBackendConfig(fallbackPolicy.baseConfig, override)
    : override;
  const config = fallbackPolicy?.normalizeConfig
    ? fallbackPolicy.normalizeConfig(mergedFallback)
    : mergedFallback;
  const command = config.command?.trim();
  if (!command) {
    return null;
  }
  return {
    id: normalized,
    config: { ...config, command },
    bundleMcp: fallbackPolicy?.bundleMcp === true,
  };
}
