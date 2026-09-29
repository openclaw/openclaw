import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const SkillLifecycleStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("stale"),
  Type.Literal("archived"),
]);

const SkillCuratorEntrySchema = closedObject({
  skillFile: NonEmptyString,
  skillKey: NonEmptyString,
  skillName: NonEmptyString,
  state: SkillLifecycleStateSchema,
  pinned: Type.Boolean(),
  createdAtMs: Type.Number(),
  stateChangedAtMs: Type.Number(),
  lastUsedAtMs: Type.Union([Type.Number(), Type.Null()]),
  useCount: Type.Number(),
  archivedReason: Type.Union([Type.String(), Type.Null()]),
});

const SkillOverlapCandidateSchema = closedObject({
  left: NonEmptyString,
  right: NonEmptyString,
  score: Type.Number(),
});

const SkillCollectionReviewStatusSchema = closedObject({
  attemptedAtMs: Type.Number(),
  succeededAtMs: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
});

const SkillExperienceReviewStatusSchema = closedObject({
  attemptedAtMs: Type.Number(),
  outcome: Type.Union([
    Type.Literal("completed"),
    Type.Literal("applied"),
    Type.Literal("proposed"),
    Type.Literal("nothing"),
    Type.Literal("failed"),
  ]),
  proposalId: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  usage: Type.Optional(
    closedObject({
      inputTokens: Type.Number(),
      cachedInputTokens: Type.Number(),
      outputTokens: Type.Number(),
    }),
  ),
});

/** Reads persisted skill usage and collection review state. */
export const SkillsCuratorStatusParamsSchema = closedObject({});

export const SkillsCuratorStatusResultSchema = closedObject({
  lastAttemptAtMs: Type.Union([Type.Number(), Type.Null()]),
  lastSuccessAtMs: Type.Union([Type.Number(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
  collectionReview: Type.Optional(Type.Record(NonEmptyString, SkillCollectionReviewStatusSchema)),
  experienceReview: Type.Optional(Type.Record(NonEmptyString, SkillExperienceReviewStatusSchema)),
  counts: closedObject({
    active: Type.Number(),
    stale: Type.Number(),
    archived: Type.Number(),
  }),
  skills: Type.Array(SkillCuratorEntrySchema),
  overlaps: Type.Array(SkillOverlapCandidateSchema),
});

/** Preserves retired curator action methods so clients receive an actionable error. */
export const SkillsCuratorActionParamsSchema = closedObject({ skill: NonEmptyString });

export const SkillsCuratorActionResultSchema = SkillCuratorEntrySchema;

export const SkillCuratorLiveEntrySchema = closedObject({
  ...SkillCuratorEntrySchema.properties,
  createdAtMs: Type.Union([Type.Number(), Type.Null()]),
  stateChangedAtMs: Type.Union([Type.Number(), Type.Null()]),
});

export const SkillsCuratorLiveStatusResultSchema = closedObject({
  ...SkillsCuratorStatusResultSchema.properties,
  inventory: Type.Literal("live-workshop"),
  skills: Type.Array(SkillCuratorLiveEntrySchema),
});

export type SkillsCuratorStatusParams = Static<typeof SkillsCuratorStatusParamsSchema>;
export type SkillsCuratorStatusResult = Static<typeof SkillsCuratorStatusResultSchema>;
export type SkillsCuratorLiveStatusResult = Static<typeof SkillsCuratorLiveStatusResultSchema>;
export type SkillsCuratorCompatibleStatusResult =
  | SkillsCuratorStatusResult
  | SkillsCuratorLiveStatusResult;
export type SkillsCuratorActionParams = Static<typeof SkillsCuratorActionParamsSchema>;
export type SkillsCuratorActionResult = Static<typeof SkillsCuratorActionResultSchema>;
