// Shared memory results for Memory Wiki queries: a native provider answers through its
// provider runtime, and a legacy memory runtime keeps its manager calls and result shapes.
import path from "node:path";
import { filterMemorySearchHitsBySessionVisibility } from "@openclaw/memory-core/session-search-visibility-api.js";
import {
  getActiveMemorySearchManager,
  type MemoryCallerContext,
  type MemoryCitation,
  type MemoryReference,
} from "openclaw/plugin-sdk/memory-host-search";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawConfig } from "../api.js";
import {
  memoryReferenceLookup,
  resolveActiveMemoryAgentId,
  usesNativeMemoryProvider,
  withActiveMemoryProvider,
} from "./query-memory-provider.js";
import { normalizeLookupKey } from "./query-pages.js";

type ConversationRecallContext = NonNullable<OpenClawPluginToolContext["conversationRecall"]>;

// Legacy memory reads by path; native provider records use opaque lookups.
type SharedMemoryResultSource =
  | { corpus: "memory"; path: string; reference?: never; lookup?: never }
  | { corpus: "memory"; path?: never; reference: MemoryReference; lookup: string };

export type SharedMemorySearchResult<M extends string> = {
  title: string;
  kind: "memory";
  score: number;
  snippet: string;
  startLine?: number;
  endLine?: number;
  memorySource?: string;
  searchMode: M;
  citation?: string;
  citations?: MemoryCitation[];
} & SharedMemoryResultSource;

export type SharedMemoryPage = {
  title: string;
  kind: "memory";
  content: string;
  fromLine: number;
  lineCount: number;
  truncated?: boolean;
  citations?: MemoryCitation[];
} & SharedMemoryResultSource;

function buildLookupCandidates(lookup: string): string[] {
  const normalized = normalizeLookupKey(lookup);
  const withExtension = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
  return uniqueStrings([normalized, withExtension]);
}

export function shouldEnforceSessionVisibility(params: {
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): boolean {
  return (
    params.sandboxed === true ||
    Boolean(params.agentSessionKey?.trim()) ||
    Boolean(params.agentId?.trim())
  );
}

// Keep these path shapes aligned with source: "sessions" hits in session-search-visibility and session-transcript-hit.
function isSessionMemoryPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return normalized.startsWith("sessions/");
}

async function resolveActiveMemoryManager(params: {
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
}) {
  const agentId = resolveActiveMemoryAgentId(params);
  if (!params.appConfig || !agentId) {
    return null;
  }
  try {
    const { manager } = await getActiveMemorySearchManager({
      cfg: params.appConfig,
      agentId,
    });
    return manager;
  } catch {
    return null;
  }
}

// Registered managers come from the active memory plugin; nothing enforces
// the MemorySearchManager contract at runtime, so a partial manager would
// otherwise surface as "... is not a function" from inside the bundle.
function buildMemoryManagerContractError(method: "search" | "readFile"): Error {
  return new Error(
    `The active memory plugin's search manager does not implement ${method}() from the MemorySearchManager contract. ` +
      `Set search.backend to "local" for wiki-only access, or use a memory plugin that implements the contract.`,
  );
}

function buildMemorySearchTitle(resultPath: string): string {
  const basename = path.basename(resultPath, path.extname(resultPath));
  return basename.length > 0 ? basename : resultPath;
}

export type SharedMemorySearchParams = {
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  conversationRecall?: ConversationRecallContext;
  memoryContext?: MemoryCallerContext;
  signal?: AbortSignal;
  query: string;
};

export type SharedMemorySearchOptions<M extends string> = {
  maxResults: number;
  mode: M;
  protectedSessionRecall: boolean;
};

