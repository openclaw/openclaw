import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers/types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_COMPACTION_TIMEOUT_MS = 30_000;
const COMPACTION_MAX_INPUT_CHARS = 10_000;
const COMPACTION_MAX_FILES = 3;
/** Bump this when COMPACTION_SYSTEM_PROMPT changes to invalidate caches. */
const COMPACTION_CACHE_VERSION = 1;

export const COMPACTION_SYSTEM_PROMPT = [
  "You are a memory compaction assistant. Given the content of a memory file, produce a structured summary using EXACTLY the following template — no additional sections, no content outside the headers:",
  "",
  "## Key Rules",
  "[Essential rules and constraints from the original content]",
  "",
  "## Recent Decisions",
  "[Decisions made recently with rationale]",
  "",
  "## Open Tasks / Blockers",
  "[Active tasks, their status, and any blockers]",
  "",
  "## Critical References",
  "[Important file paths, URLs, IDs, and technical details that must be preserved exactly]",
  "",
  "RULES:",
  "- Use the exact four section headers above.",
  "- Preserve all identifiers exactly: UUIDs, IDs, file paths, URLs, IP addresses, model names, config keys.",
  "- Prioritize recent information over older information.",
  "- Keep output under 5000 characters total.",
  "- If a section has no relevant content, write '[none]' for that section.",
].join("\n");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BootstrapCompactionConfig {
  /**
   * Model to use for compaction (provider/model format, e.g. "anthropic/claude-haiku-4-5-20251001").
   * When unset, inherits the agent's current model.
   */
  model?: string;
  /** Timeout in ms. Default 30_000. */
  timeoutMs?: number;
}

export interface CompactionResult {
  /** Original file path */
  path: string;
  /** Original char count */
  charsBefore: number;
  /** Compacted char count */
  charsAfter: number;
  /** Whether compaction was attempted and succeeded */
  success: boolean;
  /** If failed, the reason */
  fallbackReason?: string;
}

/**
 * Provider-agnostic LLM call function.
 * Takes the user prompt (with system prompt already embedded by the caller or
 * handled internally) and returns the model's text response.
 *
 * The caller is responsible for wiring up model resolution, auth, and the
 * actual API call (via completeSimple or equivalent).
 */
export type CompactionLlmFn = (userPrompt: string, signal?: AbortSignal) => Promise<string>;

// ── Content-hash cache ────────────────────────────────────────────────────────

/**
 * In-memory LRU cache (process lifetime). Key = file path, value = { hash, compacted }.
 * Avoids redundant LLM calls when file content hasn't changed.
 * Capped at MAX_CACHE_ENTRIES to prevent unbounded memory growth.
 */
const MAX_CACHE_ENTRIES = 100;
const compactionCache = new Map<string, { hash: string; compacted: string }>();

function cacheSet(key: string, value: { hash: string; compacted: string }): void {
  // Delete-then-set to refresh LRU order (Map iterates in insertion order)
  compactionCache.delete(key);
  compactionCache.set(key, value);
  // Evict oldest entries when over limit
  if (compactionCache.size > MAX_CACHE_ENTRIES) {
    const oldest = compactionCache.keys().next().value;
    if (oldest !== undefined) {
      compactionCache.delete(oldest);
    }
  }
}

/** Exported for testing only. */
export function clearCompactionCache(): void {
  compactionCache.clear();
}

function getContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve compaction config from OpenClawConfig.
 * Config path: cfg.agents.defaults.compaction.model / .timeoutMs
 */
export function resolveCompactionConfig(cfg?: OpenClawConfig): BootstrapCompactionConfig {
  const raw = cfg?.agents?.defaults?.compaction;
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  return {
    model: typeof obj.model === "string" ? obj.model : undefined,
    timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : undefined,
  };
}

/**
 * Check if a bootstrap file is eligible for compaction.
 * Only MEMORY.md and memory/YYYY-MM-DD.md files can be compacted.
 */
export function isCompactableFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (basename === "MEMORY.md") {
    return true;
  }
  // Match memory/YYYY-MM-DD.md pattern
  if (/^20\d{2}-\d{2}-\d{2}\.md$/.test(basename)) {
    const dir = path.basename(path.dirname(filePath));
    return dir === "memory";
  }
  return false;
}

// ── Core compaction functions ─────────────────────────────────────────────────

/**
 * Compact a single bootstrap file using LLM summarization.
 *
 * Uses content-hash caching: if the file content hasn't changed since last
 * compaction, returns the cached result without calling the LLM.
 *
 * The actual LLM call is delegated to `llmFn`, making this function
 * provider-agnostic. The caller wires up model resolution and auth.
 *
 * Always returns successfully — on LLM failure, returns the original content
 * with success=false and fallbackReason set.
 */
