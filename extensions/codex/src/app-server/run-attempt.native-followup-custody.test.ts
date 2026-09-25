import assert from "node:assert/strict";
import path from "node:path";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
  onAgentEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { isCodexAppServerLiveThreadClaimed } from "./client-runtime.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { defaultNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";
import {
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

describe("native follow-up custody through the registered attempt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });

  it.each([
    "observed-success",
    "delayed-success",
    "failed-result",
    "completed-only",
    "v2-queue-only",
    "opaque-steer",
    "wait-before-admission",
  ] as const)("preserves accepted follow-up through sessions_yield (%s)", async (scenario) => {
    const childThreadId = `custody-${scenario}`;
    const runA = `codex-thread:${childThreadId}`;
    const turnB = `${childThreadId}-turn-b`;
    const runB = `${runA}:turn:${turnB}`;
    const accepted =
      scenario === "observed-success" ||
      scenario === "delayed-success" ||
      scenario === "wait-before-admission";
    const waiterThreadId = `${childThreadId}-waiter`;
    const waiterRunId = `codex-thread:${waiterThreadId}`;
    const executionEvents: Array<Parameters<Parameters<typeof onAgentEvent>[0]>[0]> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === waiterRunId && event.stream === "execution") {
        executionEvents.push(event);
      }
    });
    let waitAfterAdmission: unknown;
    const turnStarted = createDeferred<void>();
    const allowTurnStart = createDeferred<void>();
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        turnStarted.resolve();
        await allowTurnStart.promise;
      }
      return undefined;
    });
    const params = createParams(
      path.join(tempDir, `${childThreadId}-session.jsonl`),
      path.join(tempDir, `${childThreadId}-workspace`),
      { runId: `${childThreadId}-parent-run` },
    );
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, `${childThreadId}-sessions.json`),
      `${childThreadId}-session`,
    );
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => undefined }]),
    );
    const host = await createAdmittedHostCapabilityTestFixture(params, {
      nativeModelPolicySupport: "exact",
    });
    assert(
      host.agentHarnessTaskRuntimeScope,
      "Expected the session fixture to issue a task runtime scope",
    );
    params.hostCapabilities = host.hostCapabilities;
    params.agentHarnessTaskRuntimeScope = host.agentHarnessTaskRuntimeScope;
    const taskRuntime = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "codex-native",
      runIdPrefix: "codex-thread:",
      scope: host.agentHarnessTaskRuntimeScope,
    });
    // Keep the real scoped persistence and registered monitor; isolate final user delivery.
    const delivery = vi
      .spyOn(defaultNativeSubagentMonitorRuntime, "deliverAgentHarnessTaskCompletion")
      .mockResolvedValue({ delivered: true, path: "direct" });
    const notify = async (method: string, notificationParams: JsonObject) => {
      await harness.notify({ method, params: notificationParams } as CodexServerNotification);
    };
    const childStart = () =>
      notify("turn/started", {
        threadId: childThreadId,
        turn: { id: turnB, status: "inProgress", items: [], error: null },
      });
    const parentItem = (item: JsonObject, method = "item/completed") =>
      notify(method, { threadId: "thread-1", turnId: "turn-1", item });
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    let relayId: string | undefined;
    try {
      await turnStarted.promise;
      allowTurnStart.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      relayId = extractRelayIdFromThreadRequest(
        harness.requests.find((request) => request.method === "thread/start")?.params,
      );
      await notify("thread/started", {
        thread: {
          id: childThreadId,
          parentThreadId: "thread-1",
          source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
        },
      });
      await parentItem({
        id: "spawn-a",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: [childThreadId],
      });
      await notify("turn/started", {
        threadId: childThreadId,
        turn: { id: "turn-a", status: "inProgress", items: [], error: null },
      });
      await notify("turn/completed", {
        threadId: childThreadId,
        turn: {
          id: "turn-a",
          status: "completed",
          items: [
            { type: "agentMessage", id: "result-a", phase: "final_answer", text: "A result" },
          ],
          error: null,
        },
      });
      await parentItem({
        id: "wait-a",
        type: "collabAgentToolCall",
        tool: "wait",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: [childThreadId],
        agentsStates: { [childThreadId]: { status: "completed", message: "A result" } },
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const previous = taskRuntime.listTaskRecords().find((task) => task.runId === runA);
      expect(previous).toMatchObject({
        status: "succeeded",
        deliveryStatus: "delivered",
        terminalSummary: "A result",
      });
      const previousSnapshot = structuredClone(previous);

      // A completed A and not-yet-mirrored B cannot authorize sessions_yield.
      // This independently running sibling supplies a real pending completion.
      await notify("thread/started", {
        thread: {
          id: waiterThreadId,
          parentThreadId: "thread-1",
          source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
        },
      });
      await parentItem({
        id: "spawn-waiter",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: [waiterThreadId],
      });
      await notify("turn/started", {
        threadId: waiterThreadId,
        turn: { id: "waiter-turn", status: "inProgress", items: [], error: null },
      });
      if (scenario === "observed-success" || scenario === "wait-before-admission") {
        await childStart();
      }
      if (scenario === "wait-before-admission") {
        await notify("item/started", {
          threadId: waiterThreadId,
          turnId: "waiter-turn",
          item: {
            id: "wait-b",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "inProgress",
            senderThreadId: waiterThreadId,
            receiverThreadIds: [childThreadId],
          },
        });
      }
      await parentItem(
        scenario === "v2-queue-only"
          ? {
              id: "submit-b",
              type: "subAgentActivity",
              kind: "interacted",
              agentThreadId: childThreadId,
              agentPath: "/root/worker",
            }
          : {
              id: "submit-b",
              type: "collabAgentToolCall",
              tool: "sendInput",
              status: "completed",
              senderThreadId: "thread-1",
              receiverThreadIds: [childThreadId],
            },
      );
      // Pinned V1 emits its activity item before applying result?. Only this successful
      // function result certifies submission; completed-only and failure are controls.
      if (scenario !== "completed-only") {
        await parentItem(
          {
            type: "function_call_output",
            call_id: "submit-b",
            output: accepted
              ? JSON.stringify({ submission_id: turnB })
              : scenario === "opaque-steer"
                ? JSON.stringify({ submission_id: `opaque-${turnB}` })
                : scenario === "failed-result"
                  ? "turn input was not submitted: NoActiveTurn"
                  : "",
          },
          "rawResponseItem/completed",
        );
      }
      if (scenario === "wait-before-admission") {
        waitAfterAdmission = structuredClone(executionEvents.at(-1)?.data);
      }
      const yieldResponse = await harness.handleServerRequest({
        id: "yield-parent",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "yield-parent",
          namespace: null,
          tool: "sessions_yield",
          arguments: { message: "Waiting for follow-up B" },
        },
      });
      expect(yieldResponse).toMatchObject({ success: true });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;
      expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, promptError: null });
      await nativeHookRelayUnregisterQueue.flush();
      host.closeHost();
      host.closeAdmission();

      if (scenario === "delayed-success" || scenario === "opaque-steer") {
        await childStart();
      }
      const startedRows = taskRuntime.listTaskRecords();
      const claimedAfterStart = isCodexAppServerLiveThreadClaimed(harness.client, childThreadId);
      if (!accepted) {
        await expect(
          invokeNativeHookRelay(
            {
              provider: "codex",
              relayId,
              event: "pre_tool_use",
              rawPayload: {
                agent_id: childThreadId,
                tool_name: "Bash",
                tool_input: { command: "unaccepted-followup" },
              },
            },
            AbortSignal.timeout(1_000),
          ),
        ).rejects.toThrow(/retained|inactive|not found|admission/);
      }
      if (accepted) {
        const completed = {
          threadId: childThreadId,
          turn: {
            id: turnB,
            status: "completed",
            items: [
              { type: "agentMessage", id: "result-b", phase: "final_answer", text: "B result" },
            ],
            error: null,
          },
        };
        await notify("turn/completed", completed);
        await notify("turn/completed", completed);
      }
      await notify("turn/completed", {
        threadId: waiterThreadId,
        turn: {
          id: "waiter-turn",
          status: "completed",
          items: [
            {
              type: "agentMessage",
              id: "waiter-result",
              phase: "final_answer",
              text: "Waiter result",
            },
          ],
          error: null,
        },
      });
      await nativeHookRelayUnregisterQueue.flush();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const finalRows = taskRuntime.listTaskRecords();
      const claimedAfterCompletion = isCodexAppServerLiveThreadClaimed(
        harness.client,
        childThreadId,
      );
      const relayAfterCompletion = Boolean(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
      );
      expect.soft(finalRows.find((task) => task.runId === runA)).toEqual(previousSnapshot);
      if (accepted) {
        expect
          .soft(startedRows.find((task) => task.runId === runB))
          .toMatchObject({ status: "running" });
        expect.soft(finalRows.find((task) => task.runId === runB)).toMatchObject({
          status: "succeeded",
          deliveryStatus: "delivered",
          terminalSummary: "B result",
        });
        expect
          .soft(delivery.mock.calls.filter(([call]) => call.childSessionKey === runB))
          .toEqual([[expect.objectContaining({ childSessionKey: runB, result: "B result" })]]);
        expect.soft(claimedAfterStart).toBe(true);
      } else {
        expect.soft(finalRows.find((task) => task.runId === runB)).toBeUndefined();
        expect
          .soft(delivery.mock.calls.filter(([call]) => call.childSessionKey === runB))
          .toHaveLength(0);
        expect.soft(claimedAfterStart).toBe(false);
      }
      if (scenario === "wait-before-admission") {
        expect.soft(waitAfterAdmission).toMatchObject({
          state: "waiting",
          wait: { kind: "children", dependencies: [{ runId: runB }], pendingCount: 1 },
        });
      }
      expect.soft(claimedAfterCompletion).toBe(false);
      expect.soft(relayAfterCompletion).toBe(false);
    } finally {
      unsubscribe();
      allowTurnStart.resolve();
      harness.close();
      await nativeHookRelayUnregisterQueue.flush();
      host.closeHost();
      host.closeAdmission();
    }
  });
});
