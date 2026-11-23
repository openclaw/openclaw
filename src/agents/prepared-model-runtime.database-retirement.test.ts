// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import * as agentDatabase from "../state/openclaw-agent-execution.js";
import {
  getPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "model-database-retirement" });

it.each(["retirement", "unrelated"] as const)(
  "handles %s database cancellation during startup replacement",
  async (failureSource) => {
    fixture.mocks.configuredAgentIds = ["default"];
    const cfg = {};
    const entered = createDeferred<AbortSignal>();
    const unrelated = new DOMException("unrelated database cancellation", "AbortError");
    using preparation = vi
      .spyOn(agentDatabase, "prepareOpenClawAgentDatabaseExecution")
      .mockImplementationOnce(async (_options, _assertCurrent, signal) => {
        expect(signal).toBeDefined();
        entered.resolve(signal!);
        await new Promise<never>((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              const reason = failureSource === "retirement" ? signal!.reason : unrelated;
              assert(reason instanceof Error);
              reject(reason);
            },
            { once: true },
          );
        });
      });
    const startup = refreshPreparedModelRuntimeSnapshots(cfg, {
      gatewayLifecycle: true,
      startup: true,
      catalogMode: "static",
      joinSupersedingPublication: true,
    });
    const outcome = startup.catch((error: unknown) => error);
    let replacement: Promise<void> | undefined;
    try {
      const retired = await awaitGateBeforeSettlement(
        entered.promise,
        startup,
        "Startup settled before database preparation",
      );
      replacement = refreshPreparedModelRuntimeSnapshots(cfg, {
        agentIds: new Set(["default"]),
        catalogMode: "static",
      });
      expect(retired.aborted).toBe(true);
      await replacement;
      if (failureSource === "retirement") {
        expect(await outcome).toBeUndefined();
      } else {
        expect(await outcome).toBe(unrelated);
      }
      expect(preparation).toHaveBeenCalledTimes(2);
      expect(
        getPreparedModelRuntimeSnapshot({
          config: cfg,
          agentId: "default",
          agentDir: fixture.state.agentDir("default"),
        })?.isCurrent(),
      ).toBe(true);
    } finally {
      await Promise.allSettled([startup, replacement]);
    }
  },
);

it("applies an auth removal that retires an owner during config database preparation", async () => {
  fixture.mocks.configuredAgentIds = ["default"];
  const cfg = {};
  const input = { config: cfg, agentId: "default", agentDir: fixture.state.agentDir("default") };
  await refreshPreparedModelRuntimeSnapshots(cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const initial = await prepareModelRuntimeSnapshot(input);
  expect(initial.createStores().authStorage.getAll()).not.toEqual({});
  const entered = createDeferred();
  const release = createDeferred();
  const prepareDatabase = agentDatabase.prepareOpenClawAgentDatabaseExecution;
  using preparation = vi
    .spyOn(agentDatabase, "prepareOpenClawAgentDatabaseExecution")
    .mockImplementationOnce(async (options, assertCurrent, signal) => {
      entered.resolve();
      await release.promise;
      signal?.throwIfAborted();
      await prepareDatabase(options, assertCurrent, signal);
    });
  const refresh = refreshPreparedModelRuntimeSnapshots(cfg, { catalogMode: "static" });
  const outcome = refresh.catch((error: unknown) => error);
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      refresh,
      "Refresh skipped database preparation",
    );
    expect(preparation).toHaveBeenCalled();
    fixture.mocks.authStorage.getAll.mockReturnValue({});
    fixture.mocks.mutationListener!({
      agentDir: input.agentDir,
      affectsInheritedStores: false,
      profileSetChanged: true,
    });
    release.resolve();
    expect(await outcome).toBeUndefined();
    const snapshot = await prepareModelRuntimeSnapshot(input);
    expect(snapshot.isCurrent()).toBe(true);
    expect(snapshot.createStores().authStorage.getAll()).toEqual({});
  } finally {
    release.resolve();
    await outcome;
  }
});
