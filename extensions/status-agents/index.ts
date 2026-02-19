import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  AgentStatusEntry,
  AgentStatusResult,
  AgentStatusError,
  AgentStatusSummary,
} from "../../src/ai-fabric/agent-status.js";
import type {
  AgentSystemStatusEntry,
  AgentSystemStatusResult,
  AgentSystemStatusError,
  AgentSystemStatusSummary,
} from "../../src/ai-fabric/agent-system-status.js";
import type {
  McpStatusEntry,
  McpStatusResult,
  McpStatusError,
  McpStatusSummary,
} from "../../src/ai-fabric/mcp-status.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import { getAgentStatus } from "../../src/ai-fabric/agent-status.js";
import { getAgentSystemStatus } from "../../src/ai-fabric/agent-system-status.js";
import { getMcpServerStatus } from "../../src/ai-fabric/mcp-status.js";
import { resolveIamSecret } from "../../src/ai-fabric/resolve-iam-secret.js";

// ---------------------------------------------------------------------------
// Health icons — reusable mapping
// ---------------------------------------------------------------------------

const HEALTH_ICON: Record<string, string> = {
  healthy: "\u2713",
  degraded: "\u23F8",
  failed: "\u2717",
  unknown: "?",
};

function healthIcon(health: string): string {
  return HEALTH_ICON[health] ?? "?";
}

// ---------------------------------------------------------------------------
// Formatting — modular, testable, reusable across channels
// ---------------------------------------------------------------------------

export function formatAgentEntry(entry: AgentStatusEntry): string {
  const icon = healthIcon(entry.health);
  const name = entry.name.padEnd(24);
  const status = entry.status.padEnd(12);
  const shortId = entry.id.slice(0, 8);
  return `  ${icon} ${name} ${status} ${shortId}`;
}

export function formatMcpEntry(entry: McpStatusEntry): string {
  const icon = healthIcon(entry.health);
  const name = entry.name.padEnd(24);
  const status = entry.status.padEnd(12);
  const toolNames = entry.tools.map((t) => t.name);
  const toolsDisplay =
    toolNames.length <= 3
      ? toolNames.join(", ")
      : `${toolNames.slice(0, 3).join(", ")}, +${toolNames.length - 3} more`;
  return `  ${icon} ${name} ${status} ${toolsDisplay || "(no tools)"}`;
}

export function formatAgentSystemEntry(entry: AgentSystemStatusEntry): string {
  const icon = healthIcon(entry.health);
  const name = entry.name.padEnd(24);
  const status = entry.status.padEnd(12);
  const members = entry.memberCount === 1 ? "1 agent" : `${entry.memberCount} agents`;
  return `  ${icon} ${name} ${status} ${members}`;
}

export function formatAgentsSection(entries: AgentStatusEntry[]): string {
  if (entries.length === 0) return "Agents (0)\n  No agents found.";
  const lines = [`Agents (${entries.length})`];
  for (const entry of entries) {
    lines.push(formatAgentEntry(entry));
  }
  return lines.join("\n");
}

export function formatMcpSection(entries: McpStatusEntry[]): string {
  if (entries.length === 0) return "MCP Servers (0)\n  No MCP servers found.";
  const lines = [`MCP Servers (${entries.length})`];
  for (const entry of entries) {
    lines.push(formatMcpEntry(entry));
  }
  return lines.join("\n");
}

export function formatAgentSystemsSection(entries: AgentSystemStatusEntry[]): string {
  if (entries.length === 0) return "Agent Systems (0)\n  No agent systems found.";
  const lines = [`Agent Systems (${entries.length})`];
  for (const entry of entries) {
    lines.push(formatAgentSystemEntry(entry));
  }
  return lines.join("\n");
}

export function formatSummaryLine(
  agentSummary: AgentStatusSummary,
  mcpSummary: McpStatusSummary,
  systemSummary?: AgentSystemStatusSummary,
): string {
  const agentParts: string[] = [];
  if (agentSummary.healthy > 0) agentParts.push(`${agentSummary.healthy} healthy`);
  if (agentSummary.degraded > 0) agentParts.push(`${agentSummary.degraded} degraded`);
  if (agentSummary.failed > 0) agentParts.push(`${agentSummary.failed} failed`);
  if (agentSummary.unknown > 0) agentParts.push(`${agentSummary.unknown} unknown`);

  const agentDetail = agentParts.length > 0 ? ` (${agentParts.join(", ")})` : "";
  let line = `Summary: ${agentSummary.total} agents${agentDetail} | ${mcpSummary.total} MCP servers`;
  if (systemSummary && systemSummary.total > 0) {
    line += ` | ${systemSummary.total} agent systems`;
  }
  return line;
}

