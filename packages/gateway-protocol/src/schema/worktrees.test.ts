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
  validateWorktreesRecoverFileParams as recoverFile,
  validateWorktreesRecoverRemovalParams as recoverRemoval,
  validateWorktreesRemoveParams as remove,
  validateWorktreesRestoreParams as restore,
  validateWorktreesRetireSnapshotParams as retireSnapshot,
} from "../index.js";
import { accepts, rejects } from "./schema.test-support.js";

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
    accepts(CreateResult, {
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
    const recovery = {
      sessionKey: "agent:main:dashboard:recovery",
      path: ".openclaw/tmp/archive.tgz",
      recoveryId: "4efcb376-a2d2-482e-98fe-9f5a79bbf466",
      expectedOwnerId: "owner",
    };
    expect(recoverFile(recovery)).toBe(true);
    expect(recoverFile({ ...recovery, expectedOwnerId: undefined })).toBe(false);
    expect(recoverFile({ ...recovery, recoveryId: "../../outside" })).toBe(false);
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
    accepts(RemoveResult, {
      removed: true,
      recoveryPath: "/state/worktrees/.openclaw-retiring-id",
      recoveryRetainedUntil: 10,
      cleanup: { outcome: "removed-lossless", at: 3 },
    });
  });

  it("accepts partial GC receipts with protection and pack-maintenance progress", () => {
    const receipt = {
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
    accepts(GcResult, receipt);
    accepts(GcResult, {
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
    accepts(BranchesResult, {
      branches: [
        { name: "main", kind: "local" },
        { name: "feature", kind: "remote" },
      ],
      defaultBranch: "main",
      headBranch: "feature",
      repositoryStatus: "git",
      branchesUnavailable: true,
    });
    accepts(BranchesResult, { branches: [], repositoryStatus: "not_git" });
    accepts(BranchesResult, { branches: [], repositoryStatus: "unavailable" });
    rejects(BranchesResult, { branches: [], repositoryStatus: "unknown" });
    accepts(RemoveResult, { removed: true, snapshotError: "snapshot failed: nested gitlink" });
  });

  it("accepts Gateway and node directory-listing targets", () => {
    expect(listDir({ path: "/repo" })).toBe(true);
    expect(listDir({ nodeId: "macbook", path: "/Users/peter" })).toBe(true);
    expect(listDir({ nodeId: "" })).toBe(false);
  });
});
