import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const WorktreeNameSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });
const WorktreeOidSchema = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" });
const WorktreeExactStateSchema = closedObject({
  ownerKind: Type.Union([
    Type.Literal("manual"),
    Type.Literal("session"),
    Type.Literal("workboard"),
  ]),
  ownerId: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  lastActiveAt: Type.Number(),
  head: WorktreeOidSchema,
  branchHead: WorktreeOidSchema,
  indexSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});

const WorktreeRunEndCleanupSchema = Type.Union([
  closedObject({
    outcome: Type.String({
      enum: [
        "removed-lossless",
        "retained-busy",
        "retained-dirty",
        "retained-unpushed",
        "retained-provisioned-drift",
      ],
    }),
    at: Type.Integer({ minimum: 0 }),
  }),
  closedObject({
    outcome: Type.Literal("failed"),
    at: Type.Integer({ minimum: 0 }),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  }),
]);

export const WorktreeRecordSchema = closedObject({
  id: NonEmptyString,
  name: WorktreeNameSchema,
  repoFingerprint: Type.String({ pattern: "^[a-f0-9]{16}$" }),
  repoRoot: NonEmptyString,
  path: NonEmptyString,
  branch: NonEmptyString,
  baseRef: NonEmptyString,
  ownerKind: Type.String({ enum: ["manual", "workboard", "session"] }),
  ownerId: Type.Optional(NonEmptyString),
  snapshotRef: Type.Optional(NonEmptyString),
  createdAt: Type.Integer({ minimum: 0 }),
  lastActiveAt: Type.Integer({ minimum: 0 }),
  removedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  runEndCleanup: Type.Optional(WorktreeRunEndCleanupSchema),
  gcProtection: Type.Optional(NonEmptyString),
});

export const WorktreesListParamsSchema = closedObject({});
export const WorktreesListResultSchema = closedObject({
  worktrees: Type.Array(WorktreeRecordSchema),
});

export const WorktreesCreateParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  name: Type.Optional(WorktreeNameSchema),
  baseRef: Type.Optional(NonEmptyString),
  profiles: Type.Optional(Type.Array(NonEmptyString)),
  expectedOwnerId: Type.Optional(NonEmptyString),
  expectedRepoIdentity: Type.Optional(NonEmptyString),
});

export const WorktreesRemoveParamsSchema = closedObject({
  id: NonEmptyString,
  force: Type.Optional(Type.Boolean()),
  ifLossless: Type.Optional(Type.Boolean()),
  exactState: Type.Optional(WorktreeExactStateSchema),
  expectedOwnerId: Type.Optional(NonEmptyString),
});
export const WorktreesRemoveResultSchema = closedObject({
  removed: Type.Boolean(),
  snapshotRef: Type.Optional(NonEmptyString),
  /** Why the pre-removal snapshot failed; removal may have stopped or continued without one. */
  snapshotError: Type.Optional(NonEmptyString),
  recoveryPath: Type.Optional(NonEmptyString),
  recoveryRetainedUntil: Type.Optional(Type.Integer({ minimum: 0 })),
  cleanup: Type.Optional(WorktreeRunEndCleanupSchema),
});

const WORKTREE_REPOSITORY_STATUSES = ["git", "not_git", "unavailable"] as const;
// Keep a flat string enum for native enum generation; the schema test pins
// TypeBox Value.Check rejection of unknown members on our supported version.
export const WorktreeRepositoryStatusSchema = Type.String({
  enum: [...WORKTREE_REPOSITORY_STATUSES],
});
export const WorktreesBranchesParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  includeRepositoryStatus: Type.Optional(Type.Boolean()),
});
export const WorktreeBranchSchema = closedObject({
  name: NonEmptyString,
  kind: Type.Union([Type.Literal("local"), Type.Literal("remote")]),
});
export const WorktreesBranchesResultSchema = closedObject({
  branches: Type.Array(WorktreeBranchSchema),
  defaultBranch: Type.Optional(NonEmptyString),
  headBranch: Type.Optional(NonEmptyString),
  repositoryStatus: Type.Optional(WorktreeRepositoryStatusSchema),
  branchesUnavailable: Type.Optional(Type.Boolean()),
});

