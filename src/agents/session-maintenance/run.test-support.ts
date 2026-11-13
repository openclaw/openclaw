import { beforeEach, expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { scheduleSessionMaintenance } from "./run.js";

export const memory = {
  runMemoryFlushIfNeeded: vi.fn(async (_params: { replyOperation?: ReplyOperation }) => ({})),
  runSessionCompactionIfNeeded: vi.fn(async () => {}),
};

beforeEach(() => {
  memory.runMemoryFlushIfNeeded.mockReset();
  memory.runSessionCompactionIfNeeded.mockReset();
});

export async function setup(env: NodeJS.ProcessEnv, sessionId: string) {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const sessionKey = `agent:main:${sessionId}`;
  const entry = { sessionId, lifecycleRevision: "initial", updatedAt: 1 };
  writeSessionEntry(database, sessionKey, entry);
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  const scope = { agentId: "main", sessionKey, sessionId, storePath: database.path };
  const request = {
    prepared: { cfg: {}, sessionKey, storePath: database.path, timeoutMs: 60_000 },
    followupRun: createTestFollowupRun({ sessionKey, sessionId }),
    sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    startedAt: Date.now(),
  };
  const schedule = (
    afterOwnerSettles?: Promise<boolean>,
    resolveGatewayContext?: () => GatewayRequestContext | undefined,
  ) =>
    withPluginRuntimeGatewayRequestScope(
      {
        pluginRegistry: createEmptyPluginRegistry(),
        resolveGatewayContext,
        isWebchatConnect: () => false,
      },
      () => scheduleSessionMaintenance(request, afterOwnerSettles),
    );
  return { scope, entry, schedule, request };
}

export function blockFlush(onStart = () => {}) {
  const started = createDeferred();
  const release = createDeferred();
  memory.runMemoryFlushIfNeeded.mockImplementationOnce(async () => {
    onStart();
    started.resolve();
    await release.promise;
    return {};
  });
  return { started: started.promise, release: release.resolve };
}

export function expectEffects(flush: number, compaction = flush) {
  expect([
    memory.runMemoryFlushIfNeeded.mock.calls.length,
    memory.runSessionCompactionIfNeeded.mock.calls.length,
  ]).toEqual([flush, compaction]);
}
