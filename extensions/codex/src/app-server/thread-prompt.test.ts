import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
  type JsonObject,
} from "./protocol.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";

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

function createParams(overrides: Partial<EmbeddedRunAttemptParams> = {}): EmbeddedRunAttemptParams {
  return {
    agentId: "main",
    config: {},
    modelId: "gpt-5.6-luna",
    sessionKey: "agent:main:main",
    sourceReplyDeliveryMode: "automatic",
    ...overrides,
  } as EmbeddedRunAttemptParams;
}

function buildInstructions(overrides: Partial<EmbeddedRunAttemptParams> = {}): string {
  return buildDeveloperInstructions(createParams(overrides), {
    dynamicTools: delegationTools,
  });
}

describe("buildDeveloperInstructions deferred tool discovery", () => {
  it.each([false, true])("advertises JavaScript discovery only when enabled (%s)", (enabled) => {
    const instructions = buildDeveloperInstructions(createParams(), {
      nativeCodeModeEnabled: enabled,
      dynamicTools: [namespace([tool("dashboard", {}, true)])],
    });
    expect(instructions).toContain("openclaw.dashboard");
    expect(instructions.includes("ALL_TOOLS")).toBe(enabled);
    if (enabled) {
      expect(instructions).toContain("native JavaScript `exec`");
    } else {
      expect(instructions).toContain("Shell command tools execute operating-system commands");
    }
  });

  it.each([false, true])(
    "does not advertise discovery for a restricted direct surface (%s)",
    (enabled) => {
      const instructions = buildDeveloperInstructions(
        createParams({
          toolsAllow: ["message"],
          sourceReplyDeliveryMode: "message_tool_only",
        }),
        {
          nativeCodeModeEnabled: enabled,
          dynamicTools: [tool("message")],
        },
      );
      expect(instructions).not.toContain("ALL_TOOLS");
      expect(instructions).not.toContain("`tool_search`");
      expect(instructions).not.toContain("spawn_agent");
    },
  );

  it("preserves JavaScript discovery for code-mode-only threads", () => {
    const instructions = buildDeveloperInstructions(createParams(), {
      nativeCodeModeEnabled: true,
      nativeCodeModeOnlyEnabled: true,
    });
    expect(instructions).toContain("native JavaScript `exec`");
    expect(instructions).toContain("ALL_TOOLS");
    expect(instructions).not.toContain("`tool_search`");
  });
});

