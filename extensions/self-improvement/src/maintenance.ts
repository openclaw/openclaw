/**
 * Loop 4: Maintenance Pass
 *
 * Every N sessions, aggregate telemetry and reflections to produce
 * actionable proposals for human review.
 *
 * This is the ONLY loop that proposes systemic changes.
 * Proposals are ALWAYS human-gated, never auto-deployed.
 *
 * Exposed as a tool so the agent (or user) can trigger it explicitly.
 */
import type { AnyAgentTool, BotPluginApi } from "bot/plugin-sdk";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface MaintenanceProposal {
  id: string;
  type: "new_tool" | "tool_improvement" | "skill_update" | "config_change" | "prompt_update";
  priority: "high" | "medium" | "low";
  title: string;
  evidence: string;
  proposed_change: string;
  expected_impact: string;
  risk: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

interface MaintenanceReport {
  generated_at: string;
  sessions_analyzed: number;
  total_tool_calls: number;
  overall_success_rate: number;
  top_failures: Array<{
    tool_id: string;
    failure_mode: string;
    total_count: number;
    across_sessions: number;
  }>;
  proposals: MaintenanceProposal[];
}

export function createMaintenanceTool(api: BotPluginApi): AnyAgentTool {
  const baseDir = api.resolvePath("~/.hanzo/bot/self-improvement");

  return {
    name: "self_improvement_maintenance",
    label: "Self Improvement Maintenance",
    description:
      "Run a maintenance pass analyzing recent session telemetry and reflections. " +
      "Produces prioritized proposals for improving tool reliability, adding new tools, " +
      "or updating skills. Proposals require human approval before implementation. " +
      "Use when the user asks to review agent performance or improve capabilities.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["analyze", "list_proposals", "approve", "reject"],
          description:
            "analyze: generate new proposals from recent sessions. " +
            "list_proposals: show pending proposals. " +
            "approve/reject: act on a proposal by ID.",
        },
        proposal_id: {
          type: "string",
          description: "Proposal ID for approve/reject actions",
        },
        sessions: {
          type: "number",
          description: "Number of recent sessions to analyze (default: 5)",
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: any) {
      const action = params.action as string;

      switch (action) {
        case "analyze":
          return analyzeAndPropose(baseDir, params.sessions ?? 5);
        case "list_proposals":
          return listProposals(baseDir);
        case "approve":
          return updateProposal(baseDir, params.proposal_id, "approved");
        case "reject":
          return updateProposal(baseDir, params.proposal_id, "rejected");
        default:
          return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
      }
    },
  } as AnyAgentTool;
}

