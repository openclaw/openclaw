/**
 * Capabilities Sync Tool
 *
 * Regenerates Capabilities.md from registered MABOS tools (categorized)
 * and OpenClaw eligible skills. Preserves custom sections (Constraints, Notes, etc.).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";
import { getToolsForRole } from "./tool-filter.js";

// --- Category definitions (exported for reuse by HTTP endpoint) ---

export const TOOL_CATEGORIES: Record<string, RegExp[]> = {
  "BDI Cognitive": [
    /^belief_/,
    /^goal_/,
    /^desire_/,
    /^intention_/,
    /^bdi_cycle$/,
    /^plan_/,
    /^skill_inventory$/,
    /^action_log$/,
  ],
  "Reasoning & Knowledge": [
    /^reason/,
    /^knowledge_/,
    /^ontology_/,
    /^fact_/,
    /^infer_/,
    /^htn_/,
    /^rule_/,
    /^cbr_/,
  ],
  Memory: [/^memory_/],
  Communication: [
    /^agent_message/,
    /^agent_spawn/,
    /^contract_net_/,
    /^decision_/,
    /^handoff/,
    /^notify_/,
    /^request_approval/,
  ],
  "Business Operations": [
    /^business_/,
    /^onboard_/,
    /^metrics_/,
    /^analytics_/,
    /^report_/,
    /^financial_/,
    /^workflow_/,
    /^work_package_/,
    /^supply_chain_/,
    /^vendor_/,
    /^sla_/,
    /^capacity_/,
    /^inventory_/,
  ],
  "Marketing & Content": [
    /^content_/,
    /^marketing_/,
    /^ad_/,
    /^audience_/,
    /^conversion_/,
    /^branded_/,
    /^email_/,
    /^sendgrid_/,
    /^sms_/,
    /^whatsapp_/,
    /^seo_/,
  ],
  Infrastructure: [
    /^cloudflare_/,
    /^godaddy_/,
    /^integration_/,
    /^webhook_/,
    /^typedb_/,
    /^setup_/,
    /^cicd_/,
    /^security_/,
    /^apm_/,
  ],
  "E-commerce": [/^shopify_/, /^stripe_/, /^order_/, /^pictorem_/],
};

/**
 * Categorize a tool name into one of the defined categories.
 * Returns "Other" if no pattern matches.
 */
export function categorize(toolName: string): string {
  for (const [category, patterns] of Object.entries(TOOL_CATEGORIES)) {
    for (const pattern of patterns) {
      if (pattern.test(toolName)) {
        return category;
      }
    }
  }
  return "Other";
}

// --- Auto-generated section headers (not preserved as custom) ---

const AUTO_HEADERS = new Set([
  "# Capabilities",
  "## MABOS BDI Tools",
  "## OpenClaw Skills",
  "## Platform Tools",
]);

function isAutoHeader(line: string): boolean {
  // Match headers with or without trailing content like " — agent_id"
  for (const h of AUTO_HEADERS) {
    if (line.startsWith(h)) return true;
  }
  // Also match category sub-headers like "### BDI Cognitive"
  for (const cat of Object.keys(TOOL_CATEGORIES)) {
    if (line === `### ${cat}`) return true;
  }
  if (line === "### Other") return true;
  return false;
}

/**
 * Extract custom sections from existing Capabilities.md.
 * Custom sections are any ## heading blocks that are NOT auto-generated.
 */
function extractCustomSections(content: string): string[] {
  const lines = content.split("\n");
  const sections: string[] = [];
  let currentSection: string[] = [];
  let inCustomSection = false;

  for (const line of lines) {
    const isH2 = line.startsWith("## ") && !line.startsWith("### ");
    const isH1 = line.startsWith("# ") && !line.startsWith("## ");

    if (isH2 || isH1) {
      // Flush previous custom section
      if (inCustomSection && currentSection.length > 0) {
        sections.push(currentSection.join("\n"));
      }
      currentSection = [];

      if (isAutoHeader(line)) {
        inCustomSection = false;
      } else if (isH2) {
        inCustomSection = true;
        currentSection.push(line);
      } else {
        inCustomSection = false;
      }
    } else if (inCustomSection) {
      currentSection.push(line);
    }
  }

  // Flush last section
  if (inCustomSection && currentSection.length > 0) {
    sections.push(currentSection.join("\n"));
  }

  return sections;
}

