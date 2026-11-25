export const WIKI_PAGE_GROUPS = [
  { kind: "source", dir: "sources", heading: "Sources" },
  { kind: "entity", dir: "entities", heading: "Entities" },
  { kind: "concept", dir: "concepts", heading: "Concepts" },
  { kind: "synthesis", dir: "syntheses", heading: "Syntheses" },
  { kind: "report", dir: "reports", heading: "Reports" },
] as const;

export type WikiPageKind = (typeof WIKI_PAGE_GROUPS)[number]["kind"];
