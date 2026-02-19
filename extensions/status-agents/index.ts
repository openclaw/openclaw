import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  AgentStatusEntry,
  AgentStatusResult,
  AgentStatusError,
  AgentStatusSummary,
} from "../../src/ai-fabric/agent-status.js";
import type {
  McpStatusEntry,
  McpStatusResult,
  McpStatusError,
  McpStatusSummary,
} from "../../src/ai-fabric/mcp-status.js";
import { getAgentStatus } from "../../src/ai-fabric/agent-status.js";
import { getMcpServerStatus } from "../../src/ai-fabric/mcp-status.js";

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

export function formatSummaryLine(
  agentSummary: AgentStatusSummary,
  mcpSummary: McpStatusSummary,
): string {
  const agentParts: string[] = [];
  if (agentSummary.healthy > 0) agentParts.push(`${agentSummary.healthy} healthy`);
  if (agentSummary.degraded > 0) agentParts.push(`${agentSummary.degraded} degraded`);
  if (agentSummary.failed > 0) agentParts.push(`${agentSummary.failed} failed`);
  if (agentSummary.unknown > 0) agentParts.push(`${agentSummary.unknown} unknown`);

  const agentDetail = agentParts.length > 0 ? ` (${agentParts.join(", ")})` : "";
  return `Summary: ${agentSummary.total} agents${agentDetail} | ${mcpSummary.total} MCP servers`;
}

export function formatTips(agentEntries: AgentStatusEntry[], mcpEntries: McpStatusEntry[]): string {
  const tips: string[] = [];
  const hasCooled =
    agentEntries.some((e) => e.status === "COOLED") ||
    mcpEntries.some((e) => e.status === "COOLED");
  const hasFailed =
    agentEntries.some((e) => e.health === "failed") ||
    mcpEntries.some((e) => e.health === "failed");

  if (hasCooled) {
    tips.push("\u23F8 Cooled resources wake up automatically on the first request.");
  }
  if (hasFailed) {
    tips.push("\u2717 Failed resources need attention in the Cloud.ru console.");
  }
  return tips.join("\n");
}

export function formatStatusOutput(
  agentResult: AgentStatusResult | AgentStatusError,
  mcpResult: McpStatusResult | McpStatusError,
): string {
  const sections: string[] = [];

  // Agent section
  if (!agentResult.ok) {
    sections.push(`Agents: error \u2014 ${agentResult.error}`);
  } else {
    sections.push(formatAgentsSection(agentResult.entries));
  }

  // MCP section
  if (!mcpResult.ok) {
    sections.push(`MCP Servers: error \u2014 ${mcpResult.error}`);
  } else {
    sections.push(formatMcpSection(mcpResult.entries));
  }

  // Summary (only if both succeeded)
  if (agentResult.ok && mcpResult.ok) {
    sections.push(formatSummaryLine(agentResult.summary, mcpResult.summary));

    const tips = formatTips(agentResult.entries, mcpResult.entries);
    if (tips) {
      sections.push(tips);
    }
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export default function register(api: OpenClawPluginApi) {
  api.registerCommand({
    name: "status-agents",
    description: "Check the live status of Cloud.ru AI Fabric agents and MCP servers.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const aiFabric = ctx.config.aiFabric;

      if (!aiFabric?.enabled) {
        return {
          text: "AI Fabric is not enabled. Run `openclaw onboard` to configure.",
        };
      }

      const projectId = aiFabric.projectId ?? "";
      const keyId = aiFabric.keyId ?? "";
      const secret = process.env.CLOUDRU_IAM_SECRET ?? "";

      if (!projectId || !keyId || !secret) {
        return {
          text: "AI Fabric credentials incomplete. Ensure aiFabric.projectId, aiFabric.keyId, and CLOUDRU_IAM_SECRET are set.",
        };
      }

      const nameFilter = ctx.args?.trim() || undefined;
      const authParams = { keyId, secret };

      const [agentResult, mcpResult] = await Promise.all([
        getAgentStatus({
          projectId,
          auth: authParams,
          configuredAgents: aiFabric.agents ?? [],
          nameFilter,
        }),
        getMcpServerStatus({
          projectId,
          auth: authParams,
          nameFilter,
        }),
      ]);

      return { text: formatStatusOutput(agentResult, mcpResult) };
    },
  });
}
