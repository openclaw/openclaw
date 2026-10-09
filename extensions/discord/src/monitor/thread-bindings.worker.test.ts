import { DatabaseSync, StatementSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { createThreadBindingManager } from "./thread-bindings.manager.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

vi.mock("../runtime.js", () => {
  const runtime = {
    state: {
      openKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests("discord", options),
      openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests("discord", options),
    },
  };
  return { getDiscordRuntime: () => runtime, getOptionalDiscordRuntime: () => runtime };
});

it("keeps binding restoration, mutation, and shutdown SQL off the process main thread", async () => {
  expect(isMainThread).toBe(true);
  await resetThreadBindingsForTests();
  await withOpenClawTestState({ label: "discord-binding-worker-sql" }, async () => {
    const saved: ThreadBindingRecord = {
      accountId: "work",
      channelId: "parent-1",
      threadId: "thread-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      boundBy: "test",
      boundAt: 100,
      lastActivityAt: 100,
    };
    const native = createPluginStateSyncKeyedStoreForTests<ThreadBindingRecord>("discord", {
      namespace: "thread-bindings",
      maxEntries: 10_000,
    });
    native.register("work:thread-1", saved);
    const calibration = observeHostDataSql();
    try {
      expect(native.lookup("work:thread-1")).toEqual(saved);
      expect(calibration.queries.length).toBeGreaterThan(0);
    } finally {
      calibration.restore();
    }
    await closeOpenClawStateDatabaseAsync();
    const observation = observeHostDataSql();
    const raw = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
    ];
    let manager: Awaited<ReturnType<typeof createThreadBindingManager>> | undefined;
    try {
      manager = await createThreadBindingManager({
        cfg: EMPTY_DISCORD_TEST_CONFIG,
        accountId: "work",
        persist: true,
        enableSweeper: false,
      });
      expect(manager.getByThreadId("thread-1")).toEqual(saved);
      await expect(manager.touchThread({ threadId: "thread-1", at: 200 })).resolves.toMatchObject({
        lastActivityAt: 200,
      });
      const reader = createPluginStateKeyedStoreForTests<ThreadBindingRecord>("discord", {
        namespace: "thread-bindings",
        maxEntries: 10_000,
      });
      await expect(reader.lookup("work:thread-1")).resolves.toMatchObject({ lastActivityAt: 200 });
      await expect(
        manager.unbindThread({ threadId: "thread-1", sendFarewell: false }),
      ).resolves.toMatchObject({
        threadId: "thread-1",
        lastActivityAt: 200,
      });
      await manager.stop();
      expect(observation.queries).toEqual([]);
      for (const call of [...observation.calls, ...raw]) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      observation.restore();
      await manager?.stop();
      await resetThreadBindingsForTests();
    }
    expect(native.lookup("work:thread-1")).toBeUndefined();
    resetPluginStateStoreForTests();
  });
});
