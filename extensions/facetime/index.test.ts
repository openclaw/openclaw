import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, expect, it, vi } from "vitest";

type TestRuntime = {
  stop(): Promise<void>;
  preflight(): Promise<{ ready: boolean }>;
};

const mocks = vi.hoisted(() => ({
  activateRuntime: vi.fn<() => Promise<TestRuntime>>(async () => {
    throw new Error("read-only inspection activated the runtime");
  }),
  staticStatus: vi.fn(async () => ({ activation: "inactive" })),
  nativePackageReady: vi.fn(async () => true),
  inspectDriver: vi.fn(async () => "current"),
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

function registerPlugin(enabled?: boolean) {
  const services: OpenClawPluginService[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const serviceContext = { config: {}, stateDir: "/synthetic-facetime-state", logger };
  const gatewayMethods = new Map<string, (options: unknown) => Promise<void>>();
  let toolFactory: (() => { execute(id: string, input: unknown): Promise<unknown> }) | undefined;
  plugin.register!(
    createTestPluginApi({
      rootDir: "/plugin",
      pluginConfig: { enabled, ownerHandles: ["owner@example.com"] },
      logger,
      runtime: { system: { runCommandWithTimeout: vi.fn() } } as never,
      registerGatewayMethod: (name, handler) =>
        void gatewayMethods.set(name, handler as (options: unknown) => Promise<void>),
      registerTool: (factory) => (toolFactory = factory as unknown as typeof toolFactory),
      registerService: (service) => {
        if (service.apiVersion === 2) {
          throw new Error("expected FaceTime's version 1 service contract");
        }
        services.push(service);
      },
    }),
  );
  const request = async (name: string) => {
    const respond = vi.fn();
    await gatewayMethods.get(`facetime.${name}`)!({ respond });
    return respond;
  };
  return { request, toolFactory, service: services[0], serviceContext };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nativePackageReady.mockResolvedValue(true);
});

it("serves gateway and model status without build, socket, injection, or runtime activation", async () => {
  const { request, toolFactory } = registerPlugin();
  expect(await request("status")).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ activation: "inactive" }),
  );
  await toolFactory!().execute("tool-1", { action: "get_status" });
  expect(mocks.staticStatus).toHaveBeenCalledTimes(2);
  expect(mocks.activateRuntime).not.toHaveBeenCalled();
});

it("reports native installation remediation without attempting runtime activation", async () => {
  mocks.nativePackageReady.mockResolvedValue(false);
  const { request } = registerPlugin();
  const installAction = expect.objectContaining({ id: "install-native-package" });
  expect(await request("setup")).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ actions: [installAction] }),
  );
  expect(mocks.setup).toHaveBeenCalledWith(expect.objectContaining({ nativePackageReady: false }));
  expect(mocks.activateRuntime).not.toHaveBeenCalled();
});

it("retains a runtime whose carrier shutdown fails before uninstall", async () => {
  const stop = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("carrier shutdown unresolved"))
    .mockRejectedValueOnce(new Error("carrier shutdown unresolved"))
    .mockResolvedValue(undefined);
  const runtime = { stop, preflight: vi.fn(async () => ({ ready: true })) };
  mocks.activateRuntime.mockResolvedValueOnce(runtime);
  const { request } = registerPlugin(true);
  await request("preflight");
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await request("uninstall")).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  }
  expect(stop).toHaveBeenCalledTimes(2);
  expect(mocks.activateRuntime).toHaveBeenCalledTimes(1);
  expect(mocks.uninstallDriver).not.toHaveBeenCalled();
  expect(await request("uninstall")).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ok: true }),
  );
  expect(stop).toHaveBeenCalledTimes(3);
  expect(mocks.uninstallDriver).toHaveBeenCalledTimes(1);
  mocks.activateRuntime.mockResolvedValueOnce(runtime);
  expect(await request("preflight")).toHaveBeenCalledWith(true, { ready: true });
  expect(mocks.activateRuntime).toHaveBeenCalledTimes(2);
});

it("recovers after stopping a service whose pending runtime construction rejects", async () => {
  const pending = Promise.withResolvers<TestRuntime>();
  const entered = Promise.withResolvers<void>();
  mocks.activateRuntime.mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  const { request, service, serviceContext } = registerPlugin(true);
  if (!service?.stop) {
    throw new Error("expected registered FaceTime service with shutdown");
  }
  const starting = service.start(serviceContext);
  await entered.promise;
  const error = new Error("startup failed");
  const stopped = expect(service.stop(serviceContext)).rejects.toBe(error);
  pending.reject(error);
  await stopped;
  await starting;
  expect(serviceContext.logger.warn).toHaveBeenCalledWith(
    "[facetime] startup skipped: startup failed",
  );
  expect(mocks.uninstallDriver).not.toHaveBeenCalled();
  const runtime = { stop: vi.fn(async () => {}), preflight: vi.fn(async () => ({ ready: true })) };
  mocks.activateRuntime.mockResolvedValueOnce(runtime);
  expect(await request("preflight")).toHaveBeenCalledWith(true, { ready: true });
  expect(mocks.activateRuntime).toHaveBeenCalledTimes(2);
  expect(runtime.stop).not.toHaveBeenCalled();
});

it("blocks runtime activation until native uninstall finishes", async () => {
  const { promise, resolve: finishUninstall } = Promise.withResolvers<void>();
  mocks.uninstallDriver.mockReturnValueOnce(promise);
  const runtime = {
    stop: vi.fn(async () => undefined),
    preflight: vi.fn(async () => ({ ready: true })),
  };
  mocks.activateRuntime.mockResolvedValue(runtime as never);
  const { request } = registerPlugin(true);
  await request("preflight");
  const uninstall = request("uninstall");
  await vi.waitFor(() => expect(mocks.uninstallDriver).toHaveBeenCalledTimes(1));
  expect(await request("preflight")).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  expect(mocks.activateRuntime).toHaveBeenCalledTimes(1);
  finishUninstall();
  await uninstall;
  expect(await request("preflight")).toHaveBeenCalledWith(true, { ready: true });
  expect(mocks.activateRuntime).toHaveBeenCalledTimes(2);
});
