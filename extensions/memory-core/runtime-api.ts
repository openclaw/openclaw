export { getMemorySearchManager, MemoryIndexManager } from "./src/memory/index.js";
export {
  getBuiltinMemoryEmbeddingProviderDoctorMetadata,
  listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata,
} from "./src/memory/provider-adapters.js";
export {
  auditShortTermPromotionArtifacts,
  repairShortTermPromotionArtifacts,
} from "./src/short-term-promotion.js";
export type { BuiltinMemoryEmbeddingProviderDoctorMetadata } from "./src/memory/provider-adapters.js";
export type {
  RepairShortTermPromotionArtifactsResult,
  ShortTermAuditSummary,
} from "./src/short-term-promotion.js";
