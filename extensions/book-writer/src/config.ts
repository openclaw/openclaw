import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../api.js";
import type { MemoryPolicy } from "./types.js";

export type BookWriterConfig = {
  outputDir?: string;
  localProvider?: "lmstudio" | "ollama" | "custom";
  localModel?: string;
  localBaseUrl?: string;
  memoryPolicy?: Partial<MemoryPolicy>;
  schedule?: {
    timezone?: string;
    reviewReadyBy?: string;
  };
  editorialPolicy?: {
    blockedAffirmativeThemes?: string[];
    allowCriticalHistoricalDiscussion?: boolean;
    uncertainMeansBlocked?: boolean;
  };
  publishing?: {
    primaryChannel?: string;
    kdpSelectDefault?: boolean;
    finalSubmitRequiresApproval?: boolean;
  };
  qualityThresholds?: {
    minWords?: number;
    minQualityScore?: number;
    maxInternalSimilarity?: number;
  };
  penNames?: Array<{
    name: string;
    lane?: string;
    readerPromise?: string;
  }>;
};

export type ResolvedBookWriterConfig = {
  outputDir: string;
  localProvider: "lmstudio" | "ollama" | "custom";
  localModel: string;
  localBaseUrl: string;
  memoryPolicy: MemoryPolicy;
  schedule: {
    timezone: string;
    reviewReadyBy: string;
  };
  editorialPolicy: {
    blockedAffirmativeThemes: string[];
    allowCriticalHistoricalDiscussion: boolean;
    uncertainMeansBlocked: boolean;
  };
  publishing: {
    primaryChannel: "kdp";
    kdpSelectDefault: boolean;
    finalSubmitRequiresApproval: true;
  };
  qualityThresholds: {
    minWords: number;
    minQualityScore: number;
    maxInternalSimilarity: number;
  };
  penNames: Array<{
    name: string;
    lane: string;
    readerPromise: string;
  }>;
};

export const DEFAULT_BOOK_WRITER_CONFIG = {
  localProvider: "lmstudio",
  localModel: "Qwen/Qwen3-30B-A3B-Instruct-2507",
  localBaseUrl: "http://127.0.0.1:1234/v1",
  memoryPolicy: {
    defaultGb: 64,
    idealGb: 80,
    premiumGb: 96,
    hardRejectGb: 110,
  },
  schedule: {
    timezone: "America/New_York",
    reviewReadyBy: "07:00",
  },
  editorialPolicy: {
    blockedAffirmativeThemes: ["LGBTQIA+", "Marxism", "socialism", "communism"],
    allowCriticalHistoricalDiscussion: true,
    uncertainMeansBlocked: true,
  },
  publishing: {
    primaryChannel: "kdp",
    kdpSelectDefault: true,
    finalSubmitRequiresApproval: true,
  },
  qualityThresholds: {
    minWords: 8000,
    minQualityScore: 0.74,
    maxInternalSimilarity: 0.34,
  },
  penNames: [
    {
      name: "Northstar House",
      lane: "clean commercial mystery",
      readerPromise: "fast, satisfying suspense with practical courage and no explicit content",
    },
  ],
} satisfies Omit<ResolvedBookWriterConfig, "outputDir">;

export const DEFAULT_LOCAL_PROVIDER_BASE_URLS = {
  lmstudio: DEFAULT_BOOK_WRITER_CONFIG.localBaseUrl,
  ollama: "http://127.0.0.1:11434",
  custom: DEFAULT_BOOK_WRITER_CONFIG.localBaseUrl,
} satisfies Record<ResolvedBookWriterConfig["localProvider"], string>;

export const DEFAULT_LOCAL_PROVIDER_MODELS = {
  lmstudio: DEFAULT_BOOK_WRITER_CONFIG.localModel,
  ollama: "qwen2.5:32b",
  custom: DEFAULT_BOOK_WRITER_CONFIG.localModel,
} satisfies Record<ResolvedBookWriterConfig["localProvider"], string>;

function defaultStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

function configuredProviderBaseUrl(
  appConfig: OpenClawConfig | undefined,
  provider: ResolvedBookWriterConfig["localProvider"],
): string | undefined {
  const providers = appConfig?.models?.providers as
    | Record<string, { baseUrl?: unknown; api?: unknown }>
    | undefined;
  const baseUrl = providers?.[provider]?.baseUrl;
  return typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : undefined;
}

function configuredDefaultModel(
  appConfig: OpenClawConfig | undefined,
  provider: ResolvedBookWriterConfig["localProvider"],
): string | undefined {
  const modelConfig = appConfig?.agents?.defaults?.model;
  const primary = typeof modelConfig === "string" ? modelConfig : modelConfig?.primary;
  if (typeof primary !== "string" || !primary.startsWith(`${provider}/`)) {
    return undefined;
  }
  const model = primary.slice(provider.length + 1).trim();
  return model || undefined;
}

function normalizeBookWriterBaseUrl(
  provider: ResolvedBookWriterConfig["localProvider"],
  baseUrl: string,
): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (provider === "ollama") {
    return trimmed.replace(/\/v1$/i, "");
  }
  return trimmed;
}

export function resolveBookWriterConfig(
  rawConfig?: unknown,
  appConfig?: OpenClawConfig,
): ResolvedBookWriterConfig {
  const config = (rawConfig ?? {}) as BookWriterConfig;
  const outputDir =
    typeof config.outputDir === "string" && config.outputDir.trim()
      ? config.outputDir.trim()
      : path.join(defaultStateDir(), "book-writer", "books");
  const localProvider = config.localProvider ?? DEFAULT_BOOK_WRITER_CONFIG.localProvider;
  const localModel =
    config.localModel?.trim() ||
    configuredDefaultModel(appConfig, localProvider) ||
    DEFAULT_LOCAL_PROVIDER_MODELS[localProvider];
  const localBaseUrl = normalizeBookWriterBaseUrl(
    localProvider,
    config.localBaseUrl ??
      configuredProviderBaseUrl(appConfig, localProvider) ??
      DEFAULT_LOCAL_PROVIDER_BASE_URLS[localProvider],
  );
  const memoryPolicy = {
    ...DEFAULT_BOOK_WRITER_CONFIG.memoryPolicy,
    ...config.memoryPolicy,
  };
  const penNames =
    Array.isArray(config.penNames) && config.penNames.length > 0
      ? config.penNames.map((penName) => ({
          name: penName.name,
          lane: penName.lane ?? DEFAULT_BOOK_WRITER_CONFIG.penNames[0].lane,
          readerPromise:
            penName.readerPromise ?? DEFAULT_BOOK_WRITER_CONFIG.penNames[0].readerPromise,
        }))
      : [...DEFAULT_BOOK_WRITER_CONFIG.penNames];

  return {
    outputDir,
    localProvider,
    localModel,
    localBaseUrl,
    memoryPolicy,
    schedule: {
      ...DEFAULT_BOOK_WRITER_CONFIG.schedule,
      ...config.schedule,
    },
    editorialPolicy: {
      ...DEFAULT_BOOK_WRITER_CONFIG.editorialPolicy,
      ...config.editorialPolicy,
    },
    publishing: {
      primaryChannel: "kdp",
      kdpSelectDefault:
        config.publishing?.kdpSelectDefault ??
        DEFAULT_BOOK_WRITER_CONFIG.publishing.kdpSelectDefault,
      finalSubmitRequiresApproval: true,
    },
    qualityThresholds: {
      ...DEFAULT_BOOK_WRITER_CONFIG.qualityThresholds,
      ...config.qualityThresholds,
    },
    penNames,
  };
}
