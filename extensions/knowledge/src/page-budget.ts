import { Type, type Static } from "typebox";
import { TEXT_PAGE_DEFAULT_CHARS } from "./limits.js";
import { resolveLinks } from "./markdown-links.js";
import { linkTargets } from "./merge.js";
import { id, text, type LoadedRecord } from "./model.js";

/**
 * Page bodies are budgeted by read cost. A hub page is read whenever an agent
 * works on anything connected to it, so its body must fit one default
 * knowledge_record read; other pages get two reads. Claims are never budgeted.
 */
export const HUB_PAGE_BUDGET_CHARS = TEXT_PAGE_DEFAULT_CHARS;
export const PAGE_BUDGET_CHARS = 2 * TEXT_PAGE_DEFAULT_CHARS;
/** Top decile by authored-link degree within the current partition. */
export const DEFAULT_HUB_PERCENTILE = 90;
/** Below this many current pages one page spans several percentile points; no hubs. */
export const HUB_MIN_PAGES = 20;
/** A hub links with at least this many distinct pages, whatever its percentile. */
export const HUB_MIN_DEGREE = 10;
const SECTIONS_REPORTED = 6;
const CANDIDATES_REPORTED = 3;

const chars = Type.Integer({ minimum: 0 });
const Candidate = Type.Object(
  {
    id,
    title: text(200),
    type: text(64),
    linked: Type.Boolean({ description: "The section already links to this page." }),
    mentions: Type.Integer({ minimum: 0 }),
    headroomChars: Type.Integer({
      description: "Its budget minus its current size; negative when already over.",
    }),
  },
  { additionalProperties: false },
);
const SectionReport = Type.Object(
  {
    heading: text(200),
    level: Type.Integer({ minimum: 1, maximum: 6 }),
    start: chars,
    end: chars,
    chars,
    subsections: Type.Integer({ minimum: 0 }),
    candidates: Type.Array(Candidate, {
      maxItems: CANDIDATES_REPORTED,
      description:
        "Existing pages connected to this page that the section links to or names. Empty means extract to a new page.",
    }),
  },
  { additionalProperties: false },
);
const PageReport = Type.Object(
  {
    id: Type.Union([id, Type.Null()], {
      description: "Null for a page this request would create.",
    }),
    title: text(200),
    currentChars: chars,
    attemptedChars: chars,
    budgetChars: chars,
    hub: Type.Object(
      {
        hub: Type.Boolean(),
        degree: Type.Integer({
          minimum: 0,
          description:
            "Distinct current pages linked to or from this page by wikilinks or Markdown links.",
        }),
        percentile: Type.Number({ description: "Share of current pages with a lower degree." }),
        hubPercentile: Type.Number(),
        pages: Type.Integer({ minimum: 0 }),
        minPages: Type.Integer(),
        minDegree: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    sectionsOf: Type.Union([Type.Literal("current"), Type.Literal("attempted")]),
    sections: Type.Array(SectionReport, { maxItems: SECTIONS_REPORTED }),
  },
  { additionalProperties: false },
);
/** Why a rejected receipt saved nothing: the pages whose bodies would grow past their budget. */
export const PageBudget = Type.Object(
  { pages: Type.Array(PageReport, { maxItems: 25 }) },
  { additionalProperties: false },
);
export type PageBudget = Static<typeof PageBudget>;

export type Section = { heading: string; level: number; start: number; end: number };
/** ATX headings outside fenced code; each section runs to the next heading of its level or higher. */
export function pageSections(body: string): Section[] {
  const headings: Omit<Section, "end">[] = [];
  let fence: string | undefined;
  for (let start = 0; start < body.length;) {
    const newline = body.indexOf("\n", start),
      end = newline === -1 ? body.length : newline;
    const line = body.slice(start, end).replace(/\r$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !line.trim().slice(marker.length).trim()
      ) {
        fence = undefined;
      }
    } else if (marker) {
      fence = marker;
    } else {
      const heading = /^ {0,3}(#{1,6})(?=[ \t]|$)[ \t]*(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (heading) {
        headings.push({ heading: heading[2]!, level: heading[1]!.length, start });
      }
    }
    start = end + 1;
  }
  return headings.map((h, n) => ({
    heading: h.heading,
    level: h.level,
    start: h.start,
    end: headings.slice(n + 1).find((next) => next.level <= h.level)?.start ?? body.length,
  }));
}

export type LinkGraph = {
  pages: Map<string, LoadedRecord>;
  neighbours: Map<string, Set<string>>;
  targets: ReturnType<typeof linkTargets>;
  relationships: LoadedRecord[];
};
/** Undirected page graph of authored body links; typed relationships and claims do not count. */
export function linkGraph(records: readonly LoadedRecord[], current: LoadedRecord[]): LinkGraph {
  const pages = new Map(
    current.filter((r) => r.kind === "page" && r.lifecycle === "active").map((r) => [r.id, r]),
  );
  const neighbours = new Map([...pages.keys()].map((page) => [page, new Set<string>()]));
  const targets = linkTargets(records, current);
  for (const page of pages.values()) {
    for (const link of resolveLinks(page, targets.candidates, targets.canonical)) {
      if (link.id && link.id !== page.id && pages.has(link.id)) {
        neighbours.get(page.id)!.add(link.id);
        neighbours.get(link.id)!.add(page.id);
      }
    }
  }
  return {
    pages,
    neighbours,
    targets,
    relationships: current.filter((r) => r.kind === "relationship"),
  };
}

export type HubStatus = Static<typeof PageReport>["hub"];
/** Percentile rank by degree among current pages, with a vault-size and degree floor. */
export function hubStatus(graph: LinkGraph, pageId: string, hubPercentile: number): HubStatus {
  const degree = graph.neighbours.get(pageId)?.size ?? 0,
    pages = graph.pages.size;
  let below = 0;
  for (const linked of graph.neighbours.values()) {
    below += linked.size < degree ? 1 : 0;
  }
  const percentile = pages ? (100 * below) / pages : 0;
  return {
    hub: pages >= HUB_MIN_PAGES && degree >= HUB_MIN_DEGREE && percentile >= hubPercentile,
    degree,
    percentile: Math.floor(percentile * 10) / 10,
    hubPercentile,
    pages,
    minPages: HUB_MIN_PAGES,
    minDegree: HUB_MIN_DEGREE,
  };
}

export const pageBudget = (hub: Pick<HubStatus, "hub">) =>
  hub.hub ? HUB_PAGE_BUDGET_CHARS : PAGE_BUDGET_CHARS;

/** Current pages connected to a page by a body link or a typed relationship. */
export function connectedPages(graph: LinkGraph, pageId: string): LoadedRecord[] {
  const connected = new Set(graph.neighbours.get(pageId));
  for (const r of graph.relationships) {
    if (r.metadata.from === pageId && r.metadata.to) {
      connected.add(r.metadata.to);
    }
    if (r.metadata.to === pageId && r.metadata.from) {
      connected.add(r.metadata.from);
    }
  }
  connected.delete(pageId);
  return [...connected].flatMap((other) => graph.pages.get(other) ?? []);
}

const clip = (value: string, max: number) => Array.from(value).slice(0, max).join("");
/** Whole-word, case-insensitive mentions of a page's title or aliases of three characters or more. */
export function pageMentions(body: string, page: LoadedRecord) {
  let count = 0;
  const names = [page.title, ...(page.metadata.aliases ?? [])].map((n) => n.trim());
  for (const name of new Set(names.filter((n) => n.length >= 3))) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    count +=
      body.match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"))?.length ?? 0;
  }
  return count;
}

