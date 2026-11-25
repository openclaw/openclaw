import { Type, type Static } from "typebox";
import { Summary, CardSummary } from "./inspection-contract.js";
import { text } from "./model.js";

const sequence = Type.Integer({ minimum: 0 });
export const RecentInput = Type.Object(
  {
    groupBySource: Type.Optional(Type.Boolean()),
    includeEndpoints: Type.Optional(Type.Boolean()),
    sourceId: Type.Optional(text(96)),
    recordOffset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    upperSequence: Type.Optional(sequence),
    beforeSequence: Type.Optional(sequence),
  },
  { additionalProperties: false },
);
export const RecentOutput = Type.Object(
  {
    upperSequence: sequence,
    nextBefore: Type.Union([sequence, Type.Null()]),
    items: Type.Array(
      Type.Object(
        {
          group: Type.Optional(
            Type.Object({
              source: Summary,
              total: Type.Integer(),
              counts: Type.Record(Type.String(), Type.Integer()),
              records: Type.Array(
                Type.Object({ ...CardSummary.properties, change: Type.Optional(text(20)) }),
                { maxItems: 20 },
              ),
              endpoints: Type.Optional(Type.Array(Summary, { maxItems: 40 })),
              truncated: Type.Boolean(),
              nextRecordOffset: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
              firstSaved: Type.Optional(text(40)),
              lastSaved: Type.Optional(text(40)),
            }),
          ),
          sequence,
          id: text(96),
          at: text(40),
          kind: text(40),
          type: text(64),
          change: Type.Union([
            Type.Literal("created"),
            Type.Literal("updated"),
            Type.Literal("observed"),
            Type.Literal("external"),
            Type.Literal("corrected"),
            Type.Literal("withdrawn"),
          ]),
          title: Type.Optional(text(200)),
          identityStatus: Type.Optional(text(20)),
          reason: Type.Optional(text(2000)),
          replacementId: Type.Optional(text(96)),
          replacementActive: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
  },
  { additionalProperties: false },
);
/** One Recent activity entry. */
export type RecentItem = Static<typeof RecentOutput>["items"][number];
