import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { McpBridgeClient } from "./src/client.js";
import { parseConfig, configSchema } from "./src/config.js";
import { jsonSchemaToTypeBox } from "./src/schema-convert.js";
import type { McpServerConfig } from "./src/types.js";

// Active clients keyed by server name; shared across all tool invocations.
const activeClients = new Map<string, McpBridgeClient>();

async function getOrCreateClient(config: McpServerConfig): Promise<McpBridgeClient> {
  const existing = activeClients.get(config.name);
  if (existing) {
    return existing;
  }
  const client = new McpBridgeClient(config);
  await client.connect();
  activeClients.set(config.name, client);
  return client;
}

const plugin = {
  id: "mcp-bridge",
  name: "MCP Bridge",
  description: "Bridge any MCP server's tools into OpenClaw agent",
  configSchema,

  register(api: OpenClawPluginApi) {
    const raw = api.pluginConfig;
    if (!raw) {
      api.logger.warn("mcp-bridge: no config provided, skipping");
      return;
    }

    let config;
    try {
      config = parseConfig(raw);
    } catch (err) {
      api.logger.error(`mcp-bridge: invalid config: ${String(err)}`);
      return;
    }

    for (const server of config.servers) {
      registerServerTools(api, server);
    }
  },
};

function registerServerTools(api: OpenClawPluginApi, server: McpServerConfig) {
  // Register a tool factory that discovers MCP tools on first use.
  // We use a factory so tool discovery happens per-agent-session, not at plugin
  // load time (the gateway may start before MCP servers are reachable).
  api.registerTool(
    (_ctx) => {
      // We cannot do async work inside the factory, so we return a
      // single dispatcher tool that lazily connects and discovers tools.
      // The dispatcher exposes all MCP tools under a single umbrella tool.
      //
      // Alternative: pre-discover tools synchronously at register time,
      // but that blocks gateway startup and fails if the MCP server is down.
      //
      // The trade-off: agent sees one tool per server instead of N tools.
      // This is simpler and more resilient.
      return {
        name: `mcp_${server.name}`,
        label: `MCP: ${server.name}`,
        description: buildDispatcherDescription(server),
        parameters: jsonSchemaToTypeBox({
          type: "object",
          properties: {
            tool: {
              type: "string",
              description: "Name of the MCP tool to call",
            },
            args: {
              type: "object",
              description: "Arguments to pass to the MCP tool (key-value pairs)",
              additionalProperties: true,
            },
            action: {
              type: "string",
              enum: ["call", "list"],
              description:
                'Action: "call" to invoke a tool (default), "list" to discover available tools',
            },
          },
          required: ["tool"],
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const action = (params.action as string) || "call";
          const client = await getOrCreateClient(server);

          if (action === "list") {
            const tools = await client.listTools();
            return jsonResult({
              server: server.name,
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
              })),
            });
          }

          const toolName = params.tool as string;
          if (!toolName) {
            return jsonResult({ error: "Missing 'tool' parameter" });
          }
          const toolArgs = (params.args as Record<string, unknown>) ?? {};

          try {
            const result = await client.callTool(toolName, toolArgs);
            const text = result.content
              .map((c) => c.text ?? "")
              .filter(Boolean)
              .join("\n");

            if (result.isError) {
              return jsonResult({ error: text || "MCP tool returned an error" });
            }
            // Try to parse as JSON for structured output
            try {
              return jsonResult(JSON.parse(text));
            } catch {
              return jsonResult({ result: text });
            }
          } catch (err) {
            return jsonResult({
              error: `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        },
      };
    },
    { name: `mcp_${server.name}` },
  );

  api.logger.info(
    `mcp-bridge: registered dispatcher tool mcp_${server.name} (${server.type}://${serverDisplayUrl(server)})`,
  );
}

function serverDisplayUrl(server: McpServerConfig): string {
  if (server.type === "stdio") {
    return `${server.command} ${(server.args ?? []).join(" ")}`.trim();
  }
  try {
    const u = new URL(server.url);
    return u.hostname + u.pathname;
  } catch {
    return server.url;
  }
}

function buildDispatcherDescription(server: McpServerConfig): string {
  return (
    `Call tools on the "${server.name}" MCP server. ` +
    `Use action="list" to discover available tools, then action="call" with the tool name and args. ` +
    `Example: { "action": "list" } to list tools, or { "tool": "search_by_mql", "args": { "project_key": "myproject", "moql": "SELECT ..." } } to call a tool.`
  );
}

export default plugin;
