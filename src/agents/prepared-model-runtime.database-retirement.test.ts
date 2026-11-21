// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import * as agentDatabase from "../state/openclaw-agent-execution.js";
import {
  getPreparedModelRuntimeSnapshot,
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

it("finishes a config rebuild when auth changes during database preparation", async () => {
  const { mocks, state } = fixture;
  const agentId = "default";
  const agentDir = state.agentDir(agentId);
  mocks.configuredAgentIds = [agentId];
  await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true, catalogMode: "static" });

  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  using _preparation = vi
    .spyOn(agentDatabase, "prepareOpenClawAgentDatabaseExecution")
    .mockImplementationOnce(async (_options, _assertCurrent, signal) => {
      entered.resolve();
      await racePromiseWithAbortSignal(release.promise, signal, (aborted) => aborted.reason);
    });
  const config = { plugins: {} };
  const rebuild = refreshPreparedModelRuntimeSnapshots(config, { catalogMode: "static" });
  try {
    await awaitGateBeforeSettlement(entered.promise, rebuild, "Rebuild skipped database prep");
    mocks.mutationListener!({ agentDir, affectsInheritedStores: false, profileSetChanged: true });
    release.resolve();
    await rebuild;
    expect(getPreparedModelRuntimeSnapshot({ config, agentId, agentDir })?.isCurrent()).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([rebuild]);
  }
});
