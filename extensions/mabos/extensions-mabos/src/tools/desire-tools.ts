/**
 * Desire Management Tools — priority formula, conflict resolution, adoption/drop
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";

async function readMd(p: string) {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}
async function writeMd(p: string, c: string) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, c, "utf-8");
}
function aDir(api: OpenClawPluginApi, id: string) {
  return join(resolveWorkspaceDir(api), "agents", id);
}

/**
 * BDI-MAS Priority Formula:
 * priority = base_priority × 0.30 + importance × 0.25 + urgency × 0.25
 *          + strategic_alignment × 0.15 + dependency_status × 0.05
 */
function computePriority(factors: {
  base_priority: number;
  importance: number;
  urgency: number;
  strategic_alignment: number;
  dependency_status: number;
}): number {
  const p =
    factors.base_priority * 0.3 +
    factors.importance * 0.25 +
    factors.urgency * 0.25 +
    factors.strategic_alignment * 0.15 +
    factors.dependency_status * 0.05;
  return Math.round(p * 100) / 100;
}

const DesireCreateParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  desire_id: Type.String({ description: "Desire ID (e.g., 'D-001')" }),
  name: Type.String({ description: "Desire name" }),
  description: Type.String({ description: "What the agent wants" }),
  type: Type.Union(
    [
      Type.Literal("maintain"),
      Type.Literal("achieve"),
      Type.Literal("avoid"),
      Type.Literal("optimize"),
    ],
    { description: "Desire type" },
  ),
  category: Type.Union([Type.Literal("terminal"), Type.Literal("instrumental")], {
    description: "Terminal (intrinsic) or instrumental (serves another desire)",
  }),
  serves: Type.Optional(
    Type.String({ description: "Parent desire ID (for instrumental desires)" }),
  ),
  base_priority: Type.Number({ description: "Base priority 0.0-1.0" }),
  importance: Type.Number({ description: "Importance 0.0-1.0" }),
  urgency: Type.Number({ description: "Urgency 0.0-1.0" }),
  strategic_alignment: Type.Number({ description: "Strategic alignment 0.0-1.0" }),
  dependency_status: Type.Number({ description: "Dependency readiness 0.0-1.0" }),
  generates_goals: Type.Optional(
    Type.String({ description: "Goal patterns this desire produces" }),
  ),
  conflicts_with: Type.Optional(
    Type.Array(Type.String(), { description: "Conflicting desire IDs" }),
  ),
  conflict_resolution: Type.Optional(
    Type.Union(
      [
        Type.Literal("priority-based"),
        Type.Literal("resource-sharing"),
        Type.Literal("temporal-scheduling"),
      ],
      { description: "Conflict resolution strategy" },
    ),
  ),
});

const DesireEvaluateParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  recalculate: Type.Optional(
    Type.Boolean({ description: "Recalculate all priorities (default: false)" }),
  ),
});

const DesireDropParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  desire_id: Type.String({ description: "Desire ID to drop" }),
  reason: Type.String({ description: "Why this desire is being dropped" }),
});

const ReconsiderParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  intention_id: Type.String({ description: "Intention ID to reconsider" }),
  trigger: Type.Union(
    [
      Type.Literal("belief_change"),
      Type.Literal("progress_stall"),
      Type.Literal("resource_constraint"),
      Type.Literal("better_option"),
      Type.Literal("external_event"),
    ],
    { description: "What triggered reconsideration" },
  ),
  details: Type.String({ description: "Trigger details" }),
  severity: Type.Number({
    description: "Severity 0.0-1.0 (belief change magnitude, resource %, etc.)",
  }),
});

