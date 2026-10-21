import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

// mock-isolation: shutdown races use synthetic Chrome handles, not native browser processes.
vi.mock("./chrome.js", () => ({ stopOpenClawChrome: mocks.stopOpenClawChrome }));

// mock-isolation: simulate a removed installed chunk without importing the real MCP client.
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
afterEach(() => {
  mocks.chunksRemoved = false;
});

it("closes an unused existing-session profile after its installation is replaced", async () => {
  const profile = makeBrowserProfile({ name: "user", driver: "existing-session" });
  const state = makeBrowserServerState({ profile });
  getOrCreateProfileRuntime(state, profile);
  mocks.chunksRemoved = true;
  const clearState = vi.fn();
  await stopBrowserRuntime({ current: state, clearState, onWarn: vi.fn() });
  expect(clearState).toHaveBeenCalledOnce();
  expect(mocks.closeChromeMcpSession).not.toHaveBeenCalled();
});

it("invalidates every deferred start before draining late children and clearing state", async () => {
  const profiles = ["alpha", "beta"].map((name, i) =>
    makeBrowserProfile({ name, cdpPort: 18_801 + i }),
  );
  const state = makeBrowserServerState({
    resolvedOverrides: {
      profiles: Object.fromEntries(profiles.map((profile) => [profile.name, profile])),
    },
  });
  const runtimes = profiles.map((profile) => getOrCreateProfileRuntime(state, profile));
  const launches = profiles.map(() => createDeferred<RunningChrome>());
  const entered = profiles.map(() => createDeferred<void>());
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
  const children = [1, 2].map((pid) => mockLaunchedChrome(vi.fn(), pid));
  const clearState = vi.fn(() => {
    for (const runtime of runtimes) {
      expect({
        running: runtime.running,
        handles: getProfileLifecycle(runtime).handles.size,
      }).toEqual({ running: null, handles: 0 });
    }
  });

  const stopping = stopBrowserBridgeRuntime({ current: state, clearState, onWarn: vi.fn() });

  expect(startSignals.map((signal) => signal.aborted)).toEqual([true, true]);
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
