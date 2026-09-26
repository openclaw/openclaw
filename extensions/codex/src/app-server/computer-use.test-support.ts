import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import type { CodexComputerUseRequest } from "./computer-use-readiness.js";
import type { CodexComputerUseStatus } from "./computer-use.js";

export function expectStatusFields(
  status: CodexComputerUseStatus,
  fields: Partial<CodexComputerUseStatus>,
): void {
  for (const key of Object.keys(fields) as Array<keyof CodexComputerUseStatus>) {
    expect(status[key]).toEqual(fields[key]);
  }
}

export async function expectSetupErrorStatus(
  promise: Promise<CodexComputerUseStatus>,
  fields: Partial<CodexComputerUseStatus>,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  const error = requireRecord(caught, "setup error");
  const status = requireRecord(error.status, "setup error status") as CodexComputerUseStatus;
  expectStatusFields(status, fields);
}

export const requireRecord = createRequireRecord("object", "label-not-object");

export function requestCalls(
  request: CodexComputerUseRequest,
): ReadonlyArray<readonly [method: string, params?: unknown, options?: { timeoutMs?: number }]> {
  return vi.mocked(request).mock.calls;
}

export function expectRequestMethodNotCalled(
  request: CodexComputerUseRequest,
  method: string,
): void {
  expect(requestCalls(request).map(([calledMethod]) => calledMethod)).not.toContain(method);
}

