import { lifecycleImpact, lifecycleRecord } from "./lifecycle.js";
import { mergeRedirects } from "./merge.js";
import type { LoadedRecord } from "./model.js";
import type { SupersedeInput } from "./mutation-contract.js";
import type { Prepared } from "./storage-types.js";

type Fence = SupersedeInput["by"];

/**
 * Plan marking earlier claims superseded by one existing claim, or undoing that. The
 * superseding claim is never rewritten: each earlier claim gets `superseded_by` and a
 * lifecycle_change, exactly like the original side of a correction. `current` holds the
 * caller's eligible (active, in-scope) records. The superseding claim must be current and every
 * superseded claim active, so a supersession can never form a cycle.
 */
export function planSupersede(
  data: Prepared["data"],
  current: LoadedRecord[],
  input: SupersedeInput,
  actor: string,
) {
  const ids = input.superseded.map((f) => f.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Each superseded claim may be listed once. No publication accepted.");
  }
  if (ids.includes(input.by.id)) {
    throw new Error("A claim cannot supersede itself. No publication accepted.");
  }
  const exact = (fence: Fence, role: string) => {
    const matches = data.records.filter((r) => r.id === fence.id),
      r = matches.length === 1 ? matches[0] : undefined;
    if (
      !r ||
      !r.valid ||
      r.kind !== "claim" ||
      r.revision !== fence.expectedRevision ||
      r.hash !== fence.expectedHash
    ) {
      throw new Error(
        `${role} claim unavailable, not a claim, invalid or changed: ${fence.id}. Reread it with knowledge_record and retry with a new request. No publication accepted.`,
      );
    }
    return r;
  };
  const by = exact(input.by, "Superseding");
  const change = { reason: input.reason, requestId: input.requestId };
  if (input.undo) {
    const changes = input.superseded.map((fence) => {
      const r = exact(fence, "Superseded");
      if (r.lifecycle !== "superseded" || r.metadata.superseded_by !== by.id) {
        throw new Error(
          `${r.title} (${r.id}) is not superseded by ${by.id}. No publication accepted.`,
        );
      }
      if (by.metadata.supersedes === r.id) {
        throw new Error(
          `${r.title} (${r.id}) was replaced by knowledge_correct, which wrote ${by.id} as its new version. Correct or withdraw ${by.id} instead. No publication accepted.`,
        );
      }
      return { before: r, after: lifecycleRecord(r, "active", change, actor) };
    });
    return { by, changes, impact: undefined };
  }
  if (!current.some((r) => r.id === by.id)) {
    throw new Error(
      `Superseding claim ${by.title} (${by.id}) is not current in this scope: it is ${by.lifecycle}, expired, or depends on an unavailable record. No publication accepted.`,
    );
  }
  // Plausibly the same subject: both claims are filed on at least one common page.
  const redirects = mergeRedirects(data.records);
  const subjects = (r: LoadedRecord) =>
    [
      ...(r.metadata.entities ?? []),
      ...(r.metadata.source_page ? [r.metadata.source_page] : []),
    ].map((id) => redirects.get(id) ?? id);
  const shared = new Set(subjects(by));
  const changes = input.superseded.map((fence) => {
    const r = exact(fence, "Superseded");
    if (r.lifecycle !== "active") {
      throw new Error(
        `${r.title} (${r.id}) is ${r.lifecycle}, not active. A superseded claim keeps its first replacement; undo that supersession first. No publication accepted.`,
      );
    }
    if (!subjects(r).some((id) => shared.has(id))) {
      throw new Error(
        `${r.title} (${r.id}) shares no linked page with ${by.title} (${by.id}), so they may not be about the same subject. Link both to the page they are about with knowledge_annotate entities first. No publication accepted.`,
      );
    }
    return { before: r, after: lifecycleRecord(r, "superseded", change, actor, by.id) };
  });
  // Dependents of every superseded claim, once each; the claims themselves are receipt items.
  const impacts = ids.map((id) => lifecycleImpact(data.records, id));
  // Retrieval hides dependents of inactive records, so the replacement must not be one of them.
  const hidden = impacts.findIndex((i) => i.items.some((item) => item.id === by.id));
  if (hidden !== -1) {
    const r = changes[hidden]!.before;
    throw new Error(
      `${by.title} (${by.id}) depends on ${r.title} (${r.id}), directly or through its dependents, so superseding it would hide the replacement too. Supersede by a claim that does not depend on it. No publication accepted.`,
    );
  }
  const items = [
    ...new Map(
      impacts
        .flatMap((i) => i.items)
        .filter((i) => !ids.includes(i.id))
        .map((i) => [i.id, i]),
    ).values(),
  ];
  return { by, changes, impact: { ...impacts[0]!, items, total: items.length } };
}
