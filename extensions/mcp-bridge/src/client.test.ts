import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the MCP SDK modules
const mockConnect = vi.hoisted(() => vi.fn());
const mockRequest = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: class MockClient {
      connect = mockConnect;
      request = mockRequest;
    },
  };
});

vi.mock("./transport.js", () => ({
  createTransport: vi.fn().mockReturnValue({
    close: mockClose,
  }),
}));

import { McpBridgeClient } from "./client.js";

describe("McpBridgeClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects to the server", async () => {
    const client = new McpBridgeClient({
      name: "test",
      type: "http",
      url: "https://example.com/mcp",
    });
    await client.connect();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("lists tools from the server", async () => {
    mockRequest.mockResolvedValueOnce({
      tools: [
        {
          name: "search",
          description: "Search things",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
        },
        {
          name: "create",
          description: "Create a thing",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    const client = new McpBridgeClient({
      name: "test",
      type: "http",
      url: "https://example.com/mcp",
    });
    await client.connect();
    const tools = await client.listTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("search");
    expect(tools[0].description).toBe("Search things");
    expect(tools[1].name).toBe("create");
  });

  it("calls a tool and returns text content", async () => {
    mockRequest.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"results": []}' }],
      isError: false,
    });

    const client = new McpBridgeClient({
      name: "test",
      type: "http",
      url: "https://example.com/mcp",
    });
    await client.connect();

    const result = await client.callTool("search", { q: "hello" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('{"results": []}');
    expect(result.isError).toBe(false);
  });

  it("handles error results from tool calls", async () => {
    mockRequest.mockResolvedValueOnce({
      content: [{ type: "text", text: "Something went wrong" }],
      isError: true,
    });

    const client = new McpBridgeClient({
      name: "test",
      type: "http",
      url: "https://example.com/mcp",
    });
    await client.connect();

    const result = await client.callTool("broken_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Something went wrong");
  });

  it("closes the transport", async () => {
    const client = new McpBridgeClient({
      name: "test",
      type: "http",
      url: "https://example.com/mcp",
    });
    await client.connect();
    await client.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
