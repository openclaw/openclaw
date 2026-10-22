import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionsCreateResultSchema as CreateResult,
  WorktreesBranchesResultSchema as BranchesResult,
  WorktreesGcResultSchema as GcResult,
  WorktreesRemoveResultSchema as RemoveResult,
  validateSessionsCreateParams as createSession,
  validateFsListDirParams as listDir,
  validateWorktreesBranchesParams as listBranches,
  validateWorktreesCreateParams as createWorktree,
  validateWorktreesGcParams as gc,
  validateWorktreesRecoverRemovalParams as recoverRemoval,
  validateWorktreesRemoveParams as remove,
  validateWorktreesRestoreParams as restore,
  validateWorktreesRetireSnapshotParams as retireSnapshot,
} from "../index.js";

function check(schema: TSchema, expected: boolean, value: unknown) {
  expect(Value.Check(schema, value)).toBe(expected);
}
const gcResult = { removed: [], orphansDeleted: 0, snapshotsPruned: 0 };

describe("managed worktree protocol schemas", () => {
  it("accepts the additive worktree method payloads", () => {
    expect(createWorktree({ repoRoot: "/repo", name: "task-one", baseRef: "main" })).toBe(true);
    expect(remove({ id: "id", force: true })).toBe(true);
    expect(gc({})).toBe(true);
    expect(createSession({ agentId: "main", worktree: true })).toBe(true);
    expect(createSession({ agentId: "main", catalogId: "claude" })).toBe(true);
    expect(createSession({ agentId: "main", thinkingLevel: "high" })).toBe(true);
    expect(createSession({ agentId: "main", fastMode: true })).toBe(true);
    expect(createSession({ agentId: "main", fastMode: "auto" })).toBe(true);
    expect(createSession({ agentId: "main", fastMode: "ultrafast" })).toBe(true);
    expect(createSession({ agentId: "main", fastMode: "fast" })).toBe(false);
    expect(createSession({ agentId: "main", incognito: true })).toBe(true);
    expect(createSession({ agentId: "main", incognito: "true" })).toBe(false);
    expect(createSession({ agentId: "main", thinkingLevel: "" })).toBe(false);
    check(CreateResult, true, {
      ok: true,
      key: "agent:main:dashboard:test",
      runStarted: false,
      runError: { code: "INVALID_REQUEST", message: "send blocked by session policy" },
      worktree: { id: "id", path: "/worktree", branch: "openclaw/wt-test" },
    });
  });

  it("preserves exact-state custody and recovery data in owner-qualified payloads", () => {
    const owned = { id: "id", expectedOwnerId: "owner" };
    const exactState = {
      ownerKind: "manual",
      createdAt: 1,
      lastActiveAt: 2,
      head: "a".repeat(40),
      branchHead: "b".repeat(40),
      indexSha256: "c".repeat(64),
    };
    expect(remove({ ...owned, exactState })).toBe(true);
    expect(restore({ ...owned, recoverExactState: exactState })).toBe(true);
    expect(remove({ id: "id", exactState: { ...exactState, head: "main" } })).toBe(false);
    expect(recoverRemoval({ ...owned, snapshot: "a".repeat(64) })).toBe(true);
    expect(
      retireSnapshot({
        ...owned,
        expectedSnapshotRef: "refs/openclaw/snapshots/id",
        expectedSnapshotOid: "a".repeat(40),
        expectedRemovedAt: 3,
        retainedSourceRef: "refs/heads/main",
        expectedRetainedSourceOid: "b".repeat(40),
      }),
    ).toBe(true);
    check(RemoveResult, true, {
      removed: true,
      recoveryPath: "/state/worktrees/.openclaw-retiring-id",
      recoveryRetainedUntil: 10,
      cleanup: { outcome: "removed-lossless", at: 3 },
    });
    check(GcResult, true, {
      ...gcResult,
      removed: ["removed"],
      orphansRetired: 1,
      retiredCheckoutPaths: ["/retired"],
      outcome: "partial",
      issues: [{ id: "retained", stage: "snapshots", outcome: "failed", reason: "unavailable" }],
      issueCount: 1,
      protectedCount: 1,
      protectionReasons: { "branch-moved": 1 },
      limitsSatisfied: null,
    });
  });

  it("accepts pack-maintenance progress and failures in GC receipts", () => {
    const receipt = {
      ...gcResult,
      jobId: "gc-job",
      state: "running",
      packsRemoved: 1023,
      gitMaintenance: {
        repoRoot: "/repo",
        stage: "completed",
        packsBefore: 8800,
        packsAfter: 7777,
      },
    };
    check(GcResult, true, receipt);
    check(GcResult, true, {
      ...receipt,
      state: "completed",
      outcome: "partial",
      gitMaintenance: { repoRoot: "/repo", stage: "suspended" },
      issues: [{ stage: "git-maintenance", outcome: "failed", reason: "pack checksum mismatch" }],
    });
  });

  it("accepts branch listing payloads and snapshot errors", () => {
    expect(listBranches({ repoRoot: "/repo" })).toBe(true);
    expect(listBranches({ repoRoot: "/repo", includeRepositoryStatus: true })).toBe(true);
    expect(listBranches({ repoRoot: "/repo", includeRepositoryStatus: false })).toBe(true);
    expect(listBranches({})).toBe(false);
    check(BranchesResult, true, {
      branches: [
        { name: "main", kind: "local" },
        { name: "feature", kind: "remote" },
      ],
      defaultBranch: "main",
      headBranch: "feature",
      repositoryStatus: "git",
      branchesUnavailable: true,
    });
    check(BranchesResult, true, { branches: [], repositoryStatus: "not_git" });
    check(BranchesResult, true, { branches: [], repositoryStatus: "unavailable" });
    check(BranchesResult, false, { branches: [], repositoryStatus: "unknown" });
    check(RemoveResult, true, { removed: true, snapshotError: "snapshot failed: nested gitlink" });
  });

  it("accepts Gateway and node directory-listing targets", () => {
    expect(listDir({ path: "/repo" })).toBe(true);
    expect(listDir({ nodeId: "macbook", path: "/Users/peter" })).toBe(true);
    expect(listDir({ nodeId: "" })).toBe(false);
  });
});
