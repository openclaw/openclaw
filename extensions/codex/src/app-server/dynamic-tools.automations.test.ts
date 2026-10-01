import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexDynamicToolSpec, JsonValue } from "./protocol.js";

function tool(name: string, overrides: Partial<AnyAgentTool> = {}): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Test ${name}`,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => ({ content: [], details: {} }),
    ...overrides,
  };
}

function setup(options: { registeredSpecs?: CodexDynamicToolSpec[] } = {}) {
  const execute = vi.fn(async (_id: string, args: unknown) => ({
    content: [{ type: "text" as const, text: "observed" }],
    details: args,
  }));
  const tools = [
    tool("automations", { execute }),
    tool("read"),
    tool("sandbox_exec", { catalogMode: "direct-only" }),
    tool("fixture__lookup_note"),
    tool("openclaw__read"),
    tool("openclaw_direct__read"),
    tool("_probe"),
  ];
  const bridge = createCodexDynamicToolBridge({
    tools,
    registeredSpecs: options.registeredSpecs,
    signal: new AbortController().signal,
    loading: "searchable",
  });
  async function call(args: JsonValue) {
    return bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: "openclaw",
      tool: "automations",
      arguments: args,
    });
  }
  return { call, execute };
}

function automationArgs(toolsAllow: JsonValue): JsonValue {
  return {
    action: "add",
    job: {
      name: "reminder",
      payload: { kind: "agentTurn", message: "Read the note.", toolsAllow },
    },
  };
}

function received(execute: ReturnType<typeof setup>["execute"]) {
  expect(execute).toHaveBeenCalledTimes(1);
  return execute.mock.calls[0]?.[1];
}

describe("Codex automation tool references", () => {
  it("resolves ordinary, direct-only and server references from the current catalog", async () => {
    const { call, execute } = setup();
    const input = automationArgs([
      "openclaw__fixture__lookup_note",
      "openclaw_direct__sandbox_exec",
      "openclaw_probe",
    ]);
    const original = structuredClone(input);
    expect((await call(input)).success).toBe(true);
    expect(received(execute)).toEqual(
      automationArgs(["fixture__lookup_note", "sandbox_exec", "_probe"]),
    );
    expect(input).toEqual(original);
  });

  it("keeps exact canonical names before resolving a colliding qualified reference", async () => {
    const { call, execute } = setup();
    await call(
      automationArgs(["openclaw__read", "openclaw_direct__read", "openclaw__openclaw__read"]),
    );
    expect(received(execute)).toEqual(
      automationArgs(["openclaw__read", "openclaw_direct__read", "openclaw__read"]),
    );
  });

  it("leaves unknown, wrong-namespace and non-string values unchanged", async () => {
    const { call, execute } = setup();
    const input = automationArgs([
      "openclaw__missing",
      "openclaw__sandbox_exec",
      "openclaw_direct__fixture__lookup_note",
      7,
      "read",
    ]);
    await call(input);
    expect(received(execute)).toEqual(input);
  });

  it("leaves a non-array allowlist for the automation validator", async () => {
    const { call, execute } = setup();
    const input = automationArgs(null);
    await call(input);
    expect(received(execute)).toEqual(input);
  });

  it("uses inherited native declarations instead of guessing namespaces from executable metadata", async () => {
    const { call, execute } = setup({
      registeredSpecs: [
        {
          type: "namespace",
          name: "openclaw_direct",
          description: "Inherited declaration",
          tools: ["automations", "read"].map((name) => ({
            type: "function",
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        },
      ],
    });
    await call(automationArgs(["openclaw_direct__read", "openclaw__read"]));
    expect(received(execute)).toEqual(automationArgs(["read", "openclaw__read"]));
  });
});

it.each<{ label: string; wrap: (toolsAllow: string[]) => JsonValue }>([
  { label: "flat job", wrap: (toolsAllow) => ({ action: "add", payload: { toolsAllow } }) },
  {
    label: "empty job with flat fields",
    wrap: (toolsAllow) => ({ action: "add", job: {}, toolsAllow }),
  },
  {
    label: "flat payload in a job",
    wrap: (toolsAllow) => ({ action: "add", job: { toolsAllow } }),
  },
  {
    label: "data-wrapped job",
    wrap: (toolsAllow) => ({ action: "add", job: { data: { payload: { toolsAllow } } } }),
  },
  {
    label: "job-wrapped patch",
    wrap: (toolsAllow) => ({ action: "update", job: { job: { toolsAllow } } }),
  },
  {
    label: "recoverable padded field",
    wrap: (toolsAllow) => ({ action: "add", job: { "toolsAllow ": toolsAllow } }),
  },
  {
    label: "recoverable concatenated payload",
    wrap: (toolsAllow) => ({ action: "add", namePayload: { toolsAllow } }),
  },
])("resolves references without rewriting the supported $label shape", async ({ wrap }) => {
  const { call, execute } = setup();
  const input = wrap(["openclaw__fixture__lookup_note"]);
  const original = structuredClone(input);
  await call(input);
  expect(received(execute)).toEqual(wrap(["fixture__lookup_note"]));
  expect(input).toEqual(original);
});
