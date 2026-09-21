// Exercises harness lifecycle hook adapters and finalize-retry budget semantics.
import { afterEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => loggerMocks),
}));

import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
  runAgentHarnessBeforeAgentFinalizeHook,
  runAgentHarnessBeforeAgentRun,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "./lifecycle-hook-helpers.js";

const createLegacyHookRunner = () => ({
  hasHooks: vi.fn(() => true),
});

const EVENT = {
  runId: "run-1",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  turnId: "turn-1",
  provider: "codex",
  model: "gpt-5.4",
  cwd: "/repo",
  transcriptPath: "/tmp/session.jsonl",
  stopHookActive: false,
  lastAssistantMessage: "done",
  messages: [],
  success: true,
};

describe("agent harness lifecycle hook helpers", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("openclaw.pluginFinalizeRetryBudget"));
    loggerMocks.warn.mockClear();
  });

  it("ignores legacy hook runners that advertise llm_input without a runner method", () => {
    const hookRunner = createLegacyHookRunner();
    runAgentHarnessLlmInputHook({
      ctx: {},
      event: {},
      hookRunner,
    } as never);
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("llm_input");
  });

  it("ignores legacy hook runners that advertise llm_output without a runner method", () => {
    const hookRunner = createLegacyHookRunner();
    runAgentHarnessLlmOutputHook({
      ctx: {},
      event: {},
      hookRunner,
    } as never);
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("llm_output");
  });

  it("ignores legacy hook runners that advertise agent_end without a runner method", () => {
    const hookRunner = createLegacyHookRunner();
    runAgentHarnessAgentEndHook({
      ctx: {},
      event: {},
      hookRunner,
    } as never);
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("agent_end");
  });

  it("resolves after agent_end hooks settle", async () => {
    let releaseHook: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
      runAgentEnd: vi.fn(() => agentEndSettled),
    };

    const run = awaitAgentHarnessAgentEndHook({
      ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
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
      ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
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

  it("continues when legacy hook runners advertise before_agent_finalize without a runner method", async () => {
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        ctx: {},
        event: {},
        hookRunner: createLegacyHookRunner(),
      } as never),
    ).resolves.toEqual({ action: "continue" });
  });

  it("keys finalize retry budgets by context run id when the event omits run id", async () => {
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue({
        action: "revise",
        retry: {
          instruction: "revise from context run",
          idempotencyKey: "stable",
          maxAttempts: 1,
        },
      }),
    };
    const eventWithoutRunId = {
      ...EVENT,
      runId: undefined,
      sessionId: "shared-session",
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: eventWithoutRunId,
        ctx: { runId: "run-from-context", sessionKey: "agent:main:shared-session" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "revise", reason: "revise from context run" });
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: eventWithoutRunId,
        ctx: { runId: "run-from-context", sessionKey: "agent:main:shared-session" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "continue" });
  });

  it("preserves merged revise reasons when retry metadata is present", async () => {
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue({
        action: "revise",
        reason: "fix generated baseline\n\nrerun the focused tests",
        retry: {
          instruction: "rerun the focused tests",
          idempotencyKey: "merged-reason",
          maxAttempts: 1,
        },
      }),
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: "fix generated baseline\n\nrerun the focused tests",
    });
  });

  it("honors a later finalize retry candidate after an earlier candidate is spent", async () => {
    const firstRetry = {
      instruction: "regenerate artifacts",
      idempotencyKey: "artifacts",
      maxAttempts: 1,
    };
    const secondRetry = {
      instruction: "rerun focused tests",
      idempotencyKey: "tests",
      maxAttempts: 1,
    };
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
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue(result),
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: "retry generated artifacts\n\nretry focused tests\n\nregenerate artifacts",
    });
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: "retry generated artifacts\n\nretry focused tests\n\nrerun focused tests",
    });
  });

  it("falls back to retry instruction keys when retry idempotency keys are malformed", async () => {
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue({
        action: "revise",
        retry: {
          instruction: "retry with a safe key",
          idempotencyKey: { invalid: true },
          maxAttempts: 1,
        } as never,
      }),
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: "retry with a safe key",
    });
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "continue" });
  });

  it("passes when no before_agent_run gate is registered", async () => {
    const hookRunner = { hasHooks: vi.fn(() => false) };

    await expect(
      runAgentHarnessBeforeAgentRun({
        event: { prompt: "hello", messages: [] },
        ctx: {},
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ outcome: "pass" });
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("before_agent_run");
  });

  it("fails closed when a runner advertises before_agent_run without a callable runner method", async () => {
    // before_agent_run is a fail-closed gate. A registered hook that the runner
    // cannot execute must never be treated the same as no hook being registered
    // at all (unlike the best-effort hooks above), or a real admission policy
    // would silently never run.
    const hookRunner = createLegacyHookRunner();

    await expect(
      runAgentHarnessBeforeAgentRun({
        event: { prompt: "hello", messages: [] },
        ctx: {},
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      outcome: "block",
      blockedBy: "before_agent_run",
      message: "Your message could not be sent: blocked by before_agent_run",
    });
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("before_agent_run");
  });

  it("passes an admitted attempt through to the model start path", async () => {
    const runBeforeAgentRun = vi.fn().mockResolvedValue({
      decision: { outcome: "pass" },
      pluginId: "policy",
    });
    const hookRunner = { hasHooks: () => true, runBeforeAgentRun };

    await expect(
      runAgentHarnessBeforeAgentRun({
        event: { prompt: "hello", messages: [] },
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ outcome: "pass" });
    expect(runBeforeAgentRun).toHaveBeenCalledTimes(1);
    expect(runBeforeAgentRun).toHaveBeenCalledWith(
      { prompt: "hello", messages: [] },
      expect.objectContaining({ runId: "run-1", sessionKey: "agent:main:session-1" }),
    );
  });

  it("blocks and reports the denying plugin when the gate returns a block decision", async () => {
    const runBeforeAgentRun = vi.fn().mockResolvedValue({
      decision: { outcome: "block", reason: "unsafe input", message: "Request blocked." },
      pluginId: "policy",
    });
    const hookRunner = { hasHooks: () => true, runBeforeAgentRun };

    await expect(
      runAgentHarnessBeforeAgentRun({
        event: { prompt: "hello", messages: [] },
        ctx: {},
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      outcome: "block",
      blockedBy: "policy",
      message: "Your message could not be sent: Request blocked. (blocked by policy)",
    });
  });

  it("fails closed when the gate hook throws", async () => {
    const runBeforeAgentRun = vi.fn().mockRejectedValue(new Error("policy unavailable"));
    const hookRunner = { hasHooks: () => true, runBeforeAgentRun };

    await expect(
      runAgentHarnessBeforeAgentRun({
        event: { prompt: "hello", messages: [] },
        ctx: {},
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      outcome: "block",
      blockedBy: "before_agent_run",
      message: "Your message could not be sent: blocked by before_agent_run",
    });
  });

  it("never logs hook exception text, even when it carries sensitive detail", async () => {
    const sensitiveSentinel = "SENTINEL-9f1c-do-not-log-ssn-078-05-1120";
    const runBeforeAgentRun = vi
      .fn()
      .mockRejectedValue(new Error(`policy lookup failed for ${sensitiveSentinel}`));
    const hookRunner = { hasHooks: () => true, runBeforeAgentRun };

    const outcome = await runAgentHarnessBeforeAgentRun({
      event: { prompt: "hello", messages: [] },
      ctx: {},
      hookRunner: hookRunner as never,
    });

    expect(outcome).toEqual({
      outcome: "block",
      blockedBy: "before_agent_run",
      message: "Your message could not be sent: blocked by before_agent_run",
    });
    expect(JSON.stringify(outcome)).not.toContain(sensitiveSentinel);
    for (const call of loggerMocks.warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(sensitiveSentinel);
    }
    expect(loggerMocks.warn).toHaveBeenCalledWith("before_agent_run hook failed; blocking request");
  });

  it("fails closed when the gate hook times out", async () => {
    const runBeforeAgentRun = vi.fn().mockRejectedValue(new Error("hook timed out after 15000ms"));
    const hookRunner = { hasHooks: () => true, runBeforeAgentRun };

    await expect(
      runAgentHarnessBeforeAgentRun({
        event: { prompt: "hello", messages: [] },
        ctx: {},
        hookRunner: hookRunner as never,
      }),
    ).resolves.toMatchObject({ outcome: "block", blockedBy: "before_agent_run" });
  });

  it("fails closed when the gate returns a malformed decision", async () => {
    // The core hook runner already normalizes undefined/invalid decisions to a
    // block outcome (fail-closed policy for before_agent_run); this proves the
    // harness helper does not second-guess that normalized result.
    const runBeforeAgentRun = vi.fn().mockResolvedValue({
      decision: { outcome: "block", reason: "before_agent_run returned an invalid decision" },
      pluginId: "unknown",
    });
    const hookRunner = { hasHooks: () => true, runBeforeAgentRun };

    await expect(
      runAgentHarnessBeforeAgentRun({
        event: { prompt: "hello", messages: [] },
        ctx: {},
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      outcome: "block",
      blockedBy: "unknown",
      message: "Your message could not be sent: blocked by unknown",
    });
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
          retry: {
            instruction: firstInstruction,
            idempotencyKey: { invalid: true },
            maxAttempts: 1,
          },
        })
        .mockResolvedValueOnce({
          action: "revise",
          retry: {
            instruction: secondInstruction,
            idempotencyKey: { invalid: true },
            maxAttempts: 1,
          },
        }),
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: firstInstruction,
    });
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: secondInstruction,
    });
  });
});
