import {
  getAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type BackendLifecycle = {
  publish: (backend: { runtime: unknown }) => void;
  retract: (runtime: unknown) => void;
};

const { realRuntime, startMock, stopMock, createServiceMock } = vi.hoisted(() => {
  const runtime = {
    async ensureSession({ sessionKey }: { sessionKey: string }) {
      return { backend: "acpx", runtimeSessionName: sessionKey, sessionKey };
    },
    async *runTurn() {},
    async cancel() {},
    async close() {},
    isHealthy: vi.fn(() => true),
  };
  const start = vi.fn(async (_ctx: unknown, backendLifecycle?: BackendLifecycle) => {
    backendLifecycle?.publish({ runtime });
  });
  const stop = vi.fn(async (_ctx: unknown, backendLifecycle?: BackendLifecycle) => {
    backendLifecycle?.retract(runtime);
  });
  return {
    realRuntime: runtime,
    startMock: start,
    stopMock: stop,
    createServiceMock: vi.fn(
      (
        params: {
          backendLifecycle?: BackendLifecycle;
          getAllowedAgents?: () => string[] | undefined;
          openKeyedStore?: OpenClawPluginApi["runtime"]["state"]["openKeyedStoreV2"];
        } = {},
      ) => ({
        id: "real-acpx-runtime",
        start: (ctx: unknown) => start(ctx, params.backendLifecycle),
        promote: async (_ctx: unknown, assertCurrent?: () => void) => {
          assertCurrent?.();
        },
        stop: (ctx: unknown) => stop(ctx, params.backendLifecycle),
      }),
    ),
  };
});

// mock-isolation: exercise deferred publication without starting the ACPX process service.
vi.mock("./src/service.js", () => ({
  createAcpxRuntimeService: createServiceMock,
}));

import { createRegisteredAcpxService } from "./registration.test-support.js";

function createServiceContext() {
  return {
    workspaceDir: "/tmp/openclaw-acpx-register-test",
    stateDir: "/tmp/openclaw-acpx-register-test/state",
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

type DeferredRuntime = {
  ensureSession(input: { sessionKey: string; agent: string; mode: string }): Promise<unknown>;
};

const session = (runtime: DeferredRuntime, name: string) =>
  runtime.ensureSession({ sessionKey: `agent:codex:acp:${name}`, agent: "codex", mode: "oneshot" });
const activationError = (activation: Promise<unknown>) =>
  activation.then(
    () => null,
    (error: unknown) => error,
  );
const stoppedDuringActivation = () =>
  expect.objectContaining({ message: "ACPX runtime service stopped during activation" });
const notStarted = "ACPX runtime service is not started";

describe("acpx register runtime service", () => {
  let ctx: ReturnType<typeof createServiceContext>;
  beforeEach(() => {
    ctx = createServiceContext();
    vi.stubEnv("OPENCLAW_SKIP_ACPX_RUNTIME", undefined);
  });
  afterEach(() => {
    unregisterAcpRuntimeBackend("acpx");
    startMock.mockClear();
    stopMock.mockClear();
    createServiceMock.mockClear();
    vi.unstubAllEnvs();
  });

  async function start(service = createRegisteredAcpxService()) {
    await service.start(ctx);
    return { service, runtime: getAcpRuntimeBackend("acpx")?.runtime as DeferredRuntime };
  }

  it("registers the acpx backend at startup and starts the real service on first use", async () => {
    const openKeyedStore = vi.fn();
    const { service, runtime } = await start(
      createRegisteredAcpxService({
        pluginConfig: { timeoutSeconds: 10 },
        runtime: createPluginRuntimeMock({
          config: { current: () => ({ acp: { allowedAgents: ["codex"] } }) },
          state: { openKeyedStoreV2: openKeyedStore },
        }),
      }),
    );
    expect(runtime).toBeTruthy();
    expect(createServiceMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();

    await session(runtime, "test");

    expect(createServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backendLifecycle: expect.objectContaining({
          publish: expect.any(Function),
          retract: expect.any(Function),
        }),
        pluginConfig: { timeoutSeconds: 10 },
      }),
    );
    expect(startMock).toHaveBeenCalledWith(ctx, expect.any(Object));
    const params = createServiceMock.mock.calls[0]?.[0];
    expect(params?.getAllowedAgents?.()).toEqual(["codex"]);
    params?.openKeyedStore?.({ namespace: "test", maxEntries: 1 });
    expect(openKeyedStore).toHaveBeenCalledWith({ namespace: "test", maxEntries: 1 });
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);
    expect(ctx.logger.info).toHaveBeenCalledWith("embedded acpx runtime backend registered lazily");

    await service.stop?.(ctx);

    expect(stopMock).toHaveBeenCalledWith(ctx, expect.any(Object));
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });

  it("rejects stale publication after stop invalidates the deferred backend", async () => {
    const startEntered = createDeferred<void>();
    const releasePublication = createDeferred<void>();
    startMock.mockImplementationOnce(async (_ctx, backendLifecycle) => {
      startEntered.resolve();
      await releasePublication.promise;
      backendLifecycle?.publish({ runtime: realRuntime });
    });
    const { service, runtime } = await start();
    const activationResult = activationError(session(runtime, "shutdown-race"));
    await startEntered.promise;

    const stopping = service.stop?.(ctx);
    await Promise.resolve();
    expect(stopMock).not.toHaveBeenCalled();

    releasePublication.resolve();
    await stopping;

    expect(await activationResult).toEqual(stoppedDuringActivation());
    expect(stopMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledWith(ctx, expect.any(Object));
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
    await expect(session(runtime, "stale-proxy")).rejects.toThrow(notStarted);
  });

  it("keeps a successor generation registered when old cleanup finishes late", async () => {
    const published = createDeferred<void>();
    const releaseProbe = createDeferred<void>();
    startMock.mockImplementationOnce(async (_ctx, backendLifecycle) => {
      if (!backendLifecycle) {
        throw new Error("expected outer backend lifecycle");
      }
      backendLifecycle.publish({ runtime: realRuntime });
      published.resolve();
      await releaseProbe.promise;
    });
    const { service: generationA, runtime: runtimeA } = await start();
    const activationResult = activationError(session(runtimeA, "generation-a"));
    await published.promise;
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtimeA);

    let concurrentCallSettled = false;
    const concurrentCallResult = activationError(session(runtimeA, "generation-a-concurrent")).then(
      (result) => {
        concurrentCallSettled = true;
        return result;
      },
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(concurrentCallSettled).toBe(false);

    const stoppingA = generationA.stop?.(ctx);
    expect(getAcpRuntimeBackend("acpx")).toBeNull();

    const { service: generationB, runtime: runtimeB } = await start();
    expect(runtimeB).toBeTruthy();
    expect(runtimeB).not.toBe(runtimeA);
    expect(runtimeB).not.toBe(realRuntime);
    expect(concurrentCallSettled).toBe(false);

    releaseProbe.resolve();
    await stoppingA;

    expect(await activationResult).toEqual(stoppedDuringActivation());
    expect(await concurrentCallResult).toEqual(stoppedDuringActivation());
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtimeB);
    await expect(session(runtimeA, "stale-generation-a")).rejects.toThrow(notStarted);

    await generationB.stop?.(ctx);
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });

  it("keeps the explicit runtime skip env as the only outer startup skip", async () => {
    vi.stubEnv("OPENCLAW_SKIP_ACPX_RUNTIME", "1");
    await start();

    expect(createServiceMock).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)",
    );
  });
});