export async function searchSharedMemory<M extends string>(
  params: SharedMemorySearchParams,
  options: SharedMemorySearchOptions<M>,
): Promise<SharedMemorySearchResult<M>[]> {
  if (await usesNativeMemoryProvider(params)) {
    return await withActiveMemoryProvider(params, async ({ provider }) => {
      if (!provider) {
        return [];
      }
      const page = await provider.search({
        query: params.query,
        maxResults: options.maxResults,
        ...(options.protectedSessionRecall ? { sources: ["sessions" as const] } : {}),
      });
      return page.hits.map((result) => {
        const citation = result.citations?.[0];
        const hit: SharedMemorySearchResult<M> = {
          corpus: "memory",
          reference: result.reference,
          lookup: memoryReferenceLookup(result.reference),
          title: citation?.label ?? result.reference.id,
          kind: "memory",
          score: result.score ?? 0,
          snippet: result.excerpt,
          startLine: citation?.startLine,
          endLine: citation?.endLine,
          memorySource: result.source,
          searchMode: options.mode,
        };
        if (citation) {
          hit.citation = citation.label;
        }
        if (result.citations) {
          hit.citations = result.citations;
        }
        return hit;
      });
    });
  }
  const sharedMemoryManager = await resolveActiveMemoryManager(params);
  if (sharedMemoryManager && typeof sharedMemoryManager.search !== "function") {
    throw buildMemoryManagerContractError("search");
  }
  let rawMemoryResults = sharedMemoryManager
    ? await sharedMemoryManager.search(params.query, {
        maxResults: options.maxResults,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(options.protectedSessionRecall
          ? { sources: ["sessions" as const], sessionKey: params.agentSessionKey }
          : {}),
      })
    : [];
  if (
    params.appConfig &&
    shouldEnforceSessionVisibility(params) &&
    (params.conversationRecall || rawMemoryResults.some((hit) => hit.source === "sessions"))
  ) {
    rawMemoryResults = await filterMemorySearchHitsBySessionVisibility({
      cfg: params.appConfig,
      agentId: params.agentId,
      requesterSessionKey: params.agentSessionKey,
      sandboxed: params.sandboxed === true,
      hits: rawMemoryResults,
      conversationRecall: params.conversationRecall,
      trustedAgentScope: !params.agentSessionKey && Boolean(params.agentId?.trim()),
    });
  }
  return rawMemoryResults.map((result) => {
    const hit: SharedMemorySearchResult<M> = {
      corpus: "memory",
      path: result.path,
      title: buildMemorySearchTitle(result.path),
      kind: "memory",
      score: result.score,
      snippet: result.snippet,
      startLine: result.startLine,
      endLine: result.endLine,
      memorySource: result.source,
      searchMode: options.mode,
    };
    if (result.citation) {
      hit.citation = result.citation;
    }
    return hit;
  });
}

export type SharedMemoryReadParams = Omit<SharedMemorySearchParams, "query"> & {
  lookup: string;
  fromLine: number;
  lineCount: number;
};

/**
 * Reads one memory page for a Wiki lookup: a native provider resolves only the reference
 * it issued, and a legacy runtime resolves the lookup as a Markdown path.
 */
export async function readSharedMemoryPage(
  params: SharedMemoryReadParams,
  reference: MemoryReference | null,
): Promise<SharedMemoryPage | null> {
  if (reference) {
    return await withActiveMemoryProvider(params, async ({ provider }) => {
      if (!provider) {
        return null;
      }
      const result = await provider.get({
        reference,
        from: params.fromLine,
        lines: params.lineCount,
      });
      if (result.status === "not_found") {
        return null;
      }
      return {
        corpus: "memory" as const,
        reference: result.reference,
        lookup: memoryReferenceLookup(result.reference),
        citations: result.citations,
        title: result.citations?.[0]?.label ?? result.reference.id,
        kind: "memory" as const,
        content: result.text,
        fromLine: result.from ?? params.fromLine,
        lineCount: result.lines ?? params.lineCount,
        truncated: result.truncated,
      };
    });
  }
  if (await usesNativeMemoryProvider(params)) {
    return null;
  }
  const { fromLine, lineCount } = params;
  const manager = await resolveActiveMemoryManager(params);
  if (!manager) {
    return null;
  }
  if (typeof manager.readFile !== "function") {
    throw buildMemoryManagerContractError("readFile");
  }

  const lookupCandidates = buildLookupCandidates(params.lookup);
  const visibleSessionPaths =
    params.appConfig &&
    shouldEnforceSessionVisibility(params) &&
    lookupCandidates.some((relPath) => isSessionMemoryPath(relPath))
      ? new Set(
          (
            await filterMemorySearchHitsBySessionVisibility({
              cfg: params.appConfig,
              agentId: params.agentId,
              requesterSessionKey: params.agentSessionKey,
              sandboxed: params.sandboxed === true,
              conversationRecall: params.conversationRecall,
              trustedAgentScope: !params.agentSessionKey && Boolean(params.agentId?.trim()),
              hits: lookupCandidates
                .filter((relPath) => isSessionMemoryPath(relPath))
                .map((relPath) => ({
                  path: relPath,
                  startLine: 1,
                  endLine: 1,
                  score: 0,
                  snippet: "",
                  source: "sessions" as const,
                })),
            })
          ).map((hit) => hit.path),
        )
      : null;

  for (const relPath of lookupCandidates) {
    // Raw session candidates still need visibility checks; memory readers accept Markdown only.
    if (
      !relPath.endsWith(".md") ||
      (visibleSessionPaths && isSessionMemoryPath(relPath) && !visibleSessionPaths.has(relPath))
    ) {
      continue;
    }

    const result = await manager.readFile({
      relPath,
      from: fromLine,
      lines: lineCount,
    });
    if (result.status === "not_found") {
      continue;
    }
    return {
      corpus: "memory",
      path: result.path,
      title: buildMemorySearchTitle(result.path),
      kind: "memory",
      content: result.text,
      fromLine,
      lineCount,
    };
  }

  return null;
}
