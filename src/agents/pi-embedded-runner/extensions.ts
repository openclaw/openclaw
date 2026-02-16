import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "../memory-context/embedding.js";
import {
  setGlobalMemoryRuntime,
  type MemoryContextConfig,
} from "../memory-context/global-runtime.js";
import { KnowledgeStore } from "../memory-context/knowledge-store.js";
import { WarmStore } from "../memory-context/store.js";
import { setCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import { setContextPruningRuntime } from "../pi-extensions/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-extensions/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-extensions/context-pruning/tools.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";

function resolvePiExtensionPath(id: string): string {
  const self = fileURLToPath(import.meta.url);
  const dir = path.dirname(self);
  const ext = path.extname(self) === ".ts" ? "ts" : "js";
  const resolved = path.join(dir, "..", "pi-extensions", `${id}.${ext}`);
  if (ext === "js") {
    // In dist mode, .js files may not exist for memory-context extensions;
    // fall back to .ts source files that jiti can load.
    if (!fs.existsSync(resolved)) {
      const tsPath = resolved.replace(/\.js$/, ".ts");
      if (fs.existsSync(tsPath)) {
        return tsPath;
      }
      const srcPath = path.join(dir, "..", "src", "agents", "pi-extensions", `${id}.ts`);
      if (fs.existsSync(srcPath)) {
        return srcPath;
      }
    }
  }
  return resolved;
}

function resolveContextWindowTokens(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    modelContextWindow: params.model?.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
}

function buildContextPruningExtension(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): { additionalExtensionPaths?: string[] } {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "cache-ttl") {
    return {};
  }
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId)) {
    return {};
  }

  const settings = computeEffectiveSettings(raw);
  if (!settings) {
    return {};
  }

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager),
  });

  return {
    additionalExtensionPaths: [resolvePiExtensionPath("context-pruning")],
  };
}

function resolveCompactionMode(cfg?: OpenClawConfig): "default" | "safeguard" {
  return cfg?.agents?.defaults?.compaction?.mode === "safeguard" ? "safeguard" : "default";
}

/**
 * Per-session cache for memory-context resources.
 * Avoids re-creating WarmStore / KnowledgeStore / embedding on every message.
 */
type MemoryContextCacheEntry = {
  rawStore: WarmStore;
  knowledgeStore: KnowledgeStore;
  embedding: EmbeddingProvider;
  /** Timestamp of last embedding upgrade probe (ms). */
  lastUpgradeProbeAt?: number;
};
const memoryContextCache = new Map<string, MemoryContextCacheEntry>();

/** Minimum interval (ms) between embedding upgrade probes per session. */
const EMBEDDING_UPGRADE_PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Hash/fallback dim threshold — anything at or below this is considered degraded. */
const FALLBACK_DIM_THRESHOLD = 384;

