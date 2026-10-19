import { copyFileSync, renameSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { waitForSessionMaintenance } from "./coordinator.js";
import { scheduleSessionMaintenance } from "./run.js";

const memory = vi.hoisted(() => ({
  runMemoryFlushIfNeeded: vi.fn(async () => ({})),
  runSessionCompactionIfNeeded: vi.fn(async () => {}),
}));
// mock-isolation: Admission uses real stores and workers; optional model/persistence effects stay inert.
vi.mock("../command/runtime-loaders.js", () => ({
  loadAgentRunnerMemoryRuntime: async () => memory,
  loadSessionStoreRuntime: () => import("../command/session-store.runtime.js"),
}));

beforeEach(() => {
  memory.runMemoryFlushIfNeeded.mockReset();
  memory.runSessionCompactionIfNeeded.mockReset();
});

it("rejects a replacement database while waiting for the foreground owner", async () => {
  await withOpenClawTestState({ label: "maintenance-worker-source" }, async ({ env, path }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:maintenance-source";
    const entry = { sessionId: "maintenance-source", lifecycleRevision: "initial", updatedAt: 1 };
    writeSessionEntry(database, sessionKey, entry);
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    const replacementPath = path("replacement.sqlite");
    copyFileSync(database.path, replacementPath);
    const predecessor = createDeferred<boolean>();
    const followupRun = createTestFollowupRun({ sessionKey, sessionId: entry.sessionId });
    const request = {
      prepared: { cfg: {}, sessionKey, storePath: database.path, timeoutMs: 60_000 },
      followupRun,
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      startedAt: Date.now(),
    };
    const schedule = (afterOwnerSettles?: Promise<boolean>) =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: createEmptyPluginRegistry(), isWebchatConnect: () => false },
        () => scheduleSessionMaintenance(request, afterOwnerSettles),
      );
    memory.runMemoryFlushIfNeeded.mockClear();
    memory.runSessionCompactionIfNeeded.mockClear();
    try {
      schedule(predecessor.promise);
      renameSync(database.path, path("original.sqlite"));
      renameSync(replacementPath, database.path);
      expect(
        await entryReads.readSessionEntryReadOnlyInWorker({
          agentId: "main",
          storePath: database.path,
          sessionKey,
          env,
        }),
      ).toMatchObject(entry);
      predecessor.resolve(true);
      await waitForSessionMaintenance(sessionKey);
      expect(memory.runMemoryFlushIfNeeded).not.toHaveBeenCalled();
      expect(memory.runSessionCompactionIfNeeded).not.toHaveBeenCalled();
      schedule();
      await waitForSessionMaintenance(sessionKey);
      expect(memory.runMemoryFlushIfNeeded).toHaveBeenCalledOnce();
      expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledOnce();
    } finally {
      predecessor.resolve(false);
      await waitForSessionMaintenance(sessionKey);
      memory.runMemoryFlushIfNeeded.mockClear();
      memory.runSessionCompactionIfNeeded.mockClear();
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
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = `agent:main:maintenance-${mode}`;
    const entry = { sessionId: mode, lifecycleRevision: "initial", updatedAt: 1 };
    writeSessionEntry(database, sessionKey, entry);
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    const predecessor = createDeferred<boolean>();
    const flushStarted = createDeferred();
    const releaseFlush = createDeferred();
    const duringFlush = mode.endsWith("-during-flush");
    if (duringFlush) {
      memory.runMemoryFlushIfNeeded.mockImplementationOnce(async () => {
        flushStarted.resolve();
        await releaseFlush.promise;
        return {};
      });
    }
    let gatewayLive = true;
    const gatewayContext = {
      resolveGatewayContext: (): GatewayRequestContext | undefined =>
        gatewayLive ? gatewayContext : undefined,
    } as GatewayRequestContext;
    const request = {
      prepared: { cfg: {}, sessionKey, storePath: database.path, timeoutMs: 60_000 },
      followupRun: createTestFollowupRun({ sessionKey, sessionId: entry.sessionId }),
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      startedAt: Date.now(),
    };
    const retireGateway = () => {
      if (mode.startsWith("gateway-lifecycle-retired")) {
        rotateAgentEventLifecycleGeneration();
      } else if (mode.startsWith("gateway-instance-retired")) {
        gatewayLive = false;
      }
    };
    try {
      expect(gatewayContext.resolveGatewayContext?.()).toBe(gatewayContext);
      withPluginRuntimeGatewayRequestScope(
        {
          pluginRegistry: createEmptyPluginRegistry(),
          resolveGatewayContext: () => gatewayContext,
          isWebchatConnect: () => false,
        },
        () => scheduleSessionMaintenance(request, predecessor.promise),
      );
      await Promise.resolve();
      expect(memory.runMemoryFlushIfNeeded).not.toHaveBeenCalled();
      if (!duringFlush) {
        retireGateway();
      }
      if (mode === "session-replaced") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey, storePath: database.path },
          { ...entry, lifecycleRevision: "replacement" },
        );
      }
      predecessor.resolve(mode !== "unsuccessful-owner");
      if (duringFlush) {
        await Promise.race([flushStarted.promise, waitForSessionMaintenance(sessionKey)]);
        expect(memory.runMemoryFlushIfNeeded).toHaveBeenCalledOnce();
        retireGateway();
        releaseFlush.resolve();
      }
      await waitForSessionMaintenance(sessionKey);
      expect(memory.runMemoryFlushIfNeeded).toHaveBeenCalledTimes(
        mode === "completed-owner" || duringFlush ? 1 : 0,
      );
      expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledTimes(
        mode === "completed-owner" ? 1 : 0,
      );
    } finally {
      predecessor.resolve(false);
      releaseFlush.resolve();
      await waitForSessionMaintenance(sessionKey);
    }
  });
});

