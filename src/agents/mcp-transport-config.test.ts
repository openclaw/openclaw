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

  it("drops dangerous env overrides from stdio config", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      command: "node",
      env: {
        SAFE_VALUE: "ok",
        PORT: 3000,
        ENABLED: true,
        NODE_OPTIONS: "--require=./evil.js",
        LD_PRELOAD: "/tmp/pwn.so",
        BASH_ENV: "/tmp/pwn.sh",
      },
    });

    expect(resolved).toEqual({
      kind: "stdio",
      transportType: "stdio",
      command: "node",
      args: undefined,
      env: {
        SAFE_VALUE: "ok",
        PORT: "3000",
        ENABLED: "true",
      },
      cwd: undefined,
      description: "node",
      connectionTimeoutMs: 30_000,
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

  it("keeps HTTP header parsing unchanged for env-like names", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      url: "https://mcp.example.com/sse",
      headers: {
        NODE_OPTIONS: "allowed-header",
      },
    });

    expect(resolved).toEqual({
      kind: "http",
      transportType: "sse",
      url: "https://mcp.example.com/sse",
      headers: {
        NODE_OPTIONS: "allowed-header",
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