// --- Helpers ---

async function readMd(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function writeMd(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

// --- Tool Parameters ---

const CapabilitiesSyncParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID (e.g., 'cfo', 'coo')" }),
});

// --- Factory ---

export function createCapabilitiesSyncTools(
  api: OpenClawPluginApi,
  context: { registeredToolNames: string[] },
): AnyAgentTool[] {
  return [
    {
      name: "capabilities_sync",
      label: "Sync Capabilities",
      description:
        "Regenerate Capabilities.md from registered MABOS tools and OpenClaw skills. Preserves custom sections (Constraints, Notes, etc.).",
      parameters: CapabilitiesSyncParams,
      async execute(_id: string, params: Static<typeof CapabilitiesSyncParams>) {
        if (!/^[a-zA-Z0-9_-]+$/.test(params.agent_id)) {
          return textResult(
            `Error: invalid agent_id '${params.agent_id}'. Must be alphanumeric, hyphens, and underscores only.`,
          );
        }
        const ws = resolveWorkspaceDir(api);
        const agentDirPath = join(ws, "agents", params.agent_id);
        const capPath = join(agentDirPath, "Capabilities.md");

        // 1. Read existing Capabilities.md
        const existingContent = await readMd(capPath);

        // 2. Extract custom sections
        const customSections = extractCustomSections(existingContent);

        // 3. Filter tools by agent role, then categorize
        const roleTools = getToolsForRole(params.agent_id, context.registeredToolNames);
        const categorized: Record<string, string[]> = {};
        for (const toolName of roleTools) {
          const cat = categorize(toolName);
          if (!categorized[cat]) categorized[cat] = [];
          categorized[cat].push(toolName);
        }

        // Sort tools within each category
        for (const cat of Object.keys(categorized)) {
          categorized[cat].sort();
        }

        // 4. Get OpenClaw skills (graceful)
        let openclawSkills: Array<{ name: string; primaryEnv?: string }> = [];
        try {
          const snapshot = api.getSkillSnapshot({ workspaceDir: ws });
          openclawSkills = snapshot.skills ?? [];
        } catch {
          // getSkillSnapshot unavailable or threw — not critical
        }

        // 5. Generate Capabilities.md
        const lines: string[] = [];
        lines.push(`# Capabilities — ${params.agent_id}`);
        lines.push("");

        // MABOS BDI Tools section
        lines.push("## MABOS BDI Tools");
        lines.push("");

        // Ordered categories: defined order first, then "Other"
        const categoryOrder = [...Object.keys(TOOL_CATEGORIES), "Other"];
        let mabosToolCount = 0;

        for (const cat of categoryOrder) {
          const tools = categorized[cat];
          if (!tools || tools.length === 0) continue;
          lines.push(`### ${cat}`);
          lines.push("");
          for (const t of tools) {
            lines.push(`- \`${t}\``);
            mabosToolCount++;
          }
          lines.push("");
        }

        // OpenClaw Skills section (only if there are skills)
        let openclawCount = 0;
        if (openclawSkills.length > 0) {
          lines.push("## OpenClaw Skills");
          lines.push("");
          for (const sk of openclawSkills) {
            const envNote = sk.primaryEnv ? ` _(${sk.primaryEnv})_` : "";
            lines.push(`- \`${sk.name}\`${envNote}`);
            openclawCount++;
          }
          lines.push("");
        }

        // Preserved custom sections at the end
        if (customSections.length > 0) {
          for (const section of customSections) {
            lines.push(section);
            lines.push("");
          }
        }

        const output =
          lines
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trimEnd() + "\n";

        // 6. Write to agent dir
        await writeMd(capPath, output);

        // 7. Return result with counts
        return textResult(
          `Capabilities.md synced for '${params.agent_id}': ${mabosToolCount} MABOS tools (${Object.keys(categorized).length} categories), ${openclawCount} OpenClaw skills, ${customSections.length} custom sections preserved.`,
        );
      },
    },
  ];
}
