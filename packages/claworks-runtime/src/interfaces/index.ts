export { createClaworksRestHandler } from "./rest/router.js";
export {
  resolveAuthContext,
  checkRbac,
  checkClaworksApiAuth,
  type AuthContext,
} from "./rest/auth.js";
export { serveClaworksStudio } from "./rest/studio.js";
export { badRequest, notFound, parsePath, readJsonBody, sendJson } from "./rest/http-utils.js";

export { buildA2aAgentCard, A2aClient, createA2aHttpHandler, A2aTaskStore } from "./a2a/index.js";
export type * from "./a2a/types.js";

export { createMcpHttpHandler } from "./mcp/server.js";
export { CLAWORKS_MCP_TOOLS, callClaworksMcpTool, type McpToolDef } from "./mcp/tools.js";

export { ConnectorManager, type ConnectorEventHandler } from "./connectors/connector-manager.js";
export { resolveConnectorConfigs, type ConnectorConfigInput } from "./connectors/presets.js";
export type * from "./connectors/types.js";

export { scanNexusCatalog, extractPackBuffer } from "./nexus/catalog.js";
export { createNexusServer } from "./nexus/server.js";
export type * from "./nexus/types.js";
