import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const destroyAll = vi.fn(async () => undefined);
  const desktopManager = { destroyAll };
  const shutdown = vi.fn(async () => undefined);
  const createRuntime = vi.fn(() => ({ getDesktop: vi.fn(), shutdown }));
  const AppRegistry = vi.fn(function MockAppRegistry() {
    return {
      loadFromEntries: vi.fn(async () => undefined),
      has: vi.fn(() => false),
      installSelected: vi.fn(async () => []),
    };
  });
  const resolveAotuiRegistryEntries = vi.fn(() => []);
  const resolveAotuiAgentAppNames = vi.fn(() => []);
  const isAotuiEnabled = vi.fn(() => true);
  const InMemorySessionDesktopManager = vi.fn(function MockSessionDesktopManager() {
    return desktopManager;
  });

  return {
    destroyAll,
    desktopManager,
    shutdown,
    createRuntime,
    AppRegistry,
    resolveAotuiRegistryEntries,
    resolveAotuiAgentAppNames,
    isAotuiEnabled,
    InMemorySessionDesktopManager,
  };
});

vi.mock("@aotui/runtime", () => ({
  createRuntime: mocks.createRuntime,
  AppRegistry: mocks.AppRegistry,
}));

vi.mock("./policy.js", () => ({
  resolveAotuiRegistryEntries: mocks.resolveAotuiRegistryEntries,
  resolveAotuiAgentAppNames: mocks.resolveAotuiAgentAppNames,
  isAotuiEnabled: mocks.isAotuiEnabled,
}));

vi.mock("./session-desktop-manager.js", () => ({
  InMemorySessionDesktopManager: mocks.InMemorySessionDesktopManager,
}));

describe("DefaultAotuiKernelService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveAotuiRegistryEntries.mockReturnValue([]);
    mocks.resolveAotuiAgentAppNames.mockReturnValue([]);
    mocks.isAotuiEnabled.mockReturnValue(true);
    mocks.destroyAll.mockResolvedValue(undefined);
    mocks.shutdown.mockResolvedValue(undefined);
  });

  it("shuts down the runtime after destroying desktops", async () => {
    const { createOpenClawKernelService } = await import("./kernel-service.js");
    const service = createOpenClawKernelService();
    await service.start();

    await service.stop("shutdown");

    expect(mocks.destroyAll).toHaveBeenCalledWith("shutdown");
    expect(mocks.shutdown).toHaveBeenCalledWith("shutdown");
    expect(service.isStarted()).toBe(false);
  });

  it("cleans up local service state and still shuts down the runtime when destroyAll fails", async () => {
    const { createOpenClawKernelService } = await import("./kernel-service.js");
    const service = createOpenClawKernelService();
    await service.start();
    mocks.destroyAll.mockRejectedValueOnce(new Error("destroy failed"));

    await expect(service.stop("shutdown")).rejects.toThrow("destroy failed");

    expect(mocks.shutdown).toHaveBeenCalledWith("shutdown");
    expect(service.isStarted()).toBe(false);
    expect(() => service.getKernel()).toThrow("AOTUI kernel service has not been started");
    expect(() => service.getDesktopManager()).toThrow("AOTUI kernel service has not been started");
  });

  it("shuts down the runtime and clears local state when start fails mid-initialization", async () => {
    const runtime = { getDesktop: vi.fn(), shutdown: mocks.shutdown };
    mocks.createRuntime.mockReturnValueOnce(runtime);
    const registry = {
      loadFromEntries: vi.fn(async () => {
        throw new Error("registry load failed");
      }),
      has: vi.fn(() => false),
      installSelected: vi.fn(async () => []),
    };
    mocks.AppRegistry.mockImplementationOnce(function MockAppRegistry() {
      return registry;
    });
    mocks.resolveAotuiRegistryEntries.mockReturnValueOnce([
      { name: "ide", source: "npm:test" } as never,
    ]);

    const { createOpenClawKernelService } = await import("./kernel-service.js");
    const service = createOpenClawKernelService();

    await expect(service.start()).rejects.toThrow("registry load failed");

    expect(registry.loadFromEntries).toHaveBeenCalledWith([{ name: "ide", source: "npm:test" }], {
      replace: true,
    });
    expect(mocks.shutdown).toHaveBeenCalledWith("start_failed");
    expect(service.isStarted()).toBe(false);
    expect(() => service.getKernel()).toThrow("AOTUI kernel service has not been started");
    expect(() => service.getDesktopManager()).toThrow("AOTUI kernel service has not been started");
  });
});