export async function buildEmbeddedExtensionPaths(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): Promise<string[]> {
  const paths: string[] = [];
  if (resolveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const contextWindowInfo = resolveContextWindowInfo({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      modelContextWindow: params.model?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    setCompactionSafeguardRuntime(params.sessionManager, {
      maxHistoryShare: compactionCfg?.maxHistoryShare,
      contextWindowTokens: contextWindowInfo.tokens,
    });
    paths.push(resolvePiExtensionPath("compaction-safeguard"));
  }
  // context-pruning: micro-level tool result pruning (runs first in context chain)
  const pruning = buildContextPruningExtension(params);
  if (pruning.additionalExtensionPaths) {
    paths.push(...pruning.additionalExtensionPaths);
  }

  // memory-context: recall injection (runs after context-pruning in context chain)
  // + archive (runs on session_before_compact, independent of context chain)
  const memCtxCfg = params.cfg?.agents?.defaults?.memoryContext;
  if (memCtxCfg?.enabled) {
    const contextWindowTokens = resolveContextWindowTokens(params);
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const storagePath = memCtxCfg.storagePath ?? "~/.openclaw/memory/context";
    const resolvedPath = storagePath.startsWith("~")
      ? storagePath.replace(/^~/, process.env.HOME ?? "/root")
      : storagePath;

    const config: MemoryContextConfig = {
      enabled: true,
      hardCapTokens: memCtxCfg.hardCapTokens ?? 4000,
      embeddingModel: memCtxCfg.embeddingModel ?? "auto",
      storagePath: resolvedPath,
      redaction: memCtxCfg.redaction !== false,
      knowledgeExtraction: memCtxCfg.knowledgeExtraction !== false,
      maxSegments: memCtxCfg.maxSegments ?? 20000,
      crossSession: memCtxCfg.crossSession === true,
      autoRecallMinScore: memCtxCfg.autoRecallMinScore ?? 0.7,
      evictionDays: memCtxCfg.evictionDays ?? 90,
    };

    // Session-level caching: reuse WarmStore / embedding across messages.
    const sessionId =
      (params.sessionManager as unknown as { sessionId?: string }).sessionId ?? "default";
    let cached = memoryContextCache.get(sessionId);
    if (!cached) {
      // Unified embedding with cascading fallback:
      //   gemini/auto → openai → voyage → local → transformer → noop (BM25)
      const embedding: EmbeddingProvider = await createEmbeddingProvider(
        params.cfg,
        config.embeddingModel ?? "auto",
        { warn: (msg) => console.warn(msg), info: (msg) => console.info(msg) },
      );
      const rawStore = new WarmStore({
        sessionId,
        embedding,
        coldStore: { path: resolvedPath },
        maxSegments: config.maxSegments,
        crossSession: config.crossSession,
        eviction: {
          enabled: config.evictionDays > 0,
          maxAgeDays: config.evictionDays,
        },
        vectorPersist: true,
      });
      // KnowledgeStore and WarmStore share the same directory intentionally:
      // KnowledgeStore writes knowledge.jsonl, WarmStore writes segments.jsonl — no collision.
      const knowledgeStore = new KnowledgeStore(resolvedPath);
      cached = { rawStore, knowledgeStore, embedding };
      memoryContextCache.set(sessionId, cached);
      console.info(`[memory-context] created new WarmStore for session=${sessionId}`);
    } else {
      console.info(`[memory-context] reusing cached WarmStore for session=${sessionId}`);

      // Embedding upgrade probe: if the cached embedding is a fallback (hash/low-dim),
      // periodically re-probe the real provider. If it recovered (e.g. Gemini came back),
      // rebuild WarmStore with the better embedding so vector search works again.
      const isFallback =
        cached.embedding.dim <= FALLBACK_DIM_THRESHOLD ||
        cached.embedding.name === "hash" ||
        cached.embedding.name === "none";
      const now = Date.now();
      const probeAllowed =
        !cached.lastUpgradeProbeAt ||
        now - cached.lastUpgradeProbeAt >= EMBEDDING_UPGRADE_PROBE_INTERVAL_MS;

      if (isFallback && probeAllowed) {
        cached.lastUpgradeProbeAt = now;
        try {
          const upgraded = await createEmbeddingProvider(
            params.cfg,
            config.embeddingModel ?? "auto",
            { warn: (msg) => console.warn(msg), info: (msg) => console.info(msg) },
          );
          if (
            upgraded.dim > FALLBACK_DIM_THRESHOLD &&
            upgraded.name !== "hash" &&
            upgraded.name !== "none"
          ) {
            // Provider recovered — rebuild WarmStore with the better embedding.
            // WarmStore constructor handles the upgrade path: re-embeds old segments
            // with the new provider and persists the new vectors.
            console.info(
              `[memory-context] embedding upgraded: ${cached.embedding.name}(${cached.embedding.dim}-dim) → ${upgraded.name}(${upgraded.dim}-dim) for session=${sessionId}`,
            );
            const rawStore = new WarmStore({
              sessionId,
              embedding: upgraded,
              coldStore: { path: resolvedPath },
              maxSegments: config.maxSegments,
              crossSession: config.crossSession,
              eviction: {
                enabled: config.evictionDays > 0,
                maxAgeDays: config.evictionDays,
              },
              vectorPersist: true,
            });
            const knowledgeStore = new KnowledgeStore(resolvedPath);
            cached = { rawStore, knowledgeStore, embedding: upgraded };
            memoryContextCache.set(sessionId, cached);
          } else {
            console.info(
              `[memory-context] embedding upgrade probe: still fallback (${upgraded.name}/${upgraded.dim}-dim) for session=${sessionId}`,
            );
          }
        } catch (err) {
          console.warn(
            `[memory-context] embedding upgrade probe failed for session=${sessionId}: ${String(err)}`,
          );
        }
      }
    }
    const { rawStore, knowledgeStore } = cached;

    // Resolve subagent model for knowledge extraction (faster than main model).
    const subagentModelCfg = params.cfg?.agents?.defaults?.subagents?.model;
    const subagentPrimary =
      typeof subagentModelCfg === "string" ? subagentModelCfg : subagentModelCfg?.primary;
    let extractionModel: { provider: string; modelId: string } | undefined;
    if (subagentPrimary && subagentPrimary.includes("/")) {
      const [provider, ...rest] = subagentPrimary.split("/");
      extractionModel = { provider, modelId: rest.join("/") };
    }

    setGlobalMemoryRuntime(sessionId, {
      config,
      rawStore,
      knowledgeStore,
      contextWindowTokens,
      maxHistoryShare: compactionCfg?.maxHistoryShare ?? 0.5,
      extractionModel,
    });
    console.info(`[memory-context] global runtime set for session=${sessionId}`);

    // Push extension paths — Pi runtime will load and execute these via jiti
    paths.push(resolvePiExtensionPath("memory-context-recall"));
    paths.push(resolvePiExtensionPath("memory-context-archive"));
  }

  return paths;
}

export { ensurePiCompactionReserveTokens };
