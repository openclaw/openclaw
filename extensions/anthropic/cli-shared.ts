/**
 * Shared Claude CLI backend normalization. It sanitizes command args, maps
 * thinking levels, and keeps OpenClaw-managed CLI runs isolated from shell env.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CliBackendConfig,
  CliBackendNormalizeConfigContext,
  CliBackendResolvedExecutionArgs,
  CliBackendResolveExecutionArgsContext,
} from "openclaw/plugin-sdk/cli-backend";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
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

type ClaudeSettingsInjectionOptions = {
  cwd?: string;
};

type ClaudeSettingsMergeResult = {
  value: string;
  cleanup?: () => void;
};

type ClaudeSettingsInjectionResult = {
  args: string[];
  cleanup?: () => void;
};

function composeCleanup(cleanups: Array<(() => void) | undefined>): (() => void) | undefined {
  const active = cleanups.filter((cleanup): cleanup is () => void => cleanup !== undefined);
  if (active.length === 0) {
    return undefined;
  }
  return () => {
    for (const cleanup of active.toReversed()) {
      cleanup();
    }
  };
}

function writePrivateClaudeSettingsFile(
  settings: Record<string, unknown>,
): ClaudeSettingsMergeResult {
  const settingsJson = JSON.stringify(settings);
  const settingsHash = crypto.createHash("sha256").update(settingsJson).digest("hex");
  const dir = fs.mkdtempSync(
    path.join(resolvePreferredOpenClawTmpDir(), `openclaw-claude-settings-${settingsHash}-`),
  );
  try {
    fs.chmodSync(dir, 0o700);
    const filePath = path.join(dir, "settings.json");
    fs.writeFileSync(filePath, settingsJson, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(filePath, 0o600);
    return {
      value: filePath,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Merge a settings object into an existing `--settings` value, patch wins. */
function mergeClaudeSettingsJson(
  existing: string,
  patch: Record<string, unknown>,
  options: ClaudeSettingsInjectionOptions = {},
): ClaudeSettingsMergeResult | null {
  const trimmed = existing.trim();
  const inlineJson = trimmed.startsWith("{") && trimmed.endsWith("}");
  if (!inlineJson && !options.cwd) {
    return null;
  }
  let base: Record<string, unknown> = {};
  try {
    const payload = inlineJson
      ? trimmed
      : fs.readFileSync(
          path.isAbsolute(trimmed) ? trimmed : path.resolve(options.cwd ?? "", trimmed),
          "utf8",
        );
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      base = parsed as Record<string, unknown>;
    } else if (!inlineJson) {
      throw new Error("settings file must contain a JSON object");
    }
  } catch (error) {
    if (!inlineJson) {
      throw new Error(`Failed to merge Claude settings file ${existing}: ${String(error)}`, {
        cause: error,
      });
    }
    // Unparseable inline settings: drop the malformed blob and forward the patch
    // alone so ultracode still engages rather than passing invalid JSON through.
  }
  const merged = { ...base, ...patch };
  return inlineJson ? { value: JSON.stringify(merged) } : writePrivateClaudeSettingsFile(merged);
}

/**
 * Idempotently inject a Claude CLI `--settings` JSON patch.
 *
 * Claude Code accepts `--settings` as a file path or an inline JSON string.
 * Inline objects are shallow-merged (patch wins). File paths are read relative
 * to the child cwd, merged, and replaced with a private temp settings file.
 */
function resolveClaudeSettingsInjection(
  args: readonly string[],
  patch: Record<string, unknown>,
  options: ClaudeSettingsInjectionOptions = {},
): ClaudeSettingsInjectionResult {
  const normalized: string[] = [];
  let merged = false;
  let preservedUnmergedSettings = false;
  const cleanups: Array<(() => void) | undefined> = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === CLAUDE_SETTINGS_ARG) {
      const maybeValue = args[i + 1];
      if (
        typeof maybeValue === "string" &&
        maybeValue.trim().length > 0 &&
        !maybeValue.startsWith("-")
      ) {
        const mergedValue = mergeClaudeSettingsJson(maybeValue, patch, options);
        if (mergedValue !== null) {
          normalized.push(arg, mergedValue.value);
          cleanups.push(mergedValue.cleanup);
          merged = true;
        } else {
          normalized.push(arg, maybeValue);
          preservedUnmergedSettings = true;
        }
        i += 1;
        continue;
      }
      continue;
    }
    if (arg.startsWith(`${CLAUDE_SETTINGS_ARG}=`)) {
      const value = arg.slice(`${CLAUDE_SETTINGS_ARG}=`.length);
      const mergedValue = mergeClaudeSettingsJson(value, patch, options);
      if (mergedValue !== null) {
        normalized.push(`${CLAUDE_SETTINGS_ARG}=${mergedValue.value}`);
        cleanups.push(mergedValue.cleanup);
        merged = true;
      } else if (value.trim().length > 0) {
        normalized.push(arg);
        preservedUnmergedSettings = true;
      }
      continue;
    }
    normalized.push(arg);
  }
  if (!merged && !preservedUnmergedSettings) {
    normalized.push(CLAUDE_SETTINGS_ARG, JSON.stringify(patch));
  }
  return {
    args: normalized,
    cleanup: composeCleanup(cleanups),
  };
}

export function injectClaudeSettings(
  args: readonly string[],
  patch: Record<string, unknown>,
  options: ClaudeSettingsInjectionOptions = {},
): string[] {
  return resolveClaudeSettingsInjection(args, patch, options).args;
}

/** Resolve final Claude CLI execution args for one backend invocation. */
export function resolveClaudeCliExecutionArgs(
  context: CliBackendResolveExecutionArgsContext,
): string[] | CliBackendResolvedExecutionArgs {
  const settingsInjection =
    context.backendConfig?.ultracode === true
      ? resolveClaudeSettingsInjection(
          context.baseArgs,
          { ultracode: true },
          {
            cwd: context.cwd ?? context.workspaceDir,
          },
        )
      : undefined;
  const baseArgs = settingsInjection?.args ?? [...context.baseArgs];
  const effort = mapClaudeCliThinkingLevelToEffort(context.thinkingLevel);
  if (!effort) {
    return settingsInjection?.cleanup
      ? { args: baseArgs, cleanup: settingsInjection.cleanup }
      : baseArgs;
  }
  const args = [...stripClaudeEffortArgs(baseArgs), CLAUDE_EFFORT_ARG, effort];
  return settingsInjection?.cleanup ? { args, cleanup: settingsInjection.cleanup } : args;
}

/** Normalize Claude CLI backend config before registration or execution. */
export function normalizeClaudeBackendConfig(
  config: CliBackendConfig,
  context?: CliBackendNormalizeConfigContext,
): CliBackendConfig {
  const output = config.output ?? "jsonl";
  const input = config.input ?? "stdin";
  const permission = resolveClaudePermissionMode(context);
  return {
    ...config,
    args: normalizeClaudePermissionArgs(normalizeClaudeSettingSourcesArgs(config.args), permission),
    resumeArgs: normalizeClaudePermissionArgs(
      normalizeClaudeSettingSourcesArgs(config.resumeArgs),
      permission,
    ),
    output,
    liveSession:
      config.liveSession ?? (output === "jsonl" && input === "stdin" ? "claude-stdio" : undefined),
    input,
  };
}
