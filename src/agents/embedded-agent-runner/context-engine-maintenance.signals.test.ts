import { EventEmitter } from "node:events";
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
    const listeners = new EventEmitter();
    const kill = vi.fn();
    const processLike = {
      on(event: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.on(event, listener);
        return this;
      },
      off(event: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.off(event, listener);
        return this;
      },
      listenerCount: listeners.listenerCount.bind(listeners),
      kill,
      pid: 4242,
    } as unknown as NonNullable<
      Parameters<typeof createDeferredTurnMaintenanceAbortSignal>[0]
    >["processLike"];

    const { abortSignal, dispose } = createDeferredTurnMaintenanceAbortSignal({ processLike });
    const second = createDeferredTurnMaintenanceAbortSignal({ processLike });
    expect(listeners.listenerCount("SIGINT")).toBe(1);
    expect(listeners.listenerCount("SIGTERM")).toBe(1);

    listeners.emit("SIGTERM");

    expect(abortSignal?.aborted).toBe(true);
    expect(second.abortSignal?.aborted).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(listeners.listenerCount("SIGINT")).toBe(0);
    expect(listeners.listenerCount("SIGTERM")).toBe(0);

    dispose();
    second.dispose();
    expect(listeners.listenerCount("SIGINT")).toBe(0);
    expect(listeners.listenerCount("SIGTERM")).toBe(0);
  });
});
