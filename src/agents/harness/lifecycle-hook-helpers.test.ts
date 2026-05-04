import { describe, expect, it, vi } from "vitest";
import {
  runAgentHarnessAgentEndHook,
  runAgentHarnessBeforeAgentFinalizeHook,
  runAgentHarnessBeforeModelCallHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "./lifecycle-hook-helpers.js";

const legacyHookRunner = {
  hasHooks: () => true,
};

describe("agent harness lifecycle hook helpers", () => {
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

  it("continues when legacy hook runners advertise before_model_call without a runner method", async () => {
    await expect(
      runAgentHarnessBeforeModelCallHook({
        ctx: {},
        event: {},
        hookRunner: legacyHookRunner,
      } as never),
    ).resolves.toEqual({ action: "continue" });
  });

  it("normalizes blank before_model_call block reasons", async () => {
    const runBeforeModelCall = vi.fn(async () => ({ block: true, blockReason: "   " }));

    await expect(
      runAgentHarnessBeforeModelCallHook({
        ctx: { runId: "run-1" },
        event: {
          runId: "run-1",
          sessionId: "session-1",
          provider: "openai",
          model: "gpt-5",
          prompt: "hello",
          historyMessages: [],
          imagesCount: 0,
        },
        hookRunner: {
          hasHooks: (hookName: string) => hookName === "before_model_call",
          runBeforeModelCall,
        },
      } as never),
    ).resolves.toEqual({ action: "block", reason: "blocked by before_model_call hook" });
  });

  it("propagates before_model_call hook failures", async () => {
    await expect(
      runAgentHarnessBeforeModelCallHook({
        ctx: {},
        event: {
          runId: "run-1",
          sessionId: "session-1",
          provider: "openai",
          model: "gpt-5",
          prompt: "hello",
          historyMessages: [],
          imagesCount: 0,
        },
        hookRunner: {
          hasHooks: (hookName: string) => hookName === "before_model_call",
          runBeforeModelCall: async () => {
            throw new Error("boom");
          },
        },
      } as never),
    ).rejects.toThrow("boom");
  });
});
