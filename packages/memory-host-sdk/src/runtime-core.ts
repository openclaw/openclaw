// Focused runtime contract for memory plugin config/state/helpers.
// Browser-safe overrides for Node.js-dependent functions.

export {
  type AnyAgentTool,
  resolveCronStyleNow,
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  resolveDefaultAgentId,
  resolveSessionAgentId,
  resolveMemorySearchConfig,
  jsonResult,
  readNumberParam,
  readStringParam,
  SILENT_REPLY_TOKEN,
  parseNonNegativeByteSize,
  emptyPluginConfigSchema,
  parseAgentSessionKey,
  type OpenClawConfig,
  type MemoryCitationsMode,
  type MemoryFlushPlan,
  type MemoryFlushPlanResolver,
  type MemoryPluginRuntime,
  type MemoryPromptSectionBuilder,
  type OpenClawPluginApi,
} from "../../../src/memory-host-sdk/runtime-core.js";

// browser-safe loadConfig
export function loadConfig(): Record<string, unknown> {
  if (typeof process === "undefined" || !process.env) {
    return {};
  }
  return {};
}

// browser-safe resolveStateDir
export function resolveStateDir(): string {
  return "";
}

// browser-safe resolveSessionTranscriptsDirForAgent
export function resolveSessionTranscriptsDirForAgent(): string {
  return "";
}
