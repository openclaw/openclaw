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
import type { CodexServerNotification } from "./protocol.js";
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

describe("runCodexAppServerAttempt native hook relay retention", () => {
  beforeEach(() => {
    // Retention owns this clock; cold preparation must not consume the execution budget.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
    const relay = createCodexNativeHookRelay({
      options: { enabled: true },
      events: ["pre_tool_use"],
      agentId: undefined,
      sessionId: "active-input",
      sessionKey: undefined,
      config: {},
      runId: "active-input",
      attemptTimeoutMs: 30_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: false,
      signal: new AbortController().signal,
      hostCapabilities: host.hostCapabilities,
      nativeModelAdmission: {
        client: () => client.client,
        threadId: () => "parent-thread",
        readQualification: () => qualification,
        tools: resolveCodexNativeModelInputTools({}),
      },
      onPreToolUseFailure: () => {},
    });
    if (!relay) {
      throw new Error("Expected native input admission relay");
    }
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
        "receiver turn to be bound",
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
      await client.notify({
        method: "rawResponseItem/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-a",
          item: {
            type: "function_call_output",
            call_id: "same-active-followup",
            output: "Input declined",
          },
        },
      });

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
        await client.notify({
          method: "rawResponseItem/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-a",
            item: {
              type: "function_call_output",
              call_id: `pending-${index}`,
              output: "Input rejected",
            },
          },
        });
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
      await client.notify({
        method: "rawResponseItem/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-a",
          item: {
            type: "function_call_output",
            call_id: "abandoned-input",
            output: "Requester closed",
          },
        },
      });
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

  it.each([undefined, "callback cancelled"])(
    "releases abandoned admission capacity while preserving duplicate waiters and retained children (reason: %s)",
    async (abortReason) => {
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
      const relay = createCodexNativeHookRelay({
        options: { enabled: true },
        events: ["pre_tool_use"],
        agentId: undefined,
        sessionId: "admission-cancellation",
        sessionKey: undefined,
        config: {},
        runId: "admission-cancellation",
        attemptTimeoutMs: 30_000,
        startupTimeoutMs: 1_000,
        turnStartTimeoutMs: 1_000,
        loopDetectionPreToolUseRelay: false,
        signal: source.signal,
        hostCapabilities: host.hostCapabilities,
        onPreToolUseFailure: () => {},
      });
      if (!relay) {
        throw new Error("fixture relay missing");
      }
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
        firstAbort.abort(abortReason);
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
    },
  );

  it.each([
    {
      name: "Codex multi-agent V1",
      bindBeforeClaim: false,
      hasDeliveryScope: true,
      childThreadId: "child-v1",
      childClaim: {
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "thread-1",
        receiverThreadIds: ["child-v1"],
      },
    },
    {
      name: "Codex multi-agent V2",
      bindBeforeClaim: true,
      hasDeliveryScope: true,
      childThreadId: "child-v2",
      childClaim: {
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "child-v2",
        agentPath: "/root/child-v2",
      },
    },
    {
      name: "Codex multi-agent V2 without delivery scope",
      bindBeforeClaim: true,
      hasDeliveryScope: false,
      childThreadId: "child-v2-no-delivery",
      childClaim: {
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "child-v2-no-delivery",
        agentPath: "/root/child-v2-no-delivery",
      },
    },
  ] as const)(
    "retains and fences a live child through sessions_yield ($name)",
    async ({ bindBeforeClaim, hasDeliveryScope, childThreadId, childClaim }) => {
      const sessionFile = path.join(tempDir, `${childThreadId}-yield-session.jsonl`);
      const workspaceDir = path.join(tempDir, `${childThreadId}-yield-workspace`);
      let resolveTurnStart: ((value: undefined) => void) | undefined;
      const deferredTurnStart = new Promise<undefined>((resolve) => {
        resolveTurnStart = resolve;
      });
      const turnStarted = createDeferred<void>();
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          turnStarted.resolve();
          return await deferredTurnStart;
        }
        return undefined;
      });
      const params = createParams(sessionFile, workspaceDir);
      await attachSqliteSessionTarget(
        params,
        path.join(tempDir, `${childThreadId}-sessions.json`),
        `${childThreadId}-session`,
      );
      params.disableTools = false;
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.onAgentEvent = vi.fn();
      setCodexTestModelSupportsTools(params, true);
      const fixture = await createAdmittedHostCapabilityTestFixture(params, {
        nativeModelPolicySupport: "exact",
      });
      params.hostCapabilities = fixture.hostCapabilities;
      if (hasDeliveryScope) {
        params.agentHarnessTaskRuntimeScope = fixture.agentHarnessTaskRuntimeScope;
      }

      const beforeToolCall = vi.fn(async (event: unknown) =>
        (event as { params?: { command?: string } }).params?.command === "deny-child"
          ? { block: true, blockReason: "child policy denied" }
          : undefined,
      );
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
      );

      const run = runCodexAppServerAttempt(params, {
        nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
      });
      let relayId: string | undefined;
      try {
        await turnStarted.promise;
        if (bindBeforeClaim) {
          resolveTurnStart?.(undefined);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        const startRequest = harness.requests.find((request) => request.method === "thread/start");
        relayId = extractRelayIdFromThreadRequest(startRequest?.params);
        const preDiscoveryPayload = {
          hook_event_name: "PreToolUse",
          agent_id: childThreadId,
          cwd: workspaceDir,
          tool_name: "Bash",
          tool_use_id: `${childThreadId}-pre-discovery`,
          tool_input: { command: "allow-child" },
        };
        let firstPendingSettled = false;
        const firstPending = invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: preDiscoveryPayload,
        }).finally(() => {
          firstPendingSettled = true;
        });
        const duplicatePending = invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: { ...preDiscoveryPayload, tool_use_id: `${childThreadId}-pre-discovery-2` },
        });
        await Promise.resolve();
        expect(firstPendingSettled).toBe(false);
        expect(beforeToolCall).not.toHaveBeenCalled();
        const terminalChildThreadId = `${childThreadId}-terminal-before-claim`;
        const terminalPending = invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: { ...preDiscoveryPayload, agent_id: terminalChildThreadId },
        });
        await harness.notify({
          method: "thread/started",
          params: {
            thread: {
              id: terminalChildThreadId,
              parentThreadId: "thread-1",
              source: {
                subAgent: {
                  thread_spawn: { parent_thread_id: "thread-1", depth: 1 },
                },
              },
            },
          },
        } as CodexServerNotification);
        await harness.notify({
          method: "turn/completed",
          params: {
            threadId: terminalChildThreadId,
            turn: {
              id: `${terminalChildThreadId}-turn`,
              status: "completed",
              items: [],
              itemsView: "full",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          },
        } as CodexServerNotification);
        await expect(terminalPending).rejects.toThrow("Codex child turn completed");
        await harness.notify({
          method: "thread/started",
          params: {
            thread: {
              id: childThreadId,
              parentThreadId: "thread-1",
              source: {
                subAgent: {
                  thread_spawn: { parent_thread_id: "thread-1", depth: 1 },
                },
              },
            },
          },
        } as CodexServerNotification);
        if (childClaim.type === "collabAgentToolCall") {
          await harness.notify({
            method: "item/completed",
            params: { threadId: "thread-1", turnId: "wrong-turn", item: childClaim },
          } as unknown as CodexServerNotification);
          await harness.notify({
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: { ...childClaim, status: "failed" },
            },
          } as unknown as CodexServerNotification);
          await Promise.resolve();
          expect(firstPendingSettled).toBe(false);
          expect(beforeToolCall).not.toHaveBeenCalled();
        } else {
          await harness.notify({
            method: "item/completed",
            params: { threadId: "thread-1", turnId: "wrong-turn", item: childClaim },
          } as unknown as CodexServerNotification);
          await Promise.resolve();
          expect(firstPendingSettled).toBe(false);
          expect(beforeToolCall).not.toHaveBeenCalled();
        }
        await harness.notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: childClaim,
          },
        } as unknown as CodexServerNotification);
        // Cover both exact-turn admission paths: an already-bound owner and
        // evidence buffered before turn/start responds.
        if (!bindBeforeClaim) {
          resolveTurnStart?.(undefined);
        }
        await expect(Promise.all([firstPending, duplicatePending])).resolves.toEqual([
          { stdout: "", stderr: "", exitCode: 0 },
          { stdout: "", stderr: "", exitCode: 0 },
        ]);
        expect(beforeToolCall).toHaveBeenCalledTimes(2);

        const yieldResponse = await harness.handleServerRequest({
          id: "request-sessions-yield",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: `yield-${childThreadId}`,
            namespace: null,
            tool: "sessions_yield",
            arguments: { message: "Waiting for child" },
          },
        });
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
        fixture.closeHost();
        fixture.closeAdmission();
        await expect(
          invokeNativeHookRelay({
            provider: "codex",
            relayId,
            event: "pre_tool_use",
            rawPayload: {
              agent_id: childThreadId,
              tool_name: "Bash",
              tool_input: { command: "allow-child" },
            },
          }),
        ).resolves.toMatchObject({ exitCode: 0 });
        const denied = await invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: {
            agent_id: childThreadId,
            tool_name: "Bash",
            tool_input: { command: "deny-child" },
          },
        });
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
          await expect(
            invokeNativeHookRelay({
              provider: "codex",
              relayId,
              event: "pre_tool_use",
              rawPayload: { agent_id: agentId, tool_name: "Bash", tool_input: {} },
            }),
          ).rejects.toThrow(/not found|inactive|retained invocation/);
        }

        const childTerminal = {
          method: "turn/completed",
          params: {
            threadId: childThreadId,
            turn: {
              id: `${childThreadId}-turn`,
              status: "completed",
              items: [],
              itemsView: "full",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          },
        } as CodexServerNotification;
        await harness.notify(childTerminal);
        await nativeHookRelayUnregisterQueue.flush();
        expect(
          nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
        ).toBeUndefined();
        await expect(
          invokeNativeHookRelay({
            provider: "codex",
            relayId,
            event: "pre_tool_use",
            rawPayload: {
              agent_id: childThreadId,
              tool_name: "Bash",
              tool_input: { command: "allow-child" },
            },
          }),
        ).rejects.toThrow(/not found|inactive/);
      } finally {
        resolveTurnStart?.(undefined);
        fixture.closeHost();
        fixture.closeAdmission();
      }
    },
  );

  it("revokes a claimed child when the parent fails after sessions_yield", async () => {
    const childThreadId = "child-failed-parent";
    const sessionFile = path.join(tempDir, `${childThreadId}-session.jsonl`);
    const workspaceDir = path.join(tempDir, `${childThreadId}-workspace`);
    const turnStarted = createDeferred<void>();
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        turnStarted.resolve();
      }
    });
    const params = createParams(sessionFile, workspaceDir);
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
      await harness.notify({
        method: "thread/started",
        params: {
          thread: {
            id: childThreadId,
            parentThreadId: "thread-1",
            source: {
              subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } },
            },
          },
        },
      } as CodexServerNotification);
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "thread-1",
            receiverThreadIds: [childThreadId],
          },
        },
      } as unknown as CodexServerNotification);
      const childPayload = {
        hook_event_name: "PreToolUse",
        agent_id: childThreadId,
        cwd: workspaceDir,
        tool_name: "Bash",
        tool_use_id: `${childThreadId}-tool`,
        tool_input: { command: "allow-child" },
      };
      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: childPayload,
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(beforeToolCall).toHaveBeenCalledOnce();

      await expect(
        harness.handleServerRequest({
          id: "request-sessions-yield-before-failure",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "yield-before-failure",
            namespace: null,
            tool: "sessions_yield",
            arguments: { message: "Waiting for child" },
          },
        }),
      ).resolves.toMatchObject({ success: true });
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "failed",
            items: [],
            error: { message: "parent failed after yielding" },
          },
        },
      } as CodexServerNotification);

      const result = await run;
      expect(readAttemptTerminal(result).promptError).toContain("parent failed after yielding");
      const continuationHistory = await readCodexMirroredSessionHistoryMessages(params);
      expect(continuationHistory?.filter((message) => message.role === "custom")).toEqual([]);
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId),
      ).toBeUndefined();
      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId,
          event: "pre_tool_use",
          rawPayload: childPayload,
        }),
      ).rejects.toThrow(/not found|inactive/);
    } finally {
      fixture.closeHost();
      fixture.closeAdmission();
    }
  });
});
