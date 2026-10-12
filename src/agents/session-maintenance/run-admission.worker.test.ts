import { copyFileSync, renameSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
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
  memory.runMemoryFlushIfNeeded.mockClear();
  memory.runSessionCompactionIfNeeded.mockClear();
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