export async function compactBootstrapFile(params: {
  content: string;
  filePath: string;
  config: BootstrapCompactionConfig;
  /** Provider-agnostic LLM call. The caller resolves model + auth. */
  llmFn: CompactionLlmFn;
  /** Resolved "provider/model" used for compaction. Included in cache key so switching models invalidates. */
  modelRef: string;
  signal?: AbortSignal;
}): Promise<{ compacted: string; result: CompactionResult }> {
  const { content, filePath, signal } = params;
  const charsBefore = content.length;

  // Enforce max input size — head+tail split to preserve recent content at end of file.
  // MEMORY.md and daily memory files have latest entries at the bottom.
  let inputContent: string;
  if (content.length > COMPACTION_MAX_INPUT_CHARS) {
    const headChars = Math.floor(COMPACTION_MAX_INPUT_CHARS * 0.3);
    const tailChars = COMPACTION_MAX_INPUT_CHARS - headChars;
    inputContent =
      content.slice(0, headChars) +
      "\n\n[... middle content omitted for compaction ...]\n\n" +
      content.slice(-tailChars);
  } else {
    inputContent = content;
  }

  // Cache lookup — hash the FULL content (pre-truncation) so middle-of-file
  // edits invalidate the cache. Include cache version + resolved model so
  // prompt changes and model switches also miss.
  const hashInput = `v${COMPACTION_CACHE_VERSION}:${params.modelRef}:${content}`;
  const contentHash = getContentHash(hashInput);
  const cached = compactionCache.get(filePath);
  if (cached?.hash === contentHash) {
    // Refresh LRU position on cache hit
    cacheSet(filePath, cached);
    return {
      compacted: cached.compacted,
      result: {
        path: filePath,
        charsBefore,
        charsAfter: cached.compacted.length,
        success: true,
      },
    };
  }

  try {
    const compacted = await params.llmFn(inputContent, signal);

    // Guard: if LLM output is not shorter than original, compaction is
    // counter-productive — fall back to original content.
    if (compacted.length >= charsBefore) {
      return {
        compacted: content,
        result: {
          path: filePath,
          charsBefore,
          charsAfter: charsBefore,
          success: false,
          fallbackReason: `compacted output (${compacted.length} chars) not shorter than original (${charsBefore} chars)`,
        },
      };
    }

    cacheSet(filePath, { hash: contentHash, compacted });

    return {
      compacted,
      result: {
        path: filePath,
        charsBefore,
        charsAfter: compacted.length,
        success: true,
      },
    };
  } catch (err) {
    const fallbackReason = err instanceof Error ? err.message : String(err);
    return {
      compacted: content,
      result: {
        path: filePath,
        charsBefore,
        charsAfter: charsBefore,
        success: false,
        fallbackReason,
      },
    };
  }
}

/**
 * Try to compact eligible files in a bootstrap context file list.
 * Selects up to COMPACTION_MAX_FILES largest compactable files.
 * Returns new context files with compacted content + per-file results.
 */
export async function compactBootstrapFiles(params: {
  contextFiles: EmbeddedContextFile[];
  config: BootstrapCompactionConfig;
  /** Provider-agnostic LLM call. The caller resolves model + auth. */
  llmFn: CompactionLlmFn;
  /** Resolved "provider/model" used for compaction. Passed to per-file cache key. */
  modelRef: string;
  signal?: AbortSignal;
}): Promise<{
  contextFiles: EmbeddedContextFile[];
  results: CompactionResult[];
}> {
  const { contextFiles, config, signal } = params;

  // Select compactable files, sorted by size descending, capped at max
  const compactable = contextFiles
    .filter((f) => isCompactableFile(f.path))
    .toSorted((a, b) => b.content.length - a.content.length)
    .slice(0, COMPACTION_MAX_FILES);

  if (compactable.length === 0) {
    return { contextFiles, results: [] };
  }

  const compactableSet = new Set(compactable.map((f) => f.path));
  const results: CompactionResult[] = [];
  const compactedMap = new Map<string, string>();

  // Overall compaction deadline: total budget across all files.
  // Per-file timeout prevents one slow file from starving the rest,
  // but the overall deadline caps total compaction latency.
  const rawTimeout = config.timeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS;
  const sanitizedTimeout =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.floor(rawTimeout)
      : DEFAULT_COMPACTION_TIMEOUT_MS;
  const overallDeadline = AbortSignal.timeout(sanitizedTimeout * compactable.length);
  const overallSignal = signal ? AbortSignal.any([signal, overallDeadline]) : overallDeadline;

  for (const file of compactable) {
    // Each file gets its own timeout to avoid one slow file starving the rest.
    const perFileTimeout = AbortSignal.timeout(sanitizedTimeout);
    const mergedSignal = AbortSignal.any([overallSignal, perFileTimeout]);
    const { compacted, result } = await compactBootstrapFile({
      content: file.content,
      filePath: file.path,
      config,
      llmFn: params.llmFn,
      modelRef: params.modelRef,
      signal: mergedSignal,
    });
    results.push(result);
    if (result.success) {
      compactedMap.set(file.path, compacted);
    }
  }

  // Rebuild context files list with compacted content where successful
  const updatedContextFiles = contextFiles.map((f) => {
    if (compactableSet.has(f.path) && compactedMap.has(f.path)) {
      return { ...f, content: compactedMap.get(f.path) as string };
    }
    return f;
  });

  return { contextFiles: updatedContextFiles, results };
}
