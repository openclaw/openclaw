import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMcpTransport } from "./mcp-transport.js";

type StreamableTransportOptions = {
  requestInit?: RequestInit;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  authProvider?: unknown;
};

type SseTransportOptions = {
  requestInit?: RequestInit;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  eventSourceInit?: {
    fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  };
  authProvider?: unknown;
};

const { runtimeFetchMock, streamableTransportConstructorMock, sseTransportConstructorMock } =
  vi.hoisted(() => ({
    runtimeFetchMock: vi.fn(),
    streamableTransportConstructorMock: vi.fn(),
    sseTransportConstructorMock: vi.fn(),
  }));

vi.mock("../infra/net/undici-runtime.js", () => ({
  loadUndiciRuntimeDeps: () => ({
    fetch: runtimeFetchMock,
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: function MockStreamableHTTPClientTransport(
    this: unknown,
    url: URL,
    options?: StreamableTransportOptions,
  ) {
    streamableTransportConstructorMock(url, options);
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: function MockSSEClientTransport(
    this: unknown,
    url: URL,
    options?: SseTransportOptions,
  ) {
    sseTransportConstructorMock(url, options);
  },
}));

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { location },
  });
}

function redirectWithoutLocationResponse(status = 302): Response {
  return new Response(null, { status });
}

function latestStreamableTransportOptions(): StreamableTransportOptions {
  const latestCall = streamableTransportConstructorMock.mock.calls[
    streamableTransportConstructorMock.mock.calls.length - 1
  ] as unknown[] | undefined;
  const options = latestCall?.[1];
  if (!options || typeof options !== "object") {
    throw new Error("Expected streamable HTTP transport options");
  }
  return options as StreamableTransportOptions;
}

function latestStreamableFetch() {
  const fetch = latestStreamableTransportOptions().fetch;
  if (typeof fetch !== "function") {
    throw new Error("Expected streamable HTTP transport fetch");
  }
  return fetch;
}

function latestSseTransportOptions(): SseTransportOptions {
  const latestCall = sseTransportConstructorMock.mock.calls[
    sseTransportConstructorMock.mock.calls.length - 1
  ] as unknown[] | undefined;
  const options = latestCall?.[1];
  if (!options || typeof options !== "object") {
    throw new Error("Expected SSE transport options");
  }
  return options as SseTransportOptions;
}

function latestSseFetch() {
  const fetch = latestSseTransportOptions().fetch;
  if (typeof fetch !== "function") {
    throw new Error("Expected SSE transport fetch");
  }
  return fetch;
}

function latestSseEventSourceFetch() {
  const fetch = latestSseTransportOptions().eventSourceInit?.fetch;
  if (typeof fetch !== "function") {
    throw new Error("Expected SSE EventSource fetch");
  }
  return fetch;
}

function runtimeFetchCall(index: number): [RequestInfo | URL, RequestInit | undefined] {
  const call = runtimeFetchMock.mock.calls[index] as
    | [RequestInfo | URL, RequestInit | undefined]
    | undefined;
  if (!call) {
    throw new Error(`Expected runtime fetch call ${index}`);
  }
  return call;
}

