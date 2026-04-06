import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadEmbeddedPiMcpConfigMock = vi.hoisted(() => vi.fn());
const createMcpOAuthProviderMock = vi.hoisted(() => vi.fn());
const loadMcpOAuthStateMock = vi.hoisted(() => vi.fn());
const saveMcpOAuthStateMock = vi.hoisted(() => vi.fn());
const waitForOAuthCallbackMock = vi.hoisted(() => vi.fn());
const resolveMcpTransportMock = vi.hoisted(() => vi.fn());
const connectMock = vi.hoisted(() => vi.fn());
const listToolsMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
const finishAuthMock = vi.hoisted(() => vi.fn());
const terminateSessionMock = vi.hoisted(() => vi.fn());

const { UnauthorizedError, FakeStreamableHTTPClientTransport, FakeSSEClientTransport } = vi.hoisted(
  () => {
    class MockUnauthorizedError extends Error {}

    class MockStreamableHTTPClientTransport {
      finishAuth = finishAuthMock;
      close = closeMock;
      terminateSession = terminateSessionMock;
    }

    class MockSSEClientTransport {
      finishAuth = finishAuthMock;
      close = closeMock;
    }

    return {
      UnauthorizedError: MockUnauthorizedError,
      FakeStreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
      FakeSSEClientTransport: MockSSEClientTransport,
    };
  },
);

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = connectMock;
    listTools = listToolsMock;
    close = closeMock;
    callTool = vi.fn();
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: FakeStreamableHTTPClientTransport,
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: FakeSSEClientTransport,
}));

vi.mock("./embedded-pi-mcp.js", () => ({
  loadEmbeddedPiMcpConfig: loadEmbeddedPiMcpConfigMock,
}));

vi.mock("./mcp-oauth-provider.js", () => ({
  createMcpOAuthProvider: createMcpOAuthProviderMock,
  loadMcpOAuthState: loadMcpOAuthStateMock,
  saveMcpOAuthState: saveMcpOAuthStateMock,
  waitForOAuthCallback: waitForOAuthCallbackMock,
}));

vi.mock("./mcp-transport.js", () => ({
  resolveMcpTransport: resolveMcpTransportMock,
}));

let createSessionMcpRuntime: typeof import("./pi-bundle-mcp-runtime.js").createSessionMcpRuntime;

describe("createSessionMcpRuntime OAuth", () => {
  beforeAll(async () => {
    ({ createSessionMcpRuntime } = await import("./pi-bundle-mcp-runtime.js"));
  });

  beforeEach(() => {
    loadEmbeddedPiMcpConfigMock.mockReset();
    createMcpOAuthProviderMock.mockReset();
    loadMcpOAuthStateMock.mockReset();
    saveMcpOAuthStateMock.mockReset();
    waitForOAuthCallbackMock.mockReset();
    resolveMcpTransportMock.mockReset();
    connectMock.mockReset();
    listToolsMock.mockReset();
    closeMock.mockReset();
    closeMock.mockResolvedValue(undefined);
    finishAuthMock.mockReset();
    finishAuthMock.mockResolvedValue(undefined);
    terminateSessionMock.mockReset();
    terminateSessionMock.mockResolvedValue(undefined);

    loadEmbeddedPiMcpConfigMock.mockReturnValue({
      diagnostics: [],
      mcpServers: {
        oauthRemote: {
          url: "https://mcp.example.com/http",
          transport: "streamable-http",
          auth: "oauth",
        },
      },
    });
    createMcpOAuthProviderMock.mockReturnValue({ provider: "oauth-provider" });
    waitForOAuthCallbackMock.mockResolvedValue("oauth-code");
    listToolsMock.mockResolvedValue({
      tools: [
        {
          name: "remote_tool",
          title: "Remote tool",
          description: "Runs remotely",
          inputSchema: { type: "object" },
        },
      ],
      nextCursor: undefined,
    });
  });

  it("completes the browser callback flow before retrying the connection", async () => {
    const transport = new FakeStreamableHTTPClientTransport();
    resolveMcpTransportMock.mockReturnValue({
      transport,
      description: "https://mcp.example.com/http",
      transportType: "streamable-http",
      connectionTimeoutMs: 5_000,
      auth: "oauth",
    });
    connectMock
      .mockRejectedValueOnce(new UnauthorizedError("Unauthorized"))
      .mockResolvedValueOnce(undefined);

    const runtime = createSessionMcpRuntime({
      sessionId: "oauth-session",
      workspaceDir: "/tmp/openclaw-oauth-runtime",
    });

    const catalog = await runtime.getCatalog();

    expect(createMcpOAuthProviderMock).toHaveBeenCalledWith({
      serverName: "oauthRemote",
      loadState: expect.any(Function),
      saveState: expect.any(Function),
    });
    expect(resolveMcpTransportMock).toHaveBeenCalledWith(
      "oauthRemote",
      {
        url: "https://mcp.example.com/http",
        transport: "streamable-http",
        auth: "oauth",
      },
      { authProvider: { provider: "oauth-provider" } },
    );
    expect(waitForOAuthCallbackMock.mock.invocationCallOrder[0]).toBeLessThan(
      connectMock.mock.invocationCallOrder[0],
    );
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(waitForOAuthCallbackMock).toHaveBeenCalledWith({
      serverName: "oauthRemote",
      getExpectedState: expect.any(Function),
    });
    expect(finishAuthMock).toHaveBeenCalledWith("oauth-code");
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]?.toolName).toBe("remote_tool");

    await runtime.dispose();
  });

  it("closes the client before retrying an OAuth SSE connection", async () => {
    const transport = new FakeSSEClientTransport();
    resolveMcpTransportMock.mockReturnValue({
      transport,
      description: "https://mcp.example.com/sse",
      transportType: "sse",
      connectionTimeoutMs: 5_000,
      auth: "oauth",
    });
    connectMock
      .mockRejectedValueOnce(new UnauthorizedError("Unauthorized"))
      .mockResolvedValueOnce(undefined);

    const runtime = createSessionMcpRuntime({
      sessionId: "oauth-sse-session",
      workspaceDir: "/tmp/openclaw-oauth-runtime",
    });

    await runtime.getCatalog();

    expect(finishAuthMock).toHaveBeenCalledWith("oauth-code");
    expect(closeMock).toHaveBeenCalled();
    expect(closeMock.mock.invocationCallOrder[0]).toBeLessThan(
      connectMock.mock.invocationCallOrder[1],
    );

    await runtime.dispose();
  });
});
