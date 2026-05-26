import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { j as MemoryCitationsMode } from "./types.tools-BpgZArJS.js";

//#region packages/memory-host-sdk/src/host/types.d.ts
type MemorySource = "memory" | "sessions";
type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};
type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
};
type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};
type MemorySearchRuntimeDebug = {
  backend: "builtin" | "qmd";
  configuredMode?: string;
  effectiveMode?: string;
  fallback?: string;
};
type MemoryReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};
type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: string[];
  sources?: MemorySource[];
  sourceCounts?: Array<{
    source: MemorySource;
    files: number;
    chunks: number;
  }>;
  cache?: {
    enabled: boolean;
    entries?: number;
    maxEntries?: number;
  };
  fts?: {
    enabled: boolean;
    available: boolean;
    error?: string;
  };
  fallback?: {
    from: string;
    reason?: string;
  };
  vector?: {
    enabled: boolean;
    storeAvailable?: boolean;
    semanticAvailable?: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
};
interface MemorySearchManager {
  search(query: string, opts?: {
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
    qmdSearchModeOverride?: "query" | "search" | "vsearch";
    onDebug?: (debug: MemorySearchRuntimeDebug) => void;
    sources?: MemorySource[];
  }): Promise<MemorySearchResult[]>;
  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<MemoryReadResult>;
  status(): MemoryProviderStatus;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  getCachedEmbeddingAvailability?(): MemoryEmbeddingProbeResult | null;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}
//#endregion
//#region src/plugins/memory-state.d.ts
type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) => string[];
type MemoryCorpusSearchResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  score: number;
  snippet: string;
  id?: string;
  startLine?: number;
  endLine?: number;
  citation?: string;
  source?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};
type MemoryCorpusGetResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  content: string;
  fromLine: number;
  lineCount: number;
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};
type MemoryCorpusSupplement = {
  search(params: {
    query: string;
    maxResults?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusSearchResult[]>;
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusGetResult | null>;
};
type MemoryCorpusSupplementRegistration = {
  pluginId: string;
  supplement: MemoryCorpusSupplement;
};
type MemoryPromptSupplementRegistration = {
  pluginId: string;
  builder: MemoryPromptSectionBuilder;
};
type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  model?: string;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
};
type MemoryFlushPlanResolver = (params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}) => MemoryFlushPlan | null;
type RegisteredMemorySearchManager = MemorySearchManager;
type MemoryRuntimeQmdConfig = {
  command?: string;
};
type MemoryRuntimeBackendConfig = {
  backend: "builtin";
} | {
  backend: "qmd";
  qmd?: MemoryRuntimeQmdConfig;
};
type MemoryPluginRuntime = {
  getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status" | "cli";
  }): Promise<{
    manager: RegisteredMemorySearchManager | null;
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): MemoryRuntimeBackendConfig;
  closeMemorySearchManager?(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): Promise<void>;
  closeAllMemorySearchManagers?(): Promise<void>;
};
type MemoryPluginPublicArtifactContentType = "markdown" | "json" | "text";
type MemoryPluginPublicArtifact = {
  kind: string;
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: MemoryPluginPublicArtifactContentType;
};
type MemoryPluginPublicArtifactsProvider = {
  listArtifacts(params: {
    cfg: OpenClawConfig;
  }): Promise<MemoryPluginPublicArtifact[]>;
};
type MemoryPluginCapability = {
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
  publicArtifacts?: MemoryPluginPublicArtifactsProvider;
};
type MemoryPluginCapabilityRegistration = {
  pluginId: string;
  capability: MemoryPluginCapability;
};
type MemoryPluginState = {
  capability?: MemoryPluginCapabilityRegistration;
  corpusSupplements: MemoryCorpusSupplementRegistration[];
  promptSupplements: MemoryPromptSupplementRegistration[];
};
declare function registerMemoryCorpusSupplement(pluginId: string, supplement: MemoryCorpusSupplement): void;
declare function registerMemoryCapability(pluginId: string, capability: MemoryPluginCapability): void;
declare function getMemoryCapabilityRegistration(): MemoryPluginCapabilityRegistration | undefined;
declare function listMemoryCorpusSupplements(): MemoryCorpusSupplementRegistration[];
/** @deprecated Use registerMemoryCapability(pluginId, { promptBuilder }) instead. */
declare function registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void;
declare function registerMemoryPromptSectionForPlugin(pluginId: string, builder: MemoryPromptSectionBuilder): void;
declare function registerMemoryPromptSupplement(pluginId: string, builder: MemoryPromptSectionBuilder): void;
declare function buildMemoryPromptSection(params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[];
declare function getMemoryPromptSectionBuilder(): MemoryPromptSectionBuilder | undefined;
declare function listMemoryPromptSupplements(): MemoryPromptSupplementRegistration[];
/** @deprecated Use registerMemoryCapability(pluginId, { flushPlanResolver }) instead. */
declare function registerMemoryFlushPlanResolver(resolver: MemoryFlushPlanResolver): void;
declare function registerMemoryFlushPlanResolverForPlugin(pluginId: string, resolver: MemoryFlushPlanResolver): void;
declare function resolveMemoryFlushPlan(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}): MemoryFlushPlan | null;
declare function getMemoryFlushPlanResolver(): MemoryFlushPlanResolver | undefined;
/** @deprecated Use registerMemoryCapability(pluginId, { runtime }) instead. */
declare function registerMemoryRuntime(runtime: MemoryPluginRuntime): void;
declare function registerMemoryRuntimeForPlugin(pluginId: string, runtime: MemoryPluginRuntime): void;
declare function getMemoryRuntime(): MemoryPluginRuntime | undefined;
declare function hasMemoryRuntime(): boolean;
declare function listActiveMemoryPublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]>;
declare function restoreMemoryPluginState(state: MemoryPluginState): void;
declare function clearMemoryPluginState(): void;
declare const resetMemoryPluginState: typeof clearMemoryPluginState;
//#endregion
export { registerMemoryFlushPlanResolver as A, MemoryProviderStatus as B, getMemoryRuntime as C, listMemoryPromptSupplements as D, listMemoryCorpusSupplements as E, registerMemoryRuntime as F, MemorySyncProgressUpdate as G, MemorySearchManager as H, registerMemoryRuntimeForPlugin as I, resetMemoryPluginState as L, registerMemoryPromptSection as M, registerMemoryPromptSectionForPlugin as N, registerMemoryCapability as O, registerMemoryPromptSupplement as P, resolveMemoryFlushPlan as R, getMemoryPromptSectionBuilder as S, listActiveMemoryPublicArtifacts as T, MemorySearchResult as U, MemoryReadResult as V, MemorySearchRuntimeDebug as W, RegisteredMemorySearchManager as _, MemoryFlushPlan as a, getMemoryCapabilityRegistration as b, MemoryPluginCapabilityRegistration as c, MemoryPluginPublicArtifactsProvider as d, MemoryPluginRuntime as f, MemoryRuntimeQmdConfig as g, MemoryRuntimeBackendConfig as h, MemoryCorpusSupplementRegistration as i, registerMemoryFlushPlanResolverForPlugin as j, registerMemoryCorpusSupplement as k, MemoryPluginPublicArtifact as l, MemoryPromptSupplementRegistration as m, MemoryCorpusSearchResult as n, MemoryFlushPlanResolver as o, MemoryPromptSectionBuilder as p, MemoryCorpusSupplement as r, MemoryPluginCapability as s, MemoryCorpusGetResult as t, MemoryPluginPublicArtifactContentType as u, buildMemoryPromptSection as v, hasMemoryRuntime as w, getMemoryFlushPlanResolver as x, clearMemoryPluginState as y, restoreMemoryPluginState as z };