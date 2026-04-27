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
});
