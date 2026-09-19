/** Scopes OpenClaw-managed tool MCP servers to the ACP session that launches them. */
import type { AcpRuntimeOptions } from "acpx/runtime";

type AcpxMcpServers = Extract<NonNullable<AcpRuntimeOptions["mcpServers"]>, unknown[]>;
type AcpxMcpServer = AcpxMcpServers[number];

const ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME = "openclaw-plugin-tools";
const ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME = "openclaw-tools";
const OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV = "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY";

export function withManagedToolsMcpSessionEnv(params: {
  pluginToolsEnabled: boolean;
  openclawToolsEnabled: boolean;
  mcpServers: AcpxMcpServers;
  sessionKey: string;
  agentId?: string;
}): AcpxMcpServers {
  const sessionKey = params.sessionKey.trim();
  if (
    (!params.pluginToolsEnabled && !params.openclawToolsEnabled) ||
    !sessionKey ||
    !params.mcpServers?.length
  ) {
    return params.mcpServers;
  }
  let changed = false;
  const nextServers = params.mcpServers.map((server): AcpxMcpServer => {
    const isManagedPluginTools =
      params.pluginToolsEnabled && server.name === ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME;
    const isManagedOpenClawTools =
      params.openclawToolsEnabled && server.name === ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME;
    if ((!isManagedPluginTools && !isManagedOpenClawTools) || !("command" in server)) {
      return server;
    }
    changed = true;
    const env = [
      ...server.env.filter((entry) => entry.name !== OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV),
      {
        name: OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
        value: sessionKey,
      },
    ];
    return {
      ...server,
      env,
      args: params.agentId ? [...server.args, "--openclaw-agent-id", params.agentId] : server.args,
    };
  });
  return changed ? nextServers : params.mcpServers;
}
