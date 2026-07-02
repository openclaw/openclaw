import { describe, expect, it } from "vitest";
import { classifyStuckRecoveryAbort } from "./stuck-recovery-abort.js";

describe("classifyStuckRecoveryAbort", () => {
  it("classifies active model-call stalls as model idle timeouts", () => {
    expect(
      classifyStuckRecoveryAbort({
        modelCallActive: true,
        activePotentialSideEffectToolExecutions: 0,
      }),
    ).toBe("model_idle_timeout");
  });

  it("keeps stale post-model stuck recovery out of replay paths", () => {
    const stalePostModelRecovery = {
      modelCallStarted: true,
      modelCallActive: false,
      activePotentialSideEffectToolExecutions: 0,
    };

    expect(classifyStuckRecoveryAbort(stalePostModelRecovery)).toBe("external_abort");
  });

  it("classifies side-effecting tool-call stalls before model retry", () => {
    expect(
      classifyStuckRecoveryAbort({
        modelCallActive: true,
        activePotentialSideEffectToolExecutions: 1,
      }),
    ).toBe("tool_execution_timeout");
  });

  it("keeps pre-model stuck recovery out of replay paths", () => {
    expect(
      classifyStuckRecoveryAbort({
        modelCallActive: false,
        activePotentialSideEffectToolExecutions: 0,
      }),
    ).toBe("external_abort");
  });
});
