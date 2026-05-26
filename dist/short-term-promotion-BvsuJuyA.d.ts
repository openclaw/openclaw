//#region extensions/memory-core/src/concept-vocabulary.d.ts
type ConceptTagScriptCoverage = {
  latinEntryCount: number;
  cjkEntryCount: number;
  mixedEntryCount: number;
  otherEntryCount: number;
};
//#endregion
//#region extensions/memory-core/src/short-term-promotion.d.ts
type ShortTermRecallEntry = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  source: "memory";
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalScore: number;
  maxScore: number;
  firstRecalledAt: string;
  lastRecalledAt: string;
  queryHashes: string[];
  recallDays: string[];
  conceptTags: string[];
  claimHash?: string;
  promotedAt?: string;
};
type PromotionComponents = {
  frequency: number;
  relevance: number;
  diversity: number;
  recency: number;
  consolidation: number;
  conceptual: number;
};
type PromotionCandidate = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  source: "memory";
  snippet: string;
  recallCount: number;
  dailyCount?: number;
  groundedCount?: number;
  signalCount?: number;
  avgScore: number;
  maxScore: number;
  uniqueQueries: number;
  claimHash?: string;
  promotedAt?: string;
  firstRecalledAt: string;
  lastRecalledAt: string;
  ageDays: number;
  score: number;
  recallDays: string[];
  conceptTags: string[];
  components: PromotionComponents;
};
type ShortTermAuditIssue = {
  severity: "warn" | "error";
  code: "recall-store-unreadable" | "recall-store-empty" | "recall-store-invalid" | "recall-lock-stale" | "recall-lock-unreadable" | "qmd-index-missing" | "qmd-index-empty" | "qmd-collections-empty";
  message: string;
  fixable: boolean;
};
type ShortTermAuditSummary = {
  storePath: string;
  lockPath: string;
  updatedAt?: string;
  exists: boolean;
  entryCount: number;
  promotedCount: number;
  spacedEntryCount: number;
  conceptTaggedEntryCount: number;
  conceptTagScripts?: ConceptTagScriptCoverage;
  invalidEntryCount: number;
  issues: ShortTermAuditIssue[];
  qmd?: {
    dbPath?: string;
    collections?: number;
    dbBytes?: number;
  } | undefined;
};
type RepairShortTermPromotionArtifactsResult = {
  changed: boolean;
  removedInvalidEntries: number;
  rewroteStore: boolean;
  removedStaleLock: boolean;
};
declare function auditShortTermPromotionArtifacts(params: {
  workspaceDir: string;
  qmd?: {
    dbPath?: string;
    collections?: number;
  };
}): Promise<ShortTermAuditSummary>;
declare function repairShortTermPromotionArtifacts(params: {
  workspaceDir: string;
}): Promise<RepairShortTermPromotionArtifactsResult>;
declare function removeGroundedShortTermCandidates(params: {
  workspaceDir: string;
}): Promise<{
  removed: number;
  storePath: string;
}>;
//#endregion
export { auditShortTermPromotionArtifacts as a, ShortTermRecallEntry as i, RepairShortTermPromotionArtifactsResult as n, removeGroundedShortTermCandidates as o, ShortTermAuditSummary as r, repairShortTermPromotionArtifacts as s, PromotionCandidate as t };