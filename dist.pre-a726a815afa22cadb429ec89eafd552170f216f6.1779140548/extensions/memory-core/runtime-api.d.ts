import { i as OpenClawConfig } from "../../types.openclaw-CQzDxdpQ.js";
import { Ai as MemoryEmbeddingProviderAdapter } from "../../types-Bb8qdnX4.js";
import { r as MemorySearchManager } from "../../types-BzdVHqrC.js";
import { f as MemoryPluginRuntime } from "../../memory-state-DGFn0jnm.js";
import { L as DEFAULT_LOCAL_MODEL } from "../../memory-core-host-engine-embeddings-D7WfvFV2.js";
import { a as auditShortTermPromotionArtifacts, n as RepairShortTermPromotionArtifactsResult, o as removeGroundedShortTermCandidates, r as ShortTermAuditSummary, s as repairShortTermPromotionArtifacts } from "../../short-term-promotion-D5sh9dOK.js";
import { i as resolveMemoryVectorState, n as resolveMemoryCacheSummary, r as resolveMemoryFtsState, t as Tone } from "../../memory-core-host-status-D_Xe_EDx.js";
import { r as createEmbeddingProvider, t as MemoryIndexManager } from "../../manager-DHbCXeEY.js";
import { t as checkQmdBinaryAvailability } from "../../memory-core-host-engine-qmd-C-bUBfMa.js";
import { t as hasConfiguredMemorySecretInput } from "../../memory-core-host-secret-CwJcR2hG.js";

//#region extensions/memory-core/src/memory/search-manager.d.ts
type Maybe<T> = T | null;
type MemorySearchManagerResult = {
  manager: Maybe<MemorySearchManager>;
  error?: string;
};
type MemorySearchManagerPurpose = "default" | "status" | "cli";
declare function getMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemorySearchManagerPurpose;
}): Promise<MemorySearchManagerResult>;
//#endregion
//#region extensions/memory-core/src/runtime-provider.d.ts
declare const memoryRuntime: MemoryPluginRuntime;
//#endregion
//#region extensions/memory-core/src/memory/provider-adapters.d.ts
type BuiltinMemoryEmbeddingProviderDoctorMetadata = {
  providerId: string;
  authProviderId: string;
  envVars: string[];
  transport: "local" | "remote";
  autoSelectPriority?: number;
};
declare function registerBuiltInMemoryEmbeddingProviders(register: {
  registerMemoryEmbeddingProvider: (adapter: MemoryEmbeddingProviderAdapter) => void;
}): void;
declare function getBuiltinMemoryEmbeddingProviderDoctorMetadata(providerId: string): BuiltinMemoryEmbeddingProviderDoctorMetadata | null;
declare function listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata(): Array<BuiltinMemoryEmbeddingProviderDoctorMetadata>;
//#endregion
//#region extensions/memory-core/src/dreaming-repair.d.ts
type DreamingArtifactsAuditIssue = {
  severity: "warn" | "error";
  code: "dreaming-session-corpus-unreadable" | "dreaming-session-corpus-self-ingested" | "dreaming-session-ingestion-unreadable" | "dreaming-diary-unreadable";
  message: string;
  fixable: boolean;
};
type DreamingArtifactsAuditSummary = {
  dreamsPath?: string;
  sessionCorpusDir: string;
  sessionCorpusFileCount: number;
  suspiciousSessionCorpusFileCount: number;
  suspiciousSessionCorpusLineCount: number;
  sessionIngestionPath: string;
  sessionIngestionExists: boolean;
  issues: DreamingArtifactsAuditIssue[];
};
type RepairDreamingArtifactsResult = {
  changed: boolean;
  archiveDir?: string;
  archivedDreamsDiary: boolean;
  archivedSessionCorpus: boolean;
  archivedSessionIngestion: boolean;
  archivedPaths: string[];
  warnings: string[];
};
declare function auditDreamingArtifacts(params: {
  workspaceDir: string;
}): Promise<DreamingArtifactsAuditSummary>;
declare function repairDreamingArtifacts(params: {
  workspaceDir: string;
  archiveDiary?: boolean;
  now?: Date;
}): Promise<RepairDreamingArtifactsResult>;
//#endregion
export { type BuiltinMemoryEmbeddingProviderDoctorMetadata, DEFAULT_LOCAL_MODEL, type DreamingArtifactsAuditSummary, MemoryIndexManager, type RepairDreamingArtifactsResult, type RepairShortTermPromotionArtifactsResult, type ShortTermAuditSummary, type Tone, auditDreamingArtifacts, auditShortTermPromotionArtifacts, checkQmdBinaryAvailability, createEmbeddingProvider, getBuiltinMemoryEmbeddingProviderDoctorMetadata, getMemorySearchManager, hasConfiguredMemorySecretInput, listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata, memoryRuntime, registerBuiltInMemoryEmbeddingProviders, removeGroundedShortTermCandidates, repairDreamingArtifacts, repairShortTermPromotionArtifacts, resolveMemoryCacheSummary, resolveMemoryFtsState, resolveMemoryVectorState };