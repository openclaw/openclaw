import path from "node:path";
import {
  abortAgentHarnessRun,
  invokeNativeHookRelay,
  nativeHookRelayTesting,
  registerNativeHookRelay,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  createMockPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import {
  createCodexNativeHookRelay,
  type CodexNativePreToolUseFailure,
} from "./native-hook-relay.js";
import { codexNativeHookRelayOwnerCount } from "./native-hook-relay.test-harness.js";
import type { CodexServerNotification } from "./protocol.js";
import {
  createParams,
  createStartedThreadHarness,
  extractGenerationFromThreadRequest,
  extractRelayIdFromThreadRequest,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

const flushRelayCleanup = () => nativeHookRelayUnregisterQueue.flush();
const DESCENDANT_RELAY_QUIET_WINDOW_MS = 5 * 60_000;

type DirectRelayOptions = {
  signal?: AbortSignal;
  generation?: string;
  runId?: string;
  onPreToolUseFailure?: (failure: CodexNativePreToolUseFailure) => void;
};

function createDirectRelayResult(ttlMs: number, options: DirectRelayOptions = {}) {
  const params = createParams(
    path.join(tempDir, "direct-relay-session.jsonl"),
    path.join(tempDir, "direct-relay-workspace"),
  );
  return createCodexNativeHookRelay({
    options: { enabled: true, ttlMs },
    ...(options.generation ? { generation: options.generation } : {}),
    events: ["pre_tool_use"],
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    config: params.config,
    runId: options.runId ?? params.runId,
    attemptTimeoutMs: 5_000,
    startupTimeoutMs: 5_000,
    turnStartTimeoutMs: 5_000,
    loopDetectionPreToolUseRelay: true,
    signal: options.signal ?? new AbortController().signal,
    onPreToolUseFailure: options.onPreToolUseFailure ?? vi.fn(),
  });
}

function createDirectRelay(ttlMs: number, options: DirectRelayOptions = {}) {
  const relay = createDirectRelayResult(ttlMs, options);
  if (!relay) {
    throw new Error("Expected native hook relay");
  }
  return relay;
}

function spawned(
  spawnerThreadId: string,
  spawnedThreadId: string,
  kind: "started" | "interacted" | "interrupted" = "started",
): CodexServerNotification {
  return {
    method: "item/completed",
    params: {
      threadId: spawnerThreadId,
      item: {
        id: `${spawnedThreadId}-activity`,
        type: "subAgentActivity",
        agentThreadId: spawnedThreadId,
        agentPath: spawnedThreadId,
        kind,
      },
    },
  };
}

function threadStatusChanged(
  threadId: string,
  type: "idle" | "notLoaded" | "active",
): CodexServerNotification {
  return { method: "thread/status/changed", params: { threadId, status: { type } } };
}

function childTurnStarted(childThreadId: string, turnId: string): CodexServerNotification {
  return {
    method: "turn/started",
    params: {
      threadId: childThreadId,
      turn: { id: turnId, status: "inProgress", items: [], error: null },
    },
  };
}

function childTurnCompleted(params: {
  childThreadId: string;
  turnId: string;
  status: "completed" | "interrupted";
}): CodexServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId: params.childThreadId,
      turn: {
        id: params.turnId,
        status: params.status,
        items:
          params.status === "completed"
            ? [
                {
                  id: `${params.turnId}-final`,
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "child done",
                },
              ]
            : [],
        error: null,
      },
    },
  };
}

function invokeChildTool(params: {
  relayId: string;
  generation: string;
  toolCallId: string;
  command?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}) {
  return invokeNativeHookRelay({
    provider: "codex",
    relayId: params.relayId,
    generation: params.generation,
    requireGeneration: true,
    event: "pre_tool_use",
    rawPayload: {
      hook_event_name: "PreToolUse",
      tool_name: params.toolName ?? "Bash",
      tool_use_id: params.toolCallId,
      tool_input: params.toolInput ?? { command: params.command ?? "pwd" },
    },
  });
}

function getRoute(harness: ReturnType<typeof createStartedThreadHarness>) {
  const request = harness.requests.find((entry) => entry.method === "thread/start");
  return {
    relayId: extractRelayIdFromThreadRequest(request?.params),
    generation: extractGenerationFromThreadRequest(request?.params),
  };
}

