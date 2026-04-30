import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

describe("prepareCliBundleMcpConfig gemini", () => {
  it("writes Gemini system settings for bundle MCP servers", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-gemini",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
      env: {
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
      },
    });

    expect(prepared.backend.args).toEqual(["--prompt", "{prompt}"]);
    expect(prepared.env?.OPENCLAW_MCP_TOKEN).toBe("loopback-token-123");
    expect(typeof prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe("string");
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as {
      mcp?: { allowed?: string[] };
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(raw.mcp?.allowed).toEqual(["openclaw"]);
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer loopback-token-123");
    expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-agent-id"]).toBeUndefined();
    expect(raw.mcpServers?.openclaw?.headers?.["x-session-key"]).toBeUndefined();

    await prepared.cleanup?.();
  });

  it("translates user mcp.servers transport fields in Gemini system settings", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-gemini",
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            context7: {
              transport: "streamable-http",
              url: "https://mcp.context7.com/mcp",
              headers: {
                Authorization: "Bearer ${CONTEXT7_API_KEY}",
              },
            },
          },
        },
      },
      env: {
        CONTEXT7_API_KEY: "ctx7-test",
      },
    });

    expect(prepared.env?.CONTEXT7_API_KEY).toBe("ctx7-test");
    expect(typeof prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe("string");
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as {
      mcp?: { allowed?: string[] };
      mcpServers?: Record<
        string,
        { type?: string; transport?: string; url?: string; headers?: Record<string, string> }
      >;
    };
    expect(raw.mcp?.allowed).toEqual(["context7"]);
    expect(raw.mcpServers?.context7?.type).toBe("http");
    expect(raw.mcpServers?.context7?.transport).toBeUndefined();
    expect(raw.mcpServers?.context7?.url).toBe("https://mcp.context7.com/mcp");
    expect(raw.mcpServers?.context7?.headers?.Authorization).toBe("Bearer ctx7-test");
    expect(raw.mcpServers?.context7?.headers?.["x-openclaw-agent-id"]).toBeUndefined();

    await prepared.cleanup?.();
  });

  it("resolves injected caller headers when the openclaw server opts in", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-gemini-caller",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            injectCallerContext: true,
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
      env: {
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
        OPENCLAW_MCP_AGENT_ID: "agent-main",
        OPENCLAW_MCP_SESSION_KEY: "sess-1",
      },
    });

    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as {
      mcpServers?: Record<string, { headers?: Record<string, string> }>;
    };
    expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-agent-id"]).toBe("agent-main");
    expect(raw.mcpServers?.openclaw?.headers?.["x-session-key"]).toBe("sess-1");

    await prepared.cleanup?.();
  });
});
