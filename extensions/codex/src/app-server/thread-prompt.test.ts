import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolSpec,
} from "./protocol.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";

const delegationTools: CodexDynamicToolSpec[] = [
  {
    type: "function",
    name: "sessions_spawn",
    description: "Spawn an OpenClaw session",
    inputSchema: { type: "object" },
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

describe("buildDeveloperInstructions Git co-authors", () => {
  it.each([{}, { promptMode: "minimal" }, { promptMode: "none" }, { disableTools: true }] as const)(
    "includes exact session credit before extra instructions (%j)",
    (overrides) => {
      const params = createParams({
        agentId: "work",
        sessionKey: "agent:work:shared",
        gitCoauthorPrompt:
          "Git co-authors: add these exact trailers to every commit you make from this session.\n" +
          "Co-authored-by: ada <20+ada@users.noreply.github.com>",
        extraSystemPrompt: "Extra system instructions.",
        ...overrides,
      });
      const instructions = buildDeveloperInstructions(params);

      expect(instructions.split("\n\n").slice(-2)).toEqual([
        "Git co-authors: add these exact trailers to every commit you make from this session.\n" +
          "Co-authored-by: ada <20+ada@users.noreply.github.com>",
        "Extra system instructions.",
      ]);
    },
  );

  it("omits the section when there is nobody to credit", () => {
    expect(buildInstructions()).not.toContain("Git co-authors:");
  });
});

describe("buildDeveloperInstructions credential routing", () => {
  const tool = (name: string) => ({
    type: "function" as const,
    name,
    description: name,
    inputSchema: { type: "object" },
  });
  const cases: {
    name: string;
    dynamicTools: CodexDynamicToolSpec[];
    disableTools?: boolean;
    terminalSetup: boolean;
  }[] = [
    { name: "no controls", dynamicTools: [], terminalSetup: true },
    { name: "openclaw", dynamicTools: [tool("openclaw")], terminalSetup: false },
    { name: "gateway", dynamicTools: [tool("gateway")], terminalSetup: false },
    {
      name: "both controls",
      dynamicTools: [tool("openclaw"), tool("gateway")],
      terminalSetup: false,
    },
    {
      name: "disabled controls",
      dynamicTools: [tool("openclaw"), tool("gateway")],
      disableTools: true,
      terminalSetup: true,
    },
    {
      name: "deferred gateway",
      dynamicTools: [{ ...tool("gateway"), deferLoading: true }],
      terminalSetup: false,
    },
    {
      name: "namespaced control",
      dynamicTools: [
        {
          type: "namespace",
          name: "openclaw_direct",
          description: "Tools",
          tools: [tool("openclaw")],
        },
      ],
      terminalSetup: false,
    },
    {
      name: "namespace name without a control",
      dynamicTools: [
        { type: "namespace", name: "openclaw", description: "Tools", tools: [tool("message")] },
      ],
      terminalSetup: true,
    },
  ];

  it.each(cases)("routes setup with $name", ({ dynamicTools, disableTools, terminalSetup }) => {
    const instructions = buildDeveloperInstructions(createParams({ disableTools }), {
      dynamicTools,
    });

    expect(instructions.includes("openclaw channels add <channel>")).toBe(terminalSetup);
    expect(instructions.includes("openclaw configure")).toBe(terminalSetup);
    expect(instructions).toContain("only to the requesting user in private");
    expect(instructions).toContain("then acknowledge in the group without them");
  });
});

describe("buildDeveloperInstructions delegation guidance", () => {
  it("shares the visible-session delegation policy with a canonical main session", () => {
    const instructions = buildInstructions();

    expect(instructions).toContain("## Delegation");
    expect(instructions).toContain("delegate via native `spawn_agent`");
    expect(instructions).toContain("spawn `sessions_spawn` with `visible=true`");
    expect(instructions).toContain("Announcing spawns notify when the run ends");
    expect(instructions).toContain("Collectors require explicit result collection instead.");
    expect(instructions.indexOf("## Delegation")).toBeGreaterThan(
      instructions.indexOf("When a native child's result belongs in a later turn"),
    );
  });

  it("omits the policy outside the canonical main session", () => {
    expect(buildInstructions({ sessionKey: "agent:main:slack:channel:C01234567" })).not.toContain(
      "## Delegation",
    );
  });

  it("honors an explicit suggest mode in the canonical main session", () => {
    expect(
      buildInstructions({
        config: { agents: { defaults: { subagents: { delegationMode: "suggest" } } } },
      }),
    ).not.toContain("## Delegation");
  });

  it.each([
    { name: "report-only delegation", overrides: { delegationCapability: "report_only" } },
    { name: "disabled tools", overrides: { disableTools: true } },
    // Subagent runs must not be told to delegate again; the native runtime
    // suppresses the same section for minimal/none prompt modes.
    { name: "minimal subagent prompt mode", overrides: { promptMode: "minimal" } },
    { name: "prompt mode none", overrides: { promptMode: "none" } },
  ] as const)("omits the policy for $name", ({ overrides }) => {
    expect(buildInstructions(overrides)).not.toContain("## Delegation");
  });
});

describe("buildDeveloperInstructions UI presentation guidance", () => {
  const uiTools = ["show_widget", "dashboard", "portal"].map(
    (name) =>
      ({
        type: "function",
        name,
        description: `Use ${name}`,
        inputSchema: { type: "object" },
      }) satisfies CodexDynamicToolSpec,
  );

  it.each([
    { name: "direct", dynamicTools: uiTools, prefix: "" },
    {
      name: "deferred",
      dynamicTools: uiTools.map((tool) => ({ ...tool, deferLoading: true })),
      prefix: "",
    },
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
      for (const tool of uiTools) {
        expect(instructions).toContain(`\`${prefix}${tool.name}\``);
      }
      expect(instructions).toContain("pin=true");
      expect(instructions).toContain("publicUrl");
      expect(instructions).toContain("result.presentation");
      expect(instructions).toContain("inline support varies by surface");
    },
  );

  it("distinguishes unavailable custom authoring from dashboard and portal support", () => {
    const instructions = buildDeveloperInstructions(createParams(), {
      dynamicTools: uiTools.filter((tool) => tool.name !== "show_widget"),
    });

    expect(instructions).toContain("`dashboard`");
    expect(instructions).toContain("`portal`");
    expect(instructions).toContain(
      "Custom authoring is unavailable this turn, not unsupported by dashboards.",
    );
    expect(instructions).not.toContain("`show_widget`");
  });

  it.each([
    { name: "absent", dynamicTools: [], overrides: {} },
    { name: "unsupplied", dynamicTools: undefined, overrides: {} },
    { name: "disabled", dynamicTools: uiTools, overrides: { disableTools: true } },
    { name: "minimal", dynamicTools: uiTools, overrides: { promptMode: "minimal" } },
    { name: "none", dynamicTools: uiTools, overrides: { promptMode: "none" } },
  ] satisfies {
    name: string;
    dynamicTools: CodexDynamicToolSpec[] | undefined;
    overrides: Partial<EmbeddedRunAttemptParams>;
  }[])("omits presentation guidance when $name", ({ dynamicTools, overrides }) => {
    const instructions = buildDeveloperInstructions(createParams(overrides), { dynamicTools });

    expect(instructions).not.toContain("## UI Presentation");
  });
});

describe("buildDeveloperInstructions delivery-mode stability", () => {
  it.each([false, true])("keeps thread policy stable with message available=%s", (available) => {
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
