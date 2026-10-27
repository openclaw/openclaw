import type { Static } from "typebox";
import type { ClaimCard } from "./inspection-contract.js";
import type { LoadedRecord } from "./model.js";
import { recordSummary, sourceCount } from "./record-summary.js";
import { truncateWhole } from "./text-window.js";

export function claimCard(
  record: LoadedRecord,
  records: LoadedRecord[] = [],
): Static<typeof ClaimCard> {
  const m = record.metadata;
  const owner = records.find((r) => r.id === m.owner && r.kind === "page");
  const source = records.find((r) => r.id === m.source_page && r.kind === "page");
  return {
    hash: record.hash,
    body: truncateWhole(record.body, 4000),
    truncated: record.body.length > 4000,
    evidenceTotal: m.evidence?.length ?? 0,
    evidenceSourceTotal: sourceCount(m.evidence),
    about: records
      .filter((r) => m.entities?.includes(r.id))
      .slice(0, 2)
      .map(recordSummary),
    ...(owner ? { owner: recordSummary(owner) } : {}),
    ...(source ? { source: recordSummary(source) } : {}),
    ...(m.attribution !== undefined ? { attribution: m.attribution } : {}),
    ...(m.assertion_origin !== undefined ? { assertionOrigin: m.assertion_origin } : {}),
    ...(m.claim_kind !== undefined ? { claimKind: m.claim_kind } : {}),
    metadata: {
      ...(m.supersedes ? { supersedes: m.supersedes } : {}),
      ...(m.continuity ? { continuity: m.continuity } : {}),
      ...(m.attribution_confidence ? { attribution_confidence: m.attribution_confidence } : {}),
      ...(m.entities !== undefined ? { entities: m.entities } : {}),
      ...(m.owner !== undefined ? { owner: m.owner } : {}),
      ...(m.due_at !== undefined ? { due_at: m.due_at } : {}),
      ...(m.occurred_at !== undefined ? { occurred_at: m.occurred_at } : {}),
      ...(m.source_event !== undefined ? { source_event: m.source_event } : {}),
    },
  };
}
