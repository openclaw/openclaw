import { beforeEach, describe, expect, it, vi } from "vitest";

const callToolMock = vi.hoisted(() => vi.fn());

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function Client() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "slow_probe",
            description: "slow probe",
            inputSchema: { type: "object" },
          },
        ],
      }),
      callTool: callToolMock,
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock("./embedded-pi-mcp.js", () => ({
  loadEmbeddedPiMcpConfig: (params: { cfg?: { mcp?: { servers?: Record<string, unknown> } } }) => ({
    diagnostics: [],
    mcpServers: params.cfg?.mcp?.servers ?? {},
  }),
}));

vi.mock("./mcp-transport.js", () => ({
  resolveMcpTransport: vi.fn().mockReturnValue({
    transport: { close: vi.fn().mockResolvedValue(undefined) },
    description: "mock transport",
    transportType: "stdio",
    connectionTimeoutMs: 30_000,
    requestTimeoutMs: 456_789,
  }),
}));

describe("createSessionMcpRuntime callTool request timeout", () => {
  beforeEach(() => {
    callToolMock.mockReset();
    callToolMock.mockResolvedValue({ content: [], isError: false });
  });

  it("passes resolved MCP request timeout and progress reset options to SDK callTool", async () => {
    const { createSessionMcpRuntime } = await import("./pi-bundle-mcp-runtime.js");
    const runtime = createSessionMcpRuntime({
      sessionId: "session-timeout",
      workspaceDir: "/tmp",
      cfg: {
        mcp: {
          servers: {
            probe: { command: "node" },
          },
        },
      },
    });

    await runtime.callTool("probe", "slow_probe", { ok: true });

    expect(callToolMock).toHaveBeenCalledWith(
      { name: "slow_probe", arguments: { ok: true } },
      undefined,
      { timeout: 456_789, resetTimeoutOnProgress: true },
    );

    await runtime.dispose();
  });
});
