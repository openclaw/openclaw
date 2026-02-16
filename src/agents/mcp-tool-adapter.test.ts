import { describe, expect, it, vi } from "vitest";
import { toMcpToolDefinitions } from "./mcp-tool-adapter.js";

describe("mcp tool adapter", () => {
  it("adapts MCP tools and passes params through", async () => {
    const call = vi.fn(async (params: Record<string, unknown>) => ({ ok: true, params }));
    const defs = toMcpToolDefinitions([
      {
        name: "lean_check",
        mcpName: "lean_check",
        serverName: "lean-lsp",
        description: "Check Lean source",
        inputSchema: {
          type: "object",
          properties: {
            source: { type: "string" },
          },
        },
        call,
      },
    ]);

    const result = await defs[0].execute("call1", { source: "#check Nat" }, undefined, undefined);

    expect(call).toHaveBeenCalledWith(
      {
        source: "#check Nat",
      },
      {
        timeoutMs: undefined,
        signal: undefined,
      },
    );
    expect(result.details).toMatchObject({
      ok: true,
      params: { source: "#check Nat" },
    });
  });

  it("wraps execution failures into a structured error tool result", async () => {
    const defs = toMcpToolDefinitions([
      {
        name: "lean_check",
        mcpName: "lean_check",
        serverName: "lean-lsp",
        inputSchema: undefined,
        call: async () => {
          throw new Error("server down");
        },
      },
    ]);

    const result = await defs[0].execute("call2", { source: "#check Nat" }, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "lean_check",
      server: "lean-lsp",
      error: "server down",
    });
  });
});
