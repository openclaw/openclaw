import {
  callGatewayTool,
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

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
type AgentHarnessHostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];

type ElicitationRequest = Parameters<typeof routeCodexAppServerElicitationRequest>[0];

async function elicit(
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

function gatewayToolArg(index = 0, argIndex = 0) {
  return mockCallGatewayTool.mock.calls.at(index)?.at(argIndex);
}

function mockApprovalDecision(decision: "allow-once" | "allow-always" | "deny" = "allow-once") {
  const id = "plugin:approval";
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
        { pluginId: "codex", ...request, timeoutMs: request.timeoutMs, twoPhase: true },
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
  return { hostCapabilities } as unknown as EmbeddedRunAttemptParams;
}

function reply(
  action: "accept" | "decline" | "cancel",
  content: JsonObject | null = null,
  meta: JsonObject | null = null,
) {
  return { action, content, _meta: meta };
}

function objectSchema(properties: JsonObject, required?: string[]): JsonObject {
  return { type: "object", properties, ...(required ? { required } : {}) };
}

function approvalField(title: string, description?: string): JsonObject {
  return { type: "boolean", title, ...(description ? { description } : {}) };
}

function approvalSchema(approve: JsonObject, fields: JsonObject = {}) {
  return objectSchema({ approve, ...fields }, ["approve"]);
}

function approvalMeta(fields: JsonObject = {}): JsonObject {
  return { codex_approval_kind: "mcp_tool_call", ...fields };
}

function approval() {
  return {
    ...codexTestTurnIds(),
    serverName: "codex_apps__github",
    mode: "form",
    message: "Approve app tool call?",
    _meta: approvalMeta({ persist: ["session", "always"] }),
    requestedSchema: approvalSchema(approvalField("Approve this tool call"), {
      persist: { type: "string", title: "Persist choice", enum: ["session", "always"] },
    }),
  };
}

function currentApproval() {
  return {
    ...approval(),
    _meta: approvalMeta({
      persist: ["session", "always"],
      connector_name: "GitHub",
      tool_title: "Create pull request",
      tool_description: "Creates a pull request in the selected repository.",
      tool_params_display: [
        { name: "repo", display_name: "Repository", value: "openclaw/openclaw" },
      ],
    }),
    requestedSchema: objectSchema({}),
  };
}

function connectorApproval(meta: JsonObject = {}, overrides: Record<string, unknown> = {}) {
  const base = buildConnectorPluginApprovalElicitation();
  return { ...base, _meta: { ...base._meta, ...meta }, ...overrides };
}

function computerApproval(overrides: Record<string, unknown> = {}) {
  return {
    ...codexTestTurnIds(),
    serverName: "computer-use",
    mode: "form",
    message: "Allow Codex to use Notes?",
    _meta: { persist: ["always"] },
    requestedSchema: objectSchema({}),
    ...overrides,
  };
}

function pluginApproval(overrides: Record<string, unknown> = {}) {
  return {
    ...codexTestTurnIds(),
    serverName: "google-calendar-mcp",
    mode: "form",
    message: "Approve app action?",
    _meta: approvalMeta({ app_id: "google-calendar-app" }),
    requestedSchema: approvalSchema(approvalField("Approve this app action")),
    ...overrides,
  };
}

function pluginPolicy(
  params: {
    allowDestructiveActions?: boolean;
    destructiveApprovalMode?: "allow" | "deny" | "auto" | "ask";
    apps?: Array<{ appId: string; mcpServerNames: string[] }>;
  } = {},
) {
  const apps = params.apps ?? [
    { appId: "google-calendar-app", mcpServerNames: ["google-calendar-mcp"] },
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
    pluginAppIds: apps.length ? { "google-calendar": apps.map((app) => app.appId).toSorted() } : {},
  };
}

function connectorPolicy(
  params: Omit<NonNullable<Parameters<typeof pluginPolicy>[0]>, "apps"> = {},
) {
  return pluginPolicy({
    allowDestructiveActions: true,
    ...params,
    apps: [{ appId: "connector_google_calendar", mcpServerNames: [] }],
  });
}

function accountPolicy() {
  return {
    fingerprint: "account-app-policy-1",
    apps: {
      chatgpt_meetings: {
        source: "account" as const,
        appName: "ChatGPT Meetings",
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto" as const,
        mcpServerNames: [],
      },
    },
    pluginAppIds: {},
  };
}

function pluginRequest(
  requestParams: ElicitationRequest["requestParams"],
  pluginAppPolicyContext: ElicitationRequest["pluginAppPolicyContext"] = pluginPolicy({
    allowDestructiveActions: true,
  }),
  extra: Partial<ElicitationRequest> = {},
) {
  return { requestParams, pluginAppPolicyContext, ...extra };
}

function computerRequest(
  requestParams: ElicitationRequest["requestParams"],
  extra: Partial<ElicitationRequest> = {},
) {
  return {
    requestParams,
    pluginAppPolicyContext: pluginPolicy({ apps: [] }),
    computerUseMcpServerName: "computer-use",
    ...extra,
  };
}

function displayRequest(meta: JsonObject, overrides: JsonObject = {}) {
  return {
    requestParams: {
      ...currentApproval(),
      message: "Approve",
      _meta: approvalMeta(meta),
      ...overrides,
    },
  };
}

function mcpParams(
  servers: NonNullable<NonNullable<EmbeddedRunAttemptParams["config"]>["mcp"]>["servers"],
) {
  return { ...createParams(), config: { mcp: { servers } } };
}

function elicitPlugin(...args: Parameters<typeof pluginRequest>) {
  return elicit(pluginRequest(...args));
}
function elicitComputer(...args: Parameters<typeof computerRequest>) {
  return elicit(computerRequest(...args));
}

function scheduledParams() {
  return {
    ...createParams(),
    trigger: "cron",
    scheduledRuntimeAuthority: {
      version: 1,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { version: 1 },
    },
  } as EmbeddedRunAttemptParams;
}

describe("Codex app-server elicitation bridge", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
    vi.restoreAllMocks();
  });

  it("declines app elicitations for scheduled app authority", async () => {
    const result = await elicitPlugin(pluginApproval(), undefined, {
      paramsForRun: scheduledParams(),
    });

    expect(result).toEqual(reply("decline"));
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("keeps unrelated Computer Use elicitation policy unchanged", async () => {
    mockApprovalDecision();
    const result = await elicitComputer(computerApproval(), {
      paramsForRun: scheduledParams(),
      autoApproveMcpTools: true,
    });

    expect(result).toEqual(reply("accept"));
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(2);
  });

  it.each([
    { mode: undefined, prompts: true },
    { mode: "approve", prompts: false },
  ] as const)(
    "honors projected prompt posture and the server override $mode in full-permission mode",
    async ({ mode, prompts }) => {
      mockApprovalDecision();
      const result = await elicit({
        requestParams: { ...currentApproval(), serverName: "linear" },
        paramsForRun: mcpParams({
          linear: {
            url: "https://linear.example/mcp",
            ...(mode ? { codex: { defaultToolsApprovalMode: mode } } : {}),
          },
        }),
        autoApproveMcpTools: true,
        projectedMcpServers: { linear: { default_tools_approval_mode: "prompt" } },
      });

      expect(result).toEqual(reply("accept"));
      expect(mockCallGatewayTool).toHaveBeenCalledTimes(prompts ? 2 : 0);
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
    mockApprovalDecision("allow-always");
    const server = testCase.apps ? "codex_apps" : "raw-server";
    const item = {
      id: "raw-call",
      server,
      tool: "_create.issue-v2",
      arguments: { repo: "openclaw/openclaw", limit: 3 },
    };
    let activeItem: typeof item | undefined = testCase.missingItem ? undefined : item;
    const result = await elicit({
      requestParams: {
        ...currentApproval(),
        serverName: server,
        ...(testCase.missingTurn ? { turnId: null } : {}),
        _meta: approvalMeta({
          persist: testCase.sessionOnly ? "session" : ["session", "always"],
          tool_title: "This is not the tool identity",
          ...(testCase.display === undefined ? {} : { tool_params_display: testCase.display }),
        }),
      },
      paramsForRun: mcpParams(
        testCase.unconfigured
          ? {}
          : {
              [server]: {
                url: "https://mcp.example.test",
                ...(testCase.prompt ? { codex: { defaultToolsApprovalMode: "prompt" } } : {}),
              },
            },
      ),
      getActiveMcpToolCall: () => activeItem,
      ...(testCase.computerUse ? { computerUseMcpServerName: server } : {}),
    });
    const request = gatewayToolArg(0, 2) as {
      mcpTool?: unknown;
      toolCallId?: string;
      isMcpToolApprovalActive?: () => boolean;
    };
    expect(request.mcpTool).toEqual(testCase.grant ? { server, tool: item.tool } : undefined);
    if (testCase.grant) {
      expect(request.toolCallId).toBe(item.id);
      expect(request.isMcpToolApprovalActive?.()).toBe(true);
      activeItem = undefined;
      expect(request.isMcpToolApprovalActive?.()).toBe(false);
    }
    expect(result?.action).toBe("accept");
    if (!testCase.prompt) {
      expect(result?._meta).toEqual({ persist: testCase.sessionOnly ? "session" : "always" });
    }
  });

  it("does not trust request-time decisions for two-phase MCP approvals", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({
        id: "plugin:approval-untrusted",
        status: "accepted",
        decision: "allow-always",
      })
      .mockResolvedValueOnce({ id: "plugin:approval-untrusted", decision: "deny" });

    const result = await elicit({ requestParams: approval() });

    expect(result).toEqual(reply("decline"));
    expect(gatewayToolArg(0, 2)).toMatchObject({
      description: expect.stringContaining(
        "openclaw mcp configure codex_apps__github --approval approve",
      ),
    });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("declines timed-out MCP approvals without response meta Codex would drop", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-timeout", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-timeout",
        decision: "deny",
        terminalReason: "timeout",
      });

    const result = await elicit({ requestParams: approval() });

    expect(result).toEqual(reply("decline"));
  });

  it("does not handle non-Computer Use elicitations without approval metadata", async () => {
    const result = await elicitComputer(computerApproval({ serverName: "desktop-control" }));

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("declines approved Computer Use app approvals with unmappable non-empty schemas", async () => {
    const warnSpy = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    mockApprovalDecision();

    const result = await elicitComputer(
      computerApproval({
        requestedSchema: objectSchema({ appName: { type: "string", title: "App name" } }, [
          "appName",
        ]),
      }),
    );

    expect(result).toEqual(reply("decline"));
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      "codex MCP approval elicitation approved without a mappable response",
      expect.objectContaining({ fields: ["appName"], outcome: "approved-once" }),
    );
  });

  it("normalizes missing Computer Use schemas to the empty object schema", async () => {
    mockApprovalDecision();

    const result = await elicitComputer(computerApproval({ requestedSchema: "not-a-schema" }));

    expect(result).toEqual(reply("accept"));
  });

  it("declines Computer Use elicitations outside form mode", async () => {
    const result = await elicitComputer(computerApproval({ mode: "notification" }));

    expect(result).toEqual(reply("decline"));
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    request: Parameters<typeof elicit>[0];
    title: string | undefined;
    contains: string[];
    excludes: string[];
  }>([
    {
      name: "falls back to a Computer Use approval title and sanitizes server names",
      request: {
        requestParams: computerApproval({
          message: "\u001b[31m",
          serverName: "computer-use\u009b31m",
          _meta: null,
        }),
        pluginAppPolicyContext: pluginPolicy({ apps: [] }),
        computerUseMcpServerName: "computer-use\u009b31m",
      },
      title: "Computer Use approval",
      contains: ["MCP server: computer-use"],
      excludes: ["openclaw mcp configure", "\u009b"],
    },
    {
      name: "strips control and invisible formatting from approval display text",
      request: displayRequest(
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
        {
          message: "Approve\u202e hidden",
          serverName: "codex\u009b31m_apps__github",
          requestedSchema: approvalSchema(
            approvalField("Approve\u202e this tool call", "Confirm\u009b31m access"),
          ),
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
      request: displayRequest(
        {
          connector_name: "GitHub [trusted](https://evil)",
          tool_title: "Create <@U123>",
          tool_description: "Use @here",
          tool_params_display: [
            { name: "repo", display_name: "Repository [trusted](https://evil)", value: "<@U123>" },
          ],
        },
        {
          message: "Approve <@U123>",
          serverName: "server @here",
          requestedSchema: approvalSchema(approvalField("Approve <@U123>", "Confirm @here")),
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
      request: displayRequest(
        {
          connector_name: "App",
          tool_params_display: [
            { name: "repo", display_name: "\u202e", value: "openclaw/openclaw" },
          ],
        },
        { requestedSchema: approvalSchema(approvalField("\u202e", "Confirm access")) },
      ),
      title: undefined,
      contains: ["- repo: openclaw/openclaw", "- approve: Confirm access"],
      excludes: ["- field: Confirm access"],
    },
    {
      name: "bounds deep approval display parameter values before forwarding them",
      request: displayRequest({
        connector_name: "App",
        tool_title: "Tool",
        tool_params_display: [
          {
            name: "payload",
            value: {
              key0: { nested: { deeper: { secret: "hidden" } } },
              ...Object.fromEntries(
                Array.from({ length: 8 }, (_, index) => [`key${index + 1}`, index + 1]),
              ),
            },
          },
        ],
      }),
      title: undefined,
      contains: ["payload", "key0"],
      excludes: ["key8", "hidden"],
    },
    {
      name: "caps approval display parameter entries before forwarding them",
      request: displayRequest(
        {
          connector_name: "App",
          tool_params_display: Array.from({ length: 9 }, (_, index) => ({
            name: `p${index}`,
            value: index,
          })),
        },
        { serverName: "" },
      ),
      title: undefined,
      contains: ["p0", "p7", "Additional parameters: 1 more"],
      excludes: ["p8"],
    },
  ])("$name", async ({ request, title, contains, excludes }) => {
    mockApprovalDecision();
    const result = await elicit(request);
    expect(result?.action).toBe("accept");
    if ("computerUseMcpServerName" in request) {
      expect(result).toEqual(reply("accept"));
    }
    const approvalRequest = gatewayToolArg(0, 2) as { title: string; description: string };
    if (title !== undefined) {
      expect(approvalRequest.title).toBe(title);
    }
    for (const text of contains) {
      expect(approvalRequest.description).toContain(text);
    }
    for (const text of excludes) {
      expect(approvalRequest.description).not.toContain(text);
    }
  });

  it.each([
    {
      name: "declines plugin app elicitations when destructive actions are disabled",
      request: pluginRequest(pluginApproval(), pluginPolicy({ allowDestructiveActions: false }), {
        autoApproveMcpTools: true,
      }),
    },
    {
      name: "does not trust account app ids from non-connector MCP servers",
      request: pluginRequest(
        pluginApproval({ _meta: approvalMeta({ app_id: "chatgpt_meetings" }) }),
        accountPolicy(),
      ),
    },
    {
      name: "declines live connector elicitations that only match display names",
      request: pluginRequest(
        buildConnectorPluginApprovalElicitation({
          _meta: approvalMeta({
            source: "connector",
            connector_name: "Google Calendar",
            tool_title: "create_event",
          }),
        }),
        connectorPolicy(),
      ),
    },
    {
      name: "declines live connector elicitations with mismatched app and connector ids",
      request: pluginRequest(connectorApproval({ app_id: "other-app" }), connectorPolicy()),
    },
    {
      name: "declines plugin app elicitations that are missing active turn correlation",
      request: pluginRequest(pluginApproval({ turnId: null })),
    },
    {
      name: "declines plugin app elicitations with ambiguous server ownership",
      request: pluginRequest(
        pluginApproval({ serverName: "shared-mcp", _meta: approvalMeta({}) }),
        pluginPolicy({
          allowDestructiveActions: true,
          apps: [
            { appId: "calendar-app-1", mcpServerNames: ["shared-mcp"] },
            { appId: "calendar-app-2", mcpServerNames: ["shared-mcp"] },
          ],
        }),
      ),
    },
    {
      name: "declines plugin-scoped elicitations when policy context is missing",
      request: { requestParams: pluginApproval() },
    },
    {
      name: "declines plugin app elicitations with unmappable schemas",
      request: pluginRequest(
        pluginApproval({
          requestedSchema: objectSchema(
            { template: { type: "string", enum: ["simple", "detailed"] } },
            ["template"],
          ),
        }),
      ),
    },
    {
      name: "declines connector-id plugin app elicitations without object properties",
      request: pluginRequest(
        connectorApproval({}, { requestedSchema: { type: "object" } }),
        connectorPolicy(),
      ),
    },
  ])("$name", async ({ request }) => {
    const result = await elicit(request);
    expect(result).toEqual(reply("decline"));
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "accepts safely mapped plugin app elicitations only while the turn remains active (aborted: %s)",
    async (aborted) => {
      const controller = new AbortController();
      if (aborted) {
        controller.abort("permission-change");
      }
      const result = await elicitPlugin(pluginApproval(), undefined, { signal: controller.signal });

      expect(result).toEqual(
        reply(aborted ? "cancel" : "accept", aborted ? null : { approve: true }),
      );
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    },
  );

  it("routes approvals for account-connected apps through the configured policy", async () => {
    mockApprovalDecision();

    const result = await elicitPlugin(
      connectorApproval(
        {
          connector_id: "chatgpt_meetings",
          connector_name: "ChatGPT Meetings",
          tool_title: "import_meeting",
        },
        { message: "Allow ChatGPT Meetings to import a meeting?" },
      ),
      accountPolicy(),
    );

    expect(result).toEqual(reply("accept"));
    expect(gatewayToolArg(0, 2)).toMatchObject({
      allowedDecisions: ["allow-once", "deny"],
      title: "Allow ChatGPT Meetings to import a meeting?",
      twoPhase: true,
    });
  });

  it("does not expose allow-always for auto plugin session-only persistence", async () => {
    mockApprovalDecision();

    const result = await elicitPlugin(
      connectorApproval(
        { persist: ["session"] },
        {
          requestedSchema: approvalSchema(approvalField("Approve this app action"), {
            persist: { type: "string", title: "Persist choice", enum: ["session", "always"] },
          }),
        },
      ),
      connectorPolicy({ destructiveApprovalMode: "auto" }),
    );

    expect(result).toEqual(reply("accept", { approve: true }));
    expect(gatewayToolArg(0, 2)).toMatchObject({ allowedDecisions: ["allow-once", "deny"] });
  });

  it("maps unexpected allow-always decisions to one-shot for ask plugin policy", async () => {
    mockApprovalDecision("allow-always");

    const result = await elicitPlugin(
      connectorApproval({ persist: ["session", "always"] }),
      connectorPolicy({ destructiveApprovalMode: "ask" }),
    );

    expect(gatewayToolArg(0, 2)).toMatchObject({ allowedDecisions: ["allow-once", "deny"] });
    expect(result).toEqual(reply("accept"));
  });

  it("fails closed when auto plugin approval routing is unavailable", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-calendar-unavailable",
      decision: null,
    });

    const result = await elicitPlugin(
      connectorApproval(),
      connectorPolicy({ destructiveApprovalMode: "auto" }),
    );

    expect(result).toEqual(reply("decline"));
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
    ]);
  });

  it("cancels auto plugin app approvals when the turn aborts", async () => {
    const abortController = new AbortController();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-calendar-abort", status: "accepted" })
      .mockImplementationOnce(() => {
        abortController.abort(new Error("turn stopped"));
        return new Promise(() => {});
      });

    const result = await elicitPlugin(
      connectorApproval(),
      connectorPolicy({ destructiveApprovalMode: "auto" }),
      {
        signal: abortController.signal,
      },
    );

    expect(result).toEqual(reply("cancel"));
  });

  it("routes permitted native app calls for consent under destructive denial", async () => {
    mockApprovalDecision("deny");
    const result = await elicitPlugin(
      connectorApproval(
        { tool_title: "read_event" },
        { message: "Allow Google Calendar to read an event?" },
      ),
      connectorPolicy({ allowDestructiveActions: false }),
    );

    expect(result).toEqual(reply("decline"));
    expect(gatewayToolArg(0, 2)).toMatchObject({
      title: "Allow Google Calendar to read an event?",
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("matches a connector approval to the admitted Apps SDK identity", async () => {
    const suffix = "0123456789abcdef0123456789abcdef";
    const result = await elicitPlugin(
      connectorApproval({ app_id: `asdk_app_${suffix}`, connector_id: `connector_${suffix}` }),
      pluginPolicy({
        allowDestructiveActions: true,
        apps: [{ appId: `connector_${suffix}`, mcpServerNames: [] }],
      }),
    );
    expect(result?.action).toBe("accept");
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("does not answer plugin app elicitations for a different active turn", async () => {
    const result = await elicitPlugin(pluginApproval({ turnId: "turn-2" }));

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("keeps unrelated MCP approval elicitations on the existing approval bridge", async () => {
    mockApprovalDecision();

    const result = await elicitPlugin(currentApproval());

    expect(result).toEqual(reply("accept"));
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("ignores unscoped approval elicitations without the active thread id", async () => {
    const { turnId, serverName, mode, message, _meta, requestedSchema } = currentApproval();
    const result = await routeCodexAppServerElicitationRequest({
      requestParams: { turnId, serverName, mode, message, _meta, requestedSchema },
      paramsForRun: createParams(),
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ kind: "not-mine" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("maps allow-always decisions onto persistent approval metadata when offered", async () => {
    mockApprovalDecision("allow-always");

    const result = await elicit({ requestParams: approval() });

    expect(result).toEqual(
      reply("accept", { approve: true, persist: "always" }, { persist: "always" }),
    );
    expect(gatewayToolArg(0, 2)).toMatchObject({
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
      mockApprovalDecision("allow-always");
      const result = await elicit({
        requestParams: {
          ...approval(),
          _meta: approvalMeta({ persist: hints }),
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
      expect(result).toEqual(reply("accept", { approval: choice }, persist ? { persist } : null));
    },
  );

  it("does not inherit persist defaults for one-time approvals", async () => {
    mockApprovalDecision();

    const result = await elicit({
      requestParams: {
        ...approval(),
        requestedSchema: approvalSchema(approvalField("Approve this tool call"), {
          persist: {
            type: "string",
            title: "Persist choice",
            enum: ["session", "always"],
            default: "always",
          },
        }),
      },
    });

    expect(result).toEqual(reply("accept", { approve: true }));
  });

  it("leaves an ordinary form from a plugin-owned MCP server to the ordinary input bridge", async () => {
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
      pluginAppPolicyContext: pluginPolicy({ allowDestructiveActions: false }),
      paramsForRun: createParams(),
      ...codexTestTurnIds(),
    });
    expect(result).toEqual({ kind: "not-mine" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("does not split surrogate pairs when truncating display parameter values", async () => {
    mockApprovalDecision();

    // The surrogate pair straddles the 117-code-unit boundary before the ellipsis.
    const displayValue = `${"b".repeat(116)}😀tail`;

    await elicit({
      requestParams: {
        ...approval(),
        _meta: approvalMeta({
          tool_params_display: [{ name: "key", display_name: "Value", value: displayValue }],
        }),
      },
    });

    const approvalCallParams = gatewayToolArg(0, 2) as { title?: string; description?: string };
    const description = approvalCallParams.description ?? "";
    expect(description).toContain(`${"b".repeat(116)}...`);
  });

  it("does not expose a split surrogate pair from the display scan cap", async () => {
    mockApprovalDecision();

    await elicit({
      requestParams: {
        ...approval(),
        message: `${"\u0000".repeat(4095)}😀tail`,
      },
    });

    const approvalCallParams = gatewayToolArg(0, 2) as { title?: string; description?: string };
    expect(approvalCallParams.title).toBe("Codex MCP tool approval");
    expect(approvalCallParams.description).not.toContain(String.fromCharCode(0xd83d));
    expect(() => encodeURIComponent(approvalCallParams.description ?? "")).not.toThrow();
  });
});
