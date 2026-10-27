import "../../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { resolveLocalWorkspaceOwner } from "../../gateway/worker-environments/local-workspace-projection.js";
import * as nativeSqlite from "../../infra/node-sqlite.js";
import type { SqliteWorkerAdmissionRequest } from "../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { insertRegistryWorktree } from "../worktrees/registry.js";
import type { ManagedWorktreeRecord } from "../worktrees/types.js";
import { readBrowserRegistry, updateBrowserRegistry } from "./registry.js";
import { useSandboxRegistryState } from "./registry.test-support.js";

const state = useSandboxRegistryState("openclaw-browser-registry-authority-");

it("retains local-workspace authority through browser transaction and commit grants", async () => {
  const { root } = state;
  const sessionKey = "agent:main:browser-authority";
  const worktree: ManagedWorktreeRecord = {
    id: "browser-worktree",
    name: "browser",
    repoFingerprint: "synthetic-browser-repo",
    repoRoot: path.join(root, "repo"),
    path: path.join(root, "checkout"),
    branch: "openclaw/browser",
    baseRef: "main",
    ownerKind: "session",
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  };
  await insertRegistryWorktree(process.env, worktree);
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  const sessionTarget = { agentId: "main", sessionKey, storePath };
  const session = {
    sessionId: "browser-session",
    updatedAt: 1,
    worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
  };
  replaceSessionEntrySync(sessionTarget, session);

  class WorkspaceRevokedError extends Error {}
  const refusal = new WorkspaceRevokedError("Browser workspace authority revoked");
  let stage: SqliteWorkerAdmissionRequest["stage"] | undefined;
  let revokeAt: SqliteWorkerAdmissionRequest["stage"] | undefined;
  const ownerParams = {
    cfg: { session: { store: storePath } },
    agentId: "main",
    sessionKey,
    workspaceDir: worktree.path,
    assertCurrent: () => {
      if (stage !== undefined && stage === revokeAt) {
        throw refusal;
      }
    },
  };
  const sql = observeHostDataSql();
  using sqlObserver = { [Symbol.dispose]: () => sql.restore() };
  void sqlObserver;
  using owner = await resolveLocalWorkspaceOwner(ownerParams);
  expect(owner).toBeDefined();
  const grants: SqliteWorkerAdmissionRequest["stage"][] = [];
  const openNative = vi.spyOn(nativeSqlite, "openNodeSqliteDatabase");
  const createAdmission = workerStore.createSqliteWorkerWriteAdmission;
  vi.spyOn(workerStore, "createSqliteWorkerWriteAdmission").mockImplementation(
    (assertCurrent, nativeLocations) =>
      createAdmission((request) => {
        stage = request.stage;
        const opens = openNative.mock.calls.length;
        try {
          assertCurrent(request);
          grants.push(stage);
        } finally {
          stage = undefined;
          expect(openNative.mock.calls).toHaveLength(opens);
        }
      }, nativeLocations),
  );
  const entry = {
    containerName: "authority-browser",
    sessionKey,
    workspaceDir: worktree.path,
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "synthetic-browser",
    cdpPort: 9222,
  };

  // Session authority is worker-prepared; this upsert uses the registry's worker owner.
  await updateBrowserRegistry(entry, owner!.assertCurrent);
  expect(grants).toEqual(["transaction", "commit"]);
  expect((await readBrowserRegistry()).entries).toEqual([entry]);

  for (const revokedStage of ["transaction", "commit"] as const) {
    revokeAt = revokedStage;
    await expect(
      updateBrowserRegistry({ ...entry, lastUsedAtMs: 2, cdpPort: 9333 }, owner!.assertCurrent),
    ).rejects.toBe(refusal);
    expect((await readBrowserRegistry()).entries).toEqual([entry]);
  }
  revokeAt = undefined;
  await replaceSessionEntry(sessionTarget, {
    ...session,
    lifecycleRevision: "replacement",
    updatedAt: 2,
  });
  expect(() => owner!.assertCurrent()).toThrow("Local sandbox workspace authority changed");
  using released = await resolveLocalWorkspaceOwner(ownerParams);
  released![Symbol.dispose]();
  expect(() => released!.assertCurrent()).toThrow("Local sandbox workspace authority changed");
  using closed = await resolveLocalWorkspaceOwner(ownerParams);
  expect(sql.queries).toEqual([]);
  // Explicit teardown seals the database and releases its lease on the host.
  await closeOpenClawAgentDatabasesAsync();
  expect(() => closed!.assertCurrent()).toThrow("Local sandbox workspace authority changed");
});

