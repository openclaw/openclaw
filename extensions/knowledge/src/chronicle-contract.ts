import { Type, type Static } from "typebox";
import { text } from "./model.js";
import { QueryFreshness } from "./query-freshness.js";

const TimeField = Type.Union([
  Type.Literal("occurred_at"),
  Type.Literal("recorded_at"),
  Type.Literal("updated_at"),
  Type.Literal("due_at"),
]);
export const TemporalFilters = {
  timeField: Type.Optional(TimeField),
  since: Type.Optional(
    Type.String({
      minLength: 10,
      maxLength: 40,
      description:
        "Inclusive lower date/time. YYYY-MM-DD or ISO timestamp with explicit timezone. Default timeField is occurred_at; no ingestion-time fallback.",
    }),
  ),
  until: Type.Optional(
    Type.String({
      minLength: 10,
      maxLength: 40,
      description:
        "Inclusive upper date/time; a date includes its whole UTC day. Date-only records match overlapping query days, without asserting an exact time.",
    }),
  ),
};
const paging = {
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  snapshot: Type.Optional(text(64)),
};
const Eligibility = Type.Union([Type.Literal("current"), Type.Literal("include_inactive")], {
  description:
    "Default current. include_inactive includes superseded/expired assertions, never withdrawn. Does not reconstruct past vault state.",
});
const common = {
  ...paging,
  entity: Type.Optional(text(96)),
  kind: Type.Optional(text(64)),
  eligibility: Type.Optional(Eligibility),
  includeSources: Type.Optional(Type.Boolean()),
};
export const TimelineInput = Type.Object(
  {
    ...common,
    ...TemporalFilters,
    order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
  },
  { additionalProperties: false },
);
export type TimelineInput = Static<typeof TimelineInput>;
export const DayInput = Type.Object(
  {
    ...common,
    date: Type.String({ minLength: 10, maxLength: 10 }),
    week: Type.Optional(Type.Boolean()),
    timezone: Type.Optional(text(100)),
  },
  { additionalProperties: false },
);
export type DayInput = Static<typeof DayInput>;
export const SinceInput = Type.Object(
  { ...common, since: Type.String({ minLength: 10, maxLength: 40 }), until: TemporalFilters.until },
  { additionalProperties: false },
);
export type SinceInput = Static<typeof SinceInput>;
export const LastSeenInput = Type.Object(
  {
    entity: text(96),
    occurredOnOrBefore: Type.Optional(text(40)),
    eligibility: common.eligibility,
    includeSources: common.includeSources,
  },
  { additionalProperties: false },
);
export type LastSeenInput = Static<typeof LastSeenInput>;
const TemporalReference = Type.Object({
  id: text(96),
  title: text(200),
  path: text(500),
  kind: text(30),
  type: text(64),
  revision: Type.Integer(),
  hash: text(64),
  lifecycle: text(20),
  supersededBy: Type.Optional(text(96)),
  expiresAt: Type.Optional(text(40)),
});
const ChronicleItem = Type.Object({
  record: TemporalReference,
  date: text(40),
  dateField: TimeField,
  precision: Type.Union([Type.Literal("day"), Type.Literal("instant")]),
  summary: text(1000),
  entities: Type.Array(text(96), { maxItems: 100 }),
  sourcePage: Type.Optional(text(96)),
  evidenceCount: Type.Integer(),
});
export const ChronicleOutput = Type.Object({
  items: Type.Array(ChronicleItem, { maxItems: 100 }),
  total: Type.Integer(),
  offset: Type.Integer(),
  nextOffset: Type.Union([Type.Integer(), Type.Null()]),
  snapshot: text(64),
  freshness: QueryFreshness,
  sources: Type.Optional(Type.Array(TemporalReference, { maxItems: 100 })),
  coverage: Type.Object({ complete: Type.Boolean(), message: text(1500) }),
});
export type ChronicleOutput = Static<typeof ChronicleOutput>;
export const LastSeenOutput = Type.Object({
  entity: text(96),
  selection: Type.Object({
    timeField: Type.Literal("occurred_at"),
    onOrBefore: text(40),
    eligibility: Eligibility,
  }),
  last: Type.Union([ChronicleItem, Type.Null()]),
  message: text(500),
  snapshot: text(64),
  freshness: QueryFreshness,
  sources: Type.Optional(Type.Array(TemporalReference, { maxItems: 100 })),
});
