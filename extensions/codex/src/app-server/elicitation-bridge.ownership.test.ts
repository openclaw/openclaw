import { describe, expect, it, vi } from "vitest";
import { buildConnectorPluginApprovalElicitation } from "./codex-app-server.test-fixtures.js";
import {
  activeCalendarMcpAttribution,
  buildPluginApprovalElicitation,
  createPluginAppPolicyContext,
  gatewayToolArg,
  handleCodexAppServerElicitationRequest,
  mockApprovalDecision,
  mockCallGatewayTool,
  useElicitationBridgeTestSetup,
} from "./elicitation-bridge.test-support.js";

describe("Codex elicitation plugin ownership", () => {
  useElicitationBridgeTestSetup();

  it.each([
    {
      label: "catalog action",
      appId: "connector_google_calendar",
      connectorId: "connector_google_calendar",
      actionName: "create_event",
    },
    {
      label: "unproven tool identity",
      appId: "connector_google_calendar",
      connectorId: "connector_google_calendar",
      actionName: undefined,
    },
    {
      label: "admitted Apps SDK alias",
      appId: "asdk_app_0123456789abcdef0123456789abcdef",
      connectorId: "connector_0123456789abcdef0123456789abcdef",
      actionName: "create_event",
    },
  ])("binds plugin reviewer policy using $label", async ({ appId, connectorId, actionName }) => {
    mockApprovalDecision("plugin:approval-calendar-tool", "allow-once");
    const correlate = vi.fn((serverName: string, selectedConnectorId?: string) =>
      serverName === "codex_apps" && selectedConnectorId === connectorId
        ? {
            id: "mcp-item-1",
            server: serverName,
            tool: "renamed_123.create_event",
            arguments: { calendar: "work" },
            actionName,
          }
        : undefined,
    );
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          ...(appId !== connectorId ? { app_id: appId } : {}),
          connector_id: connectorId,
          tool_title: "display title, not a tool ID",
          tool_params_display: [{ name: "calendar", value: "work" }],
        },
      }),
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
        apps: [{ appId, pluginName: "google-calendar", mcpServerNames: [] }],
      }),
      getActiveMcpToolCall: correlate,
    });

    expect(result?.action).toBe("accept");
    expect(correlate).toHaveBeenCalledWith("codex_apps", connectorId);
    expect(gatewayToolArg(0, 2)).toHaveProperty("policySubject", {
      pluginKey: "google-calendar",
      appId,
      ...(actionName ? { tool: actionName } : {}),
    });
  });

  it("does not use a claimed app as the reviewer policy subject for another MCP server", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation({
        serverName: "other-mcp",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          app_id: "google-calendar-app",
        },
      }),
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
        apps: [
          {
            appId: "google-calendar-app",
            pluginName: "google-calendar",
            mcpServerNames: ["google-calendar-mcp"],
          },
          {
            appId: "other-app",
            pluginName: "other-plugin",
            mcpServerNames: ["other-mcp"],
          },
        ],
      }),
      getActiveMcpToolCallAttribution: () => ({
        id: "other-plugin-item",
        server: "other-mcp",
        tool: "other_tool",
        arguments: {},
        pluginId: "other-plugin@openai-curated",
      }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "no matching active item",
      overrides: { getActiveMcpToolCallAttribution: () => undefined },
    },
    {
      label: "a legacy binding without native ownership",
      overrides: {
        pluginAppPolicyContext: { fingerprint: "legacy", apps: {}, pluginAppIds: {} },
      },
    },
    {
      label: "ambiguous server ownership",
      overrides: {
        pluginAppPolicyContext: {
          ...createPluginAppPolicyContext({ allowDestructiveActions: true }),
          mcpServers: { "google-calendar-mcp": null },
        },
      },
    },
  ])("declines a plugin MCP approval with $label", async ({ overrides }) => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation(),
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
      getActiveMcpToolCallAttribution: activeCalendarMcpAttribution,
      autoApproveMcpTools: true,
      ...overrides,
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it.each(["available", "missing"])(
    "binds the native plugin and raw MCP tool when server details are %s",
    async (detail) => {
      mockApprovalDecision("plugin:approval-owned-server", "allow-once");
      const context = createPluginAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
      });
      const result = await handleCodexAppServerElicitationRequest({
        requestParams: buildPluginApprovalElicitation(),
        pluginAppPolicyContext: {
          ...context,
          mcpServers: detail === "available" ? context.mcpServers : {},
        },
        getActiveMcpToolCallAttribution: activeCalendarMcpAttribution,
        autoApproveMcpTools: true,
      });

      expect(result).toEqual({ action: "accept", content: { approve: true }, _meta: null });
      expect(gatewayToolArg(0, 2)).toHaveProperty("policySubject", {
        pluginKey: "google-calendar",
        mcpServer: "google-calendar-mcp",
        tool: "create_event.raw",
      });
    },
  );

  it("keeps a user MCP server that shadows a plugin server on generic policy", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation({
        _meta: { codex_approval_kind: "mcp_tool_call" },
      }),
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
      getActiveMcpToolCallAttribution: (serverName) => ({
        id: "shadow-item",
        server: serverName,
        tool: "create_event.raw",
        arguments: {},
        pluginId: null,
      }),
      autoApproveMcpTools: true,
    });

    expect(result).toEqual({ action: "accept", content: { approve: true }, _meta: null });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });
});
