import { i as OpenClawConfig } from "./types.openclaw-BYfkTL_f.js";
import { j as MemoryCitationsMode } from "./types.tools-DLW0nzGW.js";
import { r as MemorySearchManager } from "./types-Bi2nhdvf.js";

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
export { registerMemoryFlushPlanResolver as A, getMemoryRuntime as C, listMemoryPromptSupplements as D, listMemoryCorpusSupplements as E, registerMemoryRuntime as F, registerMemoryRuntimeForPlugin as I, resetMemoryPluginState as L, registerMemoryPromptSection as M, registerMemoryPromptSectionForPlugin as N, registerMemoryCapability as O, registerMemoryPromptSupplement as P, resolveMemoryFlushPlan as R, getMemoryPromptSectionBuilder as S, listActiveMemoryPublicArtifacts as T, RegisteredMemorySearchManager as _, MemoryFlushPlan as a, getMemoryCapabilityRegistration as b, MemoryPluginCapabilityRegistration as c, MemoryPluginPublicArtifactsProvider as d, MemoryPluginRuntime as f, MemoryRuntimeQmdConfig as g, MemoryRuntimeBackendConfig as h, MemoryCorpusSupplementRegistration as i, registerMemoryFlushPlanResolverForPlugin as j, registerMemoryCorpusSupplement as k, MemoryPluginPublicArtifact as l, MemoryPromptSupplementRegistration as m, MemoryCorpusSearchResult as n, MemoryFlushPlanResolver as o, MemoryPromptSectionBuilder as p, MemoryCorpusSupplement as r, MemoryPluginCapability as s, MemoryCorpusGetResult as t, MemoryPluginPublicArtifactContentType as u, buildMemoryPromptSection as v, hasMemoryRuntime as w, getMemoryFlushPlanResolver as x, clearMemoryPluginState as y, restoreMemoryPluginState as z };