async function analyzeAndPropose(baseDir: string, sessionCount: number) {
  const reflectionsDir = join(baseDir, "reflections");
  const proposalsDir = join(baseDir, "proposals");

  if (!existsSync(proposalsDir)) {
    mkdirSync(proposalsDir, { recursive: true });
  }

  // Load recent reflections
  let reflections: any[] = [];
  if (existsSync(reflectionsDir)) {
    const files = readdirSync(reflectionsDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, sessionCount);

    reflections = files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(reflectionsDir, f), "utf-8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  if (reflections.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No session reflections found. Run some sessions first, then try again.",
        },
      ],
    };
  }

  // Aggregate failure patterns across sessions
  const failureAgg = new Map<
    string,
    { tool_id: string; failure_mode: string; total: number; sessions: number }
  >();
  let totalCalls = 0;
  let totalSuccesses = 0;

  for (const ref of reflections) {
    for (const worked of ref.what_worked ?? []) {
      totalCalls += worked.calls;
      totalSuccesses += Math.round(worked.calls * worked.success_rate);
    }
    for (const failed of ref.what_failed ?? []) {
      const key = `${failed.tool_id}:${failed.failure_mode}`;
      const agg = failureAgg.get(key) ?? {
        tool_id: failed.tool_id,
        failure_mode: failed.failure_mode,
        total: 0,
        sessions: 0,
      };
      agg.total += failed.count;
      agg.sessions++;
      failureAgg.set(key, agg);
      totalCalls += failed.count;
    }
  }

  const overallRate = totalCalls > 0 ? totalSuccesses / totalCalls : 1;

  // Generate proposals from aggregated failures
  const proposals: MaintenanceProposal[] = [];
  const sortedFailures = Array.from(failureAgg.values()).sort((a, b) => b.total - a.total);

  for (const failure of sortedFailures.slice(0, 5)) {
    const priority = failure.total >= 10 ? "high" : failure.total >= 5 ? "medium" : "low";

    proposals.push({
      id: `prop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: failure.total >= 8 ? "new_tool" : "tool_improvement",
      priority,
      title: `${failure.total >= 8 ? "Build" : "Improve"} handling for ${failure.tool_id} ${failure.failure_mode} failures`,
      evidence: `${failure.tool_id} failed ${failure.total}x with ${failure.failure_mode} across ${failure.sessions} sessions`,
      proposed_change:
        failure.total >= 8
          ? `Create a specific tool replacing generic ${failure.tool_id} for the ${failure.failure_mode} pattern`
          : `Add ${failure.failure_mode} error handling or retry logic to ${failure.tool_id}`,
      expected_impact: `Reduce ${failure.failure_mode} failures on ${failure.tool_id} by >50%`,
      risk: "low",
      status: "pending",
      created_at: new Date().toISOString(),
    });
  }

  // Also check for existing proposed changes from reflections
  for (const ref of reflections) {
    if (ref.proposed_change) {
      const pc = ref.proposed_change;
      const exists = proposals.some((p) =>
        p.title.toLowerCase().includes(pc.title?.toLowerCase()?.slice(0, 20) ?? ""),
      );
      if (!exists) {
        proposals.push({
          id: `prop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: pc.type ?? "tool_improvement",
          priority: "medium",
          title: pc.title,
          evidence: pc.evidence,
          proposed_change: pc.expected_impact ?? pc.title,
          expected_impact: pc.expected_impact ?? "Improve reliability",
          risk: "low",
          status: "pending",
          created_at: new Date().toISOString(),
        });
      }
    }
  }

  // Save report
  const report: MaintenanceReport = {
    generated_at: new Date().toISOString(),
    sessions_analyzed: reflections.length,
    total_tool_calls: totalCalls,
    overall_success_rate: Math.round(overallRate * 100),
    top_failures: sortedFailures.slice(0, 10).map((f) => ({
      tool_id: f.tool_id,
      failure_mode: f.failure_mode,
      total_count: f.total,
      across_sessions: f.sessions,
    })),
    proposals,
  };

  writeFileSync(
    join(proposalsDir, `maintenance-${Date.now()}.json`),
    JSON.stringify(report, null, 2),
  );

  // Format output for agent
  const lines: string[] = [];
  lines.push(`## Maintenance Report`);
  lines.push(`Sessions analyzed: ${reflections.length}`);
  lines.push(`Total tool calls: ${totalCalls}`);
  lines.push(`Overall success rate: ${report.overall_success_rate}%`);
  lines.push("");

  if (proposals.length === 0) {
    lines.push("No proposals generated. All systems nominal.");
  } else {
    lines.push(`### ${proposals.length} Proposals`);
    lines.push("");
    for (const p of proposals) {
      lines.push(`**[${p.priority}] ${p.title}**`);
      lines.push(`ID: ${p.id}`);
      lines.push(`Evidence: ${p.evidence}`);
      lines.push(`Impact: ${p.expected_impact}`);
      lines.push(`Status: ${p.status}`);
      lines.push("");
    }
    lines.push(
      "Use `self_improvement_maintenance` with action `approve` or `reject` and a proposal_id to act.",
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function listProposals(baseDir: string) {
  const proposalsDir = join(baseDir, "proposals");
  if (!existsSync(proposalsDir)) {
    return { content: [{ type: "text", text: "No proposals found." }] };
  }

  const files = readdirSync(proposalsDir)
    .filter((f) => f.startsWith("maintenance-") && f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) {
    return { content: [{ type: "text", text: "No maintenance reports found." }] };
  }

  // Load most recent report
  const report: MaintenanceReport = JSON.parse(readFileSync(join(proposalsDir, files[0]), "utf-8"));

  const pending = report.proposals.filter((p) => p.status === "pending");
  if (pending.length === 0) {
    return {
      content: [
        { type: "text", text: "No pending proposals. Run `analyze` to generate new ones." },
      ],
    };
  }

  const lines = pending.map((p) => `- [${p.priority}] **${p.title}** (${p.id})\n  ${p.evidence}`);

  return { content: [{ type: "text", text: `## Pending Proposals\n\n${lines.join("\n\n")}` }] };
}

async function updateProposal(
  baseDir: string,
  proposalId: string,
  status: "approved" | "rejected",
) {
  if (!proposalId) {
    return { content: [{ type: "text", text: "Missing proposal_id" }] };
  }

  const proposalsDir = join(baseDir, "proposals");
  if (!existsSync(proposalsDir)) {
    return { content: [{ type: "text", text: "No proposals directory found." }] };
  }

  const files = readdirSync(proposalsDir)
    .filter((f) => f.startsWith("maintenance-") && f.endsWith(".json"))
    .sort()
    .reverse();

  for (const file of files) {
    const filePath = join(proposalsDir, file);
    const report: MaintenanceReport = JSON.parse(readFileSync(filePath, "utf-8"));
    const proposal = report.proposals.find((p) => p.id === proposalId);
    if (proposal) {
      proposal.status = status;
      writeFileSync(filePath, JSON.stringify(report, null, 2));
      return {
        content: [
          {
            type: "text",
            text: `Proposal ${proposalId} marked as **${status}**.\n\n${status === "approved" ? "You can now implement the proposed change." : "Proposal will not be re-proposed."}`,
          },
        ],
      };
    }
  }

  return { content: [{ type: "text", text: `Proposal ${proposalId} not found.` }] };
}
