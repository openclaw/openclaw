import { copyFileSync, renameSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { waitForSessionMaintenance } from "./coordinator.js";
import { blockFlush, expectEffects, memory, setup } from "./run.test-support.js";

// mock-isolation: Real admission stores; only optional memory effects are inert.
vi.mock("../command/runtime-loaders.js", () => ({
  loadAgentRunnerMemoryRuntime: async () => (await import("./run.test-support.js")).memory,
  loadSessionStoreRuntime: () => import("../command/session-store.runtime.js"),
}));

it("rejects a replacement database while waiting for the foreground owner", async () => {
  await withOpenClawTestState({ label: "maintenance-worker-source" }, async ({ env, path }) => {
    const { scope, entry, schedule } = await setup(env, "maintenance-source");
    const replacementPath = path("replacement.sqlite");
    copyFileSync(scope.storePath, replacementPath);
    const predecessor = createDeferred<boolean>();
    try {
      schedule(predecessor.promise);
      renameSync(scope.storePath, path("original.sqlite"));
      renameSync(replacementPath, scope.storePath);
      expect(await entryReads.readSessionEntryReadOnlyInWorker({ ...scope, env })).toMatchObject(
        entry,
      );
      predecessor.resolve(true);
      await waitForSessionMaintenance(scope.sessionKey);
      expectEffects(0);
      schedule();
      await waitForSessionMaintenance(scope.sessionKey);
      expectEffects(1);
    } finally {
      predecessor.resolve(false);
      await waitForSessionMaintenance(scope.sessionKey);
    }
  });
});

it.each([
  "completed-owner",
  "unsuccessful-owner",
  "gateway-lifecycle-retired",
  "gateway-instance-retired",
  "session-replaced",
  "gateway-lifecycle-retired-during-flush",
  "gateway-instance-retired-during-flush",
] as const)("fences scheduled effects for %s", async (mode) => {
  await withOpenClawTestState({ label: `maintenance-${mode}` }, async ({ env }) => {
    const { scope, entry, schedule } = await setup(env, mode);
    const predecessor = createDeferred<boolean>();
    const duringFlush = mode.endsWith("-during-flush");
    const flush = duringFlush ? blockFlush() : undefined;
    let gatewayLive = true;
    const gatewayContext = {
      resolveGatewayContext: (): GatewayRequestContext | undefined =>
        gatewayLive ? gatewayContext : undefined,
    } as GatewayRequestContext;
    const retireGateway = () => {
      if (mode.startsWith("gateway-lifecycle-retired")) {
        rotateAgentEventLifecycleGeneration();
      } else if (mode.startsWith("gateway-instance-retired")) {
        gatewayLive = false;
      }
    };
    try {
      expect(gatewayContext.resolveGatewayContext?.()).toBe(gatewayContext);
      schedule(predecessor.promise, () => gatewayContext);
      await Promise.resolve();
      expect(memory.runMemoryFlushIfNeeded).not.toHaveBeenCalled();
      if (!duringFlush) {
        retireGateway();
      }
      if (mode === "session-replaced") {
        await replaceSessionEntry(scope, { ...entry, lifecycleRevision: "replacement" });
      }
      predecessor.resolve(mode !== "unsuccessful-owner");
      if (flush) {
        await Promise.race([flush.started, waitForSessionMaintenance(scope.sessionKey)]);
        expect(memory.runMemoryFlushIfNeeded).toHaveBeenCalledOnce();
        retireGateway();
        flush.release();
      }
      await waitForSessionMaintenance(scope.sessionKey);
      expectEffects(
        mode === "completed-owner" || duringFlush ? 1 : 0,
        mode === "completed-owner" ? 1 : 0,
      );
    } finally {
      predecessor.resolve(false);
      flush?.release();
      await waitForSessionMaintenance(scope.sessionKey);
    }
  });
});