export function createDesireTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "desire_create",
      label: "Create Desire",
      description:
        "Create a terminal or instrumental desire with computed priority using BDI-MAS formula: base×0.30 + importance×0.25 + urgency×0.25 + alignment×0.15 + deps×0.05",
      parameters: DesireCreateParams,
      async execute(_id: string, params: Static<typeof DesireCreateParams>) {
        const dir = aDir(api, params.agent_id);
        const path = join(dir, "Desires.md");
        const now = new Date().toISOString();

        const priority = computePriority({
          base_priority: params.base_priority,
          importance: params.importance,
          urgency: params.urgency,
          strategic_alignment: params.strategic_alignment,
          dependency_status: params.dependency_status,
        });

        let content = await readMd(path);
        if (!content) {
          content = `# Desires — ${params.agent_id}\n\n## Terminal Desires (Intrinsic Goals)\n\n## Instrumental Desires (Means to Terminal)\n\n## Desire Hierarchy (Conflict Resolution Order)\n\n## Desire Adoption/Drop Log\n\n| Date | Desire | Action | Reason |\n|---|---|---|---|\n`;
        }

        const entry = `\n### ${params.desire_id}: ${params.name}
- **Description:** ${params.description}
- **Type:** ${params.type}
- **Priority Score:** ${priority}
  - Base Priority: ${params.base_priority}
  - Importance: ${params.importance}
  - Urgency: ${params.urgency}
  - Strategic Alignment: ${params.strategic_alignment}
  - Dependency Status: ${params.dependency_status}
${params.serves ? `- **Serves:** ${params.serves}` : ""}
- **Generates Goals:** ${params.generates_goals || "—"}
${params.conflicts_with?.length ? `- **Conflicts With:** ${params.conflicts_with.join(", ")}` : ""}
${params.conflict_resolution ? `- **Conflict Resolution:** ${params.conflict_resolution}` : ""}
`;

        // Insert in appropriate section
        const section =
          params.category === "terminal"
            ? "## Terminal Desires (Intrinsic Goals)"
            : "## Instrumental Desires (Means to Terminal)";
        const sectionIdx = content.indexOf(section);
        if (sectionIdx !== -1) {
          const nextSection = content.indexOf("\n## ", sectionIdx + section.length);
          const insertAt = nextSection !== -1 ? nextSection : content.length;
          content = content.slice(0, insertAt) + entry + content.slice(insertAt);
        }

        // Log adoption
        const logEntry = `| ${now.split("T")[0]} | ${params.desire_id} | adopted | Created with priority ${priority} |`;
        const logIdx = content.indexOf("|---|---|---|---|");
        if (logIdx !== -1) {
          const afterTable = content.indexOf("\n", logIdx);
          content =
            content.slice(0, afterTable + 1) + logEntry + "\n" + content.slice(afterTable + 1);
        }

        await writeMd(path, content);
        return textResult(
          `Desire ${params.desire_id} created: "${params.name}" (${params.category}, type: ${params.type}, priority: ${priority})`,
        );
      },
    },

    {
      name: "desire_evaluate",
      label: "Evaluate Desires",
      description:
        "Evaluate all desires for an agent — check priorities, conflicts, and generate goal recommendations.",
      parameters: DesireEvaluateParams,
      async execute(_id: string, params: Static<typeof DesireEvaluateParams>) {
        const dir = aDir(api, params.agent_id);
        const desires = await readMd(join(dir, "Desires.md"));
        const beliefs = await readMd(join(dir, "Beliefs.md"));
        const goals = await readMd(join(dir, "Goals.md"));

        if (!desires) return textResult(`No desires found for agent '${params.agent_id}'.`);

        return textResult(`## Desire Evaluation — ${params.agent_id}

**Current Desires:**
${desires}

**Current Beliefs:**
${beliefs || "None."}

**Current Goals:**
${goals || "None."}

**Evaluate:**
1. Are priority scores still accurate given current beliefs?
2. Any new conflicts between desires?
3. Which desires lack active goals? Generate goals for them.
4. Any desires that should be dropped (environment changed)?
5. Rank desires by priority and recommend resource allocation.

${params.recalculate ? "**RECALCULATE all priority scores based on current state.**" : ""}`);
      },
    },

    {
      name: "desire_drop",
      label: "Drop Desire",
      description: "Drop a desire and log the reason. Cascades to dependent goals and intentions.",
      parameters: DesireDropParams,
      async execute(_id: string, params: Static<typeof DesireDropParams>) {
        const dir = aDir(api, params.agent_id);
        const path = join(dir, "Desires.md");
        const now = new Date().toISOString();

        let content = await readMd(path);
        if (!content) return textResult(`No desires found for agent '${params.agent_id}'.`);

        // Log the drop
        const logEntry = `| ${now.split("T")[0]} | ${params.desire_id} | dropped | ${params.reason} |`;
        const logIdx = content.indexOf("|---|---|---|---|");
        if (logIdx !== -1) {
          const afterTable = content.indexOf("\n", logIdx);
          content =
            content.slice(0, afterTable + 1) + logEntry + "\n" + content.slice(afterTable + 1);
        }

        await writeMd(path, content);
        return textResult(
          `Desire ${params.desire_id} dropped for '${params.agent_id}'. Reason: ${params.reason}\n\n⚠️ Review goals linked to this desire — they may need to be abandoned.`,
        );
      },
    },

    {
      name: "intention_reconsider",
      label: "Reconsider Intention",
      description:
        "Trigger reconsideration of an intention based on belief changes, stalls, resource constraints, or better options. Respects commitment strategy thresholds.",
      parameters: ReconsiderParams,
      async execute(_id: string, params: Static<typeof ReconsiderParams>) {
        const dir = aDir(api, params.agent_id);
        const intentions = await readMd(join(dir, "Intentions.md"));
        const beliefs = await readMd(join(dir, "Beliefs.md"));
        const plans = await readMd(join(dir, "Plans.md"));

        if (!intentions) return textResult(`No intentions found for agent '${params.agent_id}'.`);

        // Reconsideration thresholds by trigger
        const thresholds: Record<string, { threshold: number; label: string }> = {
          belief_change: { threshold: 0.3, label: "Belief change severity > 0.3" },
          progress_stall: { threshold: 0.01, label: "Progress delta < 0.01" },
          resource_constraint: { threshold: 0.5, label: "Resources < 50%" },
          better_option: { threshold: 1.2, label: "Better option > 1.2× current EV" },
          external_event: { threshold: 0.0, label: "Any relevant environment change" },
        };

        const t = thresholds[params.trigger];
        const triggered = params.trigger === "external_event" || params.severity >= t.threshold;

        return textResult(`## Reconsideration — ${params.intention_id}

**Trigger:** ${params.trigger}
**Details:** ${params.details}
**Severity:** ${params.severity}
**Threshold:** ${t.label}
**Triggered:** ${triggered ? "✅ YES" : "❌ NO (below threshold)"}

**Current Intentions:**
${intentions}

**Current Beliefs:**
${beliefs || "None."}

**Available Plans:**
${plans || "None."}

${
  triggered
    ? `**Action Required:**
Based on the intention's commitment strategy:
- **Single-minded:** Continue unless goal impossible or achieved
- **Open-minded:** Re-evaluate, consider alternatives
- **Cautious:** Strongly consider switching

Recommend: continue, modify, or drop this intention.`
    : "Severity below threshold — no action needed under current commitment strategy."
}`);
      },
    },
  ];
}
