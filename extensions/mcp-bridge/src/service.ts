import type {
  AnyAgentTool,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk";
import { connectMcpServer } from "./client.js";
import { createMcpTools } from "./tools.js";
import type { McpBridgeConfig, McpServerConnection } from "./types.js";

/** 全局存储已注册的 MCP 工具，供 tool factory 使用 */
let registeredTools: AnyAgentTool[] = [];

export function getMcpTools(): AnyAgentTool[] {
  return registeredTools;
}

export function createMcpBridgeService(pluginConfig?: unknown): OpenClawPluginService {
  const connections: McpServerConnection[] = [];

  return {
    id: "mcp-bridge-service",

    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const config = (pluginConfig ?? {}) as McpBridgeConfig;
      const servers = config.servers ?? {};
      const serverEntries = Object.entries(servers);

      if (serverEntries.length === 0) {
        ctx.logger.info("mcp-bridge: no servers configured");
        return;
      }

      const allTools: AnyAgentTool[] = [];

      for (const [name, serverConfig] of serverEntries) {
        if (serverConfig.enabled === false) {
          ctx.logger.info(`mcp-bridge: skipping disabled server "${name}"`);
          continue;
        }

        try {
          ctx.logger.info(
            `mcp-bridge: connecting to "${name}" (${serverConfig.transport}://${serverConfig.url ?? serverConfig.command})`,
          );
          const conn = await connectMcpServer(name, serverConfig);
          connections.push(conn);

          const tools = await createMcpTools(conn);
          allTools.push(...tools);
          ctx.logger.info(`mcp-bridge: "${name}" connected, ${tools.length} tools discovered`);
        } catch (err) {
          ctx.logger.warn(
            `mcp-bridge: failed to connect to "${name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      registeredTools = allTools;
      ctx.logger.info(`mcp-bridge: total ${allTools.length} MCP tools registered`);
    },

    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      registeredTools = [];
      for (const conn of connections) {
        try {
          await conn.close();
        } catch {
          // 关闭时忽略错误
        }
      }
      connections.length = 0;
    },
  };
}
