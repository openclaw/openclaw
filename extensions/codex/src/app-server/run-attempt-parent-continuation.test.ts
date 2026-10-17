import { invokeNativeHookRelay as invokeHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import * as threads from "./client-runtime.js";
import { codexNativeSubagentMonitorRuntime as monitor } from "./native-subagent-monitor.js";
import * as child from "./native-subagent-monitor.test-support.js";
import * as attemptResources from "./run-attempt-resources.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import * as test from "./run-attempt-test-harness.js";
import { runCodexAppServerAttempt as runAttempt } from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding as readBinding,
  writeCodexAppServerBinding as writeBinding,
} from "./session-binding.test-helpers.js";

test.setupRunAttemptTestHooks();

type Retain = attemptResources.CodexAttemptResources["retainThreadSubscription"];
function wrapRetention(wrap: (retain: Retain) => Retain) {
  const prepare = attemptResources.prepareCodexAttemptResources;
  vi.spyOn(attemptResources, "prepareCodexAttemptResources").mockImplementation((prompt) => {
    const resources = prepare(prompt);
    resources.retainThreadSubscription = wrap(resources.retainThreadSubscription);
    return resources;
  });
}

function createParentHarness() {
  const runtime = child.createRuntime();
  const register = monitor.register;
  vi.spyOn(monitor, "register").mockImplementation((request) => register({ ...request, runtime }));
  let turns = 0;
  const harness = test.createStartedThreadHarness(async (method, request) => {
    switch (method) {
      case "thread/resume":
        return test.threadStartResult("thread-1");
      case "thread/read":
        return child.threadRead({
          childThreadId: (request as { threadId: string }).threadId,
          parentThreadId: "thread-1",
          turnId: "child-turn",
          status: "inProgress",
          threadStatus: "active",
        });
      case "thread/turns/list":
        return { data: [], nextCursor: null };
      case "turn/start":
        return test.turnStartResult(`turn-${++turns}`);
    }
  });
  return {
    runtime,
    harness,
    turnId: () => `turn-${turns}`,
    async startChild() {
      const source = { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } };
      const thread = { id: "child-thread", parentThreadId: "thread-1", source };
      await harness.notify({ method: "thread/started", params: { thread } });
      const item = child.directSpawnItem("v1", "thread-1", "child-thread");
      await harness.notify(child.itemNotification(item, `turn-${turns}`, "thread-1"));
      expect(threads.isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(true);
    },
  };
}

it.each([false, true])("Codex parent resumes and delivers child (warm: %s)", async (warm) => {
  const abort = new AbortController();
  const params = test.createTestParams();
  const { sessionFile, workspaceDir } = params;
  params.abortSignal = abort.signal;
  params.agentHarnessCompletionScope = {
    requesterSessionKey: params.sessionKey!,
    requesterAgentId: "main",
  };
  const { runtime, harness, startChild, turnId } = createParentHarness();
  const completionAttempts = child.observeCompletionAttempts();
  if (warm) {
    const initial = runAttempt(test.createParams(sessionFile, workspaceDir));
    await initial.waitForTurnAccepted();
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    expect((await initial).terminal).toEqual({ kind: "ok" });
    params.runId = "run-interrupted";
  }
  const first = runAttempt(params);
  await first.waitForTurnAccepted();
  await startChild();
  const binding = await readBinding(sessionFile);

  abort.abort("parent interrupted while child is active");
  await harness.waitForMethod("turn/interrupt");
  expect(readAttemptTerminal(await first).aborted).toBe(true);
  expect(harness.requests.some(({ method }) => method === "thread/unsubscribe")).toBe(false);

  const nextParams = test.createParams(sessionFile, workspaceDir, { runId: "run-next" });
  nextParams.agentHarnessCompletionScope = params.agentHarnessCompletionScope;
  const next = runAttempt(nextParams);
  await next.waitForTurnAccepted();
  const { threadId, clientId } = binding!;
  expect(await readBinding(sessionFile)).toMatchObject({ threadId, clientId });
  expect(harness.requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
  expect(harness.requests.filter(({ method }) => method === "thread/resume")).toHaveLength(0);
  const childCompleted = child.childTurnCompletedNotification({
    status: "completed",
    items: [child.agentMessage("child-result", "child completed", "final_answer")],
  });
  await harness.notify(childCompleted);
  await completionAttempts.settle();
  expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
  await harness.completeTurn({ threadId: "thread-1", turnId: turnId() });
  expect((await next).terminal).toEqual({ kind: "ok" });
  await completionAttempts.settle();
  await harness.notify(childCompleted);
  await completionAttempts.settle();
  expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      result: "child completed",
      scope: params.agentHarnessCompletionScope,
      expectedRequester: expect.objectContaining({ sessionId: params.sessionId }),
    }),
  );
});

