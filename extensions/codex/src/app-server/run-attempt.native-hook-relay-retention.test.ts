// Codex composed native hook relay retention regression.
import path from "node:path";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import * as relayRuntime from "openclaw/plugin-sdk/native-hook-relay-runtime";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { createCodexNativeHookRelay } from "./native-hook-relay.js";
import { resolveCodexNativeModelInputTools } from "./native-model-input-tools.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  createClient,
  createRuntime,
  createNativeModelSourceFixture,
  childTurnCompletedNotification,
  directSpawnItem,
  notifyChildStarted,
  successfulSendInputOutput,
  turnStartedNotification,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
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
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

function invokeRelay(relayId: string, rawPayload: JsonObject) {
  return invokeNativeHookRelay({ provider: "codex", relayId, event: "pre_tool_use", rawPayload });
}

function childTool(agentId: string, command?: string): JsonObject {
  return { agent_id: agentId, tool_name: "Bash", tool_input: command ? { command } : {} };
}

function yieldRequest(harness: ReturnType<typeof createStartedThreadHarness>, callId: string) {
  return harness.handleServerRequest({
    id: `request-${callId}`,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId,
      namespace: null,
      tool: "sessions_yield",
      arguments: { message: "Waiting for child" },
    },
  });
}

async function yieldParams(childThreadId: string) {
  const params = createParams(
    path.join(tempDir, `${childThreadId}-session.jsonl`),
    path.join(tempDir, `${childThreadId}-workspace`),
  );
  await attachSqliteSessionTarget(
    params,
    path.join(tempDir, `${childThreadId}-sessions.json`),
    `${childThreadId}-session`,
  );
  params.disableTools = false;
  params.runtimePlan = createCodexRuntimePlanFixture();
  setCodexTestModelSupportsTools(params, true);
  const fixture = await createAdmittedHostCapabilityTestFixture(params, {
    nativeModelPolicySupport: "exact",
  });
  params.hostCapabilities = fixture.hostCapabilities;
  return { params, fixture };
}

function createRelay(
  runId: string,
  hostCapabilities: Parameters<typeof createCodexNativeHookRelay>[0]["hostCapabilities"],
  signal: AbortSignal,
  admission: Pick<
    Parameters<typeof createCodexNativeHookRelay>[0],
    "nativeModelAdmission" | "remoteCallback"
  > = {},
) {
  const relay = createCodexNativeHookRelay({
    options: { enabled: true },
    events: ["pre_tool_use"],
    agentId: undefined,
    sessionId: runId,
    sessionKey: undefined,
    config: {},
    runId,
    attemptTimeoutMs: 30_000,
    startupTimeoutMs: 1_000,
    turnStartTimeoutMs: 1_000,
    loopDetectionPreToolUseRelay: false,
    signal,
    hostCapabilities,
    onPreToolUseFailure: () => {},
    ...admission,
  });
  if (!relay) {
    throw new Error("Expected native hook relay");
  }
  return relay;
}

function inputRejected(callId: string, output: string): CodexServerNotification {
  return {
    method: "rawResponseItem/completed",
    params: {
      threadId: "parent-thread",
      turnId: "parent-a",
      item: { type: "function_call_output", call_id: callId, output },
    },
  };
}

function childStarted(id: string): CodexServerNotification {
  return {
    method: "thread/started",
    params: {
      thread: {
        id,
        parentThreadId: "thread-1",
        source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
      },
    },
  };
}

function childClaimed(item: JsonObject, turnId: string): CodexServerNotification {
  return { method: "item/completed", params: { threadId: "thread-1", turnId, item } };
}

