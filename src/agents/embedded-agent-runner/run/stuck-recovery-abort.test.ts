import { describe, expect, it } from "vitest";
import { classifyStuckRecoveryAbort } from "./stuck-recovery-abort.js";

describe("classifyStuckRecoveryAbort", () => {
  it("classifies model-call stalls as model idle timeouts", () => {
    expect(
      classifyStuckRecoveryAbort({
        modelCallStarted: true,
        activePotentialSideEffectToolExecutions: 0,
      }),
    ).toBe("model_idle_timeout");
  });

  it("classifies side-effecting tool-call stalls before model retry", () => {
    expect(
      classifyStuckRecoveryAbort({
        modelCallStarted: true,
        activePotentialSideEffectToolExecutions: 1,
      }),
    ).toBe("tool_execution_timeout");
  });

  it("keeps pre-model stuck recovery out of replay paths", () => {
    expect(
      classifyStuckRecoveryAbort({
        modelCallStarted: false,
        activePotentialSideEffectToolExecutions: 0,
      }),
    ).toBe("external_abort");
  });
});
