import { describe, expect, it, vi } from "vitest";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { buildCodexLifecycleTerminalMeta } from "./run-attempt-lifecycle-terminal.js";

function createTerminalReleaseHarness(options?: { abortController?: AbortController }) {
  const order: string[] = [];
  const cancel = vi.fn(() => order.push("cancel"));
  const request = vi.fn(async (method: string) => {
    order.push(method);
    return {};
  });
  const resolveCompletion = vi.fn();
  const armTerminalReleaseDeadline =
    vi.fn<(input: { deadlineMs: number; onDeadline: () => void }) => void>();
  const clearTerminalReleaseDeadline = vi.fn();
  const disarmAssistantCompletionIdleWatch = vi.fn();
  const state = {
    completed: false,
    activeAppServerTurnRequests: 0,
    currentTurnHadNonTerminalDynamicToolResult: false,
    pendingTerminalDynamicToolRelease: undefined,
    terminalDynamicToolReleaseCheckScheduled: false,
    terminalReleaseAwaitingTurnCompletion: undefined as
      | {
          threadId: string;
          turnId: string;
          toolCallId: string;
          tool: string;
          interruptRequested: boolean;
        }
      | undefined,
    resolveCompletion,
  };
  const controller = createCodexAttemptLifecycleController(
    {
      prompt: {
        context: {
          runtime: {
            connection: {
              params: {},
              attemptStartedAt: 0,
              runAbortController: options?.abortController ?? new AbortController(),
              fastModeAutoProgressState: {},
            },
          },
        },
      },
      state: { client: { request } },
    } as never,
    {
      state,
      activeTurnItemIds: new Set(),
      pendingOpenClawDynamicToolCompletionIds: new Set(),
      steeringQueueRef: { current: { cancel } },
      turnWatches: {
        clearCompletionIdleTimer: vi.fn(),
        clearAssistantCompletionIdleTimer: vi.fn(),
        clearTerminalIdleTimer: vi.fn(),
        disarmAssistantCompletionIdleWatch,
        armTerminalReleaseDeadline,
        clearTerminalReleaseDeadline,
      },
    } as never,
  );
  return {
    armTerminalReleaseDeadline,
    cancel,
    clearTerminalReleaseDeadline,
    controller,
    disarmAssistantCompletionIdleWatch,
    order,
    request,
    resolveCompletion,
    state,
  };
}

function terminalYieldResult(success: boolean) {
  return {
    call: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-yield",
      tool: "sessions_yield",
      arguments: {},
    },
    response: { success, terminate: true, contentItems: [] },
    durationMs: 1,
  };
}

describe("buildCodexLifecycleTerminalMeta", () => {
  it("marks sessions_yield as a paused parent continuation", () => {
    expect(
      buildCodexLifecycleTerminalMeta({
        aborted: false,
        timedOut: false,
        yielded: true,
      }),
    ).toEqual({
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    });
  });

  it("keeps ordinary successful turns terminal", () => {
    expect(
      buildCodexLifecycleTerminalMeta({
        aborted: false,
        timedOut: false,
        yielded: false,
      }),
    ).toBeUndefined();
  });

  it("keeps cancellation stronger than a stale yield signal", () => {
    expect(
      buildCodexLifecycleTerminalMeta({
        aborted: true,
        timedOut: false,
        yielded: true,
      }),
    ).toEqual({
      aborted: true,
      status: "cancelled",
      stopReason: "stop",
    });
  });
});

