import { describe, expect, it, vi } from "vitest";
import {
  CodexComputerUseSetupError,
  ensureCodexComputerUse,
  installCodexComputerUse,
  readCodexComputerUseStatus,
  type CodexComputerUseRequest,
} from "./computer-use.js";

describe("Codex Computer Use setup", () => {
  it("stays disabled until configured", async () => {
    await expect(
      readCodexComputerUseStatus({ pluginConfig: {}, request: vi.fn() }),
    ).resolves.toEqual(
      expect.objectContaining({
        enabled: false,
        ready: false,
        message: "Computer Use is disabled.",
      }),
    );
  });

  it("reports an installed Computer Use MCP server from a registered marketplace", async () => {
    const request = createComputerUseRequest({ installed: true });

    await expect(
      readCodexComputerUseStatus({
        pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
        request,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        enabled: true,
        ready: true,
        installed: true,
        pluginEnabled: true,
        mcpServerAvailable: true,
        marketplaceName: "desktop-tools",
        tools: ["list_apps"],
        message: "Computer Use is ready.",
      }),
    );
    expect(request).not.toHaveBeenCalledWith("marketplace/add", expect.anything());
    expect(request).not.toHaveBeenCalledWith("plugin/install", expect.anything());
  });

  it("installs Computer Use from a configured marketplace source", async () => {
    const request = createComputerUseRequest({ installed: false });

    await expect(
      installCodexComputerUse({
        pluginConfig: {
          computerUse: {
            marketplaceSource: "github:example/desktop-tools",
          },
        },
        request,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ready: true,
        installed: true,
        pluginEnabled: true,
        tools: ["list_apps"],
      }),
    );
    expect(request).toHaveBeenCalledWith("experimentalFeature/enablement/set", {
      enablement: { plugins: true },
    });
    expect(request).toHaveBeenCalledWith("marketplace/add", {
      source: "github:example/desktop-tools",
    });
    expect(request).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
      pluginName: "computer-use",
    });
    expect(request).toHaveBeenCalledWith("config/mcpServer/reload", undefined);
  });

  it("fails closed when Computer Use is required but not installed", async () => {
    const request = createComputerUseRequest({ installed: false });

    await expect(
      ensureCodexComputerUse({
        pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
        request,
      }),
    ).rejects.toThrow(CodexComputerUseSetupError);
    expect(request).not.toHaveBeenCalledWith("plugin/install", expect.anything());
  });
});

function createComputerUseRequest(params: { installed: boolean }): CodexComputerUseRequest {
  let installed = params.installed;
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "experimentalFeature/enablement/set") {
      return { enablement: { plugins: true } };
    }
    if (method === "marketplace/add") {
      return {
        marketplaceName: "desktop-tools",
        installedRoot: "/marketplaces/desktop-tools",
        alreadyAdded: false,
      };
    }
    if (method === "plugin/list") {
      return {
        marketplaces: [
          {
            name: "desktop-tools",
            path: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
            interface: null,
            plugins: [pluginSummary(installed)],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    if (method === "plugin/read") {
      expect(requestParams).toEqual(
        expect.objectContaining({
          pluginName: "computer-use",
        }),
      );
      return {
        plugin: {
          marketplaceName: "desktop-tools",
          marketplacePath: "/marketplaces/desktop-tools/.agents/plugins/marketplace.json",
          summary: pluginSummary(installed),
          description: "Control desktop apps.",
          skills: [],
          apps: [],
          mcpServers: ["computer-use"],
        },
      };
    }
    if (method === "plugin/install") {
      installed = true;
      return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
    }
    if (method === "config/mcpServer/reload") {
      return undefined;
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: installed
          ? [
              {
                name: "computer-use",
                tools: {
                  list_apps: {
                    name: "list_apps",
                    inputSchema: { type: "object" },
                  },
                },
                resources: [],
                resourceTemplates: [],
                authStatus: "unsupported",
              },
            ]
          : [],
        nextCursor: null,
      };
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

function pluginSummary(installed: boolean) {
  return {
    id: "computer-use@desktop-tools",
    name: "computer-use",
    source: { type: "local", path: "/marketplaces/desktop-tools/plugins/computer-use" },
    installed,
    enabled: installed,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_INSTALL",
    interface: null,
  };
}
