/**
 * Tests for the injectCallerContext feature in the Pi embedded agent MCP runtime.
 *
 * Verifies that servers opted in via `mcp.servers.<name>.injectCallerContext: true`
 * receive fully-expanded caller-identity headers when the embedded Pi agent
 * connects to them, while all other security and no-op boundaries are preserved.
 *
 * Strategy:
 *  - Pure-unit tests use `__testing.expandEmbeddedMcpCallerContextInConfig`
 *    and `applyBundleMcpCallerContext` directly — no MCP SDK needed.
 *  - Integration tests call `createSessionMcpRuntime` and spy on
 *    `resolveMcpTransport` to capture the effective server config that would
 *    be handed to the transport layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBundleMcpCallerContext } from "./cli-runner/bundle-mcp-caller-context.js";
import { ownerCallerContextTrustedServers } from "./bundle-mcp-config.js";
import { createSessionMcpRuntime, __testing } from "./pi-bundle-mcp-runtime.js";

const { expandEmbeddedMcpCallerContextInConfig } = __testing;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("./embedded-pi-mcp.js", () => ({
  loadEmbeddedPiMcpConfig: vi.fn((params: { cfg?: { mcp?: { servers?: Record<string, unknown> } } }) => ({
    diagnostics: [],
    mcpServers: params.cfg?.mcp?.servers ?? {},
  })),
}));

// Spy on resolveMcpTransport so we can capture the effective server config
// handed to the transport layer without needing to mock the MCP SDK client.
vi.mock("./mcp-transport.js", () => ({
  resolveMcpTransport: vi.fn(() => undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(servers: Record<string, unknown>) {
  return { mcp: { servers } };
}

// ---------------------------------------------------------------------------
// Pure unit tests — expandEmbeddedMcpCallerContextInConfig
// ---------------------------------------------------------------------------

describe("expandEmbeddedMcpCallerContextInConfig", () => {
  it("replaces all OPENCLAW_MCP_* placeholders with real values", () => {
    const input = {
      mcpServers: {
        sbs: {
          url: "http://127.0.0.1:9180/mcp",
          headers: {
            "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
            "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
            "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
            "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          },
        },
      },
    };

    const result = expandEmbeddedMcpCallerContextInConfig(input, {
      agentId: "sgsi_polseg_review",
      accountId: "acct-001",
      messageChannel: "msteams",
      sessionKey: "sk-xyz",
    });

    const headers = result.mcpServers.sbs.headers as Record<string, string>;
    expect(headers["x-openclaw-agent-id"]).toBe("sgsi_polseg_review");
    expect(headers["x-openclaw-account-id"]).toBe("acct-001");
    expect(headers["x-openclaw-message-channel"]).toBe("msteams");
    expect(headers["x-session-key"]).toBe("sk-xyz");
  });

  it("leaves a server without headers unchanged", () => {
    const serverWithoutHeaders = {
      url: "http://127.0.0.1:9181/mcp",
    };
    const input = { mcpServers: { plain: serverWithoutHeaders } };
    const result = expandEmbeddedMcpCallerContextInConfig(input, {
      agentId: "a",
      accountId: "b",
      messageChannel: "c",
    });
    expect(result.mcpServers.plain).toEqual(serverWithoutHeaders);
  });

  it("preserves non-string header values verbatim", () => {
    const input = {
      mcpServers: {
        sbs: {
          url: "http://127.0.0.1:9180/mcp",
          headers: {
            "x-priority": 42,
            "x-flag": true,
            "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
          },
        },
      },
    };

    const result = expandEmbeddedMcpCallerContextInConfig(input, {
      agentId: "agent",
    });

    const headers = result.mcpServers.sbs.headers as Record<string, unknown>;
    expect(headers["x-priority"]).toBe(42);
    expect(headers["x-flag"]).toBe(true);
    expect(headers["x-openclaw-agent-id"]).toBe("agent");
  });

  it("replaces unknown placeholder keys with empty string", () => {
    const input = {
      mcpServers: {
        s: {
          url: "http://host/mcp",
          headers: { "x-custom": "${UNKNOWN_VAR}" },
        },
      },
    };
    const result = expandEmbeddedMcpCallerContextInConfig(input, {});
    const headers = result.mcpServers.s.headers as Record<string, string>;
    expect(headers["x-custom"]).toBe("");
  });

  it("uses empty string for undefined callerContext fields", () => {
    const input = {
      mcpServers: {
        s: {
          url: "http://host/mcp",
          headers: {
            "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
            "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          },
        },
      },
    };
    const result = expandEmbeddedMcpCallerContextInConfig(input, {});
    const headers = result.mcpServers.s.headers as Record<string, string>;
    expect(headers["x-openclaw-agent-id"]).toBe("");
    expect(headers["x-session-key"]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — full pipeline through createSessionMcpRuntime
// ---------------------------------------------------------------------------

describe("Pi embedded MCP runtime — injectCallerContext integration", () => {
  let resolveMcpTransportMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mcpTransport = await import("./mcp-transport.js");
    resolveMcpTransportMock = vi.mocked(mcpTransport.resolveMcpTransport);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("expands caller identity headers for a server with injectCallerContext: true", async () => {
    const config = cfg({
      sbs: {
        transport: "streamable-http",
        url: "http://127.0.0.1:9180/mcp",
        injectCallerContext: true,
      },
    });

    const runtime = createSessionMcpRuntime({
      sessionId: "test-session",
      sessionKey: "sk-abc",
      workspaceDir: "/tmp",
      cfg: config,
      callerContext: {
        agentId: "sgsi_polseg_review",
        accountId: "acct-001",
        messageChannel: "msteams",
      },
    });

    await runtime.getCatalog();

    expect(resolveMcpTransportMock).toHaveBeenCalledOnce();
    const [, rawServer] = resolveMcpTransportMock.mock.calls[0];
    const headers = (rawServer as Record<string, unknown>).headers as Record<string, string>;
    expect(headers["x-openclaw-agent-id"]).toBe("sgsi_polseg_review");
    expect(headers["x-openclaw-account-id"]).toBe("acct-001");
    expect(headers["x-openclaw-message-channel"]).toBe("msteams");
    expect(headers["x-session-key"]).toBe("sk-abc");
  });

  it("does not inject headers for a server without injectCallerContext", async () => {
    const config = cfg({
      plain: {
        transport: "streamable-http",
        url: "http://127.0.0.1:9181/mcp",
      },
    });

    const runtime = createSessionMcpRuntime({
      sessionId: "test-session",
      sessionKey: "sk-abc",
      workspaceDir: "/tmp",
      cfg: config,
      callerContext: { agentId: "some-agent", accountId: "a", messageChannel: "slack" },
    });

    await runtime.getCatalog();

    expect(resolveMcpTransportMock).toHaveBeenCalledOnce();
    const [, rawServer] = resolveMcpTransportMock.mock.calls[0];
    const headers = (rawServer as Record<string, unknown>).headers as Record<string, string> | undefined;
    expect(headers?.["x-openclaw-agent-id"]).toBeUndefined();
  });

  it("is a graceful no-op when callerContext is omitted", async () => {
    const config = cfg({
      sbs: {
        transport: "streamable-http",
        url: "http://127.0.0.1:9180/mcp",
        injectCallerContext: true,
      },
    });

    const runtime = createSessionMcpRuntime({
      sessionId: "test-session",
      workspaceDir: "/tmp",
      cfg: config,
      // callerContext omitted intentionally
    });

    await runtime.getCatalog();

    expect(resolveMcpTransportMock).toHaveBeenCalledOnce();
    const [, rawServer] = resolveMcpTransportMock.mock.calls[0];
    const headers = (rawServer as Record<string, unknown>).headers as Record<string, string> | undefined;
    expect(headers?.["x-openclaw-agent-id"]).toBeUndefined();
  });

  it("does not inject when the merged URL differs from the trusted URL (security boundary)", async () => {
    const { loadEmbeddedPiMcpConfig } = await import("./embedded-pi-mcp.js");
    // Owner config trusts "http://trusted-host/mcp", but the loaded config
    // has a different URL (e.g. a plugin overrode it).
    vi.mocked(loadEmbeddedPiMcpConfig).mockReturnValueOnce({
      diagnostics: [],
      mcpServers: {
        sbs: {
          transport: "streamable-http",
          url: "http://attacker-host/mcp", // URL was overridden
        },
      } as Record<string, unknown>,
    });

    const config = cfg({
      sbs: {
        transport: "streamable-http",
        url: "http://trusted-host/mcp",
        injectCallerContext: true,
      },
    });

    const runtime = createSessionMcpRuntime({
      sessionId: "test-session",
      workspaceDir: "/tmp",
      cfg: config,
      callerContext: { agentId: "agent", accountId: "a", messageChannel: "c" },
    });

    await runtime.getCatalog();

    expect(resolveMcpTransportMock).toHaveBeenCalledOnce();
    const [, rawServer] = resolveMcpTransportMock.mock.calls[0];
    const headers = (rawServer as Record<string, unknown>).headers as Record<string, string> | undefined;
    expect(headers?.["x-openclaw-agent-id"]).toBeUndefined();
  });

  it("sessionKey flows into x-session-key header", async () => {
    const config = cfg({
      sbs: {
        transport: "streamable-http",
        url: "http://127.0.0.1:9180/mcp",
        injectCallerContext: true,
      },
    });

    const runtime = createSessionMcpRuntime({
      sessionId: "test-session",
      sessionKey: "agent:myagent:msteams:channel:abc",
      workspaceDir: "/tmp",
      cfg: config,
      callerContext: { agentId: "myagent", accountId: "a", messageChannel: "msteams" },
    });

    await runtime.getCatalog();

    const [, rawServer] = resolveMcpTransportMock.mock.calls[0];
    const headers = (rawServer as Record<string, unknown>).headers as Record<string, string>;
    expect(headers["x-session-key"]).toBe("agent:myagent:msteams:channel:abc");
  });

  it("a pre-existing case-insensitive header blocks injection for that header only", async () => {
    // applyBundleMcpCallerContext is case-insensitive: X-Session-Key blocks x-session-key injection.
    const config = cfg({
      sbs: {
        transport: "streamable-http",
        url: "http://127.0.0.1:9180/mcp",
        injectCallerContext: true,
        headers: {
          "X-Session-Key": "manually-set-key",
        },
      },
    });

    const runtime = createSessionMcpRuntime({
      sessionId: "test-session",
      sessionKey: "runtime-key",
      workspaceDir: "/tmp",
      cfg: config,
      callerContext: { agentId: "agent", accountId: "a", messageChannel: "c" },
    });

    await runtime.getCatalog();

    const [, rawServer] = resolveMcpTransportMock.mock.calls[0];
    const headers = (rawServer as Record<string, unknown>).headers as Record<string, unknown>;
    // The manually-set header wins; runtime-key must not appear
    expect(headers["X-Session-Key"]).toBe("manually-set-key");
    expect(headers["x-session-key"]).toBeUndefined();
    // Other caller headers should still be injected and expanded
    expect(headers["x-openclaw-agent-id"]).toBe("agent");
  });
});
