import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
  type JsonObject,
} from "./protocol.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";

const delegationTools: CodexDynamicToolSpec[] = [
  {
    type: "function",
    name: "sessions_spawn",
    description: "Spawn an OpenClaw session",
    inputSchema: {
      type: "object",
      properties: { runtime: { type: "string", enum: ["subagent", "acp"] } },
    },
  },
  {
    type: "function",
    name: "sessions_send",
    description: "Send to an OpenClaw session",
    inputSchema: { type: "object" },
  },
  {
    type: "function",
    name: "subagents",
    description: "List OpenClaw subagents",
    inputSchema: { type: "object" },
  },
  {
    type: "namespace",
    name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
    description: "Direct OpenClaw tools",
    tools: [
      {
        type: "function",
        name: "sessions_yield",
        description: "Yield for OpenClaw session events",
        inputSchema: { type: "object" },
      },
    ],
  },
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
  it.each([{ name: "native delegation", overrides: {}, deferred: false }] as const)(
    "uses direct discovery for normal threads with $name",
    ({ overrides, deferred }) => {
      const instructions = buildDeveloperInstructions(createParams(overrides), {
        nativeCodeModeOnlyEnabled: false,
        dynamicTools: deferred
          ? [
              {
                type: "function",
                name: "lookup",
                description: "Lookup",
                inputSchema: {},
                deferLoading: true,
              },
            ]
          : [],
      });

      expect(instructions).toContain(
        "Deferred tools may be absent from the direct tool list. Call a tool that is in the direct tool list directly. Use `tool_search` to find a tool that is not listed; if `tool_search` is not directly callable, use `exec` to filter `ALL_TOOLS` by name and description and call the matching entry through `tools`. Never use `exec` to look up a tool that is already listed, and do not re-run a completed call to get a result you already have.",
      );
      expect(instructions).not.toContain("On code-mode-only models");
      expect(instructions).not.toContain("use `exec` instead");
    },
  );

  it("preserves exec discovery for code-mode-only threads", () => {
    const instructions = buildDeveloperInstructions(createParams(), {
      nativeCodeModeOnlyEnabled: true,
    });

    expect(instructions).toContain(
      "Deferred tools may be absent from the direct tool list. Use `tool_search` when directly callable. On code-mode-only models, use `exec` instead: filter `ALL_TOOLS` by name and description, then call the matching entry through `tools`.",
    );
    expect(instructions).not.toContain("Do not use `exec`");
  });
});

describe("buildDeveloperInstructions delegation guidance", () => {
  it.each(["prefer", "suggest"] as const)(
    "routes new helpers by tool requirements in %s mode without moving existing children",
    (delegationMode) => {
      const instructions = buildDeveloperInstructions(
        createParams({ config: { agents: { defaults: { subagents: { delegationMode } } } } }),
        {
          dynamicTools: [
            {
              type: "namespace",
              name: "openclaw",
              description: "OpenClaw tools",
              tools: [
                {
                  type: "function",
                  name: "sessions_spawn",
                  description: "Spawn a helper",
                  inputSchema: {
                    type: "object",
                    properties: { runtime: { type: "string", enum: ["subagent", "acp"] } },
                  },
                },
                {
                  type: "function",
                  name: "sessions_create",
                  description: "Create a session",
                  inputSchema: { type: "object" },
                },
              ],
            },
          ],
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
      dynamicTools: [
        {
          type: "function",
          name: "sessions_spawn",
          description: "Spawn a worker",
          inputSchema: { type: "object", properties },
        },
      ],
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

    expect(instructions).not.toContain("Deferred tools may be absent");
    expect(instructions).not.toContain("spawn_agent");
    expect(buildDeveloperInstructions({ ...params, toolsAllow: undefined })).toContain(
      "Deferred tools may be absent",
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
            {
              type: "namespace",
              name: "openclaw",
              description: "OpenClaw tools",
              tools: [
                {
                  type: "function",
                  name: createAvailable ? "sessions_create" : "sessions",
                  description: "Session tool",
                  deferLoading,
                  inputSchema: { type: "object" },
                },
                {
                  type: "function",
                  name: "suggest_task",
                  description: "Suggest a follow-up",
                  deferLoading,
                  inputSchema: { type: "object" },
                },
              ],
            },
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

  it.each([{ name: "prompt mode none", overrides: { promptMode: "none" } }] as const)(
    "omits the policy for $name",
    ({ overrides }) => {
      expect(buildInstructions(overrides)).not.toContain("## Delegation");
    },
  );
});

describe("buildDeveloperInstructions UI presentation guidance", () => {
  const uiTools = ["screen", "show_widget", "dashboard", "portal", "message"].map(
    (name): CodexDynamicToolFunctionSpec => ({
      type: "function",
      name,
      description: `Use ${name}`,
      inputSchema: { type: "object", properties: name === "message" ? { clawhub: {} } : {} },
    }),
  );

  it.each([
    {
      name: "namespaced deferred",
      dynamicTools: [
        {
          type: "namespace",
          name: "openclaw",
          description: "OpenClaw tools",
          tools: uiTools.map((tool) => ({ ...tool, deferLoading: true })),
        },
      ],
      prefix: "openclaw.",
    },
  ] satisfies { name: string; dynamicTools: CodexDynamicToolSpec[]; prefix: string }[])(
    "explains the actual $name presentation routes",
    ({ dynamicTools, prefix }) => {
      const instructions = buildDeveloperInstructions(createParams(), { dynamicTools });

      expect(instructions).toContain("## UI Presentation");
      expect(instructions).toContain(`\`${prefix}screen(action="browser_show")\``);
      expect(instructions).toContain("Do not create or expand a dashboard to open a panel");
      for (const tool of uiTools) {
        expect(instructions).toContain(`\`${prefix}${tool.name}\``);
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
    },
  );
});

describe("buildDeveloperInstructions delivery-mode stability", () => {
  it.each([true])("keeps thread policy stable with message available=%s", (available) => {
    const dynamicTools: CodexDynamicToolSpec[] = available
      ? [
          {
            type: "function",
            name: "message",
            description: "Send messages",
            inputSchema: { type: "object" },
          },
        ]
      : [];
    const instructions = (["automatic", "message_tool_only", "automatic"] as const).map(
      (sourceReplyDeliveryMode) =>
        buildDeveloperInstructions(createParams({ sourceReplyDeliveryMode }), { dynamicTools }),
    );

    expect(instructions[1]).toBe(instructions[0]);
    expect(instructions[2]).toBe(instructions[0]);
    if (!available) {
      expect(instructions[0]).not.toContain("message(action=send)");
    }
  });
});
