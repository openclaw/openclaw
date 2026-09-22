import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { persistHeartbeatOutcome } from "../infra/heartbeat-outcome-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createCliRunnerPrepareFixture } from "./cli-runner.test-helpers.js";

it("drains owned agent resources before removing preparation directories and preserves unrelated state", async () => {
  const fixture = createCliRunnerPrepareFixture(async () => {
    throw new Error("This fixture cleanup test does not prepare a CLI run");
  });
  const first = fixture.session;
  const sessions = [first, fixture.createSession()];
  const ownedState = sessions.map(({ dir }) => ({
    dir,
    database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: dir } }),
  }));
  await persistHeartbeatOutcome({
    ...first.sessionTarget,
    env: { OPENCLAW_STATE_DIR: first.dir },
    runSessionKey: "agent:main:main:heartbeat",
    occurredAt: 100,
    response: { outcome: "progress", notify: false, summary: "Fixture-owned worker" },
  });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let resourceClosed = false;
  const unregister = registerOpenClawAgentDatabaseAsyncResource({
    agentId: "main",
    path: first.sessionTarget.storePath,
    revoke() {},
    async close() {
      entered.resolve();
      await release.promise;
      resourceClosed = true;
    },
  });
  const unrelatedDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-unrelated-")),
  );
  const unrelated = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: unrelatedDir } });
  const removed: string[] = [];
  const remove = fs.rmSync;
  const removal = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    const owned = ownedState.find(({ dir }) => dir === target);
    if (owned) {
      // Refuse unsafe unlink on the original bug so finally can drain before deleting.
      expect(resourceClosed, "agent resources must settle before directory removal").toBe(true);
      expect(owned.database.db.isOpen, "state handle must close before directory removal").toBe(
        false,
      );
      removed.push(owned.dir);
    }
    remove(target, options);
  });
  const cleanup = Promise.resolve().then(() => fixture.cleanup());
  void cleanup.catch(() => {});
  try {
    await entered.promise;
    expect(removed).toEqual([]);
    expect(sessions.every(({ dir }) => fs.existsSync(dir))).toBe(true);
    release.resolve();
    await cleanup;
    expect(removed).toEqual(sessions.map(({ dir }) => dir));
    expect(sessions.some(({ dir }) => fs.existsSync(dir))).toBe(false);
    unrelated.db.exec(
      "CREATE TEMP TABLE cleanup_probe (value INTEGER); INSERT INTO cleanup_probe VALUES (7);",
    );
    expect(unrelated.db.prepare("SELECT value FROM cleanup_probe").get()).toEqual({ value: 7 });
  } finally {
    release.resolve();
    await Promise.allSettled([cleanup]);
    removal.mockRestore();
    for (const { sessionTarget } of sessions) {
      await closeOpenClawAgentDatabaseByPathAsync(sessionTarget.storePath);
    }
    unregister();
    for (const { database } of ownedState) {
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
    await fixture.cleanup();
    await closeOpenClawStateDatabaseByPathAsync(unrelated.path);
    fs.rmSync(unrelatedDir, { recursive: true, force: true });
  }
});
