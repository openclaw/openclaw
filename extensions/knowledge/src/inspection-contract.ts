import { Type, type Static } from "typebox";
import { text, Evidence, Envelope, Field, Definition } from "./model.js";

const optionalBool = () => Type.Optional(Type.Boolean());
const offset = Type.Optional(Type.Integer({ minimum: 0 }));
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }));
const maxChars = Type.Optional(Type.Integer({ minimum: 256, maximum: 65536 }));
const nullableOffset = Type.Union([Type.Integer(), Type.Null()]);
export const Summary = Type.Object({
  id: text(96),
  title: text(200),
  kind: text(30),
  type: text(64),
  path: text(500),
  lifecycle: text(20),
  revision: Type.Integer(),
  valid: Type.Boolean(),
  writtenByAgentId: Type.Optional(text(64)),
  recordedAt: Type.Optional(text(40)),
  updatedAt: Type.Optional(text(40)),
  occurredAt: Type.Optional(text(40)),
  from: Envelope.properties.from,
  to: Envelope.properties.to,
  label: Envelope.properties.label,
  attributionConfidence: Type.Optional(
    Type.Object({
      level: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      basis: text(1000),
      evidence: Type.Optional(Type.Array(Evidence)),
    }),
  ),
  identityStatus: Type.Optional(text(20)),
  identityContext: Type.Optional(text(1000)),
  sourceEvent: Type.Optional(Type.Boolean()),
});
// Bounded card data, projected from the same authorized scan as the list.
// Evidence files and full metadata are deliberately loaded only on disclosure.
export const ClaimCard = Type.Object(
  {
    hash: text(64),
    body: text(4000),
    truncated: Type.Boolean(),
    evidenceTotal: Type.Integer(),
    evidenceSourceTotal: Type.Optional(Type.Integer()),
    about: Type.Optional(Type.Array(Summary, { maxItems: 2 })),
    owner: Type.Optional(Summary),
    source: Type.Optional(Summary),
    attribution: Type.Optional(text(1000)),
    assertionOrigin: Type.Optional(text(30)),
    claimKind: Type.Optional(text(30)),
    metadata: Type.Object(
      {
        entities: Envelope.properties.entities,
        owner: Envelope.properties.owner,
        due_at: Envelope.properties.due_at,
        occurred_at: Envelope.properties.occurred_at,
        source_event: Envelope.properties.source_event,
        supersedes: Envelope.properties.supersedes,
        continuity: Envelope.properties.continuity,
        attribution_confidence: Envelope.properties.attribution_confidence,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const CardSummary = Type.Object({ ...Summary.properties, card: Type.Optional(ClaimCard) });
const Issue = Type.Object({ path: text(500), code: text(80), message: text(1000) });
export const CompactMetadata = Type.Object(
  {
    owner: Envelope.properties.owner,
    due_at: Envelope.properties.due_at,
    occurred_at: Envelope.properties.occurred_at,
    source_page: Envelope.properties.source_page,
    source_event: Envelope.properties.source_event,
    entities: Envelope.properties.entities,
    dependencies: Envelope.properties.dependencies,
    from: Envelope.properties.from,
    to: Envelope.properties.to,
    label: Envelope.properties.label,
    attribution: Envelope.properties.attribution,
    assertion_origin: Envelope.properties.assertion_origin,
    claim_kind: Envelope.properties.claim_kind,
    aliases: Envelope.properties.aliases,
    fields: Envelope.properties.fields,
    updated_at: Type.Optional(Envelope.properties.updated_at),
    supersedes: Envelope.properties.supersedes,
    superseded_by: Envelope.properties.superseded_by,
    lifecycle_change: Envelope.properties.lifecycle_change,
    merged_into: Envelope.properties.merged_into,
    identity: Type.Optional(
      Type.Object({
        status: Type.Union([Type.Literal("partial"), Type.Literal("resolved")]),
        context: text(1000),
        candidates: Type.Optional(
          Type.Array(Type.Object({ id: text(96), basis: text(1000) }), { maxItems: 10 }),
        ),
      }),
    ),
    attribution_confidence: Type.Optional(
      Type.Object({
        level: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
        basis: text(1000),
      }),
    ),
  },
  { additionalProperties: false },
);
export type CompactMetadata = Static<typeof CompactMetadata>;
export const RecordInput = Type.Object(
  {
    id: text(96),
    view: Type.Optional(
      Type.Union([Type.Literal("content"), Type.Literal("summary"), Type.Literal("raw")]),
    ),
    offset,
    maxChars,
    metadataView: Type.Optional(
      Type.Union([Type.Literal("compact"), Type.Literal("full"), Type.Literal("none")], {
        description:
          "Default compact: structured associations, dates, aliases, domain fields and uncertainty without evidence. Full for complete frontmatter/provenance; none for text-only inspection. Do not combine with legacy includeMetadata.",
      }),
    ),
    includeMetadata: Type.Optional(
      Type.Boolean({
        description:
          "Legacy full/none metadata selector. Omit for compact defaults; do not combine with metadataView.",
      }),
    ),
    includeEvidence: Type.Optional(
      Type.Boolean({
        description:
          "Default false. Request verified evidence locators/excerpts and supporting previews for provenance review; use evidence pagination for completeness.",
      }),
    ),
    includeReferences: Type.Optional(
      Type.Boolean({
        description:
          "Default false. Request connected record summaries; follow nextReferenceOffset.",
      }),
    ),
    referenceOffset: offset,
    referenceLimit: limit,
    evidenceOffset: offset,
    evidenceLimit: limit,
    maxEvidenceChars: Type.Optional(Type.Integer({ minimum: 0, maximum: 20000 })),
  },
  { additionalProperties: false },
);
export type RecordInput = Static<typeof RecordInput>;
const InspectedEvidence = Type.Object({
  ...Evidence.properties,
  excerpt: text(20000),
  verified: Type.Boolean(),
  excerptTruncated: Type.Boolean(),
});
export const RecordOutput = Type.Object(
  {
    view: Type.Union([Type.Literal("content"), Type.Literal("summary"), Type.Literal("raw")]),
    record: Type.Union([
      Type.Intersect([
        Summary,
        Type.Object({
          hash: text(64),
          body: Type.Optional(text(65536)),
          raw: Type.Optional(text(65536)),
          metadata: Type.Optional(
            Type.Object({
              ...Type.Partial(Envelope).properties,
              identity: Type.Optional(
                Type.Object({
                  status: Type.Union([Type.Literal("partial"), Type.Literal("resolved")]),
                  context: text(1000),
                  candidates: Type.Optional(
                    Type.Array(
                      Type.Object({
                        id: text(96),
                        basis: text(1000),
                        evidence: Type.Optional(Type.Array(Evidence)),
                      }),
                    ),
                  ),
                }),
              ),
              attribution_confidence: Type.Optional(
                Type.Object({
                  level: Type.Union([
                    Type.Literal("high"),
                    Type.Literal("medium"),
                    Type.Literal("low"),
                  ]),
                  basis: text(1000),
                  evidence: Type.Optional(Type.Array(Evidence)),
                }),
              ),
            }),
          ),
          attribution: Type.Optional(text(1000)),
          assertionOrigin: Type.Optional(text(30)),
          claimKind: Type.Optional(text(30)),
          owner: Type.Optional(Summary),
          source: Type.Optional(Summary),
          about: Type.Optional(Type.Array(Summary, { maxItems: 2 })),
        }),
      ]),
      Type.Null(),
    ]),
    content: Type.Object({
      offset: Type.Integer(),
      totalChars: Type.Integer(),
      nextOffset: nullableOffset,
    }),
    issues: Type.Array(Issue, { maxItems: 1000 }),
    omitted: Type.Optional(Type.Array(text(80), { maxItems: 10 })),
    sourceFiles: Type.Optional(
      Type.Array(Type.Object({ evidence: InspectedEvidence, citations: Type.Integer() }), {
        maxItems: 100,
      }),
    ),
    sourceFilesTotal: Type.Optional(Type.Integer()),
    identityEvidence: Type.Optional(
      Type.Array(
        Type.Object({ id: text(96), evidence: Type.Array(InspectedEvidence, { maxItems: 20 }) }),
        { maxItems: 10 },
      ),
    ),
    relatedStatements: Type.Optional(
      Type.Array(
        Type.Object({
          record: Summary,
          text: Type.Optional(text(4000)),
          attribution: Type.Optional(text(1000)),
          assertionOrigin: Type.Optional(text(30)),
          relation: text(30),
          incoming: Type.Boolean(),
          basis: text(1000),
          source: Type.Optional(Summary),
        }),
        { maxItems: 100 },
      ),
    ),
    references: Type.Optional(Type.Array(Summary, { maxItems: 100 })),
    referenceTotal: Type.Optional(Type.Integer()),
    nextReferenceOffset: Type.Optional(nullableOffset),
    evidence: Type.Optional(Type.Array(InspectedEvidence, { maxItems: 100 })),
    links: Type.Optional(
      Type.Array(
        Type.Object({
          href: text(200000),
          status: Type.Union([
            Type.Literal("resolved"),
            Type.Literal("missing"),
            Type.Literal("ambiguous"),
          ]),
          id: Type.Optional(text(96)),
        }),
        { maxItems: 1000 },
      ),
    ),
    linksTruncated: Type.Optional(Type.Boolean()),
    mergedInto: Type.Optional(Summary),
    mergedFrom: Type.Optional(
      Type.Array(Summary, {
        maxItems: 100,
        description: "Pages merged into this one. Their IDs resolve here.",
      }),
    ),
    redirects: Type.Optional(
      Type.Array(Type.Object({ from: text(96), to: text(96) }, { additionalProperties: false }), {
        maxItems: 100,
        description: "Authored references to merged pages and the current pages they resolve to.",
      }),
    ),
    evidenceTotal: Type.Optional(Type.Integer()),
    evidenceSourceTotal: Type.Optional(Type.Integer()),
    nextEvidenceOffset: Type.Optional(nullableOffset),
  },
  { additionalProperties: false },
);
export type RecordOutput = Static<typeof RecordOutput>;

export const OntologyInput = Type.Object(
  {
    view: Type.Optional(
      Type.Union([
        Type.Literal("catalog"),
        Type.Literal("definitions"),
        Type.Literal("sources"),
        Type.Literal("diagnostics"),
      ]),
    ),
    name: Type.Optional(text(64)),
    kind: Type.Optional(Type.Union([Type.Literal("page"), Type.Literal("relationship")])),
    offset,
    limit,
    includeRecords: optionalBool(),
    sourcePath: Type.Optional(text(500)),
    maxChars,
  },
  { additionalProperties: false },
);
export type OntologyInput = Static<typeof OntologyInput>;
export const OntologyOutput = Type.Object(
  {
    view: Type.Union([
      Type.Literal("catalog"),
      Type.Literal("definitions"),
      Type.Literal("sources"),
      Type.Literal("diagnostics"),
    ]),
    available: Type.Boolean(),
    name: text(64),
    version: text(40),
    fingerprint: text(64),
    total: Type.Integer(),
    offset: Type.Integer(),
    nextOffset: nullableOffset,
    definitions: Type.Optional(
      Type.Array(
        Type.Object({
          name: text(64),
          label: text(200),
          kind: text(30),
          primitive: text(20),
          description: text(2000),
          aliases: Type.Array(text(64), { maxItems: 100 }),
          recordCount: Type.Integer(),
          directory: Type.Optional(text(100)),
          fields: Type.Optional(Type.Array(Field, { maxItems: 50 })),
          fromTypes: Type.Optional(Type.Array(text(200), { maxItems: 100 })),
          toTypes: Type.Optional(Type.Array(text(200), { maxItems: 100 })),
          pathPrefixes: Type.Optional(Type.Array(text(100), { maxItems: 100 })),
          behaviors: Definition.properties.behaviors,
          source: Type.Optional(text(500)),
          ontology: Type.Optional(text(64)),
          version: Type.Optional(text(40)),
          records: Type.Optional(Type.Array(Summary, { maxItems: 20 })),
          recordsTruncated: Type.Optional(Type.Boolean()),
        }),
        { maxItems: 100 },
      ),
    ),
    sources: Type.Optional(
      Type.Array(
        Type.Object({
          path: text(500),
          valid: Type.Boolean(),
          name: text(64),
          version: text(40),
          totalChars: Type.Integer(),
        }),
        { maxItems: 100 },
      ),
    ),
    source: Type.Optional(
      Type.Object({ path: text(500), raw: text(65536), totalChars: Type.Integer() }),
    ),
    chain: Type.Optional(Type.Array(text(110), { maxItems: 8 })),
    issues: Type.Optional(Type.Array(Issue, { maxItems: 100 })),
    totalIssues: Type.Integer(),
  },
  { additionalProperties: false },
);
export type OntologyOutput = Static<typeof OntologyOutput>;
