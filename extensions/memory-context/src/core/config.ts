import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EmbeddingModelType = "auto" | "gemini" | "hash" | "transformer";
export type IndexType = "brute" | "hnsw";

export type SearchConfig = {
  vectorWeight: number;
  bm25Weight: number;
  timeDecay: number;
};

export type BudgetConfig = {
  maxTokens: number;
  tokenEstimateRatio: number;
};

export type MemoryContextConfig = {
  embeddingDim: number;
  storagePath: string;
  redaction: boolean;
  knowledgeExtraction: boolean;
  autoRecall: boolean;
  autoRecallMinScore: number;
  autoRecallMaxTokens: number;
  maxSegments: number;
  embeddingModel: EmbeddingModelType;
  embeddingModelName: string;
  indexType: IndexType;
  search: SearchConfig;
  budget: BudgetConfig;
  /** Cross-session search (default: false) */
  crossSession: boolean;
  /** Eviction: max age in days for warm store (default: 90, 0 = disabled) */
  evictionDays: number;
  /** Persist vectors to binary file (default: true) */
  vectorPersist: boolean;
};

const DEFAULT_EMBEDDING_DIM = 384;
const DEFAULT_EMBEDDING_MODEL: EmbeddingModelType = "auto";
const DEFAULT_EMBEDDING_MODEL_NAME = "EmbeddingGemma-300M";
const DEFAULT_INDEX_TYPE: IndexType = "hnsw";

function resolveDefaultStoragePath(): string {
  const home = homedir();
  const preferred = join(home, ".openclaw", "memory", "context");
  try {
    if (fs.existsSync(preferred)) {
      return preferred;
    }
  } catch {
    // best-effort
  }
  return preferred;
}

const DEFAULT_STORAGE_PATH = resolveDefaultStoragePath();

const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  timeDecay: 0.995,
};

const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxTokens: 4000,
  tokenEstimateRatio: 3,
};

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function assertNumber(
  value: unknown,
  label: string,
  opts?: { min?: number; max?: number; integer?: boolean },
): number {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  if (opts?.integer && !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (typeof opts?.min === "number" && value < opts.min) {
    throw new Error(`${label} must be >= ${opts.min}`);
  }
  if (typeof opts?.max === "number" && value > opts.max) {
    throw new Error(`${label} must be <= ${opts.max}`);
  }
  return value;
}

function parseSearchConfig(value: unknown): SearchConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_SEARCH_CONFIG };
  }
  const cfg = value as Record<string, unknown>;
  assertAllowedKeys(cfg, ["vectorWeight", "bm25Weight", "timeDecay"], "search config");

  return {
    vectorWeight:
      cfg.vectorWeight === undefined
        ? DEFAULT_SEARCH_CONFIG.vectorWeight
        : assertNumber(cfg.vectorWeight, "search.vectorWeight", { min: 0, max: 1 }),
    bm25Weight:
      cfg.bm25Weight === undefined
        ? DEFAULT_SEARCH_CONFIG.bm25Weight
        : assertNumber(cfg.bm25Weight, "search.bm25Weight", { min: 0, max: 1 }),
    timeDecay:
      cfg.timeDecay === undefined
        ? DEFAULT_SEARCH_CONFIG.timeDecay
        : assertNumber(cfg.timeDecay, "search.timeDecay", { min: 0, max: 1 }),
  };
}

function parseBudgetConfig(value: unknown): BudgetConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_BUDGET_CONFIG };
  }
  const cfg = value as Record<string, unknown>;
  assertAllowedKeys(cfg, ["maxTokens", "tokenEstimateRatio"], "budget config");

  return {
    maxTokens:
      cfg.maxTokens === undefined
        ? DEFAULT_BUDGET_CONFIG.maxTokens
        : assertNumber(cfg.maxTokens, "budget.maxTokens", { min: 0, integer: true }),
    tokenEstimateRatio:
      cfg.tokenEstimateRatio === undefined
        ? DEFAULT_BUDGET_CONFIG.tokenEstimateRatio
        : assertNumber(cfg.tokenEstimateRatio, "budget.tokenEstimateRatio", { min: 1 }),
  };
}

