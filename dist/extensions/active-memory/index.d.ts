import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { A as OpenClawPluginDefinition, k as OpenClawPluginConfigSchema } from "../../types-Vx7Jq4_-2.js";
//#region extensions/active-memory/index.d.ts
type ActiveMemoryQmdSearchMode = "inherit" | "search" | "vsearch" | "query";
type ResolvedActiveRecallPluginConfig = {
  enabled: boolean;
  agents: string[];
  model?: string;
  modelFallback?: string;
  modelFallbackPolicy: "default-remote" | "resolved-only";
  allowedChatTypes: Array<"direct" | "group" | "channel" | "explicit">;
  allowedChatIds: string[];
  deniedChatIds: string[];
  thinking: ActiveMemoryThinkingLevel;
  promptStyle: "balanced" | "strict" | "contextual" | "recall-heavy" | "precision-heavy" | "preference-only";
  toolsAllow: string[];
  promptOverride?: string;
  promptAppend?: string;
  timeoutMs: number;
  setupGraceTimeoutMs: number;
  queryMode: "message" | "recent" | "full";
  maxSummaryChars: number;
  recentUserTurns: number;
  recentAssistantTurns: number;
  recentUserChars: number;
  recentAssistantChars: number;
  logging: boolean;
  cacheTtlMs: number;
  circuitBreakerMaxTimeouts: number;
  circuitBreakerCooldownMs: number;
  persistTranscripts: boolean;
  transcriptDir: string;
  qmd: {
    searchMode: ActiveMemoryQmdSearchMode;
  };
};
type ActiveMemorySearchDebug = {
  backend?: string;
  configuredMode?: string;
  effectiveMode?: string;
  fallback?: string;
  searchMs?: number;
  hits?: number;
  warning?: string;
  action?: string;
  error?: string;
};
type ActiveRecallResult = {
  status: "empty" | "failed" | "no_relevant_memory" | "timeout" | "unavailable";
  elapsedMs: number;
  summary: string | null;
  searchDebug?: ActiveMemorySearchDebug;
} | {
  status: "timeout_partial";
  elapsedMs: number;
  summary: string;
  searchDebug?: ActiveMemorySearchDebug;
} | {
  status: "ok";
  elapsedMs: number;
  rawReply: string;
  summary: string;
  searchDebug?: ActiveMemorySearchDebug;
};
type TranscriptReadLimits = {
  maxChars?: number;
  maxLines?: number;
  maxBytes?: number;
};
type ActiveMemoryThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
type CircuitBreakerEntry = {
  consecutiveTimeouts: number;
  lastTimeoutAt: number;
};
declare function buildCircuitBreakerKey(agentId: string, provider?: string, model?: string): string;
declare function isCircuitBreakerOpen(key: string, maxTimeouts: number, cooldownMs: number): boolean;
declare function isMissingRegisteredMemoryToolsError(error: unknown, toolsAllow?: readonly string[]): boolean;
declare function normalizePluginConfig(pluginConfig: unknown, cfg?: OpenClawConfig): ResolvedActiveRecallPluginConfig;
declare function buildCacheKey(params: {
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  query: string;
}): string;
declare function getCachedResult(cacheKey: string): ActiveRecallResult | undefined;
declare function setCachedResult(cacheKey: string, result: ActiveRecallResult, ttlMs: number): void;
declare function shouldCacheResult(result: ActiveRecallResult): boolean;
declare function buildPluginStatusLine(params: {
  result: ActiveRecallResult;
  config: ResolvedActiveRecallPluginConfig;
}): string;
declare function readActiveMemorySearchDebug(sessionFile: string, limits?: TranscriptReadLimits): Promise<ActiveMemorySearchDebug | undefined>;
declare function readPartialAssistantText(sessionFile: string | undefined, limits?: TranscriptReadLimits): Promise<string | null>;
declare function buildMetadata(summary: string | null): string | undefined;
declare function buildPromptPrefix(summary: string | null): string | undefined;
declare const _default: {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
declare const testing: {
  buildCacheKey: typeof buildCacheKey;
  buildCircuitBreakerKey: typeof buildCircuitBreakerKey;
  buildMetadata: typeof buildMetadata;
  buildPluginStatusLine: typeof buildPluginStatusLine;
  buildPromptPrefix: typeof buildPromptPrefix;
  getCachedResult: typeof getCachedResult;
  isCircuitBreakerOpen: typeof isCircuitBreakerOpen;
  isMissingRegisteredMemoryToolsError: typeof isMissingRegisteredMemoryToolsError;
  normalizePluginConfig: typeof normalizePluginConfig;
  readActiveMemorySearchDebug: typeof readActiveMemorySearchDebug;
  readPartialAssistantText: typeof readPartialAssistantText;
  shouldCacheResult: typeof shouldCacheResult;
  resetActiveRecallCacheForTests(): void;
  setMinimumTimeoutMsForTests(value: number): void;
  setSetupGraceTimeoutMsForTests(value: number): void;
  setTimeoutPartialDataGraceMsForTests(value: number): void;
  setCachedResult: typeof setCachedResult;
  getCircuitBreakerEntry(key: string): CircuitBreakerEntry | undefined;
};
//#endregion
export { testing as __testing, testing, _default as default };