export function formatTips(
  agentEntries: AgentStatusEntry[],
  mcpEntries: McpStatusEntry[],
  systemEntries?: AgentSystemStatusEntry[],
): string {
  const tips: string[] = [];
  const hasCooled =
    agentEntries.some((e) => e.status === "COOLED") ||
    mcpEntries.some((e) => e.status === "COOLED") ||
    (systemEntries?.some((e) => e.status === "COOLED") ?? false);
  const hasFailed =
    agentEntries.some((e) => e.health === "failed") ||
    mcpEntries.some((e) => e.health === "failed") ||
    (systemEntries?.some((e) => e.health === "failed") ?? false);

  if (hasCooled) {
    tips.push("\u23F8 Cooled resources wake up automatically on the first request.");
  }
  if (hasFailed) {
    tips.push("\u2717 Failed resources need attention in the Cloud.ru console.");
  }
  return tips.join("\n");
}

/**
 * Filter out deleted/deleting agents for display purposes.
 * agent-status.ts deliberately keeps them for drift detection,
 * but the user-facing output should only show active resources.
 */
function filterActiveAgents(entries: AgentStatusEntry[]): AgentStatusEntry[] {
  return entries.filter((e) => e.status !== "DELETED" && e.status !== "ON_DELETION");
}

function buildAgentSummary(entries: AgentStatusEntry[]): AgentStatusSummary {
  const summary: AgentStatusSummary = { total: 0, healthy: 0, degraded: 0, failed: 0, unknown: 0 };
  for (const entry of entries) {
    summary.total++;
    summary[entry.health]++;
  }
  return summary;
}

