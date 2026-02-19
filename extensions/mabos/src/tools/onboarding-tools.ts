/**
 * Onboarding Tools — TOGAF model generation, Business Model Canvas, Tropos goals, agent spawning,
 * desire initialization, SBVR sync, and onboarding progress tracking
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";

const __toolDir = dirname(fileURLToPath(import.meta.url));
// From src/tools/ (source) or dist/src/tools/ (compiled), resolve to extension root
const __extRoot = __toolDir.includes("dist")
  ? join(__toolDir, "..", "..", "..")
  : join(__toolDir, "..", "..");
const TEMPLATE_DIR = join(__extRoot, "templates", "base");

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
async function writeMd(p: string, c: string) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, c, "utf-8");
}

const AGENT_ROLES = [
  "ceo",
  "cfo",
  "coo",
  "cmo",
  "cto",
  "hr",
  "legal",
  "strategy",
  "knowledge",
] as const;

const TogafGenerateParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  business_name: Type.String({ description: "Business name" }),
  business_type: Type.String({ description: "Business type" }),
  description: Type.String({ description: "Business description" }),
  products_services: Type.Array(Type.String(), { description: "Products or services offered" }),
  target_market: Type.String({ description: "Target market/customers" }),
  revenue_model: Type.String({ description: "How the business makes money" }),
  technology_stack: Type.Optional(Type.Array(Type.String(), { description: "Key technologies" })),
  team_size: Type.Optional(Type.String({ description: "Current/planned team size" })),
  stage: Type.Optional(
    Type.Union(
      [
        Type.Literal("idea"),
        Type.Literal("mvp"),
        Type.Literal("growth"),
        Type.Literal("scale"),
        Type.Literal("mature"),
      ],
      { description: "Business stage" },
    ),
  ),
});

const BmcGenerateParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  key_partners: Type.Optional(Type.Array(Type.String())),
  key_activities: Type.Optional(Type.Array(Type.String())),
  key_resources: Type.Optional(Type.Array(Type.String())),
  value_propositions: Type.Array(Type.String(), { description: "What value you deliver" }),
  customer_relationships: Type.Optional(Type.Array(Type.String())),
  channels: Type.Optional(Type.Array(Type.String())),
  customer_segments: Type.Array(Type.String(), { description: "Who you serve" }),
  cost_structure: Type.Optional(Type.Array(Type.String())),
  revenue_streams: Type.Array(Type.String(), { description: "How you make money" }),
});

const TroposGenerateParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  stakeholder_goals: Type.Array(
    Type.Object({
      goal: Type.String(),
      priority: Type.Number({ description: "0.0-1.0" }),
      type: Type.Union([Type.Literal("hard"), Type.Literal("soft")]),
    }),
    { description: "Stakeholder's goals for this business" },
  ),
  constraints: Type.Optional(
    Type.Array(Type.String(), { description: "Constraints or boundaries" }),
  ),
});

const AgentSpawnDomainParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  business_type: Type.String({ description: "Business type for domain-specific agent selection" }),
  custom_agents: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        name: Type.String(),
        role: Type.String({ description: "Role description" }),
      }),
      { description: "Additional domain-specific agents to create" },
    ),
  ),
});

const OnboardFullParams = Type.Object({
  business_id: Type.String({ description: "Business ID (slug)" }),
  name: Type.String({ description: "Business name" }),
  legal_name: Type.String({ description: "Legal entity name" }),
  type: Type.Union([
    Type.Literal("ecommerce"),
    Type.Literal("saas"),
    Type.Literal("consulting"),
    Type.Literal("marketplace"),
    Type.Literal("retail"),
    Type.Literal("other"),
  ]),
  description: Type.String({ description: "What the business does" }),
  value_propositions: Type.Array(Type.String()),
  customer_segments: Type.Array(Type.String()),
  revenue_streams: Type.Array(Type.String()),
  jurisdiction: Type.Optional(Type.String()),
  stage: Type.Optional(Type.String()),
  orchestrate: Type.Optional(
    Type.Boolean({
      description:
        "When true, also spawns domain agents, initializes desires, and syncs SBVR to backend",
      default: false,
    }),
  ),
});

const DesireInitParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  roles: Type.Optional(
    Type.Array(Type.String(), { description: "Roles to initialize (default: all 9)" }),
  ),
});

const SbvrSyncParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  backend_url: Type.Optional(
    Type.String({ description: "Backend URL (default: http://localhost:8000)" }),
  ),
});

const OnboardingProgressParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  phase: Type.Union(
    [
      Type.Literal("discovery"),
      Type.Literal("architecture"),
      Type.Literal("agents"),
      Type.Literal("knowledge_graph"),
      Type.Literal("launch"),
    ],
    { description: "Onboarding phase" },
  ),
  status: Type.Union(
    [
      Type.Literal("started"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("skipped"),
      Type.Literal("retry"),
    ],
    { description: "Phase status" },
  ),
  details: Type.Optional(Type.String({ description: "Additional details about this phase" })),
  show_canvas: Type.Optional(
    Type.Boolean({ description: "Show Canvas progress view", default: false }),
  ),
});

export function createOnboardingTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "togaf_generate",
      label: "Generate TOGAF Architecture",
      description:
        "Generate a TOGAF enterprise architecture model (business, application, technology layers) for a business.",
      parameters: TogafGenerateParams,
      async execute(_id: string, params: Static<typeof TogafGenerateParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);
        const now = new Date().toISOString();

        const togaf = {
          business_id: params.business_id,
          generated_at: now,
          version: "1.0",

          business_architecture: {
            vision: params.description,
            business_model: params.revenue_model,
            products_services: params.products_services,
            target_market: params.target_market,
            stage: params.stage || "mvp",
            organizational_structure: {
              governance: "stakeholder-principal",
              agents: AGENT_ROLES.map((r) => ({
                id: r,
                role: r.toUpperCase(),
                type: "core",
              })),
              human_resources: "freelancer-contractor-model",
            },
            key_processes: [
              "strategic-planning",
              "financial-management",
              "operations-execution",
              "customer-acquisition",
              "product-development",
              "knowledge-management",
            ],
          },

          application_architecture: {
            agent_system: "MABOS BDI Multi-Agent",
            cognitive_framework: "Belief-Desire-Intention with CBR",
            communication_protocol: "ACL (FIPA performatives)",
            coordination_patterns: ["request-reply", "pub-sub", "contract-net"],
            knowledge_representation: "JSON-LD/OWL ontologies",
            reasoning_engine: "Multi-method (35+ methods)",
            memory_system: "3-store (working, short-term, long-term)",
            decision_support: "Stakeholder dashboard with decision queue",
          },

          technology_architecture: {
            platform: "OpenClaw",
            runtime: "Node.js",
            ai_models: "Configurable (Claude, GPT, etc.)",
            data_storage: "File-based (JSON, Markdown)",
            ontology_format: "JSON-LD/OWL",
            technology_stack: params.technology_stack || [],
            integration_points: [
              "REST APIs (via agent tools)",
              "Webhook events",
              "Scheduled BDI cycles (cron)",
            ],
          },
        };

        await writeJson(join(bizDir, "togaf-architecture.json"), togaf);
        await writeMd(
          join(bizDir, "TOGAF-ARCHITECTURE.md"),
          `# TOGAF Architecture — ${params.business_name}

Generated: ${now}

## Business Architecture Layer

**Vision:** ${params.description}
**Business Model:** ${params.revenue_model}
**Stage:** ${params.stage || "mvp"}
**Target Market:** ${params.target_market}

### Products/Services
${params.products_services.map((p) => `- ${p}`).join("\n")}

### Organizational Structure
- **Governance:** Stakeholder as principal
- **Agents:** ${AGENT_ROLES.length} core C-suite agents
- **Human Resources:** Freelancer/contractor model

## Application Architecture Layer

- **Agent System:** MABOS BDI Multi-Agent
- **Cognition:** BDI with Case-Based Reasoning
- **Communication:** ACL with FIPA performatives
- **Coordination:** Request-reply, pub-sub, contract-net
- **Knowledge:** JSON-LD/OWL ontologies
- **Reasoning:** 35+ methods with meta-reasoning router
- **Memory:** 3-store model (working → short-term → long-term)

## Technology Architecture Layer

- **Platform:** OpenClaw
- **Runtime:** Node.js
${params.technology_stack?.length ? `- **Stack:** ${params.technology_stack.join(", ")}` : ""}
- **Storage:** File-based (JSON + Markdown)
- **Integration:** REST APIs, webhooks, cron-based BDI cycles
`,
        );

        return textResult(
          `TOGAF architecture generated for '${params.business_name}' (${params.business_id}). Files: togaf-architecture.json, TOGAF-ARCHITECTURE.md`,
        );
      },
    },

    {
      name: "bmc_generate",
      label: "Generate Business Model Canvas",
      description: "Generate a Business Model Canvas for a venture.",
      parameters: BmcGenerateParams,
      async execute(_id: string, params: Static<typeof BmcGenerateParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);
        const now = new Date().toISOString();

        const bmc = {
          business_id: params.business_id,
          generated_at: now,
          canvas: {
            key_partners: params.key_partners || [],
            key_activities: params.key_activities || [],
            key_resources: params.key_resources || [],
            value_propositions: params.value_propositions,
            customer_relationships: params.customer_relationships || [],
            channels: params.channels || [],
            customer_segments: params.customer_segments,
            cost_structure: params.cost_structure || [],
            revenue_streams: params.revenue_streams,
          },
        };

        await writeJson(join(bizDir, "business-model-canvas.json"), bmc);

        const md = `# Business Model Canvas — ${params.business_id}

Generated: ${now}

| Block | Details |
|---|---|
| **Key Partners** | ${(params.key_partners || ["TBD"]).join(", ")} |
| **Key Activities** | ${(params.key_activities || ["TBD"]).join(", ")} |
| **Key Resources** | ${(params.key_resources || ["TBD"]).join(", ")} |
| **Value Propositions** | ${params.value_propositions.join(", ")} |
| **Customer Relationships** | ${(params.customer_relationships || ["TBD"]).join(", ")} |
| **Channels** | ${(params.channels || ["TBD"]).join(", ")} |
| **Customer Segments** | ${params.customer_segments.join(", ")} |
| **Cost Structure** | ${(params.cost_structure || ["TBD"]).join(", ")} |
| **Revenue Streams** | ${params.revenue_streams.join(", ")} |
`;

        await writeMd(join(bizDir, "BUSINESS-MODEL-CANVAS.md"), md);
        return textResult(
          `Business Model Canvas generated for '${params.business_id}'. Files: business-model-canvas.json, BUSINESS-MODEL-CANVAS.md`,
        );
      },
    },

    {
      name: "tropos_generate",
      label: "Generate Tropos Goal Model",
      description:
        "Generate a Tropos i* goal model mapping stakeholder goals to agent goals and plans.",
      parameters: TroposGenerateParams,
      async execute(_id: string, params: Static<typeof TroposGenerateParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);
        const now = new Date().toISOString();

        // Map stakeholder goals to agent responsibilities
        const goalMapping = params.stakeholder_goals.map((sg) => {
          // Heuristic: map goals to most relevant agents
          const goalLower = sg.goal.toLowerCase();
          let primaryAgent = "ceo";
          if (
            goalLower.includes("revenue") ||
            goalLower.includes("profit") ||
            goalLower.includes("cost") ||
            goalLower.includes("cash")
          )
            primaryAgent = "cfo";
          else if (
            goalLower.includes("customer") ||
            goalLower.includes("market") ||
            goalLower.includes("brand")
          )
            primaryAgent = "cmo";
          else if (
            goalLower.includes("tech") ||
            goalLower.includes("platform") ||
            goalLower.includes("build")
          )
            primaryAgent = "cto";
          else if (
            goalLower.includes("operation") ||
            goalLower.includes("process") ||
            goalLower.includes("efficien")
          )
            primaryAgent = "coo";
          else if (
            goalLower.includes("team") ||
            goalLower.includes("hire") ||
            goalLower.includes("talent")
          )
            primaryAgent = "hr";
          else if (
            goalLower.includes("legal") ||
            goalLower.includes("compliance") ||
            goalLower.includes("regulat")
          )
            primaryAgent = "legal";
          else if (goalLower.includes("strateg") || goalLower.includes("compet"))
            primaryAgent = "strategy";

          return {
            stakeholder_goal: sg.goal,
            priority: sg.priority,
            type: sg.type,
            primary_agent: primaryAgent,
            decomposition: `Decompose into ${primaryAgent.toUpperCase()} goals via desire_create + goal_create`,
          };
        });

        const tropos = {
          business_id: params.business_id,
          generated_at: now,
          actors: [
            { id: "stakeholder", type: "principal", goals: params.stakeholder_goals },
            ...AGENT_ROLES.map((r) => ({
              id: r,
              type: "agent",
              delegated_goals: goalMapping
                .filter((g) => g.primary_agent === r)
                .map((g) => g.stakeholder_goal),
            })),
          ],
          goal_mapping: goalMapping,
          constraints: params.constraints || [],
          dependencies: AGENT_ROLES.map((r) => ({
            from: "stakeholder",
            to: r,
            type: "delegation",
          })),
        };

        await writeJson(join(bizDir, "tropos-goal-model.json"), tropos);

        const md = `# Tropos Goal Model — ${params.business_id}

Generated: ${now}

## Stakeholder Goals
${params.stakeholder_goals.map((g) => `- **${g.goal}** (${g.type}, priority: ${g.priority})`).join("\n")}

## Goal → Agent Mapping
${goalMapping.map((g) => `- "${g.stakeholder_goal}" → **${g.primary_agent.toUpperCase()}** (priority: ${g.priority})`).join("\n")}

${params.constraints?.length ? `## Constraints\n${params.constraints.map((c) => `- ${c}`).join("\n")}` : ""}

## Agent Dependencies
All C-suite agents receive delegated goals from the stakeholder via the CEO.
`;

        await writeMd(join(bizDir, "TROPOS-GOAL-MODEL.md"), md);
        return textResult(
          `Tropos goal model generated. ${goalMapping.length} stakeholder goals mapped to agents.`,
        );
      },
    },

    {
      name: "agent_spawn_domain",
      label: "Spawn Domain Agents",
      description:
        "Create domain-specific agents for a business type (e.g., inventory manager for e-commerce, DevOps for SaaS).",
      parameters: AgentSpawnDomainParams,
      async execute(_id: string, params: Static<typeof AgentSpawnDomainParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);

        // Domain-specific agent definitions
        const domainAgents: Record<string, Array<{ id: string; name: string; role: string }>> = {
          ecommerce: [
            {
              id: "inventory-mgr",
              name: "Inventory Manager",
              role: "Manages stock levels, reorder points, and supplier relationships",
            },
            {
              id: "fulfillment-mgr",
              name: "Fulfillment Manager",
              role: "Handles order processing, shipping, and returns",
            },
            {
              id: "product-mgr",
              name: "Product Manager",
              role: "Manages product catalog, pricing, and listings",
            },
          ],
          saas: [
            {
              id: "devops",
              name: "DevOps Engineer",
              role: "Manages deployments, monitoring, uptime, and infrastructure",
            },
            {
              id: "product-mgr",
              name: "Product Manager",
              role: "Manages feature roadmap, user research, and releases",
            },
            {
              id: "customer-success",
              name: "Customer Success",
              role: "Manages onboarding, retention, and churn prevention",
            },
          ],
          consulting: [
            {
              id: "engagement-mgr",
              name: "Engagement Manager",
              role: "Manages client engagements, milestones, and deliverables",
            },
            {
              id: "biz-dev",
              name: "Business Development",
              role: "Manages pipeline, proposals, and client acquisition",
            },
          ],
          marketplace: [
            {
              id: "supply-mgr",
              name: "Supply Manager",
              role: "Manages seller onboarding, quality, and trust scoring",
            },
            {
              id: "demand-mgr",
              name: "Demand Manager",
              role: "Manages buyer acquisition, matching, and experience",
            },
            {
              id: "trust-safety",
              name: "Trust & Safety",
              role: "Manages disputes, fraud prevention, and platform integrity",
            },
          ],
          retail: [
            {
              id: "store-mgr",
              name: "Store Manager",
              role: "Manages store operations, staff scheduling, and customer experience",
            },
            {
              id: "merchandiser",
              name: "Merchandiser",
              role: "Manages product placement, promotions, and visual merchandising",
            },
          ],
        };

        const agents = [
          ...(domainAgents[params.business_type] || []),
          ...(params.custom_agents || []),
        ];

        if (agents.length === 0) {
          return textResult(
            `No domain-specific agents defined for type '${params.business_type}'.`,
          );
        }

        const cogFiles = [
          "Persona.md",
          "Capabilities.md",
          "Beliefs.md",
          "Desires.md",
          "Goals.md",
          "Intentions.md",
          "Plans.md",
          "Playbooks.md",
          "Knowledge.md",
          "Memory.md",
        ];
        let created = 0;

        for (const agent of agents) {
          const agentPath = join(bizDir, "agents", agent.id);
          await writeMd(
            join(agentPath, "Persona.md"),
            `# Persona — ${agent.name}\n\n**Role:** ${agent.name}\n**Agent ID:** ${agent.id}\n**Type:** Domain-specific\n\n## Identity\n${agent.role}\n`,
          );
          for (const f of cogFiles.slice(1)) {
            await writeMd(
              join(agentPath, f),
              `# ${f.replace(".md", "")} — ${agent.name}\n\nInitialized: ${new Date().toISOString().split("T")[0]}\n`,
            );
          }
          await writeJson(join(agentPath, "inbox.json"), []);
          await writeJson(join(agentPath, "cases.json"), []);
          await writeJson(join(agentPath, "agent.json"), {
            id: agent.id,
            name: agent.name,
            bdi: {
              commitmentStrategy: "open-minded",
              cycleFrequency: { fullCycleMinutes: 120, quickCheckMinutes: 30 },
              reasoningMethods: ["means-ends", "heuristic"],
            },
          });
          created++;
        }

        // Update business manifest
        const manifest = await readJson(join(bizDir, "manifest.json"));
        if (manifest) {
          manifest.domain_agents = agents.map((a) => a.id);
          await writeJson(join(bizDir, "manifest.json"), manifest);
        }

        return textResult(`Spawned ${created} domain agents for ${params.business_type}:
${agents.map((a) => `- **${a.id}:** ${a.name} — ${a.role}`).join("\n")}`);
      },
    },

    {
      name: "onboard_business",
      label: "Full Business Onboarding",
      description:
        "End-to-end business onboarding: create business, generate BMC, spawn agents. Use orchestrate=true to also init desires and sync SBVR.",
      parameters: OnboardFullParams,
      async execute(_id: string, params: Static<typeof OnboardFullParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);
        const now = new Date().toISOString();

        if (existsSync(bizDir)) {
          return textResult(
            `Business '${params.business_id}' already exists. Use individual tools to modify.`,
          );
        }

        // 1. Create business manifest
        const manifest = {
          id: params.business_id,
          name: params.name,
          legal_name: params.legal_name,
          type: params.type,
          description: params.description,
          jurisdiction: params.jurisdiction || "",
          stage: params.stage || "mvp",
          status: "active",
          created: now,
          agents: [...AGENT_ROLES],
          domain_agents: [],
        };
        await writeJson(join(bizDir, "manifest.json"), manifest);

        // 2. Copy agent templates
        const templateBase = join(ws, "extensions", "mabos", "templates", "base", "agents");
        let filesCreated = 0;
        for (const role of AGENT_ROLES) {
          const agentPath = join(bizDir, "agents", role);
          const templatePath = join(templateBase, role);

          // Copy Persona.md from template if exists, otherwise generate
          if (existsSync(join(templatePath, "Persona.md"))) {
            const persona = await readFile(join(templatePath, "Persona.md"), "utf-8");
            await writeMd(
              join(agentPath, "Persona.md"),
              persona.replace(/\{business_name\}/g, params.name),
            );
            filesCreated++;
          }
          if (existsSync(join(templatePath, "Capabilities.md"))) {
            await writeMd(
              join(agentPath, "Capabilities.md"),
              await readFile(join(templatePath, "Capabilities.md"), "utf-8"),
            );
            filesCreated++;
          }

          // Copy agent.json (BDI schema) from template if exists
          if (existsSync(join(templatePath, "agent.json"))) {
            const agentJson = await readFile(join(templatePath, "agent.json"), "utf-8");
            await writeJson(join(agentPath, "agent.json"), JSON.parse(agentJson));
            filesCreated++;
          }

          // Initialize remaining cognitive files
          for (const f of [
            "Beliefs.md",
            "Desires.md",
            "Goals.md",
            "Intentions.md",
            "Plans.md",
            "Playbooks.md",
            "Knowledge.md",
            "Memory.md",
          ]) {
            await writeMd(
              join(agentPath, f),
              `# ${f.replace(".md", "")} — ${role.toUpperCase()}\n\nInitialized: ${now.split("T")[0]}\nBusiness: ${params.name}\n`,
            );
            filesCreated++;
          }
          await writeJson(join(agentPath, "inbox.json"), []);
          await writeJson(join(agentPath, "cases.json"), []);
          await writeJson(join(agentPath, "facts.json"), { facts: [], version: 0 });
          await writeJson(join(agentPath, "rules.json"), { rules: [], version: 0 });
          await writeJson(join(agentPath, "memory-store.json"), {
            working: [],
            short_term: [],
            long_term: [],
            version: 0,
          });
        }

        // 3. Generate BMC
        const bmc = {
          business_id: params.business_id,
          generated_at: now,
          canvas: {
            value_propositions: params.value_propositions,
            customer_segments: params.customer_segments,
            revenue_streams: params.revenue_streams,
          },
        };
        await writeJson(join(bizDir, "business-model-canvas.json"), bmc);

        // 4. Create shared resources
        await writeJson(join(bizDir, "decision-queue.json"), []);
        await writeJson(join(bizDir, "metrics.json"), { metrics: [], snapshots: [] });
        await writeMd(
          join(bizDir, "README.md"),
          `# ${params.name}\n\n**Legal:** ${params.legal_name}\n**Type:** ${params.type}\n**Created:** ${now}\n\n${params.description}\n`,
        );

        // 5. Orchestrate additional steps if requested
        const orchestrationResults: string[] = [];
        if (params.orchestrate) {
          // 5a. Spawn domain agents
          const domainAgents: Record<string, Array<{ id: string; name: string; role: string }>> = {
            ecommerce: [
              {
                id: "inventory-mgr",
                name: "Inventory Manager",
                role: "Manages stock levels, reorder points, and supplier relationships",
              },
              {
                id: "fulfillment-mgr",
                name: "Fulfillment Manager",
                role: "Handles order processing, shipping, and returns",
              },
              {
                id: "product-mgr",
                name: "Product Manager",
                role: "Manages product catalog, pricing, and listings",
              },
            ],
            saas: [
              {
                id: "devops",
                name: "DevOps Engineer",
                role: "Manages deployments, monitoring, uptime, and infrastructure",
              },
              {
                id: "product-mgr",
                name: "Product Manager",
                role: "Manages feature roadmap, user research, and releases",
              },
              {
                id: "customer-success",
                name: "Customer Success",
                role: "Manages onboarding, retention, and churn prevention",
              },
            ],
            consulting: [
              {
                id: "engagement-mgr",
                name: "Engagement Manager",
                role: "Manages client engagements, milestones, and deliverables",
              },
              {
                id: "biz-dev",
                name: "Business Development",
                role: "Manages pipeline, proposals, and client acquisition",
              },
            ],
            marketplace: [
              {
                id: "supply-mgr",
                name: "Supply Manager",
                role: "Manages seller onboarding, quality, and trust scoring",
              },
              {
                id: "demand-mgr",
                name: "Demand Manager",
                role: "Manages buyer acquisition, matching, and experience",
              },
              {
                id: "trust-safety",
                name: "Trust & Safety",
                role: "Manages disputes, fraud prevention, and platform integrity",
              },
            ],
            retail: [
              {
                id: "store-mgr",
                name: "Store Manager",
                role: "Manages store operations, staff scheduling, and customer experience",
              },
              {
                id: "merchandiser",
                name: "Merchandiser",
                role: "Manages product placement, promotions, and visual merchandising",
              },
            ],
          };
          const agents = domainAgents[params.type] || [];
          const cogFiles = [
            "Persona.md",
            "Capabilities.md",
            "Beliefs.md",
            "Desires.md",
            "Goals.md",
            "Intentions.md",
            "Plans.md",
            "Playbooks.md",
            "Knowledge.md",
            "Memory.md",
          ];
          for (const agent of agents) {
            const agentPath = join(bizDir, "agents", agent.id);
            await writeMd(
              join(agentPath, "Persona.md"),
              `# Persona — ${agent.name}\n\n**Role:** ${agent.name}\n**Agent ID:** ${agent.id}\n**Type:** Domain-specific\n\n## Identity\n${agent.role}\n`,
            );
            for (const f of cogFiles.slice(1)) {
              await writeMd(
                join(agentPath, f),
                `# ${f.replace(".md", "")} — ${agent.name}\n\nInitialized: ${now.split("T")[0]}\n`,
              );
            }
            await writeJson(join(agentPath, "inbox.json"), []);
            await writeJson(join(agentPath, "cases.json"), []);
          }
          (manifest as any).domain_agents = agents.map((a) => a.id);
          await writeJson(join(bizDir, "manifest.json"), manifest);
          orchestrationResults.push(`Domain agents: ${agents.length} spawned`);

          // 5b. Initialize desires from templates
          const templateDir = join(ws, "extensions", "mabos", "templates", "base");
          let desiresInitialized = 0;
          for (const role of AGENT_ROLES) {
            const templateFile = join(templateDir, `desires-${role}.md`);
            if (existsSync(templateFile)) {
              let content = await readFile(templateFile, "utf-8");
              content = content.replace(/\{business_name\}/g, params.name);
              await writeMd(join(bizDir, "agents", role, "Desires.md"), content);
              desiresInitialized++;
            }
          }
          orchestrationResults.push(`Desires: ${desiresInitialized} agents initialized`);

          // 5c. SBVR sync to backend + TypeDB schema push (best-effort)
          try {
            const { loadOntologies, mergeOntologies, exportSBVRForTypeDB } =
              await import("../ontology/index.js");
            const ontologies = loadOntologies();
            const graph = mergeOntologies(ontologies);
            const sbvrExport = exportSBVRForTypeDB(graph);

            const backendUrl = "http://localhost:8000";
            const payload = {
              business_id: params.business_id,
              business_name: params.name,
              business_type: params.type,
              agent_roles: [...AGENT_ROLES],
              sbvr_export: sbvrExport,
            };

            const response = await fetch(`${backendUrl}/api/businesses/onboard`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });

            if (response.ok) {
              orchestrationResults.push("SBVR: Synced to backend");
            } else {
              await writeJson(join(bizDir, "sbvr-export.json"), sbvrExport);
              orchestrationResults.push("SBVR: Backend unavailable, saved locally");
            }

            // Push TypeQL schema to TypeDB (best-effort)
            try {
              const { getTypeDBClient } = await import("../knowledge/typedb-client.js");
              const { jsonldToTypeQL, generateDefineQuery } =
                await import("../knowledge/typedb-schema.js");
              const { getBaseSchema } = await import("../knowledge/typedb-queries.js");
              const client = getTypeDBClient();
              if (client.isAvailable()) {
                const dbName = `mabos_${params.business_id}`;
                await client.ensureDatabase(dbName);
                await client.defineSchema(getBaseSchema(), dbName);
                const ontologySchema = generateDefineQuery(jsonldToTypeQL(graph));
                await client.defineSchema(ontologySchema, dbName);
                orchestrationResults.push("TypeDB: Schema pushed");
              }
            } catch {
              orchestrationResults.push("TypeDB: Schema push skipped (unavailable)");
            }
          } catch {
            orchestrationResults.push("SBVR: Sync skipped (backend/ontology unavailable)");
          }

          // 5d. Write onboarding progress
          const progress = {
            business_id: params.business_id,
            started_at: now,
            phases: {
              discovery: { status: "completed", started_at: now, completed_at: now },
              architecture: { status: "completed", started_at: now, completed_at: now },
              agents: { status: "completed", started_at: now, completed_at: now },
              knowledge_graph: { status: "completed", started_at: now, completed_at: now },
              launch: { status: "completed", started_at: now, completed_at: now },
            },
            current_phase: "launch",
            overall_status: "completed",
          };
          await writeJson(join(bizDir, "onboarding-progress.json"), progress);
        }

        const orchestrateSection =
          params.orchestrate && orchestrationResults.length > 0
            ? `\n**Orchestration:**\n${orchestrationResults.map((r) => `- ${r}`).join("\n")}`
            : "";

        return textResult(`## Business Onboarded: ${params.name}

- **ID:** ${params.business_id}
- **Type:** ${params.type}
- **Stage:** ${params.stage || "mvp"}
- **Core agents:** ${AGENT_ROLES.length} (${AGENT_ROLES.join(", ")})
- **Cognitive files:** ${filesCreated}
- **BMC:** Generated
- **Location:** ${bizDir}${orchestrateSection}

**Next steps:**
1. Run \`togaf_generate\` for enterprise architecture model
2. Run \`tropos_generate\` with stakeholder goals
3. Run \`agent_spawn_domain\` for ${params.type}-specific agents
4. Initialize desires via \`desire_create\` for each agent
5. Run \`bdi_cycle\` for CEO to kickstart operations`);
      },
    },

    // ── New Tools ──────────────────────────────────────────────────────────

    {
      name: "desire_init_from_template",
      label: "Initialize Desires from Templates",
      description: "Batch-initialize desires for all 9 (or specified) agent roles from templates.",
      parameters: DesireInitParams,
      async execute(_id: string, params: Static<typeof DesireInitParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);

        if (!existsSync(bizDir)) {
          return textResult(
            `Business '${params.business_id}' not found. Run onboard_business first.`,
          );
        }

        const manifest = await readJson(join(bizDir, "manifest.json"));
        const businessName = manifest?.name || params.business_id;
        const roles = params.roles || [...AGENT_ROLES];
        const results: string[] = [];

        for (const role of roles) {
          const templateFile = join(TEMPLATE_DIR, `desires-${role}.md`);
          const agentDesires = join(bizDir, "agents", role, "Desires.md");

          if (!existsSync(templateFile)) {
            results.push(`${role}: no template found`);
            continue;
          }

          let content = await readFile(templateFile, "utf-8");
          content = content.replace(/\{business_name\}/g, businessName);
          await writeMd(agentDesires, content);
          results.push(`${role}: initialized`);
        }

        return textResult(`## Desires Initialized for ${params.business_id}

${results.map((r) => `- **${r}**`).join("\n")}

${results.filter((r) => r.includes("initialized")).length}/${roles.length} agents initialized from templates.`);
      },
    },

    {
      name: "sbvr_sync_to_backend",
      label: "Sync SBVR to Backend",
      description:
        "Export the SBVR ontology and push it to the backend, creating business and agent schema in TypeDB.",
      parameters: SbvrSyncParams,
      async execute(_id: string, params: Static<typeof SbvrSyncParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);
        const backendUrl = params.backend_url || "http://localhost:8000";

        if (!existsSync(bizDir)) {
          return textResult(
            `Business '${params.business_id}' not found. Run onboard_business first.`,
          );
        }

        const manifest = await readJson(join(bizDir, "manifest.json"));
        if (!manifest) {
          return textResult(`No manifest found for '${params.business_id}'.`);
        }

        // Load and export SBVR ontology
        let sbvrExport;
        let ontologyGraph;
        try {
          const { loadOntologies, mergeOntologies, exportSBVRForTypeDB } =
            await import("../ontology/index.js");
          const ontologies = loadOntologies();
          ontologyGraph = mergeOntologies(ontologies);
          sbvrExport = exportSBVRForTypeDB(ontologyGraph);
        } catch (e) {
          return textResult(`Failed to load ontologies: ${e}`);
        }

        const payload = {
          business_id: params.business_id,
          business_name: manifest.name,
          business_type: manifest.type,
          agent_roles: manifest.agents || [...AGENT_ROLES],
          sbvr_export: sbvrExport,
        };

        // Attempt POST to backend
        try {
          const response = await fetch(`${backendUrl}/api/businesses/onboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (response.ok) {
            const result = (await response.json()) as { agent_ids?: string[] };

            // Also push TypeQL schema to TypeDB (best-effort)
            let typedbStatus = "skipped";
            try {
              const { getTypeDBClient } = await import("../knowledge/typedb-client.js");
              const { jsonldToTypeQL, generateDefineQuery } =
                await import("../knowledge/typedb-schema.js");
              const { getBaseSchema } = await import("../knowledge/typedb-queries.js");
              const client = getTypeDBClient();
              if (client.isAvailable() && ontologyGraph) {
                const dbName = `mabos_${params.business_id}`;
                await client.ensureDatabase(dbName);
                await client.defineSchema(getBaseSchema(), dbName);
                const ontologySchema = generateDefineQuery(jsonldToTypeQL(ontologyGraph));
                await client.defineSchema(ontologySchema, dbName);
                typedbStatus = "schema pushed";
              }
            } catch {
              typedbStatus = "unavailable";
            }

            return textResult(`## SBVR Synced to Backend

- **Business:** ${manifest.name} (${params.business_id})
- **Backend:** ${backendUrl}
- **Concept Types:** ${sbvrExport.conceptTypes.length}
- **Fact Types:** ${sbvrExport.factTypes.length}
- **Rules:** ${sbvrExport.rules.length}
- **Proof Tables:** ${sbvrExport.proofTables.length}
- **Agent Nodes:** ${(result.agent_ids || []).length}
- **TypeDB:** ${typedbStatus}

Backend sync completed successfully.`);
          } else {
            const errText = await response.text().catch(() => "unknown error");
            // Save locally as fallback
            await writeJson(join(bizDir, "sbvr-export.json"), sbvrExport);
            return textResult(`## SBVR Sync — Saved Locally

Backend returned ${response.status}: ${errText}
Export saved to \`businesses/${params.business_id}/sbvr-export.json\` for later sync.

**Ontology stats:**
- Concept Types: ${sbvrExport.conceptTypes.length}
- Fact Types: ${sbvrExport.factTypes.length}
- Rules: ${sbvrExport.rules.length}
- Proof Tables: ${sbvrExport.proofTables.length}`);
          }
        } catch {
          // Network error — save locally
          await writeJson(join(bizDir, "sbvr-export.json"), sbvrExport);
          return textResult(`## SBVR Sync — Saved Locally

Backend at ${backendUrl} is unreachable.
Export saved to \`businesses/${params.business_id}/sbvr-export.json\` for later sync.

**Ontology stats:**
- Concept Types: ${sbvrExport.conceptTypes.length}
- Fact Types: ${sbvrExport.factTypes.length}
- Rules: ${sbvrExport.rules.length}
- Proof Tables: ${sbvrExport.proofTables.length}`);
        }
      },
    },

    {
      name: "onboarding_progress",
      label: "Onboarding Progress",
      description: "Track onboarding phase state. Optionally renders a Canvas progress view.",
      parameters: OnboardingProgressParams,
      async execute(_id: string, params: Static<typeof OnboardingProgressParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);
        const progressFile = join(bizDir, "onboarding-progress.json");
        const now = new Date().toISOString();

        if (!existsSync(bizDir)) {
          return textResult(`Business '${params.business_id}' not found.`);
        }

        // Load or create progress state
        const PHASES = [
          "discovery",
          "architecture",
          "agents",
          "knowledge_graph",
          "launch",
        ] as const;
        let progress = await readJson(progressFile);
        if (!progress) {
          progress = {
            business_id: params.business_id,
            started_at: now,
            phases: {} as Record<string, any>,
            current_phase: params.phase,
            overall_status: "in_progress",
          };
          for (const p of PHASES) {
            progress.phases[p] = { status: "pending", started_at: null, completed_at: null };
          }
        }

        // Update the specified phase
        const phaseData = progress.phases[params.phase];
        if (params.status === "started") {
          phaseData.status = "in_progress";
          phaseData.started_at = now;
        } else if (params.status === "completed") {
          phaseData.status = "completed";
          phaseData.completed_at = now;
          if (!phaseData.started_at) phaseData.started_at = now;
        } else if (params.status === "retry") {
          phaseData.status = "in_progress";
          phaseData.started_at = now;
          phaseData.completed_at = null;
        } else {
          phaseData.status = params.status;
        }
        if (params.details) phaseData.details = params.details;

        progress.current_phase = params.phase;

        // Compute overall status
        const allCompleted = PHASES.every((p) => progress.phases[p].status === "completed");
        const anyFailed = PHASES.some((p) => progress.phases[p].status === "failed");
        progress.overall_status = allCompleted
          ? "completed"
          : anyFailed
            ? "has_failures"
            : "in_progress";

        await writeJson(progressFile, progress);

        // Build status summary
        const statusIcons: Record<string, string> = {
          pending: "( )",
          in_progress: "(~)",
          completed: "(x)",
          failed: "(!)",
          skipped: "(-)",
        };
        const phaseLabels: Record<string, string> = {
          discovery: "Discovery",
          architecture: "Architecture",
          agents: "Agent Activation",
          knowledge_graph: "Knowledge Graph",
          launch: "Launch",
        };

        let summary = `## Onboarding Progress — ${params.business_id}\n\n`;
        for (const p of PHASES) {
          const s = progress.phases[p].status;
          const icon = statusIcons[s] || "( )";
          summary += `${icon} **${phaseLabels[p]}** — ${s}\n`;
        }
        summary += `\nOverall: **${progress.overall_status}**`;

        // Canvas HTML if requested
        if (params.show_canvas) {
          const phaseColors: Record<string, string> = {
            pending: "#555",
            in_progress: "#2196F3",
            completed: "#4CAF50",
            failed: "#f44336",
            skipped: "#9E9E9E",
          };

          const stepsHtml = PHASES.map((p, i) => {
            const s = progress.phases[p].status;
            const color = phaseColors[s] || "#555";
            const check =
              s === "completed"
                ? "&#10003;"
                : s === "in_progress"
                  ? "&#9881;"
                  : s === "failed"
                    ? "&#10007;"
                    : `${i + 1}`;
            return `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:${color}22;border-left:4px solid ${color};border-radius:4px;margin-bottom:8px;">
              <div style="width:32px;height:32px;border-radius:50%;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:16px;">${check}</div>
              <div><div style="font-weight:600;color:#eee;">${phaseLabels[p]}</div><div style="font-size:12px;color:#999;">${s}</div></div>
            </div>`;
          }).join("");

          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Onboarding Progress</title></head>
<body style="font-family:Inter,-apple-system,sans-serif;background:#1a1a1a;color:#eee;padding:24px;margin:0;">
<h2 style="margin:0 0 4px 0;">Onboarding Pipeline</h2>
<p style="color:#888;margin:0 0 20px 0;">${params.business_id}</p>
${stepsHtml}
<div style="margin-top:16px;padding:12px;background:#2d2d2d;border-radius:8px;text-align:center;">
<span style="font-size:14px;color:#aaa;">Overall:</span> <strong style="color:${progress.overall_status === "completed" ? "#4CAF50" : progress.overall_status === "has_failures" ? "#f44336" : "#2196F3"}">${progress.overall_status.toUpperCase()}</strong>
</div></body></html>`;

          summary += `\n\n**Canvas HTML:** ${html.length} characters generated.`;
        }

        return textResult(summary);
      },
    },
  ];
}
