import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionsCreateResultSchema,
  WorktreesBranchesResultSchema,
  WorktreesGcResultSchema,
  WorktreesRemoveResultSchema,
  validateSessionsCreateParams,
  validateFsListDirParams,
  validateWorktreesBranchesParams,
  validateWorktreesCreateParams,
  validateWorktreesGcParams,
  validateWorktreesRecoverRemovalParams,
  validateWorktreesRemoveParams,
  validateWorktreesRestoreParams,
  validateWorktreesRetireSnapshotParams,
} from "../index.js";

describe("managed worktree protocol schemas", () => {
  it("accepts the additive worktree method payloads", () => {
    expect(
      validateWorktreesCreateParams({ repoRoot: "/repo", name: "task-one", baseRef: "main" }),
    ).toBe(true);
    expect(validateWorktreesRemoveParams({ id: "id", force: true })).toBe(true);
    expect(validateWorktreesGcParams({})).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", worktree: true })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", catalogId: "claude" })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", thinkingLevel: "high" })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", fastMode: true })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", fastMode: "auto" })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", fastMode: "ultrafast" })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", fastMode: "fast" })).toBe(false);
    expect(validateSessionsCreateParams({ agentId: "main", incognito: true })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", incognito: "true" })).toBe(false);
    expect(validateSessionsCreateParams({ agentId: "main", thinkingLevel: "" })).toBe(false);
    expect(
      Value.Check(SessionsCreateResultSchema, {
        ok: true,
        key: "agent:main:dashboard:test",
        runStarted: false,
        runError: { code: "INVALID_REQUEST", message: "send blocked by session policy" },
        worktree: { id: "id", path: "/worktree", branch: "openclaw/wt-test" },
      }),
    ).toBe(true);
  });

  it("accepts worktree target params on sessions.create", () => {
    expect(
      validateSessionsCreateParams({
        agentId: "main",
        worktree: true,
        worktreeBaseRef: "origin/main",
        worktreeName: "my-task",
        execNode: "macbook",
      }),
    ).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", worktreeName: "Bad Name" })).toBe(false);
  });

  it("preserves exact-state custody and recovery data in owner-qualified payloads", () => {
    const exactState = {
      ownerKind: "manual",
      createdAt: 1,
      lastActiveAt: 2,
      head: "a".repeat(40),
      branchHead: "b".repeat(40),
      indexSha256: "c".repeat(64),
    };
    expect(validateWorktreesRemoveParams({ id: "id", exactState, expectedOwnerId: "owner" })).toBe(
      true,
    );
    expect(
      validateWorktreesRestoreParams({
        id: "id",
        recoverExactState: exactState,
        expectedOwnerId: "owner",
      }),
    ).toBe(true);
    expect(
      validateWorktreesRemoveParams({ id: "id", exactState: { ...exactState, head: "main" } }),
    ).toBe(false);
    expect(
      validateWorktreesRecoverRemovalParams({
        id: "id",
        snapshot: "a".repeat(64),
        expectedOwnerId: "owner",
      }),
    ).toBe(true);
    expect(
      validateWorktreesRetireSnapshotParams({
        id: "id",
        expectedSnapshotRef: "refs/openclaw/snapshots/id",
        expectedSnapshotOid: "a".repeat(40),
        expectedRemovedAt: 3,
        retainedSourceRef: "refs/heads/main",
        expectedRetainedSourceOid: "b".repeat(40),
        expectedOwnerId: "owner",
      }),
    ).toBe(true);
    expect(
      Value.Check(WorktreesRemoveResultSchema, {
        removed: true,
        recoveryPath: "/state/worktrees/.openclaw-retiring-id",
        recoveryRetainedUntil: 10,
        cleanup: { outcome: "removed-lossless", at: 3 },
      }),
    ).toBe(true);
    expect(
      Value.Check(WorktreesGcResultSchema, {
        removed: ["removed"],
        orphansDeleted: 0,
        snapshotsPruned: 0,
        orphansRetired: 1,
        retiredCheckoutPaths: ["/retired"],
        outcome: "partial",
        issues: [{ id: "retained", stage: "snapshots", outcome: "failed", reason: "unavailable" }],
        issueCount: 1,
        protectedCount: 1,
        protectionReasons: { "branch-moved": 1 },
        limitsSatisfied: null,
      }),
    ).toBe(true);
  });

  it("accepts branch listing payloads and snapshot errors", () => {
    expect(validateWorktreesBranchesParams({ repoRoot: "/repo" })).toBe(true);
    expect(
      validateWorktreesBranchesParams({ repoRoot: "/repo", includeRepositoryStatus: true }),
    ).toBe(true);
    expect(
      validateWorktreesBranchesParams({ repoRoot: "/repo", includeRepositoryStatus: false }),
    ).toBe(true);
    expect(validateWorktreesBranchesParams({})).toBe(false);
    expect(
      Value.Check(WorktreesBranchesResultSchema, {
        branches: [
          { name: "main", kind: "local" },
          { name: "feature", kind: "remote" },
        ],
        defaultBranch: "main",
        headBranch: "feature",
        repositoryStatus: "git",
        branchesUnavailable: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(WorktreesBranchesResultSchema, {
        branches: [],
        repositoryStatus: "not_git",
      }),
    ).toBe(true);
    expect(
      Value.Check(WorktreesBranchesResultSchema, {
        branches: [],
        repositoryStatus: "unavailable",
      }),
    ).toBe(true);
    expect(
      Value.Check(WorktreesBranchesResultSchema, {
        branches: [],
        repositoryStatus: "unknown",
      }),
    ).toBe(false);
    expect(
      Value.Check(WorktreesRemoveResultSchema, {
        removed: true,
        snapshotError: "snapshot failed: nested gitlink",
      }),
    ).toBe(true);
  });

  it("accepts Gateway and node directory-listing targets", () => {
    expect(validateFsListDirParams({ path: "/repo" })).toBe(true);
    expect(validateFsListDirParams({ nodeId: "macbook", path: "/Users/peter" })).toBe(true);
    expect(validateFsListDirParams({ nodeId: "" })).toBe(false);
  });

  it("rejects invalid names and unknown fields", () => {
    expect(validateWorktreesCreateParams({ repoRoot: "/repo", name: "Bad Name" })).toBe(false);
    expect(validateWorktreesGcParams({ unexpected: true })).toBe(false);
  });
});
