import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
}));
vi.mock("../infra/net/undici-runtime.js", () => ({
  loadUndiciRuntimeDeps: vi.fn(() => ({ fetch: vi.fn() })),
}));
vi.mock("../logger.js", () => ({ logDebug: vi.fn() }));

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveMcpTransport } from "./mcp-transport.js";

describe("resolveMcpTransport — streamable-http Accept header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds Accept header when no user headers provided", () => {
    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/http",
      transport: "streamable-http",
    });

    expect(StreamableHTTPClientTransport).toHaveBeenCalledOnce();
    const [, options] = (StreamableHTTPClientTransport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.requestInit.headers).toMatchObject({
      Accept: "application/json, text/event-stream",
    });
  });

  it("adds Accept header when user headers present but no Accept set", () => {
    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/http",
      transport: "streamable-http",
      headers: { Authorization: "Bearer token" },
    });

    const [, options] = (StreamableHTTPClientTransport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.requestInit.headers).toMatchObject({
      Authorization: "Bearer token",
      Accept: "application/json, text/event-stream",
    });
  });

  it("does not override Accept header when user already set it", () => {
    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/http",
      transport: "streamable-http",
      headers: { Accept: "application/json" },
    });

    const [, options] = (StreamableHTTPClientTransport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.requestInit.headers["Accept"]).toBe("application/json");
  });

  it("does not override Accept header when user set lowercase accept", () => {
    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/http",
      transport: "streamable-http",
      headers: { accept: "application/json" },
    });

    const [, options] = (StreamableHTTPClientTransport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.requestInit.headers["accept"]).toBe("application/json");
    expect(options.requestInit.headers["Accept"]).toBeUndefined();
  });
});
