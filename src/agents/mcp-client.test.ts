import { describe, expect, it } from "vitest";
import { initMcpRuntime } from "./mcp-client.js";

const MOCK_MCP_SERVER_SCRIPT = [
  'process.stdin.setEncoding("utf8");',
  'let buffer = "";',
  'const send = (payload) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");',
  'process.stdin.on("data", (chunk) => {',
  '  buffer += String(chunk);',
  '  let newline = buffer.indexOf("\\n");',
  '  while (newline >= 0) {',
  '    const raw = buffer.slice(0, newline).trim();',
  '    buffer = buffer.slice(newline + 1);',
  '    newline = buffer.indexOf("\\n");',
  '    if (!raw) continue;',
  '    const msg = JSON.parse(raw);',
  '    if (msg.method === "initialize") {',
  '      send({ id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } } });',
  '      continue;',
  '    }',
  '    if (msg.method === "tools/list") {',
  '      send({ id: msg.id, result: { tools: [{ name: "ping", description: "Ping tool", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });',
  '      continue;',
  '    }',
  '    if (msg.method === "tools/call") {',
  '      send({ id: msg.id, result: { ok: true, tool: msg.params?.name, args: msg.params?.arguments ?? {} } });',
  '      continue;',
  '    }',
  '    if (msg.method === "notifications/initialized") {',
  '      continue;',
  '    }',
  '    send({ id: msg.id, error: { code: -32601, message: "method not found" } });',
  '  }',
  '});',
].join("\n");

function mockServerConfig(name: string) {
  return {
    name,
    type: "stdio",
    command: process.execPath,
    args: ["-e", MOCK_MCP_SERVER_SCRIPT],
  } as const;
}

describe("mcp client runtime", () => {
  it("loads stdio MCP tools and calls them", async () => {
    const runtime = await initMcpRuntime({
      mcpServers: [mockServerConfig("mock")],
    });

    try {
      expect(runtime.tools).toHaveLength(1);
      expect(runtime.tools[0].name).toBe("ping");

      const result = await runtime.tools[0].call({ text: "hello" });
      expect(result).toMatchObject({
        ok: true,
        tool: "ping",
        args: {
          text: "hello",
        },
      });
    } finally {
      await runtime.cleanup();
    }
  });

  it("uniquifies MCP tool names across servers", async () => {
    const runtime = await initMcpRuntime({
      mcpServers: [mockServerConfig("mock-a"), mockServerConfig("mock-b")],
    });

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["ping", "ping-2"]);
      expect(runtime.tools.map((tool) => tool.serverName)).toEqual(["mock-a", "mock-b"]);
    } finally {
      await runtime.cleanup();
    }
  });
});
