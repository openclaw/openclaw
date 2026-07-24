import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import {
  createCodexNativeMcpAppResultDetailsPreparer,
  readMcpToolResult,
} from "./native-mcp-app.js";

function createAttempt(enabled = true): EmbeddedRunAttemptParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:dashboard:thread-1",
    workspaceDir: "/tmp/workspace",
    config: enabled ? { mcp: { apps: { enabled: true } } } : {},
  } as EmbeddedRunAttemptParams;
}

describe("Codex native MCP Apps", () => {
  it("uses the active Codex thread for inventory and app resources", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            {
              name: "doordash",
              tools: {
                show_options: { description: "Show nearby options", inputSchema: {} },
                show_menu: { description: "Show a restaurant menu", inputSchema: {} },
              },
            },
          ],
        };
      }
      if (method === "mcpServer/resource/read") {
        return {
          contents: [
            {
              uri: params.uri,
              mimeType: "text/html;profile=mcp-app",
              text: "<html><body>DoorDash</body></html>",
            },
          ],
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const prepare = createCodexNativeMcpAppResultDetailsPreparer({
      client: { request, getInstanceId: () => "client-1" } as unknown as CodexAppServerClient,
      threadId: "thread-1",
      attempt: createAttempt(),
    });

    const details = await prepare?.({
      id: "call-options",
      type: "mcpToolCall",
      server: "doordash",
      tool: "show_options",
      status: "completed",
      appContext: { connectorId: "doordash", resourceUri: "ui://doordash/options.html" },
      arguments: { limit: 4 },
      result: {
        content: [{ type: "text", text: "Found four restaurants." }],
        structuredContent: { stores: [{ id: "store-1" }] },
        _meta: null,
      },
    } as never);
    expect(details).toMatchObject({
      mcpAppPreview: {
        kind: "canvas",
        view: { id: expect.stringMatching(/^mcp-app-/u), title: "show_options UI" },
        mcpApp: {
          serverName: "doordash",
          toolName: "show_options",
          uiResourceUri: "ui://doordash/options.html",
          toolCallId: "call-options",
          originSessionKey: "agent:main:dashboard:thread-1",
        },
      },
    });
    expect(request).toHaveBeenCalledWith("mcpServerStatus/list", {
      threadId: "thread-1",
      detail: "full",
    });
    expect(request).toHaveBeenCalledWith("mcpServer/resource/read", {
      threadId: "thread-1",
      server: "doordash",
      uri: "ui://doordash/options.html",
    });
  });

  it("omits null result metadata before MCP App schema validation", () => {
    expect(
      readMcpToolResult({
        result: {
          content: [{ type: "text", text: "Found four restaurants." }],
          structuredContent: { stores: [{ id: "store-1" }] },
          _meta: null,
        },
      } as never),
    ).toEqual({
      content: [{ type: "text", text: "Found four restaurants." }],
      structuredContent: { stores: [{ id: "store-1" }] },
    });
  });

  it("does not prepare native app views unless MCP Apps are enabled", () => {
    expect(
      createCodexNativeMcpAppResultDetailsPreparer({
        client: {} as CodexAppServerClient,
        threadId: "thread-1",
        attempt: createAttempt(false),
      }),
    ).toBeUndefined();
  });
});
