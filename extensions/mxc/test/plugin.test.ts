import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
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
  readinessProbeExecMock,
} = vi.hoisted(() => {
  return {
    assertMxcReadinessMock: vi.fn<(params: { nativeEnv: Record<string, string> }) => void>(),
    warnMxcHostPrepIfNeededMock: vi.fn(),
    createMxcSandboxBackendFactoryMock: vi.fn(() => async () => {
      throw new Error("MXC provider must not run in registration tests");
    }),
    mxcSandboxBackendManagerMock: { describeRuntime: vi.fn(), removeRuntime: vi.fn() },
    readinessProbeExecMock: vi.fn(),
  };
});

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
const arch = process.arch === "arm64" ? "arm64" : "x64";
const sdkBinDir = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@microsoft/mxc-sdk/package.json")),
  "bin",
);
const sdkNativeEnv = { MXC_BIN_DIR: sdkBinDir, MXC_FFI_DIR: path.join(sdkBinDir, arch) };

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

    expect(assertMxcReadinessMock).toHaveBeenCalledWith({ nativeEnv: sdkNativeEnv });
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

  test("blocks an SDK 0.8 override layout and registers after selecting an MXC 1.0 layout", async () => {
    const { assertMxcReadiness: runMxcReadiness } =
      await vi.importActual<typeof import("../src/readiness.js")>("../src/readiness.js");
    const root = mkdtempSync(path.join(tmpdir(), "mxc-plugin-override-"));
    const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    Object.defineProperty(process.versions, "node", { ...nodeVersion, value: "24.21.0" });
    try {
      const legacyOverride = path.join(root, "tools", "wxc-exec.exe");
      const compatibleOverride = path.join(root, "release", arch, "wxc-exec.exe");
      for (const executor of [legacyOverride, compatibleOverride]) {
        mkdirSync(path.dirname(executor), { recursive: true });
        writeFileSync(executor, "");
        writeFileSync(path.join(path.dirname(executor), "mxc_ffi.dll"), "");
      }
      const original = readBackend();
      const legacy = createApi({ mxcBinaryPath: legacyOverride });
      assertMxcReadinessMock.mockImplementation(runMxcReadiness);

      expect(() => registerMxcPlugin(legacy.api)).toThrow(
        `[mxc] MXC sandbox backend cannot load: MXC binary override ${legacyOverride} must be in an "${arch}" directory`,
      );
      expect(assertMxcReadinessMock).not.toHaveBeenCalled();
      expect(readinessProbeExecMock).not.toHaveBeenCalled();
      expect(readBackend()).toEqual(original);
      expect(createMxcSandboxBackendFactoryMock).not.toHaveBeenCalled();
      expect(legacy.lifecycles).toEqual([]);

      const recovered = createApi({ mxcBinaryPath: compatibleOverride });
      const nativeEnv = {
        MXC_BIN_DIR: path.join(root, "release"),
        MXC_FFI_DIR: path.join(root, "release", arch),
      };
      readinessProbeExecMock.mockImplementation(
        (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
          if (
            command === process.execPath &&
            args[1] === "--probe" &&
            options.env?.MXC_BIN_DIR === nativeEnv.MXC_BIN_DIR &&
            options.env.MXC_FFI_DIR === nativeEnv.MXC_FFI_DIR
          ) {
            return JSON.stringify({
              probe: { tier: "base-container", warnings: [], probes: {} },
            });
          }
          throw new Error(`unexpected probe: ${command}`);
        },
      );

      expect(() => registerMxcPlugin(recovered.api)).not.toThrow();
      expect(assertMxcReadinessMock).toHaveBeenCalledWith({ nativeEnv });
      expect(readinessProbeExecMock).toHaveBeenCalledTimes(1);
      expect(readBackend().factory).toEqual(expect.any(Function));
      await recovered.stop();
      expect(readBackend()).toEqual(original);
    } finally {
      Object.defineProperty(process.versions, "node", nodeVersion);
      rmSync(root, { force: true, recursive: true });
    }
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

  test("fails activation when the configured native components are missing", () => {
    const missing = path.join(tmpdir(), "mxc-plugin-missing", arch, "wxc-exec.exe");
    const original = readBackend();
    const { api, registerService, lifecycles } = createApi({ mxcBinaryPath: missing });

    expect(() => registerMxcPlugin(api)).toThrow(
      `[mxc] MXC sandbox backend cannot load: MXC binary not found at configured path: ${missing}`,
    );

    expect(warnSpy).not.toHaveBeenCalled();
    expect(assertMxcReadinessMock).not.toHaveBeenCalled();
    expect(readBackend()).toEqual(original);
    expect(lifecycles).toEqual([]);
    expect(registerService).not.toHaveBeenCalled();
  });
});
