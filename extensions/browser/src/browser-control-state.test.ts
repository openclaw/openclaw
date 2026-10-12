// Browser tests cover shared browser-control lifecycle serialization.
import type { Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markBrowserRuntimeStopping } from "./browser/server-context.lifecycle.js";

const runtimeMocks = vi.hoisted(() => ({
  stopBrowserRuntime: vi.fn(),
}));

vi.mock("./browser/runtime-lifecycle.js", () => ({
  createBrowserRuntimeState: (params: {
    server: Server | null;
    port: number;
    resolved: unknown;
  }) => ({
    server: params.server,
    port: params.port,
    resolved: params.resolved,
    profiles: new Map(),
  }),
  stopBrowserRuntime: runtimeMocks.stopBrowserRuntime,
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

function start(server: Server | null = null) {
  return withBrowserControlStart(() =>
    ensureBrowserControlRuntime({ server, port: 18_791, resolved }),
  );
}

function stop(requestedBy: "server" | "service") {
  return stopBrowserControlRuntime({ requestedBy, onWarn });
}

beforeEach(() => {
  runtimeMocks.stopBrowserRuntime.mockReset().mockImplementation(async (params) => {
    params.clearState();
  });
});

describe("browser control lifecycle", () => {
  it("allows a start after a no-state stop settles", async () => {
    await expect(stop("service")).resolves.toBeNull();
    await expect(start()).resolves.toBeTruthy();
    await stop("service");
  });

  it("rejects new starts while ordinary shutdown is pending", async () => {
    await start();
    const gate = Promise.withResolvers<void>();
    runtimeMocks.stopBrowserRuntime.mockImplementationOnce(async (params) => {
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
    expect(getBrowserControlState()).toBeNull();
    await expect(start()).resolves.toBeTruthy();
    await stop("service");
  });

  it("retains a failed stop owner for an exact retry", async () => {
    await start();
    expect(hasBrowserControlWork()).toBe(true);
    runtimeMocks.stopBrowserRuntime.mockImplementationOnce(async (params) => {
      markBrowserRuntimeStopping(params.current);
      throw new Error("cleanup failed");
    });

    await expect(stop("service")).rejects.toThrow("cleanup failed");
    expect(getBrowserControlState()).toBeNull();
    expect(hasBrowserControlWork()).toBe(true);

    await expect(stop("service")).resolves.toBeTruthy();
    expect(hasBrowserControlWork()).toBe(false);
    await expect(start()).resolves.toBeTruthy();
    await stop("service");
  });

  it("lets a foreground server adopt service state without a second runtime", async () => {
    const serviceState = await start();
    const server = {} as Server;
    const serverState = await start(server);

    expect(serverState).toBe(serviceState);
    expect(serverState.server).toBe(server);
    await stop("service");
    expect(runtimeMocks.stopBrowserRuntime).not.toHaveBeenCalled();

    await stop("server");
    expect(runtimeMocks.stopBrowserRuntime).toHaveBeenCalledOnce();
  });

  it("allows a start after a foreground-owned service stop settles", async () => {
    await start();
    await start({} as Server);
    await expect(stop("service")).resolves.toBeNull();
    await expect(start()).resolves.toBeTruthy();
    await stop("server");
  });

  it("orders a queued stop after an in-progress cold start", async () => {
    expect(hasBrowserControlWork()).toBe(false);
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const starting = withBrowserControlStart(async () => {
      await startGate;
      return await ensureBrowserControlRuntime({
        server: null,
        port: 18_791,
        resolved,
      });
    });
    expect(getBrowserControlState()).toBeNull();
    expect(hasBrowserControlWork()).toBe(true);
    const stopping = stop("service");
    releaseStart();

    await starting;
    await stopping;
    expect(runtimeMocks.stopBrowserRuntime).toHaveBeenCalledOnce();
    expect(getBrowserControlState()).toBeNull();
    expect(hasBrowserControlWork()).toBe(false);
  });
});
