/**
 * Business Management Tools — venture creation, listing, and status
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

const COGNITIVE_FILES = [
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

const BusinessCreateParams = Type.Object({
  business_id: Type.String({
    description: "Unique business identifier (slug, e.g., 'acme-consulting')",
  }),
  name: Type.String({ description: "Business display name" }),
  legal_name: Type.String({ description: "Legal entity name" }),
  type: Type.Union(
    [
      Type.Literal("ecommerce"),
      Type.Literal("saas"),
      Type.Literal("consulting"),
      Type.Literal("marketplace"),
      Type.Literal("retail"),
      Type.Literal("other"),
    ],
    { description: "Business type" },
  ),
  description: Type.Optional(Type.String({ description: "Business description" })),
  jurisdiction: Type.Optional(Type.String({ description: "Legal jurisdiction" })),
});

const BusinessListParams = Type.Object({
  status: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("inactive"), Type.Literal("all")], {
      description: "Filter by status. Default: active",
    }),
  ),
});

const BusinessStatusParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  include_agents: Type.Optional(Type.Boolean({ description: "Include agent statuses" })),
  include_decisions: Type.Optional(Type.Boolean({ description: "Include pending decisions" })),
});

function agentPersona(role: string, bizName: string): string {
  const personas: Record<string, string> = {
    ceo: `Chief Executive Officer of ${bizName}. Responsible for overall strategy, vision, and inter-agent coordination.`,
    cfo: `Chief Financial Officer of ${bizName}. Manages financial planning, budgeting, cash flow, and financial reporting.`,
    coo: `Chief Operating Officer of ${bizName}. Oversees daily operations, process optimization, and resource allocation.`,
    cmo: `Chief Marketing Officer of ${bizName}. Drives marketing strategy, brand management, and customer acquisition.`,
    cto: `Chief Technology Officer of ${bizName}. Manages technology strategy, architecture, and technical execution.`,
    hr: `Head of Resource Engagement for ${bizName}. Manages freelancer/contractor relationships, work packages, and talent pool.`,
    legal: `Legal Counsel for ${bizName}. Handles compliance, contracts, IP, and regulatory matters.`,
    strategy: `Chief Strategy Officer of ${bizName}. Conducts market analysis, competitive intelligence, and strategic planning.`,
    knowledge: `Knowledge Manager for ${bizName}. Maintains ontologies, case bases, and organizational learning.`,
  };
  return personas[role] || `${role} agent for ${bizName}.`;
}

export function createBusinessTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "business_create",
      label: "Create Business",
      description:
        "Create a new business venture with isolated workspace, 9 C-suite agents, and cognitive files.",
      parameters: BusinessCreateParams,
      async execute(_id: string, params: Static<typeof BusinessCreateParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);

        if (existsSync(bizDir)) {
          return textResult(`Business '${params.business_id}' already exists at ${bizDir}`);
        }

        // Create business manifest
        const manifest = {
          id: params.business_id,
          name: params.name,
          legal_name: params.legal_name,
          type: params.type,
          description: params.description || "",
          jurisdiction: params.jurisdiction || "",
          status: "active",
          created: new Date().toISOString(),
          agents: AGENT_ROLES.map((r) => r),
        };
        await writeJson(join(bizDir, "manifest.json"), manifest);

        // Create agent directories with cognitive files
        let filesCreated = 0;
        for (const role of AGENT_ROLES) {
          const agentPath = join(bizDir, "agents", role);
          for (const file of COGNITIVE_FILES) {
            const filePath = join(agentPath, file);
            if (file === "Persona.md") {
              await writeMd(
                filePath,
                `# Persona — ${role.toUpperCase()}\n\n**Role:** ${role.toUpperCase()}\n**Business:** ${params.name}\n\n${agentPersona(role, params.name)}\n`,
              );
            } else {
              await writeMd(
                filePath,
                `# ${file.replace(".md", "")} — ${role.toUpperCase()}\n\nInitialized: ${new Date().toISOString().split("T")[0]}\n`,
              );
            }
            filesCreated++;
          }
          // Create empty inbox and cases
          await writeJson(join(agentPath, "inbox.json"), []);
          await writeJson(join(agentPath, "cases.json"), []);
        }

        // Create shared resources
        await writeJson(join(bizDir, "decision-queue.json"), []);
        await writeJson(join(bizDir, "metrics.json"), { metrics: [], snapshots: [] });
        await writeMd(
          join(bizDir, "README.md"),
          `# ${params.name}\n\n**Legal Entity:** ${params.legal_name}\n**Type:** ${params.type}\n**Created:** ${manifest.created}\n`,
        );

        return textResult(`Business '${params.name}' created successfully.
- **ID:** ${params.business_id}
- **Type:** ${params.type}
- **Agents:** ${AGENT_ROLES.length} (${AGENT_ROLES.join(", ")})
- **Cognitive files:** ${filesCreated}
- **Location:** ${bizDir}`);
      },
    },

    {
      name: "business_list",
      label: "List Businesses",
      description: "List all managed business ventures with status overview.",
      parameters: BusinessListParams,
      async execute(_id: string, params: Static<typeof BusinessListParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizRoot = join(ws, "businesses");

        if (!existsSync(bizRoot)) return textResult("No businesses created yet.");

        const dirs = await readdir(bizRoot, { withFileTypes: true });
        const businesses: string[] = [];

        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          const manifest = await readJson(join(bizRoot, d.name, "manifest.json"));
          if (!manifest) continue;

          const status = params.status || "active";
          if (status !== "all" && manifest.status !== status) continue;

          const decisions = (await readJson(join(bizRoot, d.name, "decision-queue.json"))) || [];
          const pending = decisions.filter((d: any) => d.status === "pending").length;

          businesses.push(`### ${manifest.name} (${manifest.id})
- **Type:** ${manifest.type}
- **Status:** ${manifest.status}
- **Legal:** ${manifest.legal_name}
- **Agents:** ${manifest.agents?.length || 0}
- **Pending decisions:** ${pending}`);
        }

        if (businesses.length === 0) return textResult("No businesses found matching filter.");
        return textResult(`## Business Portfolio\n\n${businesses.join("\n\n")}`);
      },
    },

    {
      name: "business_status",
      label: "Business Status",
      description:
        "Get detailed status of a specific business including agents and pending decisions.",
      parameters: BusinessStatusParams,
      async execute(_id: string, params: Static<typeof BusinessStatusParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);
        const manifest = await readJson(join(bizDir, "manifest.json"));

        if (!manifest) return textResult(`Business '${params.business_id}' not found.`);

        let output = `## ${manifest.name} — Status\n\n- **Type:** ${manifest.type}\n- **Status:** ${manifest.status}\n- **Legal:** ${manifest.legal_name}\n- **Created:** ${manifest.created}\n`;

        if (params.include_agents) {
          output += "\n### Agents\n";
          for (const role of manifest.agents || []) {
            const agentPath = join(bizDir, "agents", role);
            const goals = await readJson(join(agentPath, "Goals.md")).catch(() => "");
            const inbox = (await readJson(join(agentPath, "inbox.json"))) || [];
            const unread = inbox.filter((m: any) => !m.read).length;
            output += `- **${role.toUpperCase()}:** ${unread} unread messages\n`;
          }
        }

        if (params.include_decisions) {
          const decisions = (await readJson(join(bizDir, "decision-queue.json"))) || [];
          const pending = decisions.filter((d: any) => d.status === "pending");
          output += `\n### Pending Decisions (${pending.length})\n`;
          for (const d of pending) {
            output += `- **${d.id}:** ${d.title} [${d.urgency}] — ${d.options?.length || 0} options\n`;
          }
        }

        return textResult(output);
      },
    },
  ];
}
