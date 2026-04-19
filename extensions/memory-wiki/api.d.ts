export {
  buildPluginConfigSchema,
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawConfig,
  type OpenClawPluginApi,
  type OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";
export { z } from "openclaw/plugin-sdk/zod";

export type WikiVaultMode = "isolated" | "bridge" | "unsafe-local";
export type WikiRenderMode = "native" | "obsidian";
export type WikiSearchBackend = "shared" | "local";
export type WikiSearchCorpus = "wiki" | "memory" | "all";
export type WikiPageKind = "entity" | "concept" | "source" | "synthesis" | "report";

export type MemoryWikiPluginConfig = {
  vaultMode?: WikiVaultMode;
  vault?: {
    path?: string;
    renderMode?: WikiRenderMode;
  };
  obsidian?: {
    enabled?: boolean;
    useOfficialCli?: boolean;
    vaultName?: string;
    openAfterWrites?: boolean;
  };
  bridge?: {
    enabled?: boolean;
    readMemoryArtifacts?: boolean;
    indexDreamReports?: boolean;
    indexDailyNotes?: boolean;
    indexMemoryRoot?: boolean;
    followMemoryEvents?: boolean;
  };
  unsafeLocal?: {
    allowPrivateMemoryCoreAccess?: boolean;
    paths?: string[];
  };
  ingest?: {
    autoCompile?: boolean;
    maxConcurrentJobs?: number;
    allowUrlIngest?: boolean;
  };
  search?: {
    backend?: WikiSearchBackend;
    corpus?: WikiSearchCorpus;
  };
  context?: {
    includeCompiledDigestPrompt?: boolean;
  };
  render?: {
    preserveHumanBlocks?: boolean;
    createBacklinks?: boolean;
    createDashboards?: boolean;
  };
};

export type ResolvedMemoryWikiConfig = {
  vaultMode: WikiVaultMode;
  vault: {
    path: string;
    renderMode: WikiRenderMode;
  };
  obsidian: {
    enabled: boolean;
    useOfficialCli: boolean;
    vaultName?: string;
    openAfterWrites: boolean;
  };
  bridge: {
    enabled: boolean;
    readMemoryArtifacts: boolean;
    indexDreamReports: boolean;
    indexDailyNotes: boolean;
    indexMemoryRoot: boolean;
    followMemoryEvents: boolean;
  };
  unsafeLocal: {
    allowPrivateMemoryCoreAccess: boolean;
    paths: string[];
  };
  ingest: {
    autoCompile: boolean;
    maxConcurrentJobs: number;
    allowUrlIngest: boolean;
  };
  search: {
    backend: WikiSearchBackend;
    corpus: WikiSearchCorpus;
  };
  context: {
    includeCompiledDigestPrompt: boolean;
  };
  render: {
    preserveHumanBlocks: boolean;
    createBacklinks: boolean;
    createDashboards: boolean;
  };
};

export type WikiSearchResult = {
  corpus: "wiki" | "memory";
  path: string;
  title: string;
  kind: WikiPageKind | "memory";
  score: number;
  snippet: string;
  id?: string;
  startLine?: number;
  endLine?: number;
  citation?: string;
  memorySource?: string;
  sourceType?: string;
  provenanceMode?: string;
  sourcePath?: string;
  provenanceLabel?: string;
  updatedAt?: string;
};

export type WikiGetResult = {
  corpus: "wiki" | "memory";
  path: string;
  title: string;
  kind: WikiPageKind | "memory";
  content: string;
  fromLine: number;
  lineCount: number;
  totalLines?: number;
  truncated?: boolean;
  id?: string;
  sourceType?: string;
  provenanceMode?: string;
  sourcePath?: string;
  provenanceLabel?: string;
  updatedAt?: string;
};

export declare function resolveMemoryWikiConfig(
  config: MemoryWikiPluginConfig | undefined,
  options?: { homedir?: string },
): ResolvedMemoryWikiConfig;

export declare function searchMemoryWiki(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  query: string;
  maxResults?: number;
  searchBackend?: WikiSearchBackend;
  searchCorpus?: WikiSearchCorpus;
}): Promise<WikiSearchResult[]>;

export declare function getMemoryWikiPage(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  searchBackend?: WikiSearchBackend;
  searchCorpus?: WikiSearchCorpus;
}): Promise<WikiGetResult | null>;
