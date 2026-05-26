import type { GatewayRequestHandlers } from "./types.js";
type DoctorMemoryDreamingPhasePayload = {
    enabled: boolean;
    cron: string;
    managedCronPresent: boolean;
    nextRunAtMs?: number;
};
type DoctorMemoryLightDreamingPayload = DoctorMemoryDreamingPhasePayload & {
    lookbackDays: number;
    limit: number;
};
type DoctorMemoryDeepDreamingPayload = DoctorMemoryDreamingPhasePayload & {
    minScore: number;
    minRecallCount: number;
    minUniqueQueries: number;
    recencyHalfLifeDays: number;
    maxAgeDays?: number;
    limit: number;
};
type DoctorMemoryRemDreamingPayload = DoctorMemoryDreamingPhasePayload & {
    lookbackDays: number;
    limit: number;
    minPatternStrength: number;
};
type DoctorMemoryDreamingEntryPayload = {
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
type DoctorMemoryDreamingPayload = {
    enabled: boolean;
    timezone?: string;
    verboseLogging: boolean;
    storageMode: "inline" | "separate" | "both";
    separateReports: boolean;
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
    lastPromotedAt?: string;
    storeError?: string;
    phaseSignalError?: string;
    shortTermEntries: DoctorMemoryDreamingEntryPayload[];
    signalEntries: DoctorMemoryDreamingEntryPayload[];
    promotedEntries: DoctorMemoryDreamingEntryPayload[];
    phases: {
        light: DoctorMemoryLightDreamingPayload;
        deep: DoctorMemoryDeepDreamingPayload;
        rem: DoctorMemoryRemDreamingPayload;
    };
};
export type DoctorMemoryStatusPayload = {
    agentId: string;
    provider?: string;
    embedding: {
        ok: boolean;
        error?: string;
        checked?: boolean;
        cached?: boolean;
        checkedAtMs?: number;
        cacheExpiresAtMs?: number;
    };
    dreaming?: DoctorMemoryDreamingPayload;
};
export type DoctorMemoryDreamDiaryPayload = {
    agentId: string;
    found: boolean;
    path: string;
    content?: string;
    updatedAtMs?: number;
};
export type DoctorMemoryDreamActionPayload = {
    agentId: string;
    action: "backfill" | "reset" | "resetGroundedShortTerm" | "repairDreamingArtifacts" | "dedupeDreamDiary";
    path?: string;
    found?: boolean;
    scannedFiles?: number;
    written?: number;
    replaced?: number;
    removedEntries?: number;
    removedShortTermEntries?: number;
    changed?: boolean;
    archiveDir?: string;
    archivedDreamsDiary?: boolean;
    archivedSessionCorpus?: boolean;
    archivedSessionIngestion?: boolean;
    warnings?: string[];
    dedupedEntries?: number;
    keptEntries?: number;
};
export type DoctorMemoryRemHarnessCandidatePayload = {
    key: string;
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
    recallCount: number;
    uniqueQueries: number;
    avgScore: number;
    maxScore: number;
    ageDays: number;
    firstRecalledAt: string;
    lastRecalledAt: string;
    promoted: boolean;
    promotedAt?: string;
};
export type DoctorMemoryRemHarnessCandidateTruthPayload = {
    snippet: string;
    confidence: number;
};
export type DoctorMemoryRemHarnessGroundedFilePayload = {
    path: string;
    renderedMarkdown: string;
};
export type DoctorMemoryRemHarnessSuccessPayload = {
    ok: true;
    agentId: string;
    workspaceDir: string;
    remConfig: {
        enabled: boolean;
        lookbackDays: number;
        limit: number;
        minPatternStrength: number;
    };
    deepConfig: {
        minScore: number;
        minRecallCount: number;
        minUniqueQueries: number;
        recencyHalfLifeDays: number;
        maxAgeDays: number | null;
    };
    rem: {
        skipped: boolean;
        sourceEntryCount: number;
        reflections: string[];
        candidateTruths: DoctorMemoryRemHarnessCandidateTruthPayload[];
        bodyLines: string[];
    };
    grounded: {
        scannedFiles: number;
        files: DoctorMemoryRemHarnessGroundedFilePayload[];
    } | null;
    deep: {
        candidateLimit: number;
        truncated: boolean;
        candidates: DoctorMemoryRemHarnessCandidatePayload[];
    };
};
export type DoctorMemoryRemHarnessErrorPayload = {
    ok: false;
    agentId: string;
    workspaceDir: string;
    error: string;
};
export declare const doctorHandlers: GatewayRequestHandlers;
export {};
