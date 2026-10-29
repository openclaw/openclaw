import { describe, expect, it } from "vitest";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
  type JsonObject,
} from "./protocol.js";
import { buildDeveloperInstructions, type CodexThreadPromptContext } from "./thread-prompt.js";

function tool(
  name: string,
  properties: JsonObject = {},
  deferLoading = false,
): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name,
    description: name,
    inputSchema: { type: "object", properties },
    deferLoading,
  };
}

function namespace(tools: CodexDynamicToolFunctionSpec[], name = "openclaw"): CodexDynamicToolSpec {
  return { type: "namespace", name, description: "OpenClaw tools", tools };
}

const spawnTool = tool("sessions_spawn", {
  runtime: { type: "string", enum: ["subagent", "acp"] },
});
const delegationTools = [
  spawnTool,
  tool("sessions_send"),
  tool("subagents"),
  namespace([tool("sessions_yield")], CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE),
];

function render(
  params: Partial<CodexThreadPromptContext> = {},
  options: Parameters<typeof buildDeveloperInstructions>[1] = {},
) {
  return buildDeveloperInstructions(
    {
      agentId: "main",
      config: {},
      modelId: "gpt-5.6-luna",
      sessionKey: "agent:main:main",
      sourceReplyDeliveryMode: "automatic",
      ...params,
    },
    {
      dynamicTools: delegationTools,
      ...options,
    },
  );
}

describe("buildDeveloperInstructions deferred tool discovery", () => {
  it.each([false, true])(
    "routes credential entry to the admitted qualified tool (deferred: %s)",
    (deferred) => {
      const instructions = render(
        {},
        {
          nativeCodeModeEnabled: true,
          nativeCodeModeOnlyEnabled: true,
          dynamicTools: [namespace([tool("secrets", {}, deferred)])],
        },
      );
      expect(instructions).toContain("use `openclaw.secrets` for masked entry");
      expect(instructions).toContain("Discover its schema first if deferred");
      expect(instructions).toContain("check the supported consumer, list metadata");
      expect(instructions).toContain("ALL_TOOLS");
    },
  );

  it.each([
    { disableTools: false, dynamicTools: [] },
    { disableTools: true, dynamicTools: [namespace([tool("secrets", {}, true)])] },
  ])("does not advertise unavailable credential entry: %j", ({ disableTools, dynamicTools }) => {
    const instructions = render(
      { disableTools },
      {
        dynamicTools,
      },
    );
    expect(instructions).not.toContain("for masked entry");
    expect(instructions).toContain("Use or store credentials the user supplies as requested");
  });

  it.each([
    [false, false, false],
    [true, false, false],
    [false, false, true],
    [true, false, true],
    [true, true, false],
  ] as const)(
    "selects discovery (JavaScript: %s, code-only: %s, restricted: %s)",
    (enabled, codeOnly, restricted) => {
      const instructions = render(
        restricted ? { toolsAllow: ["message"], sourceReplyDeliveryMode: "message_tool_only" } : {},
        {
          nativeCodeModeEnabled: enabled,
          nativeCodeModeOnlyEnabled: codeOnly,
          dynamicTools: codeOnly
            ? []
            : restricted
              ? [tool("message")]
              : [namespace([tool("dashboard", {}, true)])],
        },
      );
      if (restricted) {
        for (const name of ["ALL_TOOLS", "`tool_search`", "spawn_agent"]) {
          expect(instructions).not.toContain(name);
        }
      } else {
        expect(instructions.includes("ALL_TOOLS")).toBe(enabled);
        expect(instructions).toContain(
          enabled
            ? "native JavaScript `exec`"
            : "Shell command tools execute operating-system commands",
        );
        if (!codeOnly) {
          expect(instructions).toContain("openclaw.dashboard");
        } else {
          expect(instructions).not.toContain("`tool_search`");
        }
      }
    },
  );
});