export function createComputerUseRequest(params: {
  installed: boolean;
  enabled?: boolean;
  pluginName?: string;
  mcpServerName?: string;
  mcpTools?: readonly string[];
  nativePluginsEnabled?: boolean | "absent";
  marketplaceAvailableAfterListCalls?: number;
  liveTestFailures?: number;
  liveTestResultErrors?: number;
  reloadFailures?: number;
  mcpToolsAvailable?: boolean;
  remoteMarketplace?: {
    name: string;
    pluginId?: string | null;
  };
  additionalMarketplaceNames?: readonly string[];
}): CodexComputerUseRequest {
  let installed = params.installed;
  let enabled = params.enabled ?? installed;
  let pluginListCalls = 0;
  let liveTestFailures = params.liveTestFailures ?? 0;
  let liveTestResultErrors = params.liveTestResultErrors ?? 0;
  let reloadFailures = params.reloadFailures ?? 0;
  let threadStartCalls = 0;
  const pluginName = params.pluginName ?? "computer-use";
  const mcpServerName = params.mcpServerName ?? "computer-use";
  const mcpTools = params.mcpTools ?? ["list_apps"];
  const marketplaceName = params.remoteMarketplace?.name ?? "desktop-tools";
  const marketplacePath = params.remoteMarketplace
    ? null
    : `/marketplaces/${marketplaceName}/.agents/plugins/marketplace.json`;
  const source = params.remoteMarketplace ? "remote" : "local";
  const currentPluginSummary = () =>
    pluginSummary(
      installed,
      marketplaceName,
      enabled,
      source,
      params.remoteMarketplace?.pluginId,
      pluginName,
    );
  return vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === "experimentalFeature/enablement/set") {
      return {
        enablement: params.nativePluginsEnabled === false ? {} : { plugins: true },
      };
    }
    if (method === "experimentalFeature/list") {
      return {
        data:
          params.nativePluginsEnabled === "absent"
            ? []
            : [{ name: "plugins", enabled: params.nativePluginsEnabled ?? true }],
        nextCursor: null,
      };
    }
    if (method === "marketplace/add") {
      return {
        marketplaceName: "desktop-tools",
        installedRoot: "/marketplaces/desktop-tools",
        alreadyAdded: false,
      };
    }
    if (method === "plugin/list") {
      pluginListCalls += 1;
      const marketplaceAvailable =
        pluginListCalls >= (params.marketplaceAvailableAfterListCalls ?? 1);
      return {
        marketplaces: marketplaceAvailable
          ? [
              ...(params.additionalMarketplaceNames ?? []).map((name) =>
                marketplaceEntry(name, false),
              ),
              {
                name: marketplaceName,
                path: marketplacePath,
                interface: null,
                plugins: [currentPluginSummary()],
              },
            ]
          : [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };
    }
    if (method === "plugin/read") {
      expect(requestParams).toEqual(
        params.remoteMarketplace
          ? {
              remoteMarketplaceName: marketplaceName,
              pluginName: params.remoteMarketplace.pluginId,
            }
          : { marketplacePath, pluginName },
      );
      return {
        plugin: {
          marketplaceName,
          marketplacePath,
          summary: currentPluginSummary(),
          description: "Control desktop apps.",
          skills: [],
          apps: [],
          mcpServers: [mcpServerName],
        },
      };
    }
    if (method === "plugin/install") {
      if (params.remoteMarketplace) {
        expect(requestParams).toEqual({
          remoteMarketplaceName: marketplaceName,
          pluginName: params.remoteMarketplace.pluginId,
        });
      }
      installed = true;
      enabled = true;
      return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
    }
    if (method === "config/mcpServer/reload") {
      if (reloadFailures > 0) {
        reloadFailures -= 1;
        throw new Error("MCP runtime reload failed");
      }
      return undefined;
    }
    if (method === "mcpServerStatus/list") {
      return {
        data:
          installed && enabled
            ? [
                {
                  name: mcpServerName,
                  tools:
                    params.mcpToolsAvailable === false
                      ? {}
                      : Object.fromEntries(
                          mcpTools.map((name) => [name, { name, inputSchema: { type: "object" } }]),
                        ),
                  resources: [],
                  resourceTemplates: [],
                  authStatus: "unsupported",
                },
              ]
            : [],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      threadStartCalls += 1;
      return {
        thread: {
          id: `computer-use-probe-thread-${threadStartCalls}`,
        },
        model: "gpt-5.1",
        modelProvider: "openai",
      };
    }
    if (method === "mcpServer/tool/call") {
      const requestRecord = requireRecord(requestParams, "Computer Use readiness tool call");
      const tool = requestRecord.tool;
      if (typeof tool !== "string" || !mcpTools.includes(tool)) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${String(tool)}` }],
          isError: true,
        };
      }
      expect(requestRecord).toEqual({
        threadId: `computer-use-probe-thread-${threadStartCalls}`,
        server: mcpServerName,
        tool,
        arguments: tool === "js" ? { code: "await cua.getState();" } : {},
      });
      if (liveTestFailures > 0) {
        liveTestFailures -= 1;
        throw new Error(`${tool} timed out`);
      }
      if (liveTestResultErrors > 0) {
        liveTestResultErrors -= 1;
        return { content: [{ type: "text", text: `${tool} failed` }], isError: true };
      }
      return { content: [{ type: "text", text: "[]" }] };
    }
    if (method === "thread/unsubscribe") {
      expect(requestParams).toEqual({ threadId: `computer-use-probe-thread-${threadStartCalls}` });
      return undefined;
    }
    throw new Error(`unexpected request ${method}`);
  }) as CodexComputerUseRequest;
}

export function marketplaceEntry(marketplaceName: string, installed: boolean) {
  return {
    name: marketplaceName,
    path: `/marketplaces/${marketplaceName}/.agents/plugins/marketplace.json`,
    interface: null,
    plugins: [pluginSummary(installed, marketplaceName)],
  };
}

export function pluginSummary(
  installed: boolean,
  marketplaceName = "desktop-tools",
  enabled = installed,
  source: "local" | "remote" = "local",
  remotePluginId?: string | null,
  pluginName = "computer-use",
) {
  return {
    id: `${pluginName}@${marketplaceName}`,
    ...(source === "remote" ? { remotePluginId: remotePluginId ?? null } : {}),
    name: pluginName,
    source:
      source === "local"
        ? { type: "local", path: `/marketplaces/${marketplaceName}/plugins/${pluginName}` }
        : { type: "remote" },
    installed,
    enabled,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_INSTALL",
    interface: null,
  };
}
