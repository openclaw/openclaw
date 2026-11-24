// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import * as agentDatabase from "../state/openclaw-agent-execution.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "model-database-retirement" });

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
