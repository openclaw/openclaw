import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
} from "./protocol.js";
import {
  buildCodexConversationTurnInstructions,
  buildDeveloperInstructions,
  splitCodexExtraSystemPrompt,
} from "./thread-prompt.js";

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
  it.each([{ requireWorkspaceOnly: true }] as const)(
    "does not advertise native helpers for restricted runs (%j)",
    (overrides) => {
      const instructions = buildInstructions(overrides);
      expect(instructions).not.toContain("spawn_agent");
      expect(instructions).not.toContain("wait_agent");
      expect(instructions).toContain("sessions_spawn");
    },
  );

  it("omits discovery and delegation guidance for an explicitly empty tool allowlist", () => {
    const params = createParams({ toolsAllow: [] });
    const instructions = buildDeveloperInstructions(params);

    expect(instructions).not.toContain("Deferred tools may be absent");
    expect(instructions).not.toContain("spawn_agent");
    expect(buildDeveloperInstructions({ ...params, toolsAllow: undefined })).toContain(
      "Deferred tools may be absent",
    );
  });

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

describe("Codex conversation context handoff", () => {
  it("moves only the annotated conversation section and preserves policy on both sides", () => {
    const text = "Current owner context.";
    const prefix = "Persistent prelude.\n\n";
    const params = createParams({
      extraSystemPrompt: prefix + text + "\n\nPersistent trailing policy.",
      extraSystemPromptTurnContext: { start: prefix.length, text },
    });
    expect(splitCodexExtraSystemPrompt(params)).toEqual({
      persistent: "Persistent prelude.\n\nPersistent trailing policy.",
      turn: text,
    });
    const withRelay = buildDeveloperInstructions(params, { omitConversationTurnContext: true });
    expect(withRelay).toContain("Persistent prelude.");
    expect(withRelay).toContain("Persistent trailing policy.");
    expect(withRelay).not.toContain(text);
    expect(buildDeveloperInstructions(params)).toContain(text);
    const next = {
      ...params,
      extraSystemPrompt: prefix + "Private completion.\n\nPersistent trailing policy.",
      extraSystemPromptTurnContext: { start: prefix.length, text: "Private completion." },
    };
    expect(buildDeveloperInstructions(next, { omitConversationTurnContext: true })).toBe(withRelay);
    const handoff = buildCodexConversationTurnInstructions(next, []);
    expect(handoff).toContain("Private completion.");
    expect(handoff).not.toContain(text);
    expect(handoff).toContain("none");
  });

  it.each([
    { start: -1, text: "context" },
    { start: 0.5, text: "context" },
    { start: 0, text: "mismatch" },
    { start: 0, text: "context" },
    { start: 1, text: "ontext" },
  ])("keeps malformed or non-section annotations in immutable policy (%j)", (annotation) => {
    const params = createParams({
      extraSystemPrompt: "context-not-a-whole-section",
      extraSystemPromptTurnContext: annotation,
    });
    expect(splitCodexExtraSystemPrompt(params)).toEqual({
      persistent: params.extraSystemPrompt,
      turn: undefined,
    });
    expect(buildDeveloperInstructions(params, { omitConversationTurnContext: true })).toContain(
      params.extraSystemPrompt,
    );
  });
});
