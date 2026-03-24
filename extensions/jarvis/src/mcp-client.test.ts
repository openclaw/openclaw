import { describe, expect, it } from "vitest";
import { createJsonRpcRequest, parseJsonRpcResponse, type JsonRpcResponse } from "./mcp-client.js";

describe("JSON-RPC helpers", () => {
  it("creates a well-formed JSON-RPC 2.0 request", () => {
    const req = createJsonRpcRequest("tools/list", {}, 1);
    expect(req).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
  });

  it("parses a valid JSON-RPC response", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    });
    const parsed = parseJsonRpcResponse(raw);
    expect(parsed.id).toBe(1);
    expect((parsed as { result: unknown }).result).toEqual({ tools: [] });
  });

  it("parses a JSON-RPC error response", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "Invalid Request" },
    });
    const parsed = parseJsonRpcResponse(raw);
    expect((parsed as { error: { code: number } }).error.code).toBe(-32600);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseJsonRpcResponse("not json")).toThrow();
  });
});

describe("JarvisMcpClient", () => {
  it("exports a class with start/stop/callTool/listTools", async () => {
    const { JarvisMcpClient } = await import("./mcp-client.js");
    expect(JarvisMcpClient).toBeDefined();
    expect(typeof JarvisMcpClient.prototype.start).toBe("function");
    expect(typeof JarvisMcpClient.prototype.stop).toBe("function");
    expect(typeof JarvisMcpClient.prototype.callTool).toBe("function");
    expect(typeof JarvisMcpClient.prototype.listTools).toBe("function");
  });
});
