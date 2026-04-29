import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn(),
  getActivePluginRegistry: vi.fn<() => unknown>(() => undefined),
  getActivePluginRuntimeSubagentMode: vi.fn<() => "default" | "explicit" | "gateway-bindable">(
    () => "default",
  ),
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: hoisted.resolveRuntimePluginRegistry,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: hoisted.getActivePluginRegistry,
  getActivePluginRuntimeSubagentMode: hoisted.getActivePluginRuntimeSubagentMode,
}));

describe("ensureRuntimePluginsLoaded", () => {
  let ensureRuntimePluginsLoaded: typeof import("./runtime-plugins.js").ensureRuntimePluginsLoaded;

  beforeEach(async () => {
    hoisted.resolveRuntimePluginRegistry.mockReset();
    hoisted.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    hoisted.getActivePluginRegistry.mockReset();
    hoisted.getActivePluginRegistry.mockReturnValue(undefined);
    hoisted.getActivePluginRuntimeSubagentMode.mockReset();
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("default");
    vi.resetModules();
    ({ ensureRuntimePluginsLoaded } = await import("./runtime-plugins.js"));
  });

  it("short-circuits without rebuilding load options when an active registry exists", async () => {
    // Regression: every inbound dispatch was calling
    // resolveRuntimePluginRegistry with a 3-field options set that hashes
    // to a different cacheKey than boot's 9+ field set, so
    // getCompatibleActivePluginRegistry's strict equality check failed
    // and the dispatcher fell through to a full loadOpenClawPlugins
    // rebuild — costing ~5–6s per inbound message on hosted gateways even
    // though the active registry was already a valid answer.
    hoisted.getActivePluginRegistry.mockReturnValue({ plugins: [], channels: [] });

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.resolveRuntimePluginRegistry).not.toHaveBeenCalled();
  });

  it("resolves runtime plugins through the shared runtime helper when no active registry is present", async () => {
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

  it("does not enable gateway subagent binding for normal runtime loads", async () => {
    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: undefined,
    });
  });

  it("inherits gateway-bindable mode from an active gateway registry", async () => {
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });
});
