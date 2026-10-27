import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, expect, it, vi } from "vitest";

type TestRuntime = ReturnType<typeof makeRuntime>;

const mocks = vi.hoisted(() => ({
  activateRuntime: vi.fn<() => Promise<TestRuntime>>(async () => {
    throw new Error("read-only inspection activated the runtime");
  }),
  staticStatus: vi.fn(async () => ({ activation: "inactive" })),
  nativePackageReady: vi.fn(async () => false),
  uninstallDriver: vi.fn(async (_params?: unknown): Promise<void> => undefined),
  setup: vi.fn(async ({ nativePackageReady }: { nativePackageReady: boolean }) => ({
    actions: nativePackageReady ? [] : [{ id: "install-native-package" }],
  })),
}));

vi.mock("./runtime-api.js", () => ({ createFaceTimeRuntime: mocks.activateRuntime }));
vi.mock("./src/static-status.js", () => ({ inspectFaceTimeStaticStatus: mocks.staticStatus }));
vi.mock("./src/plugin-paths.js", () => ({
  inspectFaceTimeNativePackage: mocks.nativePackageReady,
}));
vi.mock("./src/driver-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/driver-setup.js")>()),
  inspectFaceTimeDriver: vi.fn(async () => "current"),
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

function makeRuntime(stop = vi.fn<() => Promise<void>>(async () => {})) {
  return { stop, preflight: vi.fn(async () => ({ ready: true })) };
}

function registerPlugin(enabled?: boolean) {
  let service: Parameters<ReturnType<typeof createTestPluginApi>["registerService"]>[0] | undefined;
  const gatewayMethods = new Map<string, (options: unknown) => Promise<void>>();
  let toolFactory: (() => { execute(id: string, input: unknown): Promise<unknown> }) | undefined;
  const api = createTestPluginApi({
    rootDir: "/plugin",
    pluginConfig: { enabled, ownerHandles: ["owner@example.com"] },
    runtime: { system: { runCommandWithTimeout: vi.fn() } } as never,
    registerGatewayMethod: (name, handler) =>
      void gatewayMethods.set(name, handler as (options: unknown) => Promise<void>),
    registerTool: (factory) => (toolFactory = factory as unknown as typeof toolFactory),
    registerService: (registered) => {
      service = registered;
    },
  });
  plugin.register!(api);
  const serviceContext = { config: {}, stateDir: "/synthetic-facetime-state", logger: api.logger };
  const request = async (name: string, ...expected: unknown[]) => {
    const respond = vi.fn();
    await gatewayMethods.get(`facetime.${name}`)!({ respond });
    expect(respond).toHaveBeenCalledWith(...expected);
  };
  return { request, toolFactory, service, serviceContext };
}

beforeEach(() => vi.clearAllMocks());

it("serves status and installation remediation without runtime activation", async () => {
  const { request, toolFactory } = registerPlugin();
  await request("status", true, expect.objectContaining({ activation: "inactive" }));
  await toolFactory!().execute("tool-1", { action: "get_status" });
  expect(mocks.staticStatus).toHaveBeenCalledTimes(2);
  const installAction = expect.objectContaining({ id: "install-native-package" });
  await request("setup", true, expect.objectContaining({ actions: [installAction] }));
  expect(mocks.activateRuntime).not.toHaveBeenCalled();
});

it("retains a runtime whose carrier shutdown fails before uninstall", async () => {
  const stop = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("carrier shutdown unresolved"))
    .mockResolvedValue(undefined);
  const runtime = makeRuntime(stop);
  mocks.activateRuntime.mockResolvedValueOnce(runtime);
  const { request } = registerPlugin(true);
  await request("preflight", true, { ready: true });
  await request("uninstall", false, undefined, expect.any(Object));
  expect(mocks.activateRuntime).toHaveBeenCalledTimes(1);
  expect(mocks.uninstallDriver).not.toHaveBeenCalled();
  await request("uninstall", true, expect.objectContaining({ ok: true }));
  expect(stop).toHaveBeenCalledTimes(2);
  expect(mocks.uninstallDriver).toHaveBeenCalledTimes(1);
  mocks.activateRuntime.mockResolvedValueOnce(runtime);
  await request("preflight", true, { ready: true });
});

it("recovers after stopping a service whose pending runtime construction rejects", async () => {
  const pending = Promise.withResolvers<TestRuntime>();
  const entered = Promise.withResolvers<void>();
  mocks.activateRuntime.mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  const { request, service, serviceContext } = registerPlugin(true);
  if (!service?.stop || service.apiVersion === 2) {
    throw new Error("expected registered FaceTime service with shutdown");
  }
  const starting = service.start(serviceContext);
  await entered.promise;
  const error = new Error("startup failed");
  const stopped = expect(service.stop(serviceContext)).rejects.toBe(error);
  pending.reject(error);
  await stopped;
  await starting;
  expect(mocks.uninstallDriver).not.toHaveBeenCalled();
  const runtime = makeRuntime();
  mocks.activateRuntime.mockResolvedValueOnce(runtime);
  await request("preflight", true, { ready: true });
  expect(runtime.stop).not.toHaveBeenCalled();
});

it("blocks runtime activation until native uninstall finishes", async () => {
  const { promise, resolve: finishUninstall } = Promise.withResolvers<void>();
  mocks.uninstallDriver.mockReturnValueOnce(promise);
  mocks.activateRuntime.mockResolvedValue(makeRuntime());
  const { request } = registerPlugin(true);
  await request("preflight", true, { ready: true });
  const uninstall = request("uninstall", true, expect.objectContaining({ ok: true }));
  await vi.waitFor(() => expect(mocks.uninstallDriver).toHaveBeenCalledTimes(1));
  await request("preflight", false, undefined, expect.any(Object));
  expect(mocks.activateRuntime).toHaveBeenCalledTimes(1);
  finishUninstall();
  await uninstall;
  await request("preflight", true, { ready: true });
  expect(mocks.activateRuntime).toHaveBeenCalledTimes(2);
});
