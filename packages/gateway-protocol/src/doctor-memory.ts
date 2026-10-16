/** Browser-safe wire values returned by doctor.memory.status. */
export type DoctorMemoryEmbeddingRuntimePayload = {
  engine: "llama.cpp";
  state: "ready" | "failed";
  backend?: "metal" | "cpu";
  buildInfo?: string;
  model?: { id: string; path?: string };
  capabilities?: { vision: boolean; draft: boolean };
  endpoints?: Record<string, "ready" | "unavailable">;
  loadError?: string;
};

export type DoctorMemoryDreamingEntry = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalSignalCount: number;
  lightHits: number;
  remHits: number;
  phaseHitCount: number;
  promotedAt?: string;
  lastRecalledAt?: string;
};

type DoctorMemoryDreamingPhase = {
  enabled: boolean;
  cron: string;
  limit: number;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

export type DoctorMemoryDreamingConfig = {
  enabled: boolean;
  timezone?: string;
  verboseLogging: boolean;
  storageMode: "inline" | "separate" | "both";
  separateReports: boolean;
  phases: {
    light: DoctorMemoryDreamingPhase & { lookbackDays: number };
    deep: DoctorMemoryDreamingPhase & {
      minScore: number;
      minRecallCount: number;
      minUniqueQueries: number;
      recencyHalfLifeDays: number;
      maxAgeDays?: number;
    };
    rem: DoctorMemoryDreamingPhase & { lookbackDays: number; minPatternStrength: number };
  };
};

export type DoctorMemoryDreamingPayload = DoctorMemoryDreamingConfig & {
  shortTermCount: number;
  recallSignalCount: number;
  dailySignalCount: number;
  groundedSignalCount: number;
  totalSignalCount: number;
  phaseSignalCount: number;
  lightPhaseHitCount: number;
  remPhaseHitCount: number;
  promotedTotal: number;
  promotedToday: number;
  storePath?: string;
  phaseSignalPath?: string;
  phaseSignalError?: string;
  storeError?: string;
  lastPromotedAt?: string;
  shortTermEntries: DoctorMemoryDreamingEntry[];
  signalEntries: DoctorMemoryDreamingEntry[];
  promotedEntries: DoctorMemoryDreamingEntry[];
};

export type DoctorMemoryStatusPayload = {
  agentId: string;
  searchRuntimeRegistered?: boolean;
  provider?: string;
  health?: {
    status: "ready" | "degraded" | "unavailable";
    message?: string;
    details?: Record<string, unknown>;
  };
  embedding: {
    ok: boolean;
    error?: string;
    checked?: boolean;
    cached?: boolean;
    checkedAtMs?: number;
    cacheExpiresAtMs?: number;
  };
  embeddingRuntime?: DoctorMemoryEmbeddingRuntimePayload;
  dreaming?: DoctorMemoryDreamingPayload;
};
