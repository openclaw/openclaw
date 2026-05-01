import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentHarnessFinalizeRetryBudget,
  runAgentHarnessAgentEndHook,
  runAgentHarnessBeforeAgentFinalizeHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "./lifecycle-hook-helpers.js";

const legacyHookRunner = {
  hasHooks: () => true,
};

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
};

describe("agent harness lifecycle hook helpers", () => {
  afterEach(() => {
    clearAgentHarnessFinalizeRetryBudget();
  });

  it("ignores legacy hook runners that advertise llm_input without a runner method", () => {
    expect(() =>
      runAgentHarnessLlmInputHook({
        ctx: {},
        event: {},
        hookRunner: legacyHookRunner,
      } as never),
    ).not.toThrow();
  });

  it("ignores legacy hook runners that advertise llm_output without a runner method", () => {
    expect(() =>
      runAgentHarnessLlmOutputHook({
        ctx: {},
        event: {},
        hookRunner: legacyHookRunner,
      } as never),
    ).not.toThrow();
  });

  it("ignores legacy hook runners that advertise agent_end without a runner method", () => {
    expect(() =>
      runAgentHarnessAgentEndHook({
        ctx: {},
        event: {},
        hookRunner: legacyHookRunner,
      } as never),
    ).not.toThrow();
  });

  it("continues when legacy hook runners advertise before_agent_finalize without a runner method", async () => {
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        ctx: {},
        event: {},
        hookRunner: legacyHookRunner,
      } as never),
    ).resolves.toEqual({ action: "continue" });
  });

  it("clears finalize retry budgets by run id", async () => {
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue({
        action: "revise",
        retry: {
          instruction: "revise once",
          idempotencyKey: "stable",
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
    ).resolves.toEqual({ action: "revise", reason: "revise once" });
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "continue" });

    clearAgentHarnessFinalizeRetryBudget({ runId: "run-1" });

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "revise", reason: "revise once" });
  });

  it("does not clear finalize retry budgets for runs that only share a prefix", async () => {
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue({
        action: "revise",
        retry: {
          instruction: "revise child once",
          idempotencyKey: "stable",
          maxAttempts: 1,
        },
      }),
    };
    const childEvent = {
      ...EVENT,
      runId: "run:child",
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: childEvent,
        ctx: { runId: "run:child", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "revise", reason: "revise child once" });

    clearAgentHarnessFinalizeRetryBudget({ runId: "run" });

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: childEvent,
        ctx: { runId: "run:child", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
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

    clearAgentHarnessFinalizeRetryBudget({ runId: "run-from-context" });

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: eventWithoutRunId,
        ctx: { runId: "run-from-context", sessionKey: "agent:main:shared-session" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "revise", reason: "revise from context run" });
  });
});
