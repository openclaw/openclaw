// Adapted from gbrain src/core/facts/relink.ts ("page" and "mention" tiers);
// see THIRD_PARTY_NOTICES.md.
import { createHash } from "node:crypto";
import type { LoadedRecord } from "./model.js";
import type { RelinkExample } from "./relink-contract.js";
import { inferSubject, isFactEntity, resolveHint } from "./subject-infer.js";
import type { SampleVault } from "./vault.js";

type Snapshot = Awaited<ReturnType<SampleVault["scan"]>>;
export type RelinkPlan = {
  record: LoadedRecord;
  outcome: RelinkExample["outcome"];
  tier?: "page" | "hint" | "mention";
  subject?: LoadedRecord;
  reason?: string;
};

/** knowledge_remember cites the retained conversation excerpt it uploads under its request ID. */
const REMEMBERED_EXCERPT = /^artifacts\/[a-f0-9-]{36}\/excerpt\.txt$/;

/**
 * Current unlinked claims in stable ID order. `remembered` selects claims
 * knowledge_remember saved without a subject (relink's targets); `all` selects
 * every claim reachable from no page: no linked page and no source page.
 */
export function unlinkedClaims(
  active: readonly LoadedRecord[],
  include: "remembered" | "all" = "remembered",
): LoadedRecord[] {
  return active
    .filter(
      (r) =>
        r.kind === "claim" &&
        r.lifecycle === "active" &&
        r.valid &&
        !r.metadata.entities?.length &&
        (include === "all"
          ? !r.metadata.source_page
          : (r.metadata.evidence ?? []).some((e) => REMEMBERED_EXCERPT.test(e.path))),
    )
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Decide one claim's subject with zero model calls: its recorded source page
 * when that is an entity page, then the one entity page its saver's subject
 * hint names, then the one entity page its text names with no competing name.
 * Anything else stays unlinked; nothing is guessed.
 */
export function planRelink(
  data: Snapshot,
  active: readonly LoadedRecord[],
  withdrawn: Set<string>,
  record: LoadedRecord,
): RelinkPlan {
  const page = (id: string | undefined) =>
    id
      ? active.find((r) => r.id === id && r.kind === "page" && r.lifecycle === "active")
      : undefined;
  const source = page(record.metadata.source_page);
  if (source && isFactEntity(data, source)) {
    return { record, outcome: "linked", tier: "page", subject: source };
  }
  const hint = record.metadata.subject_hint;
  const hinted = hint ? page(resolveHint(data, hint, withdrawn).id ?? undefined) : undefined;
  if (hinted) {
    return { record, outcome: "linked", tier: "hint", subject: hinted };
  }
  const inferred = inferSubject(data, record.body, withdrawn);
  const subject = page(inferred.id ?? undefined);
  if (subject) {
    return { record, outcome: "linked", tier: "mention", subject };
  }
  const reason = inferred.id === null ? inferred.reason : "no_page";
  return {
    record,
    outcome: reason === "ambiguous" || reason === "unverified_match" ? "ambiguous" : "no_subject",
    reason,
  };
}

/** Stable request ID for linking one claim revision to one subject, so an
 * interrupted pass replays its publication instead of duplicating it. */
export function relinkRequestId(
  record: Pick<LoadedRecord, "id" | "revision">,
  subjectId: string,
): string {
  const bytes = createHash("sha256")
    .update("knowledge-relink\0")
    .update(record.id)
    .update("\0")
    .update(String(record.revision))
    .update("\0")
    .update(subjectId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
