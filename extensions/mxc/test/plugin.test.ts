import type {
  OpenClawPluginApi,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRegistryFixture } from "openclaw/plugin-sdk/plugin-test-contracts";
import * as registryApi from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveNative: vi.fn(() => ({
    binDir: "C:\\mxc",
    archDir: "C:\\mxc\\x64",
    executorPath: "C:\\mxc\\x64\\wxc-exec.exe",
    nativeLibraryPath: "C:\\mxc\\x64\\mxc_ffi.dll",
  })),
  probe: vi.fn(),
}));
// mock-isolation: Registration probes synthetic native components, never the host installation.
vi.mock("../src/binary-resolver.js", () => ({
  resolveMxcNativeBinaries: mocks.resolveNative,
  buildMxcNativeEnv: (binaries: { binDir: string; archDir: string }) => ({
    MXC_BIN_DIR: binaries.binDir,
    MXC_FFI_DIR: binaries.archDir,
  }),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.probe,
}));

import { registerMxcPlugin } from "../src/plugin.js";

const readyProbe = JSON.stringify({
  probe: { tier: "base-container", warnings: [], probes: {} },
});
const originalPlatform = process.platform;
const originalNodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node")!;

function readBackend() {
  return {
    factory: getSandboxBackendFactory("mxc"),
    manager: getSandboxBackendManager("mxc"),
    resolveWorkdir: getSandboxBackendWorkdirResolver("mxc"),
  };
}

const stops: Array<() => Promise<void>> = [];

function setProcessPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function createApi(
  pluginConfig: Record<string, unknown> | undefined = {},
  registrationMode: OpenClawPluginApi["registrationMode"] = "full",
) {
  const original = readBackend();
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

  return {
    cleanup,
    stop,
    register: () => registerMxcPlugin(api),
    expectDormant() {
      expect(readBackend()).toEqual(original);
      expect(lifecycles).toEqual([]);
      expect(registerService).not.toHaveBeenCalled();
    },
  };
}

function selectNative(override: string) {
  const native = {
    binDir: "C:\\mxc",
    archDir: "C:\\mxc\\x64",
    executorPath: "C:\\mxc\\x64\\wxc-exec.exe",
    nativeLibraryPath: "C:\\mxc\\x64\\mxc_ffi.dll",
  };
  mocks.resolveNative.mockReturnValueOnce(native);
  mocks.probe.mockImplementationOnce(
    (command: string, args: readonly string[], options: unknown) => {
      expect(command).toBe(process.execPath);
      expect(args.at(-1)).toBe("--probe");
      expect(options).toMatchObject({
        encoding: "utf-8",
        env: { MXC_BIN_DIR: native.binDir, MXC_FFI_DIR: native.archDir },
      });
      expect(mocks.resolveNative).toHaveBeenLastCalledWith(override);
      return readyProbe;
    },
  );
}