describe("buildDeveloperInstructions delegation guidance", () => {
  it("routes new helpers by tool requirements without moving existing children", () => {
    const instructions = render(
      {},
      {
        dynamicTools: [namespace([spawnTool, tool("sessions_create")])],
      },
    );

    expect(instructions).toContain("`spawn_agent` for work that only needs Codex-native tools");
    expect(instructions).toContain("native collaboration tools may be deferred");
    expect(instructions).toContain(
      'For new delegated work that needs OpenClaw tools, use `openclaw.sessions_spawn` with `runtime="subagent"` from the start.',
    );
    expect(instructions).toContain(
      "For follow-up work on an existing native child, use the native collaboration tool that starts or queues a new turn.",
    );
    expect(instructions).toContain("Do not respawn existing work to switch tool routes");
  });

  it.each<{ properties: JsonObject; expected: string }>([
    { properties: {}, expected: "use `sessions_spawn` from the start." },
    {
      properties: { runtime: { type: "string", enum: ["acp"] } },
      expected: "Keep work needing OpenClaw tools in this session",
    },
  ])("respects the advertised managed runtime schema: %j", ({ properties, expected }) => {
    const instructions = render(
      {},
      {
        dynamicTools: [tool("sessions_spawn", properties)],
      },
    );

    expect(instructions).toContain(expected);
    expect(instructions).not.toContain('runtime="subagent"');
  });

  it.each([{ requireWorkspaceOnly: true }, { delegationCapability: "host_only" }] as const)(
    "does not advertise native helpers for restricted runs (%j)",
    (overrides) => {
      const instructions = render(overrides);
      expect(instructions).not.toContain("spawn_agent");
      expect(instructions).not.toContain("wait_agent");
      expect(instructions).toContain('`sessions_spawn` with `runtime="subagent"`');
    },
  );

  it.each<Partial<CodexThreadPromptContext>>([
    { delegationCapability: "report_only" },
    { disableTools: true },
    { toolsAllow: [] },
  ])("does not advertise either delegation route when delegation is disabled (%j)", (overrides) => {
    const instructions = render(overrides);
    expect(instructions).not.toContain("spawn_agent");
    expect(instructions).not.toContain("sessions_spawn");
  });

  it("omits discovery and delegation guidance for an explicitly empty tool allowlist", () => {
    const instructions = render({ toolsAllow: [] }, { dynamicTools: [] });

    expect(instructions).not.toContain("Shell command tools");
    expect(instructions).not.toContain("spawn_agent");
    expect(render({}, { dynamicTools: [] })).toContain("Shell command tools");
  });

  it.each([false, true])(
    "routes session creation from available tools in suggest mode (deferred: %s)",
    (deferLoading) => {
      const renderCreation = (createAvailable: boolean) =>
        render(
          { sessionKey: "agent:main:dashboard:task" },
          {
            dynamicTools: [
              ...delegationTools,
              namespace([
                tool(createAvailable ? "sessions_create" : "sessions", {}, deferLoading),
                tool("suggest_task", {}, deferLoading),
              ]),
            ],
          },
        );
      const instructions = renderCreation(true);

      expect(instructions).toContain("`openclaw.sessions_create`");
      expect(instructions).toContain("no completion event or yield expectation");
      expect(instructions).toContain("Actual delegated helpers use native `spawn_agent`");
      expect(instructions).toContain("unrequested follow-up proposals use `openclaw.suggest_task`");
      expect(instructions).not.toContain("## Delegation");
      expect(renderCreation(false)).not.toContain("`openclaw.sessions_create`");
    },
  );

  it("omits the policy for prompt mode none", () => {
    expect(render({ promptMode: "none" })).not.toContain("## Delegation");
  });
});

describe("buildDeveloperInstructions UI presentation guidance", () => {
  const uiTools = ["screen", "show_widget", "dashboard", "portal", "message"].map((name) =>
    tool(name, name === "message" ? { clawhub: {} } : {}, true),
  );

  it("explains the actual namespaced deferred presentation routes", () => {
    const dynamicTools = [namespace(uiTools)];
    const instructions = render({}, { dynamicTools });

    expect(instructions).toContain("## UI Presentation");
    expect(instructions).toContain('`openclaw.screen(action="browser_show")`');
    for (const uiTool of uiTools) {
      expect(instructions).toContain(`\`openclaw.${uiTool.name}\``);
    }
    expect(instructions).toContain(
      '`openclaw.message(action="send", clawhub={query:"capability"})`',
    );
  });
});

describe("buildDeveloperInstructions delivery-mode stability", () => {
  it("keeps thread policy stable with message available", () => {
    const dynamicTools = [tool("message")];
    const instructions = (["automatic", "message_tool_only", "automatic"] as const).map(
      (sourceReplyDeliveryMode) => render({ sourceReplyDeliveryMode }, { dynamicTools }),
    );

    expect(instructions[1]).toBe(instructions[0]);
    expect(instructions[2]).toBe(instructions[0]);
  });
});
