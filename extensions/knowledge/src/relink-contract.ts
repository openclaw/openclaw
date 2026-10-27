import { Type, type Static } from "typebox";
import { id, text } from "./model.js";

/** Most unlinked claims one relink call examines. */
const RELINK_LIMIT_MAX = 500;
/** Examples reported per outcome. */
export const RELINK_EXAMPLES_MAX = 10;

export const RelinkInput = Type.Object(
  {
    dryRun: Type.Optional(
      Type.Boolean({ description: "Report what would be linked without publishing." }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: RELINK_LIMIT_MAX,
        description: "Unlinked claims to examine in this call; default 100.",
      }),
    ),
    include: Type.Optional(
      Type.Union([Type.Literal("remembered"), Type.Literal("all")], {
        description:
          "remembered (default): claims knowledge_remember saved unlinked. all: every current claim with no linked page and no source page, for review; requires dryRun.",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        maxLength: 96,
        description: "nextCursor from the previous call; continue with the same dryRun.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type RelinkInput = Static<typeof RelinkInput>;

const Outcome = Type.Union([
  Type.Literal("linked"),
  Type.Literal("ambiguous"),
  Type.Literal("no_subject"),
]);
export const RelinkExample = Type.Object(
  {
    id,
    title: text(200),
    outcome: Outcome,
    /** page: the claim's recorded source page; hint: the page its saver's subject hint names; mention: the one entity page its text names. */
    tier: Type.Optional(
      Type.Union([Type.Literal("page"), Type.Literal("hint"), Type.Literal("mention")]),
    ),
    subject: Type.Optional(Type.Object({ id, title: text(200) }, { additionalProperties: false })),
    reason: Type.Optional(text(40)),
  },
  { additionalProperties: false },
);
export type RelinkExample = Static<typeof RelinkExample>;

export const RelinkOutput = Type.Object(
  {
    dryRun: Type.Boolean(),
    /** Unlinked remembered claims examined in this call. */
    scanned: Type.Integer({ minimum: 0 }),
    linked: Type.Integer({ minimum: 0 }),
    ambiguous: Type.Integer({ minimum: 0 }),
    noSubject: Type.Integer({ minimum: 0 }),
    /** Links that could not be published (conflict or changed record); retried next pass. */
    failed: Type.Integer({ minimum: 0 }),
    examples: Type.Array(RelinkExample, { maxItems: RELINK_EXAMPLES_MAX * 4 }),
    nextCursor: Type.Union([Type.String({ maxLength: 96 }), Type.Null()]),
    message: text(500),
  },
  { additionalProperties: false },
);
export type RelinkOutput = Static<typeof RelinkOutput>;
