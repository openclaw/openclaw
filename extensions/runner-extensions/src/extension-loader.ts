/**
 * Dynamic pi-extension path resolution and memory-context wiring.
 *
 * Extracted from src/agents/pi-embedded-runner/extensions.ts on dev branch.
 * This module provides self-contained logic without modifying core files.
 */
import fs from "node:fs";
import path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export type MemoryContextAgentConfig = {
  /** Enable memory-context extensions (default: false, opt-in). */
  enabled?: boolean;
  /** Hard cap on injected recalled-context tokens (default: 4000). */
  hardCapTokens?: number;
  /** Embedding model: "auto" | "gemini" | "hash" | "transformer". */
  embeddingModel?: "auto" | "gemini" | "hash" | "transformer";
  /** Storage path for JSONL + vectors.bin. */
  storagePath?: string;
  /** Redact secrets before persisting. */
  redaction?: boolean;
  /** Enable async knowledge extraction via LLM. */
  knowledgeExtraction?: boolean;
  /** Minimum similarity score for auto-recall (0-1). */
  autoRecallMinScore?: number;
  /** Max segments in warm store. */
  maxSegments?: number;
  /** Search across all sessions. */
  crossSession?: boolean;
  /** Max age in days for warm store eviction (0 = disabled). */
  evictionDays?: number;
};

export type ExtensionPathsParams = {
  /** Caller's own `import.meta.url` or `__filename` for path resolution. */
  callerPath: string;
  /** Extension id (e.g. "compaction-safeguard", "memory-context-recall"). */
  extensionId: string;
};

// ─── Extension Path Resolution ──────────────────────────────────────────────

/**
 * Resolve the filesystem path for a pi-extension by id.
 *
 * In dev mode, `.ts` files are loaded directly (via tsx/jiti).
 * In production (`.js`), if the compiled file doesn't exist, falls back
 * to the `.ts` source that jiti can still load.
 */
export function resolveExtensionPath(params: ExtensionPathsParams): string {
  const callerDir = path.dirname(params.callerPath);
  const ext = path.extname(params.callerPath) === ".ts" ? "ts" : "js";
  const resolved = path.join(callerDir, `${params.extensionId}.${ext}`);

  if (ext === "js" && !fs.existsSync(resolved)) {
    // In dist mode, .js files may not exist for newer extensions;
    // fall back to .ts source files that jiti can load.
    const tsPath = resolved.replace(/\.js$/, ".ts");
    if (fs.existsSync(tsPath)) {
      return tsPath;
    }
  }

  return resolved;
}

/**
 * Build the list of pi-extension paths that should be loaded for a session.
 *
 * This is the portable version of the logic from
 * `src/agents/pi-embedded-runner/extensions.ts` on the dev branch,
 * packaged as a self-contained utility.
 *
 * The caller (e.g. `buildEmbeddedExtensionPaths`) can call this and
 * merge the results into its own path list.
 */
export function buildExtensionPaths(params: {
  callerPath: string;
  memoryContext?: MemoryContextAgentConfig;
  compactionMode?: "default" | "safeguard";
}): string[] {
  const paths: string[] = [];

  if (params.compactionMode === "safeguard") {
    paths.push(
      resolveExtensionPath({
        callerPath: params.callerPath,
        extensionId: "compaction-safeguard",
      }),
    );
  }

  if (params.memoryContext?.enabled) {
    paths.push(
      resolveExtensionPath({
        callerPath: params.callerPath,
        extensionId: "memory-context-recall",
      }),
    );
    paths.push(
      resolveExtensionPath({
        callerPath: params.callerPath,
        extensionId: "memory-context-archive",
      }),
    );
  }

  return paths;
}

// ─── Embedding Upgrade Probe ────────────────────────────────────────────────

/**
 * Per-session cache entry for memory-context resources.
 * Avoids re-creating WarmStore / KnowledgeStore / embedding on every message.
 */
export type MemoryContextCacheEntry = {
  sessionId: string;
  embeddingName: string;
  embeddingDim: number;
  /** Timestamp of last embedding upgrade probe (ms). */
  lastUpgradeProbeAt?: number;
};

/** Minimum interval (ms) between embedding upgrade probes per session. */
export const EMBEDDING_UPGRADE_PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Hash/fallback dim threshold — anything at or below is considered degraded. */
export const FALLBACK_DIM_THRESHOLD = 384;

/**
 * Determine whether an embedding upgrade probe should run.
 */
export function shouldProbeEmbeddingUpgrade(entry: MemoryContextCacheEntry): boolean {
  const isFallback =
    entry.embeddingDim <= FALLBACK_DIM_THRESHOLD ||
    entry.embeddingName === "hash" ||
    entry.embeddingName === "none";

  if (!isFallback) {
    return false;
  }

  const now = Date.now();
  return (
    !entry.lastUpgradeProbeAt ||
    now - entry.lastUpgradeProbeAt >= EMBEDDING_UPGRADE_PROBE_INTERVAL_MS
  );
}
