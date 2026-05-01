import { describe, expect, it } from "vitest";
import {
  applyBundleMcpCallerContext,
  OPENCLAW_MCP_CALLER_HEADERS,
} from "./bundle-mcp-caller-context.js";

describe("applyBundleMcpCallerContext", () => {
  it("injects only on remote servers whose name is in the trusted allowlist", () => {
    const merged = applyBundleMcpCallerContext(
      {
        mcpServers: {
          probe: {
            command: "node",
            args: ["x.mjs"],
          },
          ext: {
            type: "http",
            url: "http://127.0.0.1:9180/mcp",
          },
          withFlag: {
            type: "http",
            url: "https://api.example/mcp",
            injectCallerContext: true,
          },
        },
      },
      new Set(["withFlag"]),
    );

    expect(merged.mcpServers.probe).toEqual({
      command: "node",
      args: ["x.mjs"],
    });
    expect(merged.mcpServers.ext).toEqual({
      type: "http",
      url: "http://127.0.0.1:9180/mcp",
    });
    expect(merged.mcpServers.withFlag).toMatchObject({
      type: "http",
      url: "https://api.example/mcp",
      headers: OPENCLAW_MCP_CALLER_HEADERS,
    });
    expect("injectCallerContext" in (merged.mcpServers.withFlag as object)).toBe(false);
  });

  it("does not inject when the server is not in the trusted allowlist, even if the merged config says injectCallerContext: true", () => {
    // Simulates a plugin .mcp.json that sets injectCallerContext: true. Owner
    // never opted that name in, so the flag is ignored AND stripped.
    const merged = applyBundleMcpCallerContext(
      {
        mcpServers: {
          pluginRemote: {
            type: "sse",
            url: "https://attacker.example/mcp",
            injectCallerContext: true,
          },
        },
      },
      new Set(),
    );

    expect(merged.mcpServers.pluginRemote).toEqual({
      type: "sse",
      url: "https://attacker.example/mcp",
    });
    expect(
      "injectCallerContext" in (merged.mcpServers.pluginRemote as object),
    ).toBe(false);
  });

  it("does not inject on stdio servers even when trusted", () => {
    const merged = applyBundleMcpCallerContext(
      {
        mcpServers: {
          stdio: {
            command: "node",
            args: ["server.mjs"],
            injectCallerContext: true,
          },
        },
      },
      new Set(["stdio"]),
    );

    expect(merged.mcpServers.stdio).toEqual({
      command: "node",
      args: ["server.mjs"],
    });
  });

  it("adds caller headers without overwriting existing case-exact names", () => {
    const merged = applyBundleMcpCallerContext(
      {
        mcpServers: {
          ext: {
            type: "http",
            url: "http://127.0.0.1:9180/mcp",
          },
          mixed: {
            type: "sse",
            url: "https://api.example/mcp",
            headers: {
              Authorization: "Bearer secret",
              "x-session-key": "user-set-session",
            },
          },
        },
      },
      new Set(["ext", "mixed"]),
    );

    expect(merged.mcpServers.ext).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:9180/mcp",
      headers: OPENCLAW_MCP_CALLER_HEADERS,
    });

    expect(merged.mcpServers.mixed.headers).toEqual({
      Authorization: "Bearer secret",
      "x-session-key": "user-set-session",
      "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
      "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
      "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
    });
  });

  it("preserves numeric and boolean header values verbatim when injecting", () => {
    // McpServerConfig.headers permits string | number | boolean. The injection
    // step must NOT downcast existing values to strings (or drop them) when
    // adding the caller placeholders.
    const merged = applyBundleMcpCallerContext(
      {
        mcpServers: {
          remote: {
            type: "http",
            url: "https://api.example/mcp",
            headers: {
              "X-Tenant": 42,
              "X-Use-Beta": true,
              Authorization: "Bearer secret",
            },
          },
        },
      },
      new Set(["remote"]),
    );

    expect(merged.mcpServers.remote.headers).toEqual({
      "X-Tenant": 42,
      "X-Use-Beta": true,
      Authorization: "Bearer secret",
      "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
      "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
      "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
      "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
    });
  });

  it("respects existing user headers case-insensitively (HTTP semantics)", () => {
    // User supplied `X-Session-Key` (capitalized). Since HTTP headers are
    // case-insensitive, we must NOT also inject the lowercase `x-session-key`
    // — otherwise the downstream client would see both, and OpenClaw's
    // placeholder could silently shadow the user's own value.
    const merged = applyBundleMcpCallerContext(
      {
        mcpServers: {
          mixed: {
            type: "sse",
            url: "https://api.example/mcp",
            headers: {
              "X-Session-Key": "user-set-session",
              "X-OpenClaw-Agent-Id": "user-agent",
            },
          },
        },
      },
      new Set(["mixed"]),
    );

    expect(merged.mcpServers.mixed.headers).toEqual({
      "X-Session-Key": "user-set-session",
      "X-OpenClaw-Agent-Id": "user-agent",
      "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
      "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
    });
  });
});
