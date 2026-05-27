import { describe, expect, it } from "vitest";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

describe("resolveMcpTransportConfig", () => {
  it("resolves stdio config with connection timeout", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      command: "node",
      args: ["./server.mjs"],
      connectionTimeoutMs: 12_345,
    });

    expect(resolved).toMatchObject({
      kind: "stdio",
      transportType: "stdio",
      command: "node",
      args: ["./server.mjs"],
      connectionTimeoutMs: 12_345,
    });
  });

  it("resolves SSE config by default", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      url: "https://mcp.example.com/sse",
      headers: {
        Authorization: "Bearer token",
        "X-Count": 42,
      },
    });

    expect(resolved).toEqual({
      kind: "http",
      transportType: "sse",
      url: "https://mcp.example.com/sse",
      headers: {
        Authorization: "Bearer token",
        "X-Count": "42",
      },
      description: "https://mcp.example.com/sse",
      connectionTimeoutMs: 30_000,
    });
  });

  it("resolves explicit streamable HTTP config", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      url: "https://mcp.example.com/http",
      transport: "streamable-http",
    });

    expect(resolved).toMatchObject({
      kind: "http",
      transportType: "streamable-http",
      url: "https://mcp.example.com/http",
    });
  });
});
