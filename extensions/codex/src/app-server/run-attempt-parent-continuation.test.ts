import { invokeNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessHostCapabilitiesForTest as createHost } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  consumeCodexAppServerLiveThread as consumeLiveThread,
  isCodexAppServerLiveThreadProtected as isProtected,
  protectCodexAppServerLiveThread as protectLiveThread,
} from "./client-runtime.js";
import { codexNativeSubagentMonitorRuntime as monitor } from "./native-subagent-monitor.js";
import {
  agentMessage,
  childTurnCompletedNotification,
  createRuntime,
  directSpawnItem,
  itemNotification,
  observeCompletionAttempts,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import * as attemptResources from "./run-attempt-resources.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createParams,
  createTestParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt as runAttempt,
  setupRunAttemptTestHooks,
  setCodexTestModelSupportsTools,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding as readBinding,
  writeCodexAppServerBinding as writeBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

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
  const runtime = createRuntime();
  const register = monitor.register;
  vi.spyOn(monitor, "register").mockImplementation((request) => register({ ...request, runtime }));
  let turns = 0;
  const harness = createStartedThreadHarness(async (method, request) => {
    if (method === "thread/resume") {
      return threadStartResult("thread-1");
    }
    if (method === "thread/read") {
      return threadRead({
        childThreadId: (request as { threadId: string }).threadId,
        parentThreadId: "thread-1",
        turnId: "child-turn",
        status: "inProgress",
        threadStatus: "active",
      });
    }
    if (method === "thread/turns/list") {
      return { data: [], nextCursor: null };
    }
    if (method === "turn/start") {
      return turnStartResult(`turn-${++turns}`);
    }
    return undefined;
  });
  return {
    runtime,
    harness,
    get turnId() {
      return `turn-${turns}`;
    },
    async startChild() {
      await harness.notify({
        method: "thread/started",
        params: {
          thread: {
            id: "child-thread",
            parentThreadId: "thread-1",
            source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
          },
        },
      });
      const item = directSpawnItem("v1", "thread-1", "child-thread");
      await harness.notify(itemNotification(item, `turn-${turns}`, "thread-1"));
      expect(isProtected(harness.client, "thread-1")).toBe(true);
    },
  };
}

describe("Codex parent continuation with native child custody", () => {
  it.each([false, true])(
    "continues an interrupted parent and delivers its child's result (warm: %s)",
    async (warm) => {
      const abort = new AbortController();
      const params = createTestParams();
      const { sessionFile, workspaceDir } = params;
      params.abortSignal = abort.signal;
      params.agentHarnessCompletionScope = {
        requesterSessionKey: params.sessionKey!,
        requesterAgentId: "main",
      };
      const parent = createParentHarness();
      const { runtime, harness } = parent;
      const completionAttempts = observeCompletionAttempts();
      if (warm) {
        const initial = runAttempt(createParams(sessionFile, workspaceDir));
        await initial.waitForTurnAccepted();
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        expect((await initial).terminal).toEqual({ kind: "ok" });
        params.runId = "run-interrupted";
      }
      const first = runAttempt(params);
      await first.waitForTurnAccepted();
      await parent.startChild();
      const binding = await readBinding(sessionFile);

      abort.abort("parent interrupted while child is active");
      await harness.waitForMethod("turn/interrupt");
      expect(readAttemptTerminal(await first).aborted).toBe(true);
      expect(harness.requests.some(({ method }) => method === "thread/unsubscribe")).toBe(false);

      const nextParams = createParams(sessionFile, workspaceDir, { runId: "run-next" });
      nextParams.agentHarnessCompletionScope = params.agentHarnessCompletionScope;
      const next = runAttempt(nextParams);
      await next.waitForTurnAccepted();
      expect(await readBinding(sessionFile)).toMatchObject({
        threadId: binding!.threadId,
        clientId: binding!.clientId,
      });
      expect(harness.requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
      expect(harness.requests.filter(({ method }) => method === "thread/resume")).toHaveLength(0);
      const childCompleted = childTurnCompletedNotification({
        status: "completed",
        items: [agentMessage("child-result", "child completed", "final_answer")],
      });
      await harness.notify(childCompleted);
      await completionAttempts.settle();
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      await harness.completeTurn({ threadId: "thread-1", turnId: parent.turnId });
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
    },
  );

  it.each(["binding", "lineage"] as const)(
    "does not publish an interrupted parent after its %s is replaced",
    async (replacement) => {
      const abort = new AbortController();
      const params = createTestParams();
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
      const harness = createStartedThreadHarness();
      const run = runAttempt(params);
      await run.waitForTurnAccepted();
      const releaseProtection = protectLiveThread(harness.client, "thread-1");
      try {
        abort.abort("foreground interrupted");
        const outcome = await Promise.allSettled([run]);
        if (replacement === "lineage") {
          expect(outcome[0]).toMatchObject({ status: "rejected" });
        }
        expect(await consumeLiveThread(harness.client, "thread-1")).toBeUndefined();
        expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
        expect(harness.requests.some(({ method }) => method === "thread/resume")).toBe(false);
      } finally {
        releaseProtection();
      }
    },
  );

  it.each([false, true])(
    "settles a yielded parent under retained source authority (revoked: %s)",
    async (revoked) => {
      const params = createTestParams();
      // Full host tool construction can exceed the lightweight fixture's 5s budget.
      params.timeoutMs = 30_000;
      params.runtimePlan = createCodexRuntimePlanFixture();
      setCodexTestModelSupportsTools(params, true);
      let sourceRevoked = false;
      const host = await createHost({
        attempt: params,
        pluginId: "codex",
        nativeModelPolicySupport: "exact",
        operatorSource: {
          profileId: "parent-source",
          scopes: ["operator.write"],
          assertCurrent: () => {
            if (sourceRevoked) {
              throw new Error("parent source revoked");
            }
          },
        },
      });
      params.hostCapabilities = host.capabilities;
      wrapRetention((retain) => async (afterConfirmedStop) => {
        host.close();
        sourceRevoked = revoked;
        return retain(afterConfirmedStop);
      });
      const parent = createParentHarness();
      const { harness } = parent;
      const run = runAttempt(params, {
        nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
      });
      await run.waitForTurnAccepted();
      const relayId = extractRelayIdFromThreadRequest(
        harness.requests.find(({ method }) => method === "thread/start")?.params,
      );
      // The native child inherits this actual relay. Its first hook waits for
      // the parent's spawn evidence to admit the direct child before yielding.
      const childAdmission = invokeNativeHookRelay({
        provider: "codex",
        relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          agent_id: "child-thread",
          cwd: params.workspaceDir,
          tool_name: "Bash",
          tool_use_id: "child-first-tool",
          tool_input: { command: "allow-child" },
        },
      });
      await parent.startChild();
      await expect(childAdmission).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
      try {
        const response = await harness.handleServerRequest({
          id: "yield-parent",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "yield-parent",
            namespace: null,
            tool: "sessions_yield",
            arguments: { message: "Waiting for native child" },
          },
        });
        expect(response).toMatchObject({ success: true });
        const outcome = await Promise.allSettled([run]);
        expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(true);
        const ownership = await consumeLiveThread(harness.client, "thread-1");
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
        await harness.notify(childTurnCompletedNotification({ status: "completed" }));
        host.close();
      }
    },
  );
});
