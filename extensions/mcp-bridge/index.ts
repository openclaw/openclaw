import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createMcpBridgeService, getMcpTools } from "./src/service.js";

const plugin = {
  id: "mcp-bridge",
  name: "MCP Bridge",
  description: "Connect MCP servers and register their tools as native OpenClaw agent tools.",
  register(api: OpenClawPluginApi) {
    // 注册 MCP 连接管理服务
    api.registerService(createMcpBridgeService(api.pluginConfig));

    // 注册工具工厂：返回所有已连接 MCP Server 的工具
    api.registerTool(
      (_ctx) => {
        const tools = getMcpTools();
        return tools.length > 0 ? tools : null;
      },
      { names: ["mcp-bridge"] },
    );
  },
};

export default plugin;
