import { afterEach, describe, expect, it, vi } from "vitest";
const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
  runAgentHarnessBeforeAgentFinalizeHook,
} from "./lifecycle-hook-helpers.js";
import { bindAgentHarnessHookMessages } from "./lifecycle-hook-messages.js";

const EVENT = {
  runId: "run-1",
  sessionId: "session-1",
  stopHookActive: false,
  messages: [],
  success: true,
};

const ctx = { runId: "run-1", sessionKey: "agent:main:session-1" };
function finalize(
  hookRunner: Parameters<typeof runAgentHarnessBeforeAgentFinalizeHook>[0]["hookRunner"],
  event: Parameters<typeof runAgentHarnessBeforeAgentFinalizeHook>[0]["event"] = EVENT,
  context = ctx,
) {
  return runAgentHarnessBeforeAgentFinalizeHook({ event, ctx: context, hookRunner });
}
function finalizer(result: unknown, event: Parameters<typeof finalize>[1] = EVENT, context = ctx) {
  const hookRunner = {
    hasHooks: () => true,
    runBeforeAgentFinalize: vi.fn().mockResolvedValue(result),
  };
  return () => finalize(hookRunner as never, event, context);
}
function retry<Key>(instruction: string, idempotencyKey: Key) {
  return { instruction, idempotencyKey, maxAttempts: 1 };
}

describe("agent harness lifecycle hook helpers", () => {
  afterEach(() => {
    log.warn.mockClear();
    Reflect.deleteProperty(globalThis, Symbol.for("openclaw.pluginFinalizeRetryBudget"));
  });

  it.each(["agent_end", "before_agent_finalize"] as const)(
    "loads %s evidence only for its subscriber and skips delivery when loading fails",
    async (hook) => {
      const messages = [{ role: "custom", content: "canonical evidence" }];
      const dispatch = vi.fn(async (_event: { messages?: unknown[] }) => undefined);
      const loadMessages = vi.fn(async () => messages);
      let enabled = false;
      const params = {
        ctx: { runId: EVENT.runId },
        event: EVENT,
        hookRunner: {
          hasHooks: () => enabled,
          runAgentEnd: dispatch,
          runBeforeAgentFinalize: dispatch,
        } as never,
      };
      const run = () => {
        bindAgentHarnessHookMessages(params.event, loadMessages);
        return hook === "agent_end"
          ? awaitAgentHarnessAgentEndHook(params)
          : runAgentHarnessBeforeAgentFinalizeHook(params);
      };
      await run();
      expect(loadMessages).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      enabled = true;
      loadMessages.mockRejectedValueOnce(new Error("transcript owner retired"));
      await run();
      expect(dispatch).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(`${hook} hook failed: Error: transcript owner retired`);
      await run();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ messages });
      expect(EVENT.messages).toEqual([]);
    },
  );

  it("resolves after agent_end hooks settle", async () => {
    const { promise: agentEndSettled, resolve: releaseHook } = Promise.withResolvers<void>();
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
      runAgentEnd: vi.fn(() => agentEndSettled),
    };

    const run = awaitAgentHarnessAgentEndHook({
      ctx,
      event: EVENT,
      hookRunner: hookRunner as never,
    });
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    expect(hookRunner.runAgentEnd).toHaveBeenCalledWith(
      EVENT,
      expect.objectContaining({ runId: "run-1", sessionKey: "agent:main:session-1" }),
      { unrefTimeout: false },
    );
    expect(resolved).toBe(false);
    releaseHook();
    await expect(run).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("can leave agent_end timeouts unref'd for fire-and-forget callers", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
      runAgentEnd: vi.fn(async () => undefined),
    };

    runAgentHarnessAgentEndHook({
      ctx,
      event: EVENT,
      hookRunner: hookRunner as never,
    });
    await Promise.resolve();

    expect(hookRunner.runAgentEnd).toHaveBeenCalledWith(
      EVENT,
      expect.objectContaining({ runId: "run-1", sessionKey: "agent:main:session-1" }),
      { unrefTimeout: true },
    );
  });

  it("keys finalize retry budgets by context run id when the event omits run id", async () => {
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue({
        action: "revise",
        retry: retry("revise from context run", "stable"),
      }),
    };
    const eventWithoutRunId = {
      ...EVENT,
      runId: undefined,
      sessionId: "shared-session",
    };

    const run = () =>
      finalize(hookRunner as never, eventWithoutRunId, {
        runId: "run-from-context",
        sessionKey: "agent:main:shared-session",
      });
    await expect(run()).resolves.toEqual({ action: "revise", reason: "revise from context run" });
    await expect(run()).resolves.toEqual({ action: "continue" });
  });

  it("preserves merged revise reasons when retry metadata is present", async () => {
    const run = finalizer({
      action: "revise",
      reason: "fix generated baseline\n\nrerun the focused tests",
      retry: retry("rerun the focused tests", "merged-reason"),
    });

    await expect(run()).resolves.toEqual({
      action: "revise",
      reason: "fix generated baseline\n\nrerun the focused tests",
    });
  });

  it("honors a later finalize retry candidate after an earlier candidate is spent", async () => {
    const firstRetry = retry("regenerate artifacts", "artifacts");
    const secondRetry = retry("rerun focused tests", "tests");
    const result = {
      action: "revise",
      reason: "retry generated artifacts\n\nretry focused tests",
      retry: firstRetry,
    };
    // retryCandidates is intentionally non-enumerable in production hook
    // results, so callers do not serialize internal retry bookkeeping.
    Object.defineProperty(result, "retryCandidates", {
      enumerable: false,
      value: [firstRetry, secondRetry],
    });
    const run = finalizer(result);

    await expect(run()).resolves.toEqual({
      action: "revise",
      reason: "retry generated artifacts\n\nretry focused tests\n\nregenerate artifacts",
    });
    await expect(run()).resolves.toEqual({
      action: "revise",
      reason: "retry generated artifacts\n\nretry focused tests\n\nrerun focused tests",
    });
  });

  it("falls back to retry instruction keys when retry idempotency keys are malformed", async () => {
    const run = finalizer({
      action: "revise",
      retry: retry("retry with a safe key", { invalid: true }) as never,
    });

    await expect(run()).resolves.toEqual({
      action: "revise",
      reason: "retry with a safe key",
    });
    await expect(run()).resolves.toEqual({ action: "continue" });
  });

  it("does not collide fallback retry keys for long instructions with shared prefixes", async () => {
    // Fallback keys include a digest of the full instruction. Prefix-only
    // truncation would spend unrelated long retry requests together.
    const sharedPrefix = "x".repeat(180);
    const firstInstruction = `${sharedPrefix} first`;
    const secondInstruction = `${sharedPrefix} second`;
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi
        .fn()
        .mockResolvedValueOnce({
          action: "revise",
          retry: retry(firstInstruction, { invalid: true }),
        })
        .mockResolvedValueOnce({
          action: "revise",
          retry: retry(secondInstruction, { invalid: true }),
        }),
    };

    await expect(finalize(hookRunner as never)).resolves.toEqual({
      action: "revise",
      reason: firstInstruction,
    });
    await expect(finalize(hookRunner as never)).resolves.toEqual({
      action: "revise",
      reason: secondInstruction,
    });
  });
});
