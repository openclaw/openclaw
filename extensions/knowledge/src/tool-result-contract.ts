import { Type, type Static, type TObject, type TProperties } from "typebox";
import { RecordOutput } from "./inspection-contract.js";
import { Definition, Field, text } from "./model.js";
import { Receipt } from "./mutation-contract.js";
import { PageBudget } from "./page-budget.js";
import { RememberResult } from "./remember-contract.js";
import { StoreState } from "./stores-contract.js";
import { PageRow, Ref, Row } from "./tool-rows.js";

// Lean agent tool outputs. Each operation's contract output is the union of its
// lean shape and its complete shape; tool-results.ts owns the projection.

/** Maximum agent search snippet length in UTF-16 code units. */
export const COMPACT_SNIPPET_CHARS = 200;

export const Detail = Type.Optional(
  Type.Union([Type.Literal("compact"), Type.Literal("full")], {
    description:
      "compact (default): the fields agents usually need. full: the complete response with every field, timestamp and explanatory message.",
  }),
);
export type Detail = Static<typeof Detail>;

/** Extend an input schema with the response-only detail selector. */
export function withDetail<P extends TProperties>(schema: TObject<P>) {
  return Type.Object({ ...schema.properties, detail: Detail }, { additionalProperties: false });
}

export const Incomplete = Type.Optional(
  Type.Object(
    { complete: Type.Literal(false), message: text(1500) },
    { additionalProperties: false },
  ),
);

export const page = {
  total: Type.Integer(),
  nextOffset: Type.Optional(Type.Integer()),
  snapshot: Type.Optional(text(64)),
};

export const Issue = Type.Object({ path: text(500), code: text(80), message: text(1000) });
const recordFields = RecordOutput.properties;
export const LeanEvidence = Type.Object(
  {
    path: text(500),
    sha256: text(64),
    filename: Type.Optional(text(500)),
    start_line: Type.Optional(Type.Integer()),
    end_line: Type.Optional(Type.Integer()),
    quote: Type.Optional(text(20000)),
    attribution: Type.Optional(text(1000)),
    excerpt: Type.Optional(text(20000)),
    verified: Type.Optional(Type.Literal(false)),
    excerptTruncated: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
export const LeanRecordFields = Type.Object(
  {
    id: text(96),
    revision: Type.Integer(),
    hash: text(64),
    lifecycle: Type.Optional(text(20)),
    title: Type.Optional(text(200)),
    type: Type.Optional(text(64)),
    claimKind: Type.Optional(text(30)),
    date: Type.Optional(text(40)),
    dueAt: Type.Optional(text(40)),
    owner: Type.Optional(Ref),
    from: Type.Optional(text(96)),
    to: Type.Optional(text(96)),
    aliases: Type.Optional(Type.Array(text(200), { maxItems: 100 })),
    fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    identity: Type.Optional(
      Type.Object(
        { status: Type.Literal("partial"), context: text(1000) },
        { additionalProperties: false },
      ),
    ),
    about: Type.Optional(Type.Array(Ref, { maxItems: 100 })),
    source: Type.Optional(Ref),
    attribution: Type.Optional(text(1000)),
    assertionOrigin: Type.Optional(text(30)),
    supersededBy: Type.Optional(text(96)),
    text: Type.Optional(text(65536)),
    body: Type.Optional(text(65536)),
    raw: Type.Optional(text(65536)),
  },
  { additionalProperties: false },
);
export const LeanRecordOutput = Type.Object(
  {
    record: Type.Union([LeanRecordFields, Type.Null()]),
    nextOffset: Type.Optional(Type.Integer()),
    totalChars: Type.Optional(Type.Integer()),
    issues: Type.Optional(Type.Array(Issue, { maxItems: 1000 })),
    mergedInto: Type.Optional(Ref),
    mergedFrom: Type.Optional(Type.Array(Ref, { maxItems: 100 })),
    redirects: recordFields.redirects,
    // Explicit options add exactly what they name.
    metadata: Type.Optional(Type.Unknown()),
    evidence: Type.Optional(Type.Array(LeanEvidence, { maxItems: 100 })),
    evidenceTotal: recordFields.evidenceTotal,
    evidenceSourceTotal: recordFields.evidenceSourceTotal,
    nextEvidenceOffset: Type.Optional(Type.Integer()),
    sourceFiles: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: text(500),
            sha256: text(64),
            filename: Type.Optional(text(500)),
            citations: Type.Integer(),
          },
          { additionalProperties: false },
        ),
        { maxItems: 100 },
      ),
    ),
    sourceFilesTotal: recordFields.sourceFilesTotal,
    identityEvidence: Type.Optional(
      Type.Array(
        Type.Object(
          { id: text(96), evidence: Type.Array(LeanEvidence, { maxItems: 20 }) },
          { additionalProperties: false },
        ),
        { maxItems: 10 },
      ),
    ),
    relatedStatements: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: text(96),
            revision: Type.Integer(),
            hash: Type.Optional(text(64)),
            relation: text(30),
            incoming: Type.Boolean(),
            basis: text(1000),
            text: Type.Optional(text(4000)),
            source: Type.Optional(Ref),
            assertionOrigin: Type.Optional(text(30)),
          },
          { additionalProperties: false },
        ),
        { maxItems: 100 },
      ),
    ),
    references: Type.Optional(Type.Array(Row, { maxItems: 100 })),
    referenceTotal: recordFields.referenceTotal,
    nextReferenceOffset: Type.Optional(Type.Integer()),
    links: recordFields.links,
    linksTruncated: recordFields.linksTruncated,
    omitted: recordFields.omitted,
  },
  { additionalProperties: false },
);
export type LeanRecordOutput = Static<typeof LeanRecordOutput>;

