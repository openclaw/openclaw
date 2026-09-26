import path from "node:path";
import type { AgentHarnessTaskRuntimeScope } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, onTestFinished, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import type { CodexServerNotification } from "./protocol.js";
import {
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

export { setupRunAttemptTestHooks as setupNativeYieldChannelProofHooks };

/** Only native model/client notifications are synthetic; yield, retention, and task registration are real. */
export async function createNativeYieldChannelProof(params: {
  scope: AgentHarnessTaskRuntimeScope;
  config: NonNullable<ReturnType<typeof createParams>["config"]>;
}) {
  vi.useRealTimers();
  const turnStarted = createDeferred<void>();
  const childTurn = {
    id: "proof-child-turn",
    status: "inProgress",
    items: [],
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
  };
  const childSource = { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } };
  const harness = createStartedThreadHarness(async (method, request) => {
    if (method === "turn/start") {
      turnStarted.resolve();
    }
    if (method === "thread/loaded/list") {
      return { data: ["thread-1", "proof-child"], nextCursor: null };
    }
    if (method === "thread/read" && (request as { threadId?: string }).threadId === "proof-child") {
      return {
        thread: {
          ...threadStartResult("proof-child").thread,
          parentThreadId: "thread-1",
          source: childSource,
          status: { type: "active", activeFlags: [] },
          turns: [childTurn],
        },
      };
    }
    if (method === "thread/turns/list") {
      return { data: [childTurn], nextCursor: null };
    }
    return undefined;
  });
  const attempt = createParams(
    path.join(tempDir, "proof-session.jsonl"),
    path.join(tempDir, "workspace"),
  );
  await attachSqliteSessionTarget(
    attempt,
    resolveStorePath(undefined, { agentId: "main" }),
    "proof-session",
    params.scope.requesterLifecycleRevision,
  );
  // This composed scenario includes measured cold preparation (~12 s), unlike the 5 s unit fixture.
  attempt.timeoutMs = 60_000;
  attempt.config = params.config;
  attempt.runtimePlan = createCodexRuntimePlanFixture();
  attempt.agentHarnessTaskRuntimeScope = params.scope;
  setCodexTestModelSupportsTools(attempt, true);
  const host = await createAdmittedHostCapabilityTestFixture(attempt, {
    nativeModelPolicySupport: "exact",
  });
  attempt.hostCapabilities = host.hostCapabilities;
  onTestFinished(() => {
    host.closeHost();
    host.closeAdmission();
  });
  const run = runCodexAppServerAttempt(attempt, {
    nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
  });
  // Surface an early attempt exit rather than hanging on a notification that can no longer arrive.
  await Promise.race([
    turnStarted.promise,
    run.then((result) => {
      throw new Error(
        `Attempt exited before turn/start: ${JSON.stringify(readAttemptTerminal(result))}`,
      );
    }),
  ]);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const notify = async (notification: CodexServerNotification) =>
    await harness.notify(notification);
  await notify({
    method: "thread/started",
    params: {
      thread: {
        id: "proof-child",
        parentThreadId: "thread-1",
        source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
      },
    },
  } as CodexServerNotification);
  await notify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "proof-spawn",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: ["proof-child"],
      },
    },
  } as unknown as CodexServerNotification);
  await notify({
    method: "turn/started",
    params: { threadId: "proof-child", turn: childTurn },
  } as CodexServerNotification);
  return {
    sessionKey: attempt.sessionKey!,
    sessionId: attempt.sessionId,
    tool: async (name: string) =>
      await notify({
        method: "item/started",
        params: {
          threadId: "proof-child",
          turnId: "proof-child-turn",
          item: {
            type: "commandExecution",
            id: `proof-${name}`,
            command: name,
            cwd: attempt.workspaceDir,
            status: "inProgress",
            commandActions: [],
          },
        },
      } as unknown as CodexServerNotification),
    waiting: async () =>
      await notify({
        method: "thread/status/changed",
        params: {
          threadId: "proof-child",
          status: { type: "active", activeFlags: ["waitingOnApproval"] },
        },
      } as CodexServerNotification),
    yield: async () => {
      const result = await harness.handleServerRequest({
        id: "proof-yield",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "proof-yield-call",
          namespace: null,
          tool: "sessions_yield",
          arguments: { message: "Waiting for synthetic child" },
        },
      });
      expect(result).toMatchObject({ success: true });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const terminal = await run;
      expect(readAttemptTerminal(terminal)).toMatchObject({ aborted: false, promptError: null });
      expect(terminal.runtimeContinuationStarted).toBe(true);
    },
    close: () => {
      harness.close();
      host.closeHost();
      host.closeAdmission();
    },
  };
}
