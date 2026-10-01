import {
  callGatewayTool,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, vi } from "vitest";
import { codexTestTurnIds } from "./codex-app-server.test-fixtures.js";
import { routeCodexAppServerElicitationRequest } from "./elicitation-bridge.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
type AgentHarnessHostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];

type ElicitationRequest = Parameters<typeof routeCodexAppServerElicitationRequest>[0];

async function handleCodexAppServerElicitationRequest(
  params: Omit<ElicitationRequest, "paramsForRun" | "threadId" | "turnId"> &
    Partial<Pick<ElicitationRequest, "paramsForRun" | "threadId" | "turnId">>,
) {
  const result = await routeCodexAppServerElicitationRequest({
    paramsForRun: createParams(),
    ...codexTestTurnIds(),
    ...params,
  });
  return result.kind === "handled" ? result.response : undefined;
}

function mockCall(mock: { mock: { calls: unknown[][] } }, index = 0) {
  return mock.mock.calls.at(index);
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mockCall(mock, index)?.at(argIndex);
}

function gatewayToolCall(index = 0) {
  return mockCall(mockCallGatewayTool, index);
}

function gatewayToolArg(index = 0, argIndex = 0) {
  return mockCallArg(mockCallGatewayTool, index, argIndex);
}

function mockApprovalDecision(id: string, decision: "allow-once" | "allow-always" | "deny") {
  mockCallGatewayTool
    .mockResolvedValueOnce({ id, status: "accepted" })
    .mockResolvedValueOnce({ id, decision });
}

function createParams(): EmbeddedRunAttemptParams {
  const hostCapabilities: AgentHarnessHostCapabilities = {
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    bindToolSurface: (tools) => tools,
    runBeforeToolCall: async ({ params }) => ({ blocked: false, params }),
    requestApproval: async (request) =>
      (await callGatewayTool(
        "plugin.approval.request",
        { timeoutMs: request.transportTimeoutMs ?? request.timeoutMs },
        {
          pluginId: "codex",
          ...request,
          timeoutMs: request.timeoutMs,
          twoPhase: true,
        },
        { expectFinal: false },
      )) as Awaited<ReturnType<AgentHarnessHostCapabilities["requestApproval"]>>,
    waitForApproval: async (request) => {
      const result = (await callGatewayTool(
        "plugin.approval.waitDecision",
        { timeoutMs: request.transportTimeoutMs ?? request.timeoutMs },
        { id: request.approvalId },
      )) as { id?: string } & Partial<
        NonNullable<Awaited<ReturnType<AgentHarnessHostCapabilities["waitForApproval"]>>>
      >;
      return result?.id === request.approvalId
        ? { decision: result.decision, terminalReason: result.terminalReason }
        : undefined;
    },
  };
  return {
    sessionKey: "agent:main:session-1",
    agentId: "main",
    messageChannel: "telegram",
    currentChannelId: "chat-1",
    agentAccountId: "default",
    currentThreadTs: "thread-ts",
    hostCapabilities,
  } as unknown as EmbeddedRunAttemptParams;
}

function buildApprovalElicitation() {
  return {
    ...codexTestTurnIds(),
    serverName: "codex_apps__github",
    mode: "form",
    message: "Approve app tool call?",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approve: {
          type: "boolean",
          title: "Approve this tool call",
        },
        persist: {
          type: "string",
          title: "Persist choice",
          enum: ["session", "always"],
        },
      },
      required: ["approve"],
    },
  };
}

function buildCurrentCodexApprovalElicitation() {
  return {
    ...buildApprovalElicitation(),
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      connector_name: "GitHub",
      tool_title: "Create pull request",
      tool_description: "Creates a pull request in the selected repository.",
      tool_params_display: [
        { name: "repo", display_name: "Repository", value: "openclaw/openclaw" },
      ],
    },
    requestedSchema: {
      type: "object",
      properties: {},
    },
  };
}

function buildComputerUseApprovalElicitation(overrides: Record<string, unknown> = {}) {
  return {
    ...codexTestTurnIds(),
    serverName: "computer-use",
    mode: "form",
    message: "Allow Codex to use Notes?",
    _meta: {
      persist: ["always"],
    },
    requestedSchema: {
      type: "object",
      properties: {},
    },
    ...overrides,
  };
}

