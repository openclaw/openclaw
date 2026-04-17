import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../tools/common.js";
import { buildOpenClawMcpServer } from "./native-tools-adapter.js";

// Construct a minimal AnyAgentTool that satisfies the pi-agent-core
// shape our adapter calls into. The tests below don't exercise the
// pi-ai runtime itself — they verify that `buildOpenClawMcpServer()`
// wraps OpenClaw tools in a shape the Agent SDK's MCP server accepts.
function makeTool(params: {
  name: string;
  description?: string;
  parameters?: ReturnType<typeof Type.Object>;
  execute?: AnyAgentTool["execute"];
  prepareArguments?: AnyAgentTool["prepareArguments"];
}): AnyAgentTool {
  const defaultExecute: AnyAgentTool["execute"] = async () => ({
    content: [{ type: "text", text: "ok" }],
    details: undefined,
  });
  return {
    name: params.name,
    description: params.description ?? `test tool ${params.name}`,
    label: params.name,
    parameters: params.parameters ?? Type.Object({ q: Type.String() }),
    execute: params.execute ?? defaultExecute,
    prepareArguments: params.prepareArguments,
  } as unknown as AnyAgentTool;
}

describe("buildOpenClawMcpServer", () => {
  it("registers tools on an in-process MCP server and returns its config", async () => {
    const tools = [makeTool({ name: "alpha" }), makeTool({ name: "beta" })];
    const result = await buildOpenClawMcpServer({ tools, runId: "r1" });

    expect(result.name).toBe("openclaw");
    expect(result.registered).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.config).toBeDefined();
    expect(result.config.type).toBe("sdk");
    expect(result.config.instance).toBeDefined();
  });

  it("honors a custom serverName", async () => {
    const result = await buildOpenClawMcpServer({
      tools: [makeTool({ name: "x" })],
      serverName: "custom-name",
    });
    expect(result.name).toBe("custom-name");
  });

  it("returns an empty-tool server when the input array is empty", async () => {
    const result = await buildOpenClawMcpServer({ tools: [] });
    expect(result.registered).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe("buildOpenClawMcpServer — handler bridging", () => {
  it("calls the OpenClaw tool's execute() when the SDK invokes the MCP tool", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "bridged" }],
      details: undefined,
    }));
    const tool = makeTool({ name: "bridge-test", execute });
    const result = await buildOpenClawMcpServer({ tools: [tool] });

    // Pull the registered tool off the MCP server and invoke its handler
    // directly. We go through the server instance because that's the
    // layer the Agent SDK will ultimately route calls through.
    type McpHandler = (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    }>;
    const registered = (result.config.instance as unknown as {
      _registeredTools: Record<string, { handler: McpHandler }>;
    })._registeredTools;
    const entry = registered["bridge-test"];
    expect(entry).toBeDefined();

    const toolResult = await entry.handler({ q: "hi" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolResult.content).toEqual([{ type: "text", text: "bridged" }]);
    expect(toolResult.isError).toBe(false);
  });

  it("surfaces thrown errors from execute() as MCP error results", async () => {
    const tool = makeTool({
      name: "throws",
      execute: async () => {
        throw new Error("boom");
      },
    });
    const result = await buildOpenClawMcpServer({ tools: [tool] });
    type McpHandler = (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    }>;
    const entry = (result.config.instance as unknown as {
      _registeredTools: Record<string, { handler: McpHandler }>;
    })._registeredTools["throws"];
    const toolResult = await entry.handler({ q: "hi" });
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]?.text).toContain("boom");
  });

  it("passes prepareArguments-transformed params into execute()", async () => {
    type ExecuteFn = (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
    const execute = vi.fn<ExecuteFn>(async () => ({
      content: [{ type: "text", text: "ok" }],
      details: undefined,
    }));
    const tool = makeTool({
      name: "prepared",
      parameters: Type.Object({ raw: Type.String() }),
      prepareArguments: (args) => {
        const a = args as { raw?: string };
        return { raw: (a.raw ?? "").toUpperCase() } as never;
      },
      execute: execute as unknown as AnyAgentTool["execute"],
    });
    const result = await buildOpenClawMcpServer({ tools: [tool] });
    const entry = (result.config.instance as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    })._registeredTools["prepared"];
    await entry.handler({ raw: "hello" });
    expect(execute).toHaveBeenCalled();
    expect(execute.mock.calls[0]?.[1]).toEqual({ raw: "HELLO" });
  });

  it("translates pi-ai image content blocks into MCP image blocks", async () => {
    const tool = makeTool({
      name: "with-image",
      execute: async () => ({
        content: [
          { type: "text", text: "here you go" },
          { type: "image", data: "b64data", mimeType: "image/png" },
        ],
        details: undefined,
      }),
    });
    const result = await buildOpenClawMcpServer({ tools: [tool] });
    type McpHandler = (args: unknown) => Promise<{
      content: Array<Record<string, unknown>>;
      isError: boolean;
    }>;
    const entry = (result.config.instance as unknown as {
      _registeredTools: Record<string, { handler: McpHandler }>;
    })._registeredTools["with-image"];
    const toolResult = await entry.handler({ q: "?" });
    expect(toolResult.content).toHaveLength(2);
    expect(toolResult.content[0]).toMatchObject({ type: "text", text: "here you go" });
    expect(toolResult.content[1]).toMatchObject({
      type: "image",
      data: "b64data",
      mimeType: "image/png",
    });
  });
});
