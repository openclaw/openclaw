//#region packages/memory-host-sdk/src/host/config-utils.d.ts
type ChatType = "direct" | "group" | "channel";
type MemoryBackend = "builtin" | "qmd";
type MemoryCitationsMode = "auto" | "on" | "off";
type MemoryQmdSearchMode = "query" | "search" | "vsearch";
type MemoryQmdStartupMode = "off" | "idle" | "immediate";
type SessionSendPolicyAction = "allow" | "deny";
type SessionSendPolicyMatch = {
  channel?: string;
  chatType?: ChatType;
  keyPrefix?: string;
  rawKeyPrefix?: string;
};
type SessionSendPolicyRule = {
  action: SessionSendPolicyAction;
  match?: SessionSendPolicyMatch;
};
type SessionSendPolicyConfig = {
  default?: SessionSendPolicyAction;
  rules?: SessionSendPolicyRule[];
};
type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};
type MemoryQmdMcporterConfig = {
  enabled?: boolean;
  serverName?: string;
  startDaemon?: boolean;
};
type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};
type MemoryQmdUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  startup?: MemoryQmdStartupMode;
  startupDelayMs?: number;
  waitForBootSync?: boolean;
  embedInterval?: string;
  commandTimeoutMs?: number;
  updateTimeoutMs?: number;
  embedTimeoutMs?: number;
};
type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};
type MemoryQmdConfig = {
  command?: string;
  mcporter?: MemoryQmdMcporterConfig;
  searchMode?: MemoryQmdSearchMode;
  searchTool?: string;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};
type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
};
type MemorySearchConfig = {
  enabled?: boolean;
  extraPaths?: string[];
  qmd?: {
    extraCollections?: MemoryQmdIndexPath[];
  };
};
type AgentContextLimitsConfig = {
  memoryGetMaxChars?: number;
  memoryGetDefaultLines?: number;
};
type SecretInput = string | {
  source: string;
  provider: string;
  id: string;
};
type AgentConfig = {
  id?: string;
  default?: boolean;
  workspace?: string;
  memorySearch?: MemorySearchConfig;
  contextLimits?: AgentContextLimitsConfig;
};
type OpenClawConfig = {
  agents?: {
    defaults?: {
      workspace?: string;
      memorySearch?: MemorySearchConfig;
      contextLimits?: AgentContextLimitsConfig;
    };
    list?: AgentConfig[];
  };
  memory?: MemoryConfig;
  models?: {
    providers?: Record<string, {
      api?: string;
      baseUrl?: string;
      headers?: Record<string, SecretInput>;
    }>;
  };
};
//#endregion
//#region packages/memory-host-sdk/src/host/backend-config.d.ts
type ResolvedMemoryBackendConfig = {
  backend: MemoryBackend;
  citations: MemoryCitationsMode;
  qmd?: ResolvedQmdConfig;
};
type ResolvedQmdCollection = {
  name: string;
  path: string;
  pattern: string;
  kind: "memory" | "custom" | "sessions";
};
type ResolvedQmdUpdateConfig = {
  intervalMs: number;
  debounceMs: number;
  onBoot: boolean;
  startup: MemoryQmdStartupMode;
  startupDelayMs: number;
  waitForBootSync: boolean;
  embedIntervalMs: number;
  commandTimeoutMs: number;
  updateTimeoutMs: number;
  embedTimeoutMs: number;
};
type ResolvedQmdLimitsConfig = {
  maxResults: number;
  maxSnippetChars: number;
  maxInjectedChars: number;
  timeoutMs: number;
};
type ResolvedQmdSessionConfig = {
  enabled: boolean;
  exportDir?: string;
  retentionDays?: number;
};
type ResolvedQmdMcporterConfig = {
  enabled: boolean;
  serverName: string;
  startDaemon: boolean;
};
type ResolvedQmdConfig = {
  command: string;
  mcporter: ResolvedQmdMcporterConfig;
  searchMode: MemoryQmdSearchMode;
  searchTool?: string;
  collections: ResolvedQmdCollection[];
  sessions: ResolvedQmdSessionConfig;
  update: ResolvedQmdUpdateConfig;
  limits: ResolvedQmdLimitsConfig;
  includeDefaultMemory: boolean;
  scope?: SessionSendPolicyConfig;
};
declare function resolveMemoryBackendConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): ResolvedMemoryBackendConfig;
//#endregion
export { OpenClawConfig as a, resolveMemoryBackendConfig as i, ResolvedQmdConfig as n, ResolvedQmdMcporterConfig as r, ResolvedMemoryBackendConfig as t };