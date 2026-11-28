import assert from "node:assert/strict";
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
  const agentDir = path.join(stateDir, "agents", "temporary", "agent");
  const run = <T>(fn: () => T | Promise<T>) => withAuthProfileStoreAgentDir(agentDir, stateDir, fn);
  return { env, agentDir, run };
}

function rows(key: string): AuthProfileRowRead {
  const shared = { type: "api_key", provider: "custom", key };
  return {
    store: { status: "readable", raw: { version: 1, profiles: { shared } } },
    state: { status: "missing", reason: "row" },
    cacheable: true,
  };
}

it.each(["fresh", "database-close", "owner-change"] as const)(
  "prepares shared credentials before scope entry: %s",
  async (mode) => {
    const owner = root();
    const started = createDeferredCore();
    const pendingRows = createDeferredCore<AuthProfileRowRead>();
    vi.spyOn(sqliteRead, "readSharedAuthProfileRows")
      .mockImplementationOnce(() => {
        started.resolve();
        return pendingRows.promise;
      })
      .mockResolvedValueOnce(rows("fixture-new"));
    const runtime = createAuthProfileStoreRuntime({
      listRuntimeExternalAuthProfiles: () => [],
      overlayExternalAuthProfiles: (store) => store,
      withPreparedExternalAuthProfiles: async (_params, run) => run(),
    });
    const run = vi.fn(() => runtime.loadAuthProfileStoreForRuntime().profiles.shared);
    const first = owner.run(run);
    try {
      expect(run).not.toHaveBeenCalled();
      await Promise.race([started.promise, first.then(() => assert.fail("Scope entered early"))]);
      if (mode === "database-close") {
        await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(owner.env));
      } else if (mode === "owner-change") {
        noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" }, owner.env);
      }
      pendingRows.resolve(rows("fixture-old"));
      if (mode === "fresh") {
        await expect(first).resolves.toMatchObject({ key: "fixture-old" });
        await expect(owner.run(run)).resolves.toMatchObject({ key: "fixture-new" });
        expect(resolveRuntimeAuthProfileAgentDir()).toBeUndefined();
      } else {
        await expect(first).rejects.toThrow();
        expect(run).not.toHaveBeenCalled();
      }
    } finally {
      pendingRows.resolve(rows("fixture-old"));
      await Promise.allSettled([first]);
    }
  },
);

it("keeps concurrent and nested async scopes separate, including callback rejection", async () => {
  const first = root("legacy-main");
  const second = root("legacy-main");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const runSecond = (fail = false) =>
    second.run(async () => {
      await Promise.resolve();
      expect(resolveRuntimeAuthProfileAgentDir()).toBe(second.agentDir);
      if (fail) {
        throw new Error("fixture callback failed");
      }
    });
  const outer = first.run(async () => {
    entered.resolve();
    await release.promise;
    expect(resolveRuntimeAuthProfileAgentDir()).toBe(first.agentDir);
    await expect(runSecond(true)).rejects.toThrow("fixture callback failed");
    expect(resolveRuntimeAuthProfileAgentDir()).toBe(first.agentDir);
  });
  try {
    await entered.promise;
    await runSecond();
    expect(resolveRuntimeAuthProfileAgentDir()).toBeUndefined();
  } finally {
    release.resolve();
    await outer;
  }
});
