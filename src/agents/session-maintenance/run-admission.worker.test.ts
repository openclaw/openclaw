import { copyFileSync, renameSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import * as targetPreparation from "../../config/sessions/session-transcript-worker-resources.js";
import { resolveVisibleActiveSessionRunState } from "../../gateway/server-methods/session-active-runs.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { observeMainThreadFs } from "../../test-utils/main-thread-fs-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { waitForSessionMaintenance } from "./coordinator.js";
import { prepareSessionMaintenanceRequest, scheduleSessionMaintenance } from "./run.js";
import { blockFlush, expectEffects, memory, setup } from "./run.test-support.js";

// mock-isolation: Real admission stores; only optional memory effects are inert.
vi.mock("../command/runtime-loaders.js", () => ({
  loadAgentRunnerMemoryRuntime: async () => (await import("./run.test-support.js")).memory,
  loadSessionStoreRuntime: () => import("../command/session-store.runtime.js"),
}));

it("rejects a replacement database while waiting for the foreground owner", async () => {
  await withOpenClawTestState({ label: "maintenance-worker-source" }, async ({ env, path }) => {
    const { scope, entry, schedule, prepare } = await setup(env, "maintenance-source");
    const replacementPath = path("replacement.sqlite");
    copyFileSync(scope.storePath, replacementPath);
    const predecessor = createDeferred<boolean>();
    try {
      {
        using filesystem = observeMainThreadFs();
        schedule(predecessor.promise);
        expect(filesystem.stacks()).toEqual([]);
      }
      renameSync(scope.storePath, path("original.sqlite"));
      renameSync(replacementPath, scope.storePath);
      expect(await entryReads.readSessionEntryReadOnlyInWorker({ ...scope, env })).toMatchObject(
        entry,
      );
      predecessor.resolve(true);
      await waitForSessionMaintenance(scope.sessionKey);
      expectEffects(0);
      const successor = await prepare();
      successor.schedule();
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

it("keeps optional maintenance out of the finished session's active run state", () =>
  withOpenClawTestState({ label: "maintenance-hidden" }, async ({ env }) => {
    expect(isMainThread).toBe(true);
    const { scope, request } = await setup(env, "maintenance-hidden");
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env });
    const discovery = vi.spyOn(targetPreparation, "prepareSessionStoreCandidatesInWorker");
    let prepared: Awaited<ReturnType<typeof prepareSessionMaintenanceRequest>>;
    try {
      using filesystem = observeMainThreadFs();
      prepared = await prepareSessionMaintenanceRequest(request);
      expect(discovery).not.toHaveBeenCalled();
      expect(filesystem.calls()).toEqual({});
    } finally {
      discovery.mockRestore();
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
    }
    if (!prepared) {
      throw new Error("Warm maintenance request was not prepared");
    }
    const flush = blockFlush();
    try {
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: createEmptyPluginRegistry(), isWebchatConnect: () => false },
        () => scheduleSessionMaintenance(prepared),
      );
      await flush.started;
      // Control UI shows a running turn and Stop for any active state on this session.
      expect(
        resolveVisibleActiveSessionRunState({
          requestedKey: scope.sessionKey,
          canonicalKey: scope.sessionKey,
          sessionId: scope.sessionId,
          agentId: scope.agentId,
          storePath: scope.storePath,
        }).active,
      ).toBe(false);
    } finally {
      flush.release();
      await waitForSessionMaintenance(scope.sessionKey);
    }
    expectEffects(1);
  }));
