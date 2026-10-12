import type {
  OpenClawPluginApi,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRegistryFixture } from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  createEmptyPluginRegistry,
  createPluginRecord,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  assertMxcReadinessMock,
  warnMxcHostPrepIfNeededMock,
  createMxcSandboxBackendFactoryMock,
  mxcSandboxBackendManagerMock,
  resolveMxcBinaryPathMock,
  readinessProbeExecMock,
} = vi.hoisted(() => {
  return {
    assertMxcReadinessMock: vi.fn<(params: { executablePath: string }) => void>(),
    warnMxcHostPrepIfNeededMock: vi.fn(),
    createMxcSandboxBackendFactoryMock: vi.fn(() => async () => {
      throw new Error("MXC provider must not run in registration tests");
    }),
    mxcSandboxBackendManagerMock: { describeRuntime: vi.fn(), removeRuntime: vi.fn() },
    resolveMxcBinaryPathMock: vi.fn(() => "mxc-test-binary"),
    readinessProbeExecMock: vi.fn(),
  };
});

vi.mock("../src/binary-resolver.js", () => ({
  resolveMxcBinaryPath: resolveMxcBinaryPathMock,
}));

vi.mock("../src/mxc-backend-factory.js", () => ({
  createMxcSandboxBackendFactory: createMxcSandboxBackendFactoryMock,
}));

vi.mock("../src/mxc-backend.js", () => ({
  mxcSandboxBackendManager: mxcSandboxBackendManagerMock,
}));

vi.mock("../src/readiness.js", () => ({
  assertMxcReadiness: assertMxcReadinessMock,
  warnMxcHostPrepIfNeeded: warnMxcHostPrepIfNeededMock,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: readinessProbeExecMock,
}));

import { registerMxcPlugin } from "../src/plugin.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function readBackend() {
  return {
    factory: getSandboxBackendFactory("mxc"),
    manager: getSandboxBackendManager("mxc"),
    resolveWorkdir: getSandboxBackendWorkdirResolver("mxc"),
  };
}

const stops: Array<() => Promise<void>> = [];

function setProcessPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
}

