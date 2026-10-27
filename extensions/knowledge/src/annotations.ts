import type { Envelope, Evidence, LoadedRecord } from "./model.js";

export function annotationEvidence(m: Partial<Envelope>): Evidence[] {
  return [
    ...(m.attribution_confidence?.evidence ?? []),
    ...(m.identity?.candidates ?? []).flatMap((c) => c.evidence),
    ...(m.continuity ?? []).flatMap((c) => c.evidence),
  ];
}

/** `byId` resolves a stable ID to every record carrying it (a scan's index). */
export function annotationProblems(
  m: Envelope,
  byId: (id: string) => readonly LoadedRecord[],
): string[] {
  const issues: string[] = [];
  const reference = (id: string, kind: string) => {
    const found = byId(id);
    if (id === m.id || found.length !== 1 || found[0]!.kind !== kind) {
      issues.push(`Invalid ${kind} annotation reference: ${id}`);
    }
  };
  if (m.source_event && (m.claim_kind !== "event" || !m.source_page)) {
    issues.push("Source event requires an event claim and its source page");
  }
  if (m.source_page) {
    reference(m.source_page, "page");
  }
  if (m.identity) {
    if (m.kind !== "page") {
      issues.push("Identity annotations require a page");
    }
    if (m.identity.status === "resolved" && m.identity.candidates?.length) {
      issues.push("Resolved identity cannot have unresolved candidates");
    }
    for (const candidate of m.identity.candidates ?? []) {
      reference(candidate.id, "page");
    }
  }
  if (m.continuity?.length) {
    if (m.kind !== "claim") {
      issues.push("Assertion continuity requires a claim");
    }
    for (const link of m.continuity) {
      reference(link.id, "claim");
    }
  }
  return issues;
}
