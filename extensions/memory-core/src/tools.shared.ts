import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  listMemoryCorpusSupplements,
  resolveMemorySearchConfig,
  resolveSessionAgentId,
  type MemoryCorpusGetResult,
  type MemoryCorpusSearchResult,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

type MemoryToolRuntime = typeof import("./tools.runtime.js");
type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("./memory/index.js"))["getMemorySearchManager"]>
>;

let memoryToolRuntimePromise: Promise<MemoryToolRuntime> | null = null;

export async function loadMemoryToolRuntime(): Promise<MemoryToolRuntime> {
  memoryToolRuntimePromise ??= import("./tools.runtime.js");
  return await memoryToolRuntimePromise;
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
    return [];
  }
  const results = (
    await Promise.all(
      supplements.map(async (registration) => await registration.supplement.search(params)),
    )
  ).flat();
  return results
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, params.maxResults ?? 10));
}

export async function getMemoryCorpusSupplementResult(params: {
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
  return null;
}

function tokenizeFallbackQuery(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  return terms.length > 0
    ? Array.from(new Set(terms))
    : [query.trim().toLowerCase()].filter(Boolean);
}

function countOccurrences(text: string, term: string): number {
  if (!term) {
    return 0;
  }
  let count = 0;
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(term, from);
    if (index < 0) {
      break;
    }
    count += 1;
    from = index + Math.max(1, term.length);
  }
  return count;
}

function buildFallbackSearchResult(params: {
  relPath: string;
  lines: string[];
  terms: string[];
  wholeQuery: string;
  minScore?: number;
}): MemorySearchResult | null {
  const loweredLines = params.lines.map((line) => line.toLowerCase());
  let best:
    | {
        score: number;
        startLine: number;
        endLine: number;
      }
    | undefined;
  for (let index = 0; index < loweredLines.length; index += 1) {
    const startIndex = Math.max(0, index - 1);
    const endIndex = Math.min(loweredLines.length - 1, index + 1);
    const windowText = loweredLines.slice(startIndex, endIndex + 1).join("\n");
    const matchedTerms = params.terms.filter((term) => windowText.includes(term));
    if (matchedTerms.length === 0 && !windowText.includes(params.wholeQuery)) {
      continue;
    }
    const hitCount = params.terms.reduce(
      (sum, term) => sum + countOccurrences(windowText, term),
      0,
    );
    const score = Math.min(
      1,
      (matchedTerms.length / Math.max(1, params.terms.length)) * 0.8 +
        (windowText.includes(params.wholeQuery) ? 0.15 : 0) +
        Math.min(0.05, hitCount * 0.01),
    );
    if (params.minScore !== undefined && score < params.minScore) {
      continue;
    }
    const candidate = {
      score,
      startLine: startIndex + 1,
      endLine: endIndex + 1,
    };
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.startLine < best.startLine)
    ) {
      best = candidate;
    }
  }
  if (!best) {
    return null;
  }
  const snippet = params.lines
    .slice(best.startLine - 1, best.endLine)
    .join("\n")
    .trim();
  if (!snippet) {
    return null;
  }
  return {
    path: params.relPath,
    startLine: best.startLine,
    endLine: best.endLine,
    score: best.score,
    snippet,
    source: "memory",
  };
}

export async function searchWorkspaceMemoryFilesFallback(params: {
  cfg: OpenClawConfig;
  agentId: string;
  query: string;
  maxResults?: number;
  minScore?: number;
}): Promise<MemorySearchResult[]> {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const candidates = [path.join(workspaceDir, "MEMORY.md")];
  try {
    const memoryDirEntries = await fs.readdir(path.join(workspaceDir, "memory"), {
      withFileTypes: true,
    });
    for (const entry of memoryDirEntries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        candidates.push(path.join(workspaceDir, "memory", entry.name));
      }
    }
  } catch {}
  const terms = tokenizeFallbackQuery(params.query);
  const wholeQuery = params.query.trim().toLowerCase();
  const results: MemorySearchResult[] = [];
  for (const absPath of candidates) {
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch {
      continue;
    }
    const relPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
    const result = buildFallbackSearchResult({
      relPath,
      lines: content.split(/\r?\n/),
      terms,
      wholeQuery,
      minScore: params.minScore,
    });
    if (result) {
      results.push(result);
    }
  }
  return results
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      if (left.path !== right.path) {
        return left.path.localeCompare(right.path);
      }
      return left.startLine - right.startLine;
    })
    .slice(0, Math.max(1, params.maxResults ?? 10));
}
