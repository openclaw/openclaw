import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTENSION_IDLE_RELEASE_MS } from "./server-context.constants.js";
import {
  getOrCreateProfileRuntime,
  withProfileOperationLease,
} from "./server-context.lifecycle.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

const pwAiMocks = vi.hoisted(() => {
  const close = vi.fn(async () => {});
  return {
    close,
    retirePlaywrightBrowserConnectionExact: vi.fn((_opts: { cdpUrl: string }) => ({
      retired: true,
      close,
    })),
  };
});

vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => pwAiMocks,
}));

function setup(driver: "extension" | "openclaw") {
  const profile = makeBrowserProfile({
    name: driver === "extension" ? "dia" : "openclaw",
    driver,
    cdpUrl: "http://127.0.0.1:18798",
    cdpPort: 18798,
    attachOnly: driver === "extension",
  });
  const state = makeBrowserServerState({ profile });
  const runtime = getOrCreateProfileRuntime(state, profile);
  const lease = <T>(run: () => Promise<T>) =>
    withProfileOperationLease({ state, runtime, run: async () => await run() });
  return { lease };
}

describe("extension profile idle release", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("releases the Playwright adapter once the profile has been idle", async () => {
    const { lease } = setup("extension");
    await lease(async () => {});

    await vi.advanceTimersByTimeAsync(EXTENSION_IDLE_RELEASE_MS - 1);
    expect(pwAiMocks.retirePlaywrightBrowserConnectionExact).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(pwAiMocks.retirePlaywrightBrowserConnectionExact).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18798",
    });
    expect(pwAiMocks.close).toHaveBeenCalledTimes(1);
  });

  it("restarts the idle clock on new work and never releases during work", async () => {
    const { lease } = setup("extension");
    await lease(async () => {});
    await vi.advanceTimersByTimeAsync(EXTENSION_IDLE_RELEASE_MS / 2);

    let finish!: () => void;
    const running = lease(() => new Promise<void>((resolve) => (finish = resolve)));
    await vi.advanceTimersByTimeAsync(EXTENSION_IDLE_RELEASE_MS * 2);
    expect(pwAiMocks.retirePlaywrightBrowserConnectionExact).not.toHaveBeenCalled();

    finish();
    await running;
    await vi.advanceTimersByTimeAsync(EXTENSION_IDLE_RELEASE_MS);
    expect(pwAiMocks.retirePlaywrightBrowserConnectionExact).toHaveBeenCalledTimes(1);
  });

  it("keeps managed-browser connections cached", async () => {
    const { lease } = setup("openclaw");
    await lease(async () => {});
    await vi.advanceTimersByTimeAsync(EXTENSION_IDLE_RELEASE_MS * 2);
    expect(pwAiMocks.retirePlaywrightBrowserConnectionExact).not.toHaveBeenCalled();
  });
});
