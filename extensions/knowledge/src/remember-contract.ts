import { Type, type Static } from "typebox";
import { text, id, Envelope } from "./model.js";
import { requestId, Receipt } from "./mutation-contract.js";

/** Largest conversation excerpt one remember call retains; one attachment chunk. */
export const REMEMBER_EXCERPT_MAX_BYTES = 16 * 1024;
/** Most claims one remember call may save. */
const REMEMBER_ITEMS_MAX = 20;

export const RememberItem = Type.Object(
  {
    text: Type.String({
      minLength: 1,
      maxLength: 500,
      description:
        "One claim in plain words; becomes the claim body (titles longer than 200 characters are shortened).",
    }),
    kind: Type.Required(Type.Pick(Envelope, ["claim_kind"])).properties.claim_kind,
    subject: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          "Exact page ID, title or alias of what the claim is about. A unique match links the claim; otherwise it is saved unlinked. Omit it to infer the subject from a name in the text. Never creates a page.",
      }),
    ),
    about: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          'What the claim is about, in your own words from context (e.g. "bundled plugin hot reload, PR #180466"); no lookup needed. Stored with the claim and used to link it now or by later maintenance.',
      }),
    ),
    infer_subject: Type.Optional(
      Type.Boolean({
        description:
          "Default true. When subject is omitted, link the claim to the one entity page its text names by exact title or alias, if no other name competes. False saves it unlinked.",
      }),
    ),
    origin: Type.Optional(
      Type.Union([Type.Literal("source"), Type.Literal("user_belief")], {
        description:
          "Default source: stated in the excerpt. user_belief: the user's own belief. Agent inference is not remembered.",
      }),
    ),
    occurred_at: Envelope.properties.occurred_at,
    due_at: Envelope.properties.due_at,
    valid_from: Envelope.properties.valid_from,
    expires_at: Envelope.properties.expires_at,
  },
  { additionalProperties: false },
);
export type RememberItem = Static<typeof RememberItem>;

export const RememberInput = Type.Object(
  {
    requestId: Type.Optional(
      Type.String({
        ...requestId,
        description:
          "Generate a lowercase UUID per call. Omit only during a host pre-compaction memory flush.",
      }),
    ),
    expectedVaultId: Type.Optional(requestId),
    attribution: Type.String({
      minLength: 1,
      maxLength: 1000,
      description:
        'Short provenance: who said it, where and when, e.g. "user in openclaw session 8f3a, 2026-10-19".',
    }),
    excerpt: Type.String({
      minLength: 1,
      maxLength: REMEMBER_EXCERPT_MAX_BYTES,
      description:
        "The actual conversation text supporting these claims, retained as their evidence. An excerpt, not a transcript; never paraphrase or invent.",
    }),
    items: Type.Array(RememberItem, { minItems: 1, maxItems: REMEMBER_ITEMS_MAX }),
  },
  { additionalProperties: false },
);
export type RememberInput = Static<typeof RememberInput>;

export const RememberResult = Type.Object(
  {
    status: Type.Union([Type.Literal("inserted"), Type.Literal("duplicate")]),
    id,
    subject: Type.Union([
      Type.Literal("attached"),
      Type.Literal("inferred"),
      Type.Literal("ambiguous"),
      Type.Literal("missing"),
      Type.Literal("none"),
    ]),
    subjectId: Type.Optional(id),
    candidates: Type.Optional(
      Type.Array(Type.Object({ id, title: text(200) }, { additionalProperties: false }), {
        maxItems: 10,
      }),
    ),
  },
  { additionalProperties: false },
);
export type RememberResult = Static<typeof RememberResult>;

export const RememberOutput = Type.Object(
  {
    items: Type.Array(RememberResult, { maxItems: REMEMBER_ITEMS_MAX }),
    receipt: Type.Union([Receipt, Type.Null()]),
    message: text(500),
  },
  { additionalProperties: false },
);
export type RememberOutput = Static<typeof RememberOutput>;
