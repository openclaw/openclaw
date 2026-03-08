import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { toClientToolDefinitions, toToolDefinitions } from "./pi-tool-definition-adapter.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

async function executeThrowingTool(name: string, callId: string) {
  const tool = {
    name,
    label: name === "bash" ? "Bash" : "Boom",
    description: "throws",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("nope");
    },
  } satisfies AgentTool;

  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

async function executeTool(tool: AgentTool, callId: string) {
  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const result = await executeThrowingTool("boom", "call1");

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const result = await executeThrowingTool("bash", "call2");

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });

  it("coerces details-only tool results to include content", async () => {
    const tool = {
      name: "memory_query",
      label: "Memory Query",
      description: "returns details only",
      parameters: Type.Object({}),
      execute: (async () => ({
        details: {
          hits: [{ id: "a1", score: 0.9 }],
        },
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call3");
    expect(result.details).toEqual({
      hits: [{ id: "a1", score: 0.9 }],
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text?: string }).text).toContain('"hits"');
  });

  it("coerces non-standard object results to include content", async () => {
    const tool = {
      name: "memory_query_raw",
      label: "Memory Query Raw",
      description: "returns plain object",
      parameters: Type.Object({}),
      execute: (async () => ({
        count: 2,
        ids: ["m1", "m2"],
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call4");
    expect(result.details).toEqual({
      count: 2,
      ids: ["m1", "m2"],
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text?: string }).text).toContain('"count"');
  });

  it("parses stringified tool args from glm-5 (internal tools)", async () => {
    let receivedParams: unknown;
    const tool = {
      name: "test_tool",
      label: "Test Tool",
      description: "captures params",
      parameters: Type.Object({ key: Type.String() }),
      execute: async (_callId: string, params: unknown) => {
        receivedParams = params;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    const def = defs[0];
    // Simulate GLM-5: the SDK passes args as a JSON string instead of an object
    const stringifiedArgs = JSON.stringify({ key: "value" });
    await def.execute("call_glm5", stringifiedArgs, undefined, undefined, extensionContext);
    expect(receivedParams).toEqual({ key: "value" });
  });

  it("parses stringified tool args from glm-5 (client tools)", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const clientTools = [
      {
        type: "function" as const,
        function: {
          name: "get_weather",
          description: "gets weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ];

    const defs = toClientToolDefinitions(clientTools, (name, params) => {
      capturedParams = params;
    });
    const def = defs[0];
    // Simulate GLM-5: args arrive as a JSON string
    const stringifiedArgs = JSON.stringify({ city: "Seattle" });
    await def.execute("call_glm5_client", stringifiedArgs, undefined, undefined, extensionContext);
    expect(capturedParams).toEqual({ city: "Seattle" });
  });
});
