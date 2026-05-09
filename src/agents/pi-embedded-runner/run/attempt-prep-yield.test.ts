import { describe, expect, it, vi } from "vitest";
import { createAttemptPrepYieldController } from "./attempt-prep-yield.js";

describe("createAttemptPrepYieldController", () => {
  it("does not yield before the checkpoint budget is reached", async () => {
    const yieldNow = vi.fn(async () => {});
    const controller = createAttemptPrepYieldController({
      checkpointBudget: 2,
      yieldNow,
    });

    await controller.maybeYield();
    await controller.maybeYield();

    expect(yieldNow).not.toHaveBeenCalled();
  });

  it("yields when the checkpoint budget is exceeded", async () => {
    const yieldNow = vi.fn(async () => {});
    const controller = createAttemptPrepYieldController({
      checkpointBudget: 2,
      yieldNow,
    });

    await controller.maybeYield();
    await controller.maybeYield();
    await controller.maybeYield();

    expect(yieldNow).toHaveBeenCalledTimes(1);
  });

  it("resets checkpoint accounting", async () => {
    const yieldNow = vi.fn(async () => {});
    const controller = createAttemptPrepYieldController({
      checkpointBudget: 1,
      yieldNow,
    });

    await controller.maybeYield();
    await controller.maybeYield();
    expect(yieldNow).toHaveBeenCalledTimes(1);

    controller.reset();
    await controller.maybeYield();
    expect(yieldNow).toHaveBeenCalledTimes(1);

    await controller.maybeYield();
    expect(yieldNow).toHaveBeenCalledTimes(2);
  });
});
