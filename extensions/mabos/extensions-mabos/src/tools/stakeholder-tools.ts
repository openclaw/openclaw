/**
 * Stakeholder Tools — Governance profile, decision review, preferences
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(p: string, d: any) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

function stakeholderPath(api: OpenClawPluginApi) {
  return join(resolveWorkspaceDir(api), "stakeholder.json");
}

const StakeholderProfileParams = Type.Object({
  name: Type.String({ description: "Stakeholder name" }),
  approval_threshold_usd: Type.Number({ description: "Expenditure threshold requiring approval" }),
  decision_style: Type.Optional(
    Type.Union(
      [Type.Literal("hands-on"), Type.Literal("strategic-only"), Type.Literal("exception-based")],
      { description: "How much the stakeholder wants to be involved" },
    ),
  ),
  preferred_report_frequency: Type.Optional(
    Type.Union([
      Type.Literal("daily"),
      Type.Literal("weekly"),
      Type.Literal("biweekly"),
      Type.Literal("monthly"),
    ]),
  ),
  risk_tolerance: Type.Optional(
    Type.Union([
      Type.Literal("conservative"),
      Type.Literal("moderate"),
      Type.Literal("aggressive"),
    ]),
  ),
  focus_areas: Type.Optional(
    Type.Array(Type.String(), { description: "Areas the stakeholder cares most about" }),
  ),
  auto_approve_categories: Type.Optional(
    Type.Array(Type.String(), { description: "Decision categories that can be auto-approved" }),
  ),
});

const DecisionReviewParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  decision_id: Type.Optional(
    Type.String({ description: "Specific decision to review (or omit for all pending)" }),
  ),
});

const DecisionResolveParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  decision_id: Type.String({ description: "Decision ID" }),
  resolution: Type.Union([
    Type.Literal("approved"),
    Type.Literal("rejected"),
    Type.Literal("deferred"),
    Type.Literal("modified"),
  ]),
  chosen_option: Type.Optional(Type.String({ description: "Option ID selected (for approved)" })),
  feedback: Type.Optional(Type.String({ description: "Stakeholder feedback or modifications" })),
  conditions: Type.Optional(Type.Array(Type.String(), { description: "Conditions for approval" })),
});

const GovernanceCheckParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.String({ description: "Proposed action" }),
  estimated_cost: Type.Optional(Type.Number({ description: "Estimated cost in USD" })),
  category: Type.Optional(Type.String({ description: "Action category" })),
  agent_id: Type.String({ description: "Agent proposing the action" }),
});

export function createStakeholderTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "stakeholder_profile",
      label: "Set Stakeholder Profile",
      description:
        "Configure the stakeholder's governance preferences — approval thresholds, decision style, risk tolerance, and auto-approve categories.",
      parameters: StakeholderProfileParams,
      async execute(_id: string, params: Static<typeof StakeholderProfileParams>) {
        const path = stakeholderPath(api);
        const existing = (await readJson(path)) || {};
        const profile = {
          ...existing,
          name: params.name,
          approval_threshold_usd: params.approval_threshold_usd,
          decision_style: params.decision_style || "strategic-only",
          preferred_report_frequency: params.preferred_report_frequency || "weekly",
          risk_tolerance: params.risk_tolerance || "moderate",
          focus_areas: params.focus_areas || [],
          auto_approve_categories: params.auto_approve_categories || [],
          updated_at: new Date().toISOString(),
        };
        await writeJson(path, profile);
        return textResult(`Stakeholder profile updated for ${params.name}.
- Approval threshold: $${params.approval_threshold_usd}
- Decision style: ${profile.decision_style}
- Risk tolerance: ${profile.risk_tolerance}
- Auto-approve: ${profile.auto_approve_categories.length ? profile.auto_approve_categories.join(", ") : "none"}`);
      },
    },

    {
      name: "decision_review",
      label: "Review Decisions",
      description:
        "Review pending decisions across a business — shows context, options, agent recommendation, and urgency.",
      parameters: DecisionReviewParams,
      async execute(_id: string, params: Static<typeof DecisionReviewParams>) {
        const ws = resolveWorkspaceDir(api);
        const queuePath = join(ws, "businesses", params.business_id, "decision-queue.json");
        const queue = (await readJson(queuePath)) || [];
        const stakeholder = await readJson(stakeholderPath(api));

        let decisions = queue.filter((d: any) => d.status === "pending");
        if (params.decision_id) {
          decisions = decisions.filter((d: any) => d.id === params.decision_id);
        }

        if (decisions.length === 0) return textResult("No pending decisions.");

        // Sort by urgency
        const urgencyOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        decisions.sort(
          (a: any, b: any) => (urgencyOrder[a.urgency] ?? 2) - (urgencyOrder[b.urgency] ?? 2),
        );

        const output = decisions
          .map((d: any) => {
            const urgencyIcon =
              d.urgency === "critical"
                ? "🔴"
                : d.urgency === "high"
                  ? "🟠"
                  : d.urgency === "medium"
                    ? "🟡"
                    : "🟢";
            const optionsText = (d.options || [])
              .map(
                (o: any, i: number) =>
                  `  ${i + 1}. **${o.label}** — ${o.impact}${o.cost ? ` ($${o.cost})` : ""}${o.risk ? ` ⚠️ ${o.risk}` : ""}`,
              )
              .join("\n");

            return `### ${urgencyIcon} ${d.id}: ${d.title}
- **Agent:** ${d.agent}
- **Urgency:** ${d.urgency}
- **Created:** ${d.created}
${d.deadline ? `- **Deadline:** ${d.deadline}` : ""}

**Context:** ${d.description}

**Options:**
${optionsText || "  No structured options provided."}

${d.recommendation ? `**Agent Recommendation:** ${d.recommendation}` : ""}`;
          })
          .join("\n\n---\n\n");

        return textResult(`## 🔔 Pending Decisions — ${params.business_id}

${decisions.length} decision(s) awaiting review:

${output}

Use \`decision_resolve\` to approve, reject, defer, or modify.`);
      },
    },

    {
      name: "decision_resolve",
      label: "Resolve Decision",
      description:
        "Approve, reject, defer, or modify a pending decision. Notifies the requesting agent.",
      parameters: DecisionResolveParams,
      async execute(_id: string, params: Static<typeof DecisionResolveParams>) {
        const ws = resolveWorkspaceDir(api);
        const queuePath = join(ws, "businesses", params.business_id, "decision-queue.json");
        const queue = (await readJson(queuePath)) || [];

        const idx = queue.findIndex((d: any) => d.id === params.decision_id);
        if (idx === -1) return textResult(`Decision '${params.decision_id}' not found.`);

        const decision = queue[idx];
        decision.status = params.resolution;
        decision.chosen_option = params.chosen_option;
        decision.feedback = params.feedback;
        decision.conditions = params.conditions;
        decision.resolved_at = new Date().toISOString();

        await writeJson(queuePath, queue);

        // Notify the requesting agent
        if (decision.agent) {
          const inboxPath = join(
            ws,
            "businesses",
            params.business_id,
            "agents",
            decision.agent,
            "inbox.json",
          );
          const inbox = (await readJson(inboxPath)) || [];
          inbox.push({
            id: `DEC-${params.decision_id}-resolved`,
            from: "stakeholder",
            to: decision.agent,
            performative:
              params.resolution === "approved"
                ? "ACCEPT"
                : params.resolution === "rejected"
                  ? "REJECT"
                  : "INFORM",
            content: `Decision ${params.decision_id} ${params.resolution}${params.chosen_option ? `: option ${params.chosen_option}` : ""}${params.feedback ? `. Feedback: ${params.feedback}` : ""}${params.conditions?.length ? `. Conditions: ${params.conditions.join("; ")}` : ""}`,
            priority: "high",
            timestamp: new Date().toISOString(),
            read: false,
          });
          await writeJson(inboxPath, inbox);
        }

        return textResult(`Decision ${params.decision_id} → **${params.resolution}**${params.chosen_option ? ` (option: ${params.chosen_option})` : ""}${params.feedback ? `\nFeedback: ${params.feedback}` : ""}${params.conditions?.length ? `\nConditions: ${params.conditions.join("; ")}` : ""}
Agent ${decision.agent} notified.`);
      },
    },

    {
      name: "governance_check",
      label: "Governance Check",
      description:
        "Check if a proposed action requires stakeholder approval based on governance rules.",
      parameters: GovernanceCheckParams,
      async execute(_id: string, params: Static<typeof GovernanceCheckParams>) {
        const stakeholder = (await readJson(stakeholderPath(api))) || {};
        const threshold = stakeholder.approval_threshold_usd || 5000;
        const autoApprove = stakeholder.auto_approve_categories || [];
        const style = stakeholder.decision_style || "strategic-only";

        let requiresApproval = false;
        const reasons: string[] = [];

        // Cost check
        if (params.estimated_cost && params.estimated_cost > threshold) {
          requiresApproval = true;
          reasons.push(`Cost ($${params.estimated_cost}) exceeds threshold ($${threshold})`);
        }

        // Auto-approve check
        if (params.category && autoApprove.includes(params.category)) {
          requiresApproval = false;
          reasons.push(`Category '${params.category}' is auto-approved`);
        }

        // Decision style check
        if (style === "hands-on") {
          requiresApproval = true;
          reasons.push("Stakeholder uses hands-on decision style");
        }

        return textResult(`## Governance Check

**Action:** ${params.action}
**Agent:** ${params.agent_id}
${params.estimated_cost ? `**Cost:** $${params.estimated_cost}` : ""}
${params.category ? `**Category:** ${params.category}` : ""}

**Requires Approval:** ${requiresApproval ? "✅ YES" : "❌ NO"}
**Reasons:**
${reasons.map((r) => `- ${r}`).join("\n") || "- Within agent authority"}

${requiresApproval ? "→ Use `decision_request` to escalate to stakeholder." : "→ Agent may proceed autonomously."}`);
      },
    },
  ];
}
