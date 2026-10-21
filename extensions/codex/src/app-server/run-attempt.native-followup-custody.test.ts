import assert from "node:assert/strict";
import path from "node:path";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
  onAgentEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { loadNodeExecAvailability } from "openclaw/plugin-sdk/node-selection-runtime";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { isCodexAppServerLiveThreadClaimed } from "./client-runtime.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { defaultNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { collabItem, observeCompletionAttempts } from "./native-subagent-monitor.test-support.js";
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
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();
vi.mock("openclaw/plugin-sdk/node-selection-runtime", { spy: true });
beforeEach(() => {
  vi.mocked(loadNodeExecAvailability).mockResolvedValue({
    cacheKey: "[]",
    isAvailable: () => false,
  });
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => undefined }]),
  );
});
const attemptOptions = { nativeHookRelay: { enabled: true, events: ["pre_tool_use"] } } as const;
const observeDelivery = () =>
  vi
    .spyOn(defaultNativeSubagentMonitorRuntime, "deliverAgentHarnessCompletion")
    .mockResolvedValue({ delivered: true, path: "direct" });

function childNotifications(
  harness: ReturnType<typeof createStartedThreadHarness>,
  parentTurn = () => "turn-1",
) {
  const notify = (method: string, params: JsonObject) =>
    harness.notify({ method, params } as CodexServerNotification);
  const parentItem = (item: JsonObject, method = "item/completed") =>
    notify(method, { threadId: "thread-1", turnId: parentTurn(), item });
  const collab = (
    id: string,
    tool: string,
    threadId: string,
    extra: JsonObject = {},
    sender = "thread-1",
    turnId = parentTurn(),
    method = "item/completed",
  ) =>
    notify(method, {
      threadId: sender,
      turnId,
      item: collabItem(tool, [threadId], { id, senderThreadId: sender, ...extra }),
    });
  const spawn = async (threadId: string, turnId: string) => {
    await notify("thread/started", {
      thread: {
        id: threadId,
        parentThreadId: "thread-1",
        source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
      },
    });
    await collab(`spawn-${threadId}`, "spawnAgent", threadId);
    await turn(threadId, turnId);
  };
  const turn = (threadId: string, id: string, result?: string, itemId = `result-${id}`) =>
    notify(result === undefined ? "turn/started" : "turn/completed", {
      threadId,
      turn: {
        id,
        status: result === undefined ? "inProgress" : "completed",
        error: null,
        items:
          result === undefined
            ? []
            : [{ type: "agentMessage", id: itemId, phase: "final_answer", text: result }],
      },
    });
  const yieldTurn = (callId = `yield-${parentTurn()}`) =>
    harness.handleServerRequest({
      id: callId,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: parentTurn(),
        callId,
        namespace: null,
        tool: "sessions_yield",
        arguments: { message: "Waiting for children" },
      },
    });
  return { parentItem, collab, spawn, turn, yieldTurn };
}

async function admitHost(params: ReturnType<typeof createTestParams>, sessionId: string) {
  await attachSqliteSessionTarget(params, path.join(tempDir, "sessions.json"), sessionId);
  params.runtimePlan = createCodexRuntimePlanFixture();
  setCodexTestModelSupportsTools(params, true);
  const host = await createAdmittedHostCapabilityTestFixture(params, {
    nativeModelPolicySupport: "exact",
  });
  assert(host.agentHarnessCompletionScope, "Expected an admitted completion scope");
  params.hostCapabilities = host.hostCapabilities;
  params.agentHarnessCompletionScope = host.agentHarnessCompletionScope;
  const close = () => {
    try {
      host.closeHost();
    } finally {
      host.closeAdmission();
    }
  };
  return { ...host, close };
}

