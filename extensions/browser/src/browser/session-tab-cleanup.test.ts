import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sweep = vi.hoisted(() => vi.fn());
// mock-isolation: Timer tests control sweep settlement without opening the tab registry.
vi.mock("./session-tab-registry.js", () => ({ sweepTrackedBrowserTabs: sweep }));

import { startTrackedBrowserTabCleanupTimer as startTimer } from "./session-tab-cleanup.js";

function setCleanup(enabled: boolean) {
  const config = { browser: { tabCleanup: { enabled } } };
  setRuntimeConfigSnapshot(config, config);
}
const tick = () => vi.advanceTimersByTimeAsync(300_000);

describe("session tab cleanup timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sweep.mockReset();
    clearRuntimeConfigSnapshot();
    setCleanup(true);
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.useRealTimers();
  });

  it("warns on sweep store failures and continues scheduling", async () => {
    sweep.mockRejectedValueOnce(new Error("sqlite read failed")).mockResolvedValueOnce(0);
    const onWarn = vi.fn();
    const stop = startTimer({ onWarn });
    const warning = "failed to sweep tracked browser tabs: Error: sqlite read failed";

    await tick();
    await vi.waitFor(() => expect(onWarn).toHaveBeenCalledWith(warning));
    await tick();
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(2));

    await stop();
  });

  it("adopts cleanup policy changes without replacing the timer", async () => {
    sweep.mockResolvedValue(0);
    const getResolvedBrowserConfig = vi.fn(() => null);
    const stop = startTimer({ getResolvedBrowserConfig, onWarn: vi.fn() });
    const disabled = { ordinaryCleanup: false, idleMs: undefined, maxTabsPerSession: undefined };
    for (const [index, enabled] of [true, false, true].entries()) {
      setCleanup(enabled);
      await tick();
      await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(index + 1));
      expect(sweep).toHaveBeenLastCalledWith(expect.objectContaining({ getResolvedBrowserConfig }));
      if (!enabled) {
        expect(sweep).toHaveBeenLastCalledWith(expect.objectContaining(disabled));
      }
    }
    await stop();
  });

  it("waits for the active sweep and does not reschedule after stop", async () => {
    const pendingSweep = createDeferred<number>();
    sweep.mockReturnValue(pendingSweep.promise);
    const stop = startTimer({ onWarn: vi.fn() });
    await tick();
    expect(sweep).toHaveBeenCalledOnce();

    const done = vi.fn();
    const stopping = stop().then(done);
    await tick();
    expect([done.mock.calls.length, sweep.mock.calls.length]).toEqual([0, 1]);

    pendingSweep.resolve(0);
    await stopping;
    await tick();
    expect([done.mock.calls.length, sweep.mock.calls.length]).toEqual([1, 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a timer whose service generation is no longer current", async () => {
    let current = true;
    const onWarn = vi.fn();
    const stop = startTimer({ isCurrent: () => current, onWarn });
    current = false;
    await vi.advanceTimersByTimeAsync(900_000);
    expect([sweep.mock.calls, onWarn.mock.calls, vi.getTimerCount()]).toEqual([[], [], 0]);
    await stop();
  });
});
