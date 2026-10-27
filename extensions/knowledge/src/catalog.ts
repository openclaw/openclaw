import { eligible } from "./retrieval.js";
import { digest, type ScanResult } from "./vault.js";

/** Catalog facts reported by the status operation for one scanned scope. */
export function catalogFacts(data: ScanResult) {
  const active = eligible(data, undefined, false);
  return {
    checkedAt: data.checkedAt,
    records: active.length,
    issues: data.issues.length,
    definitions: data.ontology?.definitions.length ?? 0,
    ontologyAvailable: Boolean(data.ontology),
    ontologyFingerprint: data.ontology?.fingerprint ?? "",
    // Content, evidence validation, ontology and time-based eligibility can
    // change without changing the record count. checkedAt is not a revision.
    snapshot: digest(
      JSON.stringify([
        data.records.map((r) => [r.id, r.path, r.hash, r.valid]),
        active.map((r) => r.id),
        data.ontology?.fingerprint,
        data.issues,
      ]),
    ),
  };
}
