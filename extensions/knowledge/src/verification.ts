import type { VerifyInput, VerifyOutput } from "./ingestion-contract.js";
import { resolveLinks } from "./markdown-links.js";
import { linkTargets } from "./merge.js";
import { recordSummary } from "./record-summary.js";
import { eligible } from "./retrieval.js";
import type { SampleVault } from "./vault.js";
import { digest } from "./vault.js";

/** One authorized scan; compact exception codes never echo hidden references or source text. */
export function verifyRecords(
  data: Awaited<ReturnType<SampleVault["scan"]>>,
  input: VerifyInput,
  indexed: Set<string> | null,
): VerifyOutput {
  const current = eligible(data, undefined, false),
    records = new Map(current.map((r) => [r.id, r]));
  const targets = linkTargets(data.records, current);
  const snapshot = digest(
    JSON.stringify([
      data.records.map((r) => [r.id, r.path, r.hash, r.revision, r.valid]),
      [...records.keys()],
      data.ontology?.fingerprint,
      data.issues,
      indexed === null ? null : [...indexed].toSorted(),
      input.records,
    ]),
  );
  if (input.snapshot && input.snapshot !== snapshot) {
    throw new Error("Verification snapshot changed; restart at offset 0.");
  }
  const problems: VerifyOutput["problems"] = [];
  const add = (id: string, code: string, message: string) => {
    if (!problems.some((p) => p.id === id && p.code === code)) {
      problems.push({ id, code, message });
    }
  };
  const expected = new Map(input.records.map((r) => [r.id, r]));
  if (expected.size !== input.records.length) {
    throw new Error("Duplicate verification IDs are not allowed.");
  }
  for (const [id, expectation] of expected) {
    const matches = data.records.filter((r) => r.id === id),
      record = matches.length === 1 ? matches[0] : undefined;
    if (!record) {
      add(id, "unavailable", "Record unavailable or ambiguous in this scope.");
      continue;
    }
    if (!records.has(id)) {
      add(
        id,
        "not-current",
        "Record is invalid, inactive, a fixture, or has unavailable dependencies; do not recreate automatically.",
      );
    }
    for (const issue of data.issues.filter((i) => i.path === record.path)) {
      add(
        id,
        issue.code,
        "Record validation found " + issue.code + "; inspect this exact record for details.",
      );
    }
    if (expectation.expectedHash !== undefined && record.hash !== expectation.expectedHash) {
      add(id, "hash-mismatch", "Record changed since the supplied receipt.");
    }
    if (
      expectation.expectedRevision !== undefined &&
      record.revision !== expectation.expectedRevision
    ) {
      add(id, "revision-mismatch", "Revision differs from the supplied expectation.");
    }
    for (const field of [
      "owner",
      "due_at",
      "occurred_at",
      "source_page",
      "from",
      "to",
      "label",
    ] as const) {
      const actual =
        field === "occurred_at" ? recordSummary(record).occurredAt : record.metadata[field];
      if (Object.hasOwn(expectation, field) && (actual ?? null) !== expectation[field]) {
        add(
          id,
          field + "-mismatch",
          "Structured " + field + " differs from the supplied expectation.",
        );
      }
    }
    if (records.has(id)) {
      for (const [field, ids] of [
        ["entities", expectation.expectedEntities],
        ["dependencies", expectation.expectedDependencies],
      ] as const) {
        if (
          ids?.some((target) => !records.has(target) || !record.metadata[field]?.includes(target))
        ) {
          add(
            id,
            "missing-expected-" + field,
            "Required " + field + " association is absent or unavailable in this scope.",
          );
        }
      }
      if (expectation.expectedLinks?.length) {
        const links = resolveLinks(record, targets.candidates, targets.canonical);
        for (const link of expectation.expectedLinks) {
          const candidates =
            link.href === undefined ? links : links.filter((actual) => actual.href === link.href);
          if (!candidates.some((actual) => actual.status === "resolved" && actual.id === link.id)) {
            add(
              id,
              candidates.some((actual) => actual.status === "resolved") && link.href !== undefined
                ? "expected-link-mismatch"
                : "missing-expected-link",
              "Required authored link is absent, unresolved, or resolves to a different record; inspect this record and its supplied expectations.",
            );
          }
        }
      }
    }
    if (records.has(id) && (indexed === null || !indexed.has(id))) {
      add(id, "index-unavailable", "Current record could not be verified in the keyword index.");
    }
  }
  const failed = new Set(problems.map((p) => p.id)).size,
    offset = input.offset ?? 0,
    limit = input.limit ?? 20;
  return {
    checked: expected.size,
    passed: expected.size - failed,
    failed,
    problems: problems.slice(offset, offset + limit),
    totalProblems: problems.length,
    nextOffset: offset + limit < problems.length ? offset + limit : null,
    snapshot,
    checkedAt: data.checkedAt,
    index: indexed === null ? "unavailable" : "ready",
    message:
      "Structural verification only: checks current eligibility, references, retained evidence, supplied expectations and keyword indexing. Does not evaluate interpretation, attribution accuracy or source completeness.",
  };
}
