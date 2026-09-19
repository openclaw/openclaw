import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { noteCommittedSharedAuthStoreOwnership } from "./path-resolve.js";
import * as sqliteRead from "./sqlite-read.js";
import {
  createAuthProfileStoreRuntime,
  resolveRuntimeAuthProfileAgentDir,
  withAuthProfileStoreAgentDir,
} from "./store.js";
import type { AuthProfileRowRead } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function root(location: "legacy-main" | "state-db" = "state-db") {
  const stateDir = tempDirs.make("openclaw-auth-scope-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  noteCommittedSharedAuthStoreOwnership({ location }, env);
  return { stateDir, env, agentDir: path.join(stateDir, "agents", "temporary", "agent") };
}

function rows(key: string): AuthProfileRowRead {
  return {
    store: {
      status: "readable",
      raw: {
        version: 1,
        profiles: { shared: { type: "api_key", provider: "custom", key } },
      },
    },
    state: { status: "missing", reason: "row" },
  };
}

it("waits for shared facts and reads fresh credentials for each bounded scope", async () => {
  const owner = root();
  const pendingRows = createDeferredCore<AuthProfileRowRead>();
  vi.spyOn(sqliteRead, "readSharedAuthProfileRows")
    .mockReturnValueOnce(pendingRows.promise)
    .mockResolvedValueOnce(rows("fixture-new"));
  const runtime = createAuthProfileStoreRuntime({
    listRuntimeExternalAuthProfiles: () => [],
    overlayExternalAuthProfiles: (store) => store,
  });
  const run = vi.fn(() => runtime.loadAuthProfileStoreForRuntime().profiles.shared);
  const first = withAuthProfileStoreAgentDir(owner.agentDir, owner.stateDir, run);
  try {
    expect(run).not.toHaveBeenCalled();
    pendingRows.resolve(rows("fixture-old"));
    await expect(first).resolves.toMatchObject({ key: "fixture-old" });
    await expect(
      withAuthProfileStoreAgentDir(owner.agentDir, owner.stateDir, run),
    ).resolves.toMatchObject({ key: "fixture-new" });
    expect(resolveRuntimeAuthProfileAgentDir()).toBeUndefined();
  } finally {
    pendingRows.resolve(rows("fixture-old"));
    await Promise.allSettled([first]);
  }
});

it.each(["database-close", "owner-change"] as const)(
  "does not enter a scope whose shared preparation lost authority through %s",
  async (invalidatedBy) => {
    const owner = root();
    const started = createDeferredCore();
    const pendingRows = createDeferredCore<AuthProfileRowRead>();
    vi.spyOn(sqliteRead, "readSharedAuthProfileRows").mockImplementation(() => {
      started.resolve();
      return pendingRows.promise;
    });
    const run = vi.fn();
    const preparing = Promise.resolve(
      withAuthProfileStoreAgentDir(owner.agentDir, owner.stateDir, run),
    );
    const outcome = preparing.then(
      () => ({ rejected: false }),
      () => ({ rejected: true }),
    );
    try {
      await Promise.race([
        started.promise,
        preparing.then(() => {
          throw new Error("Scope entered before shared preparation");
        }),
      ]);
      if (invalidatedBy === "database-close") {
        await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(owner.env));
      } else {
        noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" }, owner.env);
      }
      pendingRows.resolve(rows("fixture-retired"));
      await expect(outcome).resolves.toEqual({ rejected: true });
      expect(run).not.toHaveBeenCalled();
    } finally {
      pendingRows.resolve(rows("fixture-retired"));
      await outcome;
    }
  },
);

it("keeps concurrent and nested async scopes separate, including callback rejection", async () => {
  const first = root("legacy-main");
  const second = root("legacy-main");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const outer = withAuthProfileStoreAgentDir(first.agentDir, first.stateDir, async () => {
    entered.resolve();
    await release.promise;
    expect(resolveRuntimeAuthProfileAgentDir()).toBe(first.agentDir);
    await expect(
      withAuthProfileStoreAgentDir(second.agentDir, second.stateDir, async () => {
        await Promise.resolve();
        expect(resolveRuntimeAuthProfileAgentDir()).toBe(second.agentDir);
        throw new Error("fixture callback failed");
      }),
    ).rejects.toThrow("fixture callback failed");
    expect(resolveRuntimeAuthProfileAgentDir()).toBe(first.agentDir);
  });
  try {
    await entered.promise;
    await withAuthProfileStoreAgentDir(second.agentDir, second.stateDir, async () => {
      await Promise.resolve();
      expect(resolveRuntimeAuthProfileAgentDir()).toBe(second.agentDir);
    });
    expect(resolveRuntimeAuthProfileAgentDir()).toBeUndefined();
  } finally {
    release.resolve();
    await outer;
  }
});
