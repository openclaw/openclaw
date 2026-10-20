import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningChrome } from "./chrome.js";
import {
  makeBrowserProfile,
  makeBrowserServerState,
  mockLaunchedChrome,
} from "./server-context.test-harness.js";

const mocks = vi.hoisted(() => ({
  chunksRemoved: false,
  closeChromeMcpSession: vi.fn(async () => false),
  stopOpenClawChrome: vi.fn(async (_running: RunningChrome) => {}),
}));

vi.mock("./chrome.js", () => ({ stopOpenClawChrome: mocks.stopOpenClawChrome }));

vi.mock("./chrome-mcp.js", () => {
  if (mocks.chunksRemoved) {
    throw new Error("installed Chrome MCP chunk was removed");
  }
  return { closeChromeMcpSession: mocks.closeChromeMcpSession };
});

vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => null,
  getPwAiModule: async () => null,
}));

const { stopBrowserBridgeRuntime, stopBrowserRuntime } = await import("./runtime-lifecycle.js");
const { getChromeMcpModule } = await import("./chrome-mcp.runtime.js");
const {
  enqueueProfileStart,
  getProfileLifecycle,
  getOrCreateProfileRuntime,
  registerProfileHandle,
} = await import("./server-context.lifecycle.js");

beforeEach(() => {
  getChromeMcpModule.clear();
  mocks.chunksRemoved = false;
  mocks.closeChromeMcpSession.mockReset().mockResolvedValue(false);
  mocks.stopOpenClawChrome.mockReset().mockResolvedValue(undefined);
});

describe("browser runtime shutdown profile races", () => {
  it("closes an unused existing-session profile after its installation is replaced", async () => {
    const profile = makeBrowserProfile({ name: "user", driver: "existing-session" });
    const state = makeBrowserServerState({ profile });
    getOrCreateProfileRuntime(state, profile);
    mocks.chunksRemoved = true;
    const clearState = vi.fn();
    try {
      await stopBrowserRuntime({ current: state, clearState, onWarn: vi.fn() });
      expect(clearState).toHaveBeenCalledOnce();
      expect(mocks.closeChromeMcpSession).not.toHaveBeenCalled();
    } finally {
      mocks.chunksRemoved = false;
    }
  });

  it("invalidates every deferred start before draining late children and clearing state", async () => {
    const profiles = [
      makeBrowserProfile({ name: "alpha", cdpPort: 18_801 }),
      makeBrowserProfile({ name: "beta", cdpPort: 18_802 }),
    ];
    const state = makeBrowserServerState({
      resolvedOverrides: {
        profiles: Object.fromEntries(profiles.map((profile) => [profile.name, profile])),
      },
    });
    const runtimes = profiles.map((profile) => getOrCreateProfileRuntime(state, profile));
    const launches = [createDeferred<RunningChrome>(), createDeferred<RunningChrome>()];
    const entered = [createDeferred<void>(), createDeferred<void>()];
    const startSignals: AbortSignal[] = [];
    const starts = runtimes.map((runtime, index) =>
      enqueueProfileStart({
        state,
        runtime,
        key: "default",
        run: async (signal) => {
          startSignals[index] = signal;
          entered[index]?.resolve();
          const running = await launches[index]!.promise;
          registerProfileHandle(runtime, running);
          signal.throwIfAborted();
          runtime.running = running;
        },
      }),
    );
    await Promise.all(entered.map((gate) => gate.promise));
    const children = [1, 2].map((pid) =>
      Object.assign(mockLaunchedChrome(vi.fn(), pid), {
        userDataDir: `/tmp/profile-${pid}`,
        cdpPort: 18_800 + pid,
      }),
    );
    const clearState = vi.fn(() => {
      for (const runtime of runtimes) {
        expect(runtime.running).toBeNull();
        expect(getProfileLifecycle(runtime).handles.size).toBe(0);
      }
    });

    const stopping = stopBrowserBridgeRuntime({ current: state, clearState, onWarn: vi.fn() });

    expect(startSignals).toHaveLength(2);
    expect(startSignals.every((signal) => signal.aborted)).toBe(true);
    expect(() =>
      enqueueProfileStart({
        state,
        runtime: runtimes[0]!,
        key: "after-shutdown",
        run: async () => {},
      }),
    ).toThrow("Browser runtime is stopping");
    expect(clearState).not.toHaveBeenCalled();

    launches.forEach((launch, index) => launch.resolve(children[index]!));
    await Promise.all(
      starts.map(async (start) => await expect(start).rejects.toThrow(/lifecycle changed/i)),
    );
    await expect(stopping).resolves.toBeUndefined();

    expect(mocks.stopOpenClawChrome.mock.calls.map(([running]) => running)).toEqual(children);
    expect(mocks.closeChromeMcpSession).not.toHaveBeenCalled();
    expect(clearState).toHaveBeenCalledTimes(1);
  });
});
