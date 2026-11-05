import { Type } from "typebox";
import { CardSummary, Summary } from "./inspection-contract.js";
import { Evidence, text } from "./model.js";
const CompactSummary = Type.Object({
  ...Type.Pick(Summary, ["id", "title", "kind", "type", "identityStatus", "identityContext"])
    .properties,
  attributionConfidence: Type.Optional(
    Type.Object({
      level: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      basis: text(1000),
    }),
  ),
});
const ConnectionRecord = Type.Union([CardSummary, CompactSummary]);
export const ConnectionsInput = Type.Object(
  {
    id: text(96),
    view: Type.Optional(
      Type.Union([Type.Literal("compact"), Type.Literal("full")], {
        description:
          "Default compact: identities and uncertainty only. Full adds record metadata and evidence previews; use for provenance inspection or rich cards.",
      }),
    ),
    includeCards: Type.Optional(Type.Boolean()),
    includeEndpoints: Type.Optional(Type.Boolean()),
    historical: Type.Optional(Type.Boolean()),
    direction: Type.Optional(
      Type.Union([
        Type.Literal("incoming"),
        Type.Literal("outgoing"),
        Type.Literal("dependents"),
        Type.Literal("claims"),
        Type.Literal("backlinks"),
        Type.Literal("links"),
      ]),
    ),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export const ConnectionsOutput = Type.Object(
  {
    endpoints: Type.Optional(Type.Array(Type.Union([Summary, CompactSummary]), { maxItems: 200 })),
    total: Type.Integer(),
    nextOffset: Type.Union([Type.Integer(), Type.Null()]),
    snapshot: text(64),
    redirectedFrom: Type.Optional(
      Type.String({
        maxLength: 96,
        description:
          "The requested ID belongs to a page merged into the page these connections describe.",
      }),
    ),
    connections: Type.Array(
      Type.Object({
        direction: Type.Union([
          Type.Literal("incoming"),
          Type.Literal("outgoing"),
          Type.Literal("dependents"),
          Type.Literal("claims"),
          Type.Literal("backlinks"),
          Type.Literal("links"),
        ]),
        record: ConnectionRecord,
        from: Type.Optional(text(96)),
        to: Type.Optional(text(96)),
        label: Type.Optional(text(64)),
        evidence: Type.Optional(Type.Array(Evidence, { maxItems: 3 })),
        evidenceTruncated: Type.Optional(Type.Boolean()),
      }),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);
