// Codex tests cover elicitation bridge plugin behavior.
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildConnectorPluginApprovalElicitation,
  codexTestTurnIds,
} from "./codex-app-server.test-fixtures.js";
import { routeCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import type { JsonObject } from "./protocol.js";

type AgentHarnessHostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];
const requestApproval = vi.fn<AgentHarnessHostCapabilities["requestApproval"]>();
const waitForApproval = vi.fn<AgentHarnessHostCapabilities["waitForApproval"]>();

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

function approvalRequest() {
  const request = requestApproval.mock.calls[0]?.[0];
  if (!request) {
    throw new Error("Expected a host approval request");
  }
  return request;
}

function expectNoApproval() {
  expect(requestApproval).not.toHaveBeenCalled();
  expect(waitForApproval).not.toHaveBeenCalled();
}

function expectApprovalRoundtrip() {
  expect(requestApproval).toHaveBeenCalledOnce();
  expect(waitForApproval).toHaveBeenCalledOnce();
}

function mockApprovalDecision(id: string, decision: "allow-once" | "allow-always" | "deny") {
  requestApproval.mockResolvedValueOnce({ id });
  waitForApproval.mockResolvedValueOnce({ decision, terminalReason: undefined });
}

function createParams(scheduled = false): EmbeddedRunAttemptParams {
  const hostCapabilities: AgentHarnessHostCapabilities = {
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    bindToolSurface: (tools) => tools,
    runBeforeToolCall: async ({ params }) => ({ blocked: false, params }),
    requestApproval,
    waitForApproval,
  };
  return {
    hostCapabilities,
    ...(scheduled
      ? {
          trigger: "cron",
          scheduledRuntimeAuthority: {
            version: 1,
            runtimeId: "codex",
            namespace: "codex.apps",
            payload: { version: 1 },
          },
        }
      : {}),
  } as unknown as EmbeddedRunAttemptParams;
}

function objectSchema<T extends JsonObject>(properties: T, required?: string[]) {
  return { type: "object", properties, ...(required ? { required } : {}) };
}

function approvalSchema(title: string, extra: JsonObject = {}) {
  return objectSchema({ approve: { type: "boolean", title, ...extra } }, ["approve"]);
}

function approvalMeta(overrides: JsonObject = {}) {
  return { codex_approval_kind: "mcp_tool_call", ...overrides };
}

function buildApprovalElicitation(title = "Approve this tool call") {
  return {
    ...codexTestTurnIds(),
    serverName: "codex_apps__github",
    mode: "form",
    message: "Approve app tool call?",
    _meta: approvalMeta({ persist: ["session", "always"] }),
    requestedSchema: objectSchema(
      {
        approve: { type: "boolean", title },
        persist: { type: "string", title: "Persist choice", enum: ["session", "always"] },
      },
      ["approve"],
    ),
  };
}

function buildCurrentCodexApprovalElicitation(overrides: JsonObject = {}, meta?: JsonObject) {
  return {
    ...buildApprovalElicitation(),
    _meta: approvalMeta(
      meta ?? {
        persist: ["session", "always"],
        connector_name: "GitHub",
        tool_title: "Create pull request",
        tool_description: "Creates a pull request in the selected repository.",
        tool_params_display: [
          { name: "repo", display_name: "Repository", value: "openclaw/openclaw" },
        ],
      },
    ),
    requestedSchema: objectSchema({}),
    ...overrides,
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
    requestedSchema: objectSchema({}),
    ...overrides,
  };
}

function buildPluginApprovalElicitation(overrides: Record<string, unknown> = {}) {
  return {
    ...codexTestTurnIds(),
    serverName: "google-calendar-mcp",
    mode: "form",
    message: "Approve app action?",
    _meta: approvalMeta({ app_id: "google-calendar-app" }),
    requestedSchema: approvalSchema("Approve this app action"),
    ...overrides,
  };
}