describe("registerMxcPlugin", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.probe.mockReset().mockImplementation((command: string) => {
      return command === process.execPath ? readyProbe : "S-1-15-2-1";
    });
    mocks.resolveNative.mockReset();
    mocks.resolveNative.mockReturnValue({
      binDir: "C:\\mxc",
      archDir: "C:\\mxc\\x64",
      executorPath: "C:\\mxc\\x64\\wxc-exec.exe",
      nativeLibraryPath: "C:\\mxc\\x64\\mxc_ffi.dll",
    });
    setProcessPlatformForTest("win32");
    Object.defineProperty(process.versions, "node", {
      ...originalNodeVersion,
      value: "24.21.0",
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const stop of stops.splice(0).toReversed()) {
      await stop();
    }
    warnSpy.mockRestore();
    setProcessPlatformForTest(originalPlatform);
    Object.defineProperty(process.versions, "node", originalNodeVersion);
  });

  test.each([
    ["unsupported host", "darwin", "full"],
    ["discovery", "win32", "discovery"],
    ["missing binary", "win32", "full"],
  ] as const)("stays dormant for %s", (reason, platform, mode) => {
    setProcessPlatformForTest(platform);
    const fixture = createApi({ timeoutSeconds: 60 }, mode);
    if (reason === "missing binary") {
      mocks.resolveNative.mockImplementation(() => {
        throw new Error("missing binary");
      });
      expect(fixture.register).toThrow("[mxc] MXC sandbox backend cannot load: missing binary");
    } else {
      fixture.register();
      expect(mocks.resolveNative).not.toHaveBeenCalled();
    }
    if (platform === "darwin") {
      expect(warnSpy).toHaveBeenCalledWith(
        "[mxc] Sandbox backend is Windows-only and not available on darwin. Plugin will be dormant.",
      );
    } else {
      expect(warnSpy).not.toHaveBeenCalled();
    }
    expect(mocks.probe).not.toHaveBeenCalled();
    fixture.expectDormant();
  });

  test("blocks an older override and registers after selecting compatible native components", async () => {
    const legacyOverride = "C:\\Tools\\old-wxc-exec.exe";
    const compatibleOverride = "C:\\Tools\\x64\\wxc-exec.exe";
    const original = readBackend();
    const legacy = createApi({ mxcBinaryPath: legacyOverride });
    mocks.resolveNative.mockImplementationOnce(() => {
      throw new Error('MXC binary override must be in an "x64" directory');
    });

    expect(legacy.register).toThrow(
      '[mxc] MXC sandbox backend cannot load: MXC binary override must be in an "x64" directory',
    );
    legacy.expectDormant();

    const recovered = createApi({ mxcBinaryPath: compatibleOverride });
    selectNative(compatibleOverride);

    expect(recovered.register).not.toThrow();
    expect(mocks.resolveNative).toHaveBeenCalledTimes(2);
    expect(readBackend().factory).toEqual(expect.any(Function));
    await recovered.cleanup({ reason: "restart" });
    expect(readBackend()).toEqual(original);
  });

  test("preserves backend hooks during scoped reset cleanup", async () => {
    const generation = createApi();
    generation.register();
    const backend = readBackend();
    for (const scope of [
      { sessionKey: "agent:other:main" },
      { runId: "other-run" },
      { sessionKey: "" },
      { runId: "" },
    ]) {
      await generation.cleanup({ reason: "reset", ...scope });
      expect(readBackend()).toEqual(backend);
    }
    await generation.cleanup({ reason: "reset" });
    expect(readBackend()).toEqual(backend);
  });

  test.each(["older-first", "newer-first"] as const)(
    "preserves live registrations when generations retire %s",
    async (order) => {
      const original = readBackend();
      const older = createApi();
      older.register();
      const olderBackend = readBackend();
      const newer = createApi();
      newer.register();
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
    const originalRegistry = registryApi.getActivePluginRegistry();
    const { registry } = createPluginRegistryFixture();
    const record = registryApi.createPluginRecord({ id: "mxc" });
    registry.registry.plugins.push(record);
    const api = registry.createApi(record, { config: {}, pluginConfig: {} });
    registerMxcPlugin(api);
    try {
      expect(readBackend().factory).toEqual(expect.any(Function));
      registryApi.setActivePluginRegistry(registry.registry);
      registryApi.setActivePluginRegistry(registryApi.createEmptyPluginRegistry());
      await expect(
        registryApi.waitForPluginRegistryRetirement(registry.registry),
      ).resolves.toMatchObject({
        failures: [],
      });
      expect(readBackend()).toEqual(original);
    } finally {
      await expect(
        registryApi.disposePluginRegistryInstances(registry.registry),
      ).resolves.toMatchObject({
        failures: [],
      });
      if (originalRegistry) {
        registryApi.setActivePluginRegistry(originalRegistry);
      } else {
        registryApi.resetPluginRuntimeStateForTest();
      }
    }
  });
});