describe("buildDeveloperInstructions delegation guidance", () => {
  it.each(["prefer", "suggest"] as const)(
    "routes new helpers by tool requirements in %s mode without moving existing children",
    (delegationMode) => {
      const instructions = buildDeveloperInstructions(
        createParams({ config: { agents: { defaults: { subagents: { delegationMode } } } } }),
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
        'Actual delegated helpers use native `spawn_agent` for Codex-native work, or `openclaw.sessions_spawn` with `runtime="subagent"` for new work needing OpenClaw tools',
      );
      expect(instructions).toContain(
        "For follow-up work on an existing native child, use the native collaboration tool that starts or queues a new turn.",
      );
      expect(instructions).toContain("Do not respawn existing work to switch tool routes");
    },
  );

  it("does not invent a managed route when only native delegation is available", () => {
    const instructions = buildDeveloperInstructions(createParams());

    expect(instructions).toContain("`spawn_agent` for work that only needs Codex-native tools");
    expect(instructions).not.toContain("sessions_spawn");
    expect(instructions).toContain("Keep work needing OpenClaw tools in this session");
  });

  it.each<{ properties: JsonObject; expected: string }>([
    { properties: {}, expected: "use `sessions_spawn` from the start." },
    {
      properties: { runtime: { type: "string", enum: ["acp"] } },
      expected: "Keep work needing OpenClaw tools in this session",
    },
  ])("respects the advertised managed runtime schema: %j", ({ properties, expected }) => {
    const instructions = buildDeveloperInstructions(createParams(), {
      dynamicTools: [tool("sessions_spawn", properties)],
    });

    expect(instructions).toContain(expected);
    expect(instructions).not.toContain('runtime="subagent"');
  });

  it.each([{ requireWorkspaceOnly: true }, { delegationCapability: "host_only" }] as const)(
    "does not advertise native helpers for restricted runs (%j)",
    (overrides) => {
      const instructions = buildInstructions(overrides);
      expect(instructions).not.toContain("spawn_agent");
      expect(instructions).not.toContain("wait_agent");
      expect(instructions).toContain("sessions_spawn");
      expect(instructions).toContain('`sessions_spawn` with `runtime="subagent"`');
    },
  );

  it.each<Partial<EmbeddedRunAttemptParams>>([
    { delegationCapability: "report_only" },
    { disableTools: true },
    { toolsAllow: [] },
  ])("does not advertise either delegation route when delegation is disabled (%j)", (overrides) => {
    const instructions = buildInstructions(overrides);
    expect(instructions).not.toContain("spawn_agent");
    expect(instructions).not.toContain("sessions_spawn");
  });

  it("omits discovery and delegation guidance for an explicitly empty tool allowlist", () => {
    const params = createParams({ toolsAllow: [] });
    const instructions = buildDeveloperInstructions(params);

    expect(instructions).not.toContain("Shell command tools");
    expect(instructions).not.toContain("spawn_agent");
    expect(buildDeveloperInstructions({ ...params, toolsAllow: undefined })).toContain(
      "Shell command tools",
    );
  });

  it.each([false, true])(
    "routes session creation from available tools in suggest mode (deferred: %s)",
    (deferLoading) => {
      const params = createParams({ sessionKey: "agent:main:dashboard:task" });
      const render = (createAvailable: boolean) =>
        buildDeveloperInstructions(params, {
          dynamicTools: [
            ...delegationTools,
            namespace([
              tool(createAvailable ? "sessions_create" : "sessions", {}, deferLoading),
              tool("suggest_task", {}, deferLoading),
            ]),
          ],
        });
      const instructions = render(true);

      expect(instructions).toContain('"spin up a new task"');
      expect(instructions).toContain("`openclaw.sessions_create`");
      expect(instructions).toContain("no completion event or yield expectation");
      expect(instructions).toContain("Actual delegated helpers use native `spawn_agent`");
      expect(instructions).toContain("unrequested follow-up proposals use `openclaw.suggest_task`");
      expect(instructions).not.toContain("## Delegation");
      expect(render(false)).not.toContain("`openclaw.sessions_create`");
    },
  );

  it("omits the policy for prompt mode none", () => {
    expect(buildInstructions({ promptMode: "none" })).not.toContain("## Delegation");
  });
});

describe("buildDeveloperInstructions UI presentation guidance", () => {
  const uiTools = ["screen", "show_widget", "dashboard", "portal", "message"].map((name) =>
    tool(name, name === "message" ? { clawhub: {} } : {}, true),
  );

  it("explains the actual namespaced deferred presentation routes", () => {
    const dynamicTools = [namespace(uiTools)];
    const prefix = "openclaw.";
    const instructions = buildDeveloperInstructions(createParams(), { dynamicTools });

    expect(instructions).toContain("## UI Presentation");
    expect(instructions).toContain(`\`${prefix}screen(action="browser_show")\``);
    expect(instructions).toContain("Do not create or expand a dashboard to open a panel");
    for (const uiTool of uiTools) {
      expect(instructions).toContain(`\`${prefix}${uiTool.name}\``);
    }
    expect(instructions).toContain("pin=true");
    expect(instructions).toContain("publicUrl");
    expect(instructions).toContain("result.presentation");
    expect(instructions).toContain("this turn's schema");
    expect(instructions).toContain("status=pinned means the widget is on the session dashboard");
    expect(instructions).toContain('action="focus_tab" with its tabId');
    expect(instructions).toContain("do not open hosting URLs as browser pages");
    expect(instructions).toContain(
      `\`${prefix}message(action="send", clawhub={query:"capability"})\``,
    );
    expect(instructions).toContain("Tools/skills first");
    expect(instructions).toContain(
      "For explicit plugin/skill search/install or missing capability, use ClawHub",
    );
    expect(instructions).toContain("Skip routine tasks, tool errors, permissions");
  });
});

describe("buildDeveloperInstructions delivery-mode stability", () => {
  it("keeps thread policy stable with message available", () => {
    const dynamicTools = [tool("message")];
    const instructions = (["automatic", "message_tool_only", "automatic"] as const).map(
      (sourceReplyDeliveryMode) =>
        buildDeveloperInstructions(createParams({ sourceReplyDeliveryMode }), { dynamicTools }),
    );

    expect(instructions[1]).toBe(instructions[0]);
    expect(instructions[2]).toBe(instructions[0]);
  });
});