export const Via = Type.Object(
  { id: text(96), revision: Type.Integer() },
  { additionalProperties: false },
);
export const LeanHit = Type.Object(
  {
    id: text(96),
    title: Type.Optional(text(200)),
    kind: Type.Optional(text(30)),
    type: text(64),
    revision: Type.Integer(),
    hash: text(64),
    lifecycle: Type.Optional(text(20)),
    snippet: Type.Optional(text(COMPACT_SNIPPET_CHARS)),
    via: Type.Optional(Via),
  },
  { additionalProperties: false },
);
export type LeanHit = Static<typeof LeanHit>;
export const LeanSearchOutput = Type.Object(
  {
    hits: Type.Array(LeanHit, { maxItems: 50 }),
    resultCount: Type.Integer(),
    total: Type.Union([Type.Integer(), Type.Null()]),
    nextOffset: page.nextOffset,
    snapshot: page.snapshot,
    coverage: Incomplete,
    index: Type.Optional(
      Type.Object(
        { state: Type.Literal("unavailable"), message: text(500) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const LeanLookupOutput = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal("found"),
      Type.Literal("ambiguous"),
      Type.Literal("missing"),
    ]),
    hits: Type.Array(LeanHit, { maxItems: 50 }),
    resultCount: Type.Integer(),
    total: Type.Integer(),
    nextOffset: page.nextOffset,
    coverage: Incomplete,
    redirectedFrom: Type.Optional(text(96)),
  },
  { additionalProperties: false },
);

export const LeanChronicleItem = Type.Object(
  {
    date: text(40),
    id: text(96),
    title: Type.Optional(text(200)),
    type: text(64),
    revision: Type.Integer(),
    hash: text(64),
    summary: Type.Optional(text(1000)),
    claims: Type.Optional(Type.Integer({ minimum: 0 })),
    noteRecord: Type.Optional(text(96)),
    lifecycle: Type.Optional(text(20)),
    supersededBy: Type.Optional(text(96)),
  },
  { additionalProperties: false },
);
export const LeanChronicleOutput = Type.Object(
  {
    items: Type.Array(LeanChronicleItem, { maxItems: 100 }),
    ...page,
    coverage: Incomplete,
    sources: Type.Optional(Type.Array(PageRow, { maxItems: 100 })),
  },
  { additionalProperties: false },
);
export const LeanLastSeenOutput = Type.Object(
  {
    entity: text(96),
    last: Type.Union([LeanChronicleItem, Type.Null()]),
    message: Type.Optional(text(500)),
    sources: Type.Optional(Type.Array(PageRow, { maxItems: 100 })),
  },
  { additionalProperties: false },
);

export const LeanRecordsOutput = Type.Object(
  {
    records: Type.Array(Row, { maxItems: 100 }),
    endpoints: Type.Optional(Type.Array(PageRow, { maxItems: 200 })),
    total: Type.Integer(),
    nextOffset: page.nextOffset,
    facets: Type.Optional(
      Type.Object({
        kinds: Type.Record(Type.String(), Type.Integer()),
        origins: Type.Record(Type.String(), Type.Integer()),
      }),
    ),
  },
  { additionalProperties: false },
);

export const LeanDefinition = Type.Object(
  {
    name: text(64),
    kind: text(30),
    description: text(2000),
    aliases: Type.Optional(Type.Array(text(64), { maxItems: 100 })),
    directory: Type.Optional(text(100)),
    fields: Type.Optional(Type.Array(Field, { maxItems: 50 })),
    fromTypes: Type.Optional(Type.Array(text(200), { maxItems: 100 })),
    toTypes: Type.Optional(Type.Array(text(200), { maxItems: 100 })),
    pathPrefixes: Type.Optional(Type.Array(text(100), { maxItems: 100 })),
    behaviors: Definition.properties.behaviors,
    records: Type.Optional(Type.Array(PageRow, { maxItems: 20 })),
    recordsTruncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const LeanOntologyOutput = Type.Object(
  {
    fingerprint: text(64),
    available: Type.Optional(Type.Literal(false)),
    definitions: Type.Optional(Type.Array(LeanDefinition, { maxItems: 100 })),
    sources: Type.Optional(
      Type.Array(Type.Object({ path: text(500), valid: Type.Boolean(), name: text(64) }), {
        maxItems: 100,
      }),
    ),
    source: Type.Optional(
      Type.Object({ path: text(500), raw: text(65536), totalChars: Type.Integer() }),
    ),
    issues: Type.Optional(Type.Array(Issue, { maxItems: 100 })),
    chain: Type.Optional(Type.Array(text(110), { maxItems: 8 })),
    totalIssues: Type.Optional(Type.Integer()),
    total: Type.Integer(),
    nextOffset: page.nextOffset,
  },
  { additionalProperties: false },
);

export const LeanStatusOutput = Type.Object(
  {
    vault: text(80),
    agent: text(80),
    store: StoreState,
    scope: Type.Optional(text(80)),
    writesEnabled: Type.Boolean(),
    records: Type.Integer(),
    ontologyFingerprint: text(64),
    issues: Type.Optional(Type.Integer()),
    message: Type.Optional(text(300)),
  },
  { additionalProperties: false },
);

export const LeanVerifyOutput = Type.Object(
  {
    checked: Type.Integer(),
    passed: Type.Integer(),
    failed: Type.Integer(),
    problems: Type.Optional(
      Type.Array(Type.Object({ id: text(96), code: text(80), message: text(300) }), {
        maxItems: 50,
      }),
    ),
    totalProblems: Type.Optional(Type.Integer()),
    nextOffset: page.nextOffset,
    snapshot: page.snapshot,
    index: Type.Optional(Type.Literal("unavailable")),
  },
  { additionalProperties: false },
);

export const LeanEvidenceReadOutput = Type.Object(
  {
    text: text(3000),
    range: Type.Object({ startLine: Type.Integer(), endLine: Type.Integer() }),
    nextCursor: Type.Optional(text(2000)),
  },
  { additionalProperties: false },
);

export const LeanReceipt = Type.Object(
  {
    requestId: Type.Optional(Receipt.properties.requestId),
    id: text(96),
    revision: Type.Integer(),
    hash: text(64),
    state: Type.Optional(
      Type.Union([Type.Literal("accepted"), Type.Literal("conflict"), Type.Literal("rejected")]),
    ),
    message: Type.Optional(text(1000)),
    items: Type.Optional(
      Type.Array(
        Type.Object(
          { key: text(40), id: text(96), revision: Type.Integer(), hash: text(64) },
          { additionalProperties: false },
        ),
        { maxItems: 25 },
      ),
    ),
    impact: Type.Optional(
      Type.Object(
        {
          items: Type.Array(
            Type.Object(
              { id: text(96), title: text(200), kind: text(40), direct: Type.Boolean() },
              { additionalProperties: false },
            ),
            { maxItems: 500 },
          ),
          total: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    merge: Receipt.properties.merge,
    budget: Type.Optional(PageBudget),
    ontologyFingerprint: Receipt.properties.ontologyFingerprint,
    git: Receipt.properties.git,
  },
  {
    additionalProperties: false,
    description:
      "Agent write receipt: id, new revision and full hash, ontologyFingerprint for the next write, state and message only when not published, other changed items, impact and page budget when present. knowledge_mutation returns the complete receipt.",
  },
);
export type LeanReceipt = Static<typeof LeanReceipt>;

export const LeanRememberOutput = Type.Object(
  {
    items: Type.Array(RememberResult, { maxItems: 20 }),
    receipt: Type.Union([LeanReceipt, Type.Null()]),
  },
  { additionalProperties: false },
);

export const LeanSourceCheckOutput = Type.Object(
  {
    state: Type.Union([
      Type.Literal("missing"),
      Type.Literal("unchanged"),
      Type.Literal("changed"),
    ]),
    receipt: Type.Union([LeanReceipt, Type.Null()]),
    message: text(1000),
  },
  { additionalProperties: false },
);
