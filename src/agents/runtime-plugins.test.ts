import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn(),
  getCompatibleActivePluginRegistry: vi.fn(),
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: hoisted.loadOpenClawPlugins,
  getCompatibleActivePluginRegistry: hoisted.getCompatibleActivePluginRegistry,
}));

describe("ensureRuntimePluginsLoaded", () => {
  beforeEach(() => {
    hoisted.loadOpenClawPlugins.mockReset();
    hoisted.getCompatibleActivePluginRegistry.mockReset();
    hoisted.getCompatibleActivePluginRegistry.mockReturnValue(undefined);
    vi.resetModules();
  });

  it("does not reactivate plugins when a process already has an active registry", async () => {
    const { ensureRuntimePluginsLoaded } = await import("./runtime-plugins.js");
    hoisted.getCompatibleActivePluginRegistry.mockReturnValue({});

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("loads runtime plugins when no compatible active registry exists", async () => {
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

  it("reloads when the current active registry is incompatible with the request", async () => {
    const { ensureRuntimePluginsLoaded } = await import("./runtime-plugins.js");

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.getCompatibleActivePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
    expect(hoisted.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });
});
