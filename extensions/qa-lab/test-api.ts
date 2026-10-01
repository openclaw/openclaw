// QA Lab test API exposes evidence helpers without loading runtime entrypoints.
export {
  captureQaEvidenceRuntimeIdentity,
  captureQaEvidenceSourceIdentity,
} from "./src/evidence-environment.js";
export { createQaEvidenceInvocation } from "./src/evidence-invocation.js";
export {
  buildQaOccurrenceEvidenceSummary,
  buildScriptEvidenceSummary,
  QA_EVIDENCE_FILENAME,
  type QaEvidenceIdentity,
  type QaEvidenceOccurrence,
  type QaEvidencePackageSource,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
  type QaEvidenceSummaryV3Entry,
  validateQaEvidenceSummaryJson,
} from "./src/evidence-summary.js";
export { splitQaModelRef } from "./src/model-selection.js";
export { liveFrontierProviderDefinition as qaLiveFrontierProvider } from "./src/providers/live-frontier/index.js";
export { QA_FRONTIER_PROVIDER_IDS } from "./src/providers/live-frontier/catalog.js";
export { qaProfileEvidencePlan } from "./src/profile-evidence-plan.js";
export type { QaProviderMode } from "./src/providers/index.js";
export { readQaScenarioById, type QaSeedScenarioWithSource } from "./src/scenario-catalog.js";
export {
  qaMaturityTaxonomyIdentity,
  readQaMaturityTaxonomySource,
} from "./src/scorecard-taxonomy.js";
