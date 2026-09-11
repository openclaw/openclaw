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
vi.mock("./src/setup.js", () => ({ runFaceTimeSetup: mocks.setup }));

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
});
