import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import {
  toToolDefinitions,
  toClientToolDefinitions,
  CLIENT_TOOL_COLLISION_PREFIX,
} from "./pi-tool-definition-adapter.js";

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
});

describe("toClientToolDefinitions — collision detection", () => {
  function makeClientTool(name: string): ClientToolDefinition {
    return {
      type: "function",
      function: {
        name,
        description: `caller-provided ${name}`,
        parameters: { type: "object", properties: {} },
      },
    };
  }

  it("does not rename tools when no built-in names are provided", () => {
    const tools = [makeClientTool("crpc_respond")];
    const result = toClientToolDefinitions(tools);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe("crpc_respond");
    expect(result.renamedTools.size).toBe(0);
  });

  it("does not rename tools when names do not collide", () => {
    const tools = [makeClientTool("crpc_respond")];
    const builtInNames = new Set(["read", "write", "exec"]);
    const result = toClientToolDefinitions(tools, undefined, undefined, builtInNames);
    expect(result.tools[0]?.name).toBe("crpc_respond");
    expect(result.renamedTools.size).toBe(0);
  });

  it("prefixes client tools that collide with built-in names", () => {
    const tools = [makeClientTool("read"), makeClientTool("exec")];
    const builtInNames = new Set(["read", "write", "exec", "edit"]);
    const result = toClientToolDefinitions(tools, undefined, undefined, builtInNames);

    expect(result.tools).toHaveLength(2);
    expect(result.tools[0]?.name).toBe(`${CLIENT_TOOL_COLLISION_PREFIX}read`);
    expect(result.tools[1]?.name).toBe(`${CLIENT_TOOL_COLLISION_PREFIX}exec`);
    expect(result.renamedTools.size).toBe(2);
    expect(result.renamedTools.get(`${CLIENT_TOOL_COLLISION_PREFIX}read`)).toBe("read");
    expect(result.renamedTools.get(`${CLIENT_TOOL_COLLISION_PREFIX}exec`)).toBe("exec");
  });

  it("only prefixes colliding tools, leaves others intact", () => {
    const tools = [makeClientTool("read"), makeClientTool("crpc_respond")];
    const builtInNames = new Set(["read", "write", "exec"]);
    const result = toClientToolDefinitions(tools, undefined, undefined, builtInNames);

    expect(result.tools[0]?.name).toBe(`${CLIENT_TOOL_COLLISION_PREFIX}read`);
    expect(result.tools[1]?.name).toBe("crpc_respond");
    expect(result.renamedTools.size).toBe(1);
  });

  it("passes original name to onClientToolCall callback (collision roundtrip)", async () => {
    const tools = [makeClientTool("read")];
    const builtInNames = new Set(["read"]);
    let callbackName: string | undefined;
    let callbackParams: Record<string, unknown> | undefined;
    const result = toClientToolDefinitions(
      tools,
      (name, params) => {
        callbackName = name;
        callbackParams = params;
      },
      undefined,
      builtInNames,
    );

    // The tool definition uses the prefixed name (what the LLM sees)
    const tool = result.tools[0];
    expect(tool?.name).toBe(`${CLIENT_TOOL_COLLISION_PREFIX}read`);

    // Execute the tool — simulates the LLM calling "user_read"
    if (tool) {
      await tool.execute(
        "call1",
        { path: "/etc/hostname" },
        undefined,
        undefined,
        extensionContext,
      );
    }

    // The callback receives the ORIGINAL name — this is what goes into function_call.name
    expect(callbackName).toBe("read");
    expect(callbackParams).toEqual({ path: "/etc/hostname" });
  });

  it("pending result uses original name (not prefixed)", async () => {
    const tools = [makeClientTool("exec")];
    const builtInNames = new Set(["exec"]);
    const result = toClientToolDefinitions(tools, undefined, undefined, builtInNames);
    const tool = result.tools[0];

    // The tool definition is prefixed
    expect(tool?.name).toBe(`${CLIENT_TOOL_COLLISION_PREFIX}exec`);

    // The pending result contains the original name
    const execResult = await tool.execute(
      "call2",
      { command: "echo hello" },
      undefined,
      undefined,
      extensionContext,
    );
    const details = execResult.details as { tool?: string; status?: string };
    expect(details?.tool).toBe("exec");
    expect(details?.status).toBe("pending");
  });

  it("does not prefix tool already using the collision prefix", () => {
    // Edge case: caller provides a tool named "user_read" (already prefixed)
    const tools = [makeClientTool(`${CLIENT_TOOL_COLLISION_PREFIX}read`)];
    const builtInNames = new Set(["read"]);
    const result = toClientToolDefinitions(tools, undefined, undefined, builtInNames);

    // "user_read" doesn't collide with "read" directly, so no double-prefixing
    expect(result.tools[0]?.name).toBe(`${CLIENT_TOOL_COLLISION_PREFIX}read`);
    expect(result.renamedTools.size).toBe(0);
  });

  it("preserves description and parameters through rename", () => {
    const tools: ClientToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "read",
          description: "Custom caller read",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ];
    const builtInNames = new Set(["read"]);
    const result = toClientToolDefinitions(tools, undefined, undefined, builtInNames);
    const tool = result.tools[0];

    expect(tool?.name).toBe(`${CLIENT_TOOL_COLLISION_PREFIX}read`);
    expect(tool?.description).toBe("Custom caller read");
    expect(tool?.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  it("handles multiple collisions with correct mappings", () => {
    const tools = [
      makeClientTool("read"),
      makeClientTool("write"),
      makeClientTool("exec"),
      makeClientTool("crpc_respond"),
    ];
    const builtInNames = new Set(["read", "write", "edit", "exec", "process"]);
    const result = toClientToolDefinitions(tools, undefined, undefined, builtInNames);

    // Three collisions, one non-collision
    expect(result.renamedTools.size).toBe(3);
    expect(result.tools.map((t) => t.name)).toEqual([
      `${CLIENT_TOOL_COLLISION_PREFIX}read`,
      `${CLIENT_TOOL_COLLISION_PREFIX}write`,
      `${CLIENT_TOOL_COLLISION_PREFIX}exec`,
      "crpc_respond",
    ]);

    // Verify reverse mapping
    expect(result.renamedTools.get(`${CLIENT_TOOL_COLLISION_PREFIX}read`)).toBe("read");
    expect(result.renamedTools.get(`${CLIENT_TOOL_COLLISION_PREFIX}write`)).toBe("write");
    expect(result.renamedTools.get(`${CLIENT_TOOL_COLLISION_PREFIX}exec`)).toBe("exec");
    expect(result.renamedTools.has("crpc_respond")).toBe(false);
  });

  it("no collision: built-in names set is empty", () => {
    const tools = [makeClientTool("read"), makeClientTool("exec")];
    const builtInNames = new Set<string>();
    const result = toClientToolDefinitions(tools, undefined, undefined, builtInNames);

    expect(result.tools[0]?.name).toBe("read");
    expect(result.tools[1]?.name).toBe("exec");
    expect(result.renamedTools.size).toBe(0);
  });
});
