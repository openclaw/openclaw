import { describe, expect, it } from "vitest";
import { stepIdleTimeoutBreaker } from "./idle-timeout-breaker.js";

// #76293: state must survive outer-loop attempts and profile rotation.
describe("stepIdleTimeoutBreaker (#76293)", () => {
  const wedged = { idleTimedOut: true, completedModelProgress: false };
  const productive = { idleTimedOut: false, completedModelProgress: true };
  function drive(inputs: Array<Parameters<typeof stepIdleTimeoutBreaker>[1]>) {
    const state = { consecutiveIdleTimeoutsBeforeOutput: 0 };
    return inputs.map((input) => stepIdleTimeoutBreaker(state, input));
  }

  it("trips on the Nth consecutive wedged attempt at the default cap", () => {
    const steps = drive(Array.from({ length: 5 }, () => ({ ...wedged })));
    expect(steps.map((s) => s.tripped)).toEqual([false, false, false, false, true]);
    expect(steps.at(-1)?.consecutive).toBe(5);
  });

  it("does not trip when the model completed progress, even on a timeout (slow but alive)", () => {
    const steps = drive(
      Array.from({ length: 8 }, () => ({
        idleTimedOut: true,
        completedModelProgress: true,
      })),
    );
    expect(steps.some((step) => step.tripped)).toBe(false);
    expect(steps.at(-1)?.consecutive).toBe(0);
  });

  it("resets the counter when a productive attempt arrives between wedged attempts", () => {
    const steps = drive([
      ...Array.from({ length: 4 }, () => ({ ...wedged })),
      productive,
      ...Array.from({ length: 4 }, () => ({ ...wedged })),
    ]);
    expect(steps.map((s) => s.tripped)).toEqual(Array(9).fill(false));
    expect(steps.map((s) => s.consecutive)).toEqual([1, 2, 3, 4, 0, 1, 2, 3, 4]);
  });

  it("non-timeout error attempts (no output) leave the counter unchanged", () => {
    const steps = drive([
      ...Array.from({ length: 3 }, () => ({ ...wedged })),
      { idleTimedOut: false, completedModelProgress: false },
      { idleTimedOut: false, completedModelProgress: false },
      ...Array.from({ length: 2 }, () => ({ ...wedged })),
    ]);
    expect(steps.map((s) => s.consecutive)).toEqual([1, 2, 3, 3, 3, 4, 5]);
    expect(steps.at(-1)?.tripped).toBe(true);
  });
});
