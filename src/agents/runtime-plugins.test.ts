import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn(),
  getActivePluginRegistryKey: vi.fn<() => string | null>(),
  activePluginRegistryAllowsGatewaySubagentBinding: vi.fn<() => boolean>(),
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: hoisted.loadOpenClawPlugins,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistryKey: hoisted.getActivePluginRegistryKey,
  activePluginRegistryAllowsGatewaySubagentBinding:
    hoisted.activePluginRegistryAllowsGatewaySubagentBinding,
}));

describe("ensureRuntimePluginsLoaded", () => {
  beforeEach(() => {
    hoisted.loadOpenClawPlugins.mockReset();
    hoisted.getActivePluginRegistryKey.mockReset();
    hoisted.getActivePluginRegistryKey.mockReturnValue(null);
    hoisted.activePluginRegistryAllowsGatewaySubagentBinding.mockReset();
    hoisted.activePluginRegistryAllowsGatewaySubagentBinding.mockReturnValue(false);
    vi.resetModules();
  });

  it("does not reactivate plugins when a process already has a compatible active registry", async () => {
    const { ensureRuntimePluginsLoaded } = await import("./runtime-plugins.js");
    hoisted.getActivePluginRegistryKey.mockReturnValue("gateway-registry");
    hoisted.activePluginRegistryAllowsGatewaySubagentBinding.mockReturnValue(true);

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("reloads plugins when the active registry lacks gateway subagent binding", async () => {
    const { ensureRuntimePluginsLoaded } = await import("./runtime-plugins.js");
    hoisted.getActivePluginRegistryKey.mockReturnValue("default-registry");
    hoisted.activePluginRegistryAllowsGatewaySubagentBinding.mockReturnValue(false);

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.loadOpenClawPlugins).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });

  it("loads runtime plugins when no active registry exists", async () => {
    const { ensureRuntimePluginsLoaded } = await import("./runtime-plugins.js");

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.loadOpenClawPlugins).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });
});
