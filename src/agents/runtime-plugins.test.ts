import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  ensureStandaloneRuntimePluginRegistryLoaded: vi.fn(),
  getActivePluginRuntimeSubagentMode: vi.fn<() => "default" | "explicit" | "gateway-bindable">(
    () => "default",
  ),
  getActivePluginRegistryWorkspaceDir: vi.fn<() => string | undefined>(() => undefined),
  loadGatewayStartupPluginPlan: vi.fn(() => ({ pluginIds: [] })),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  loadGatewayStartupPluginPlan: hoisted.loadGatewayStartupPluginPlan,
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: hoisted.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/runtime/standalone-runtime-registry-loader.js", () => ({
  ensureStandaloneRuntimePluginRegistryLoaded: hoisted.ensureStandaloneRuntimePluginRegistryLoaded,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRuntimeSubagentMode: hoisted.getActivePluginRuntimeSubagentMode,
  getActivePluginRegistryWorkspaceDir: hoisted.getActivePluginRegistryWorkspaceDir,
}));

describe("ensureRuntimePluginsLoaded", () => {
  let ensureRuntimePluginsLoaded: typeof import("./runtime-plugins.js").ensureRuntimePluginsLoaded;

  beforeEach(async () => {
    hoisted.getCurrentPluginMetadataSnapshot.mockReset();
    hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
    hoisted.ensureStandaloneRuntimePluginRegistryLoaded.mockReset();
    hoisted.ensureStandaloneRuntimePluginRegistryLoaded.mockReturnValue(undefined);
    hoisted.getActivePluginRuntimeSubagentMode.mockReset();
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("default");
    hoisted.getActivePluginRegistryWorkspaceDir.mockReset();
    hoisted.getActivePluginRegistryWorkspaceDir.mockReturnValue(undefined);
    hoisted.loadGatewayStartupPluginPlan.mockReset();
    hoisted.loadGatewayStartupPluginPlan.mockReturnValue({ pluginIds: [] });
    vi.resetModules();
    ({ ensureRuntimePluginsLoaded } = await import("./runtime-plugins.js"));
  });

  it("does not reactivate plugins when a process already has an active registry", () => {
    hoisted.ensureStandaloneRuntimePluginRegistryLoaded.mockReturnValue({});

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledTimes(1);
  });

  it("resolves runtime plugins through the shared runtime helper", () => {
    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: [],
      loadOptions: {
        config: {} as never,
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: [],
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });

  it("falls back to the gateway startup plan when no reusable metadata snapshot exists", () => {
    const config = {} as never;
    hoisted.loadGatewayStartupPluginPlan.mockReturnValue({
      pluginIds: ["agentmemory", "codex", "telegram"],
    });

    ensureRuntimePluginsLoaded({
      config,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.loadGatewayStartupPluginPlan).toHaveBeenCalledWith({
      config,
      activationSourceConfig: config,
      workspaceDir: "/tmp/workspace",
      env: process.env,
    });
    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: ["agentmemory", "codex", "telegram"],
      loadOptions: {
        config,
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["agentmemory", "codex", "telegram"],
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });

  it("can force reload the startup-scoped registry for terminal hook recovery", () => {
    const config = {} as never;
    hoisted.loadGatewayStartupPluginPlan.mockReturnValue({
      pluginIds: ["agentmemory", "telegram"],
    });

    ensureRuntimePluginsLoaded({
      config,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
      forceLoad: true,
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: ["agentmemory", "telegram"],
      forceLoad: true,
      loadOptions: {
        config,
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["agentmemory", "telegram"],
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });

  it("does not load runtime plugins when plugins are globally disabled", () => {
    ensureRuntimePluginsLoaded({
      config: {
        plugins: {
          enabled: false,
        },
      } as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).not.toHaveBeenCalled();
  });

  it("scopes runtime plugin loading to the current gateway startup plan", () => {
    const config = {} as never;
    hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue({
      startup: {
        pluginIds: ["telegram", "memory-core"],
      },
    });

    ensureRuntimePluginsLoaded({
      config,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/workspace",
    });
    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: ["telegram", "memory-core"],
      loadOptions: {
        config,
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: ["telegram", "memory-core"],
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });

  it("delegates startup-scope registry reuse to loader cache compatibility", () => {
    hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue({
      startup: {
        pluginIds: ["telegram"],
      },
    });
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: ["telegram"],
      loadOptions: {
        config: {} as never,
        onlyPluginIds: ["telegram"],
        workspaceDir: "/tmp/workspace",
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });

  it("lets the loader decide when startup ids match but config changes", () => {
    const config = {
      plugins: {
        config: {
          telegram: {
            replyMode: "changed",
          },
        },
      },
    } as never;
    hoisted.getCurrentPluginMetadataSnapshot.mockReturnValue({
      startup: {
        pluginIds: ["telegram"],
      },
    });
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");

    ensureRuntimePluginsLoaded({
      config,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: ["telegram"],
      loadOptions: {
        config,
        onlyPluginIds: ["telegram"],
        workspaceDir: "/tmp/workspace",
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });

  it("does not enable gateway subagent binding for normal runtime loads", () => {
    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: [],
      loadOptions: {
        config: {} as never,
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: [],
        runtimeOptions: undefined,
      },
    });
  });

  it("inherits gateway-bindable mode from an active gateway registry", () => {
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");

    ensureRuntimePluginsLoaded({
      config: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(hoisted.ensureStandaloneRuntimePluginRegistryLoaded).toHaveBeenCalledWith({
      requiredPluginIds: [],
      loadOptions: {
        config: {} as never,
        workspaceDir: "/tmp/workspace",
        onlyPluginIds: [],
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    });
  });
});
