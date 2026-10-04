import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WikiPageSummary } from "./markdown.js";

const MAX_RELATED_PAGES_PER_SECTION = 12;
const MAX_SHARED_SOURCE_FANOUT = 24;

export type RelatedPageIndex = {
  candidatePages: WikiPageSummary[];
  pagesById: Map<string, WikiPageSummary>;
  /** Candidate positions (ascending) of pages listing each sourceId. */
  positionsBySourceId: Map<string, number[]>;
  /** Total sourceId occurrences across candidates, duplicates included. */
  sourceIdOccurrences: Map<string, number>;
  /** Candidate positions (ascending) of pages linking to each normalized target. */
  positionsByLinkTarget: Map<string, number[]>;
};

function normalizeComparableTarget(value: string): string {
  return normalizeLowercaseStringOrEmpty(
    value
      .trim()
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, ""),
  );
}

function uniquePages(pages: WikiPageSummary[]): WikiPageSummary[] {
  const seen = new Set<string>();
  const unique: WikiPageSummary[] = [];
  for (const page of pages) {
    const key = page.id ?? page.relativePath;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(page);
  }
  return unique;
}

function buildPageLookupKeys(page: WikiPageSummary): Set<string> {
  const keys = new Set<string>();
  keys.add(normalizeComparableTarget(page.relativePath));
  keys.add(normalizeComparableTarget(page.title));
  if (page.id) {
    keys.add(normalizeComparableTarget(page.id));
  }
  return keys;
}

function pushPosition(map: Map<string, number[]>, key: string, position: number): void {
  const positions = map.get(key);
  if (!positions) {
    map.set(key, [position]);
  } else if (positions.at(-1) !== position) {
    positions.push(position);
  }
}

// One pass over the vault, so each page's related block costs its own sources and
// links instead of a scan of every other page.
export function buildRelatedPageIndex(allPages: WikiPageSummary[]): RelatedPageIndex {
  const candidatePages = allPages.filter((candidate) => candidate.kind !== "report");
  const pagesById = new Map<string, WikiPageSummary>();
  const positionsBySourceId = new Map<string, number[]>();
  const sourceIdOccurrences = new Map<string, number>();
  const positionsByLinkTarget = new Map<string, number[]>();
  candidatePages.forEach((candidate, position) => {
    if (candidate.id) {
      pagesById.set(candidate.id, candidate);
    }
    for (const sourceId of candidate.sourceIds) {
      pushPosition(positionsBySourceId, sourceId, position);
      sourceIdOccurrences.set(sourceId, (sourceIdOccurrences.get(sourceId) ?? 0) + 1);
    }
    for (const target of candidate.linkTargets) {
      pushPosition(positionsByLinkTarget, normalizeComparableTarget(target), position);
    }
  });
  return {
    candidatePages,
    pagesById,
    positionsBySourceId,
    sourceIdOccurrences,
    positionsByLinkTarget,
  };
}

function collectCandidatePositions(lists: ReadonlyArray<readonly number[] | undefined>): number[] {
  const positions = new Set<number>();
  for (const list of lists) {
    for (const position of list ?? []) {
      positions.add(position);
    }
  }
  return [...positions].toSorted((left, right) => left - right);
}

export function selectRelatedPages(
  page: WikiPageSummary,
  index: RelatedPageIndex,
): {
  sourcePages: WikiPageSummary[];
  backlinkPages: WikiPageSummary[];
  relatedPages: WikiPageSummary[];
} {
  const { candidatePages, pagesById, positionsBySourceId, sourceIdOccurrences } = index;
  const sourcePages = uniquePages(
    page.sourceIds.flatMap((sourceId) => {
      const sourcePage = pagesById.get(sourceId);
      return sourcePage ? [sourcePage] : [];
    }),
  );
  const backlinkKeys = buildPageLookupKeys(page);
  const backlinks = uniquePages(
    collectCandidatePositions([
      positionsBySourceId.get(page.id ?? ""),
      ...[...backlinkKeys].map((key) => index.positionsByLinkTarget.get(key)),
    ]).flatMap((position) => {
      const candidate = candidatePages[position]!;
      return candidate.relativePath === page.relativePath ? [] : [candidate];
    }),
  );
  const backlinkPages =
    backlinks.length <= MAX_SHARED_SOURCE_FANOUT
      ? backlinks.slice(0, MAX_RELATED_PAGES_PER_SECTION)
      : [];
  // A source's fanout is how many other pages list it; hubs past the cap relate nothing.
  const ownSourceIds = new Set(page.sourceIds);
  const ownOccurrences = new Map<string, number>();
  for (const sourceId of page.sourceIds) {
    ownOccurrences.set(sourceId, (ownOccurrences.get(sourceId) ?? 0) + 1);
  }
  const narrowSourceIds = [...ownSourceIds].filter(
    (sourceId) =>
      (sourceIdOccurrences.get(sourceId) ?? 0) - (ownOccurrences.get(sourceId) ?? 0) <=
      MAX_SHARED_SOURCE_FANOUT,
  );
  const excludedPaths = new Set([
    page.relativePath,
    ...sourcePages.map((sourcePage) => sourcePage.relativePath),
    ...backlinkPages.map((backlink) => backlink.relativePath),
  ]);
  const relatedPages = uniquePages(
    collectCandidatePositions(narrowSourceIds.map((sourceId) => positionsBySourceId.get(sourceId)))
      .map((position) => candidatePages[position]!)
      .filter((candidate) => !excludedPaths.has(candidate.relativePath)),
  ).slice(0, MAX_RELATED_PAGES_PER_SECTION);
  return { sourcePages, backlinkPages, relatedPages };
}
