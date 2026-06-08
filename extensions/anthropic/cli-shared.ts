/**
 * Shared Claude CLI backend normalization. It sanitizes command args, maps
 * thinking levels, and keeps OpenClaw-managed CLI runs isolated from shell env.
 */
import type {
  CliBackendConfig,
  CliBackendNormalizeConfigContext,
  CliBackendResolveExecutionArgsContext,
} from "openclaw/plugin-sdk/cli-backend";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";
export {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CLAUDE_CLI_MODEL_ALIASES,
  CLAUDE_CLI_SESSION_ID_FIELDS,
} from "./cli-constants.js";

// Claude Code honors provider-routing, auth, and config-root env before
// consulting its local login state, so inherited shell overrides must not
// steer OpenClaw-managed Claude CLI runs toward a different provider,
// endpoint, token source, plugin/config tree, or telemetry bootstrap mode.
/** Environment variables removed before launching OpenClaw-managed Claude CLI runs. */
export const CLAUDE_CLI_CLEAR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
] as const;

const CLAUDE_LEGACY_SKIP_PERMISSIONS_ARG = "--dangerously-skip-permissions";
const CLAUDE_PERMISSION_MODE_ARG = "--permission-mode";
const CLAUDE_SETTING_SOURCES_ARG = "--setting-sources";
const CLAUDE_EFFORT_ARG = "--effort";
const CLAUDE_SETTINGS_ARG = "--settings";
const CLAUDE_SAFE_SETTING_SOURCES = "user";
const CLAUDE_BYPASS_PERMISSION_MODE = "bypassPermissions";

type ClaudeCliEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Return whether a provider id refers to the Claude CLI backend. */
export function isClaudeCliProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === CLAUDE_CLI_BACKEND_ID;
}

function isOpenClawRequestedYolo(context?: CliBackendNormalizeConfigContext): boolean {
  const agentExec = context?.agentId
    ? context.config?.agents?.list?.find((agent) => agent.id === context.agentId)?.tools?.exec
    : undefined;
  const exec = agentExec ?? context?.config?.tools?.exec;
  const security = exec?.security ?? "full";
  const ask = exec?.ask ?? "off";
  return security === "full" && ask === "off";
}

/** Resolve Claude permission mode from OpenClaw exec security settings. */
export function resolveClaudePermissionMode(context?: CliBackendNormalizeConfigContext): {
  mode?: string;
  overrideExisting: boolean;
} {
  return isOpenClawRequestedYolo(context)
    ? { mode: CLAUDE_BYPASS_PERMISSION_MODE, overrideExisting: false }
    : { overrideExisting: false };
}

/** Normalize Claude permission arguments, removing legacy skip-permissions flags. */
export function normalizeClaudePermissionArgs(
  args?: string[],
  options?: { mode?: string; overrideExisting?: boolean },
): string[] | undefined {
  if (!args) {
    return options?.mode ? [CLAUDE_PERMISSION_MODE_ARG, options.mode] : args;
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
        if (!options?.overrideExisting) {
          normalized.push(arg);
          normalized.push(maybeValue);
        }
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_PERMISSION_MODE_ARG}=`)) {
      const maybeValue = arg.slice(`${CLAUDE_PERMISSION_MODE_ARG}=`.length).trim();
      if (maybeValue.length > 0 && !maybeValue.startsWith("-")) {
        hasPermissionMode = true;
        if (!options?.overrideExisting) {
          normalized.push(`${CLAUDE_PERMISSION_MODE_ARG}=${maybeValue}`);
        }
      }
      continue;
    }
    normalized.push(arg);
  }
  if (options?.mode && (!hasPermissionMode || options.overrideExisting)) {
    normalized.push(CLAUDE_PERMISSION_MODE_ARG, options.mode);
  }
  return normalized;
}

/** Ensure Claude CLI setting sources stay restricted to user settings. */
export function normalizeClaudeSettingSourcesArgs(args?: string[]): string[] | undefined {
  if (!args) {
    return args;
  }
  const normalized: string[] = [];
  let hasSettingSources = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === CLAUDE_SETTING_SOURCES_ARG) {
      const maybeValue = args[i + 1];
      if (
        typeof maybeValue === "string" &&
        maybeValue.trim().length > 0 &&
        !maybeValue.startsWith("-")
      ) {
        hasSettingSources = true;
        normalized.push(arg, CLAUDE_SAFE_SETTING_SOURCES);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_SETTING_SOURCES_ARG}=`)) {
      hasSettingSources = true;
      normalized.push(`${CLAUDE_SETTING_SOURCES_ARG}=${CLAUDE_SAFE_SETTING_SOURCES}`);
      continue;
    }
    normalized.push(arg);
  }
  if (!hasSettingSources) {
    normalized.push(CLAUDE_SETTING_SOURCES_ARG, CLAUDE_SAFE_SETTING_SOURCES);
  }
  return normalized;
}