it("retains both native workspace lineages without admitting unrelated or independent selections", async () => {
  const parentKey = "agent:main:parent";
  const childKey = "agent:main:subagent:child";
  const root = state.root;
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  const target = (sessionKey: string) => ({ agentId: "main", storePath, sessionKey });
  const worktree: ManagedWorktreeRecord = {
    id: "inherited-worktree",
    name: "inherited",
    repoFingerprint: "inherited-repository",
    repoRoot: path.join(root, "repo"),
    path: path.join(root, "checkout"),
    branch: "openclaw/inherited",
    baseRef: "main",
    ownerKind: "session",
    ownerId: parentKey,
    createdAt: 1,
    lastActiveAt: 1,
  };
  await insertRegistryWorktree(process.env, worktree);
  const parent = {
    sessionId: "parent-id",
    lifecycleRevision: "parent-generation",
    updatedAt: 1,
    worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
  };
  const child = {
    sessionId: "child-id",
    lifecycleRevision: "child-generation",
    updatedAt: 1,
    spawnedBy: parentKey,
    spawnedBySessionId: parent.sessionId,
    parentSessionLifecycleRevision: parent.lifecycleRevision,
    spawnedWorkspaceDir: worktree.path,
    inheritedWorktreeId: worktree.id,
  };
  await replaceSessionEntry(target(parentKey), parent);
  await replaceSessionEntry(target(childKey), child);
  const params = {
    cfg: {},
    agentId: "main",
    sessionKey: childKey,
    workspaceDir: worktree.path,
    inheritWorkspace: true,
  };
  const resolveAdmission = async (overrides: Partial<typeof params> = {}) => {
    // Release unexpected grants and keep their captured environment out of failure diagnostics.
    using admitted = await resolveLocalWorkspaceOwner({ ...params, ...overrides });
    return admitted !== undefined;
  };
  await replaceSessionEntry(target(childKey), { ...child, inheritedWorktreeId: undefined });
  expect(await resolveAdmission()).toBe(false);
  await replaceSessionEntry(target(childKey), child);
  using owner = await resolveLocalWorkspaceOwner(params);
  expect(owner?.sessionKey).toBe(parentKey);
  expect(owner?.sourceSessionKeys).toEqual([parentKey]);
  expect(owner?.workspaceRelativePath).toBe("");
  // Routine parent completion metadata does not retire accepted helper execution.
  await replaceSessionEntry(target(parentKey), { ...parent, updatedAt: 2, lastActivityAt: 2 });
  expect(() => owner!.assertCurrent()).not.toThrow();
  expect(await resolveAdmission({ inheritWorkspace: false })).toBe(false);
  await expect(resolveAdmission({ workspaceDir: path.join(root, "unrelated") })).rejects.toThrow(
    "workspace",
  );
  for (const patch of [
    { spawnedBy: "agent:other:parent" },
    { spawnedCwd: path.join(root, "other") },
    { spawnedBySessionId: undefined },
    { inheritedWorktreeId: "foreign-worktree" },
  ]) {
    await replaceSessionEntry(target(childKey), { ...child, ...patch });
    await expect(resolveAdmission()).rejects.toThrow("workspace");
  }
  await replaceSessionEntry(target(childKey), {
    ...child,
    parentSessionLifecycleRevision: "stale",
  });
  await expect(resolveAdmission()).rejects.toThrow("workspace parent changed");
  await replaceSessionEntry(target(childKey), child);
  using current = await resolveLocalWorkspaceOwner(params);
  await replaceSessionEntry(target(childKey), {
    ...child,
    spawnedWorkspaceDir: path.join(root, "changed"),
  });
  expect(() => current!.assertCurrent()).toThrow("workspace authority changed");
  await replaceSessionEntry(target(childKey), child);
  using archived = await resolveLocalWorkspaceOwner(params);
  await replaceSessionEntry(target(parentKey), { ...parent, archivedAt: 3 });
  expect(() => archived!.assertCurrent()).toThrow("workspace authority changed");
  await expect(resolveAdmission()).rejects.toThrow("workspace authority changed");
  await replaceSessionEntry(target(parentKey), { ...parent, worktree: undefined });
  await expect(resolveAdmission()).rejects.toThrow("workspace binding changed");

  // An explicitly owned child checkout keeps its own owner even with parent lineage.
  const own = {
    ...worktree,
    id: "child-worktree",
    path: path.join(root, "child"),
    ownerId: childKey,
  };
  await insertRegistryWorktree(process.env, own);
  await replaceSessionEntry(target(childKey), {
    ...child,
    worktree: { id: own.id, branch: own.branch, repoRoot: own.repoRoot },
    spawnedWorkspaceDir: undefined,
    spawnedCwd: own.path,
  });
  using independent = await resolveLocalWorkspaceOwner({ ...params, workspaceDir: own.path });
  expect(independent?.sessionKey).toBe(childKey);
  await replaceSessionEntry(target(parentKey), { ...parent, lifecycleRevision: "replaced" });
  expect(() => independent!.assertCurrent()).not.toThrow();
});
