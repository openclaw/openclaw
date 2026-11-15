import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Wire copy of the core trust state; this package intentionally depends on typebox only. */
const CLAWHUB_SKILLS_SH_TRUST_STATE_VALUE = "not-scanned-by-clawhub";

/** Searches the skill registry. */
export const SkillsSearchParamsSchema = closedObject({
  query: Type.Optional(NonEmptyString),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

/** Ranked skill registry search results. */
export const SkillsSearchResultSchema = closedObject({
  results: Type.Array(
    closedObject({
      official: Type.Optional(Type.Boolean()),
      score: Type.Number(),
      slug: NonEmptyString,
      registry: NonEmptyString,
      ownerHandle: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
      installRef: Type.String({
        minLength: 1,
        description:
          "Source-qualified reference for this result. Send it as `slug` to skills.install; several publishers can share one slug.",
      }),
      installOnly: Type.Optional(
        Type.Literal(true, {
          description:
            "Present when ClawHub serves this result install-only: offer install directly with `installRef`, because skills.detail cannot answer for it. Absence means the ordinary review-then-install flow, so results from servers that predate this field keep their existing behavior.",
        }),
      ),
      trustState: Type.Optional(
        Type.Literal(CLAWHUB_SKILLS_SH_TRUST_STATE_VALUE, {
          description:
            "Present when ClawHub resolves this result from a source it has not scanned.",
        }),
      ),
      displayName: NonEmptyString,
      summary: Type.Optional(Type.String()),
      icon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      version: Type.Optional(NonEmptyString),
      updatedAt: Type.Optional(Type.Integer()),
    }),
  ),
});

export type SkillsSearchParams = Static<typeof SkillsSearchParamsSchema>;
export type SkillsSearchResult = Static<typeof SkillsSearchResultSchema>;