async function startRelayAttempt(name: string, relayOptions: { ttlMs?: number } = {}) {
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(
    createParams(path.join(tempDir, `${name}.jsonl`), path.join(tempDir, `${name}-workspace`)),
    { nativeHookRelay: { enabled: true, events: ["pre_tool_use"], ...relayOptions } },
  );
  await harness.waitForMethod("turn/start");
  return { harness, run, route: getRoute(harness) };
}

describe("Codex native hook relay lifecycle", () => {
  it("renews child ownership and cancels cleanup for a late child claim", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const relay = createDirectRelay(100);
    const releaseChild = relay.acquireChild("child-thread");
    relay.releaseParent({ delay: true });
    const firstExpiry = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
      relay.relayId,
    )?.expiresAtMs;
    if (firstExpiry === undefined) {
      throw new Error("Expected relay registration");
    }
    await vi.advanceTimersByTimeAsync(51);
    const secondExpiry = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
      relay.relayId,
    )?.expiresAtMs;
    if (secondExpiry === undefined) {
      throw new Error("Expected renewed relay registration");
    }
    expect(secondExpiry).toBeGreaterThan(firstExpiry);
    await vi.advanceTimersByTimeAsync(51);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId)?.expiresAtMs,
    ).toBeGreaterThan(secondExpiry);
    releaseChild?.();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(codexNativeHookRelayOwnerCount()).toBe(0);

    const lateRelay = createDirectRelay(60_000);
    lateRelay.releaseParent({ delay: true });
    const releaseLateChild = lateRelay.acquireChild("late-child");
    flushRelayCleanup();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(lateRelay.relayId),
    ).toBeDefined();
    releaseLateChild?.();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(codexNativeHookRelayOwnerCount()).toBe(0);
  });

  it("keeps policy enforcement alive after the parent completes", async () => {
    const beforeToolCall = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ block: true, blockReason: "blocked after parent completion" });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const { harness, run, route } = await startRelayAttempt("parent-complete", {
      ttlMs: 40_000,
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await harness.notify(spawned("thread-1", "child-thread"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(
      invokeChildTool({
        ...route,
        toolCallId: "child-mcp-after-parent",
        toolName: "mcp__filesystem__read_text_file",
        toolInput: { path: "README.md" },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const denied = await invokeChildTool({
      ...route,
      toolCallId: "child-deny-after-parent",
      command: "git push",
    });
    expect(JSON.parse(denied.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await harness.notify(
      childTurnCompleted({
        childThreadId: "child-thread",
        turnId: "child-turn",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("keeps child ownership after parent abort and releases on terminal", async () => {
    const { harness, run, route } = await startRelayAttempt("abort");
    await harness.notify(spawned("thread-1", "child-after-abort"));
    expect(abortAgentHarnessRun("session-1")).toBe(true);
    expect(readAttemptTerminal(await run).aborted).toBe(true);
    await expect(
      invokeChildTool({ ...route, toolCallId: "child-after-abort", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    await harness.notify(
      childTurnCompleted({
        childThreadId: "child-after-abort",
        turnId: "child-after-abort-turn",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("releases a shared route only after the last child terminal", async () => {
    const { harness, run, route } = await startRelayAttempt("multi");
    await harness.notify(spawned("thread-1", "child-a"));
    await harness.notify(spawned("thread-1", "child-b"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await harness.notify(
      childTurnCompleted({ childThreadId: "child-a", turnId: "turn-a", status: "completed" }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeDefined();
    await harness.notify(
      childTurnCompleted({ childThreadId: "child-b", turnId: "turn-b", status: "completed" }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("retains an interrupted child route until resumed terminal", async () => {
    const { harness, run, route } = await startRelayAttempt("interrupted");
    await harness.notify(spawned("thread-1", "resumable-child"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await harness.notify(
      childTurnCompleted({
        childThreadId: "resumable-child",
        turnId: "interrupted-turn",
        status: "interrupted",
      }),
    );
    flushRelayCleanup();
    await expect(
      invokeChildTool({ ...route, toolCallId: "after-interrupt", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    await harness.notify(childTurnStarted("resumable-child", "resumed-turn"));
    await harness.notify(
      childTurnCompleted({
        childThreadId: "resumable-child",
        turnId: "resumed-turn",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("retains the route for a nested descendant after its spawner settles", async () => {
    const { harness, run, route } = await startRelayAttempt("nested");
    await harness.notify(spawned("thread-1", "child-c"));
    await harness.notify(spawned("child-c", "grandchild-g"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await harness.notify(
      childTurnCompleted({ childThreadId: "child-c", turnId: "turn-c", status: "completed" }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeDefined();
    await expect(
      invokeChildTool({ ...route, toolCallId: "grandchild-tool", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    await harness.notify(
      childTurnCompleted({ childThreadId: "grandchild-g", turnId: "turn-g", status: "completed" }),
    );
    await harness.notify(threadStatusChanged("grandchild-g", "idle"));
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeDefined();
    await harness.notify(spawned("child-c", "grandchild-g", "interacted"));
    await harness.notify(childTurnStarted("grandchild-g", "turn-g2"));
    await expect(
      invokeChildTool({ ...route, toolCallId: "grandchild-tool-2", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    await harness.notify(threadStatusChanged("grandchild-g", "notLoaded"));
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("releases a nested descendant's route once it stops reporting activity", async () => {
    const { harness, run, route } = await startRelayAttempt("nested-quiet");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await harness.notify(spawned("thread-1", "quiet-child"));
    await harness.notify(spawned("quiet-child", "quiet-grandchild"));
    await harness.notify(threadStatusChanged("quiet-grandchild", "active"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await harness.notify(
      childTurnCompleted({ childThreadId: "quiet-child", turnId: "turn-c", status: "completed" }),
    );
    await vi.advanceTimersByTimeAsync(DESCENDANT_RELAY_QUIET_WINDOW_MS * 2);
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeDefined();
    await expect(
      invokeChildTool({ ...route, toolCallId: "quiet-grandchild-tool", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    await harness.notify(threadStatusChanged("quiet-grandchild", "idle"));
    await vi.advanceTimersByTimeAsync(DESCENDANT_RELAY_QUIET_WINDOW_MS + 1);
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("returns no lease for a route released inside its own constructor", () => {
    const cancelled = new AbortController();
    cancelled.abort("cancelled_before_start");
    expect(
      createDirectRelayResult(60_000, {
        signal: cancelled.signal,
        generation: "poisoned-generation",
      }),
    ).toBeUndefined();
    expect(codexNativeHookRelayOwnerCount()).toBe(0);

    const nextRelay = createDirectRelay(60_000, { generation: "poisoned-generation" });
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(nextRelay.relayId),
    ).toBeDefined();
    expect(codexNativeHookRelayOwnerCount()).toBe(1);
    const releaseWorker = nextRelay.acquireChild("worker-1");
    nextRelay.releaseParent();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(nextRelay.relayId),
    ).toBeDefined();
    releaseWorker?.();
    flushRelayCleanup();
    expect(codexNativeHookRelayOwnerCount()).toBe(0);
  });

  it("returns no lease when an adopted route releases while binding", () => {
    const generation = "adopted-release-generation";
    const first = createDirectRelay(60_000, { generation });
    const cancelled = new AbortController();
    cancelled.abort("cancelled_before_start");

    expect(
      createDirectRelayResult(60_000, { signal: cancelled.signal, generation }),
    ).toBeUndefined();
    expect(codexNativeHookRelayOwnerCount()).toBe(0);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(first.relayId),
    ).toBeUndefined();
  });

  it("re-registers a relay id that died while only a child claim remains", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const generation = "child-window-heal-generation";
    const relay = createDirectRelay(60_000, { generation });
    const releaseWorker = relay.acquireChild("worker-1");
    relay.releaseParent({ delay: true });

    registerNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      sessionId: "session-1",
      runId: "run-took-over",
    }).unregister();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId),
    ).toBeUndefined();

    await vi.advanceTimersByTimeAsync(30_001);

    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId),
    ).toBeDefined();
    await expect(
      invokeChildTool({
        relayId: relay.relayId,
        generation,
        toolCallId: "worker-after-child-window-heal",
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    releaseWorker?.();
    flushRelayCleanup();
    expect(codexNativeHookRelayOwnerCount()).toBe(0);
  });

  it("ignores a superseded attempt's late release after adoption", async () => {
    const generation = "superseded-attempt-generation";
    const first = createDirectRelay(60_000, { generation });
    const releaseWorker = first.acquireChild("worker-1");
    expect(releaseWorker).toBeDefined();

    const second = createDirectRelay(60_000, { generation });
    expect(second.relayId).toBe(first.relayId);
    expect(codexNativeHookRelayOwnerCount()).toBe(1);

    first.releaseParent({ delay: true });
    flushRelayCleanup();
    await expect(
      invokeChildTool({
        relayId: first.relayId,
        generation,
        toolCallId: "worker-after-stale-release",
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    releaseWorker?.();
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(first.relayId),
    ).toBeDefined();

    second.releaseParent();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(first.relayId),
    ).toBeUndefined();
    expect(codexNativeHookRelayOwnerCount()).toBe(0);
  });

  it("re-registers a relay id that died under a live route", async () => {
    const generation = "healed-generation";
    const first = createDirectRelay(60_000, { generation });
    const releaseWorker = first.acquireChild("worker-1");
    first.releaseParent({ delay: true });

    registerNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      sessionId: "session-1",
      runId: "run-took-over",
    }).unregister();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(first.relayId),
    ).toBeUndefined();

    const second = createDirectRelay(60_000, { generation });
    expect(second.relayId).toBe(first.relayId);
    expect(codexNativeHookRelayOwnerCount()).toBe(1);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(first.relayId),
    ).toBeDefined();
    await expect(
      invokeChildTool({ relayId: first.relayId, generation, toolCallId: "worker-after-heal" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    releaseWorker?.();
    second.releaseParent();
    flushRelayCleanup();
    expect(codexNativeHookRelayOwnerCount()).toBe(0);
  });

  it("keeps an in-flight hook's failure on the attempt that started it across adoption", async () => {
    const generation = "mid-flight-failure-generation";
    let releaseBeforeToolCall!: () => void;
    const beforeToolCallGate = new Promise<void>((resolve) => {
      releaseBeforeToolCall = resolve;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => {
            await beforeToolCallGate;
            throw new Error("hook crashed");
          },
        },
      ]),
    );
    const startingAttemptFailures = vi.fn();
    const adoptingAttemptFailures = vi.fn();
    const first = createDirectRelay(60_000, {
      generation,
      onPreToolUseFailure: startingAttemptFailures,
    });
    const releaseWorker = first.acquireChild("worker-1");

    const inFlight = invokeChildTool({
      relayId: first.relayId,
      generation,
      toolCallId: "worker-denied-mid-adoption",
    });
    const second = createDirectRelay(60_000, {
      generation,
      onPreToolUseFailure: adoptingAttemptFailures,
    });
    releaseBeforeToolCall();

    expect(JSON.parse((await inFlight).stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(startingAttemptFailures).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "worker-denied-mid-adoption", disposition: "failed" }),
    );
    expect(adoptingAttemptFailures).not.toHaveBeenCalled();

    releaseWorker?.();
    second.releaseParent();
    flushRelayCleanup();
    expect(codexNativeHookRelayOwnerCount()).toBe(0);
  });

  it("detaches the cancelled attempt's failure sink from surviving workers", async () => {
    const attempt = new AbortController();
    const attemptFailureSink = vi.fn();
    const relay = createDirectRelay(60_000, {
      signal: attempt.signal,
      generation: "detached-sink-generation",
      runId: "run-originating",
      onPreToolUseFailure: attemptFailureSink,
    });
    const releaseWorker = relay.acquireChild("worker-1");
    const currentFailureSink = () =>
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId)
        ?.onPreToolUseFailure;
    const reportFailure = (toolCallId: string, sink = currentFailureSink()): void | Promise<void> =>
      sink?.({ toolName: "exec", toolCallId, disposition: "failed", durationMs: 5 });
    await reportFailure("parent-denied");
    expect(attemptFailureSink).toHaveBeenCalledTimes(1);

    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    let adopting: ReturnType<typeof createDirectRelay> | undefined;
    try {
      attempt.abort("cancelled");
      await reportFailure("worker-denied-after-abort");
      const inFlightSink = currentFailureSink();
      adopting = createDirectRelay(60_000, {
        generation: "detached-sink-generation",
        runId: "run-adopting",
      });
      await reportFailure("worker-denied-mid-adoption", inFlightSink);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      unsubscribeDiagnostics();
    }

    expect(attemptFailureSink).toHaveBeenCalledTimes(1);
    expect(
      diagnosticEvents.flatMap((event) =>
        event.type === "tool.execution.error"
          ? [[event.toolCallId, event.runId, event.terminalReason]]
          : [],
      ),
    ).toEqual([
      ["worker-denied-after-abort", "run-originating", "failed"],
      ["worker-denied-mid-adoption", "run-originating", "failed"],
    ]);

    releaseWorker?.();
    adopting?.releaseParent();
    flushRelayCleanup();
    expect(codexNativeHookRelayOwnerCount()).toBe(0);
  });

  it.each([
    { case: "retired before the abort", generation: "retired-attempt-generation", retire: true },
    { case: "still claimed at the abort", generation: "attempt-scoped-generation", retire: false },
  ])(
    "cancels only the attempt's own hook work when it is $case",
    async ({ generation, retire }) => {
      const attempt = new AbortController();
      const relay = createDirectRelay(60_000, { signal: attempt.signal, generation });
      const registrationSignal = () =>
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId)?.signal;
      const attemptScopedSignal = registrationSignal();
      const releaseWorker = relay.acquireChild("worker-1");
      if (retire) {
        relay.releaseParent({ delay: true });
      }

      attempt.abort("cancelled");
      expect(attemptScopedSignal?.aborted).toBe(true);
      expect(
        nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId),
      ).toBeDefined();
      expect(registrationSignal()?.aborted).toBe(false);
      await expect(
        invokeChildTool({ relayId: relay.relayId, generation, toolCallId: "worker-after-abort" }),
      ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

      releaseWorker?.();
      flushRelayCleanup();
      expect(codexNativeHookRelayOwnerCount()).toBe(0);
    },
  );

  it("releases descendant claims when the app-server client closes", async () => {
    const { harness, run, route } = await startRelayAttempt("nested-close");
    await harness.notify(spawned("thread-1", "close-child"));
    await harness.notify(spawned("close-child", "close-grandchild"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await harness.notify(
      childTurnCompleted({ childThreadId: "close-child", turnId: "turn-c", status: "completed" }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeDefined();
    harness.close();
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("keeps a turn-1 worker relaying across a turn-2 attempt on the same client", async () => {
    const sessionFile = path.join(tempDir, "same-generation.jsonl");
    const workspaceDir = path.join(tempDir, "same-generation-workspace");
    const harness = createStartedThreadHarness(async (method, params) =>
      method === "thread/resume"
        ? threadStartResult((params as { threadId?: string })?.threadId ?? "thread-1")
        : undefined,
    );
    const firstRun = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await harness.waitForMethod("turn/start");
    const firstRoute = getRoute(harness);
    await harness.notify(spawned("thread-1", "first-turn-child"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await firstRun;

    const secondParams = createParams(sessionFile, workspaceDir);
    secondParams.runId = "run-2";
    const secondRun = runCodexAppServerAttempt(secondParams, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await vi.waitFor(
      () =>
        expect(harness.requests.filter((entry) => entry.method === "turn/start")).toHaveLength(2),
      fastWait,
    );
    expect(codexNativeHookRelayOwnerCount()).toBe(1);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRoute.relayId)?.runId,
    ).toBe("run-2");
    await expect(
      invokeChildTool({ ...firstRoute, toolCallId: "worker-during-turn-2", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await secondRun;
    flushRelayCleanup();
    await expect(
      invokeChildTool({ ...firstRoute, toolCallId: "worker-after-turn-2", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    await harness.notify(
      childTurnCompleted({
        childThreadId: "first-turn-child",
        turnId: "first-turn-child-terminal",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRoute.relayId),
    ).toBeUndefined();
  });
});
