import "../../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot } from "@openclaw/fs-safe/root";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { prepareGitHubPublicationSession } from "../../gateway/github-publication-availability.js";
import { localWorkspaceProjectionPath } from "../../gateway/worker-environments/local-workspace-checkout.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "../../gateway/worker-environments/local-workspace-projection.js";
import { withLocalWorkspaceStore } from "../../gateway/worker-environments/local-workspace-store.js";
import { localWorkspaceProjectionFixture } from "../../gateway/worker-environments/local-workspace-store.test-support.js";
import * as nativeSqlite from "../../infra/node-sqlite.js";
import type { SqliteWorkerAdmissionRequest } from "../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "../worktrees/registry.js";
import { getRegistryWorktree } from "../worktrees/registry.test-support.js";
import type { ManagedWorktreeRecord } from "../worktrees/types.js";
import { readBrowserRegistry, updateBrowserRegistry } from "./registry.js";
import { useSandboxRegistryState } from "./registry.test-support.js";

const state = useSandboxRegistryState("openclaw-browser-registry-authority-");

it.each([
  ["retired worktree", "Worktree owner or binding changed"],
  ["replaced worktree", "Worktree owner or binding changed"],
  ["deleted session", "Local sandbox workspace authority changed"],
  ["rotated session", "Local sandbox workspace authority changed"],
  ["released publication", "GitHub publication session lifecycle changed"],
])("refuses the next filesystem effect after %s", async (change, refusal) => {
  const row = localWorkspaceProjectionFixture(randomUUID(), state.root);
  const sessionKey = row.session_key;
  const worktree: ManagedWorktreeRecord = {
    id: row.worktree_id,
    name: "guarded",
    repoFingerprint: "synthetic-repo",
    repoRoot: path.join(state.root, "repo"),
    path: path.join(state.root, "checkout"),
    branch: "openclaw/guarded",
    baseRef: "main",
    ownerKind: "session",
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  };
  await insertRegistryWorktree(process.env, worktree);
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  const scope = { agentId: "main", sessionKey, storePath };
  const session = {
    sessionId: row.session_id,
    updatedAt: 1,
    worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
  };
  await replaceSessionEntry(scope, session);
  const cfg = { session: { store: storePath } };
  using publication =
    change === "released publication"
      ? await prepareGitHubPublicationSession(sessionKey, { agentId: "main", cfg })
      : undefined;
  const assertCaller = vi.fn(() => {
    publication?.readCurrent();
  });
  using owner = await resolveLocalWorkspaceOwner({
    ...scope,
    cfg,
    assertCurrent: assertCaller,
  });
  if (!owner) {
    throw new Error("Expected a resolved workspace owner");
  }
  row.projection_path = localWorkspaceProjectionPath(owner);
  await fs.mkdir(row.projection_path, { recursive: true });
  await withLocalWorkspaceStore({ worktreeId: worktree.id }, (store) => store.create(row));
  let refusedEffect: Promise<void> | undefined;
  await expect(
    withLocalWorkspaceProjection(
      owner,
      async (projection) => {
        for (const check of [projection.current, projection.workerAuthority.assertCurrent!]) {
          assertCaller.mockClear();
          check();
          expect(assertCaller).toHaveBeenCalledOnce();
        }
        const files = await fsSafeRoot(projection.current().projection_path, {
          assertBeforeMutation: projection.current,
        });
        await files.write("owned.txt", "accepted");
        if (change === "retired worktree" || change === "replaced worktree") {
          await updateRegistryWorktree(
            process.env,
            worktree.id,
            change === "retired worktree"
              ? { removedAt: 2 }
              : {
                  repositoryIdentity: {
                    repoRoot: path.join(state.root, "replacement"),
                    repoFingerprint: "replacement",
                  },
                },
          );
          if (change === "replaced worktree") {
            expect(getRegistryWorktree(process.env, worktree.id)?.repoRoot).toBe(
              path.join(state.root, "replacement"),
            );
          }
        } else if (change === "deleted session") {
          await deleteSessionEntryLifecycle({
            ...scope,
            archiveTranscript: false,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          });
        } else if (change === "rotated session") {
          await replaceSessionEntry(scope, {
            ...session,
            lifecycleRevision: "replacement",
            updatedAt: 2,
          });
        } else {
          publication!.release();
        }
        refusedEffect = files.write("owned.txt", "must not publish");
        await refusedEffect;
      },
      { provision: true },
    ),
  ).rejects.toThrow(refusal);
  expect(refusedEffect).toBeDefined();
  expect(await fs.readFile(path.join(row.projection_path, "owned.txt"), "utf8")).toBe("accepted");
});

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
