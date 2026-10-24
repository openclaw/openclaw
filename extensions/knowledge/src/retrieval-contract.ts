import { Type, type Static } from "typebox";
import { TemporalFilters } from "./chronicle-contract.js";
import { Summary } from "./inspection-contract.js";
import { text, Envelope } from "./model.js";
import { QueryFreshness } from "./query-freshness.js";

const filters = {
  kind: Type.Optional(Envelope.properties.kind),
  type: Type.Optional(text(64)),
  tag: Type.Optional(text(200)),
  lifecycle: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("superseded"), Type.Literal("all")]),
  ),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
};
export const LookupInput = Type.Object(
  { query: Type.String({ minLength: 1, maxLength: 200 }), ...filters },
  { additionalProperties: false },
);
export type LookupInput = Static<typeof LookupInput>;
export const SearchInput = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 500 }),
    mode: Type.Optional(
      Type.Union([Type.Literal("all"), Type.Literal("any"), Type.Literal("phrase")]),
    ),
    ...filters,
    ...TemporalFilters,
  },
  { additionalProperties: false },
);
export type SearchInput = Static<typeof SearchInput>;
const locator = Type.Object({
  path: text(500),
  sha256: text(64),
  start_line: Type.Optional(Type.Integer()),
  end_line: Type.Optional(Type.Integer()),
});
const hit = Type.Object({
  record: Summary,
  citation: Type.Object({
    id: text(96),
    path: text(500),
    revision: Type.Integer(),
    hash: text(64),
  }),
  snippet: Type.Object({
    matchLocated: Type.Optional(
      Type.Boolean({
        description:
          "False means a bounded opening excerpt, not the match location. Full-record matching and ranking are unchanged.",
      }),
    ),
    field: Type.Union([Type.Literal("title"), Type.Literal("aliases"), Type.Literal("body")]),
    text: text(480),
    start: Type.Integer(),
    end: Type.Integer(),
    startLine: Type.Union([Type.Integer(), Type.Null()]),
    endLine: Type.Union([Type.Integer(), Type.Null()]),
    truncated: Type.Boolean(),
  }),
  matches: Type.Array(text(20), { maxItems: 4 }),
  score: Type.Union([Type.Number(), Type.Null()]),
  attribution: text(1000),
  assertionOrigin: text(30),
  evidence: Type.Array(locator, { maxItems: 3 }),
  evidenceTruncated: Type.Boolean(),
});
/** Full ranked hit with citation, locators and evidence. */
export type FullHit = Static<typeof hit>;
/** Agent-default hit: identity, a short snippet and matched fields; no citation or evidence. */
export const CompactHit = Type.Object(
  {
    record: Type.Pick(Summary, [
      "id",
      "title",
      "kind",
      "type",
      "path",
      "revision",
      "lifecycle",
      "valid",
    ]),
    snippet: Type.Object({
      field: Type.Union([Type.Literal("title"), Type.Literal("aliases"), Type.Literal("body")]),
      text: text(200),
    }),
    matches: Type.Array(text(20), { maxItems: 4 }),
  },
  { additionalProperties: false },
);
export type CompactHit = Static<typeof CompactHit>;
const common = {
  // Page-local evidence count understood by Active Memory's custom-tool result gate.
  hits: Type.Array(hit, { maxItems: 50 }),
  resultCount: Type.Integer(),
  offset: Type.Integer(),
  nextOffset: Type.Union([Type.Integer(), Type.Null()]),
  freshness: QueryFreshness,
  coverage: Type.Object({ complete: Type.Boolean(), message: text(500) }),
};
export const SearchOutput = Type.Object(
  {
    ...common,
    mode: Type.Literal("keyword"),
    queryMode: Type.Union([Type.Literal("all"), Type.Literal("any"), Type.Literal("phrase")]),
    total: Type.Union([Type.Integer(), Type.Null()]),
    index: Type.Object({
      state: Type.Union([Type.Literal("ready"), Type.Literal("unavailable")]),
      lag: Type.Union([Type.Boolean(), Type.Null()]),
      snapshot: Type.Union([text(64), Type.Null()]),
      message: text(500),
    }),
  },
  { additionalProperties: false },
);
export type SearchOutput = Static<typeof SearchOutput>;
export const LookupOutput = Type.Object(
  {
    ...common,
    total: Type.Integer(),
    outcome: Type.Union([
      Type.Literal("found"),
      Type.Literal("ambiguous"),
      Type.Literal("missing"),
    ]),
    redirectedFrom: Type.Optional(
      Type.String({
        maxLength: 96,
        description: "The queried ID belongs to a page merged into the returned page.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type LookupOutput = Static<typeof LookupOutput>;
// Agent tool hits: full on `detail: "full"`, otherwise compact.
const toolHits = Type.Array(Type.Union([hit, CompactHit]), { maxItems: 50 });
/** knowledge_grep tool output: SearchOutput with full or compact hits. */
export const ToolSearchOutput = Type.Object(
  { ...SearchOutput.properties, hits: toolHits },
  { additionalProperties: false },
);
export type ToolSearchOutput = Static<typeof ToolSearchOutput>;
/** knowledge_lookup tool output: LookupOutput with full or compact hits. */
export const ToolLookupOutput = Type.Object(
  { ...LookupOutput.properties, hits: toolHits },
  { additionalProperties: false },
);
export type ToolLookupOutput = Static<typeof ToolLookupOutput>;
/** Narrow a tool hit; operator (non-agent) calls always receive full hits. */
export const isFullHit = (h: FullHit | CompactHit): h is FullHit => "citation" in h;
