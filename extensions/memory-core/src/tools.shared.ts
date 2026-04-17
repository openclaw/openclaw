import { Type } from "@sinclair/typebox";
import type { MemoryWikiPluginConfig } from "openclaw/extensions/memory-wiki/api";
import {
  listMemoryCorpusSupplements,
  resolveMemorySearchConfig,
  resolveSessionAgentId,
  type MemoryCorpusGetResult,
  type MemoryCorpusSearchResult,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

type MemoryToolRuntime = typeof import("./tools.runtime.js");
type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("./memory/index.js"))["getMemorySearchManager"]>
>;

type MemoryWikiFallbackRuntime = {
  resolveMemoryWikiConfig: (typeof import("openclaw/extensions/memory-wiki/api"))["resolveMemoryWikiConfig"];
  searchMemoryWiki: (typeof import("openclaw/extensions/memory-wiki/api"))["searchMemoryWiki"];
  getMemoryWikiPage: (typeof import("openclaw/extensions/memory-wiki/api"))["getMemoryWikiPage"];
};

let memoryToolRuntimePromise: Promise<MemoryToolRuntime> | null = null;
let memoryWikiFallbackRuntimePromise: Promise<MemoryWikiFallbackRuntime> | null = null;

export async function loadMemoryToolRuntime(): Promise<MemoryToolRuntime> {
  memoryToolRuntimePromise ??= import("./tools.runtime.js");
  return await memoryToolRuntimePromise;
}

async function loadMemoryWikiFallbackRuntime(): Promise<MemoryWikiFallbackRuntime> {
  memoryWikiFallbackRuntimePromise ??= import("openclaw/extensions/memory-wiki/api").then(
    ({ resolveMemoryWikiConfig, searchMemoryWiki, getMemoryWikiPage }) => ({
      resolveMemoryWikiConfig,
      searchMemoryWiki,
      getMemoryWikiPage,
    }),
  );
  return await memoryWikiFallbackRuntimePromise;
}

function resolveMemoryWikiEntryConfig(cfg: OpenClawConfig): MemoryWikiPluginConfig | undefined {
  const entry = cfg.plugins?.entries?.["memory-wiki"];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  if (entry.enabled === false) {
    return undefined;
  }
  const config = entry.config;
  if (config == null) {
    return {} as MemoryWikiPluginConfig;
  }
  return typeof config === "object" && !Array.isArray(config)
    ? (config as MemoryWikiPluginConfig)
    : undefined;
}

async function searchMemoryWikiFallback(params: {
  cfg: OpenClawConfig;
  agentId: string;
  query: string;
  maxResults?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all";
}): Promise<MemoryCorpusSearchResult[]> {
  if (params.corpus === "memory") {
    return [];
  }
  const wikiConfig = resolveMemoryWikiEntryConfig(params.cfg);
  if (!wikiConfig) {
    return [];
  }
  const { resolveMemoryWikiConfig, searchMemoryWiki } = await loadMemoryWikiFallbackRuntime();
  return await searchMemoryWiki({
    config: resolveMemoryWikiConfig(wikiConfig),
    appConfig: params.cfg,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    query: params.query,
    maxResults: params.maxResults,
    searchBackend: "local",
    searchCorpus: "wiki",
  });
}

async function getMemoryWikiFallback(params: {
  cfg: OpenClawConfig;
  agentId: string;
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all";
}): Promise<MemoryCorpusGetResult | null> {
  if (params.corpus === "memory") {
    return null;
  }
  const wikiConfig = resolveMemoryWikiEntryConfig(params.cfg);
  if (!wikiConfig) {
    return null;
  }
  const { resolveMemoryWikiConfig, getMemoryWikiPage } = await loadMemoryWikiFallbackRuntime();
  return await getMemoryWikiPage({
    config: resolveMemoryWikiConfig(wikiConfig),
    appConfig: params.cfg,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    lookup: params.lookup,
    fromLine: params.fromLine,
    lineCount: params.lineCount,
    searchBackend: "local",
    searchCorpus: "wiki",
  });
}

export const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
  corpus: Type.Optional(
    Type.Union([Type.Literal("memory"), Type.Literal("wiki"), Type.Literal("all")]),
  ),
});

export const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
  corpus: Type.Optional(
    Type.Union([Type.Literal("memory"), Type.Literal("wiki"), Type.Literal("all")]),
  ),
});

export function resolveMemoryToolContext(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

export async function getMemoryManagerContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  return await getMemoryManagerContextWithPurpose({ ...params, purpose: undefined });
}

export async function getMemoryManagerContextWithPurpose(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  const { getMemorySearchManager } = await loadMemoryToolRuntime();
  const { manager, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: params.purpose,
  });
  return manager ? { manager } : { error };
}

export function createMemoryTool(params: {
  options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
  };
  label: string;
  name: string;
  description: string;
  parameters: typeof MemorySearchSchema | typeof MemoryGetSchema;
  execute: (ctx: { cfg: OpenClawConfig; agentId: string }) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.label,
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    execute: params.execute(ctx),
  };
}

export function buildMemorySearchUnavailableResult(error: string | undefined) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const isQuotaError = /insufficient_quota|quota|429/.test(normalizeLowercaseStringOrEmpty(reason));
  const warning = isQuotaError
    ? "Memory search is unavailable because the embedding provider quota is exhausted."
    : "Memory search is unavailable due to an embedding/provider error.";
  const action = isQuotaError
    ? "Top up or switch embedding provider, then retry memory_search."
    : "Check embedding provider configuration and retry memory_search.";
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
    debug: {
      warning,
      action,
      error: reason,
    },
  };
}

export async function searchMemoryCorpusSupplements(params: {
  cfg: OpenClawConfig;
  agentId: string;
  query: string;
  maxResults?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all";
}): Promise<MemoryCorpusSearchResult[]> {
  if (params.corpus === "memory") {
    return [];
  }
  const supplements = listMemoryCorpusSupplements();
  if (supplements.length === 0) {
    return await searchMemoryWikiFallback(params);
  }
  const hasMemoryWikiSupplement = supplements.some(
    (registration) => registration.pluginId === "memory-wiki",
  );
  const results = (
    await Promise.all(
      supplements.map(async (registration) => await registration.supplement.search(params)),
    )
  ).flat();
  const sorted = results
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, params.maxResults ?? 10));
  if (sorted.length > 0) {
    return sorted;
  }
  if (hasMemoryWikiSupplement) {
    return [];
  }
  return await searchMemoryWikiFallback(params);
}

export async function getMemoryCorpusSupplementResult(params: {
  cfg: OpenClawConfig;
  agentId: string;
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all";
}): Promise<MemoryCorpusGetResult | null> {
  if (params.corpus === "memory") {
    return null;
  }
  for (const registration of listMemoryCorpusSupplements()) {
    const result = await registration.supplement.get(params);
    if (result) {
      return result;
    }
  }
  return await getMemoryWikiFallback(params);
}
