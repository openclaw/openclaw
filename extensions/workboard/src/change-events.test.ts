import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardChangeEventService } from "./change-events.js";

afterEach(() => vi.useRealTimers());

describe("createWorkboardChangeEventService", () => {
  it("keeps repeated starts on one change sink without a freshness timer", async () => {
    vi.useFakeTimers();
    const announceChangeEpoch = vi.fn();
    const store: Parameters<typeof createWorkboardChangeEventService>[0] = {
      ready: vi.fn(async () => {}),
      onChange: undefined,
      announceChangeEpoch,
    };
    const emit = vi.fn();
    const service = createWorkboardChangeEventService(store);
    const context = {
      config: {},
      stateDir: "/tmp/workboard-change-events-test",
      gatewayEvents: { emit, onSessionsChanged: () => () => undefined },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } satisfies Parameters<typeof service.start>[0];

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await service.start(context);
    }

    expect(announceChangeEpoch).toHaveBeenCalledOnce();
    store.onChange?.({ epoch: "epoch-a", revision: 1 });
    expect(emit).toHaveBeenCalledExactlyOnceWith(
      "changed",
      { epoch: "epoch-a", revision: 1 },
      { scope: "operator.read" },
    );
    expect(vi.getTimerCount()).toBe(0);

    await service.stop?.(context);
    expect(store.onChange).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