it.each(["delayed-success", "opaque-steer", "wait-before-admission", "yield-receipt"] as const)(
  "preserves accepted follow-up through sessions_yield (%s)",
  async (scenario) => {
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
    const isClaimed = () => isCodexAppServerLiveThreadClaimed(harness.client, childThreadId);
    const lifetime = new AbortController();
    const params = createTestParams();
    params.abortSignal = lifetime.signal;
    const host = await admitHost(params, "custody-session");
    const delivery = observeDelivery();
    const completion = observeCompletionAttempts();
    const { parentItem, collab, spawn, turn, yieldTurn } = childNotifications(harness);
    const run = runCodexAppServerAttempt(params, attemptOptions);
    try {
      await run.waitForTurnAccepted();
      const relayId = extractRelayIdFromThreadRequest(
        harness.requests.find((request) => request.method === "thread/start")?.params,
      );
      await spawn(childThreadId, "turn-a");
      await turn(childThreadId, "turn-a", "A result");
      await collab("wait-a", "wait", childThreadId, {
        agentsStates: { [childThreadId]: { status: "completed", message: "A result" } },
      });
      await completion.settle();
      // A is complete and B is not admitted yet; a running sibling authorizes sessions_yield.
      await spawn(waiterThreadId, "waiter-turn");
      if (scenario === "wait-before-admission") {
        await turn(childThreadId, turnB);
        await collab(
          "wait-b",
          "wait",
          childThreadId,
          { status: "inProgress" },
          waiterThreadId,
          "waiter-turn",
          "item/started",
        );
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
      expect(await yieldTurn("yield-parent")).toMatchObject({ success: true });
      if (scenario === "yield-receipt") {
        // The native receipt queues input without starting another parent turn.
        await turn(childThreadId, turnB);
        claimedAfterStart = isClaimed();
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
      host.close();
      if (scenario !== "wait-before-admission" && scenario !== "yield-receipt") {
        await turn(childThreadId, turnB);
      }
      if (scenario !== "yield-receipt") {
        claimedAfterStart = isClaimed();
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
      await completion.settle();
      const followups = delivery.mock.calls.filter(([call]) => call.childSessionKey === runB);
      expect
        .soft(followups)
        .toEqual(
          accepted
            ? [[expect.objectContaining({ childSessionKey: runB, result: "B result" })]]
            : [],
        );
      expect.soft(claimedAfterStart).toBe(accepted);
      if (scenario === "wait-before-admission") {
        expect.soft(waitAfterAdmission).toMatchObject({
          state: "waiting",
          wait: { kind: "children", dependencies: [{ runId: runB }], pendingCount: 1 },
        });
      }
      expect.soft(isClaimed()).toBe(false);
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
        await completion.settle();
        await nativeHookRelayUnregisterQueue.flush();
      } finally {
        completion.restore();
        host.close();
      }
    }
  },
);

it("reports an earlier turn's unsettled native child to a later turn's sessions_yield", async () => {
  const delivery = observeDelivery();
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
  const child = childNotifications(harness, () => turns.at(-1)!);
  const childTurn = (threadId: string, result?: string) =>
    child.turn(threadId, `${threadId}-turn`, result, `${threadId}-result`);
  const hosts: Array<Awaited<ReturnType<typeof admitHost>>> = [];
  const startTurn = async (runId: string) => {
    const params = createTestParams();
    params.runId = runId;
    const host = await admitHost(params, "yield-session");
    hosts.push(host);
    const run = runCodexAppServerAttempt(params, attemptOptions);
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
    const response = (await child.yieldTurn()) as { contentItems: Array<{ text: string }> };
    return JSON.parse(response.contentItems[0]!.text) as Record<string, unknown>;
  };

  try {
    const first = await startTurn("run-1");
    await child.spawn("child-settled", "child-settled-turn");
    await childTurn("child-settled", "Settled result");
    await child.spawn("child-running", "child-running-turn");
    expect(await yieldTurn()).toMatchObject({ status: "yielded" });
    await completeTurn(first);
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
      host.close();
    }
  }
});
