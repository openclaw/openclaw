import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "./agent-scope-config.js";
import { loadMergedBundleMcpConfig } from "./bundle-mcp-config.js";
import { parseMcpDockerCommand } from "./mcp-docker-command.js";
import { resolveStdioMcpServerLaunchConfig } from "./mcp-stdio.js";

/** Metadata-only discovery keeps Docker and native identity out of other installations. */
export async function recoverConfiguredMcpDockerServers(
  cfg: OpenClawConfig,
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">,
): Promise<void> {
  const servers: Record<string, unknown>[] = [];
  for (const agentId of listAgentIds(cfg)) {
    const merged = loadMergedBundleMcpConfig({
      cfg,
      manifestRegistry,
      workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    });
    servers.push(...Object.values(merged.config.mcpServers));
  }
  await recoverMcpDockerServers(servers);
}

/** CLI probes recover only the selected definitions, without discovering other registries. */
export async function recoverMcpDockerServers(
  servers: Iterable<Record<string, unknown>>,
): Promise<void> {
  const targets = new Set<string>();
  const tasks: Array<() => Promise<void>> = [];
  for (const raw of servers) {
    if (raw.enabled === false) {
      continue;
    }
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
    tasks.push(async () => {
      const { recoverMcpDockerContainers } = await import("./mcp-docker-custody.js");
      await recoverMcpDockerContainers(parsed.command, env, cwd);
    });
  }
  const { hasError, firstError } = await runTasksWithConcurrency({ tasks, limit: 4 });
  if (hasError) {
    throw firstError;
  }
}
