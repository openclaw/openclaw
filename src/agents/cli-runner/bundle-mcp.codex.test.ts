import { describe, expect, it } from "vitest";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

describe("prepareCliBundleMcpConfig codex", () => {
  it("injects codex MCP config overrides with env-backed loopback headers", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "codex-config-overrides",
      backend: {
        command: "codex",
        args: ["exec", "--json"],
        resumeArgs: ["exec", "resume", "{sessionId}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-codex",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
            },
          },
        },
      },
    });

    expect(prepared.backend.args).toEqual([
      "exec",
      "--json",
      "-c",
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", default_tools_approval_mode = "approve", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY" } } }',
    ]);
    expect(prepared.backend.resumeArgs).toEqual([
      "exec",
      "resume",
      "{sessionId}",
      "-c",
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", default_tools_approval_mode = "approve", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY" } } }',
    ]);
    expect(prepared.cleanup).toBeUndefined();
  });

  it("adds env_http_headers for caller context when the openclaw server opts in", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "codex-config-overrides",
      backend: {
        command: "codex",
        args: ["exec", "--json"],
        resumeArgs: ["exec", "resume", "{sessionId}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-codex-caller",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            injectCallerContext: true,
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
            },
          },
        },
      },
    });

    const withCaller =
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", default_tools_approval_mode = "approve", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY", x-openclaw-account-id = "OPENCLAW_MCP_ACCOUNT_ID", x-openclaw-agent-id = "OPENCLAW_MCP_AGENT_ID", x-openclaw-message-channel = "OPENCLAW_MCP_MESSAGE_CHANNEL" } } }';
    expect(prepared.backend.args).toEqual(["exec", "--json", "-c", withCaller]);
    expect(prepared.backend.resumeArgs).toEqual(["exec", "resume", "{sessionId}", "-c", withCaller]);
  });
});