function restoreProcessPlatformForTest(): void {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

function createApi(
  pluginConfig: Record<string, unknown> | undefined = {},
  registrationMode: OpenClawPluginApi["registrationMode"] = "full",
) {
  const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
  const registerService = vi.fn();
  const api = createTestPluginApi({
    id: "mxc",
    pluginConfig,
    registrationMode,
    registerService,
    registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
  });
  const cleanup = async (
    context: Parameters<NonNullable<PluginRuntimeLifecycleRegistration["cleanup"]>>[0],
  ) => {
    for (const lifecycle of lifecycles.toReversed()) {
      await lifecycle.cleanup?.(context);
    }
  };
  const stop = () => cleanup({ reason: "disable" });
  stops.push(stop);

  return { api, registerService, lifecycles, cleanup, stop };
}

describe("registerMxcPlugin", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assertMxcReadinessMock.mockReset();
    warnMxcHostPrepIfNeededMock.mockClear();
    createMxcSandboxBackendFactoryMock.mockClear();
    readinessProbeExecMock.mockReset();
    resolveMxcBinaryPathMock.mockReset();
    resolveMxcBinaryPathMock.mockReturnValue("mxc-test-binary");
    setProcessPlatformForTest("win32");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const stop of stops.splice(0).toReversed()) {
      await stop();
    }
    warnSpy.mockRestore();
    restoreProcessPlatformForTest();
  });

  test("warns and stays dormant on non-Windows platforms", () => {
    setProcessPlatformForTest("darwin");
    const original = readBackend();
    const { api, registerService, lifecycles } = createApi();

    registerMxcPlugin(api);

    expect(warnSpy).toHaveBeenCalledWith(
      "[mxc] Sandbox backend is Windows-only and not available on darwin. Plugin will be dormant.",
    );
    expect(resolveMxcBinaryPathMock).not.toHaveBeenCalled();
    expect(assertMxcReadinessMock).not.toHaveBeenCalled();
    expect(readBackend()).toEqual(original);
    expect(lifecycles).toEqual([]);
    expect(registerService).not.toHaveBeenCalled();
  });

  test("does not register runtime hooks during discovery", () => {
    const original = readBackend();
    const { api, registerService, lifecycles } = createApi({ timeoutSeconds: 60 }, "discovery");

    registerMxcPlugin(api);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(resolveMxcBinaryPathMock).not.toHaveBeenCalled();
    expect(assertMxcReadinessMock).not.toHaveBeenCalled();
    expect(warnMxcHostPrepIfNeededMock).not.toHaveBeenCalled();
    expect(createMxcSandboxBackendFactoryMock).not.toHaveBeenCalled();
    expect(readBackend()).toEqual(original);
    expect(lifecycles).toEqual([]);
    expect(registerService).not.toHaveBeenCalled();
  });

  test("registers eagerly on Windows and restores hooks on global restart", async () => {
    const original = readBackend();
    const { api, cleanup, stop } = createApi({ timeoutSeconds: 60 });

    registerMxcPlugin(api);

    expect(resolveMxcBinaryPathMock).toHaveBeenCalledWith(undefined);
    expect(assertMxcReadinessMock).toHaveBeenCalledWith({ executablePath: "mxc-test-binary" });
    expect(warnMxcHostPrepIfNeededMock).toHaveBeenCalledWith();
    expect(createMxcSandboxBackendFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutSeconds: 60,
      }),
    );
    expect(readBackend()).toEqual({
      factory: expect.any(Function),
      manager: mxcSandboxBackendManagerMock,
      resolveWorkdir: null,
    });
    await cleanup({ reason: "restart" });
    expect(readBackend()).toEqual(original);
    await stop();
    expect(readBackend()).toEqual(original);
  });

  test("blocks an older override and registers after selecting a compatible executor", async () => {
    const { assertMxcReadiness: runMxcReadiness } =
      await vi.importActual<typeof import("../src/readiness.js")>("../src/readiness.js");
    const legacyOverride = "C:\\Tools\\old-wxc-exec.exe";
    const compatibleOverride = "C:\\Tools\\wxc-exec.exe";
    const original = readBackend();
    const legacy = createApi({ mxcBinaryPath: legacyOverride });
    resolveMxcBinaryPathMock.mockReturnValueOnce(legacyOverride);
    readinessProbeExecMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === legacyOverride && args[0] === "--probe") {
        throw new Error("Command failed: old-wxc-exec.exe --probe");
      }
      throw new Error(`unexpected probe: ${command}`);
    });
    assertMxcReadinessMock.mockImplementation(({ executablePath }) =>
      runMxcReadiness({ executablePath }),
    );

    expect(() => registerMxcPlugin(legacy.api)).toThrow(
      /selected executor must be compatible with MXC 0\.8\.0.*unset plugins\.entries\.mxc\.config\.mxcBinaryPath.*restart the Gateway/u,
    );
    expect(resolveMxcBinaryPathMock).toHaveBeenNthCalledWith(1, legacyOverride);
    expect(readinessProbeExecMock).toHaveBeenCalledWith(
      legacyOverride,
      ["--probe"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(readBackend()).toEqual(original);
    expect(createMxcSandboxBackendFactoryMock).not.toHaveBeenCalled();
    expect(legacy.lifecycles).toEqual([]);

    const recovered = createApi({ mxcBinaryPath: compatibleOverride });
    resolveMxcBinaryPathMock.mockReturnValueOnce(compatibleOverride);
    readinessProbeExecMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === compatibleOverride && args[0] === "--probe") {
        return JSON.stringify({ tier: "base-container", warnings: [] });
      }
      throw new Error(`unexpected probe: ${command}`);
    });

    expect(() => registerMxcPlugin(recovered.api)).not.toThrow();
    expect(resolveMxcBinaryPathMock).toHaveBeenNthCalledWith(2, compatibleOverride);
    expect(readinessProbeExecMock).toHaveBeenCalledWith(
      compatibleOverride,
      ["--probe"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(readBackend().factory).toEqual(expect.any(Function));
    await recovered.stop();
    expect(readBackend()).toEqual(original);
  });

  test.each(["disable", "reset"] as const)(
    "preserves backend hooks during scoped %s cleanup",
    async (reason) => {
      const generation = createApi();
      registerMxcPlugin(generation.api);
      const backend = readBackend();
      for (const scope of [
        { sessionKey: "agent:other:main" },
        { runId: "other-run" },
        { sessionKey: "" },
        { runId: "" },
      ]) {
        await generation.cleanup({ reason, ...scope });
        expect(readBackend()).toEqual(backend);
      }
      if (reason === "reset") {
        await generation.cleanup({ reason });
        expect(readBackend()).toEqual(backend);
      }
    },
  );

  test.each(["older-first", "newer-first"] as const)(
    "preserves live registrations when generations retire %s",
    async (order) => {
      const original = readBackend();
      const older = createApi();
      registerMxcPlugin(older.api);
      const olderBackend = readBackend();
      const newer = createApi();
      registerMxcPlugin(newer.api);
      const newerBackend = readBackend();
      expect(newerBackend.factory).not.toBe(olderBackend.factory);
      const first = order === "older-first" ? older : newer;
      const last = order === "older-first" ? newer : older;
      await first.stop();
      expect(readBackend()).toEqual(order === "older-first" ? newerBackend : olderBackend);
      await last.stop();
      expect(readBackend()).toEqual(original);
      await first.stop();
      expect(readBackend()).toEqual(original);
    },
  );

  test("retires a registered backend even when no plugin services ever start", async () => {
    const original = readBackend();
    const originalRegistry = getActivePluginRegistry();
    const { registry } = createPluginRegistryFixture();
    const record = createPluginRecord({ id: "mxc" });
    registry.registry.plugins.push(record);
    registerMxcPlugin(registry.createApi(record, { config: {}, pluginConfig: {} }));
    try {
      expect(readBackend().factory).toEqual(expect.any(Function));
      setActivePluginRegistry(registry.registry);
      setActivePluginRegistry(createEmptyPluginRegistry());
      await expect.poll(readBackend).toEqual(original);
    } finally {
      await expect(disposePluginRegistryInstances(registry.registry)).resolves.toMatchObject({
        failures: [],
      });
      if (originalRegistry) {
        setActivePluginRegistry(originalRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
    }
  });

  test("keeps the existing binary-resolution failure path after host support passes", () => {
    resolveMxcBinaryPathMock.mockImplementation(() => {
      throw new Error("missing binary");
    });
    const original = readBackend();
    const { api, registerService, lifecycles } = createApi();

    expect(() => registerMxcPlugin(api)).toThrow(
      "[mxc] MXC sandbox backend cannot load: missing binary. Install @microsoft/mxc-sdk or set mxcBinaryPath.",
    );

    expect(warnSpy).not.toHaveBeenCalled();
    expect(assertMxcReadinessMock).not.toHaveBeenCalled();
    expect(readBackend()).toEqual(original);
    expect(lifecycles).toEqual([]);
    expect(registerService).not.toHaveBeenCalled();
  });
});
