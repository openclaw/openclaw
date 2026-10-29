import { carryLinkExtraction } from "./markdown-links.js";
import type { Envelope, LoadedRecord } from "./model.js";

/** Longest chain of merged pages followed before a redirect is treated as invalid. */
const MAX_MERGE_HOPS = 8;
/** Namespaced aliases such as `discord:123` or `email:a@b.c` identify one entity across sources. */
export const IDENTITY_KEY = /^[a-z][a-z0-9_-]*:\S+$/i;
const normalize = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

/** Explain why a page's merge metadata cannot be followed; undefined when it is sound or absent. */
export function mergeProblem(
  record: LoadedRecord,
  byId: Map<string, LoadedRecord[]>,
): string | undefined {
  const m = record.metadata;
  if (m.lifecycle !== "merged") {
    return m.merged_into ? "merged_into is only valid on a merged page." : undefined;
  }
  if (record.kind !== "page") {
    return "Only pages can be merged.";
  }
  if (!m.merged_into) {
    return "A merged page needs merged_into.";
  }
  // Walk to the first page that is not itself merged. A later merge of the
  // survivor extends the chain; the hop limit also ends any cycle.
  let current = record;
  for (let hops = 0; hops < MAX_MERGE_HOPS; hops++) {
    const candidates = byId.get(current.metadata.merged_into!);
    if (!candidates || candidates.length !== 1) {
      return "Merge target is missing or ambiguous: " + current.metadata.merged_into;
    }
    const target = candidates[0]!;
    if (target.id === record.id) {
      return "Merge chain forms a cycle.";
    }
    if (target.kind !== "page" || target.type !== record.type) {
      return "Merge target must be a page of the same type: " + target.id;
    }
    if (target.metadata.lifecycle !== "merged") {
      return undefined;
    }
    current = target;
  }
  return `Merge chain exceeds ${MAX_MERGE_HOPS} hops.`;
}

const redirectCache = new WeakMap<readonly LoadedRecord[], Map<string, string>>();
/** Map each valid merged page ID to the final page its chain ends at. */
export function mergeRedirects(records: readonly LoadedRecord[]): Map<string, string> {
  const cached = redirectCache.get(records);
  if (cached) {
    return cached;
  }
  const byId = new Map<string, LoadedRecord | null>();
  for (const r of records) {
    byId.set(r.id, byId.has(r.id) ? null : r);
  }
  const redirects = new Map<string, string>();
  for (const r of records) {
    // Scan validation already rejected broken chains by marking the merged page invalid.
    if (!r.valid || r.lifecycle !== "merged" || byId.get(r.id) !== r) {
      continue;
    }
    let target = byId.get(r.metadata.merged_into!);
    for (let hops = 1; target && target.lifecycle === "merged" && hops < MAX_MERGE_HOPS; hops++) {
      target = byId.get(target.metadata.merged_into!);
    }
    if (target && target.lifecycle !== "merged") {
      redirects.set(r.id, target.id);
    }
  }
  redirectCache.set(records, redirects);
  return redirects;
}

/** Page and dependency references a record makes, as authored. */
export function referenceIds(m: Envelope): string[] {
  return [
    ...(m.dependencies ?? []),
    ...(m.entities ?? []),
    ...[m.from, m.to, m.owner].filter((id): id is string => Boolean(id)),
  ];
}

/** The current view of a record: references to merged pages resolve to their survivors, and
 * `redirected` keeps each old → new mapping. Records without such references are returned as is. */
export function effectiveRecord(
  record: LoadedRecord,
  redirects: Map<string, string>,
): LoadedRecord {
  if (!redirects.size) {
    return record;
  }
  const redirected: Record<string, string> = {},
    metadata: Envelope = { ...record.metadata };
  const resolve = (id: string) => {
    const target = redirects.get(id);
    if (target) {
      redirected[id] = target;
    }
    return target ?? id;
  };
  for (const key of ["owner", "from", "to", "source_page"] as const) {
    if (metadata[key]) {
      metadata[key] = resolve(metadata[key]!);
    }
  }
  // A claim naming both a fragment and its survivor names the survivor once.
  for (const key of ["entities", "dependencies"] as const) {
    if (metadata[key]) {
      metadata[key] = [...new Set(metadata[key]!.map(resolve))];
    }
  }
  if (!Object.keys(redirected).length) {
    return record;
  }
  const projection = { ...record, metadata, redirected };
  carryLinkExtraction(record, projection);
  return projection;
}

/** Link candidates for current records, plus the mapping that sends merged pages to their survivors. */
export function linkTargets(records: readonly LoadedRecord[], current: LoadedRecord[]) {
  const redirects = mergeRedirects(records);
  return {
    candidates: [...current, ...records.filter((r) => redirects.has(r.id))],
    canonical: (id: string) => redirects.get(id) ?? id,
  };
}

// The calendar day a page records, from occurred_at metadata or field; "" when undated.
function occurredDay(r: LoadedRecord): string {
  const occurred = r.metadata.occurred_at ?? r.metadata.fields?.occurred_at;
  return typeof occurred === "string" ? occurred.slice(0, 10) : "";
}

export type MergeCandidate = {
  type: string;
  key: string;
  strength: "identity-key" | "title";
  pages: { id: string; title: string }[];
};
/** Groups of current pages of one type that share an identity-key alias (strong) or a title (weak). Never merges. */
export function mergeCandidates(current: LoadedRecord[], limit = 100): MergeCandidate[] {
  const groups = new Map<string, MergeCandidate>();
  const add = (r: LoadedRecord, strength: MergeCandidate["strength"], key: string, day = "") => {
    const group = `${r.type}\0${strength}\0${normalize(key)}\0${day}`;
    const entry = groups.get(group) ?? { type: r.type, key, strength, pages: [] };
    if (!entry.pages.some((p) => p.id === r.id)) {
      entry.pages.push({ id: r.id, title: r.title });
    }
    groups.set(group, entry);
  };
  for (const r of current) {
    if (r.kind !== "page" || r.lifecycle !== "active") {
      continue;
    }
    for (const alias of r.metadata.aliases ?? []) {
      if (IDENTITY_KEY.test(alias.trim())) {
        add(r, "identity-key", alias.trim());
      }
    }
    // Recurring meetings share a title; only pages from the same day can be one record.
    add(r, "title", r.title, occurredDay(r));
  }
  const found = [...groups.values()].filter((g) => g.pages.length > 1);
  // A title group adds nothing when an identity key already groups the same pages.
  const strong = new Set(
    found
      .filter((g) => g.strength === "identity-key")
      .map((g) =>
        g.pages
          .map((p) => p.id)
          .toSorted()
          .join("\0"),
      ),
  );
  return found
    .filter(
      (g) =>
        g.strength === "identity-key" ||
        !strong.has(
          g.pages
            .map((p) => p.id)
            .toSorted()
            .join("\0"),
        ),
    )
    .toSorted(
      (a, b) =>
        (a.strength === b.strength ? 0 : a.strength === "identity-key" ? -1 : 1) ||
        a.key.localeCompare(b.key),
    )
    .slice(0, limit);
}
