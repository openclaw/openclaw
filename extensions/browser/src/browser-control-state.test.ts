import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markBrowserRuntimeStopping } from "./browser/server-context.lifecycle.js";

type RuntimeParams = { server: Server | null; port: number; resolved: unknown };
const stopRuntime = vi.hoisted(() => vi.fn());

vi.mock("./browser/runtime-lifecycle.js", () => ({
  createBrowserRuntimeState: (params: RuntimeParams) => ({ ...params, profiles: new Map() }),
  stopBrowserRuntime: stopRuntime,
}));

const {
  ensureBrowserControlRuntime,
  getBrowserControlState,
  hasBrowserControlWork,
  stopBrowserControlRuntime,
  withBrowserControlStart,
} = await import("./browser-control-state.js");

const resolved = { profiles: {}, controlPort: 18_791 } as never;
const onWarn = vi.fn();
const runtimeParams = { server: null, port: 18_791, resolved };
const expectState = (state: unknown, work: boolean) =>
  expect({ state: getBrowserControlState(), work: hasBrowserControlWork() }).toEqual({
    state,
    work,
  });

function start(server: Server | null = null) {
  return withBrowserControlStart(() => ensureBrowserControlRuntime({ ...runtimeParams, server }));
}

function stop(requestedBy: "server" | "service") {
  return stopBrowserControlRuntime({ requestedBy, onWarn });
}

beforeEach(() => {
  stopRuntime.mockReset().mockImplementation(async (params) => params.clearState());
});
afterEach(() => stop("server"));

describe("browser control lifecycle", () => {
  it("allows a start after a no-state stop settles", async () => {
    await expect(stop("service")).resolves.toBeNull();
    await expect(start()).resolves.toBeTruthy();
  });

  it("rejects new starts while ordinary shutdown is pending", async () => {
    await start();
    const gate = Promise.withResolvers<void>();
    stopRuntime.mockImplementationOnce(async (params) => {
      await gate.promise;
      params.clearState();
    });
    const stopping = stop("service");
    try {
      await expect(start()).rejects.toThrow("Browser runtime is stopping.");
    } finally {
      gate.resolve();
      await stopping;
    }
    expectState(null, false);
    await expect(start()).resolves.toBeTruthy();
  });

  it("retains a failed stop owner for an exact retry", async () => {
    await start();
    expect(hasBrowserControlWork()).toBe(true);
    stopRuntime.mockImplementationOnce(async (params) => {
      markBrowserRuntimeStopping(params.current);
      throw new Error("cleanup failed");
    });

    await expect(stop("service")).rejects.toThrow("cleanup failed");
    expectState(null, true);

    await expect(stop("service")).resolves.toBeTruthy();
    expect(hasBrowserControlWork()).toBe(false);
    await expect(start()).resolves.toBeTruthy();
  });

  it("lets a foreground server adopt service state without a second runtime", async () => {
    const serviceState = await start();
    const server = {} as Server;
    const serverState = await start(server);

    expect(serverState).toBe(serviceState);
    expect(serverState.server).toBe(server);
    await stop("service");
    expect(stopRuntime).not.toHaveBeenCalled();

    await stop("server");
    expect(stopRuntime).toHaveBeenCalledOnce();
  });

  it("orders a queued stop after an in-progress cold start", async () => {
    expect(hasBrowserControlWork()).toBe(false);
    const startGate = Promise.withResolvers<void>();
    const starting = withBrowserControlStart(async () => {
      await startGate.promise;
      return await ensureBrowserControlRuntime(runtimeParams);
    });
    expectState(null, true);
    const stopping = stop("service");
    startGate.resolve();

    await starting;
    await stopping;
    expect(stopRuntime).toHaveBeenCalledOnce();
    expectState(null, false);
  });
});
