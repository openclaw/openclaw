import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateRuntime: vi.fn(async () => {
    throw new Error("read-only inspection activated the runtime");
  }),
  staticStatus: vi.fn(async () => ({
    enabled: true,
    activation: "inactive",
    configValid: true,
    configErrors: [],
    artifacts: {
      captureBinary: false,
      helperDylib: false,
      helperKey: false,
      helperBuild: false,
    },
    driverStatus: "missing",
    note: "static",
  })),
  nativePackageReady: vi.fn(async () => true),
  inspectDriver: vi.fn(async () => "current"),
  uninstallDriver: vi.fn(async (_params?: unknown): Promise<void> => undefined),
  setup: vi.fn(async ({ nativePackageReady }: { nativePackageReady: boolean }) => ({
    ok: false,
    readyForTest: false,
    liveCallProofRequired: true,
    checks: [],
    actions: nativePackageReady
      ? []
      : [
          {
            id: "install-native-package",
            kind: "command",
            label: "Install or reinstall the FaceTime native package with Homebrew",
            command:
              "if brew list --versions openclaw-facetime >/dev/null 2>&1; then brew reinstall openclaw/tap/openclaw-facetime; else brew install openclaw/tap/openclaw-facetime; fi",
          },
        ],
  })),
}));

vi.mock("./runtime-api.js", () => ({ createFaceTimeRuntime: mocks.activateRuntime }));
vi.mock("./src/static-status.js", () => ({ inspectFaceTimeStaticStatus: mocks.staticStatus }));
vi.mock("./src/plugin-paths.js", () => ({
  inspectFaceTimeNativePackage: mocks.nativePackageReady,
}));
vi.mock("./src/driver-setup.js", () => ({
  inspectFaceTimeDriver: mocks.inspectDriver,
  uninstallFaceTimeDriver: mocks.uninstallDriver,
}));
vi.mock("./src/setup.js", () => ({ runFaceTimeSetup: mocks.setup }));
vi.mock("./src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/config.js")>();
  return {
    ...actual,
    validateFaceTimeConfig(config: import("./src/config.js").FaceTimeConfig) {
      const validation = actual.validateFaceTimeConfig(config);
      const errors = validation.errors.filter((error) => error !== "facetime requires macOS");
      return { valid: errors.length === 0, errors };
    },
  };
});

import plugin from "./index.js";

