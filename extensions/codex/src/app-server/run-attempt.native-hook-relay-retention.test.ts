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
      const fixture = await createAdmittedHostCapabilityTestFixture(params);
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
    const fixture = await createAdmittedHostCapabilityTestFixture(params);
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