export function formatStatusOutput(
  agentResult: AgentStatusResult | AgentStatusError,
  mcpResult: McpStatusResult | McpStatusError,
  systemResult?: AgentSystemStatusResult | AgentSystemStatusError,
): string {
  const sections: string[] = [];

  // Agent section (filter out deleted)
  let activeAgents: AgentStatusEntry[] = [];
  let agentSummary: AgentStatusSummary | undefined;
  if (!agentResult.ok) {
    sections.push(`Agents: error \u2014 ${agentResult.error}`);
  } else {
    activeAgents = filterActiveAgents(agentResult.entries);
    agentSummary = buildAgentSummary(activeAgents);
    sections.push(formatAgentsSection(activeAgents));
  }

  // MCP section (already filtered by service)
  if (!mcpResult.ok) {
    sections.push(`MCP Servers: error \u2014 ${mcpResult.error}`);
  } else {
    sections.push(formatMcpSection(mcpResult.entries));
  }

  // Agent Systems section
  let systemEntries: AgentSystemStatusEntry[] = [];
  let systemSummary: AgentSystemStatusSummary | undefined;
  if (systemResult) {
    if (!systemResult.ok) {
      sections.push(`Agent Systems: error \u2014 ${systemResult.error}`);
    } else {
      systemEntries = systemResult.entries;
      systemSummary = systemResult.summary;
      sections.push(formatAgentSystemsSection(systemEntries));
    }
  }

  // Summary (only if agents + MCP succeeded)
  if (agentResult.ok && mcpResult.ok && agentSummary) {
    sections.push(formatSummaryLine(agentSummary, mcpResult.summary, systemSummary));

    const tips = formatTips(activeAgents, mcpResult.entries, systemEntries);
    if (tips) {
      sections.push(tips);
    }
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Connection status formatting
// ---------------------------------------------------------------------------

export function formatConnectionStatus(status: {
  connected: boolean;
  mcpServers: number;
  skills: number;
  commands: number;
}): string {
  const icon = status.connected ? "\u2713" : "\u2717";
  const label = status.connected ? "Connected" : "Disconnected";
  const lines = [`Bot connection: ${icon} ${label}`];

  if (status.connected) {
    lines.push(`  ${status.mcpServers} MCP servers in settings.json`);
    lines.push(`  ${status.skills} fabric skills`);
    lines.push(`  ${status.commands} synced commands`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared credential validation
// ---------------------------------------------------------------------------

type FabricCredentials = {
  projectId: string;
  keyId: string;
  secret: string;
};

function validateFabricCredentials(config: {
  aiFabric?: { enabled?: boolean; projectId?: string; keyId?: string };
}): { ok: true; creds: FabricCredentials } | { ok: false; text: string } {
  const aiFabric = config.aiFabric;

  if (!aiFabric?.enabled) {
    return { ok: false, text: "AI Fabric is not enabled. Run `openclaw onboard` to configure." };
  }

  const projectId = aiFabric.projectId ?? "";
  const keyId = aiFabric.keyId ?? "";
  const secret = resolveIamSecret();

  if (!projectId || !keyId || !secret) {
    return {
      ok: false,
      text: "AI Fabric credentials incomplete. Ensure aiFabric.projectId, aiFabric.keyId, and CLOUDRU_IAM_SECRET are set.",
    };
  }

  return { ok: true, creds: { projectId, keyId, secret } };
}

async function resolveWorkspaceDir(config: OpenClawConfig): Promise<string> {
  const { resolveAgentWorkspaceDir, resolveDefaultAgentId } =
    await import("../../src/agents/agent-scope.js");
  return resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export default function register(api: OpenClawPluginApi) {
  // /status_agents — read-only status display
  api.registerCommand({
    name: "status_agents",
    description:
      "Check the live status of Cloud.ru AI Fabric agents, MCP servers, and agent systems.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const validation = validateFabricCredentials(ctx.config);
      if (!validation.ok) return { text: validation.text };

      const { projectId, keyId, secret } = validation.creds;
      const nameFilter = ctx.args?.trim() || undefined;
      const authParams = { keyId, secret };

      const workspaceDir = await resolveWorkspaceDir(ctx.config);

      const { getFabricConnectionStatus } =
        await import("../../src/ai-fabric/sync-fabric-resources.js");

      const [agentResult, mcpResult, systemResult, connStatus] = await Promise.all([
        getAgentStatus({
          projectId,
          auth: authParams,
          configuredAgents: ctx.config.aiFabric?.agents ?? [],
          nameFilter,
        }),
        getMcpServerStatus({ projectId, auth: authParams, nameFilter }),
        getAgentSystemStatus({ projectId, auth: authParams, nameFilter }),
        getFabricConnectionStatus({ workspaceDir }),
      ]);

      const cloudStatus = formatStatusOutput(agentResult, mcpResult, systemResult);
      const localStatus = formatConnectionStatus(connStatus);

      const text =
        cloudStatus +
        "\n\n" +
        localStatus +
        "\n\nRun /agents_on to connect, /agents_off to disconnect.";

      return { text };
    },
  });

  // /agents_on — connect: sync MCP + skills + commands
  api.registerCommand({
    name: "agents_on",
    description: "Connect AI Fabric: sync MCP servers, skills, and commands to Claude CLI.",
    handler: async (ctx) => {
      const validation = validateFabricCredentials(ctx.config);
      if (!validation.ok) return { text: validation.text };

      const { projectId, keyId, secret } = validation.creds;
      const authParams = { keyId, secret };
      const workspaceDir = await resolveWorkspaceDir(ctx.config);

      const { syncFabricResources } = await import("../../src/ai-fabric/sync-fabric-resources.js");

      const result = await syncFabricResources({
        config: ctx.config,
        workspaceDir,
        projectId,
        auth: authParams,
      });

      if (!result.ok) {
        return { text: `AI Fabric connect failed: ${result.error}` };
      }

      const lines = ["AI Fabric connected:"];
      lines.push(`  \u2713 ${result.mcpServers} MCP servers synced to Claude CLI`);
      lines.push(`  \u2713 ${result.skills} skills generated`);
      lines.push("");
      lines.push("Run /status_agents to check status.");

      return { text: lines.join("\n") };
    },
  });

  // /agents_off — disconnect: remove MCP + skills + commands
  api.registerCommand({
    name: "agents_off",
    description: "Disconnect AI Fabric: remove MCP servers, skills, and commands from Claude CLI.",
    handler: async (ctx) => {
      const validation = validateFabricCredentials(ctx.config);
      if (!validation.ok) return { text: validation.text };

      const workspaceDir = await resolveWorkspaceDir(ctx.config);

      const { disconnectFabricResources } =
        await import("../../src/ai-fabric/sync-fabric-resources.js");

      const result = await disconnectFabricResources({
        workspaceDir,
        config: ctx.config,
      });

      const lines = ["AI Fabric disconnected:"];
      lines.push(`  \u2717 ${result.mcpRemoved} MCP servers removed`);
      lines.push(`  \u2717 ${result.skillsCleaned} skills cleaned`);
      lines.push(`  \u2717 ${result.commandsCleaned} commands removed`);
      lines.push("");
      lines.push("Run /agents_on to reconnect.");

      return { text: lines.join("\n") };
    },
  });
}
