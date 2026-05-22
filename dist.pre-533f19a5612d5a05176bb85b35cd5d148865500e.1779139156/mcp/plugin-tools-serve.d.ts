import { i as OpenClawConfig } from "../types.openclaw-Bpxi7OSY.js";
import { r as AnyAgentTool } from "../common-BHDf_7WT.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

//#region src/mcp/plugin-tools-serve.d.ts
declare function createPluginToolsMcpServer(params?: {
  config?: OpenClawConfig;
  tools?: AnyAgentTool[];
}): Server;
declare function servePluginToolsMcp(): Promise<void>;
//#endregion
export { createPluginToolsMcpServer, servePluginToolsMcp };