/** Map OpenClaw thinking levels to Claude CLI effort flags for a model id. */
export function mapClaudeCliThinkingLevelToEffort(
  thinkingLevel?: string | null,
): ClaudeCliEffort | undefined {
  switch (normalizeOptionalLowercaseString(thinkingLevel)) {
    case "minimal":
    case "low":
      return "low";
    case "adaptive":
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return undefined;
  }
}

function stripClaudeEffortArgs(args: readonly string[]): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === CLAUDE_EFFORT_ARG) {
      const maybeValue = args[i + 1];
      if (
        typeof maybeValue === "string" &&
        maybeValue.trim().length > 0 &&
        !maybeValue.startsWith("-")
      ) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_EFFORT_ARG}=`)) {
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

/** Merge a settings object into an existing inline `--settings` JSON, patch wins. */
function mergeClaudeSettingsJson(existing: string, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      base = parsed as Record<string, unknown>;
    }
  } catch {
    // Unparseable inline settings: drop the malformed blob and forward the patch
    // alone so ultracode still engages rather than passing invalid JSON through.
  }
  return JSON.stringify({ ...base, ...patch });
}

/**
 * Idempotently inject a Claude CLI `--settings` JSON patch.
 *
 * Claude Code accepts `--settings` as a JSON string; a single inline object is
 * shallow-merged (patch wins) so we never emit conflicting duplicate flags. When
 * no inline settings exist (the common case) the patch is appended as a fresh arg.
 */
export function injectClaudeSettings(
  args: readonly string[],
  patch: Record<string, unknown>,
): string[] {
  const normalized: string[] = [];
  let merged = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === CLAUDE_SETTINGS_ARG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === "string" && maybeValue.trim().length > 0) {
        normalized.push(arg, mergeClaudeSettingsJson(maybeValue, patch));
        merged = true;
        i += 1;
        continue;
      }
      normalized.push(arg);
      continue;
    }
    if (arg.startsWith(`${CLAUDE_SETTINGS_ARG}=`)) {
      const value = arg.slice(`${CLAUDE_SETTINGS_ARG}=`.length);
      normalized.push(`${CLAUDE_SETTINGS_ARG}=${mergeClaudeSettingsJson(value, patch)}`);
      merged = true;
      continue;
    }
    normalized.push(arg);
  }
  if (!merged) {
    normalized.push(CLAUDE_SETTINGS_ARG, JSON.stringify(patch));
  }
  return normalized;
}

/** Resolve final Claude CLI execution args for one backend invocation. */
export function resolveClaudeCliExecutionArgs(
  context: CliBackendResolveExecutionArgsContext,
): string[] {
  const effort = mapClaudeCliThinkingLevelToEffort(context.thinkingLevel);
  if (!effort) {
    return [...context.baseArgs];
  }
  return [...stripClaudeEffortArgs(context.baseArgs), CLAUDE_EFFORT_ARG, effort];
}

/** Normalize Claude CLI backend config before registration or execution. */
export function normalizeClaudeBackendConfig(
  config: CliBackendConfig,
  context?: CliBackendNormalizeConfigContext,
): CliBackendConfig {
  const output = config.output ?? "jsonl";
  const input = config.input ?? "stdin";
  const permission = resolveClaudePermissionMode(context);
  // ultracode (xhigh effort + standing dynamic-workflow orchestration) is opt-in
  // per claude-cli backend config and reachable only via the `ultracode` session
  // settings key, so inject `--settings '{"ultracode":true}'`. Keep `undefined`
  // intact so an unset resumeArgs still falls back to args at spawn time.
  const applyUltracode = (args?: string[]): string[] | undefined =>
    config.ultracode === true && args !== undefined
      ? injectClaudeSettings(args, { ultracode: true })
      : args;
  return {
    ...config,
    args: applyUltracode(
      normalizeClaudePermissionArgs(normalizeClaudeSettingSourcesArgs(config.args), permission),
    ),
    resumeArgs: applyUltracode(
      normalizeClaudePermissionArgs(
        normalizeClaudeSettingSourcesArgs(config.resumeArgs),
        permission,
      ),
    ),
    output,
    liveSession:
      config.liveSession ?? (output === "jsonl" && input === "stdin" ? "claude-stdio" : undefined),
    input,
  };
}
