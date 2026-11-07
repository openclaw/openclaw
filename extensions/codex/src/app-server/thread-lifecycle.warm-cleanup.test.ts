import { getEventListeners } from "node:events";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  protectCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createNativeSubagentAssignmentStore } from "./native-subagent-assignment-store.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  createCompletionScope,
  createRuntime,
  nativeCompletionNotification,
} from "./native-subagent-monitor.test-support.js";
import {
  createAgentLifecycleHarness,
  createParams as createRunAttemptParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import * as sessionBinding from "./session-binding.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createLifecycleRequest,
  startOrResumeAttemptThreadWithoutSkills as startOrResumeAttemptThread,
  type CodexAttemptThreadInput as LifecycleInput,
} from "./thread-lifecycle.test-fixtures.js";
import {
  retainWarmThread,
  warmPluginConfig,
} from "./thread-lifecycle.warm-cleanup.test-support.js";

function startOrResumeThread(
  input: Pick<LifecycleInput, "client" | "params"> & Partial<LifecycleInput>,
) {
  return startOrResumeAttemptThread({
    signal: new AbortController().signal,
    dynamicTools: [],
    appServer: { ...createAppServerOptions(), connectionClass: "local-loopback" },
    ...input,
    cwd: input.params.workspaceDir,
  });
}

const fixtureParams = (name: string) => ({
  ...createRunAttemptParams(path.join(tempDir, name), path.join(tempDir, "workspace")),
  disableTools: false,
  config: undefined,
});
const createFixture = (respond: Parameters<typeof createLifecycleRequest>[0]) =>
  createAgentLifecycleHarness({
    respond: createLifecycleRequest(respond),
  });
function expectNoLifecycleRequests(fixture: Awaited<ReturnType<typeof createFixture>>) {
  expect(
    fixture.request.mock.calls.some(([method]) =>
      ["thread/start", "thread/resume", "thread/unsubscribe"].includes(method),
    ),
  ).toBe(false);
}

setupRunAttemptTestHooks({ isolateNativeSkillHome: true });

