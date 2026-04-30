import { describe, expect, it } from "vitest";
import {
  applyBundleMcpCallerContext,
  OPENCLAW_MCP_CALLER_HEADERS,
} from "./bundle-mcp-caller-context.js";

describe("applyBundleMcpCallerContext", () => {
  it("injects only on remote servers that set injectCallerContext true", () => {
    const merged = applyBundleMcpCallerContext({
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
    });

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

  it("does not inject when injectCallerContext is false or omitted on a url server", () => {
    const merged = applyBundleMcpCallerContext({
      mcpServers: {
        explicitOff: {
          type: "sse",
          url: "https://api.example/mcp",
          injectCallerContext: false,
        },
        omitted: {
          type: "sse",
          url: "https://other.example/mcp",
        },
      },
    });

    expect(merged.mcpServers.explicitOff).toEqual({
      type: "sse",
      url: "https://api.example/mcp",
    });
    expect(merged.mcpServers.omitted).toEqual({
      type: "sse",
      url: "https://other.example/mcp",
    });
  });

  it("adds caller headers without overwriting existing names", () => {
    const merged = applyBundleMcpCallerContext({
      mcpServers: {
        ext: {
          type: "http",
          url: "http://127.0.0.1:9180/mcp",
          injectCallerContext: true,
        },
        mixed: {
          type: "sse",
          url: "https://api.example/mcp",
          injectCallerContext: true,
          headers: {
            Authorization: "Bearer secret",
            "x-session-key": "user-set-session",
          },
        },
      },
    });

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
});
