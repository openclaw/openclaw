import { describe, expect, it, vi } from "vitest";
import { resolveMcpTransport } from "./mcp-transport.js";

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
  return {
    StreamableHTTPClientTransport: vi.fn(function (this: any, url: URL, opts?: any) {
      this.url = url;
      this.opts = opts;
      this.transportType = "streamable-http";
    }),
  };
});

describe("resolveMcpTransport", () => {
  it("sets Accept header for streamable-http transport", () => {
    const result = resolveMcpTransport("test-server", {
      url: "https://example.com/mcp",
      transport: "streamable-http",
    });

    expect(result).not.toBeNull();
    expect(result?.transportType).toBe("streamable-http");
    const transport = result!.transport as any;
    expect(transport.opts?.requestInit?.headers?.Accept).toBe(
      "application/json, text/event-stream",
    );
  });

  it("preserves user-provided headers while adding Accept for streamable-http", () => {
    const result = resolveMcpTransport("test-server", {
      url: "https://example.com/mcp",
      transport: "streamable-http",
      headers: {
        Authorization: "Bearer secret",
        "X-Custom": "value",
      },
    });

    expect(result).not.toBeNull();
    const transport = result!.transport as any;
    expect(transport.opts?.requestInit?.headers?.Authorization).toBe("Bearer secret");
    expect(transport.opts?.requestInit?.headers?.["X-Custom"]).toBe("value");
    expect(transport.opts?.requestInit?.headers?.Accept).toBe(
      "application/json, text/event-stream",
    );
  });
});