export const WorktreesRestoreParamsSchema = closedObject({
  id: NonEmptyString,
  recoverExactState: Type.Optional(WorktreeExactStateSchema),
  expectedOwnerId: Type.Optional(NonEmptyString),
});
export const WorktreesGcParamsSchema = closedObject({
  expectedOwnerId: Type.Optional(NonEmptyString),
  jobId: Type.Optional(NonEmptyString),
  retryDeferred: Type.Optional(Type.Boolean()),
});
export const WorktreesGcResultSchema = closedObject({
  jobId: Type.Optional(NonEmptyString),
  state: Type.Optional(Type.String({ enum: ["queued", "running", "completed", "failed"] })),
  startedAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  completedAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  removed: Type.Array(NonEmptyString),
  orphansDeleted: Type.Integer({ minimum: 0 }),
  snapshotsPruned: Type.Integer({ minimum: 0 }),
  orphansRetired: Type.Optional(Type.Integer({ minimum: 0 })),
  retiredCheckoutPaths: Type.Optional(Type.Array(NonEmptyString)),
  outcome: Type.Optional(Type.String({ enum: ["completed", "deferred", "partial"] })),
  issues: Type.Optional(
    Type.Array(
      closedObject({
        id: Type.Optional(NonEmptyString),
        stage: Type.String({
          enum: ["idle", "templates", "limits", "size", "orphans", "snapshots"],
        }),
        outcome: Type.String({ enum: ["failed", "deferred", "retired"] }),
        reason: Type.String(),
      }),
    ),
  ),
  issueCount: Type.Optional(Type.Integer({ minimum: 0 })),
  eligibleCount: Type.Optional(Type.Integer({ minimum: 0 })),
  deferredCount: Type.Optional(Type.Integer({ minimum: 0 })),
  failedCount: Type.Optional(Type.Integer({ minimum: 0 })),
  protectedCount: Type.Optional(Type.Integer({ minimum: 0 })),
  protectionReasons: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))),
  limitsSatisfied: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  evictions: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))),
});

export const WorktreesRecoverRemovalParamsSchema = closedObject({
  id: NonEmptyString,
  snapshot: WorktreeOidSchema,
  expectedOwnerId: NonEmptyString,
});
export const WorktreesRecoverRemovalResultSchema = closedObject({
  removed: Type.Literal(true),
  snapshotRef: Type.Optional(NonEmptyString),
});
export const WorktreesRetireSnapshotParamsSchema = closedObject({
  id: NonEmptyString,
  expectedSnapshotRef: NonEmptyString,
  expectedSnapshotOid: WorktreeOidSchema,
  expectedRemovedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  retainedSourceRef: Type.String({ pattern: "^refs/(?:heads|remotes)/.+" }),
  expectedRetainedSourceOid: WorktreeOidSchema,
  expectedOwnerId: NonEmptyString,
});
export const WorktreesRetireSnapshotResultSchema = closedObject({
  retired: Type.Literal(true),
  id: NonEmptyString,
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type WorktreeRecord = Static<typeof WorktreeRecordSchema>;
export type WorktreesListParams = Static<typeof WorktreesListParamsSchema>;
export type WorktreesListResult = Static<typeof WorktreesListResultSchema>;
export type WorktreesCreateParams = Static<typeof WorktreesCreateParamsSchema>;
export type WorktreesRemoveParams = Static<typeof WorktreesRemoveParamsSchema>;
export type WorktreesRemoveResult = Static<typeof WorktreesRemoveResultSchema>;
export type WorktreesRestoreParams = Static<typeof WorktreesRestoreParamsSchema>;
export type WorktreesGcParams = Static<typeof WorktreesGcParamsSchema>;
export type WorktreesGcResult = Static<typeof WorktreesGcResultSchema>;
export type WorktreesRecoverRemovalParams = Static<typeof WorktreesRecoverRemovalParamsSchema>;
export type WorktreesRecoverRemovalResult = Static<typeof WorktreesRecoverRemovalResultSchema>;
export type WorktreesRetireSnapshotParams = Static<typeof WorktreesRetireSnapshotParamsSchema>;
export type WorktreesRetireSnapshotResult = Static<typeof WorktreesRetireSnapshotResultSchema>;
export type WorktreeBranch = Static<typeof WorktreeBranchSchema>;
export type WorktreeRepositoryStatus = (typeof WORKTREE_REPOSITORY_STATUSES)[number];
export type WorktreesBranchesParams = Static<typeof WorktreesBranchesParamsSchema>;
export type WorktreesBranchesResult = Static<typeof WorktreesBranchesResultSchema>;
