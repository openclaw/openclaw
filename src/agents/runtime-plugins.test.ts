import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn(),
  getGlobalHookRunner: vi.fn(),
  initializeGlobalHookRunner: vi.fn(),
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: hoisted.resolveRuntimePluginRegistry,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunner,
  initializeGlobalHookRunner: hoisted.initializeGlobalHookRunner,
}));

describe("ensureRuntimePluginsLoaded", () => {
  let ensureRuntimePluginsLoaded: typeof import("./runtime-plugins.js").ensureRuntimePluginsLoaded;

  beforeEach(async () => {
    hoisted.resolveRuntimePluginRegistry.mockReset();
    hoisted.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    hoisted.getGlobalHookRunner.mockReset();
    hoisted.getGlobalHookRunner.mockReturnValue(null);
    hoisted.initializeGlobalHookRunner.mockReset();
    vi.resetModules();
    ({ ensureRuntimePluginsLoaded } = await import("./runtime-plugins.js"));
  });

  it("does not reactivate plugins when a process already has an active registry", async () => {
    hoisted.resolveRuntimePluginRegistry.mockReturnValue({});

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
    expect(hoisted.initializeGlobalHookRunner).toHaveBeenCalledTimes(1);
  });

  it("resolves runtime plugins through the shared runtime helper", async () => {
    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });

  it("initializes the global hook runner when a registry is returned", async () => {
    const registry = {} as never;
    hoisted.resolveRuntimePluginRegistry.mockReturnValue(registry);
    hoisted.getGlobalHookRunner.mockReturnValue(null);

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.initializeGlobalHookRunner).toHaveBeenCalledWith(registry);
  });

  it("does not reinitialize the hook runner when one already exists", async () => {
    hoisted.resolveRuntimePluginRegistry.mockReturnValue({} as never);
    hoisted.getGlobalHookRunner.mockReturnValue({} as never);

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.initializeGlobalHookRunner).not.toHaveBeenCalled();
  });
});
