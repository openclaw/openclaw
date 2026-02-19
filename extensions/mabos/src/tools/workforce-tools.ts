/**
 * Workforce Tools — Freelancer/contractor management, work packages, trust scoring, handoff protocol
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
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

type Contractor = {
  id: string;
  name: string;
  email?: string;
  skills: string[];
  rate_usd_hr?: number;
  trust_score: number; // 0.0-1.0
  trust_history: Array<{ date: string; delta: number; reason: string }>;
  availability: "available" | "busy" | "unavailable";
  total_packages: number;
  completed_packages: number;
  active_packages: string[];
  created_at: string;
  last_engaged: string;
};

type WorkPackage = {
  id: string;
  business_id: string;
  title: string;
  description: string;
  deliverables: string[];
  assigned_to?: string; // contractor ID
  assigned_agent: string; // agent that created it
  status: "draft" | "open" | "assigned" | "in_progress" | "review" | "completed" | "cancelled";
  budget_usd?: number;
  deadline?: string;
  created_at: string;
  updated_at: string;
  handoff_notes?: string;
  review_notes?: string;
  quality_score?: number; // 0.0-1.0 on completion
};

function poolPath(api: OpenClawPluginApi) {
  return join(resolveWorkspaceDir(api), "contractor-pool.json");
}
function wpPath(api: OpenClawPluginApi, bizId: string) {
  return join(resolveWorkspaceDir(api), "businesses", bizId, "work-packages.json");
}

const ContractorAddParams = Type.Object({
  name: Type.String({ description: "Contractor name" }),
  email: Type.Optional(Type.String({ description: "Contact email" })),
  skills: Type.Array(Type.String(), {
    description: "Skill tags (e.g., 'react', 'copywriting', 'accounting')",
  }),
  rate_usd_hr: Type.Optional(Type.Number({ description: "Hourly rate in USD" })),
  initial_trust: Type.Optional(
    Type.Number({ description: "Initial trust score 0.0-1.0 (default: 0.5)" }),
  ),
});

const ContractorListParams = Type.Object({
  skill: Type.Optional(Type.String({ description: "Filter by skill" })),
  availability: Type.Optional(
    Type.Union([
      Type.Literal("available"),
      Type.Literal("busy"),
      Type.Literal("unavailable"),
      Type.Literal("all"),
    ]),
  ),
  min_trust: Type.Optional(Type.Number({ description: "Minimum trust score" })),
});

const ContractorTrustParams = Type.Object({
  contractor_id: Type.String({ description: "Contractor ID" }),
  delta: Type.Number({ description: "Trust change (-1.0 to +1.0)" }),
  reason: Type.String({ description: "Reason for trust change" }),
});

const WorkPackageCreateParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  package_id: Type.String({ description: "Work package ID (e.g., 'WP-001')" }),
  title: Type.String({ description: "Package title" }),
  description: Type.String({ description: "Detailed scope description" }),
  deliverables: Type.Array(Type.String(), { description: "Expected deliverables" }),
  agent_id: Type.String({ description: "Agent creating this package" }),
  budget_usd: Type.Optional(Type.Number({ description: "Budget in USD" })),
  deadline: Type.Optional(Type.String({ description: "Deadline (ISO date)" })),
  required_skills: Type.Optional(
    Type.Array(Type.String(), { description: "Required skills for matching" }),
  ),
});

const WorkPackageAssignParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  package_id: Type.String({ description: "Work package ID" }),
  contractor_id: Type.String({ description: "Contractor to assign" }),
  handoff_notes: Type.Optional(
    Type.String({ description: "Context and instructions for the contractor" }),
  ),
});

const WorkPackageUpdateParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  package_id: Type.String({ description: "Work package ID" }),
  status: Type.Union([
    Type.Literal("in_progress"),
    Type.Literal("review"),
    Type.Literal("completed"),
    Type.Literal("cancelled"),
  ]),
  review_notes: Type.Optional(Type.String({ description: "Notes from review" })),
  quality_score: Type.Optional(
    Type.Number({ description: "Quality score 0.0-1.0 (on completion)" }),
  ),
});

const WorkPackageListParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  status: Type.Optional(Type.String({ description: "Filter by status" })),
  agent_id: Type.Optional(Type.String({ description: "Filter by creating agent" })),
  contractor_id: Type.Optional(Type.String({ description: "Filter by assigned contractor" })),
});

const HandoffParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  package_id: Type.String({ description: "Work package ID" }),
  direction: Type.Union([Type.Literal("agent_to_human"), Type.Literal("human_to_agent")], {
    description: "Handoff direction",
  }),
  context: Type.String({ description: "Context for the handoff — what's been done, what's next" }),
  artifacts: Type.Optional(
    Type.Array(Type.String(), { description: "File paths or URLs of artifacts" }),
  ),
});

export function createWorkforceTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "contractor_add",
      label: "Add Contractor",
      description:
        "Add a freelancer/contractor to the talent pool with skills, rate, and initial trust score.",
      parameters: ContractorAddParams,
      async execute(_id: string, params: Static<typeof ContractorAddParams>) {
        const path = poolPath(api);
        const pool = (await readJson(path)) || { contractors: [] };
        const now = new Date().toISOString();

        const contractor: Contractor = {
          id: `CTR-${Date.now().toString(36)}`,
          name: params.name,
          email: params.email,
          skills: params.skills,
          rate_usd_hr: params.rate_usd_hr,
          trust_score: params.initial_trust ?? 0.5,
          trust_history: [
            { date: now, delta: params.initial_trust ?? 0.5, reason: "Initial registration" },
          ],
          availability: "available",
          total_packages: 0,
          completed_packages: 0,
          active_packages: [],
          created_at: now,
          last_engaged: now,
        };

        pool.contractors.push(contractor);
        await writeJson(path, pool);
        return textResult(`Contractor added: ${params.name} (${contractor.id})
- Skills: ${params.skills.join(", ")}
- Rate: ${params.rate_usd_hr ? `$${params.rate_usd_hr}/hr` : "negotiable"}
- Trust: ${contractor.trust_score}`);
      },
    },

    {
      name: "contractor_list",
      label: "List Contractors",
      description:
        "List contractors in the talent pool with filtering by skill, availability, and trust.",
      parameters: ContractorListParams,
      async execute(_id: string, params: Static<typeof ContractorListParams>) {
        const pool = (await readJson(poolPath(api))) || { contractors: [] };
        let contractors = pool.contractors as Contractor[];

        if (params.skill)
          contractors = contractors.filter((c) =>
            c.skills.some((s) => s.toLowerCase().includes(params.skill!.toLowerCase())),
          );
        if (params.availability && params.availability !== "all")
          contractors = contractors.filter((c) => c.availability === params.availability);
        if (params.min_trust)
          contractors = contractors.filter((c) => c.trust_score >= params.min_trust!);

        contractors.sort((a, b) => b.trust_score - a.trust_score);

        if (contractors.length === 0) return textResult("No contractors match the filter.");

        const output = contractors
          .map(
            (c) =>
              `- **${c.name}** (${c.id}) — trust: ${c.trust_score.toFixed(2)}, ${c.availability}
  Skills: ${c.skills.join(", ")}${c.rate_usd_hr ? ` | Rate: $${c.rate_usd_hr}/hr` : ""}
  Packages: ${c.completed_packages}/${c.total_packages} completed, ${c.active_packages.length} active`,
          )
          .join("\n");

        return textResult(`## Contractor Pool (${contractors.length})\n\n${output}`);
      },
    },

    {
      name: "contractor_trust_update",
      label: "Update Trust Score",
      description:
        "Adjust a contractor's trust score based on performance. Positive delta for good work, negative for issues.",
      parameters: ContractorTrustParams,
      async execute(_id: string, params: Static<typeof ContractorTrustParams>) {
        const path = poolPath(api);
        const pool = (await readJson(path)) || { contractors: [] };
        const contractor = pool.contractors.find((c: Contractor) => c.id === params.contractor_id);

        if (!contractor) return textResult(`Contractor '${params.contractor_id}' not found.`);

        const oldScore = contractor.trust_score;
        contractor.trust_score = Math.max(0, Math.min(1, contractor.trust_score + params.delta));
        contractor.trust_history.push({
          date: new Date().toISOString(),
          delta: params.delta,
          reason: params.reason,
        });

        await writeJson(path, pool);
        return textResult(`Trust updated for ${contractor.name}: ${oldScore.toFixed(2)} → ${contractor.trust_score.toFixed(2)} (${params.delta > 0 ? "+" : ""}${params.delta})
Reason: ${params.reason}`);
      },
    },

    {
      name: "work_package_create",
      label: "Create Work Package",
      description: "Create a work package for assignment to a freelancer/contractor.",
      parameters: WorkPackageCreateParams,
      async execute(_id: string, params: Static<typeof WorkPackageCreateParams>) {
        const path = wpPath(api, params.business_id);
        const store = (await readJson(path)) || { packages: [] };
        const now = new Date().toISOString();

        const wp: WorkPackage = {
          id: params.package_id,
          business_id: params.business_id,
          title: params.title,
          description: params.description,
          deliverables: params.deliverables,
          assigned_agent: params.agent_id,
          status: "open",
          budget_usd: params.budget_usd,
          deadline: params.deadline,
          created_at: now,
          updated_at: now,
        };

        store.packages.push(wp);
        await writeJson(path, store);

        // Auto-suggest matching contractors
        const pool = (await readJson(poolPath(api))) || { contractors: [] };
        const matches = params.required_skills?.length
          ? (pool.contractors as Contractor[])
              .filter(
                (c) =>
                  c.availability === "available" &&
                  params.required_skills!.some((s) =>
                    c.skills.some((cs) => cs.toLowerCase().includes(s.toLowerCase())),
                  ),
              )
              .sort((a, b) => b.trust_score - a.trust_score)
              .slice(0, 3)
          : [];

        return textResult(`Work package ${params.package_id} created: "${params.title}"
- Deliverables: ${params.deliverables.length}
- Budget: ${params.budget_usd ? `$${params.budget_usd}` : "TBD"}
- Deadline: ${params.deadline || "none"}
${matches.length ? `\n**Matching contractors:**\n${matches.map((c) => `- ${c.name} (${c.id}) — trust: ${c.trust_score.toFixed(2)}, ${c.skills.join(", ")}`).join("\n")}` : ""}`);
      },
    },

    {
      name: "work_package_assign",
      label: "Assign Work Package",
      description: "Assign a work package to a contractor with handoff notes.",
      parameters: WorkPackageAssignParams,
      async execute(_id: string, params: Static<typeof WorkPackageAssignParams>) {
        const wpStore = (await readJson(wpPath(api, params.business_id))) || { packages: [] };
        const wp = wpStore.packages.find((p: WorkPackage) => p.id === params.package_id);
        if (!wp) return textResult(`Work package '${params.package_id}' not found.`);

        const pool = (await readJson(poolPath(api))) || { contractors: [] };
        const contractor = pool.contractors.find((c: Contractor) => c.id === params.contractor_id);
        if (!contractor) return textResult(`Contractor '${params.contractor_id}' not found.`);

        // Check governance
        const stakeholder =
          (await readJson(join(resolveWorkspaceDir(api), "stakeholder.json"))) || {};
        if (wp.budget_usd && wp.budget_usd > (stakeholder.approval_threshold_usd || 5000)) {
          return textResult(
            `⚠️ Budget $${wp.budget_usd} exceeds approval threshold. Use \`decision_request\` to get stakeholder approval first.`,
          );
        }

        wp.assigned_to = params.contractor_id;
        wp.status = "assigned";
        wp.handoff_notes = params.handoff_notes;
        wp.updated_at = new Date().toISOString();

        contractor.total_packages++;
        contractor.active_packages.push(params.package_id);
        contractor.availability = "busy";
        contractor.last_engaged = new Date().toISOString();

        await writeJson(wpPath(api, params.business_id), wpStore);
        await writeJson(poolPath(api), pool);

        return textResult(`Work package ${params.package_id} assigned to ${contractor.name}.
- Status: assigned
${params.handoff_notes ? `- Handoff notes: ${params.handoff_notes}` : ""}`);
      },
    },

    {
      name: "work_package_update",
      label: "Update Work Package",
      description:
        "Update work package status. On completion, optionally rate quality (affects contractor trust).",
      parameters: WorkPackageUpdateParams,
      async execute(_id: string, params: Static<typeof WorkPackageUpdateParams>) {
        const wpStore = (await readJson(wpPath(api, params.business_id))) || { packages: [] };
        const wp = wpStore.packages.find((p: WorkPackage) => p.id === params.package_id);
        if (!wp) return textResult(`Work package '${params.package_id}' not found.`);

        wp.status = params.status;
        wp.review_notes = params.review_notes;
        wp.quality_score = params.quality_score;
        wp.updated_at = new Date().toISOString();

        await writeJson(wpPath(api, params.business_id), wpStore);

        // On completion, update contractor stats and trust
        if (params.status === "completed" && wp.assigned_to) {
          const pool = (await readJson(poolPath(api))) || { contractors: [] };
          const contractor = pool.contractors.find((c: Contractor) => c.id === wp.assigned_to);
          if (contractor) {
            contractor.completed_packages++;
            contractor.active_packages = contractor.active_packages.filter(
              (p: string) => p !== params.package_id,
            );
            if (contractor.active_packages.length === 0) contractor.availability = "available";

            if (params.quality_score !== undefined) {
              const trustDelta = (params.quality_score - 0.5) * 0.2; // ±0.1 max per package
              contractor.trust_score = Math.max(
                0,
                Math.min(1, contractor.trust_score + trustDelta),
              );
              contractor.trust_history.push({
                date: new Date().toISOString(),
                delta: trustDelta,
                reason: `WP ${params.package_id} completed — quality: ${params.quality_score}`,
              });
            }
            await writeJson(poolPath(api), pool);
          }
        }

        return textResult(
          `Work package ${params.package_id} → ${params.status}${params.quality_score !== undefined ? ` (quality: ${params.quality_score})` : ""}${params.review_notes ? `\nReview: ${params.review_notes}` : ""}`,
        );
      },
    },

    {
      name: "work_package_list",
      label: "List Work Packages",
      description: "List work packages for a business with optional filters.",
      parameters: WorkPackageListParams,
      async execute(_id: string, params: Static<typeof WorkPackageListParams>) {
        const wpStore = (await readJson(wpPath(api, params.business_id))) || { packages: [] };
        let packages = wpStore.packages as WorkPackage[];

        if (params.status) packages = packages.filter((p) => p.status === params.status);
        if (params.agent_id)
          packages = packages.filter((p) => p.assigned_agent === params.agent_id);
        if (params.contractor_id)
          packages = packages.filter((p) => p.assigned_to === params.contractor_id);

        if (packages.length === 0) return textResult("No work packages match the filter.");

        const output = packages
          .map((p) => {
            const statusIcon =
              p.status === "completed"
                ? "✅"
                : p.status === "in_progress"
                  ? "🔄"
                  : p.status === "review"
                    ? "👁️"
                    : p.status === "assigned"
                      ? "📋"
                      : p.status === "cancelled"
                        ? "❌"
                        : "📝";
            return `${statusIcon} **${p.id}:** ${p.title} [${p.status}]
  Agent: ${p.assigned_agent} | Contractor: ${p.assigned_to || "unassigned"}${p.budget_usd ? ` | Budget: $${p.budget_usd}` : ""}${p.deadline ? ` | Due: ${p.deadline}` : ""}`;
          })
          .join("\n");

        return textResult(
          `## Work Packages — ${params.business_id} (${packages.length})\n\n${output}`,
        );
      },
    },

    {
      name: "handoff",
      label: "Agent-Human Handoff",
      description:
        "Formal handoff between agent and human contractor — transfers context, artifacts, and instructions.",
      parameters: HandoffParams,
      async execute(_id: string, params: Static<typeof HandoffParams>) {
        const ws = resolveWorkspaceDir(api);
        const wpStore = (await readJson(wpPath(api, params.business_id))) || { packages: [] };
        const wp = wpStore.packages.find((p: WorkPackage) => p.id === params.package_id);

        if (!wp) return textResult(`Work package '${params.package_id}' not found.`);

        const handoffLog = join(ws, "businesses", params.business_id, "handoff-log.json");
        const log = (await readJson(handoffLog)) || { handoffs: [] };

        const handoff = {
          id: `HO-${Date.now().toString(36)}`,
          package_id: params.package_id,
          direction: params.direction,
          context: params.context,
          artifacts: params.artifacts || [],
          timestamp: new Date().toISOString(),
        };

        log.handoffs.push(handoff);
        await writeJson(handoffLog, log);

        if (params.direction === "agent_to_human") {
          return textResult(`## Handoff: Agent → Human

**Package:** ${wp.title} (${params.package_id})
**Contractor:** ${wp.assigned_to || "TBD"}

**Context:**
${params.context}

${params.artifacts?.length ? `**Artifacts:**\n${params.artifacts.map((a) => `- ${a}`).join("\n")}` : ""}

The contractor should review the context and confirm receipt before starting work.`);
        } else {
          wp.status = "review";
          wp.updated_at = new Date().toISOString();
          await writeJson(wpPath(api, params.business_id), wpStore);

          return textResult(`## Handoff: Human → Agent

**Package:** ${wp.title} (${params.package_id})
**Status:** → review

**Contractor's handoff:**
${params.context}

${params.artifacts?.length ? `**Deliverables:**\n${params.artifacts.map((a) => `- ${a}`).join("\n")}` : ""}

Package moved to review. Use \`work_package_update\` to complete with quality score.`);
        }
      },
    },
  ];
}