it.each(["binding", "lineage"] as const)("rejects replaced parent %s", async (replacement) => {
  const abort = new AbortController();
  const params = test.createTestParams();
  const { sessionFile } = params;
  params.abortSignal = abort.signal;
  wrapRetention((retain) => async (afterConfirmedCancellation) => {
    if (afterConfirmedCancellation) {
      if (replacement === "binding") {
        await writeBinding(sessionFile, {
          ...(await readBinding(sessionFile))!,
          threadId: "thread-successor",
        });
      } else {
        await seedRunSessionOwnerForTest("session-successor", params.sessionKey!);
      }
    }
    return retain(afterConfirmedCancellation);
  });
  const harness = test.createStartedThreadHarness();
  const run = runAttempt(params);
  await run.waitForTurnAccepted();
  const releaseProtection = threads.protectCodexAppServerLiveThread(harness.client, "thread-1");
  try {
    abort.abort("foreground interrupted");
    const outcome = await Promise.allSettled([run]);
    if (replacement === "lineage") {
      expect(outcome[0]).toMatchObject({ status: "rejected" });
    }
    expect(
      await threads.consumeCodexAppServerLiveThread(harness.client, "thread-1"),
    ).toBeUndefined();
    expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    expect(harness.requests.some(({ method }) => method === "thread/resume")).toBe(false);
  } finally {
    releaseProtection();
  }
});

it.each([false, true])("Codex parent yield respects source revocation (%s)", async (revoked) => {
  const params = test.createTestParams();
  // Full host tool construction can exceed the lightweight fixture's 5s budget.
  params.timeoutMs = 30_000;
  params.runtimePlan = test.createCodexRuntimePlanFixture();
  test.setCodexTestModelSupportsTools(params, true);
  let sourceRevoked = false;
  const closeHost = await test.bindProductionHarnessHostCapabilitiesForTest(params, {
    profileId: "parent-source",
    scopes: ["operator.write"],
    assertCurrent: () => {
      if (sourceRevoked) {
        throw new Error("parent source revoked");
      }
    },
  });
  wrapRetention((retain) => async (afterConfirmedStop) => {
    closeHost();
    sourceRevoked = revoked;
    return retain(afterConfirmedStop);
  });
  const { harness, startChild } = createParentHarness();
  const run = runAttempt(params, {
    nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
  });
  await run.waitForTurnAccepted();
  const relayId = test.extractRelayIdFromThreadRequest(
    harness.requests.find(({ method }) => method === "thread/start")?.params,
  );
  // The inherited relay waits for spawn evidence before admitting the child's first hook.
  const rawPayload = {
    hook_event_name: "PreToolUse",
    agent_id: "child-thread",
    cwd: params.workspaceDir,
    tool_name: "Bash",
    tool_use_id: "child-first-tool",
    tool_input: { command: "allow-child" },
  };
  const admission = invokeHook({ provider: "codex", relayId, event: "pre_tool_use", rawPayload });
  await startChild();
  await expect(admission).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
  try {
    const call = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "yield-parent",
      namespace: null,
      tool: "sessions_yield",
      arguments: { message: "Waiting for native child" },
    };
    const response = await harness.handleServerRequest({
      id: "yield-parent",
      method: "item/tool/call",
      params: call,
    });
    expect(response).toMatchObject({ success: true });
    const outcome = await Promise.allSettled([run]);
    expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(true);
    const ownership = await threads.consumeCodexAppServerLiveThread(harness.client, "thread-1");
    if (revoked) {
      expect(outcome[0]).toMatchObject({ status: "rejected" });
      expect(ownership).toBeUndefined();
    } else {
      expect(outcome[0]).toMatchObject({
        status: "fulfilled",
        value: { terminal: { kind: "ok" } },
      });
      expect(ownership).toBeDefined();
      ownership!.assertCurrent();
      await ownership!.release("thread-1");
    }
  } finally {
    await harness.notify(child.childTurnCompletedNotification({ status: "completed" }));
    closeHost();
  }
});
