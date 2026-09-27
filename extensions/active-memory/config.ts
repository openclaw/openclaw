import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import {
  parseStrictPositiveInteger,
  resolveIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  asOptionalRecord,
  normalizeOptionalString,
  normalizeStringEntries,
  normalizeTrimmedStringList,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  ACTIVE_MEMORY_RESERVED_TOOLS_ALLOW,
  DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
  DEFAULT_ACTIVE_MEMORY_MODE,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
  DEFAULT_CLI_RUNTIME_RECALL_TIMEOUT_MS,
  DEFAULT_CIRCUIT_BREAKER_MAX_TIMEOUTS,
  DEFAULT_MAX_SUMMARY_CHARS,
  DEFAULT_MIN_TIMEOUT_MS,
  DEFAULT_QUERY_MODE,
  DEFAULT_RECENT_ASSISTANT_CHARS,
  DEFAULT_RECENT_ASSISTANT_TURNS,
  DEFAULT_RECENT_USER_CHARS,
  DEFAULT_RECENT_USER_TURNS,
  DEFAULT_SETUP_GRACE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSCRIPT_DIR,
  LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW,
  MAX_ACTIVE_MEMORY_TOOLS_ALLOW,
  MAX_SETUP_GRACE_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  type ActiveMemoryChatType,
  type ActiveMemoryFastMode,
  type ActiveMemoryPromptStyle,
  type ActiveMemoryThinkingLevel,
  type ActiveRecallPluginConfig,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

let minimumTimeoutMs = DEFAULT_MIN_TIMEOUT_MS;
let setupGraceTimeoutMs = DEFAULT_SETUP_GRACE_TIMEOUT_MS;

function parseOptionalPositiveInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseStrictPositiveInteger(value)
        : Number.NaN;
  return parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.find((choice) => choice === value) ?? fallback;
}

function normalizeTranscriptDir(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return DEFAULT_TRANSCRIPT_DIR;
  }
  const normalized = raw.replace(/\\/g, "/");
  const parts = normalized.split("/").map((part) => part.trim());
  const safeParts = parts.filter((part) => part.length > 0 && part !== "." && part !== "..");
  return safeParts.length > 0 ? path.join(...safeParts) : DEFAULT_TRANSCRIPT_DIR;
}

function normalizeIdentifierList(value: unknown): string[] {
  return uniqueStrings(normalizeTrimmedStringList(value).map((entry) => entry.toLowerCase()));
}

function normalizeConfiguredToolsAllow(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tools = normalizeIdentifierList(value)
    .filter((name) => !name.startsWith("group:") && !ACTIVE_MEMORY_RESERVED_TOOLS_ALLOW.has(name))
    .slice(0, MAX_ACTIVE_MEMORY_TOOLS_ALLOW);
  return tools.length > 0 ? tools : undefined;
}

function resolveDefaultToolsAllow(cfg: OpenClawConfig | undefined): string[] {
  return cfg?.plugins?.slots?.memory === "memory-lancedb"
    ? [...LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW]
    : [...DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW];
}

function hasDeprecatedModelFallbackPolicy(pluginConfig: unknown): boolean {
  const raw = asOptionalRecord(pluginConfig);
  return raw ? Object.hasOwn(raw, "modelFallbackPolicy") : false;
}

function resolveSafeTranscriptDir(baseSessionsDir: string, transcriptDir: string): string {
  const normalized = transcriptDir.trim();
  if (!normalized || normalized.includes(":") || path.isAbsolute(normalized)) {
    return path.resolve(baseSessionsDir, DEFAULT_TRANSCRIPT_DIR);
  }
  const resolvedBase = path.resolve(baseSessionsDir);
  const candidate = path.resolve(resolvedBase, normalized);
  if (!isPathInside(resolvedBase, candidate)) {
    return path.resolve(resolvedBase, DEFAULT_TRANSCRIPT_DIR);
  }
  return candidate;
}

function resolvePersistentTranscriptBaseDir(api: OpenClawPluginApi, agentId: string): string {
  return path.join(
    api.runtime.state.resolveStateDir(),
    "plugins",
    "active-memory",
    "transcripts",
    "agents",
    encodeURIComponent(agentId.trim()) || "unknown-agent",
  );
}

function isMissingRegisteredMemoryToolsError(
  error: unknown,
  toolsAllow: readonly string[] = DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim();
  const prefix = "No callable tools remain after resolving explicit tool allowlist (";
  const suffix =
    "); no registered tools matched. Fix the allowlist or enable the plugin that registers the requested tool.";
  if (!message.startsWith(prefix) || !message.endsWith(suffix)) {
    return false;
  }
  const sources = message.slice(prefix.length, -suffix.length);
  const sourceParts = sources
    .split(";")
    .map((source) => source.trim())
    .filter(Boolean);
  return sourceParts.includes(`runtime toolsAllow: ${toolsAllow.join(", ")}`);
}

