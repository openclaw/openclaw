import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const text = (max = 200) => Type.String({ maxLength: max });
export const name = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" });
export const id = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$" });
const timestamp = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
});
export const strings = Type.Array(text(), { maxItems: 100 });
export const Recall = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: 500, pattern: "^(?=.*\\S)[\\s\\S]+$" }),
    triggers: Type.Optional(
      Type.Array(
        Type.String({ minLength: 1, maxLength: 100, pattern: "^(?=.*\\S)[^\\r\\n;|]+$" }),
        { maxItems: 20 },
      ),
    ),
    importance: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    projects: Type.Optional(
      Type.Array(
        Type.String({ minLength: 1, maxLength: 500, pattern: "^(?=.*\\S)[^\\r\\n<>]+$" }),
        { maxItems: 20 },
      ),
    ),
    approved_by: Type.Literal("owner-private"),
    approved_at: timestamp,
  },
  { additionalProperties: false },
);
export type Recall = Static<typeof Recall>;

/** Returns only complete service-issued recall approvals. Invalid authored blocks fail closed. */
export function approvedRecall(value: unknown): Recall | undefined {
  if (!Check(Recall, value)) {
    return undefined;
  }
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value.approved_at);
  const parsed = new Date(value.approved_at);
  if (!parts || !Number.isFinite(parsed.getTime())) {
    return undefined;
  }
  const observed = [
    parsed.getUTCFullYear(),
    parsed.getUTCMonth() + 1,
    parsed.getUTCDate(),
    parsed.getUTCHours(),
    parsed.getUTCMinutes(),
    parsed.getUTCSeconds(),
  ];
  return observed.every((part, index) => part === Number(parts[index + 1])) ? value : undefined;
}
export const Evidence = Type.Object(
  {
    // Resolved citations retain origin identity across reads, edits and serialization.
    source: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    path: text(500),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    start_line: Type.Optional(Type.Integer({ minimum: 1 })),
    end_line: Type.Optional(Type.Integer({ minimum: 1 })),
    filename: Type.Optional(text(200)),
    mediaType: Type.Optional(text(200)),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    attribution: Type.Optional(text(1000)),
    quote: Type.Optional(text(4000)),
  },
  { additionalProperties: false },
);
export type Evidence = Static<typeof Evidence>;
const supportedBasis = {
  basis: Type.String({ minLength: 1, maxLength: 1000 }),
  evidence: Type.Array(Evidence, { minItems: 1, maxItems: 20 }),
};
export const RecordAnnotations = Type.Object(
  {
    record_class: Type.Optional(Type.Union([Type.Literal("production"), Type.Literal("fixture")])),
    source_page: Type.Optional(id),
    source_event: Type.Optional(Type.Boolean()),
    identity: Type.Optional(
      Type.Object(
        {
          status: Type.Union([Type.Literal("partial"), Type.Literal("resolved")]),
          context: text(1000),
          candidates: Type.Optional(
            Type.Array(Type.Object({ id, ...supportedBasis }, { additionalProperties: false }), {
              maxItems: 10,
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    attribution_confidence: Type.Optional(
      Type.Object(
        {
          level: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
          ...supportedBasis,
        },
        { additionalProperties: false },
      ),
    ),
    continuity: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id,
            relation: Type.Union([
              Type.Literal("reaffirms"),
              Type.Literal("updates"),
              Type.Literal("contradicts"),
            ]),
            ...supportedBasis,
          },
          { additionalProperties: false },
        ),
        { maxItems: 50 },
      ),
    ),
  },
  { additionalProperties: false },
);
export const Scope = Type.Union([
  Type.Object({ visibility: Type.Literal("sample") }, { additionalProperties: false }),
  // Store-owned partitions: the store's private knowledge, or one trusted
  // conversation's knowledge. Writers are recorded in history, not here.
  Type.Object({ visibility: Type.Literal("private") }, { additionalProperties: false }),
  Type.Object(
    {
      visibility: Type.Literal("conversation"),
      sessionId: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
    },
    { additionalProperties: false },
  ),
]);
export type Scope = Static<typeof Scope>;
/** What one identity merge added to its surviving page, so an unmerge can remove exactly that. */
export const MergedFrom = Type.Object(
  {
    id,
    request_id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
    at: timestamp,
    added: Type.Object(
      {
        aliases: strings,
        tags: strings,
        fields: strings,
        evidence: Type.Array(
          Type.Object(
            {
              path: text(500),
              sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
              start_line: Type.Optional(Type.Integer({ minimum: 1 })),
              end_line: Type.Optional(Type.Integer({ minimum: 1 })),
            },
            { additionalProperties: false },
          ),
          { maxItems: 1000 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type MergedFrom = Static<typeof MergedFrom>;
export const Envelope = Type.Object(
  {
    ...RecordAnnotations.properties,
    format: Type.Literal("knowledge-record-v1"),
    id,
    revision: Type.Integer({ minimum: 1 }),
    kind: Type.Union([Type.Literal("page"), Type.Literal("claim"), Type.Literal("relationship")]),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    scope: Scope,
    recorded_at: timestamp,
    updated_at: timestamp,
    lifecycle: Type.Union([
      Type.Literal("active"),
      Type.Literal("superseded"),
      Type.Literal("withdrawn"),
      Type.Literal("merged"),
    ]),
    supersedes: Type.Optional(id),
    superseded_by: Type.Optional(id),
    merged_into: Type.Optional(id),
    merged_from: Type.Optional(Type.Array(MergedFrom, { maxItems: 100 })),
    lifecycle_change: Type.Optional(
      Type.Object(
        {
          reason: Type.String({ minLength: 1, maxLength: 2000 }),
          at: timestamp,
          actor: text(100),
          request_id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
        },
        { additionalProperties: false },
      ),
    ),
    aliases: Type.Optional(strings),
    tags: Type.Optional(strings),
    type: Type.Optional(name),
    fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    claim_kind: Type.Optional(
      Type.Union([
        Type.Literal("fact"),
        Type.Literal("preference"),
        Type.Literal("decision"),
        Type.Literal("commitment"),
        Type.Literal("event"),
        Type.Literal("belief"),
      ]),
    ),
    assertion_origin: Type.Optional(
      Type.Union([
        Type.Literal("source"),
        Type.Literal("user_belief"),
        Type.Literal("agent_inference"),
      ]),
    ),
    occurred_at: Type.Optional(
      Type.String({
        pattern:
          "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2}))?$",
      }),
    ),
    valid_from: Type.Optional(timestamp),
    valid_until: Type.Optional(timestamp),
    expires_at: Type.Optional(timestamp),
    owner: Type.Optional(id),
    due_at: Type.Optional(Type.String({ maxLength: 40 })),
    attribution: Type.Optional(text(1000)),
    entities: Type.Optional(Type.Array(id, { maxItems: 100 })),
    /** Saver's free-text description of a claim's subject; maintenance uses it to link the claim. */
    subject_hint: Type.Optional(text(200)),
    // Preserve malformed authored blocks for diagnostics while automatic recall validates separately.
    recall: Type.Optional(Type.Unknown()),
    from: Type.Optional(id),
    to: Type.Optional(id),
    label: Type.Optional(name),
    evidence: Type.Optional(Type.Array(Evidence)),
    dependencies: Type.Optional(Type.Array(id, { maxItems: 100 })),
  },
  { additionalProperties: true },
);
export type Envelope = Static<typeof Envelope>;

export const Field = Type.Object(
  {
    name,
    label: text(),
    type: Type.Union([
      Type.Literal("string"),
      Type.Literal("number"),
      Type.Literal("boolean"),
      Type.Literal("string[]"),
    ]),
    required: Type.Optional(Type.Boolean()),
    values: Type.Optional(strings),
  },
  { additionalProperties: false },
);
export const Definition = Type.Object(
  {
    name,
    label: text(),
    description: text(2000),
    kind: Type.Union([Type.Literal("page"), Type.Literal("relationship")]),
    directory: Type.String({ maxLength: 100, pattern: "^(?:[a-z][a-z0-9_-]*/)+$" }),
    fields: Type.Array(Field, { maxItems: 50 }),
    primitive: Type.Optional(
      Type.Union([
        Type.Literal("entity"),
        Type.Literal("media"),
        Type.Literal("temporal"),
        Type.Literal("annotation"),
        Type.Literal("concept"),
      ]),
    ),
    aliases: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 100 }),
    ),
    path_prefixes: Type.Optional(
      Type.Array(Type.String({ maxLength: 100, pattern: "^(?:[a-z][a-z0-9_-]*/)+$" }), {
        maxItems: 100,
      }),
    ),
    behaviors: Type.Optional(
      Type.Object(
        { extractable: Type.Boolean(), expert_routing: Type.Boolean() },
        { additionalProperties: false },
      ),
    ),
    from_types: Type.Optional(strings),
    to_types: Type.Optional(strings),
  },
  { additionalProperties: false },
);
export type Definition = Static<typeof Definition>;
export type Issue = { path: string; code: string; message: string };
type RecordSummary = {
  id: string;
  title: string;
  kind: string;
  type: string;
  path: string;
  lifecycle: string;
  revision: number;
  valid: boolean;
  writtenByAgentId?: string;
};
/** `redirected` maps authored references to merged pages onto their survivors (current reads only). */
export type LoadedRecord = RecordSummary & {
  metadata: Envelope;
  body: string;
  raw: string;
  hash: string;
  redirected?: Record<string, string>;
};
