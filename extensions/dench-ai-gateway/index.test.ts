import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";

describe("dench-ai-gateway composio bridge", () => {
  const originalFetch = globalThis.fetch;
  let workspaceDir: string | undefined;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("strips the raw composio MCP server and registers curated direct tools", async () => {
    workspaceDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-"));
    writeFileSync(
      path.join(workspaceDir, "composio-tool-index.json"),
      JSON.stringify(
        {
          generated_at: "2026-04-02T00:00:00.000Z",
          connected_apps: [
            {
              toolkit_slug: "gmail",
              toolkit_name: "Gmail",
              account_count: 1,
              tools: [
                {
                  name: "GMAIL_FETCH_EMAILS",
                  title: "Fetch emails",
                  description_short: "Fetch recent Gmail messages.",
                  required_args: [],
                  arg_hints: {
                    label_ids: 'Must be an array like ["INBOX"].',
                  },
                  default_args: { label_ids: ["INBOX"], max_results: 10 },
                  input_schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      label_ids: {
                        type: "array",
                        items: { type: "string" },
                      },
                      max_results: {
                        type: "number",
                      },
                    },
                  },
                },
                {
                  name: "GMAIL_SEND_EMAIL",
                  title: "Send email",
                  description_short: "Send a Gmail message.",
                  required_args: ["to", "subject", "body"],
                  arg_hints: {},
                  input_schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      to: { type: "string" },
                      subject: { type: "string" },
                      body: { type: "string" },
                    },
                    required: ["to", "subject", "body"],
                  },
                },
              ],
              recipes: {
                "Read recent emails": "GMAIL_FETCH_EMAILS",
                "Send email": "GMAIL_SEND_EMAIL",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const providers: any[] = [];
    const tools: any[] = [];
    const services: any[] = [];
    const info = vi.fn();

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const payload = JSON.parse(String(init?.body ?? "{}"));
      expect(url).toBe("https://gateway.example.com/v1/composio/mcp");
      expect(payload.method).toBe("tools/call");
      expect(payload.params.name).toBe("GMAIL_FETCH_EMAILS");
      expect(payload.params.arguments).toEqual({
        label_ids: ["INBOX"],
        max_results: 10,
      });

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            structuredContent: {
              messages: [{ id: "m1", subject: "Hello" }],
            },
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const api: any = {
      config: {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        models: {
          providers: {
            "dench-cloud": {
              apiKey: "dc-key",
            },
          },
        },
        mcp: {
          servers: {
            composio: {
              url: "https://gateway.example.com/v1/composio/mcp",
              transport: "streamable-http",
              headers: {
                Authorization: "Bearer dc-key",
              },
            },
          },
        },
        plugins: {
          entries: {
            "dench-ai-gateway": {
              config: {
                enabled: true,
                gatewayUrl: "https://gateway.example.com",
              },
            },
          },
        },
      },
      registerProvider(provider: any) {
        providers.push(provider);
      },
      registerTool(tool: any) {
        tools.push(tool);
      },
      registerService(service: any) {
        services.push(service);
      },
      logger: {
        info,
      },
    };

    register(api);

    expect(providers).toHaveLength(1);
    expect(services).toHaveLength(1);
    expect(tools.map((tool) => tool.name)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_SEND_EMAIL",
    ]);
    expect(api.config.mcp).toBeUndefined();

    const result = await tools[0].execute("call-1", {
      label_ids: ["INBOX"],
      max_results: 10,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      composioBridge: true,
      mcpServer: "composio",
      mcpTool: "GMAIL_FETCH_EMAILS",
    });
    expect(result.content[0]?.text).toContain('"subject": "Hello"');
  });

  it("falls back to a permissive object schema when the index lacks input_schema", () => {
    workspaceDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-"));
    writeFileSync(
      path.join(workspaceDir, "composio-tool-index.json"),
      JSON.stringify(
        {
          generated_at: "2026-04-02T00:00:00.000Z",
          connected_apps: [
            {
              toolkit_slug: "gmail",
              toolkit_name: "Gmail",
              account_count: 1,
              tools: [
                {
                  name: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
                  title: "Fetch message",
                  description_short: "Fetch one Gmail message.",
                  required_args: ["message_id"],
                  arg_hints: {
                    message_id: "Use the Gmail message id.",
                  },
                },
              ],
              recipes: {
                "Read one email": "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const tools: any[] = [];
    const api: any = {
      config: {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        models: {
          providers: {
            "dench-cloud": {
              apiKey: "dc-key",
            },
          },
        },
        plugins: {
          entries: {
            "dench-ai-gateway": {
              config: {
                enabled: true,
                gatewayUrl: "https://gateway.example.com",
              },
            },
          },
        },
      },
      registerProvider() {},
      registerTool(tool: any) {
        tools.push(tool);
      },
      registerService() {},
      logger: {
        info: vi.fn(),
      },
    };

    register(api);

    expect(tools).toHaveLength(1);
    expect(tools[0].parameters).toMatchObject({
      type: "object",
      additionalProperties: true,
      required: ["message_id"],
      properties: {
        message_id: {
          description: "Use the Gmail message id.",
        },
      },
    });
  });
});