describe("runCodexAppServerAttempt native hook relay retention", () => {
  beforeEach(() => {
    // Retention owns this clock; cold preparation must not consume the execution budget.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });

  it("reports remote cleanup failure once without rejecting relay drain", async () => {
    const host = await createAdmittedHostCapabilityTestFixture({ runId: "remote-cleanup" });
    const client = createClient();
    const request = vi.spyOn(client.client, "request").mockResolvedValue({});
    const onCleanupFailure = vi.fn();
    const relay = createRelay(
      "remote-cleanup",
      host.hostCapabilities,
      new AbortController().signal,
      {
        remoteCallback: {
          config: {
            url: "https://gateway.example/node/__openclaw__/native-hook",
            credentialDirectory: "/private/hooks",
          },
          client: client.client,
          timeoutMs: 1_000,
          onCleanupFailure,
        },
      },
    );
    try {
      await relay.prepareInvocation();
      request.mockRejectedValueOnce(new Error("filesystem unavailable"));
      relay.unregister();
      await expect(relay.drain()).resolves.toBeUndefined();
      await nativeHookRelayUnregisterQueue.flush();
      expect(onCleanupFailure).toHaveBeenCalledOnce();
      expect(onCleanupFailure.mock.calls[0]?.[0].message).toBe(
        "Could not remove the retired native hook relay credential from Codex",
      );
    } finally {
      relay.unregister();
      await relay.drain();
      client.close();
      host.closeHost();
      host.closeAdmission();
    }
  });

  it("refuses foreign V1 steering before write and fences an accepted same-turn source mismatch", async () => {
    const client = createClient();
    const qualification = {
      assertCurrent: () => {},
      hasProvider: (provider: string) => provider === "test-provider",
    };
    for (const threadId of ["parent-thread", "child-thread", "reserved-root"]) {
      const response = threadRead({ childThreadId: threadId, threadStatus: "active" });
      response.thread.modelProvider = "test-provider";
      client.setThreadRead(threadId, response);
    }
    const a = { sourceIdentity: {}, assertCurrent: vi.fn(), release: vi.fn() };
    const b = createNativeModelSourceFixture(["model-b"]);
    const first = await codexNativeSubagentMonitorRuntime.register({
      client: client.client,
      parentThreadId: "parent-thread",
      runtime: createRuntime(),
      modelSource: a,
      configurationQualification: qualification,
    });
    first.bindTurn("parent-a");
    await notifyChildStarted(client);
    await client.notify(turnStartedNotification("child-a"));
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-a",
        item: directSpawnItem("v1", "parent-thread", "child-thread"),
      },
    });
    const second = await codexNativeSubagentMonitorRuntime.register({
      client: client.client,
      parentThreadId: "parent-thread",
      modelSource: b,
      configurationQualification: qualification,
    });
    second.bindTurn("parent-b");
    const reserved = await codexNativeSubagentMonitorRuntime.register({
      client: client.client,
      parentThreadId: "reserved-root",
      modelSource: { sourceIdentity: {}, assertCurrent: vi.fn(), release: vi.fn() },
    });
    const host = await createAdmittedHostCapabilityTestFixture({ runId: "active-input" });
    const lateAdmissionSettled = createDeferred<void>();
    const register = relayRuntime.registerNativeHookRelayForBundledRuntime;
    const observeAdmission = vi
      .spyOn(relayRuntime, "registerNativeHookRelayForBundledRuntime")
      .mockImplementation((params) => {
        const admission = params.executionAdmission;
        return register(
          admission
            ? {
                ...params,
                executionAdmission: {
                  ...admission,
                  admit: async (invocation, assertSource, preparation) => {
                    try {
                      await admission.admit(invocation, assertSource, preparation);
                    } finally {
                      if (invocation.toolUseId === "abandoned-input") {
                        lateAdmissionSettled.resolve();
                      }
                    }
                  },
                },
              }
            : params,
        );
      });
    const relay = createRelay("active-input", host.hostCapabilities, new AbortController().signal, {
      nativeModelAdmission: {
        client: () => client.client,
        threadId: () => "parent-thread",
        readQualification: () => qualification,
        tools: resolveCodexNativeModelInputTools({}),
      },
    });
    const invoke = (
      turnId: string,
      callId: string,
      target = "child-thread",
      toolName = "multi_agent_v1send_input",
      signal?: AbortSignal,
    ) =>
      invokeNativeHookRelay(
        {
          provider: "codex",
          relayId: relay.relayId,
          event: "pre_tool_use",
          rawPayload: {
            session_id: "parent-thread",
            turn_id: turnId,
            tool_use_id: callId,
            tool_name: toolName,
            tool_input: { target, message: "Continue" },
          },
        },
        signal,
      );
    const request = {
      client: client.client,
      threadId: "child-thread",
      turnId: "child-a",
      parentThreadId: "parent-thread",
      parentTurnId: "parent-a",
      rootTurnId: "parent-a",
    };
    const capture = await codexNativeSubagentMonitorRuntime.captureModelSource(request);
    if (!capture) {
      throw new Error("Expected child execution custody");
    }
    try {
      expect(relay.toolMatcherForEvent("pre_tool_use")).toEqual(
        resolveCodexNativeModelInputTools({}).toSorted(),
      );
      const nativeWrite = vi.fn();
      await expect(invoke("parent-b", "denied-steer").then(nativeWrite)).rejects.toThrow(
        "same admitted model source",
      );
      expect(nativeWrite).not.toHaveBeenCalled();
      await expect(invoke("parent-b", "ambiguous-root", "parent-thread")).rejects.toThrow(
        "unambiguous receiver turn",
      );
      await expect(invoke("parent-b", "unbound-root", "reserved-root")).rejects.toThrow(
        "outside the sender's admitted tree",
      );
      expect(() => capture.assertCurrent()).not.toThrow();
      await expect(
        invoke(
          "parent-b",
          "foreign-active-followup",
          "child-thread",
          "collaborationfollowup_task",
        ).then(nativeWrite),
      ).rejects.toThrow("same admitted model source");
      expect(nativeWrite).not.toHaveBeenCalled();
      await expect(
        invoke("parent-a", "same-active-followup", "child-thread", "collaborationfollowup_task"),
      ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
      await client.notify(inputRejected("same-active-followup", "Input declined"));

      await invoke("parent-a", "initial-same-source-steer");
      await client.notify(
        successfulSendInputOutput({
          turnId: "parent-a",
          callId: "initial-same-source-steer",
          submissionId: "initial-opaque-steer",
        }),
      );

      // The accepted opaque receipt plus unresolved writes share the capacity
      // reserved before native input. Failed calls release their reservations.
      for (let index = 0; index < 31; index++) {
        await invoke("parent-a", `pending-${index}`);
      }
      await expect(invoke("parent-a", "over-capacity").then(nativeWrite)).rejects.toThrow(
        "native input admission capacity reached",
      );
      expect(nativeWrite).not.toHaveBeenCalled();
      for (let index = 0; index < 31; index++) {
        await client.notify(inputRejected(`pending-${index}`, "Input rejected"));
      }
      await expect(invoke("parent-a", "same-source-steer")).resolves.toEqual({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
      await client.notify(
        successfulSendInputOutput({
          turnId: "parent-a",
          callId: "same-source-steer",
          submissionId: "opaque-same-turn-receipt",
        }),
      );
      expect(() => capture.assertCurrent()).not.toThrow();

      // A stock V1 successful steer reports an opaque submission ID while the
      // receiver keeps its old native turn and lineage, including after a hook race.
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-b",
          item: {
            type: "collabAgentToolCall",
            tool: "sendInput",
            status: "completed",
            id: "accepted-steer",
            senderThreadId: "parent-thread",
            receiverThreadIds: ["child-thread"],
          },
        },
      });
      await expect(codexNativeSubagentMonitorRuntime.captureModelSource(request)).rejects.toThrow(
        "same admitted model source",
      );
      await client.notify(
        successfulSendInputOutput({
          turnId: "parent-b",
          callId: "accepted-steer",
          submissionId: "opaque-foreign-receipt",
        }),
      );
      expect(() => capture.assertCurrent()).toThrow("execution was cancelled");
      await expect(codexNativeSubagentMonitorRuntime.captureModelSource(request)).rejects.toThrow(
        "execution was cancelled",
      );
      await client.notify(
        childTurnCompletedNotification({ turnId: "child-a", status: "interrupted" }),
      );
      const coldTarget = threadRead({ threadStatus: "notLoaded" });
      coldTarget.thread.modelProvider = "unqualified-provider";
      client.setThreadRead("child-thread", coldTarget);
      await expect(
        invoke(
          "parent-b",
          "denied-cold-followup",
          "child-thread",
          "collaborationfollowup_task",
        ).then(nativeWrite),
      ).rejects.toThrow("does not admit this model");
      expect(nativeWrite).not.toHaveBeenCalled();
      const warmTarget = threadRead({ threadStatus: "idle" });
      warmTarget.thread.modelProvider = "test-provider";
      client.setThreadRead("child-thread", warmTarget);

      const entered = createDeferred<void>();
      const lateRead = createDeferred<ReturnType<typeof threadRead>>();
      client.setThreadReadFactory("child-thread", () => {
        entered.resolve();
        return lateRead.promise;
      });
      const requester = new AbortController();
      const abandoned = invoke(
        "parent-a",
        "abandoned-input",
        "child-thread",
        "collaborationfollowup_task",
        requester.signal,
      );
      await Promise.race([
        entered.promise,
        abandoned.then(() => {
          throw new Error("Native input returned before its metadata read");
        }),
      ]);
      requester.abort(new Error("native hook requester closed"));
      await expect(abandoned).rejects.toMatchObject({
        name: "AbortError",
        cause: requester.signal.reason,
      });
      await client.notify(inputRejected("abandoned-input", "Requester closed"));
      lateRead.resolve(warmTarget);
      await lateAdmissionSettled.promise;
      client.setThreadRead("child-thread", warmTarget);
      await invoke(
        "parent-b",
        "followup-after-a",
        "child-thread",
        "collaborationfollowup_task",
      ).then(nativeWrite);
      expect(nativeWrite).toHaveBeenCalledOnce();
      await expect(
        invoke("parent-a", "incompatible-pending", "child-thread", "collaborationfollowup_task"),
      ).rejects.toThrow("same admitted model source");
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-b",
          item: {
            type: "subAgentActivity",
            kind: "interacted",
            id: "followup-after-a",
            agentThreadId: "child-thread",
            agentPath: "/root/child-thread",
          },
        },
      });
      await client.notify(turnStartedNotification("child-b"));
      const next = await codexNativeSubagentMonitorRuntime.captureModelSource({
        ...request,
        turnId: "child-b",
        parentTurnId: "parent-b",
        rootTurnId: "parent-b",
      });
      expect(next?.source).toBe(b);
      next?.release();
    } finally {
      observeAdmission.mockRestore();
      capture.release();
      relay.unregister();
      await relay.drain();
      await first.unregister();
      await second.unregister();
      await reserved.unregister();
      client.close();
      host.closeHost();
      host.closeAdmission();
    }
    expect(a.release).toHaveBeenCalledOnce();
    expect(b.release).toHaveBeenCalledOnce();
  });

  it("releases abandoned admission capacity while preserving duplicate waiters and retained children", async () => {
    const host = await createAdmittedHostCapabilityTestFixture({
      runId: "admission-cancellation",
    });
    const source = new AbortController();
    const admissionWaits = new Map<string, Promise<unknown>[]>();
    const register = relayRuntime.registerNativeHookRelayForBundledRuntime;
    vi.spyOn(relayRuntime, "registerNativeHookRelayForBundledRuntime").mockImplementation(
      (params) => {
        const retention = params.retention;
        if (!retention?.awaitForegroundAdmission) {
          throw new Error("fixture admission missing");
        }
        const admit = retention.awaitForegroundAdmission;
        return register({
          ...params,
          retention: {
            ...retention,
            awaitForegroundAdmission: (child, signal) => {
              const waiting = admit(child, signal);
              void waiting.catch(() => undefined);
              admissionWaits.set(child, [...(admissionWaits.get(child) ?? []), waiting]);
              return waiting;
            },
          },
        });
      },
    );
    const relay = createRelay("admission-cancellation", host.hostCapabilities, source.signal);
    const pending: Promise<unknown>[] = [];
    const invoke = (child: string, signal?: AbortSignal) => {
      const invocation = invokeNativeHookRelay(
        {
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
          event: "pre_tool_use",
          rawPayload: {
            agent_id: child,
            tool_name: "Bash",
            tool_input: { command: "echo fixture" },
          },
        },
        signal,
      );
      void invocation.catch(() => undefined);
      pending.push(invocation);
      return invocation;
    };
    let releaseChild: (() => void) | undefined;
    try {
      await relay.ready;
      const firstAbort = new AbortController();
      const duplicateAbort = new AbortController();
      const first = invoke("pending-0", firstAbort.signal);
      const duplicate = invoke("pending-0", duplicateAbort.signal);
      for (let i = 1; i < 32; i++) {
        void invoke(`pending-${i}`);
      }
      // The rejected 33rd distinct child proves all earlier waits reached admission.
      await expect(invoke("over-capacity")).rejects.toThrow("capacity reached");
      expect(admissionWaits.get("pending-0")).toHaveLength(2);
      firstAbort.abort("callback cancelled");
      await expect(first).rejects.toThrow(/abort/i);
      await expect(admissionWaits.get("pending-0")![0]).rejects.toBeInstanceOf(Error);
      await expect(invoke("still-over-capacity")).rejects.toThrow("capacity reached");
      duplicateAbort.abort();
      await expect(duplicate).rejects.toThrow(/abort/i);
      await Promise.allSettled(admissionWaits.get("pending-0")!);
      const replacement = invoke("replacement-child");
      await expect(invoke("capacity-control")).rejects.toThrow("capacity reached");
      releaseChild = relay.claimDirectChild("replacement-child");
      await expect(replacement).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
      relay.authorizeRetentionAfterSuccessfulYield();
      relay.unregister();
      await expect(invoke("replacement-child")).resolves.toEqual({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
      releaseChild();
      releaseChild = undefined;
      await expect(invoke("replacement-child")).rejects.toThrow(/not found|inactive/);
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId),
      ).toBeUndefined();
    } finally {
      releaseChild?.();
      relay.unregister();
      source.abort();
      await Promise.allSettled(pending);
      await relay.drain();
      await nativeHookRelayUnregisterQueue.flush();
      host.closeHost();
      host.closeAdmission();
    }
  });

  it.each([
    {
      name: "V1 before turn binding",
      version: "v1",
      bindBeforeClaim: false,
      hasDeliveryScope: true,
    },
    {
      name: "V2 without delivery scope",
      version: "v2",
      bindBeforeClaim: true,
      hasDeliveryScope: false,
    },
  ] as const)(
    "retains and fences a live child through sessions_yield ($name)",
    async ({ version, bindBeforeClaim, hasDeliveryScope }) => {
      const childThreadId = `child-${version}`;
      const childClaim = directSpawnItem(version, "thread-1", childThreadId);
      const deferredTurnStart = createDeferred<undefined>();
      const turnStarted = createDeferred<void>();
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          turnStarted.resolve();
          return await deferredTurnStart.promise;
        }
        return undefined;
      });
      const { params, fixture } = await yieldParams(childThreadId);
      params.onAgentEvent = vi.fn();
      if (hasDeliveryScope) {
        params.agentHarnessCompletionScope = fixture.agentHarnessCompletionScope;
      }

      const beforeToolCall = vi.fn(async (event: unknown) =>
        (event as { params?: { command?: string } }).params?.command === "deny-child"
          ? { block: true, blockReason: "child policy denied" }
          : undefined,
      );
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
      );

      const remote = version === "v1";
      const run = runCodexAppServerAttempt(params, {
        nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
        ...(remote
          ? {
              pluginConfig: {
                appServer: {
                  nativeHookRelay: {
                    url: "https://gateway.example/node/__openclaw__/native-hook",
                    credentialDirectory: "/home/node/.native-hooks",
                  },
                },
              },
            }
          : {}),
      });
      let relayId: string | undefined;
      try {
        await Promise.race([
          turnStarted.promise,
          run.then((result) => {
            throw new Error(
              `Attempt ended before turn/start: ${String(readAttemptTerminal(result).promptError)}`,
            );
          }),
        ]);
        if (bindBeforeClaim) {
          deferredTurnStart.resolve(undefined);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        const startRequest = harness.requests.find((request) => request.method === "thread/start");
        relayId = extractRelayIdFromThreadRequest(startRequest?.params);
        if (remote) {
          expect(JSON.stringify(startRequest?.params)).toContain("--remote-credential");
          expect(JSON.stringify(startRequest?.params)).not.toContain("--state-db");
          const methods = harness.requests.map(({ method }) => method);
          expect(methods.indexOf("fs/writeFile")).toBeLessThan(methods.indexOf("thread/start"));
        }
        const preDiscoveryPayload = {
          hook_event_name: "PreToolUse",
          agent_id: childThreadId,
          cwd: params.workspaceDir,
          tool_name: "Bash",
          tool_use_id: `${childThreadId}-pre-discovery`,
          tool_input: { command: "allow-child" },
        };
        let firstPendingSettled = false;
        const firstPending = invokeRelay(relayId, preDiscoveryPayload).finally(() => {
          firstPendingSettled = true;
        });
        const duplicatePending = invokeRelay(relayId, {
          ...preDiscoveryPayload,
          tool_use_id: `${childThreadId}-pre-discovery-2`,
        });
        await Promise.resolve();
        expect(firstPendingSettled).toBe(false);
        expect(beforeToolCall).not.toHaveBeenCalled();
        const terminalChildThreadId = `${childThreadId}-terminal-before-claim`;
        const terminalPending = invokeRelay(relayId, {
          ...preDiscoveryPayload,
          agent_id: terminalChildThreadId,
        });
        await harness.notify(childStarted(terminalChildThreadId));
        await harness.notify(
          childTurnCompletedNotification({
            threadId: terminalChildThreadId,
            turnId: `${terminalChildThreadId}-turn`,
            status: "completed",
          }),
        );
        await expect(terminalPending).rejects.toThrow("Codex child turn completed");
        await harness.notify(childStarted(childThreadId));
        await harness.notify(childClaimed(childClaim, "wrong-turn"));
        if (version === "v1") {
          await harness.notify(
            itemNotification("item/completed", { ...childClaim, status: "failed" }),
          );
        }
        await Promise.resolve();
        expect(firstPendingSettled).toBe(false);
        expect(beforeToolCall).not.toHaveBeenCalled();
        await harness.notify(itemNotification("item/completed", childClaim));
        // Cover both exact-turn admission paths: an already-bound owner and
        // evidence buffered before turn/start responds.
        if (!bindBeforeClaim) {
          deferredTurnStart.resolve(undefined);
        }
        await expect(Promise.all([firstPending, duplicatePending])).resolves.toEqual([
          { stdout: "", stderr: "", exitCode: 0 },
          { stdout: "", stderr: "", exitCode: 0 },
        ]);
        expect(beforeToolCall).toHaveBeenCalledTimes(2);

        const yieldResponse = await yieldRequest(harness, `yield-${childThreadId}`);
        expect(yieldResponse).toMatchObject({ success: true, contentItems: expect.any(Array) });

        // The app-server response intentionally exposes only protocol content; the internal
        // terminate marker schedules the turn release on the next macrotask.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        const result = await run;
        expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, promptError: null });
        expect(result.runtimeContinuationStarted).toBe(hasDeliveryScope ? true : undefined);
        const continuationHistory = await readCodexMirroredSessionHistoryMessages(params);
        expect(continuationHistory?.filter((message) => message.role === "custom")).toEqual([
          expect.objectContaining({
            customType: "openclaw.sessions_yield",
            content:
              "Waiting for child\n\n[Context: The previous turn ended intentionally via sessions_yield while waiting for a follow-up event.]",
            display: false,
            details: { source: "sessions_yield", message: "Waiting for child" },
          }),
        ]);
        const terminalLifecycleEvents = (params.onAgentEvent as ReturnType<typeof vi.fn>).mock.calls
          .map(([event]) => event as { stream?: string; data?: Record<string, unknown> })
          .filter(
            (event) =>
              event.stream === "lifecycle" &&
              (event.data?.phase === "end" || event.data?.phase === "error"),
          );
        expect(terminalLifecycleEvents).toHaveLength(1);
        expect(terminalLifecycleEvents[0]?.data).toMatchObject({
          phase: "end",
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
        });
        expect(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
        ).toBeDefined();
        if (remote) {
          expect(harness.requests.some(({ method }) => method === "fs/remove")).toBe(false);
        }
        fixture.closeHost();
        fixture.closeAdmission();
        await expect(
          invokeRelay(relayId, childTool(childThreadId, "allow-child")),
        ).resolves.toMatchObject({ exitCode: 0 });
        const denied = await invokeRelay(relayId, childTool(childThreadId, "deny-child"));
        expect(JSON.parse(denied.stdout)).toMatchObject({
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: "child policy denied",
          },
        });
        expect(beforeToolCall).toHaveBeenCalledTimes(5);
        expect(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
        ).toBeDefined();
        for (const agentId of ["unknown-child", `${childThreadId}/nested`]) {
          await expect(invokeRelay(relayId, childTool(agentId))).rejects.toThrow(
            /not found|inactive|retained invocation/,
          );
        }

        const childTerminal = childTurnCompletedNotification({
          threadId: childThreadId,
          turnId: `${childThreadId}-turn`,
          status: "completed",
        });
        await harness.notify(childTerminal);
        await nativeHookRelayUnregisterQueue.flush();
        if (remote) {
          expect(harness.requests.filter(({ method }) => method === "fs/remove")).toHaveLength(1);
        }
        expect(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
        ).toBeUndefined();
        await expect(invokeRelay(relayId, childTool(childThreadId, "allow-child"))).rejects.toThrow(
          /not found|inactive/,
        );
      } finally {
        deferredTurnStart.resolve(undefined);
        fixture.closeHost();
        fixture.closeAdmission();
      }
    },
  );

  it("revokes a claimed child when the parent fails after sessions_yield", async () => {
    const childThreadId = "child-failed-parent";
    const turnStarted = createDeferred<void>();
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        turnStarted.resolve();
      }
    });
    const { params, fixture } = await yieldParams(childThreadId);

    const beforeToolCall = vi.fn(async () => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );

    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    try {
      await turnStarted.promise;
      const startRequest = harness.requests.find((request) => request.method === "thread/start");
      const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
      await harness.notify(childStarted(childThreadId));
      await harness.notify(
        itemNotification("item/completed", directSpawnItem("v1", "thread-1", childThreadId)),
      );
      const childPayload = {
        hook_event_name: "PreToolUse",
        agent_id: childThreadId,
        cwd: params.workspaceDir,
        tool_name: "Bash",
        tool_use_id: `${childThreadId}-tool`,
        tool_input: { command: "allow-child" },
      };
      await expect(invokeRelay(relayId, childPayload)).resolves.toMatchObject({ exitCode: 0 });
      expect(beforeToolCall).toHaveBeenCalledOnce();

      await expect(yieldRequest(harness, "yield-before-failure")).resolves.toMatchObject({
        success: true,
      });
      await harness.notify(
        turnCompleted({
          id: "turn-1",
          status: "failed",
          error: { message: "parent failed after yielding" },
        }),
      );

      const result = await run;
      expect(readAttemptTerminal(result).promptError).toContain("parent failed after yielding");
      const continuationHistory = await readCodexMirroredSessionHistoryMessages(params);
      expect(continuationHistory?.filter((message) => message.role === "custom")).toEqual([]);
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
      ).toBeUndefined();
      await expect(invokeRelay(relayId, childPayload)).rejects.toThrow(/not found|inactive/);
    } finally {
      fixture.closeHost();
      fixture.closeAdmission();
    }
  });
});
