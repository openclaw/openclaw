import { describe, it, expect, vi } from "vitest";
import { AlphaFactoryOrchestrator } from "./orchestrator.js";

describe("AlphaFactoryOrchestrator", () => {
  it("starts and stops evolution scheduler", () => {
    const scheduler = { start: vi.fn(), stop: vi.fn(), getStats: vi.fn() };
    const orch = new AlphaFactoryOrchestrator({ evolutionScheduler: scheduler });

    orch.start();
    expect(scheduler.start).toHaveBeenCalled();
    expect(orch.getStats().running).toBe(true);

    orch.stop();
    expect(scheduler.stop).toHaveBeenCalled();
    expect(orch.getStats().running).toBe(false);
  });

  it("start is idempotent", () => {
    const scheduler = { start: vi.fn(), stop: vi.fn(), getStats: vi.fn() };
    const orch = new AlphaFactoryOrchestrator({ evolutionScheduler: scheduler });

    orch.start();
    orch.start();
    expect(scheduler.start).toHaveBeenCalledTimes(1);
    orch.stop();
  });

  it("runScreening delegates to screening pipeline", async () => {
    const screen = vi.fn().mockResolvedValue([
      {
        strategyId: "s1",
        passed: true,
        quickBacktest: { sharpe: 1, maxDD: -10, trades: 100 },
        perturbationStability: 1,
      },
      {
        strategyId: "s2",
        passed: false,
        quickBacktest: { sharpe: 0.2, maxDD: -40, trades: 10 },
        perturbationStability: 0,
        failReason: "low sharpe",
      },
    ]);

    const orch = new AlphaFactoryOrchestrator({
      screeningPipeline: { screen },
    });

    const result = await orch.runScreening(["s1", "s2"]);
    expect(result.passed).toEqual(["s1"]);
    expect(result.failed).toEqual(["s2"]);
    expect(orch.getStats().screeningPassed).toBe(1);
    expect(orch.getStats().screeningFailed).toBe(1);
  });

  it("runScreening returns all failed when no pipeline", async () => {
    const orch = new AlphaFactoryOrchestrator({});
    const result = await orch.runScreening(["s1", "s2"]);
    expect(result.passed).toEqual([]);
    expect(result.failed).toEqual(["s1", "s2"]);
  });

  it("runFullPipeline screens then validates", async () => {
    const screen = vi.fn().mockResolvedValue([
      {
        strategyId: "s1",
        passed: true,
        quickBacktest: { sharpe: 1, maxDD: -10, trades: 100 },
        perturbationStability: 1,
      },
      {
        strategyId: "s2",
        passed: false,
        quickBacktest: { sharpe: 0.2, maxDD: -40, trades: 10 },
        perturbationStability: 0,
        failReason: "low",
      },
    ]);
    const validate = vi.fn().mockResolvedValue({ strategyId: "s1", passed: true });

    const orch = new AlphaFactoryOrchestrator({
      screeningPipeline: { screen },
      validationOrchestrator: { validate },
    });

    const result = await orch.runFullPipeline(["s1", "s2"]);
    expect(result.screened).toBe(2);
    expect(result.validated).toBe(1);
    expect(result.failed).toBe(1); // s2 failed screening
    expect(validate).toHaveBeenCalledWith("s1");
  });

  it("runFullPipeline treats screened as validated when no validator", async () => {
    const screen = vi
      .fn()
      .mockResolvedValue([
        {
          strategyId: "s1",
          passed: true,
          quickBacktest: { sharpe: 1, maxDD: -10, trades: 100 },
          perturbationStability: 1,
        },
      ]);

    const orch = new AlphaFactoryOrchestrator({
      screeningPipeline: { screen },
    });

    const result = await orch.runFullPipeline(["s1"]);
    expect(result.validated).toBe(1);
  });

  it("getStats returns initial zeros", () => {
    const orch = new AlphaFactoryOrchestrator({});
    const stats = orch.getStats();
    expect(stats.running).toBe(false);
    expect(stats.screeningPassed).toBe(0);
    expect(stats.validationPassed).toBe(0);
    expect(stats.gcKilled).toBe(0);
  });
});
