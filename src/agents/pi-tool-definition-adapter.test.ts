import { describe, expect, it } from "vitest";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import { toClientToolDefinitions, toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { truncateToolNameForOpenAI } from "./tool-policy.js";

describe("pi tool definition adapter", () => {
  type TestExecute = (
    toolCallId: string,
    params: unknown,
    arg3?: unknown,
    arg4?: unknown,
    arg5?: unknown,
  ) => Promise<{ details: Record<string, unknown> }>;

  const executeTool = async (
    toolDef: {
      execute: unknown;
    },
    toolCallId: string,
    params: Record<string, unknown>,
  ) => {
    const run = toolDef.execute as TestExecute;
    return await run(toolCallId, params, undefined, undefined, undefined);
  };

  it("wraps tool errors into a tool result", async () => {
    const tool = {
      name: "boom",
      label: "Boom",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    };

    const defs = toToolDefinitions([tool]);
    const [def] = defs;
    if (!def) {
      throw new Error("Expected tool definition");
    }
    const result = await executeTool(def, "call1", {});

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    };

    const defs = toToolDefinitions([tool]);
    const [def] = defs;
    if (!def) {
      throw new Error("Expected tool definition");
    }
    const result = await executeTool(def, "call2", {});

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });

  it("uses truncated api name consistently for client tool callback and result", async () => {
    const originalName = `very_long_client_tool_name_${"x".repeat(80)}`;
    const clientTool: ClientToolDefinition = {
      type: "function",
      function: {
        name: originalName,
        description: "client tool",
        parameters: { type: "object", properties: {} },
      },
    };

    let callbackToolName = "";
    const defs = toClientToolDefinitions([clientTool], (toolName) => {
      callbackToolName = toolName;
    });

    const [def] = defs;
    if (!def) {
      throw new Error("Expected tool definition");
    }

    const expectedApiName = truncateToolNameForOpenAI(originalName);
    expect(def.name).toBe(expectedApiName);

    const result = await executeTool(def, "call3", {});

    expect(callbackToolName).toBe(expectedApiName);
    expect(result.details).toMatchObject({
      status: "pending",
      tool: expectedApiName,
    });
  });
});
