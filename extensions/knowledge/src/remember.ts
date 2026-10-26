import type { Evidence, LoadedRecord } from "./model.js";
import type { ClaimInput } from "./mutation-contract.js";
import type { RememberInput, RememberItem, RememberResult } from "./remember-contract.js";
import { exactLookup } from "./retrieval.js";
import { inferSubject, resolveHint } from "./subject-infer.js";
import type { SampleVault } from "./vault.js";

type Snapshot = Awaited<ReturnType<SampleVault["scan"]>>;
type Resolution = Pick<RememberResult, "subject" | "subjectId" | "candidates">;
/** One item's resolved subject plus, when it repeats saved knowledge, the claim it repeats. */
export type PlannedItem = Resolution & { duplicateOf?: string; sameAs?: number };
export type ClaimPayload = Omit<
  ClaimInput,
  "requestId" | "expectedVaultId" | "expectedOntologyFingerprint"
>;

const normalize = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v) => b.includes(v));

/**
 * Resolve one item's subject. A named subject uses exact ID/title/alias
 * lookup and never guesses; an omitted one is inferred from the `about` hint,
 * then the claim text, only when it names exactly one entity page and no
 * competing name.
 */
function resolveSubject(data: Snapshot, item: RememberItem, withdrawn: Set<string>): Resolution {
  const subject = item.subject;
  if (!subject?.trim()) {
    if (item.infer_subject === false) {
      return { subject: "none" };
    }
    const hinted = item.about ? resolveHint(data, item.about, withdrawn) : undefined;
    const inferred = hinted?.id ? hinted : inferSubject(data, item.text, withdrawn);
    return inferred.id ? { subject: "inferred", subjectId: inferred.id } : { subject: "none" };
  }
  const found = exactLookup(data, { query: subject, kind: "page", limit: 10 }, withdrawn);
  if (found.outcome === "found") {
    return { subject: "attached", subjectId: found.hits[0]!.record.id };
  }
  if (found.outcome === "ambiguous") {
    return {
      subject: "ambiguous",
      candidates: found.hits.map((h) => ({ id: h.record.id, title: h.record.title })),
    };
  }
  return { subject: "missing" };
}

/**
 * Plan one remember call against the current authorized snapshot.
 * Each item gets a subject resolution and, when an active claim with the same
 * normalized text, kind and linked subjects already exists (or an earlier item
 * in this call says the same thing), a duplicate marker so nothing is rewritten.
 */
export function planRemember(
  data: Snapshot,
  active: LoadedRecord[],
  input: RememberInput,
  withdrawn: Set<string>,
): PlannedItem[] {
  const claims = active.filter((r) => r.kind === "claim" && r.lifecycle === "active");
  const planned: PlannedItem[] = [];
  const keys: string[] = [];
  for (const item of input.items) {
    const resolution = resolveSubject(data, item, withdrawn);
    const entities = resolution.subjectId ? [resolution.subjectId] : [];
    const text = normalize(item.text);
    // Exact repeat of saved knowledge: same words, kind and linked subjects.
    const existing = claims.find(
      (r) =>
        r.metadata.claim_kind === item.kind &&
        normalize(r.body) === text &&
        sameSet(r.metadata.entities ?? [], entities),
    );
    // Exact repeat inside this call collapses to its first occurrence.
    const key = `${item.kind}\0${text}\0${entities.join(",")}`,
      earlier = keys.indexOf(key);
    keys.push(key);
    planned.push({
      ...resolution,
      ...(existing ? { duplicateOf: existing.id } : earlier >= 0 ? { sameAs: earlier } : {}),
    });
  }
  return planned;
}

/** Shorten a long claim to a title at a word boundary. */
function title(text: string): string {
  const clean = text.trim().replace(/\s+/gu, " ");
  if (clean.length <= 200) {
    return clean;
  }
  const cut = clean.slice(0, 199),
    space = cut.lastIndexOf(" ");
  return `${(space > 100 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Build the claim one remembered item publishes, citing the retained excerpt.
 * An unmatched subject leaves the claim without entities; nothing is guessed. */
export function claimPayload(
  item: RememberItem,
  plan: PlannedItem,
  evidence: Evidence,
  attribution: string,
): ClaimPayload {
  return {
    title: title(item.text),
    body: item.text,
    claim_kind: item.kind,
    assertion_origin: item.origin ?? "source",
    attribution,
    evidence: [evidence],
    ...(plan.subjectId ? { entities: [plan.subjectId] } : {}),
    ...(item.about ? { subject_hint: item.about.trim() } : {}),
    ...(item.occurred_at ? { occurred_at: item.occurred_at } : {}),
    ...(item.due_at ? { due_at: item.due_at } : {}),
    ...(item.valid_from ? { valid_from: item.valid_from } : {}),
    ...(item.expires_at ? { expires_at: item.expires_at } : {}),
  };
}