function normalizePluginConfig(
  pluginConfig: unknown,
  cfg?: OpenClawConfig,
): ResolvedActiveRecallPluginConfig {
  const raw = (
    pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {}
  ) as ActiveRecallPluginConfig;
  const allowedChatTypes = Array.isArray(raw.allowedChatTypes)
    ? raw.allowedChatTypes.filter(
        (value): value is ActiveMemoryChatType =>
          value === "direct" || value === "group" || value === "channel" || value === "explicit",
      )
    : [];
  return {
    enabled: raw.enabled !== false,
    mode: resolveChoice(raw.mode, ["always", "off", "escalate"], DEFAULT_ACTIVE_MEMORY_MODE),
    agents: Array.isArray(raw.agents) ? normalizeStringEntries(raw.agents) : [],
    model: normalizeOptionalString(raw.model),
    modelFallback: normalizeOptionalString(raw.modelFallback),
    allowedChatTypes: allowedChatTypes.length > 0 ? allowedChatTypes : ["direct"],
    allowedChatIds: normalizeIdentifierList(raw.allowedChatIds),
    deniedChatIds: normalizeIdentifierList(raw.deniedChatIds),
    thinking: resolveChoice<ActiveMemoryThinkingLevel>(
      raw.thinking,
      ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"],
      "off",
    ),
    fastMode: normalizeActiveMemoryFastMode(raw.fastMode),
    promptStyle: resolveChoice<ActiveMemoryPromptStyle>(
      raw.promptStyle,
      ["balanced", "strict", "contextual", "recall-heavy", "precision-heavy", "preference-only"],
      raw.queryMode === "message" ? "strict" : raw.queryMode === "full" ? "contextual" : "balanced",
    ),
    toolsAllow: normalizeConfiguredToolsAllow(raw.toolsAllow) ?? resolveDefaultToolsAllow(cfg),
    promptOverride: normalizeOptionalString(raw.promptOverride),
    promptAppend: normalizeOptionalString(raw.promptAppend),
    timeoutMs: resolveIntegerOption(
      parseOptionalPositiveInt(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
      DEFAULT_TIMEOUT_MS,
      { min: minimumTimeoutMs, max: MAX_TIMEOUT_MS },
    ),
    timeoutMsIsDefault: raw.timeoutMs === undefined || raw.timeoutMs === null,
    setupGraceTimeoutMs: resolveIntegerOption(raw.setupGraceTimeoutMs, setupGraceTimeoutMs, {
      min: 0,
      max: MAX_SETUP_GRACE_TIMEOUT_MS,
    }),
    queryMode: resolveChoice(raw.queryMode, ["message", "recent", "full"], DEFAULT_QUERY_MODE),
    maxSummaryChars: resolveIntegerOption(raw.maxSummaryChars, DEFAULT_MAX_SUMMARY_CHARS, {
      min: 40,
      max: 1000,
    }),
    recentUserTurns: resolveIntegerOption(raw.recentUserTurns, DEFAULT_RECENT_USER_TURNS, {
      min: 0,
      max: 4,
    }),
    recentAssistantTurns: resolveIntegerOption(
      raw.recentAssistantTurns,
      DEFAULT_RECENT_ASSISTANT_TURNS,
      {
        min: 0,
        max: 3,
      },
    ),
    recentUserChars: resolveIntegerOption(raw.recentUserChars, DEFAULT_RECENT_USER_CHARS, {
      min: 40,
      max: 1000,
    }),
    recentAssistantChars: resolveIntegerOption(
      raw.recentAssistantChars,
      DEFAULT_RECENT_ASSISTANT_CHARS,
      {
        min: 40,
        max: 1000,
      },
    ),
    logging: raw.logging === true,
    cacheTtlMs: resolveIntegerOption(raw.cacheTtlMs, DEFAULT_CACHE_TTL_MS, {
      min: 1000,
      max: 120_000,
    }),
    circuitBreakerMaxTimeouts: resolveIntegerOption(
      raw.circuitBreakerMaxTimeouts,
      DEFAULT_CIRCUIT_BREAKER_MAX_TIMEOUTS,
      { min: 1, max: 20 },
    ),
    circuitBreakerCooldownMs: resolveIntegerOption(
      raw.circuitBreakerCooldownMs,
      DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
      { min: 5000, max: 600_000 },
    ),
    persistTranscripts: raw.persistTranscripts === true,
    transcriptDir: normalizeTranscriptDir(raw.transcriptDir),
  };
}

function readActiveMemoryConfig(api: OpenClawPluginApi): OpenClawConfig {
  try {
    return (api.runtime.config?.current?.() as OpenClawConfig | undefined) ?? api.config;
  } catch {
    return api.config;
  }
}

function normalizeActiveMemoryFastMode(fastMode: unknown): ActiveMemoryFastMode | undefined {
  return fastMode === true || fastMode === false || fastMode === "auto" ? fastMode : undefined;
}

function resetActiveMemoryConfigForTests(): void {
  minimumTimeoutMs = DEFAULT_MIN_TIMEOUT_MS;
  setupGraceTimeoutMs = DEFAULT_SETUP_GRACE_TIMEOUT_MS;
}

function setMinimumTimeoutMsForTests(value: number): void {
  minimumTimeoutMs = value;
}

function setSetupGraceTimeoutMsForTests(value: number): void {
  setupGraceTimeoutMs = Math.max(0, Math.floor(value));
}

// The runner owns CLI eligibility; explicit timeouts and direct API runs retain their budgets.
function applyCliRuntimeRecallTimeoutDefault(
  config: ResolvedActiveRecallPluginConfig,
  cliDispatchEligible: boolean,
): ResolvedActiveRecallPluginConfig {
  if (!config.timeoutMsIsDefault || config.timeoutMs >= DEFAULT_CLI_RUNTIME_RECALL_TIMEOUT_MS) {
    return config;
  }
  return cliDispatchEligible
    ? { ...config, timeoutMs: DEFAULT_CLI_RUNTIME_RECALL_TIMEOUT_MS }
    : config;
}

export {
  applyCliRuntimeRecallTimeoutDefault,
  hasDeprecatedModelFallbackPolicy,
  isMissingRegisteredMemoryToolsError,
  normalizeActiveMemoryFastMode,
  normalizePluginConfig,
  resetActiveMemoryConfigForTests,
  readActiveMemoryConfig,
  resolvePersistentTranscriptBaseDir,
  resolveSafeTranscriptDir,
  setMinimumTimeoutMsForTests,
  setSetupGraceTimeoutMsForTests,
};
