import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** A proposed skill waiting for review in `.drafts/`; never loaded as a skill. */
export const SkillWorkshopDraftSchema = closedObject({
  id: NonEmptyString,
  /** The skill this draft creates or replaces. */
  skillName: NonEmptyString,
  /** Why the review proposed it, or the drafted skill's description when no reason was saved. */
  summary: Type.String(),
  createdAtMs: Type.Number({ minimum: 0 }),
});

export type SkillWorkshopDraft = Static<typeof SkillWorkshopDraftSchema>;