describe("Codex warm subscription cleanup", () => {
  it.each(["complete", "abort", "foreground", "discovery"] as const)(
    "defers a catalog-changing continuation behind its native child (%s)",
    async (scenario) => {
      const params = fixtureParams("child-continuation.jsonl");
      let starts = 0;
      const fixture = await createFixture(async (method) => {
        if (method === "thread/start") {
          return threadStartResult(`parent-${++starts}`);
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const common = {
        client: fixture.client,
        params,
        userMcpServersEnabled: false,
        appServerRuntimeFingerprint: "native-test-runtime",
      };
      const started = await startOrResumeThread(common);
      expect(await retainWarmThread(fixture.client, started)).toBe(true);
      const savedBinding = await readCodexAppServerBinding(params.sessionFile);
      if (!savedBinding) {
        throw new Error("Expected stored parent binding");
      }
      const historyOwner = createCodexNativeSubagentHistoryOwner({
        parentThreadId: started.threadId,
        sessionId: params.sessionId,
        binding: savedBinding,
      });
      if (!historyOwner) {
        throw new Error("Expected native parent history owner");
      }
      const identity = sessionBinding.sessionBindingIdentity({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      });
      const bindingGuard = await testCodexAppServerBindingStore.prepareNativeSubagentGuard(
        identity,
        historyOwner,
      );
      if (!bindingGuard) {
        throw new Error("Expected current native parent binding");
      }
      onTestFinished(() => bindingGuard.release());
      const assignmentStore = createNativeSubagentAssignmentStore({
        bindingStore: testCodexAppServerBindingStore,
        assertBindingCurrent: bindingGuard.assertCurrent,
        identity,
        owner: historyOwner,
      });
      const parent = await codexNativeSubagentMonitorRuntime.register({
        client: fixture.client,
        parentThreadId: started.threadId,
        agentId: "main",
        requesterSessionKey: "agent:main:main",
        completionScope: createCompletionScope("agent:main:main"),
        runtime: createRuntime(),
        historyOwner,
        assignmentStore,
        retainParentThread: (id) => protectCodexAppServerLiveThread(fixture.client, id),
      });
      await parent.ready;
      fixture.notify({
        method: "thread/started",
        params: {
          thread: {
            id: "child-thread",
            parentThreadId: started.threadId,
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: started.threadId,
                  depth: 1,
                  agent_path: "child-thread",
                },
              },
            },
          },
        },
      });
      await vi.waitFor(() => expect(parent.listPendingChildren()).toHaveLength(1));
      await parent.unregister();
      const [assignment] = await assignmentStore.read();
      if (!assignment) {
        throw new Error("Expected persisted child assignment");
      }
      const releaseDiscovery =
        scenario === "discovery"
          ? protectCodexAppServerLiveThread(fixture.client, started.threadId)
          : undefined;
      const signal = new AbortController();
      const onPrewriteHandoffCancelled = vi.fn();
      let settled = false;
      const continuation = startOrResumeThread({
        ...common,
        signal: signal.signal,
        onPrewriteHandoffCancelled,
        dynamicTools: [
          {
            type: "function",
            name: "added_tool",
            description: "Added test tool",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      });
      const outcome = continuation.then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      let childWrite: Promise<unknown> | undefined;
      try {
        if (scenario === "discovery") {
          await expect(outcome).resolves.toMatchObject({
            message: `Codex thread ${started.threadId} is claimed by active work; stop it first.`,
          });
          expect(starts).toBe(1);
          expect(onPrewriteHandoffCancelled).not.toHaveBeenCalled();
          fixture.notify(nativeCompletionNotification({ parentThreadId: started.threadId }));
          return;
        }
        // Observe the production ownership wait, rather than a timer-based guess.
        await vi.waitFor(() => expect(getEventListeners(signal.signal, "abort").length).toBe(2));
        expect(settled).toBe(false);
        expect(starts).toBe(1);
        expect(fixture.request.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(
          false,
        );
        // A child must persist its next model assignment before it can finish.
        // This write runs outside the continuation's binding-lease context.
        let childCanContinue = false;
        childWrite = assignmentStore
          .record({ ...assignment, nativeTurnId: "child-next-turn" }, () => undefined)
          .then((applied) => {
            childCanContinue = applied;
          });
        await vi.waitFor(() => expect(childCanContinue).toBe(true));
        const abortReason = new Error("continuation stopped");
        const foreground =
          scenario === "foreground"
            ? await claimCodexAppServerLiveThread(fixture.client, started.threadId)
            : undefined;
        if (scenario === "abort") {
          signal.abort(abortReason);
        }
        fixture.notify(nativeCompletionNotification({ parentThreadId: started.threadId }));
        if (scenario === "complete") {
          await expect(outcome).resolves.toMatchObject({
            threadId: "parent-2",
            lifecycle: { action: "started" },
          });
          expect(starts).toBe(2);
        } else {
          if (scenario === "abort") {
            await expect(outcome).resolves.toBe(abortReason);
          } else {
            await expect(outcome).resolves.toMatchObject({
              message: `Codex thread ${started.threadId} is claimed by active work; stop it first.`,
            });
          }
          expect(starts).toBe(1);
          expect(
            fixture.request.mock.calls.some(([method]) => method === "thread/unsubscribe"),
          ).toBe(false);
          await foreground?.release(started.threadId);
        }
        expect(onPrewriteHandoffCancelled).toHaveBeenCalledTimes(scenario === "abort" ? 1 : 0);
        expect(getEventListeners(signal.signal, "abort").length).toBe(0);
      } finally {
        releaseDiscovery?.();
        signal.abort();
        await outcome;
        await childWrite;
        await codexNativeSubagentMonitorRuntime.retireParent(fixture.client, started.threadId);
      }
    },
  );
  it.for(["settlement", "cancellation", "deadline"] as const)(
    "joins background cleanup before cold resume: %s",
    { timeout: 15_000 },
    async (scenario) => {
      const params = fixtureParams("background-cold-resume.jsonl");
      const threadId = "background-cold-resume";
      const fixture = await createFixture(async (method) => {
        if (method === "thread/start" || method === "thread/resume") {
          return threadStartResult(threadId);
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const common = { client: fixture.client, params, userMcpServersEnabled: false };
      const started = await startOrResumeThread(common);
      expect(await retainWarmThread(fixture.client, started)).toBe(true);
      const releaseProtection = protectCodexAppServerLiveThread(fixture.client, threadId);
      fixture.request.mockClear();
      const controller = new AbortController();
      const resumed = startOrResumeThread({
        ...common,
        developerInstructions: "updated policy",
        signal: controller.signal,
      });
      const outcome = resumed.catch((error: unknown) => error);
      try {
        await vi.waitFor(() =>
          expect(fixture.request.mock.calls.map(([method]) => method)).toContain("thread/read"),
        );
        await setImmediate();
        expectNoLifecycleRequests(fixture);
        if (scenario === "cancellation") {
          const reason = new Error("cancel background cleanup wait");
          controller.abort(reason);
          expect(await outcome).toBe(reason);
          expectNoLifecycleRequests(fixture);
        } else if (scenario === "deadline") {
          expect(await outcome).toMatchObject({
            message: expect.stringContaining("still has background work"),
          });
          expectNoLifecycleRequests(fixture);
        } else {
          releaseProtection();
          expect(await outcome).toMatchObject({ threadId, lifecycle: { action: "resumed" } });
          expect(fixture.request.mock.calls.map(([method]) => method)).toContain(
            "thread/unsubscribe",
          );
          expect(fixture.request.mock.calls.map(([method]) => method)).toContain("thread/resume");
        }
      } finally {
        releaseProtection();
        await outcome;
      }
    },
  );

  it("keeps the original warm policy usable after rejecting rotation during native background work", async () => {
    const sessionFile = path.join(tempDir, "warm-background-policy-session.jsonl");
    const params = fixtureParams("warm-background-policy-session.jsonl");
    const threadId = "warm-background-policy-thread";
    let pluginFingerprint = "original-plugin-policy";
    const fixture = await createFixture(async (method) => {
      if (method === "thread/start") {
        return threadStartResult(threadId);
      }
      if (method === "app/installed") {
        return { apps: [{ id: "fixture-app", enabled: true, callable: true }] };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const common = {
      client: fixture.client,
      params,
      userMcpServersEnabled: false,
      pluginThreadConfig: warmPluginConfig(() => pluginFingerprint, ["fixture-app"]),
    };
    const started = await startOrResumeThread(common);
    expect(await retainWarmThread(fixture.client, started)).toBe(true);
    const bindingBefore = await readCodexAppServerBinding(sessionFile);
    const releaseProtection = protectCodexAppServerLiveThread(fixture.client, threadId);
    fixture.request.mockClear();
    try {
      pluginFingerprint = "changed-plugin-policy";
      const failure = await startOrResumeThread(common).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AgentHarnessPreflightError);
      expect(failure).toMatchObject({
        scope: undefined,
        message: `Codex thread ${threadId} is claimed by active work; stop it first.`,
      });
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(bindingBefore);
      expectNoLifecycleRequests(fixture);

      pluginFingerprint = "original-plugin-policy";
      await expect(startOrResumeThread(common)).resolves.toMatchObject({
        threadId,
        lifecycle: { action: "resumed" },
      });
      expectNoLifecycleRequests(fixture);
      expect(fixture.client.getCloseError()).toBeUndefined();
    } finally {
      releaseProtection();
    }
  });
});