it("lets an admitted turn read before its queued maintenance, while external drains wait for cleanup", async () => {
  await withOpenClawTestState({ label: "maintenance-queued-read" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:maintenance-queued-read";
    const entry = {
      sessionId: "maintenance-queued-read",
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    writeSessionEntry(database, sessionKey, entry);
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    const flushStarted = createDeferred();
    const releaseFlush = createDeferred();
    const events: string[] = [];
    memory.runMemoryFlushIfNeeded.mockImplementationOnce(async () => {
      events.push("flush");
      flushStarted.resolve();
      await releaseFlush.promise;
      return {};
    });
    memory.runSessionCompactionIfNeeded.mockImplementationOnce(async () => {
      events.push("compaction");
    });
    try {
      await withSessionTurn(
        { sessionKey, sessionId: entry.sessionId, storePath: database.path, agentId: "main" },
        async () => {
          withPluginRuntimeGatewayRequestScope(
            { pluginRegistry: createEmptyPluginRegistry(), isWebchatConnect: () => false },
            () =>
              scheduleSessionMaintenance({
                prepared: { cfg: {}, sessionKey, storePath: database.path, timeoutMs: 60_000 },
                followupRun: createTestFollowupRun({ sessionKey, sessionId: entry.sessionId }),
                sessionId: entry.sessionId,
                lifecycleRevision: entry.lifecycleRevision,
                lifecycleGeneration: getAgentEventLifecycleGeneration(),
                startedAt: Date.now(),
              }),
          );
          const checkpoint = waitForSessionMaintenance(sessionKey).then(() => {
            events.push("read");
          });
          // Both admission and the checkpoint have only no-I/O continuations before blocking.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(events).toEqual(["read"]);
          await checkpoint;
        },
      );
      const drained = waitForSessionMaintenance(sessionKey).then(() => events.push("drained"));
      await flushStarted.promise;
      expect(events).toEqual(["read", "flush"]);
      releaseFlush.resolve();
      await drained;
      expect(events).toEqual(["read", "flush", "compaction", "drained"]);
    } finally {
      releaseFlush.resolve();
      await waitForSessionMaintenance(sessionKey);
    }
  });
});
