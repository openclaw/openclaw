// Package-local memory runtime contract. Core binds richer OpenClaw services
// through src/memory-host-sdk; this package stays host-agnostic.

export {
  SILENT_REPLY_TOKEN,
  getMemoryHostServices,
  setMemoryHostServices,
  withMemoryHostServices,
  type MemoryHostServices,
} from "./host/services.js";
export {
  resolveMemorySearchConfig,
  resolveStateDir,
  type MemoryCitationsMode,
  type OpenClawConfig,
} from "./host/config-utils.js";
