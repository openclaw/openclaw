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

it.each(["cold", "warm"] as const)(
  "keeps %s binding data SQL off the process main thread",
  async (phase) => {
    expect(isMainThread).toBe(true);
    await resetThreadBindingsForTests();
    await withOpenClawTestState({ label: `discord-binding-${phase}-sql` }, async (state) => {
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
      const calibration = observeHostDataSql(state.env);
      let positive: number;
      try {
        expect(native.lookup("work:thread-1")).toEqual(saved);
        positive = calibration.queries.length;
        expect(positive).toBeGreaterThan(0);
      } finally {
        calibration.restore();
      }
      await closeOpenClawStateDatabaseAsync();
      const observation = observeHostDataSql(state.env);
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
        if (phase === "warm") {
          observation.queries.length = 0;
          for (const call of [...observation.calls, ...raw]) {
            call.mockClear();
          }
          await manager.touchThread({ threadId: "thread-1", at: 200 });
          await manager.unbindThread({ threadId: "thread-1", sendFarewell: false });
          await manager.stop();
        }
        console.log("Discord process-main SQLite calibration", {
          phase,
          nativePositive: positive,
          parentDataSql: observation.queries.length,
          rawParentOperations: raw.map((call) => call.mock.calls.length),
          exclusion: "captured lifecycle coordinator database only",
        });
        expect(observation.queries).toEqual([]);
        for (const call of [...observation.calls, ...raw]) {
          expect(call).not.toHaveBeenCalled();
        }
      } finally {
        observation.restore();
        await manager?.stop();
        await resetThreadBindingsForTests();
      }
      expect(native.lookup("work:thread-1")).toEqual(phase === "cold" ? saved : undefined);
      resetPluginStateStoreForTests();
    });
  },
);