async function enterAwaitingTerminalRelease(
  harness: ReturnType<typeof createTerminalReleaseHarness>,
  success = true,
) {
  harness.controller.scheduleTurnReleaseAfterTerminalDynamicTool(terminalYieldResult(success));
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function armedDeadline(harness: ReturnType<typeof createTerminalReleaseHarness>) {
  const input = harness.armTerminalReleaseDeadline.mock.lastCall?.[0];
  if (!input) {
    throw new Error("terminal release deadline was not armed");
  }
  return input;
}

describe("Codex terminal dynamic-tool release", () => {
  it("awaits natural completion instead of interrupting a successful terminal result", async () => {
    const harness = createTerminalReleaseHarness();

    await enterAwaitingTerminalRelease(harness);

    // Steering closes at final so callers fall back to a follow-up turn.
    expect(harness.cancel).toHaveBeenCalled();
    // No interrupt: the clean close must not write Codex's abort marker.
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.state.completed).toBe(false);
    expect(harness.resolveCompletion).not.toHaveBeenCalled();
    expect(harness.disarmAssistantCompletionIdleWatch).toHaveBeenCalled();
    expect(harness.armTerminalReleaseDeadline).toHaveBeenCalledOnce();
    expect(harness.armTerminalReleaseDeadline).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineMs: 10_000 }),
    );
    expect(harness.state.terminalReleaseAwaitingTurnCompletion).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-yield",
      tool: "sessions_yield",
      interruptRequested: false,
    });
  });

  it("keeps steering open when the yield result fails", async () => {
    const harness = createTerminalReleaseHarness();

    await enterAwaitingTerminalRelease(harness, false);

    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.state.completed).toBe(false);
    expect(harness.resolveCompletion).not.toHaveBeenCalled();
    expect(harness.state.terminalReleaseAwaitingTurnCompletion).toBeUndefined();
  });

  it("treats a repeat terminal release while awaiting completion as a no-op", async () => {
    const harness = createTerminalReleaseHarness();

    await enterAwaitingTerminalRelease(harness);
    await enterAwaitingTerminalRelease(harness);

    expect(harness.armTerminalReleaseDeadline).toHaveBeenCalledOnce();
    expect(harness.state.pendingTerminalDynamicToolRelease).toBeUndefined();
  });

  it("interrupts exactly once when the completion deadline fires", async () => {
    const harness = createTerminalReleaseHarness();

    await enterAwaitingTerminalRelease(harness);
    const { onDeadline } = armedDeadline(harness);
    onDeadline();
    onDeadline();

    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      { timeoutMs: 5_000 },
    );
    // Attribution flips before the RPC so terminal classification never counts
    // this OpenClaw-initiated close as a user abort.
    expect(harness.state.terminalReleaseAwaitingTurnCompletion?.interruptRequested).toBe(true);
    expect(harness.clearTerminalReleaseDeadline).toHaveBeenCalled();
    // Resolution stays with the terminal notification path.
    expect(harness.state.completed).toBe(false);
    expect(harness.resolveCompletion).not.toHaveBeenCalled();
  });

  it("lets a new inbound message interrupt ahead of the deadline exactly once", async () => {
    const harness = createTerminalReleaseHarness();

    await enterAwaitingTerminalRelease(harness);
    harness.controller.interruptTurnForTerminalRelease("new_inbound_message");
    const { onDeadline } = armedDeadline(harness);
    onDeadline();

    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.state.terminalReleaseAwaitingTurnCompletion?.interruptRequested).toBe(true);
  });

  it("skips the release interrupt once the turn already completed", async () => {
    const harness = createTerminalReleaseHarness();

    await enterAwaitingTerminalRelease(harness);
    harness.state.completed = true;
    harness.controller.interruptTurnForTerminalRelease("completion_deadline");

    expect(harness.request).not.toHaveBeenCalled();
  });

  it("skips the release interrupt when the run already aborted", async () => {
    const abortController = new AbortController();
    const harness = createTerminalReleaseHarness({ abortController });

    await enterAwaitingTerminalRelease(harness);
    abortController.abort("user_abort");
    harness.controller.interruptTurnForTerminalRelease("completion_deadline");

    expect(harness.request).not.toHaveBeenCalled();
    // A genuine abort is never re-attributed as an OpenClaw clean release.
    expect(harness.state.terminalReleaseAwaitingTurnCompletion?.interruptRequested).toBe(false);
  });

  it("does not release before any terminal result arrives", async () => {
    const harness = createTerminalReleaseHarness();

    harness.controller.interruptTurnForTerminalRelease("completion_deadline");

    expect(harness.request).not.toHaveBeenCalled();
  });
});