function sectionReports(
  page: LoadedRecord,
  body: string,
  graph: LinkGraph,
  hubPercentile: number,
): Static<typeof SectionReport>[] {
  const sections = pageSections(body),
    connected = connectedPages(graph, page.id);
  return sections
    .toSorted((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
    .slice(0, SECTIONS_REPORTED)
    .map((section) => {
      const content = body.slice(section.start, section.end);
      const sectionLinks = new Set(
        resolveLinks(
          { id: page.id, title: page.title, path: page.path, body: content, metadata: {} },
          graph.targets.candidates,
          graph.targets.canonical,
        ).flatMap((link) => (link.id ? [link.id] : [])),
      );
      const candidates = connected
        .map((candidate) => ({
          candidate,
          linked: sectionLinks.has(candidate.id),
          mentions: Math.min(999, pageMentions(content, candidate)),
        }))
        .filter((c) => c.linked || c.mentions)
        .toSorted(
          (a, b) =>
            Number(b.linked) - Number(a.linked) ||
            b.mentions - a.mentions ||
            a.candidate.title.localeCompare(b.candidate.title),
        )
        .slice(0, CANDIDATES_REPORTED)
        .map(({ candidate, linked, mentions }) => ({
          id: candidate.id,
          title: clip(candidate.title, 200),
          type: clip(candidate.type, 64),
          linked,
          mentions,
          headroomChars:
            pageBudget(hubStatus(graph, candidate.id, hubPercentile)) - candidate.body.length,
        }));
      return {
        heading: clip(section.heading, 200),
        level: section.level,
        start: section.start,
        end: section.end,
        chars: section.end - section.start,
        subsections: sections.filter(
          (s) => s.start > section.start && s.end <= section.end && s.level > section.level,
        ).length,
        candidates,
      };
    });
}

export type PageChange = { before?: LoadedRecord; after: LoadedRecord };
/**
 * One rule for every page-body write: growth past the page's budget is rejected;
 * an edit that keeps the body the same size or smaller always passes, so a page
 * already over budget can only shrink (the ratchet). Returns undefined to allow.
 */
export function pageBudgetRejection(input: {
  changes: PageChange[];
  records: readonly LoadedRecord[];
  current: () => LoadedRecord[];
  hubPercentile: number;
}): { message: string; budget: PageBudget } | undefined {
  const growing = input.changes.filter(
    ({ before, after }) =>
      after.kind === "page" &&
      after.body.length > HUB_PAGE_BUDGET_CHARS &&
      after.body.length > (before?.body.length ?? 0),
  );
  if (!growing.length) {
    return undefined;
  }
  const graph = linkGraph(input.records, input.current());
  const pages = growing.flatMap(({ before, after }) => {
    const hub = hubStatus(graph, after.id, input.hubPercentile),
      budget = pageBudget(hub);
    if (after.body.length <= budget) {
      return [];
    }
    return [
      {
        id: before ? before.id : null,
        title: clip(after.title, 200),
        currentChars: before?.body.length ?? 0,
        attemptedChars: after.body.length,
        budgetChars: budget,
        hub,
        sectionsOf: before ? ("current" as const) : ("attempted" as const),
        sections: sectionReports(after, before?.body ?? after.body, graph, input.hubPercentile),
      },
    ];
  });
  if (!pages.length) {
    return undefined;
  }
  const [first] = pages;
  return {
    message: clip(
      `Nothing was saved: ${first!.title} would grow to ${first!.attemptedChars} characters, past its ${first!.budgetChars}-character ${first!.hub.hub ? "hub " : ""}page budget${pages.length > 1 ? ` (and ${pages.length - 1} more page${pages.length > 2 ? "s" : ""})` : ""}. Edits that keep a body the same size or smaller always succeed. Move a whole section to its own page, new or one of the listed connected candidates, with knowledge_extract_section, then retry. Save discrete facts as claims with knowledge_remember. Do not truncate or drop content to fit.`,
      1000,
    ),
    budget: { pages },
  };
}
