import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSrtSandboxBackendFactory,
  createSrtSandboxBackendManager,
  shutdownSrtSandboxRuntime,
  SRT_SANDBOX_BACKEND_ID,
} from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";
import { assertSrtSandboxAvailable } from "./dependency-probe.js";

const srt = vi.hoisted(() => ({
  config: undefined as SandboxRuntimeConfig | undefined,
  proxyPort: undefined as number | undefined,
  initialize: vi.fn<(config: SandboxRuntimeConfig) => Promise<void>>(),
  reset: vi.fn<() => Promise<void>>(),
}));

vi.mock("@anthropic-ai/sandbox-runtime", async (importActual) => {
  const actual = await importActual<typeof import("@anthropic-ai/sandbox-runtime")>();
  return {
    ...actual,
    SandboxManager: {
      ...actual.SandboxManager,
      initialize: srt.initialize,
      reset: srt.reset,
      isSandboxingEnabled: () => srt.config !== undefined,
      getConfig: () => srt.config,
      getProxyPort: () => srt.proxyPort,
    },
  };
});

vi.mock("./dependency-probe.js", async (importActual) => ({
  ...(await importActual<typeof import("./dependency-probe.js")>()),
  assertSrtSandboxAvailable: vi.fn().mockResolvedValue(undefined),
}));

function makeParams(scopeKey: string): CreateSandboxBackendParams {
  return {
    sessionKey: scopeKey,
    scopeKey,
    workspaceDir: "/tmp/srt-lifecycle",
    agentWorkspaceDir: "/tmp/srt-lifecycle-agent",
    cfg: {
      mode: "all",
      backend: SRT_SANDBOX_BACKEND_ID,
      scope: "session",
      workspaceAccess: "rw",
      workspaceRoot: "/tmp/srt-lifecycle",
      dockerTmpfsSource: "default",
      docker: { workdir: "/tmp/srt-lifecycle", env: {} },
      ssh: {},
      browser: {},
      tools: {},
      prune: {},
    } as unknown as CreateSandboxBackendParams["cfg"],
  };
}

let factory: ReturnType<typeof createSrtSandboxBackendFactory>;

function startPluginCycle(): void {
  factory = createSrtSandboxBackendFactory({
    pluginConfig: resolveSrtPluginConfig(undefined),
  });
}

async function removeScope(scopeKey: string): Promise<void> {
  const manager = createSrtSandboxBackendManager();
  await manager.removeRuntime({
    entry: { containerName: scopeKey },
  } as Parameters<NonNullable<typeof manager.removeRuntime>>[0]);
}

beforeEach(() => {
  srt.config = undefined;
  srt.proxyPort = undefined;
  srt.initialize.mockReset().mockImplementation(async (config) => {
    srt.config = config;
    srt.proxyPort = 43123;
  });
  srt.reset.mockReset().mockImplementation(async () => {
    srt.config = undefined;
    srt.proxyPort = undefined;
  });
  startPluginCycle();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownSrtSandboxRuntime();
  srt.config = undefined;
  srt.proxyPort = undefined;
});

