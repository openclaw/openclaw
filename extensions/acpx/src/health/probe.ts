import { DEFAULT_AGENT_NAME, resolveAgentCommand } from "../agents/registry.js";
import type { ResolvedAcpxPluginConfig } from "../config.js";
import type { McpServer } from "../runtime-types.js";
import { AcpClient } from "../transport/acp-client.js";

export type RuntimeHealthReport = {
  ok: boolean;
  message: string;
  details?: string[];
};

function toSdkMcpServers(config: ResolvedAcpxPluginConfig): McpServer[] {
  return Object.entries(config.mcpServers).map(([name, server]) => ({
    name,
    command: server.command,
    args: [...(server.args ?? [])],
    env: Object.entries(server.env ?? {}).map(([envName, value]) => ({
      name: envName,
      value,
    })),
  }));
}

function resolveProbeAgentName(config: ResolvedAcpxPluginConfig): string {
  return DEFAULT_AGENT_NAME;
}

export async function probeEmbeddedRuntime(
  config: ResolvedAcpxPluginConfig,
): Promise<RuntimeHealthReport> {
  const agentName = resolveProbeAgentName(config);
  const agentCommand = resolveAgentCommand(agentName, config.agents);
  const client = new AcpClient({
    agentCommand,
    cwd: config.cwd,
    mcpServers: toSdkMcpServers(config),
    permissionMode: config.permissionMode,
    nonInteractivePermissions: config.nonInteractivePermissions,
    verbose: false,
  });

  try {
    await client.start();
    return {
      ok: true,
      message: "embedded ACP runtime ready",
      details: [
        `agent=${agentName}`,
        `command=${agentCommand}`,
        `cwd=${config.cwd}`,
        `stateDir=${config.stateDir}`,
        ...(client.initializeResult?.protocolVersion
          ? [`protocolVersion=${client.initializeResult.protocolVersion}`]
          : []),
      ],
    };
  } catch (error) {
    return {
      ok: false,
      message: "embedded ACP runtime probe failed",
      details: [
        `agent=${agentName}`,
        `command=${agentCommand}`,
        `cwd=${config.cwd}`,
        `stateDir=${config.stateDir}`,
        error instanceof Error ? error.message : String(error),
      ],
    };
  } finally {
    await client.close().catch(() => {});
  }
}