describe("resolveMcpTransport", () => {
  beforeEach(() => {
    runtimeFetchMock.mockReset();
    streamableTransportConstructorMock.mockClear();
    sseTransportConstructorMock.mockClear();
  });

  it("scrubs custom headers when streamable HTTP follows a cross-origin redirect", async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://redirect.example/next"))
      .mockResolvedValueOnce(new Response("ok"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      headers: {
        "X-Api-Key": "secret",
      },
    });

    const options = latestStreamableTransportOptions();
    expect(options.requestInit).toEqual({
      headers: {
        "X-Api-Key": "secret",
      },
    });
    expect(options.fetch).toBeTypeOf("function");

    await options.fetch?.("https://mcp.example.com/mcp", {
      method: "GET",
      headers: {
        accept: "application/json, text/event-stream",
        "user-agent": "node",
        "x-api-key": "secret",
      },
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeFetchCall(0)?.[0]).toBe("https://mcp.example.com/mcp");
    expect(runtimeFetchCall(0)?.[1]?.redirect).toBe("manual");
    expect(runtimeFetchCall(1)?.[0]).toBe("https://redirect.example/next");
    expect(runtimeFetchCall(1)?.[1]?.redirect).toBe("manual");

    const redirectedHeaders = new Headers(runtimeFetchCall(1)?.[1]?.headers);
    expect(redirectedHeaders.get("x-api-key")).toBeNull();
    expect(redirectedHeaders.get("accept")).toBe("application/json, text/event-stream");
    expect(redirectedHeaders.get("user-agent")).toBe("node");
  });

  it("preserves replayable request bodies for cross-origin streamable HTTP redirects", async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://redirect.example/mcp", 307))
      .mockResolvedValueOnce(new Response("ok"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      headers: {
        "X-Api-Key": "secret",
      },
    });

    const options = latestStreamableTransportOptions();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    await options.fetch?.("https://mcp.example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "secret",
      },
      body,
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeFetchCall(1)?.[0]).toBe("https://redirect.example/mcp");
    expect(runtimeFetchCall(1)?.[1]?.method).toBe("POST");
    expect(runtimeFetchCall(1)?.[1]?.body).toBe(body);

    const redirectedHeaders = new Headers(runtimeFetchCall(1)?.[1]?.headers);
    expect(redirectedHeaders.get("x-api-key")).toBeNull();
    expect(redirectedHeaders.get("content-type")).toBe("application/json");
  });

  it("allows same-url redirects when the request method changes", async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://mcp.example.com/mcp", 303))
      .mockResolvedValueOnce(new Response("ok"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
    });

    const options = latestStreamableTransportOptions();

    await options.fetch?.("https://mcp.example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeFetchCall(1)?.[0]).toBe("https://mcp.example.com/mcp");
    expect(runtimeFetchCall(1)?.[1]?.method).toBe("GET");
    expect(runtimeFetchCall(1)?.[1]?.body).toBeUndefined();

    const redirectedHeaders = new Headers(runtimeFetchCall(1)?.[1]?.headers);
    expect(redirectedHeaders.get("content-type")).toBeNull();
  });

  it("rejects streamable HTTP redirect loops", async () => {
    runtimeFetchMock.mockResolvedValueOnce(redirectResponse("https://mcp.example.com/mcp"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
    });

    await expect(latestStreamableFetch()("https://mcp.example.com/mcp")).rejects.toThrow(
      "Redirect loop detected",
    );

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects streamable HTTP redirect chains beyond the limit", async () => {
    for (let index = 0; index <= 20; index += 1) {
      runtimeFetchMock.mockResolvedValueOnce(
        redirectResponse(`https://mcp.example.com/redirect-${index}`),
      );
    }

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
    });

    await expect(latestStreamableFetch()("https://mcp.example.com/mcp")).rejects.toThrow(
      "Too many redirects (limit: 20)",
    );

    expect(runtimeFetchMock).toHaveBeenCalledTimes(21);
  });

  it("returns streamable HTTP redirect responses that do not include a location", async () => {
    const response = redirectWithoutLocationResponse();
    runtimeFetchMock.mockResolvedValueOnce(response);

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
    });

    await expect(latestStreamableFetch()("https://mcp.example.com/mcp")).resolves.toBe(response);

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes OAuth providers and TLS options into HTTP transports", () => {
    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      auth: "oauth",
      headers: {
        Authorization: "Bearer static",
        "X-Tenant": "docs",
      },
      sslVerify: false,
    });

    const options = latestStreamableTransportOptions();
    expect(options.authProvider).toBeTypeOf("object");
    expect(options.fetch).toBeTypeOf("function");
    expect(options.requestInit).toBeUndefined();
  });

  it("keeps OAuth runtime headers scoped to the MCP resource origin", async () => {
    runtimeFetchMock.mockResolvedValue(new Response("ok"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      auth: "oauth",
      headers: {
        "X-Tenant": "docs",
      },
    });

    const options = latestStreamableTransportOptions();
    await options.fetch?.("https://mcp.example.com/mcp");
    await options.fetch?.("https://auth.example.com/token");

    expect(new Headers(runtimeFetchCall(0)?.[1]?.headers).get("x-tenant")).toBe("docs");
    expect(new Headers(runtimeFetchCall(1)?.[1]?.headers).get("x-tenant")).toBeNull();
  });

  it("scrubs custom headers when SSE requests follow a cross-origin redirect", async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://redirect.example/message", 307))
      .mockResolvedValueOnce(new Response("ok"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/sse",
      transport: "sse",
      headers: {
        "X-Api-Key": "secret",
        "X-Tenant": "docs",
      },
    });

    await latestSseFetch()("https://mcp.example.com/message", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "secret",
        "x-tenant": "docs",
      },
      body: "{}",
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeFetchCall(0)?.[0]).toBe("https://mcp.example.com/message");
    expect(runtimeFetchCall(0)?.[1]?.redirect).toBe("manual");
    expect(runtimeFetchCall(1)?.[0]).toBe("https://redirect.example/message");
    expect(runtimeFetchCall(1)?.[1]?.redirect).toBe("manual");
    expect(runtimeFetchCall(1)?.[1]?.method).toBe("POST");
    expect(runtimeFetchCall(1)?.[1]?.body).toBe("{}");

    const redirectedHeaders = new Headers(runtimeFetchCall(1)?.[1]?.headers);
    expect(redirectedHeaders.get("x-api-key")).toBeNull();
    expect(redirectedHeaders.get("x-tenant")).toBeNull();
    expect(redirectedHeaders.get("content-type")).toBe("application/json");
  });

  it("scrubs configured headers when SSE EventSource follows a cross-origin redirect", async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://redirect.example/sse"))
      .mockResolvedValueOnce(new Response("ok"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/sse",
      transport: "sse",
      headers: {
        "X-Api-Key": "secret",
      },
    });

    await latestSseEventSourceFetch()("https://mcp.example.com/sse", {
      headers: {
        accept: "text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeFetchCall(0)?.[0]).toBe("https://mcp.example.com/sse");
    expect(runtimeFetchCall(1)?.[0]).toBe("https://redirect.example/sse");

    const initialHeaders = new Headers(runtimeFetchCall(0)?.[1]?.headers);
    expect(initialHeaders.get("x-api-key")).toBe("secret");
    expect(initialHeaders.get("accept")).toBe("text/event-stream");

    const redirectedHeaders = new Headers(runtimeFetchCall(1)?.[1]?.headers);
    expect(redirectedHeaders.get("x-api-key")).toBeNull();
    expect(redirectedHeaders.get("mcp-protocol-version")).toBeNull();
    expect(redirectedHeaders.get("accept")).toBe("text/event-stream");
  });

  it("preserves configured SSE headers for same-origin redirects", async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://mcp.example.com/next-sse"))
      .mockResolvedValueOnce(new Response("ok"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/sse",
      transport: "sse",
      headers: {
        "X-Api-Key": "secret",
      },
    });

    await latestSseEventSourceFetch()("https://mcp.example.com/sse", {
      headers: {
        accept: "text/event-stream",
      },
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeFetchCall(1)?.[0]).toBe("https://mcp.example.com/next-sse");

    const redirectedHeaders = new Headers(runtimeFetchCall(1)?.[1]?.headers);
    expect(redirectedHeaders.get("x-api-key")).toBe("secret");
    expect(redirectedHeaders.get("accept")).toBe("text/event-stream");
  });
});
