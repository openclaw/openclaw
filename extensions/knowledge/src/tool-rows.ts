import { Type, type Static } from "typebox";
import { HASH_PREFIX_CHARS, hashPrefix } from "./hash-fence.js";
import type { CardSummary, Summary } from "./inspection-contract.js";
import { text } from "./model.js";

// Agent-facing list rows: what an agent needs to recognize a record and fence a
// write to it, nothing more. Every tool that lists records uses these rows.
const hash = Type.String({ maxLength: HASH_PREFIX_CHARS });
const lifecycle = Type.Optional(text(20));
// Uncertainty an agent must not paper over stays visible in rows.
const identity = Type.Optional(Type.Literal("partial"));
const attributionConfidence = Type.Optional(
  Type.Union([Type.Literal("low"), Type.Literal("medium")]),
);
export const Ref = Type.Object(
  { id: text(96), title: Type.Optional(text(200)) },
  { additionalProperties: false },
);
export type Ref = Static<typeof Ref>;
export const PageRow = Type.Object(
  {
    id: text(96),
    title: text(200),
    type: text(64),
    revision: Type.Integer(),
    hash: Type.Optional(hash),
    lifecycle,
    identity,
  },
  { additionalProperties: false },
);
export type PageRow = Static<typeof PageRow>;
export const ClaimRow = Type.Object(
  {
    id: text(96),
    revision: Type.Integer(),
    hash: Type.Optional(hash),
    claimKind: text(30),
    date: Type.Optional(text(10)),
    text: text(4000),
    about: Type.Optional(Type.Array(text(200), { maxItems: 2 })),
    source: Type.Optional(Ref),
    lifecycle,
    assertionOrigin: Type.Optional(text(30)),
    attributionConfidence,
    supersededBy: Type.Optional(text(96)),
  },
  { additionalProperties: false },
);
export const RelationshipRow = Type.Object(
  {
    id: text(96),
    title: text(200),
    type: text(64),
    from: text(96),
    to: text(96),
    revision: Type.Integer(),
    hash: Type.Optional(hash),
    lifecycle,
    attributionConfidence,
  },
  { additionalProperties: false },
);
export const Row = Type.Union([ClaimRow, RelationshipRow, PageRow]);
export type Row = Static<typeof Row>;

/** Remove authored HTML comments (project tags and similar) from agent-facing text. */
export const stripComments = (value: string) => value.replace(/\s*<!--[\s\S]*?-->/gu, "").trim();

/** Calendar day of a row: occurrence, else when Knowledge recorded it. */
export const rowDate = (s: { occurredAt?: string; recordedAt?: string }) =>
  (s.occurredAt ?? s.recordedAt)?.slice(0, 10);

/** Lifecycle appears only when a record is not active. */
export const inactive = (value: string) => (value === "active" ? {} : { lifecycle: value });
const prefix = (value?: string) => (value ? { hash: hashPrefix(value) } : {});
const confidence = (s: Static<typeof Summary>) =>
  s.attributionConfidence && s.attributionConfidence.level !== "high"
    ? { attributionConfidence: s.attributionConfidence.level }
    : {};

export function pageRow(s: Static<typeof Summary>): PageRow {
  return {
    id: s.id,
    title: s.title,
    type: s.type,
    revision: s.revision,
    ...prefix(s.hash),
    ...inactive(s.lifecycle),
    ...(s.identityStatus === "partial" ? { identity: "partial" as const } : {}),
  };
}

/**
 * One row per record. Claims carry their text (from a card when the scan
 * provided one, else the title Knowledge derived from it); pages and
 * relationships carry their identity only.
 */
export function summaryRow(s: Static<typeof CardSummary>, supersededBy?: string): Row {
  if (s.kind === "claim") {
    const card = s.card,
      date = rowDate(s);
    return {
      id: s.id,
      revision: s.revision,
      ...prefix(card?.hash ?? s.hash),
      claimKind: card?.claimKind ?? s.type,
      ...(date ? { date } : {}),
      text: stripComments(card?.body ?? s.title),
      ...(card?.about?.length ? { about: card.about.map((a) => a.title) } : {}),
      ...(card?.source ? { source: { id: card.source.id, title: card.source.title } } : {}),
      ...inactive(s.lifecycle),
      ...(card?.assertionOrigin && card.assertionOrigin !== "source"
        ? { assertionOrigin: card.assertionOrigin }
        : {}),
      ...confidence(s),
      ...(supersededBy ? { supersededBy } : {}),
    };
  }
  if (s.kind === "relationship" && s.from && s.to) {
    const { identity: _identity, ...row } = pageRow(s);
    return { ...row, from: s.from, to: s.to, ...confidence(s) };
  }
  return pageRow(s);
}
