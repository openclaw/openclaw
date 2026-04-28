// Package-local foundation exports. Core-only helpers are bound by the
// workspace facade.

export {
  parseDurationMs,
  resolveAgentContextLimits,
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  resolveStateDir,
  resolveUserPath,
  splitShellArgs,
  type MemoryBackend,
  type MemoryCitationsMode,
  type MemoryQmdConfig,
  type MemoryQmdIndexPath,
  type MemoryQmdMcporterConfig,
  type MemoryQmdSearchMode,
  type MemorySearchConfig,
  type OpenClawConfig,
  type SecretInput,
  type SessionSendPolicyConfig,
} from "./host/config-utils.js";
export {
  CHARS_PER_TOKEN_ESTIMATE,
  HEARTBEAT_PROMPT,
  HEARTBEAT_TOKEN,
  SILENT_REPLY_TOKEN,
  getMemoryHostServices,
  setMemoryHostServices,
  withMemoryHostServices,
  type MemoryHostServices,
} from "./host/services.js";
