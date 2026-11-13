import path from "node:path";
import type * as plugin from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRegistryFixture } from "openclaw/plugin-sdk/plugin-test-contracts";
import * as registryApi from "openclaw/plugin-sdk/plugin-test-runtime";
import * as sandbox from "openclaw/plugin-sdk/sandbox";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveBinary: vi.fn(() => "mxc-test-binary"), probe: vi.fn() }));
// mock-isolation: Registration probes a synthetic binary, never the host installation.
vi.mock("../src/binary-resolver.js", () => ({ resolveMxcBinaryPath: mocks.resolveBinary }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.probe,
}));

import { registerMxcPlugin } from "../src/plugin.js";

const originalPlatform = process.platform;
const icacls = path.win32.join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
  "icacls.exe",
);
function mockHost(
  probe: string | Record<string, unknown> | Error,
  systemDriveAcl = "S-1-15-2-1:(R)",
  binary = "mxc-test-binary",
) {
  mocks.probe.mockImplementation((command: string, args: string[] = []) => {
    if (command === binary && args.length === 1 && args[0] === "--probe") {
      if (probe instanceof Error) {
        throw probe;
      }
      return typeof probe === "string" ? probe : JSON.stringify(probe);
    }
    if (command === icacls) {
      return systemDriveAcl;
    }
    throw new Error(`spawn ${command} ENOENT`);
  });
}

function readBackend() {
  return {
    factory: sandbox.getSandboxBackendFactory("mxc"),
    manager: sandbox.getSandboxBackendManager("mxc"),
    resolveWorkdir: sandbox.getSandboxBackendWorkdirResolver("mxc"),
  };
}

type CleanupContext = Parameters<
  NonNullable<plugin.PluginRuntimeLifecycleRegistration["cleanup"]>
>[0];
const stops: Array<() => Promise<void>> = [];

function createApi(options: Partial<plugin.OpenClawPluginApi> = {}) {
  const original = readBackend();
  const lifecycles: plugin.PluginRuntimeLifecycleRegistration[] = [];
  const api = createTestPluginApi({
    id: "mxc",
    ...options,
    registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
  });
  const cleanup = async (context: CleanupContext = { reason: "disable" }) => {
    for (const lifecycle of lifecycles.toReversed()) {
      await lifecycle.cleanup?.(context);
    }
  };
  stops.push(cleanup);

  return {
    original,
    cleanup,
    register: () => {
      registerMxcPlugin(api);
      return readBackend();
    },
  };
}

