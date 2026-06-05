// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The OpenClaw Authors.
//
// Public entrypoint for the @openclaw/governance plugin. Re-exports the
// governance primitives so host code (and the plugin loader) can construct
// the recorder/scanner/ledger trio without reaching into module paths.
//
// The plugin manifest activates onStartup; wiring this entrypoint into the
// gateway's INFERENCE_END / OUTBOUND_PAYLOAD / SKILL_INVOKE event bus is
// tracked separately so the upstream review can shape the hook surface.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export {
  buildRecord,
  toJson,
  fromJson,
  type AIBOMRecord,
  type AIBOMModality,
  type BuildRecordInput,
} from "./aibom/record.js";
export {
  AibomSigner,
  type SignerOptions,
  type VerifyResult,
  type VerifyStatus,
  type Ed25519KeyPair,
} from "./aibom/signer.js";
export { AibomRecorder, type RecordInferenceParams, type RecordedAibom } from "./aibom/recorder.js";
export { verifyStoredEntry, rehydrateRecord, type StoredAibomEntry } from "./aibom/verifier.js";
export {
  GovernanceStore,
  type AibomRow,
  type CostEntryRow,
  type DlpFindingRow,
  type GovernanceStoreOptions,
} from "./store/sqlite.js";
export {
  DlpScanner,
  ALL_ENTITIES,
  type DlpAction,
  type DlpEntityType,
  type DlpFinding,
  type DlpScanResult,
  type DlpScannerOptions,
} from "./dlp/scanner.js";
export {
  CostLedger,
  type CostLedgerOptions,
  type CostRecordInput,
  type CostSummary,
  type CostSummaryGroupBy,
  type CostSummaryRow,
  type CostUsage,
  type PricePerMillion,
} from "./cost/ledger.js";
export { normalizeGovernanceConfig, type GovernancePluginConfig } from "./config.js";

export default definePluginEntry({
  id: "openclaw-governance",
  name: "OpenClaw Governance",
  description:
    "Optional signed AIBOM audit log, DLP scanner, and per-call cost ledger. " +
    "Backported from Nexus chokepoint governance for personal/local use.",
  register(api) {
    // Satisfies the loader's register/activate contract so the plugin loads.
    // Event-bus wiring (INFERENCE_END / OUTBOUND_PAYLOAD / SKILL_INVOKE) is
    // the deferred follow-up; until then host code constructs the primitives
    // via the named exports above.
    void api;
  },
});
