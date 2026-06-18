// Slack tests cover provider reconnect loop behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackTestState, resetSlackTestState } from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");
const slackTestState = getSlackTestState();

describe("slack socket reconnect loop", () => {
  beforeEach(() => {
    resetSlackTestState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("continues after thirteen consecutive recoverable start failures", async () => {
    const controller = new AbortController();
    const runtimeError = vi.fn();
    let attempts = 0;
    slackTestState.appStartMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts <= 13) {
        throw new Error("ECONNRESET");
      }
      controller.abort();
    });

    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: slackTestState.config,
      runtime: {
        log: vi.fn(),
        error: runtimeError,
        exit: vi.fn(),
      },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeUndefined();

    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(14);
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("retry 13/∞"));
  });
});
