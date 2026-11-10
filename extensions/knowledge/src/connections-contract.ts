import { Type } from "typebox";
import { CardSummary, Summary } from "./inspection-contract.js";
import { Evidence, text } from "./model.js";
import { ClaimRow, PageRow, RelationshipRow } from "./tool-rows.js";

const Direction = Type.Union([
  Type.Literal("incoming"),
  Type.Literal("outgoing"),
  Type.Literal("dependents"),
  Type.Literal("claims"),
  Type.Literal("backlinks"),
  Type.Literal("links"),
]);
export const ConnectionsInput = Type.Object(
  {
    id: text(96),
    view: Type.Optional(
      Type.Union([Type.Literal("compact"), Type.Literal("full")], {
        description:
          "Default compact: one row per connection with direction, id, revision and 16-character hash; claims add kind, date, text, linked page titles and source; relationships add from/to. Full returns complete record summaries, evidence previews and (with includeCards) claim cards.",
      }),
    ),
    includeCards: Type.Optional(Type.Boolean()),
    includeEndpoints: Type.Optional(Type.Boolean()),
    historical: Type.Optional(Type.Boolean()),
    direction: Type.Optional(Direction),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
const FullConnection = Type.Object({
  direction: Direction,
  record: CardSummary,
  from: Type.Optional(text(96)),
  to: Type.Optional(text(96)),
  label: Type.Optional(text(64)),
  evidence: Type.Optional(Type.Array(Evidence, { maxItems: 3 })),
  evidenceTruncated: Type.Optional(Type.Boolean()),
});
const directed = <T extends typeof ClaimRow | typeof RelationshipRow | typeof PageRow>(row: T) =>
  Type.Object({ direction: Direction, ...row.properties }, { additionalProperties: false });
export const ConnectionsOutput = Type.Object(
  {
    endpoints: Type.Optional(Type.Array(Type.Union([Summary, PageRow]), { maxItems: 200 })),
    total: Type.Integer(),
    nextOffset: Type.Union([Type.Integer(), Type.Null()]),
    snapshot: Type.Optional(text(64)),
    redirectedFrom: Type.Optional(
      Type.String({
        maxLength: 96,
        description:
          "The requested ID belongs to a page merged into the page these connections describe.",
      }),
    ),
    connections: Type.Array(
      Type.Union([
        FullConnection,
        directed(ClaimRow),
        directed(RelationshipRow),
        directed(PageRow),
      ]),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);