beforeEach(() => {
  mocks.probe.mockReset();
  mockHost({ tier: "base-container" });
  mocks.resolveBinary.mockReset().mockReturnValue("mxc-test-binary");
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const stop of stops.splice(0).toReversed()) {
    await stop();
  }
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

const assertReady = () => createApi().register();
const expectWarning = (...messages: RegExp[]) =>
  expect(vi.mocked(console.warn).mock.calls).toEqual(
    messages.map((message) => [expect.stringMatching(message)]),
  );

test("reports tier degradation and host-preparation advice without blocking registration", () => {
  mockHost({ tier: "appcontainer-dacl", warnings: ["BaseContainer unavailable"] }, "");
  expect(assertReady).not.toThrow();
  expectWarning(
    /appcontainer-dacl isolation tier: BaseContainer unavailable/u,
    /prepare-system-drive/u,
  );
});

test.each([
  [{ error: "DACL fallback required" }, /cannot select an isolation tier.*DACL fallback required/u],
  [{ tier: "none" }, /host check returned an unexpected result/u],
  ["wxc-exec: unknown option --probe", /host check did not return JSON/u],
] as const)("rejects probe %j", (probe, error) => {
  mockHost(probe);
  expect(assertReady).toThrow(error);
});

test("warns when the system drive lacks AppContainer ACEs", () => {
  mockHost({ tier: "base-container" }, "");
  createApi().register();
  expectWarning(/prepare-system-drive/u);
});

test.each([
  ["unsupported host", "darwin", "full"],
  ["discovery", "win32", "discovery"],
  ["missing binary", "win32", "full"],
] as const)("stays dormant for %s", (reason, platform, mode) => {
  Object.defineProperty(process, "platform", { value: platform });
  const fixture = createApi({ registrationMode: mode });
  if (reason === "missing binary") {
    mocks.resolveBinary.mockImplementation(() => {
      throw new Error("missing binary");
    });
    expect(fixture.register).toThrow(
      /missing binary.*Install @microsoft\/mxc-sdk or set mxcBinaryPath/u,
    );
  } else {
    fixture.register();
    expect(mocks.resolveBinary).not.toHaveBeenCalled();
  }
  if (platform === "darwin") {
    expectWarning(/Windows-only.*darwin.*dormant/u);
  } else {
    expect(console.warn).not.toHaveBeenCalled();
  }
  expect(mocks.probe).not.toHaveBeenCalled();
  expect(readBackend()).toEqual(fixture.original);
});

test("blocks an older override and registers after selecting a compatible executor", async () => {
  const legacyOverride = "C:\\Tools\\old-wxc-exec.exe";
  const compatibleOverride = "C:\\Tools\\wxc-exec.exe";
  const legacy = createApi({ pluginConfig: { mxcBinaryPath: legacyOverride } });
  mocks.resolveBinary.mockReturnValueOnce(legacyOverride);
  mockHost(new Error("Command failed: old-wxc-exec.exe --probe"), undefined, legacyOverride);

  expect(legacy.register).toThrow(
    /--probe for host details.*selected executor must be compatible with MXC 0\.8\.0.*older executor.*unset plugins\.entries\.mxc\.config\.mxcBinaryPath.*restart the Gateway/u,
  );
  expect(mocks.resolveBinary).toHaveBeenLastCalledWith(legacyOverride);
  expect(readBackend()).toEqual(legacy.original);

  const recovered = createApi({ pluginConfig: { mxcBinaryPath: compatibleOverride } });
  mocks.resolveBinary.mockReturnValueOnce(compatibleOverride);
  mockHost({ tier: "base-container" }, undefined, compatibleOverride);

  expect(recovered.register().factory).toEqual(expect.any(Function));
  expect(mocks.resolveBinary).toHaveBeenLastCalledWith(compatibleOverride);
  await recovered.cleanup({ reason: "restart" });
  expect(readBackend()).toEqual(legacy.original);
});

test("preserves backend hooks during scoped disable and unscoped reset", async () => {
  const generation = createApi();
  const backend = generation.register();
  for (const scope of [{ sessionKey: "" }, { runId: "" }]) {
    await generation.cleanup({ reason: "disable", ...scope });
    expect(readBackend()).toEqual(backend);
  }
  await generation.cleanup({ reason: "reset" });
  expect(readBackend()).toEqual(backend);
});

test.each([true, false])(
  "retires older first: %s without losing live hooks",
  async (olderFirst) => {
    const [older, newer] = [createApi(), createApi()];
    const [olderBackend, newerBackend] = [older.register(), newer.register()];
    expect(newerBackend.factory).not.toBe(olderBackend.factory);
    const first = olderFirst ? older : newer;
    const last = olderFirst ? newer : older;
    await first.cleanup();
    expect(readBackend()).toEqual(olderFirst ? newerBackend : olderBackend);
    await last.cleanup();
    expect(readBackend()).toEqual(older.original);
    await first.cleanup();
    expect(readBackend()).toEqual(older.original);
  },
);

test("retires a registered backend even when no plugin services ever start", async () => {
  const original = readBackend();
  const originalRegistry = registryApi.getActivePluginRegistry();
  const { registry } = createPluginRegistryFixture();
  const record = registryApi.createPluginRecord({ id: "mxc" });
  registry.registry.plugins.push(record);
  registerMxcPlugin(registry.createApi(record, { config: {}, pluginConfig: {} }));
  try {
    expect(readBackend().factory).toEqual(expect.any(Function));
    registryApi.setActivePluginRegistry(registry.registry);
    registryApi.setActivePluginRegistry(registryApi.createEmptyPluginRegistry());
    await registryApi.waitForPluginRegistryRetirement(registry.registry);
    expect(readBackend()).toEqual(original);
  } finally {
    await expect(
      registryApi.disposePluginRegistryInstances(registry.registry),
    ).resolves.toMatchObject({ failures: [] });
    if (originalRegistry) {
      registryApi.setActivePluginRegistry(originalRegistry);
    } else {
      registryApi.resetPluginRuntimeStateForTest();
    }
  }
});