describe("process-global SRT runtime lifecycle", () => {
  it("disposes a Windows-only scope without resetting an external manager owner", async () => {
    srt.config = {} as SandboxRuntimeConfig;
    srt.proxyPort = 49999;
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    await factory(makeParams("windows-external-owner"));
    await Promise.all([shutdownSrtSandboxRuntime(), shutdownSrtSandboxRuntime()]);

    expect(srt.reset).not.toHaveBeenCalled();
    expect(srt.config).toBeDefined();
    expect(srt.proxyPort).toBe(49999);

    // Plugin stop retired the Windows scope, so a later plugin cycle can admit
    // the one supported Windows scope without disturbing the external owner.
    startPluginCycle();
    await factory(makeParams("windows-after-restart"));
    await shutdownSrtSandboxRuntime();
    expect(srt.reset).not.toHaveBeenCalled();
    expect(srt.proxyPort).toBe(49999);
    platform.mockRestore();
  });

  it("disposes mixed Windows and manager-backed scopes and resets the final manager owner", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await factory(makeParams("windows-mixed"));
    platform.mockReturnValue("darwin");
    await factory(makeParams("manager-mixed"));

    await Promise.all([shutdownSrtSandboxRuntime(), shutdownSrtSandboxRuntime()]);

    expect(srt.reset).toHaveBeenCalledTimes(1);
    expect(srt.proxyPort).toBeUndefined();

    platform.mockReturnValue("win32");
    startPluginCycle();
    await factory(makeParams("windows-after-mixed-stop"));
    await shutdownSrtSandboxRuntime();
    expect(srt.reset).toHaveBeenCalledTimes(1);
    platform.mockRestore();
  });

  it("rejects admission throughout an in-flight shutdown", async () => {
    await factory(makeParams("first"));
    const resetStarted = Promise.withResolvers<void>();
    const releaseReset = Promise.withResolvers<void>();
    srt.reset.mockImplementationOnce(async () => {
      resetStarted.resolve();
      await releaseReset.promise;
      srt.config = undefined;
      srt.proxyPort = undefined;
    });

    const shutdown = shutdownSrtSandboxRuntime();
    await resetStarted.promise;
    expect(srt.proxyPort).toBe(43123);

    await expect(factory(makeParams("racing"))).rejects.toThrow(
      "runtime admission rejected while shutdown is in progress",
    );
    expect(srt.initialize).toHaveBeenCalledTimes(1);

    releaseReset.resolve();
    await shutdown;
    expect(srt.proxyPort).toBeUndefined();
  });

  it("keeps the runtime live for non-final scope disposal and resets for the final owner", async () => {
    await factory(makeParams("scope-a"));
    await factory(makeParams("scope-b"));
    expect(srt.initialize).toHaveBeenCalledTimes(1);

    await removeScope("scope-a");
    expect(srt.reset).not.toHaveBeenCalled();
    expect(srt.proxyPort).toBe(43123);

    await removeScope("scope-b");
    expect(srt.reset).toHaveBeenCalledTimes(1);
    expect(srt.proxyPort).toBeUndefined();
  });

  it("coalesces concurrent and repeated shutdown and supports a later plugin cycle", async () => {
    await factory(makeParams("before-restart"));
    const resetStarted = Promise.withResolvers<void>();
    const releaseReset = Promise.withResolvers<void>();
    srt.reset.mockImplementationOnce(async () => {
      resetStarted.resolve();
      await releaseReset.promise;
      srt.config = undefined;
      srt.proxyPort = undefined;
    });

    const first = shutdownSrtSandboxRuntime();
    const second = shutdownSrtSandboxRuntime();
    await resetStarted.promise;
    expect(srt.reset).toHaveBeenCalledTimes(1);
    releaseReset.resolve();
    await Promise.all([first, second]);
    await shutdownSrtSandboxRuntime();
    expect(srt.reset).toHaveBeenCalledTimes(1);

    startPluginCycle();
    await factory(makeParams("after-restart"));
    expect(srt.initialize).toHaveBeenCalledTimes(2);
    expect(srt.proxyPort).toBe(43123);
  });

  it("cleans up a failed initialization before allowing a retry", async () => {
    srt.initialize.mockRejectedValueOnce(new Error("injected initialization failure"));
    await expect(factory(makeParams("failed"))).rejects.toThrow("injected initialization failure");
    expect(srt.reset).toHaveBeenCalledTimes(1);

    await factory(makeParams("retry"));
    expect(srt.initialize).toHaveBeenCalledTimes(2);
    expect(srt.proxyPort).toBe(43123);
  });

  it("rejects a racing Windows admission after the existing Windows scope is disposed mid-shutdown", async () => {
    // Initial live scopes: one Windows scope plus a manager-backed scope. The
    // manager owner forces a reset(), giving a deterministic pause point AFTER
    // the Windows scope has been disposed (which clears the internal
    // windows-active flag) but BEFORE plugin teardown has completed.
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await factory(makeParams("windows-initial"));
    platform.mockReturnValue("darwin");
    await factory(makeParams("manager-anchor"));

    const resetStarted = Promise.withResolvers<void>();
    const releaseReset = Promise.withResolvers<void>();
    srt.reset.mockImplementationOnce(async () => {
      resetStarted.resolve();
      await releaseReset.promise;
      srt.config = undefined;
      srt.proxyPort = undefined;
    });

    const shutdown = shutdownSrtSandboxRuntime();
    await resetStarted.promise;

    // The Windows scope has been disposed, so the per-scope windows-active flag
    // alone no longer rejects. A concurrent Windows factory must still fail
    // closed on the shared plugin-wide teardown authority and never publish a
    // scope that would outlive the in-flight shutdown.
    platform.mockReturnValue("win32");
    await expect(factory(makeParams("windows-racing"))).rejects.toThrow(
      "runtime admission rejected while shutdown is in progress",
    );

    releaseReset.resolve();
    await shutdown;
    expect(srt.reset).toHaveBeenCalledTimes(1);

    // The rejected admission left no surviving Windows scope, so a completed
    // restart boundary admits exactly one fresh Windows scope again.
    startPluginCycle();
    await factory(makeParams("windows-after-restart"));
    await shutdownSrtSandboxRuntime();
    expect(srt.reset).toHaveBeenCalledTimes(1);
    platform.mockRestore();
  });

  it("fails closed and disposes the partial Windows scope when teardown begins during provisioning", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    await factory(makeParams("manager-anchor"));

    // Pause the Windows availability probe so a shutdown can claim teardown
    // after the scope reserves the windows slot but before it publishes.
    const probe = vi.mocked(assertSrtSandboxAvailable);
    const probeStarted = Promise.withResolvers<void>();
    const releaseProbe = Promise.withResolvers<void>();
    probe.mockImplementationOnce(async () => {
      probeStarted.resolve();
      await releaseProbe.promise;
    });

    platform.mockReturnValue("win32");
    const racing = factory(makeParams("windows-provisioning"));
    await probeStarted.promise;

    const resetStarted = Promise.withResolvers<void>();
    const releaseReset = Promise.withResolvers<void>();
    srt.reset.mockImplementationOnce(async () => {
      resetStarted.resolve();
      await releaseReset.promise;
      srt.config = undefined;
      srt.proxyPort = undefined;
    });

    const shutdown = shutdownSrtSandboxRuntime();
    await resetStarted.promise;

    // Teardown is now in progress; the in-flight Windows provisioning must
    // recheck the shared authority at publish time, fail closed, and dispose
    // the partial scope rather than leak it past shutdown.
    releaseProbe.resolve();
    await expect(racing).rejects.toThrow(
      "runtime admission rejected while shutdown is in progress",
    );

    releaseReset.resolve();
    await shutdown;

    // The failed admission released the windows slot, so a fresh scope admits.
    startPluginCycle();
    await factory(makeParams("windows-after-failed-provisioning"));
    await shutdownSrtSandboxRuntime();
    platform.mockRestore();
  });

  it("holds admission closed through final unregister and requires a fresh plugin cycle", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await factory(makeParams("windows-before-unregister"));
    const staleFactory = factory;
    const unregisterStarted = Promise.withResolvers<void>();
    const releaseUnregister = Promise.withResolvers<void>();

    const shutdown = shutdownSrtSandboxRuntime({
      finishTeardown: async () => {
        unregisterStarted.resolve();
        await releaseUnregister.promise;
      },
    });
    await unregisterStarted.promise;

    try {
      await expect(staleFactory(makeParams("windows-during-unregister"))).rejects.toThrow(
        "runtime admission rejected while shutdown is in progress",
      );
    } finally {
      releaseUnregister.resolve();
    }
    await shutdown;

    await expect(staleFactory(makeParams("windows-after-stop"))).rejects.toThrow(
      "runtime admission rejected while shutdown is in progress",
    );
    startPluginCycle();
    await factory(makeParams("windows-after-register"));
    await shutdownSrtSandboxRuntime();
    platform.mockRestore();
  });

  it("runs a teardown finalizer added by a coalesced shutdown", async () => {
    await factory(makeParams("manager-before-coalesced-stop"));
    const resetStarted = Promise.withResolvers<void>();
    const releaseReset = Promise.withResolvers<void>();
    srt.reset.mockImplementationOnce(async () => {
      resetStarted.resolve();
      await releaseReset.promise;
      srt.config = undefined;
      srt.proxyPort = undefined;
    });
    const finalizer = vi.fn();

    const first = shutdownSrtSandboxRuntime();
    await resetStarted.promise;
    const second = shutdownSrtSandboxRuntime({ finishTeardown: finalizer });
    releaseReset.resolve();
    await Promise.all([first, second]);

    expect(finalizer).toHaveBeenCalledTimes(1);
  });

  it("unregisters after failed cleanup and admits only after a successful retry", async () => {
    await factory(makeParams("manager-before-failed-stop"));
    srt.reset.mockRejectedValueOnce(new Error("injected reset failure"));
    const unregister = vi.fn();

    await expect(shutdownSrtSandboxRuntime({ finishTeardown: unregister })).rejects.toThrow(
      "injected reset failure",
    );
    expect(unregister).toHaveBeenCalledTimes(1);

    expect(() => startPluginCycle()).not.toThrow();
    await expect(factory(makeParams("manager-while-faulted"))).rejects.toThrow(
      "runtime cleanup failed; shutdown must succeed before retry",
    );

    await shutdownSrtSandboxRuntime();
    await factory(makeParams("manager-after-cleanup-retry"));
  });

  it("rejects a process-global runtime already owned by another SRT consumer", async () => {
    srt.config = {} as SandboxRuntimeConfig;
    srt.proxyPort = 49999;

    await expect(factory(makeParams("conflict"))).rejects.toThrow(
      "the process-global SRT runtime is already owned outside this plugin",
    );
    expect(srt.initialize).not.toHaveBeenCalled();
    expect(srt.reset).not.toHaveBeenCalled();
  });
});
