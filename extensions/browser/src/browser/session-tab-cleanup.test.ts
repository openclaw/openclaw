import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registryMocks = vi.hoisted(() => ({
  sweepTrackedBrowserTabs: vi.fn(),
}));

vi.mock("./session-tab-registry.js", () => registryMocks);

import { startTrackedBrowserTabCleanupTimer } from "./session-tab-cleanup.js";

function setCleanup(enabled: boolean) {
  const config = { browser: { tabCleanup: { enabled } } };
  setRuntimeConfigSnapshot(config, config);
}
const tick = () => vi.advanceTimersByTimeAsync(300_000);
const sweep = registryMocks.sweepTrackedBrowserTabs;

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
    const stop = startTrackedBrowserTabCleanupTimer({ onWarn });

    await tick();
    await vi.waitFor(() =>
      expect(onWarn).toHaveBeenCalledWith(
        "failed to sweep tracked browser tabs: Error: sqlite read failed",
      ),
    );
    await tick();
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(2));

    await stop();
  });

  it("adopts cleanup policy changes without replacing the timer", async () => {
    sweep.mockResolvedValue(0);
    const resolved = { profiles: {} } as never;
    const getResolvedBrowserConfig = vi.fn(() => resolved);
    const stop = startTrackedBrowserTabCleanupTimer({
      getResolvedBrowserConfig,
      onWarn: vi.fn(),
    });

    await tick();
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledOnce());
    expect(sweep).toHaveBeenCalledWith(expect.objectContaining({ getResolvedBrowserConfig }));

    setCleanup(false);
    await tick();
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ordinaryCleanup: false,
        idleMs: undefined,
        maxTabsPerSession: undefined,
      }),
    );

    setCleanup(true);
    await tick();
    expect(sweep).toHaveBeenCalledTimes(3);
    await stop();
  });

  it("waits for the active sweep and does not reschedule after stop", async () => {
    const pendingSweep = createDeferred<number>();
    sweep.mockReturnValue(pendingSweep.promise);
    const stop = startTrackedBrowserTabCleanupTimer({ onWarn: vi.fn() });
    await tick();
    expect(sweep).toHaveBeenCalledOnce();

    const stopped = vi.fn();
    const stopping = stop().then(stopped);
    await tick();
    expect(stopped).not.toHaveBeenCalled();
    expect(sweep).toHaveBeenCalledOnce();

    pendingSweep.resolve(0);
    await stopping;
    await tick();
    expect(stopped).toHaveBeenCalledOnce();
    expect(sweep).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a timer whose service generation is no longer current", async () => {
    let current = true;
    const onWarn = vi.fn();
    const stop = startTrackedBrowserTabCleanupTimer({ isCurrent: () => current, onWarn });
    current = false;
    await vi.advanceTimersByTimeAsync(900_000);
    expect(sweep).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await stop();
  });
});
