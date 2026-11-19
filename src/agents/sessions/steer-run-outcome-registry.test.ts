import { describe, expect, it, vi } from "vitest";
import {
  hasSteeredRunOutcomeObservers,
  registerSteeredRunOutcomeObserver,
  settleSteeredRunOutcomeObservers,
} from "./steer-run-outcome-registry.js";

describe("steer run outcome registry", () => {
  it("settles every steered source with the consuming run's outcome exactly once", () => {
    const first = vi.fn();
    const second = vi.fn();
    const runId = "run-1";
    const unregister = registerSteeredRunOutcomeObserver(runId, first);
    registerSteeredRunOutcomeObserver(runId, second);
    expect(hasSteeredRunOutcomeObservers(runId)).toBe(true);

    settleSteeredRunOutcomeObservers(runId, "completed");
    expect(first).toHaveBeenCalledWith("completed");
    expect(second).toHaveBeenCalledWith("completed");
    expect(hasSteeredRunOutcomeObservers(runId)).toBe(false);

    settleSteeredRunOutcomeObservers(runId, "failed");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(unregister()).toBeUndefined();
  });

  it("unregister removes only its own observer and keeps the rest pending", () => {
    const kept = vi.fn();
    const dropped = vi.fn();
    const runId = "run-2";
    const unregister = registerSteeredRunOutcomeObserver(runId, dropped);
    registerSteeredRunOutcomeObserver(runId, kept);
    unregister();
    expect(hasSteeredRunOutcomeObservers(runId)).toBe(true);
    settleSteeredRunOutcomeObservers(runId, "failed");
    expect(dropped).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledWith("failed");
    expect(hasSteeredRunOutcomeObservers(runId)).toBe(false);
  });

  it("isolates runs and never settles other runs' sources", () => {
    const observer = vi.fn();
    registerSteeredRunOutcomeObserver("run-a", observer);
    settleSteeredRunOutcomeObservers("run-b", "completed");
    expect(observer).not.toHaveBeenCalled();
    settleSteeredRunOutcomeObservers("run-a", "failed");
    expect(observer).toHaveBeenCalledWith("failed");
  });

  it("one observer failure never starves the remaining sources", () => {
    const failing = vi.fn(() => {
      throw new Error("source callback exploded");
    });
    const healthy = vi.fn();
    const runId = "run-3";
    registerSteeredRunOutcomeObserver(runId, failing);
    registerSteeredRunOutcomeObserver(runId, healthy);
    expect(() => settleSteeredRunOutcomeObservers(runId, "completed")).not.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledWith("completed");
    expect(hasSteeredRunOutcomeObservers(runId)).toBe(false);
  });
});
