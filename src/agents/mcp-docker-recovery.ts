import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "./agent-scope-config.js";
import { loadMergedBundleMcpConfig } from "./bundle-mcp-config.js";
import { parseMcpDockerCommand } from "./mcp-docker-command.js";
import { resolveStdioMcpServerLaunchConfig } from "./mcp-stdio.js";

/** Metadata-only discovery keeps Docker and native identity out of other installations. */
export async function recoverConfiguredMcpDockerServers(
  cfg: OpenClawConfig,
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">,
): Promise<void> {
  const targets = new Set<string>();
  for (const agentId of listAgentIds(cfg)) {
    const merged = loadMergedBundleMcpConfig({
      cfg,
      manifestRegistry,
      workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    });
    for (const raw of Object.values(merged.config.mcpServers)) {
      const launch = resolveStdioMcpServerLaunchConfig(raw);
      if (!launch.ok) {
        continue;
      }
      const parsed = parseMcpDockerCommand(launch.config.command, launch.config.args);
      if (parsed.kind !== "docker") {
        continue;
      }
      const { env, cwd } = launch.config;
      const key = JSON.stringify([parsed.command, env, cwd]);
      if (targets.has(key)) {
        continue;
      }
      targets.add(key);
      const { recoverMcpDockerContainers } = await import("./mcp-docker-custody.js");
      await recoverMcpDockerContainers(parsed.command, env, cwd);
    }
  }
}
