import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeferredTurnMaintenanceAbortSignal,
  resetDeferredTurnMaintenanceStateForTest,
} from "./context-engine-maintenance.test-support.js";

describe("createDeferredTurnMaintenanceAbortSignal", () => {
  beforeEach(() => {
    resetDeferredTurnMaintenanceStateForTest();
  });

  it("aborts on termination signals and unregisters listeners", () => {
    const listeners = new Map<string, Set<() => void>>();
    const kill = vi.fn();
    const processLike = {
      on(event: "SIGINT" | "SIGTERM", listener: () => void) {
        const bucket = listeners.get(event) ?? new Set<() => void>();
        bucket.add(listener);
        listeners.set(event, bucket);
        return this;
      },
      off(event: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.get(event)?.delete(listener);
        return this;
      },
      listenerCount(event: "SIGINT" | "SIGTERM") {
        return listeners.get(event)?.size ?? 0;
      },
      kill,
      pid: 4242,
    } as unknown as NonNullable<
      Parameters<typeof createDeferredTurnMaintenanceAbortSignal>[0]
    >["processLike"];

    const { abortSignal, dispose } = createDeferredTurnMaintenanceAbortSignal({ processLike });
    const second = createDeferredTurnMaintenanceAbortSignal({ processLike });
    expect(listeners.get("SIGINT")?.size ?? 0).toBe(1);
    expect(listeners.get("SIGTERM")?.size ?? 0).toBe(1);

    const sigtermListeners = Array.from(listeners.get("SIGTERM") ?? []);
    expect(sigtermListeners).toHaveLength(1);
    sigtermListeners[0]?.();

    expect(abortSignal?.aborted).toBe(true);
    expect(second.abortSignal?.aborted).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(listeners.get("SIGINT")?.size ?? 0).toBe(0);
    expect(listeners.get("SIGTERM")?.size ?? 0).toBe(0);

    dispose();
    second.dispose();
    expect(listeners.get("SIGINT")?.size ?? 0).toBe(0);
    expect(listeners.get("SIGTERM")?.size ?? 0).toBe(0);
  });
});
