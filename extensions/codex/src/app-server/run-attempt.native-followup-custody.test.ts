import assert from "node:assert/strict";
import path from "node:path";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
  onAgentEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { loadNodeExecAvailability } from "openclaw/plugin-sdk/node-selection-runtime";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { isCodexAppServerLiveThreadClaimed } from "./client-runtime.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { CodexNativeSubagentCompletionDelivery } from "./native-subagent-completion-delivery.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { defaultNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { observeCompletionAttempts } from "./native-subagent-monitor.test-support.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";
import {
  createTestParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();
vi.mock("openclaw/plugin-sdk/node-selection-runtime", { spy: true });

it.each(["delayed-success", "opaque-steer", "wait-before-admission", "yield-receipt"] as const)(
  "preserves accepted follow-up through sessions_yield (%s)",
  async (scenario) => {
    // Keep discovery off ambient Gateway I/O while using the real admitted host and monitor.
    vi.mocked(loadNodeExecAvailability).mockResolvedValue({
      cacheKey: "[]",
      isAvailable: () => false,
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const childThreadId = `custody-${scenario}`;
    const waiterThreadId = `${childThreadId}-waiter`;
    const turnB = `${childThreadId}-turn-b`;
    const runB = `codex-thread:${childThreadId}:turn:${turnB}`;
    const accepted = scenario !== "opaque-steer";
    const executionEvents: Array<Parameters<Parameters<typeof onAgentEvent>[0]>[0]> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === `codex-thread:${waiterThreadId}` && event.stream === "execution") {
        executionEvents.push(event);
      }
    });
    let waitAfterAdmission: unknown;
    let claimedAfterStart: boolean | undefined;
    const harness = createStartedThreadHarness();
    const lifetime = new AbortController();
    const params = createTestParams();
    params.abortSignal = lifetime.signal;
    await attachSqliteSessionTarget(params, path.join(tempDir, "sessions.json"), "custody-session");
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => undefined }]),
    );
    const host = await createAdmittedHostCapabilityTestFixture(params, {
      nativeModelPolicySupport: "exact",
    });
    assert(host.agentHarnessCompletionScope, "Expected an admitted completion scope");
    params.hostCapabilities = host.hostCapabilities;
    params.agentHarnessCompletionScope = host.agentHarnessCompletionScope;
    const delivery = vi
      .spyOn(defaultNativeSubagentMonitorRuntime, "deliverAgentHarnessCompletion")
      .mockResolvedValue({ delivered: true, path: "direct" });
    const attempts = new Set<Promise<void>>();
    // Invoked with .call(this, ...) to preserve the observed instance as receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const originalDelivery = CodexNativeSubagentCompletionDelivery.prototype.deliverPending;
    const observeAttempt = vi.spyOn(
      CodexNativeSubagentCompletionDelivery.prototype,
      "deliverPending",
    );
    observeAttempt.mockImplementation(function (
      this: CodexNativeSubagentCompletionDelivery,
      state,
      child,
    ) {
      const attempt = originalDelivery.call(this, state, child);
      attempts.add(attempt);
      return attempt;
    });
    const settleCompletionAttempts = async () => {
      // Receipts settle independently of notification dispatch; join their owner before assertions.
      while (attempts.size > 0) {
        const pending = [...attempts];
        attempts.clear();
        await Promise.all(pending);
      }
    };
    const notify = (method: string, notificationParams: JsonObject) =>
      harness.notify({ method, params: notificationParams } as CodexServerNotification);
    const parentItem = (item: JsonObject, method = "item/completed") =>
      notify(method, { threadId: "thread-1", turnId: "turn-1", item });
    const collab = (id: string, tool: string, threadId: string, extra: JsonObject = {}) =>
      parentItem({
        id,
        type: "collabAgentToolCall",
        tool,
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: [threadId],
        ...extra,
      });
    const spawn = async (threadId: string) => {
      await notify("thread/started", {
        thread: {
          id: threadId,
          parentThreadId: "thread-1",
          source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
        },
      });
      await collab(`spawn-${threadId}`, "spawnAgent", threadId);
    };
    const turn = (threadId: string, id: string, result?: string) =>
      notify(result === undefined ? "turn/started" : "turn/completed", {
        threadId,
        turn: {
          id,
          status: result === undefined ? "inProgress" : "completed",
          error: null,
          items:
            result === undefined
              ? []
              : [{ type: "agentMessage", id: `result-${id}`, phase: "final_answer", text: result }],
        },
      });
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    try {
      await run.waitForTurnAccepted();
      const relayId = extractRelayIdFromThreadRequest(
        harness.requests.find((request) => request.method === "thread/start")?.params,
      );
      await spawn(childThreadId);
      await turn(childThreadId, "turn-a");
      await turn(childThreadId, "turn-a", "A result");
      await collab("wait-a", "wait", childThreadId, {
        agentsStates: { [childThreadId]: { status: "completed", message: "A result" } },
      });
      await settleCompletionAttempts();
      // A is complete and B is not admitted yet; a running sibling authorizes sessions_yield.
      await spawn(waiterThreadId);
      await turn(waiterThreadId, "waiter-turn");
      if (scenario === "wait-before-admission") {
        await turn(childThreadId, turnB);
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
      await collab("submit-b", "sendInput", childThreadId);
      await parentItem(
        {
          type: "function_call_output",
          call_id: "submit-b",
          output: JSON.stringify({ submission_id: accepted ? turnB : `opaque-${turnB}` }),
        },
        "rawResponseItem/completed",
      );
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
      if (scenario === "yield-receipt") {
        // The native receipt queues input without starting another parent turn.
        // Keep teardown open after the real yield has been accepted.
        await turn(childThreadId, turnB);
        claimedAfterStart = isCodexAppServerLiveThreadClaimed(harness.client, childThreadId);
        await parentItem(
          {
            type: "agent_message",
            author: childThreadId,
            recipient: "/root",
            content: [
              {
                type: "input_text",
                text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${childThreadId}\nPayload:\nB result`,
              },
            ],
          },
          "rawResponseItem/completed",
        );
        await turn(childThreadId, turnB, "B result");
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, promptError: null });
      await nativeHookRelayUnregisterQueue.flush();
      host.closeHost();
      host.closeAdmission();
      if (scenario !== "wait-before-admission" && scenario !== "yield-receipt") {
        await turn(childThreadId, turnB);
      }
      if (scenario !== "yield-receipt") {
        claimedAfterStart = isCodexAppServerLiveThreadClaimed(harness.client, childThreadId);
      }
      if (accepted) {
        await turn(childThreadId, turnB, "B result");
        await turn(childThreadId, turnB, "B result");
      } else {
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
      await turn(waiterThreadId, "waiter-turn", "Waiter result");
      await nativeHookRelayUnregisterQueue.flush();
      await settleCompletionAttempts();
      const followupDeliveries = delivery.mock.calls.filter(
        ([call]) => call.childSessionKey === runB,
      );
      if (accepted) {
        expect
          .soft(followupDeliveries)
          .toEqual([[expect.objectContaining({ childSessionKey: runB, result: "B result" })]]);
      } else {
        expect.soft(followupDeliveries).toHaveLength(0);
      }
      expect.soft(claimedAfterStart).toBe(accepted);
      if (scenario === "wait-before-admission") {
        expect.soft(waitAfterAdmission).toMatchObject({
          state: "waiting",
          wait: { kind: "children", dependencies: [{ runId: runB }], pendingCount: 1 },
        });
      }
      expect.soft(isCodexAppServerLiveThreadClaimed(harness.client, childThreadId)).toBe(false);
      expect
        .soft(Boolean(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)))
        .toBe(false);
    } finally {
      unsubscribe();
      lifetime.abort("test_cleanup");
      try {
        harness.close();
        // Join cleanup before flushing relay retirement or releasing the admitted host.
        await Promise.allSettled([run]);
        await settleCompletionAttempts();
        await nativeHookRelayUnregisterQueue.flush();
      } finally {
        observeAttempt.mockRestore();
        try {
          host.closeHost();
        } finally {
          host.closeAdmission();
        }
      }
    }
  },
);

it("reports an earlier turn's unsettled native child to a later turn's sessions_yield", async () => {
  vi.mocked(loadNodeExecAvailability).mockResolvedValue({
    cacheKey: "[]",
    isAvailable: () => false,
  });
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => undefined }]),
  );
  const delivery = vi
    .spyOn(defaultNativeSubagentMonitorRuntime, "deliverAgentHarnessCompletion")
    .mockResolvedValue({ delivered: true, path: "direct" });
  const turns: string[] = [];
  const harness = createStartedThreadHarness(async (method) => {
    if (method === "thread/resume") {
      return threadStartResult();
    }
    if (method === "turn/start") {
      turns.push(`turn-${turns.length + 1}`);
      return turnStartResult(turns.at(-1));
    }
    return undefined;
  });
  const notify = (method: string, params: JsonObject) =>
    harness.notify({ method, params } as CodexServerNotification);
  const childTurn = (threadId: string, result?: string) =>
    notify(result === undefined ? "turn/started" : "turn/completed", {
      threadId,
      turn: {
        id: `${threadId}-turn`,
        status: result === undefined ? "inProgress" : "completed",
        error: null,
        items:
          result === undefined
            ? []
            : [
                {
                  type: "agentMessage",
                  id: `${threadId}-result`,
                  phase: "final_answer",
                  text: result,
                },
              ],
      },
    });
  const spawn = async (threadId: string) => {
    await notify("thread/started", {
      thread: {
        id: threadId,
        parentThreadId: "thread-1",
        source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
      },
    });
    await notify("item/completed", {
      threadId: "thread-1",
      turnId: turns.at(-1)!,
      item: {
        id: `spawn-${threadId}`,
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: [threadId],
      },
    });
    await childTurn(threadId);
  };
  const hosts: Array<Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>> = [];
  const startTurn = async (runId: string) => {
    const params = createTestParams();
    params.runId = runId;
    await attachSqliteSessionTarget(params, path.join(tempDir, "sessions.json"), "yield-session");
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    const host = await createAdmittedHostCapabilityTestFixture(params, {
      nativeModelPolicySupport: "exact",
    });
    hosts.push(host);
    assert(host.agentHarnessCompletionScope, "Expected an admitted completion scope");
    params.hostCapabilities = host.hostCapabilities;
    params.agentHarnessCompletionScope = host.agentHarnessCompletionScope;
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await run.waitForTurnAccepted();
    // Wrapped so awaiting the accepted turn does not also await the attempt.
    return { run };
  };
  const completeTurn = async ({ run }: Awaited<ReturnType<typeof startTurn>>) => {
    await harness.completeTurn({ threadId: "thread-1", turnId: turns.at(-1)! });
    expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, promptError: null });
    await nativeHookRelayUnregisterQueue.flush();
  };
  const yieldTurn = async () => {
    const callId = `yield-${turns.at(-1)}`;
    const response = (await harness.handleServerRequest({
      id: callId,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: turns.at(-1)!,
        callId,
        namespace: null,
        tool: "sessions_yield",
        arguments: { message: "Waiting for children" },
      },
    })) as { contentItems: Array<{ text: string }> };
    return JSON.parse(response.contentItems[0]!.text) as Record<string, unknown>;
  };

  try {
    // The first turn spawns two native children, one finishes, and the turn yields.
    const first = await startTurn("run-1");
    await spawn("child-settled");
    await childTurn("child-settled", "Settled result");
    await spawn("child-running");
    expect(await yieldTurn()).toMatchObject({ status: "yielded" });
    await completeTurn(first);
    // The finished child's detached delivery settles it once its parent turn ends.
    await vi.waitFor(() =>
      expect(delivery).toHaveBeenCalledWith(
        expect.objectContaining({ childSessionKey: "codex-thread:child-settled" }),
      ),
    );

    // A later turn owns no new claim, yet the still-running child will resume the session.
    const second = await startTurn("run-2");
    const result = await yieldTurn();
    expect(result).toMatchObject({
      status: "already_pending",
      pendingChildren: [
        {
          runId: "codex-thread:child-running",
          childSessionKey: "codex-thread:child-running",
          state: "running",
          wakeArmed: false,
        },
      ],
    });
    expect(result.pendingChildren).toHaveLength(1);
    await completeTurn(second);
  } finally {
    harness.close();
    for (const host of hosts) {
      host.closeHost();
      host.closeAdmission();
    }
  }
});

it("delivers a native child after parent rotation before a successor run restores assignments", async () => {
  vi.mocked(loadNodeExecAvailability).mockResolvedValue({
    cacheKey: "[]",
    isAvailable: () => false,
  });
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => undefined }]),
  );
  const harness = createStartedThreadHarness();
  const bindingStore = createCodexTestBindingStore();
  const assignmentRecorded = createDeferred<void>();
  const mutate = bindingStore.mutate.bind(bindingStore);
  const observeAssignment = vi.spyOn(bindingStore, "mutate").mockImplementation(async (...args) => {
    const applied = await mutate(...args);
    if (
      applied &&
      args[1].kind === "record-native-subagent-assignment" &&
      args[1].assignment.childThreadId === "rotation-child"
    ) {
      assignmentRecorded.resolve();
    }
    return applied;
  });
  const attempts = observeCompletionAttempts();
  const params = createTestParams();
  await attachSqliteSessionTarget(params, path.join(tempDir, "sessions.json"), "rotation-session");
  params.runtimePlan = createCodexRuntimePlanFixture();
  setCodexTestModelSupportsTools(params, true);
  const host = await createAdmittedHostCapabilityTestFixture(params, {
    nativeModelPolicySupport: "exact",
  });
  assert(host.agentHarnessCompletionScope);
  params.hostCapabilities = host.hostCapabilities;
  params.agentHarnessCompletionScope = host.agentHarnessCompletionScope;
  const delivery = vi
    .spyOn(defaultNativeSubagentMonitorRuntime, "deliverAgentHarnessCompletion")
    .mockImplementation(async (request) => {
      assert(request.completionCustody?.isCurrent());
      assert(request.isSourceSessionAdmissionAllowed());
      return { delivered: true, path: "direct" };
    });
  const notify = (method: string, notificationParams: JsonObject) =>
    harness.notify({ method, params: notificationParams } as CodexServerNotification);
  const run = runCodexAppServerAttempt(params, { bindingStore });
  try {
    await run.waitForTurnAccepted();
    await notify("thread/started", {
      thread: {
        id: "rotation-child",
        parentThreadId: "thread-1",
        source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
      },
    });
    await notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "spawn-child",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: ["rotation-child"],
      },
    });
    await notify("turn/started", {
      threadId: "rotation-child",
      turn: { id: "child-turn", status: "inProgress", error: null, items: [] },
    });
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    };
    const binding = bindingStore.read(identity);
    assert(binding);
    const owner = createCodexNativeSubagentHistoryOwner({
      parentThreadId: binding.threadId,
      sessionId: params.sessionId,
      binding,
    });
    assert(owner);
    await assignmentRecorded.promise;
    expect(await bindingStore.readNativeSubagentAssignments?.(identity, owner)).toHaveLength(1);
    const yielded = await harness.handleServerRequest({
      id: "yield-rotation",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "yield-rotation",
        namespace: null,
        tool: "sessions_yield",
        arguments: { message: "Waiting for the native child" },
      },
    });
    expect(yielded).toMatchObject({ success: true });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, promptError: null });
    await nativeHookRelayUnregisterQueue.flush();
    host.closeHost();
    host.closeAdmission();
    expect(
      await bindingStore.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-1",
        binding: { ...binding, threadId: "thread-2" },
      }),
    ).toBe(true);
    expect(delivery).not.toHaveBeenCalled();
    const completed = {
      threadId: "rotation-child",
      turn: {
        id: "child-turn",
        status: "completed",
        error: null,
        items: [{ type: "agentMessage", id: "child-final", phase: "final_answer", text: "Done" }],
      },
    };
    await notify("turn/completed", completed);
    await attempts.settle();
    expect(delivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ childSessionKey: "codex-thread:rotation-child", result: "Done" }),
    );
    await notify("turn/completed", completed);
    await attempts.settle();
    expect(delivery).toHaveBeenCalledOnce();
  } finally {
    harness.close();
    await Promise.allSettled([run]);
    await attempts.settle();
    attempts.restore();
    observeAssignment.mockRestore();
    await nativeHookRelayUnregisterQueue.flush();
    host.closeHost();
    host.closeAdmission();
  }
});