function assertEnum<T extends string>(value: unknown, allowed: T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export const memoryContextConfigSchema = {
  parse(value: unknown): MemoryContextConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-context config required");
    }

    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "embeddingDim",
        "storagePath",
        "redaction",
        "knowledgeExtraction",
        "autoRecall",
        "autoRecallMinScore",
        "autoRecallMaxTokens",
        "maxSegments",
        "embeddingModel",
        "embeddingModelName",
        "indexType",
        "search",
        "budget",
        "crossSession",
        "evictionDays",
        "vectorPersist",
      ],
      "memory-context config",
    );

    const embeddingDim =
      cfg.embeddingDim === undefined
        ? DEFAULT_EMBEDDING_DIM
        : assertNumber(cfg.embeddingDim, "embeddingDim", { min: 8, integer: true });

    const storagePath =
      typeof cfg.storagePath === "string" ? cfg.storagePath : DEFAULT_STORAGE_PATH;

    const autoRecall = cfg.autoRecall !== false;
    const redaction = cfg.redaction !== false;
    const knowledgeExtraction = cfg.knowledgeExtraction !== false;

    const autoRecallMinScore =
      cfg.autoRecallMinScore === undefined
        ? 0.6
        : assertNumber(cfg.autoRecallMinScore, "autoRecallMinScore", { min: 0, max: 1 });

    const autoRecallMaxTokens =
      cfg.autoRecallMaxTokens === undefined
        ? 12000
        : assertNumber(cfg.autoRecallMaxTokens, "autoRecallMaxTokens", { min: 0, integer: true });

    const maxSegments =
      cfg.maxSegments === undefined
        ? 20000
        : assertNumber(cfg.maxSegments, "maxSegments", { min: 1, integer: true });

    const embeddingModel =
      cfg.embeddingModel === undefined
        ? DEFAULT_EMBEDDING_MODEL
        : assertEnum(
            cfg.embeddingModel,
            ["auto", "gemini", "hash", "transformer"],
            "embeddingModel",
          );

    const embeddingModelName =
      typeof cfg.embeddingModelName === "string"
        ? cfg.embeddingModelName
        : DEFAULT_EMBEDDING_MODEL_NAME;

    const indexType =
      cfg.indexType === undefined
        ? DEFAULT_INDEX_TYPE
        : assertEnum(cfg.indexType, ["brute", "hnsw"], "indexType");

    const search = parseSearchConfig(cfg.search);
    const budget = parseBudgetConfig(cfg.budget);

    const crossSession = cfg.crossSession === true;

    const evictionDays =
      cfg.evictionDays === undefined
        ? 90
        : assertNumber(cfg.evictionDays, "evictionDays", { min: 0, integer: true });

    const vectorPersist = cfg.vectorPersist !== false;

    return {
      embeddingDim,
      storagePath,
      redaction,
      knowledgeExtraction,
      autoRecall,
      autoRecallMinScore,
      autoRecallMaxTokens,
      maxSegments,
      embeddingModel,
      embeddingModelName,
      indexType,
      search,
      budget,
      crossSession,
      evictionDays,
      vectorPersist,
    };
  },
  uiHints: {
    storagePath: {
      label: "Storage Path",
      placeholder: "~/.openclaw/memory/context",
      advanced: true,
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant conversation history into context",
    },
    redaction: {
      label: "Redaction",
      help: "Mask potential secrets before persisting compacted content",
      advanced: true,
    },
    knowledgeExtraction: {
      label: "Knowledge Extraction",
      help: "Extract durable technical facts from compacted messages",
      advanced: true,
    },
    embeddingModel: {
      label: "Embedding Model",
      help: "Use 'transformer' for semantic search (recommended) or 'hash' for fast local fallback",
    },
    embeddingModelName: {
      label: "Embedding Model Name",
      placeholder: "EmbeddingGemma-300M",
      advanced: true,
    },
    indexType: {
      label: "Index Type",
      help: "Use 'hnsw' for fast approximate search or 'brute' for exact search",
    },
    search: {
      label: "Search Settings",
      help: "Configure hybrid search weights and time decay",
      advanced: true,
    },
    budget: {
      label: "Budget Settings",
      help: "Configure context budget for auto-recall",
      advanced: true,
    },
  },
};
