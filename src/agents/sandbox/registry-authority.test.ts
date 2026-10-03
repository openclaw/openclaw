import "../../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { resolveLocalWorkspaceOwner } from "../../gateway/worker-environments/local-workspace-projection.js";
import * as nativeSqlite from "../../infra/node-sqlite.js";
import type { SqliteWorkerAdmissionRequest } from "../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { insertRegistryWorktree } from "../worktrees/registry.js";
import type { ManagedWorktreeRecord } from "../worktrees/types.js";
import { readBrowserRegistry, updateBrowserRegistry } from "./registry.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

it("retains local-workspace authority through browser transaction and commit grants", async () => {
  const root = dirs.make("openclaw-browser-registry-authority-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
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
  insertRegistryWorktree(process.env, worktree);
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId: "browser-session",
      updatedAt: 1,
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
    },
  );

  class WorkspaceRevokedError extends Error {}
  const refusal = new WorkspaceRevokedError("Browser workspace authority revoked");
  let stage: SqliteWorkerAdmissionRequest["stage"] | undefined;
  let revokeAt: SqliteWorkerAdmissionRequest["stage"] | undefined;
  const owner = resolveLocalWorkspaceOwner({
    cfg: { session: { store: storePath } },
    agentId: "main",
    sessionKey,
    workspaceDir: worktree.path,
    assertCurrent: () => {
      if (stage !== undefined && stage === revokeAt) {
        throw refusal;
      }
    },
  });
  expect(owner).toBeDefined();
  const grants: SqliteWorkerAdmissionRequest["stage"][] = [];
  const coldOpens: SqliteWorkerAdmissionRequest["stage"][] = [];
  const openNative = nativeSqlite.openNodeSqliteDatabase;
  vi.spyOn(nativeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    if (stage !== undefined) {
      coldOpens.push(stage);
    }
    return openNative(...args);
  });
  const createAdmission = workerStore.createSqliteWorkerWriteAdmission;
  vi.spyOn(workerStore, "createSqliteWorkerWriteAdmission").mockImplementation(
    (assertCurrent, nativeLocations) =>
      createAdmission((request) => {
        stage = request.stage;
        try {
          assertCurrent(request);
          grants.push(stage);
        } finally {
          stage = undefined;
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

  // Native owner reads are warm; this first upsert must open the worker independently.
  await updateBrowserRegistry(entry, owner!.assertCurrent);
  expect(grants).toEqual(["transaction", "commit"]);
  expect(coldOpens).toEqual([]);
  expect((await readBrowserRegistry()).entries).toEqual([entry]);

  for (const revokedStage of ["transaction", "commit"] as const) {
    revokeAt = revokedStage;
    await expect(
      updateBrowserRegistry({ ...entry, lastUsedAtMs: 2, cdpPort: 9333 }, owner!.assertCurrent),
    ).rejects.toBe(refusal);
    expect((await readBrowserRegistry()).entries).toEqual([entry]);
  }
  expect(coldOpens).toEqual([]);
});
