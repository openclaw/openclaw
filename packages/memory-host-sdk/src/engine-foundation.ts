// Real workspace contract for memory engine foundation concerns.

export {
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "./host/openclaw-runtime.js";
export {
  resolveMemorySearchConfig,
  resolveMemorySearchSyncConfig,
  type ResolvedMemorySearchConfig,
  type ResolvedMemorySearchSyncConfig,
} from "./host/openclaw-runtime.js";
export { parseDurationMs } from "./host/openclaw-runtime.js";
export { loadConfig } from "./host/openclaw-runtime.js";
export { resolveStateDir } from "./host/openclaw-runtime.js";
export { resolveSessionTranscriptsDirForAgent } from "./host/openclaw-runtime.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "./host/openclaw-runtime.js";
export { writeFileWithinRoot } from "./host/openclaw-runtime.js";
export { createSubsystemLogger } from "./host/openclaw-runtime.js";
export { detectMime } from "./host/openclaw-runtime.js";
export { resolveGlobalSingleton } from "./host/openclaw-runtime.js";
export { onSessionTranscriptUpdate } from "./host/openclaw-runtime.js";
export { splitShellArgs } from "./host/openclaw-runtime.js";
export { runTasksWithConcurrency } from "./host/openclaw-runtime.js";
export {
  shortenHomeInString,
  shortenHomePath,
  resolveUserPath,
  truncateUtf16Safe,
} from "./host/openclaw-runtime.js";
export type { OpenClawConfig } from "./host/openclaw-runtime.js";
export type { SessionSendPolicyConfig } from "./host/openclaw-runtime.js";
export type { SecretInput } from "./host/openclaw-runtime.js";
export type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdMcporterConfig,
  MemoryQmdSearchMode,
} from "./host/openclaw-runtime.js";
export type { MemorySearchConfig } from "./host/openclaw-runtime.js";