function createPluginAppPolicyContext(
  params: {
    allowDestructiveActions?: boolean;
    destructiveApprovalMode?: "allow" | "deny" | "auto" | "ask";
    apps?: Array<{ appId: string; mcpServerNames: string[] }>;
  } = {},
) {
  const apps = params.apps ?? [
    {
      appId: "google-calendar-app",
      mcpServerNames: ["google-calendar-mcp"],
    },
  ];
  return {
    fingerprint: "plugin-policy-1",
    apps: Object.fromEntries(
      apps.map((app) => [
        app.appId,
        {
          configKey: "google-calendar",
          marketplaceName: "openai-curated" as const,
          pluginName: "google-calendar",
          allowDestructiveActions: params.allowDestructiveActions ?? false,
          ...(params.destructiveApprovalMode
            ? { destructiveApprovalMode: params.destructiveApprovalMode }
            : {}),
          mcpServerNames: app.mcpServerNames,
        },
      ]),
    ),
    pluginAppIds: {},
  };
}

function createConnectorAppPolicyContext(
  params: Omit<NonNullable<Parameters<typeof createPluginAppPolicyContext>[0]>, "apps">,
) {
  return createPluginAppPolicyContext({
    ...params,
    apps: [
      {
        appId: "connector_google_calendar",
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

describe("Codex app-server elicitation bridge", () => {
  beforeEach(() => {
    requestApproval.mockReset();
    waitForApproval.mockReset();
    vi.restoreAllMocks();
  });

  it("declines app elicitations for scheduled app authority", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation(),
      paramsForRun: createParams(true),
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expectNoApproval();
  });

  it("keeps unrelated Computer Use elicitation policy unchanged", async () => {
    mockApprovalDecision("plugin:approval-computer-use", "allow-once");
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation(),
      paramsForRun: createParams(true),
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use",
      autoApproveMcpTools: true,
    });

    expect(result).toEqual({ action: "accept", content: null, _meta: null });
    expectApprovalRoundtrip();
  });

  it.each<{
    fullPermission: boolean;
    mode?: "auto" | "prompt" | "approve";
    projectedMode?: "auto" | "prompt" | "approve";
    prompts: boolean;
  }>([
    { fullPermission: true, projectedMode: "prompt", prompts: true },
    { fullPermission: true, mode: "approve", projectedMode: "prompt", prompts: false },
  ])(
    "honors MCP posture and server overrides (full=$fullPermission, mode=$mode, projected=$projectedMode)",
    async ({ fullPermission, mode, projectedMode, prompts }) => {
      mockApprovalDecision("plugin:posture", "allow-once");
      const result = await handleCodexAppServerElicitationRequest({
        requestParams: { ...buildCurrentCodexApprovalElicitation(), serverName: "linear" },
        paramsForRun: {
          ...createParams(),
          config: {
            mcp: {
              servers: {
                linear: {
                  url: "https://linear.example/mcp",
                  ...(mode ? { codex: { defaultToolsApprovalMode: mode } } : {}),
                },
              },
            },
          },
        },
        autoApproveMcpTools: fullPermission,
        projectedMcpServers: projectedMode
          ? { linear: { default_tools_approval_mode: projectedMode } }
          : undefined,
      });

      expect(result).toEqual({ action: "accept", content: null, _meta: null });
      if (prompts) {
        expectApprovalRoundtrip();
      } else {
        expectNoApproval();
      }
    },
  );

  it.each([
    {
      name: "raw tool identity",
      display: [{ name: "repo", value: "openclaw/openclaw" }],
      grant: true,
    },
    { name: "absent display metadata", display: undefined, grant: true },
    { name: "numeric string form", display: [{ name: "limit", value: "3" }], grant: true },
    {
      name: "mismatched display value",
      display: [{ name: "repo", value: "another/repo" }],
      grant: false,
    },
    { name: "unknown display key", display: [{ name: "other", value: "x" }], grant: false },
    { name: "malformed display metadata", display: "repo", grant: false },
    {
      name: "ambiguous or missing active item",
      display: undefined,
      missingItem: true,
      grant: false,
    },
    { name: "unconfigured server", display: undefined, unconfigured: true, grant: false },
    { name: "explicit prompt", display: undefined, prompt: true, grant: false },
    { name: "session-only hint", display: undefined, sessionOnly: true, grant: false },
    { name: "missing active turn", display: undefined, missingTurn: true, grant: false },
    { name: "computer use", display: undefined, computerUse: true, grant: false },
    { name: "Codex apps", display: undefined, apps: true, grant: false },
  ])("binds durable MCP intent only for $name", async (testCase) => {
    mockApprovalDecision("plugin:durable", "allow-always");
    const server = testCase.apps ? "codex_apps" : "raw-server";
    const item = {
      id: "raw-call",
      server,
      tool: "_create.issue-v2",
      arguments: { repo: "openclaw/openclaw", limit: 3 },
    };
    let activeItem: typeof item | undefined = testCase.missingItem ? undefined : item;
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: {
        ...buildCurrentCodexApprovalElicitation(),
        serverName: server,
        ...(testCase.missingTurn ? { turnId: null } : {}),
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          persist: testCase.sessionOnly ? "session" : ["session", "always"],
          tool_title: "This is not the tool identity",
          ...(testCase.display === undefined ? {} : { tool_params_display: testCase.display }),
        },
      },
      paramsForRun: {
        ...createParams(),
        config: {
          mcp: {
            servers: testCase.unconfigured
              ? {}
              : {
                  [server]: {
                    url: "https://mcp.example.test",
                    ...(testCase.prompt ? { codex: { defaultToolsApprovalMode: "prompt" } } : {}),
                  },
                },
          },
        },
      },
      getActiveMcpToolCall: () => activeItem,
      ...(testCase.computerUse ? { computerUseMcpServerName: server } : {}),
    });
    const request = approvalRequest();
    expect(request?.mcpTool).toEqual(testCase.grant ? { server, tool: item.tool } : undefined);
    if (testCase.grant) {
      expect(request?.toolCallId).toBe(item.id);
      expect(request?.isMcpToolApprovalActive?.()).toBe(true);
      activeItem = undefined;
      expect(request?.isMcpToolApprovalActive?.()).toBe(false);
    }
    expect(result?.action).toBe("accept");
    if (!testCase.prompt) {
      expect(result?._meta).toEqual({ persist: testCase.sessionOnly ? "session" : "always" });
    }
  });

  it("does not trust request-time decisions for two-phase MCP approvals", async () => {
    requestApproval.mockResolvedValueOnce({
      id: "plugin:approval-untrusted",
      decision: "allow-always",
    });
    waitForApproval.mockResolvedValueOnce({ decision: "deny", terminalReason: undefined });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildApprovalElicitation(),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(approvalRequest()).toMatchObject({
      description: expect.stringContaining(
        "openclaw mcp configure codex_apps__github --approval approve",
      ),
    });
    expectApprovalRoundtrip();
  });

  it("declines timed-out MCP approvals without response meta Codex would drop", async () => {
    requestApproval.mockResolvedValueOnce({ id: "plugin:approval-timeout" });
    waitForApproval.mockResolvedValueOnce({ decision: "deny", terminalReason: "timeout" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildApprovalElicitation(),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
  });

  it("does not handle non-Computer Use elicitations without approval metadata", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation({ serverName: "desktop-control" }),
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use",
    });

    expect(result).toBeUndefined();
    expectNoApproval();
  });

  it("declines approved Computer Use app approvals with unmappable non-empty schemas", async () => {
    const warnSpy = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    mockApprovalDecision("plugin:approval-computer-use-fields", "allow-once");

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation({
        requestedSchema: objectSchema({ appName: { type: "string", title: "App name" } }, [
          "appName",
        ]),
      }),
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use",
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expectApprovalRoundtrip();
    expect(warnSpy).toHaveBeenCalledWith(
      "codex MCP approval elicitation approved without a mappable response",
      expect.objectContaining({
        fields: ["appName"],
        outcome: "approved-once",
      }),
    );
  });

  it("normalizes missing Computer Use schemas to the empty object schema", async () => {
    mockApprovalDecision("plugin:approval-computer-use-schema", "allow-once");

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation({
        requestedSchema: "not-a-schema",
      }),
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use",
    });

    expect(result).toEqual({ action: "accept", content: null, _meta: null });
  });

  it("declines Computer Use elicitations outside form mode", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildComputerUseApprovalElicitation({
        mode: "notification",
      }),
      pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
      computerUseMcpServerName: "computer-use",
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expectNoApproval();
  });

  it.each<{
    name: string;
    requestParams: JsonObject;
    computerUse?: string;
    title?: string;
    contains: string[];
    excludes: string[];
    uriSafe?: boolean;
  }>([
    {
      name: "falls back to a Computer Use approval title and sanitizes server names",
      requestParams: buildComputerUseApprovalElicitation({
        message: "\u001b[31m",
        serverName: "computer-use\u009b31m",
        _meta: null,
      }),
      computerUse: "computer-use\u009b31m",
      title: "Computer Use approval",
      contains: ["MCP server: computer-use"],
      excludes: ["openclaw mcp configure", "\u009b"],
    },
    {
      name: "strips control and invisible formatting from approval display text",
      requestParams: buildCurrentCodexApprovalElicitation(
        {
          message: "Approve\u202e hidden",
          serverName: "codex\u009b31m_apps__github",
          requestedSchema: approvalSchema("Approve\u202e this tool call", {
            description: "Confirm\u009b31m access",
          }),
        },
        {
          connector_name: "GitHub\nInjected: approve",
          tool_title: "\u001b]8;;https://evil.example\u001b\\Visible tool\u001b]8;;\u001b\\",
          tool_description: "Creates\u0000 a\u202e pull request",
          tool_params_display: [
            {
              name: "repo",
              display_name: "Repository\u202e",
              value: "\u001b]8;;https://evil.example\u001b\\openclaw/openclaw\u001b]8;;\u001b\\",
            },
          ],
        },
      ),
      title: "Approve hidden",
      contains: [
        "GitHub Injected: approve",
        "Tool: Visible tool",
        "Repository: openclaw/openclaw",
        "- Approve this tool call: Confirm access",
      ],
      excludes: ["https://evil.example", "\u001b", "\u009b", "\u202e"],
    },
    {
      name: "escapes approval display text before forwarding approval prompts",
      requestParams: buildCurrentCodexApprovalElicitation(
        {
          message: "Approve <@U123>",
          serverName: "server @here",
          requestedSchema: approvalSchema("Approve <@U123>", { description: "Confirm @here" }),
        },
        {
          connector_name: "GitHub [trusted](https://evil)",
          tool_title: "Create <@U123>",
          tool_description: "Use @here",
          tool_params_display: [
            {
              name: "repo",
              display_name: "Repository [trusted](https://evil)",
              value: "<@U123>",
            },
          ],
        },
      ),
      title: "Approve &lt;\uff20U123&gt;",
      contains: [
        "GitHub \uff3btrusted\uff3d\uff08https://evil\uff09",
        "Tool: Create &lt;\uff20U123&gt;",
        "MCP server: server \uff20here",
        "Repository \uff3btrusted\uff3d\uff08https://evil\uff09: &lt;\uff20U123&gt;",
        "- Approve &lt;\uff20U123&gt;: Confirm \uff20here",
      ],
      excludes: ["<@U123>", "[trusted](https://evil)", "@here"],
    },
    {
      name: "falls back to stable names when display labels sanitize to empty",
      requestParams: buildCurrentCodexApprovalElicitation(
        {
          message: "Approve",
          requestedSchema: approvalSchema("\u202e", { description: "Confirm access" }),
        },
        {
          connector_name: "App",
          tool_params_display: [
            {
              name: "repo",
              display_name: "\u202e",
              value: "openclaw/openclaw",
            },
          ],
        },
      ),
      contains: ["- repo: openclaw/openclaw", "- approve: Confirm access"],
      excludes: ["- field: Confirm access"],
    },
    {
      name: "bounds deep approval display parameter values before forwarding them",
      requestParams: buildCurrentCodexApprovalElicitation(
        { message: "Approve" },
        {
          connector_name: "App",
          tool_title: "Tool",
          tool_params_display: [
            {
              name: "payload",
              value: {
                key0: { nested: { deeper: { secret: "hidden" } } },
                ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`key${i + 1}`, i + 1])),
              },
            },
          ],
        },
      ),
      contains: ["payload", "key0"],
      excludes: ["key8", "hidden"],
    },
    {
      name: "caps approval display parameter entries before forwarding them",
      requestParams: buildCurrentCodexApprovalElicitation(
        { message: "Approve", serverName: "" },
        {
          connector_name: "App",
          tool_params_display: Array.from({ length: 9 }, (_, index) => ({
            name: `p${index}`,
            value: index,
          })),
        },
      ),
      contains: ["p0", "p7", "Additional parameters: 1 more"],
      excludes: ["p8"],
    },
    {
      name: "does not split surrogate pairs when truncating display parameter values",
      requestParams: {
        ...buildApprovalElicitation(),
        _meta: approvalMeta({
          tool_params_display: [
            { name: "key", display_name: "Value", value: `${"b".repeat(116)}😀tail` },
          ],
        }),
      },
      contains: [`${"b".repeat(116)}...`],
      excludes: [],
    },
    {
      name: "does not expose a split surrogate pair from the display scan cap",
      requestParams: { ...buildApprovalElicitation(), message: `${"\u0000".repeat(4095)}😀tail` },
      title: "Codex MCP tool approval",
      contains: [],
      excludes: [String.fromCharCode(0xd83d)],
      uriSafe: true,
    },
  ])("$name", async ({ requestParams, computerUse, title, contains, excludes, uriSafe }) => {
    mockApprovalDecision("plugin:approval-display", "allow-once");
    const result = await handleCodexAppServerElicitationRequest({
      requestParams,
      ...(computerUse
        ? {
            computerUseMcpServerName: computerUse,
            pluginAppPolicyContext: createPluginAppPolicyContext({ apps: [] }),
          }
        : {}),
    });
    expect(result?.action).toBe("accept");
    if (computerUse) {
      expect(result).toEqual({ action: "accept", content: null, _meta: null });
    }
    const request = approvalRequest();
    if (title !== undefined) {
      expect(request.title).toBe(title);
    }
    for (const text of contains) {
      expect(request.description).toContain(text);
    }
    for (const text of excludes) {
      expect(request.description).not.toContain(text);
    }
    if (uriSafe) {
      expect(() => encodeURIComponent(request.description ?? "")).not.toThrow();
    }
  });

  it.each([
    {
      name: "declines plugin app elicitations when destructive actions are disabled",
      request: {
        requestParams: buildPluginApprovalElicitation(),
        pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: false }),
        autoApproveMcpTools: true,
      },
    },
    {
      name: "does not trust account app ids from non-connector MCP servers",
      request: {
        requestParams: buildPluginApprovalElicitation({
          _meta: { codex_approval_kind: "mcp_tool_call", app_id: "chatgpt_meetings" },
        }),
        pluginAppPolicyContext: createAccountAppPolicyContext({
          appId: "chatgpt_meetings",
          appName: "ChatGPT Meetings",
          allowDestructiveActions: true,
          destructiveApprovalMode: "auto",
        }),
      },
    },
    {
      name: "declines live connector elicitations that only match display names",
      request: {
        requestParams: buildConnectorPluginApprovalElicitation({
          _meta: {
            codex_approval_kind: "mcp_tool_call",
            source: "connector",
            connector_name: "Google Calendar",
            tool_title: "create_event",
          },
        }),
        pluginAppPolicyContext: createConnectorAppPolicyContext({ allowDestructiveActions: true }),
      },
    },
    {
      name: "declines live connector elicitations with mismatched app and connector ids",
      request: {
        requestParams: buildConnectorPluginApprovalElicitation({
          _meta: {
            codex_approval_kind: "mcp_tool_call",
            source: "connector",
            app_id: "other-app",
            connector_id: "connector_google_calendar",
            connector_name: "Google Calendar",
            tool_title: "create_event",
          },
        }),
        pluginAppPolicyContext: createConnectorAppPolicyContext({ allowDestructiveActions: true }),
      },
    },
    {
      name: "declines plugin app elicitations that are missing active turn correlation",
      request: {
        requestParams: buildPluginApprovalElicitation({ turnId: null }),
        pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
      },
    },
    {
      name: "declines plugin app elicitations with ambiguous server ownership",
      request: {
        requestParams: buildPluginApprovalElicitation({
          serverName: "shared-mcp",
          _meta: { codex_approval_kind: "mcp_tool_call" },
        }),
        pluginAppPolicyContext: createPluginAppPolicyContext({
          allowDestructiveActions: true,
          apps: [
            {
              appId: "calendar-app-1",
              mcpServerNames: ["shared-mcp"],
            },
            {
              appId: "calendar-app-2",
              mcpServerNames: ["shared-mcp"],
            },
          ],
        }),
      },
    },
    {
      name: "declines plugin-scoped elicitations when policy context is missing",
      request: {
        requestParams: buildPluginApprovalElicitation(),
      },
    },
    {
      name: "declines plugin app elicitations with unmappable schemas",
      request: {
        requestParams: buildPluginApprovalElicitation({
          requestedSchema: {
            type: "object",
            properties: {
              template: {
                type: "string",
                enum: ["simple", "detailed"],
              },
            },
            required: ["template"],
          },
        }),
        pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
      },
    },
    {
      name: "declines connector-id plugin app elicitations without object properties",
      request: {
        requestParams: buildConnectorPluginApprovalElicitation({
          requestedSchema: { type: "object" },
        }),
        pluginAppPolicyContext: createConnectorAppPolicyContext({ allowDestructiveActions: true }),
      },
    },
  ])("$name", async ({ request }) => {
    const result = await handleCodexAppServerElicitationRequest(request);
    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expectNoApproval();
  });

  it.each([false, true])(
    "accepts safely mapped plugin app elicitations only while the turn remains active (aborted: %s)",
    async (aborted) => {
      const controller = new AbortController();
      if (aborted) {
        controller.abort("permission-change");
      }
      const result = await handleCodexAppServerElicitationRequest({
        requestParams: buildPluginApprovalElicitation(),
        pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
        signal: controller.signal,
      });

      expect(result).toEqual({
        action: aborted ? "cancel" : "accept",
        content: aborted ? null : { approve: true },
        _meta: null,
      });
      expectNoApproval();
    },
  );

  it("routes approvals for account-connected apps through the configured policy", async () => {
    mockApprovalDecision("plugin:approval-meetings", "allow-once");

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        message: "Allow ChatGPT Meetings to import a meeting?",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          connector_id: "chatgpt_meetings",
          connector_name: "ChatGPT Meetings",
          tool_title: "import_meeting",
        },
      }),
      pluginAppPolicyContext: createAccountAppPolicyContext({
        appId: "chatgpt_meetings",
        appName: "ChatGPT Meetings",
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
      }),
    });

    expect(result).toEqual({ action: "accept", content: null, _meta: null });
    expect(approvalRequest()).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
      title: "Allow ChatGPT Meetings to import a meeting?",
    });
  });

  it("does not expose allow-always for auto plugin session-only persistence", async () => {
    mockApprovalDecision("plugin:approval-calendar-session", "allow-once");

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          connector_id: "connector_google_calendar",
          connector_name: "Google Calendar",
          persist: ["session"],
          tool_title: "create_event",
        },
        requestedSchema: buildApprovalElicitation("Approve this app action").requestedSchema,
      }),
      pluginAppPolicyContext: createConnectorAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
      }),
    });

    expect(result).toEqual({ action: "accept", content: { approve: true }, _meta: null });
    expect(approvalRequest()).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("maps unexpected allow-always decisions to one-shot for ask plugin policy", async () => {
    mockApprovalDecision("plugin:approval-calendar-unexpected-always", "allow-always");

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          connector_id: "connector_google_calendar",
          connector_name: "Google Calendar",
          persist: ["session", "always"],
          tool_title: "create_event",
        },
      }),
      pluginAppPolicyContext: createConnectorAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "ask",
      }),
    });

    expect(approvalRequest()).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(result).toEqual({ action: "accept", content: null, _meta: null });
  });

  it("fails closed when auto plugin approval routing is unavailable", async () => {
    requestApproval.mockResolvedValueOnce({
      id: "plugin:approval-calendar-unavailable",
      decision: null,
    });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation(),
      pluginAppPolicyContext: createConnectorAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
      }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(waitForApproval).not.toHaveBeenCalled();
  });

  it("cancels auto plugin app approvals when the turn aborts", async () => {
    const abortController = new AbortController();
    requestApproval.mockResolvedValueOnce({ id: "plugin:approval-calendar-abort" });
    waitForApproval.mockImplementationOnce(() => {
      abortController.abort(new Error("turn stopped"));
      return new Promise(() => {});
    });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation(),
      pluginAppPolicyContext: createConnectorAppPolicyContext({
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
      }),
      signal: abortController.signal,
    });

    expect(result).toEqual({ action: "cancel", content: null, _meta: null });
  });

  it("routes permitted native app calls for consent under destructive denial", async () => {
    mockApprovalDecision("plugin:read-consent", "deny");
    const requestParams = buildConnectorPluginApprovalElicitation({
      message: "Allow Google Calendar to read an event?",
    });
    requestParams._meta.tool_title = "read_event";
    const result = await handleCodexAppServerElicitationRequest({
      requestParams,
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: false,
        apps: [{ appId: "connector_google_calendar", mcpServerNames: [] }],
      }),
    });

    expect(result).toEqual({ action: "decline", content: null, _meta: null });
    expect(approvalRequest()).toMatchObject({
      title: "Allow Google Calendar to read an event?",
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("matches a connector approval to the admitted Apps SDK identity", async () => {
    const suffix = "0123456789abcdef0123456789abcdef";
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildConnectorPluginApprovalElicitation({
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          source: "connector",
          app_id: `asdk_app_${suffix}`,
          connector_id: `connector_${suffix}`,
          connector_name: "Google Calendar",
          tool_title: "create_event",
        },
      }),
      pluginAppPolicyContext: createPluginAppPolicyContext({
        allowDestructiveActions: true,
        apps: [{ appId: `connector_${suffix}`, mcpServerNames: [] }],
      }),
    });
    expect(result?.action).toBe("accept");
    expectNoApproval();
  });

  it("does not answer plugin app elicitations for a different active turn", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildPluginApprovalElicitation({ turnId: "turn-2" }),
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
    });

    expect(result).toBeUndefined();
    expectNoApproval();
  });

  it("keeps unrelated MCP approval elicitations on the existing approval bridge", async () => {
    mockApprovalDecision("plugin:approval-unrelated", "allow-once");

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildCurrentCodexApprovalElicitation(),
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: true }),
    });

    expect(result).toEqual({ action: "accept", content: null, _meta: null });
    expectApprovalRoundtrip();
  });

  it("ignores unscoped approval elicitations without the active thread id", async () => {
    const { turnId, serverName, mode, message, _meta, requestedSchema } =
      buildCurrentCodexApprovalElicitation();
    const result = await routeCodexAppServerElicitationRequest({
      requestParams: { turnId, serverName, mode, message, _meta, requestedSchema },
      paramsForRun: createParams(),
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ kind: "not-mine" });
    expectNoApproval();
  });

  it("maps allow-always decisions onto persistent approval metadata when offered", async () => {
    mockApprovalDecision("plugin:approval-2", "allow-always");

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildApprovalElicitation(),
    });

    expect(result).toEqual({
      action: "accept",
      content: { approve: true, persist: "always" },
      _meta: { persist: "always" },
    });
    expect(approvalRequest()).toMatchObject({
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
  });

  it.each([
    { hints: ["session", "always"], choice: "Allow and don't ask me again", persist: "always" },
    { hints: "session", choice: "Allow for this session", persist: "session" },
    { hints: [], choice: "Allow", persist: undefined },
  ])(
    "matches the MCP approval enum to $persist persistence",
    async ({ hints, choice, persist }) => {
      mockApprovalDecision("plugin:enum", "allow-always");
      const result = await handleCodexAppServerElicitationRequest({
        requestParams: {
          ...buildApprovalElicitation(),
          _meta: { codex_approval_kind: "mcp_tool_call", persist: hints },
          requestedSchema: objectSchema(
            {
              approval: {
                type: "string",
                enum: ["Allow", "Allow for this session", "Allow and don't ask me again", "Cancel"],
              },
            },
            ["approval"],
          ),
        },
      });
      expect(result).toEqual({
        action: "accept",
        content: { approval: choice },
        _meta: persist ? { persist } : null,
      });
    },
  );

  it("does not inherit persist defaults for one-time approvals", async () => {
    mockApprovalDecision("plugin:approval-5", "allow-once");

    const requestParams = buildApprovalElicitation();
    Object.assign(requestParams.requestedSchema.properties.persist, { default: "always" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams,
    });

    expect(result).toEqual({ action: "accept", content: { approve: true }, _meta: null });
  });

  it("leaves an ordinary plugin-owned MCP form to the ordinary input bridge", async () => {
    const result = await routeCodexAppServerElicitationRequest({
      requestParams: {
        ...codexTestTurnIds(),
        serverName: "google-calendar-mcp",
        _meta: { app_id: "google-calendar-app" },
        mode: "form",
        message: "Choose a calendar",
        requestedSchema: objectSchema(
          { calendar: { type: "string", enum: ["work", "personal"] } },
          ["calendar"],
        ),
      },
      paramsForRun: createParams(),
      ...codexTestTurnIds(),
      pluginAppPolicyContext: createPluginAppPolicyContext({ allowDestructiveActions: false }),
    });

    expect(result).toEqual({ kind: "not-mine" });
    expectNoApproval();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
