import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const destroyAll = vi.fn(async () => undefined);
  const desktopManager = { destroyAll };
  const createRuntime = vi.fn(() => ({ getDesktop: vi.fn() }));
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
  });

  it("cleans up local service state even when destroyAll fails", async () => {
    const { createOpenClawKernelService } = await import("./kernel-service.js");
    const service = createOpenClawKernelService();
    await service.start();
    mocks.destroyAll.mockRejectedValueOnce(new Error("destroy failed"));

    await expect(service.stop("shutdown")).rejects.toThrow("destroy failed");

    expect(service.isStarted()).toBe(false);
    expect(() => service.getKernel()).toThrow("AOTUI kernel service has not been started");
    expect(() => service.getDesktopManager()).toThrow("AOTUI kernel service has not been started");
  });
});