function buildPluginApprovalElicitation(overrides: Record<string, unknown> = {}) {
  return {
    ...codexTestTurnIds(),
    serverName: "google-calendar-mcp",
    mode: "form",
    message: "Approve app action?",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      app_id: "google-calendar-app",
    },
    requestedSchema: {
      type: "object",
      properties: {
        approve: {
          type: "boolean",
          title: "Approve this app action",
        },
      },
      required: ["approve"],
    },
    ...overrides,
  };
}

function createPluginAppPolicyContext(
  params: {
    allowDestructiveActions?: boolean;
    destructiveApprovalMode?: "allow" | "deny" | "auto" | "ask";
    apps?: Array<{ appId: string; pluginName: string; mcpServerNames: string[] }>;
  } = {},
) {
  const apps = params.apps ?? [
    {
      appId: "google-calendar-app",
      pluginName: "google-calendar",
      mcpServerNames: ["google-calendar-mcp"],
    },
  ];
  const entries = apps.map((app) => ({
    appId: app.appId,
    policy: {
      configKey: app.pluginName,
      marketplaceName: "openai-curated" as const,
      pluginName: app.pluginName,
      allowDestructiveActions: params.allowDestructiveActions ?? false,
      ...(params.destructiveApprovalMode
        ? { destructiveApprovalMode: params.destructiveApprovalMode }
        : {}),
      mcpServerNames: app.mcpServerNames,
    },
  }));
  return {
    fingerprint: "plugin-policy-1",
    apps: Object.fromEntries(entries.map(({ appId, policy }) => [appId, policy])),
    pluginAppIds: Object.fromEntries(
      apps.map((app) => [app.pluginName, appsForPlugin(apps, app.pluginName)]),
    ),
    nativePlugins: Object.fromEntries(
      entries.map(({ policy }) => [`${policy.pluginName}@openai-curated`, policy]),
    ),
    mcpServers: Object.fromEntries(
      entries.flatMap(({ policy }) =>
        policy.mcpServerNames.map((serverName) => [
          serverName,
          `${policy.pluginName}@openai-curated`,
        ]),
      ),
    ),
  };
}

function activeCalendarMcpAttribution(serverName: string) {
  return serverName === "google-calendar-mcp"
    ? {
        id: "calendar-item-1",
        server: serverName,
        tool: "create_event.raw",
        arguments: { calendar: "work" },
        pluginId: "google-calendar@openai-curated",
      }
    : undefined;
}

function createConnectorAppPolicyContext(
  params: Omit<NonNullable<Parameters<typeof createPluginAppPolicyContext>[0]>, "apps">,
) {
  return createPluginAppPolicyContext({
    ...params,
    apps: [
      {
        appId: "connector_google_calendar",
        pluginName: "google-calendar",
        mcpServerNames: [],
      },
    ],
  });
}

function createAccountAppPolicyContext(params: {
  appId: string;
  appName: string;
  allowDestructiveActions: boolean;
  destructiveApprovalMode?: "allow" | "deny" | "auto" | "ask";
}) {
  return {
    fingerprint: "account-app-policy-1",
    apps: {
      [params.appId]: {
        source: "account" as const,
        appName: params.appName,
        allowDestructiveActions: params.allowDestructiveActions,
        ...(params.destructiveApprovalMode
          ? { destructiveApprovalMode: params.destructiveApprovalMode }
          : {}),
        mcpServerNames: [],
      },
    },
    pluginAppIds: {},
  };
}

function appsForPlugin(
  apps: Array<{ appId: string; pluginName: string; mcpServerNames: string[] }>,
  pluginName: string,
): string[] {
  return apps
    .filter((app) => app.pluginName === pluginName)
    .map((app) => app.appId)
    .toSorted();
}

export function useElicitationBridgeTestSetup() {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
    vi.restoreAllMocks();
  });
}

export {
  mockCallGatewayTool,
  handleCodexAppServerElicitationRequest,
  gatewayToolCall,
  gatewayToolArg,
  mockApprovalDecision,
  createParams,
  buildApprovalElicitation,
  buildCurrentCodexApprovalElicitation,
  buildComputerUseApprovalElicitation,
  buildPluginApprovalElicitation,
  createPluginAppPolicyContext,
  activeCalendarMcpAttribution,
  createConnectorAppPolicyContext,
  createAccountAppPolicyContext,
};
