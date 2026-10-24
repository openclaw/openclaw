import path from "node:path";
import { invokeNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  consumeCodexAppServerLiveThread,
  isCodexAppServerLiveThreadProtected,
  protectCodexAppServerLiveThread,
} from "./client-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  createRuntime,
  directSpawnItem,
  observeCompletionAttempts,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import * as attemptResources from "./run-attempt-resources.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  setCodexTestModelSupportsTools,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

function createParentHarness() {
  const runtime = createRuntime();
  const register = codexNativeSubagentMonitorRuntime.register;
  vi.spyOn(codexNativeSubagentMonitorRuntime, "register").mockImplementation((request) =>
    register({ ...request, runtime }),
  );
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
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: `turn-${turns}`,
          item: directSpawnItem("v1", "thread-1", "child-thread"),
        },
      });
      expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(true);
    },
  };
}

describe("Codex parent continuation with native child custody", () => {
  it("observes the active parent through its canonical store rather than the legacy selector", async () => {
    const params = createParams(
      path.join(tempDir, "roster.jsonl"),
      path.join(tempDir, "workspace"),
    );
    await seedRunSessionOwnerForTest(params.sessionId, params.sessionKey!);
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    params.sessionTarget = {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
      storePath,
    };
    let current: Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsync>> | undefined;
    const parent = createParentHarness();
    const attempt = runCodexAppServerAttempt(params);
    try {
      await attempt.waitForTurnAccepted();
      current = await captureSessionEntryCurrentCheckAsync({
        agentId: "main",
        sessionKey: params.sessionKey!,
        storePath,
      });
      expect(current.entryCurrent).toBeDefined();
      expect(current.entryCurrent!.source.path).not.toBe(storePath);
      const registration = vi.mocked(codexNativeSubagentMonitorRuntime.register).mock.calls[0]![0];
      const snapshot = codexNativeSubagentMonitorRuntime.readNativeSubagents({
        client: parent.harness.client,
        agentId: "main",
        sessionKey: params.sessionKey!,
        sessionId: params.sessionId,
        lifecycleRevision: current.entry?.lifecycleRevision,
        storePath: current.entryCurrent!.source.path,
        parentThreadId: "thread-1",
        historyOwner: registration.historyOwner!,
        assertCurrent: () => {},
      });
      expect(snapshot).toEqual({ coverage: "live", children: [], truncated: false });
    } finally {
      await parent.harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await attempt;
      current?.release();
    }
  });

  it.each([false, true])(
    "continues an interrupted parent and delivers its child's result (warm: %s)",
    async (warm) => {
      const sessionFile = path.join(tempDir, "parent.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const abort = new AbortController();
      const params = createParams(sessionFile, workspaceDir);
      params.abortSignal = abort.signal;
      params.agentHarnessCompletionScope = {
        requesterSessionKey: params.sessionKey!,
        requesterAgentId: "main",
      };
      const parent = createParentHarness();
      const { runtime, harness } = parent;
      const completionAttempts = observeCompletionAttempts();
      if (warm) {
        const initial = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
        await initial.waitForTurnAccepted();
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        expect((await initial).terminal).toEqual({ kind: "ok" });
        params.runId = "run-interrupted";
      }
      const first = runCodexAppServerAttempt(params);
      await first.waitForTurnAccepted();
      await parent.startChild();
      const binding = await readCodexAppServerBinding(sessionFile);

      abort.abort("parent interrupted while child is active");
      await harness.waitForMethod("turn/interrupt");
      expect(readAttemptTerminal(await first).aborted).toBe(true);
      expect(harness.requests.some(({ method }) => method === "thread/unsubscribe")).toBe(false);

      const nextParams = createParams(sessionFile, workspaceDir, { runId: "run-next" });
      nextParams.agentHarnessCompletionScope = params.agentHarnessCompletionScope;
      const next = runCodexAppServerAttempt(nextParams);
      await next.waitForTurnAccepted();
      expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
        threadId: binding!.threadId,
        clientId: binding!.clientId,
      });
      expect(harness.requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
      expect(harness.requests.filter(({ method }) => method === "thread/resume")).toHaveLength(0);
      const childCompleted = childTurnCompletedNotification({
        threadId: "child-thread",
        turnId: "child-turn",
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: "child-result",
            phase: "final_answer",
            text: "child completed",
          },
        ],
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
      const sessionFile = path.join(tempDir, "replaced-parent.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const abort = new AbortController();
      const params = createParams(sessionFile, workspaceDir);
      params.abortSignal = abort.signal;
      const prepare = attemptResources.prepareCodexAttemptResources;
      vi.spyOn(attemptResources, "prepareCodexAttemptResources").mockImplementation((prompt) => {
        const resources = prepare(prompt);
        const retain = resources.retainThreadSubscription;
        resources.retainThreadSubscription = async (afterConfirmedCancellation) => {
          if (afterConfirmedCancellation) {
            if (replacement === "binding") {
              const binding = await readCodexAppServerBinding(sessionFile);
              await writeCodexAppServerBinding(sessionFile, {
                ...binding!,
                threadId: "thread-successor",
              });
            } else {
              await seedRunSessionOwnerForTest("session-successor", params.sessionKey!);
            }
          }
          return retain(afterConfirmedCancellation);
        };
        return resources;
      });
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      const releaseProtection = protectCodexAppServerLiveThread(harness.client, "thread-1");
      try {
        abort.abort("foreground interrupted");
        const outcome = await Promise.allSettled([run]);
        if (replacement === "lineage") {
          expect(outcome[0]).toMatchObject({ status: "rejected" });
        }
        expect(await consumeCodexAppServerLiveThread(harness.client, "thread-1")).toBeUndefined();
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
      const sessionFile = path.join(tempDir, "yielded-parent.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createParams(sessionFile, workspaceDir);
      // Full host tool construction can exceed the lightweight fixture's 5s budget.
      params.timeoutMs = 30_000;
      params.agentId = "main";
      params.runtimePlan = createCodexRuntimePlanFixture();
      setCodexTestModelSupportsTools(params, true);
      let sourceRevoked = false;
      const host = await createAgentHarnessHostCapabilitiesForTest({
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
      const prepare = attemptResources.prepareCodexAttemptResources;
      vi.spyOn(attemptResources, "prepareCodexAttemptResources").mockImplementation((prompt) => {
        const resources = prepare(prompt);
        const retain = resources.retainThreadSubscription;
        resources.retainThreadSubscription = async (afterConfirmedStop) => {
          host.close();
          sourceRevoked = revoked;
          return retain(afterConfirmedStop);
        };
        return resources;
      });
      const parent = createParentHarness();
      const { harness } = parent;
      const run = runCodexAppServerAttempt(params, {
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
          cwd: workspaceDir,
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
        expect(response, JSON.stringify(response)).toMatchObject({ success: true });
        const outcome = await Promise.allSettled([run]);
        expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(true);
        const ownership = await consumeCodexAppServerLiveThread(harness.client, "thread-1");
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
