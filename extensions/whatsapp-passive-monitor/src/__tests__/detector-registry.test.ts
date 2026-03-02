import { describe, it, expect, vi } from "vitest";
import { createDetectorRegistry } from "../detector-registry.ts";
import type { DetectorExecCtx } from "../interfaces/detector.ts";

const ctx: DetectorExecCtx = { conversationId: "chat-1" };

describe("DetectorRegistry", () => {
  it("runAll calls each detector sequentially with the context", async () => {
    const order: number[] = [];
    const detector1 = vi.fn(async () => {
      order.push(1);
    });
    const detector2 = vi.fn(async () => {
      order.push(2);
    });

    const registry = createDetectorRegistry();
    registry.add(detector1);
    registry.add(detector2);
    await registry.runAll(ctx);

    expect(detector1).toHaveBeenCalledWith(ctx);
    expect(detector2).toHaveBeenCalledWith(ctx);
    expect(order).toEqual([1, 2]);
  });

  it("runAll continues when a detector throws", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const passing = vi.fn(async () => {});

    const registry = createDetectorRegistry();
    registry.add(failing);
    registry.add(passing);
    await registry.runAll(ctx);

    expect(passing).toHaveBeenCalledWith(ctx);
  });

  it("runAll is a no-op when no detectors are registered", async () => {
    const registry = createDetectorRegistry();
    await expect(registry.runAll(ctx)).resolves.toBeUndefined();
  });

  it("add accumulates detectors", async () => {
    const detectors = [vi.fn(async () => {}), vi.fn(async () => {}), vi.fn(async () => {})];

    const registry = createDetectorRegistry();
    for (const d of detectors) registry.add(d);
    await registry.runAll(ctx);

    for (const d of detectors) expect(d).toHaveBeenCalledOnce();
  });
});
