import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as control from "./browser-control-state.js";
import { markBrowserRuntimeStopping } from "./browser/server-context.lifecycle.js";

type RuntimeParams = { server: Server | null; port: number; resolved: unknown };
const stopRuntime = vi.hoisted(() => vi.fn());

// mock-isolation: control shutdown settlement without starting or stopping real browser resources.
vi.mock("./browser/runtime-lifecycle.js", () => ({
  createBrowserRuntimeState: (params: RuntimeParams) => ({ ...params, profiles: new Map() }),
  stopBrowserRuntime: stopRuntime,
}));

const resolved = { profiles: {}, controlPort: 18_791 } as never;
const runtimeParams = { server: null, port: 18_791, resolved };
function expectState(state: unknown, work: boolean) {
  expect(control.getBrowserControlState()).toBe(state);
  expect(control.hasBrowserControlWork()).toBe(work);
}

const start = (server: Server | null = null) =>
  control.withBrowserControlStart(() =>
    control.ensureBrowserControlRuntime({ ...runtimeParams, server }),
  );

const stop = (requestedBy: "server" | "service") =>
  control.stopBrowserControlRuntime({ requestedBy, onWarn: vi.fn() });

beforeEach(() => {
  stopRuntime.mockReset().mockImplementation(async (params) => params.clearState());
});
afterEach(() => stop("server"));

it("rejects new starts while ordinary shutdown is pending", async () => {
  await start();
  const gate = Promise.withResolvers<void>();
  stopRuntime.mockImplementationOnce(({ clearState }) => gate.promise.then(clearState));
  const stopping = stop("service");
  await Promise.all([
    expect(start()).rejects.toThrow("Browser runtime is stopping.").finally(gate.resolve),
    stopping,
  ]);
  expectState(null, false);
  await expect(start()).resolves.toBeTruthy();
});

it("retains a failed stop owner for an exact retry", async () => {
  await start();
  stopRuntime.mockImplementationOnce(async (params) => {
    markBrowserRuntimeStopping(params.current);
    throw new Error("cleanup failed");
  });
  await expect(stop("service")).rejects.toThrow("cleanup failed");
  expectState(null, true);
  await expect(stop("service")).resolves.toBeTruthy();
  expect(control.hasBrowserControlWork()).toBe(false);
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
  await expect(stop("service")).resolves.toBeNull();
  const startGate = Promise.withResolvers<void>();
  const starting = control.withBrowserControlStart(async () => {
    await startGate.promise;
    return await control.ensureBrowserControlRuntime(runtimeParams);
  });
  expectState(null, true);
  const stopping = stop("service");
  startGate.resolve();
  await Promise.all([starting, stopping]);
  expect(stopRuntime).toHaveBeenCalledOnce();
  expectState(null, false);
});
