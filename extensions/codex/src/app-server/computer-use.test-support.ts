import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import type { CodexComputerUseRequest } from "./computer-use-readiness.js";
import type { CodexComputerUseStatus } from "./computer-use.js";
import type { CodexListMcpServerStatusResponse } from "./protocol-mcp.js";

export function expectStatusFields(
  status: CodexComputerUseStatus,
  fields: Partial<CodexComputerUseStatus>,
): void {
  expect(status).toEqual(expect.objectContaining(fields));
}

export async function expectSetupErrorStatus(
  promise: Promise<CodexComputerUseStatus>,
  fields: Partial<CodexComputerUseStatus>,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status: expect.objectContaining(fields) });
}

const requireRecord = createRequireRecord("object", "label-not-object");

export function requestCalls(request: CodexComputerUseRequest, method?: string) {
  const calls = vi.mocked(request).mock.calls;
  return method ? calls.filter(([called]) => called === method) : calls;
}

export function expectRequestMethodNotCalled(
  request: CodexComputerUseRequest,
  ...methods: string[]
): void {
  const called = requestCalls(request).map(([method]) => method);
  for (const method of methods) {
    expect(called).not.toContain(method);
  }
}

export function createComputerUseRequest(params: {
  installed: boolean;
  enabled?: boolean;
  pluginName?: string;
  mcpServerName?: string;
  mcpTools?: readonly string[];
  mcpStatusPages?: readonly CodexListMcpServerStatusResponse[];
  nativePluginsEnabled?: boolean;
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
  localMarketplace?: { name: string; path: string };
  probeThreadPrefix?: string;
}): CodexComputerUseRequest {
  let installed = params.installed;
  let enabled = params.enabled ?? installed;
  let pluginListCalls = 0;
  let mcpStatusPage = 0;
  let liveTestFailures = params.liveTestFailures ?? 0;
  let liveTestResultErrors = params.liveTestResultErrors ?? 0;
  let reloadFailures = params.reloadFailures ?? 0;
  let threadStartCalls = 0;
  const pluginName = params.pluginName ?? "computer-use";
  const mcpServerName = params.mcpServerName ?? "computer-use";
  const mcpTools = params.mcpTools ?? ["list_apps"];
  const tools =
    params.mcpToolsAvailable === false
      ? {}
      : Object.fromEntries(mcpTools.map((name) => [name, {}]));
  const marketplaceName =
    params.remoteMarketplace?.name ?? params.localMarketplace?.name ?? "desktop-tools";
  const marketplacePath = params.remoteMarketplace
    ? null
    : (params.localMarketplace?.path ??
      `/marketplaces/${marketplaceName}/.agents/plugins/marketplace.json`);
  const probeThreadId = () =>
    `${params.probeThreadPrefix ?? "computer-use-probe-thread"}-${threadStartCalls}`;
  const currentPluginSummary = () => ({
    name: pluginName,
    installed,
    enabled,
    source: { type: params.remoteMarketplace ? "remote" : "local" },
    ...(params.remoteMarketplace
      ? { remotePluginId: params.remoteMarketplace.pluginId ?? null }
      : {}),
  });
  const location = params.remoteMarketplace
    ? { remoteMarketplaceName: marketplaceName, pluginName: params.remoteMarketplace.pluginId }
    : { marketplacePath, pluginName };
  return vi.fn(async (method: string, requestParams?: unknown) => {
    switch (method) {
      case "experimentalFeature/enablement/set":
        return {
          enablement: params.nativePluginsEnabled === false ? {} : { plugins: true },
        };
      case "experimentalFeature/list":
        return {
          data: [{ name: "plugins", enabled: params.nativePluginsEnabled ?? true }],
        };
      case "marketplace/add":
        return { marketplaceName: "desktop-tools" };
      case "plugin/list": {
        pluginListCalls += 1;
        const marketplaceAvailable =
          pluginListCalls >= (params.marketplaceAvailableAfterListCalls ?? 1);
        return {
          marketplaces: marketplaceAvailable
            ? [
                ...(params.additionalMarketplaceNames ?? []).map(marketplaceEntry),
                { name: marketplaceName, path: marketplacePath, plugins: [currentPluginSummary()] },
              ]
            : [],
        };
      }
      case "plugin/read":
        expect(requestParams).toEqual(location);
        return {
          plugin: { marketplaceName, marketplacePath, summary: currentPluginSummary() },
        };
      case "plugin/install":
        if (params.remoteMarketplace) {
          expect(requestParams).toEqual(location);
        }
        installed = true;
        enabled = true;
        return {};
      case "config/mcpServer/reload":
        if (reloadFailures > 0) {
          reloadFailures -= 1;
          throw new Error("MCP runtime reload failed");
        }
        return undefined;
      case "mcpServerStatus/list": {
        if (params.mcpStatusPages) {
          const page = params.mcpStatusPages[mcpStatusPage++];
          if (!page) {
            throw new Error("The later inventory page is unavailable");
          }
          return page;
        }
        return {
          data: installed && enabled ? [{ name: mcpServerName, tools }] : [],
          nextCursor: null,
        };
      }
      case "thread/start":
        threadStartCalls += 1;
        return { thread: { id: probeThreadId() } };
      case "mcpServer/tool/call": {
        const requestRecord = requireRecord(requestParams, "Computer Use readiness tool call");
        const tool = requestRecord.tool;
        if (typeof tool !== "string" || !mcpTools.includes(tool)) {
          return {
            content: [{ type: "text", text: `Unknown tool: ${String(tool)}` }],
            isError: true,
          };
        }
        expect(requestRecord).toEqual({
          threadId: probeThreadId(),
          server: mcpServerName,
          tool,
          arguments: tool === "js" ? { code: "await cua.listApps();" } : {},
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
      case "thread/unsubscribe":
        expect(requestParams).toEqual({ threadId: probeThreadId() });
        return undefined;
      default:
        throw new Error(`unexpected request ${method}`);
    }
  }) as CodexComputerUseRequest;
}

export function marketplaceEntry(marketplaceName: string) {
  return {
    name: marketplaceName,
    path: `/marketplaces/${marketplaceName}/.agents/plugins/marketplace.json`,
    plugins: [{ name: "computer-use" }],
  };
}