describe("FaceTime control-plane registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nativePackageReady.mockResolvedValue(true);
  });

  it("serves gateway and model status without build, socket, injection, or runtime activation", async () => {
    const gatewayMethods = new Map<string, (options: unknown) => Promise<void>>();
    let toolFactory: (() => { execute(id: string, input: unknown): Promise<unknown> }) | undefined;
    const register = plugin.register;
    expect(register).toBeDefined();
    register!(
      createTestPluginApi({
        id: "facetime",
        name: "FaceTime",
        source: "test",
        rootDir: "/plugin",
        config: {},
        pluginConfig: { ownerHandles: ["owner@example.com"] },
        runtime: {
          system: { runCommandWithTimeout: vi.fn() },
        } as never,
        registerGatewayMethod: (name, handler) => {
          gatewayMethods.set(name, handler as (options: unknown) => Promise<void>);
        },
        registerTool: (factory) => {
          toolFactory = factory as unknown as typeof toolFactory;
        },
      }),
    );

    const respond = vi.fn();
    const statusMethod = gatewayMethods.get("facetime.status");
    expect(statusMethod).toBeDefined();
    await statusMethod!({ respond });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ activation: "inactive" }));
    expect(toolFactory).toBeDefined();
    const tool = (
      toolFactory as unknown as () => {
        execute(id: string, input: unknown): Promise<unknown>;
      }
    )();
    await tool.execute("tool-1", { action: "get_status" });

    expect(mocks.staticStatus).toHaveBeenCalledTimes(2);
    expect(mocks.activateRuntime).not.toHaveBeenCalled();
  });

  it("reports native installation remediation without attempting runtime activation", async () => {
    mocks.nativePackageReady.mockResolvedValue(false);
    const gatewayMethods = new Map<string, (options: unknown) => Promise<void>>();
    plugin.register!(
      createTestPluginApi({
        id: "facetime",
        name: "FaceTime",
        source: "test",
        rootDir: "/plugin",
        config: {},
        pluginConfig: { ownerHandles: ["owner@example.com"] },
        runtime: {
          system: { runCommandWithTimeout: vi.fn() },
        } as never,
        registerGatewayMethod: (name, handler) => {
          gatewayMethods.set(name, handler as (options: unknown) => Promise<void>);
        },
      }),
    );

    const respond = vi.fn();
    await gatewayMethods.get("facetime.setup")!({ respond });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        actions: [expect.objectContaining({ id: "install-native-package" })],
      }),
    );
    expect(mocks.setup).toHaveBeenCalledWith(
      expect.objectContaining({ nativePackageReady: false }),
    );
    expect(mocks.activateRuntime).not.toHaveBeenCalled();
  });

  it("retains a runtime whose carrier shutdown fails before uninstall", async () => {
    const stop = vi.fn(async () => {
      throw new Error("carrier shutdown unresolved");
    });
    mocks.activateRuntime.mockResolvedValueOnce({ stop } as never);
    const gatewayMethods = new Map<string, (options: unknown) => Promise<void>>();
    plugin.register!(
      createTestPluginApi({
        id: "facetime",
        name: "FaceTime",
        source: "test",
        rootDir: "/plugin",
        config: {},
        pluginConfig: { enabled: true, ownerHandles: ["owner@example.com"] },
        runtime: {
          system: { runCommandWithTimeout: vi.fn() },
        } as never,
        registerGatewayMethod: (name, handler) => {
          gatewayMethods.set(name, handler as (options: unknown) => Promise<void>);
        },
      }),
    );

    await gatewayMethods.get("facetime.preflight")!({ respond: vi.fn() });
    const firstRespond = vi.fn();
    await gatewayMethods.get("facetime.uninstall")!({ respond: firstRespond });
    const secondRespond = vi.fn();
    await gatewayMethods.get("facetime.uninstall")!({ respond: secondRespond });

    expect(stop).toHaveBeenCalledTimes(2);
    expect(mocks.activateRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.uninstallDriver).not.toHaveBeenCalled();
    expect(firstRespond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(secondRespond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("blocks runtime activation until native uninstall finishes", async () => {
    let finishUninstall: (() => void) | undefined;
    mocks.uninstallDriver.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishUninstall = resolve;
      }),
    );
    const runtime = {
      stop: vi.fn(async () => undefined),
      preflight: vi.fn(async () => ({ ready: true })),
    };
    mocks.activateRuntime.mockResolvedValue(runtime as never);
    const gatewayMethods = new Map<string, (options: unknown) => Promise<void>>();
    plugin.register!(
      createTestPluginApi({
        id: "facetime",
        name: "FaceTime",
        source: "test",
        rootDir: "/plugin",
        config: {},
        pluginConfig: { enabled: true, ownerHandles: ["owner@example.com"] },
        runtime: {
          system: { runCommandWithTimeout: vi.fn() },
        } as never,
        registerGatewayMethod: (name, handler) => {
          gatewayMethods.set(name, handler as (options: unknown) => Promise<void>);
        },
      }),
    );

    await gatewayMethods.get("facetime.preflight")!({ respond: vi.fn() });
    const uninstall = gatewayMethods.get("facetime.uninstall")!({ respond: vi.fn() });
    await vi.waitFor(() => expect(mocks.uninstallDriver).toHaveBeenCalledTimes(1));

    const blockedRespond = vi.fn();
    await gatewayMethods.get("facetime.preflight")!({ respond: blockedRespond });
    expect(blockedRespond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(mocks.activateRuntime).toHaveBeenCalledTimes(1);

    finishUninstall?.();
    await uninstall;
    const resumedRespond = vi.fn();
    await gatewayMethods.get("facetime.preflight")!({ respond: resumedRespond });
    expect(resumedRespond).toHaveBeenCalledWith(true, { ready: true });
    expect(mocks.activateRuntime).toHaveBeenCalledTimes(2);
  });
});
