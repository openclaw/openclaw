import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  createBrowserRuntimeState,
  stopBrowserRuntime,
} from "../browser/runtime-lifecycle.js";

const fixture = vi.hoisted(() => {
  const config: OpenClawConfig = {};
  return {
    config,
    createRuntime: vi.fn<typeof createBrowserRuntimeState>(),
    stopRuntime: vi.fn<typeof stopBrowserRuntime>(),
    dispatch: vi.fn(async () => ({ status: 200, body: { ok: true } })),
  };
});

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: () => fixture.config,
  getRuntimeConfigSourceSnapshot: () => fixture.config,
  captureRuntimeConfigAsyncReader: () => async () => fixture.config,
}));

// mock-isolation: keep native resources outside the real service and lifecycle queue.
vi.mock("../browser/runtime-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/runtime-lifecycle.js")>()),
  createBrowserRuntimeState: fixture.createRuntime,
  stopBrowserRuntime: fixture.stopRuntime,
}));
// mock-isolation: observe completed proxy dispatch without contacting an actual browser.
vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: fixture.dispatch }),
}));
// mock-isolation: these status requests have no uploads or host upload store.
vi.mock("../browser-proxy-upload.js", () => ({
  hasBrowserProxyUploadWork: () => false,
  ensureBrowserProxyUploadCleanup: async () => {},
  stageBrowserProxyUploadRequest: async ({ body }: { body: unknown }) => ({ body }),
  discardStagedBrowserProxyUpload: async () => {},
}));

import { getBrowserControlState, stopBrowserControlRuntime } from "../browser-control-state.js";
import { runBrowserProxyCommand } from "./invoke-browser.js";

const request = JSON.stringify({ method: "GET", path: "/profiles" });
const response = JSON.stringify({ result: { ok: true } });
const stop = () => stopBrowserControlRuntime({ requestedBy: "service", onWarn: () => {} });

beforeEach(() => {
  fixture.config = { browser: {}, nodeHost: { browserProxy: { enabled: true } } };
  fixture.createRuntime.mockReset().mockImplementation(async ({ server, port, resolved }) => ({
    server: server ?? null,
    port,
    resolved,
    profiles: new Map(),
  }));
  fixture.stopRuntime.mockReset().mockImplementation(async ({ clearState }) => {
    clearState();
  });
  fixture.dispatch.mockClear();
});

afterEach(stop);

describe("browser proxy shared service lifecycle", () => {
  it("shares canonical startup and starts a new runtime after ordinary shutdown", async () => {
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    fixture.createRuntime.mockImplementationOnce(async ({ server, port, resolved }) => {
      entered.resolve();
      await released.promise;
      return { server: server ?? null, port, resolved, profiles: new Map() };
    });
    const requests = Promise.all([
      runBrowserProxyCommand(request),
      runBrowserProxyCommand(request),
    ]);
    try {
      await entered.promise;
      // The second request waits for the canonical startup instead of creating its own runtime.
      expect(fixture.createRuntime).toHaveBeenCalledOnce();
    } finally {
      released.resolve();
    }
    await expect(requests).resolves.toEqual([response, response]);
    expect(fixture.createRuntime).toHaveBeenCalledOnce();
    await expect(runBrowserProxyCommand(request)).resolves.toBe(response);
    expect(fixture.createRuntime).toHaveBeenCalledOnce();
    await stop();
    expect(getBrowserControlState()).toBeNull();
    await expect(runBrowserProxyCommand(request)).resolves.toBe(response);
    expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
  });

  it("retries through the canonical owner after runtime creation fails", async () => {
    fixture.createRuntime.mockRejectedValueOnce(new Error("synthetic runtime startup failure"));
    await expect(runBrowserProxyCommand(request)).rejects.toThrow(
      "synthetic runtime startup failure",
    );
    expect(fixture.dispatch).not.toHaveBeenCalled();
    await expect(runBrowserProxyCommand(request)).resolves.toBe(response);
    expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
  });

  it.each([
    { browser: { enabled: false } },
    { plugins: { entries: { browser: { enabled: false } } } },
  ])("refuses cold disabled configuration, then retries after enabling: %j", async (config) => {
    const enabled = fixture.config;
    fixture.config = { ...fixture.config, ...config };
    await expect(runBrowserProxyCommand(request)).rejects.toThrow("browser control disabled");
    expect(fixture.createRuntime).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    fixture.config = enabled;
    await expect(runBrowserProxyCommand(request)).resolves.toBe(response);
    expect(fixture.createRuntime).toHaveBeenCalledOnce();
  });
});
