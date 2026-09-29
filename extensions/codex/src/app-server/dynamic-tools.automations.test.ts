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

function setup(options: { target?: string; registeredSpecs?: CodexDynamicToolSpec[] } = {}) {
  const target = options.target ?? "automations";
  const execute = vi.fn(async (_id: string, args: unknown) => ({
    content: [{ type: "text" as const, text: "observed" }],
    details: args,
  }));
  const tools = [
    tool("automations"),
    tool("read"),
    tool("sandbox_exec", { catalogMode: "direct-only" }),
    tool("fixture__lookup_note"),
    tool("openclaw__read"),
    tool("openclaw_direct__read"),
    tool("_probe"),
  ];
  for (const entry of tools) {
    if (entry.name === target) {
      entry.execute = execute;
    }
  }
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
      tool: target,
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

  it("leaves unknown, wrong-namespace, malformed, wildcard and non-string values unchanged", async () => {
    const { call, execute } = setup();
    const input = automationArgs([
      "openclaw__missing",
      "openclaw__sandbox_exec",
      "openclaw_direct__fixture__lookup_note",
      "openclaw___probe",
      "tools.openclaw__read",
      "*",
      7,
      null,
      { name: "openclaw__read" },
      "read",
    ]);
    await call(input);
    expect(received(execute)).toEqual(input);
  });

  it.each<JsonValue>([null, "openclaw__read", 7, { name: "openclaw__read" }])(
    "leaves a non-array allowlist for the automation validator: %j",
    async (value) => {
      const { call, execute } = setup();
      const input = automationArgs(value);
      await call(input);
      expect(received(execute)).toEqual(input);
    },
  );

  it("does not translate the same argument structure for another tool", async () => {
    const { call, execute } = setup({ target: "read" });
    const input = automationArgs([
      "openclaw__fixture__lookup_note",
      "openclaw_direct__sandbox_exec",
    ]);
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

it.each<{
  label: string;
  input: JsonValue;
  expected: JsonValue;
}>([
  {
    label: "flat job",
    input: { action: "add", payload: { toolsAllow: ["openclaw__fixture__lookup_note"] } },
    expected: { action: "add", payload: { toolsAllow: ["fixture__lookup_note"] } },
  },
  {
    label: "empty job with flat fields",
    input: { action: "add", job: {}, toolsAllow: ["openclaw__fixture__lookup_note"] },
    expected: { action: "add", job: {}, toolsAllow: ["fixture__lookup_note"] },
  },
  {
    label: "flat payload in a job",
    input: { action: "add", job: { toolsAllow: ["openclaw__fixture__lookup_note"] } },
    expected: { action: "add", job: { toolsAllow: ["fixture__lookup_note"] } },
  },
  {
    label: "flat update",
    input: { action: "update", jobId: "job-1", toolsAllow: ["openclaw__fixture__lookup_note"] },
    expected: { action: "update", jobId: "job-1", toolsAllow: ["fixture__lookup_note"] },
  },
  {
    label: "data-wrapped job",
    input: {
      action: "add",
      job: { data: { payload: { toolsAllow: ["openclaw__fixture__lookup_note"] } } },
    },
    expected: {
      action: "add",
      job: { data: { payload: { toolsAllow: ["fixture__lookup_note"] } } },
    },
  },
  {
    label: "job-wrapped patch",
    input: { action: "update", job: { job: { toolsAllow: ["openclaw__fixture__lookup_note"] } } },
    expected: { action: "update", job: { job: { toolsAllow: ["fixture__lookup_note"] } } },
  },
  {
    label: "recoverable padded field",
    input: { action: "add", job: { "toolsAllow ": ["openclaw__fixture__lookup_note"] } },
    expected: { action: "add", job: { "toolsAllow ": ["fixture__lookup_note"] } },
  },
  {
    label: "recoverable concatenated payload",
    input: { action: "add", namePayload: { toolsAllow: ["openclaw__fixture__lookup_note"] } },
    expected: { action: "add", namePayload: { toolsAllow: ["fixture__lookup_note"] } },
  },
])(
  "resolves references without rewriting the supported $label shape",
  async ({ input, expected }) => {
    const { call, execute } = setup();
    const original = structuredClone(input);
    await call(input);
    expect(received(execute)).toEqual(expected);
    expect(input).toEqual(original);
  },
);
