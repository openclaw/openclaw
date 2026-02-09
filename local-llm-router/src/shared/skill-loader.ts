/**
 * Skill loader — discovers and loads SKILL.md files.
 * Filters by agent scope (personal/coding/system tiers).
 * Auto-discovers on startup and watches for changes.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { stripFrontMatter } from "../persistence/workspace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillMetadata {
  name: string;
  description: string;
  requires?: {
    tools?: string[];
  };
  approval?: string;
  agent?: string;
}

export interface Skill {
  name: string;
  description: string;
  tier: "personal" | "coding" | "system";
  filePath: string;
  content: string; // Full markdown body (without frontmatter)
  metadata: SkillMetadata;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): Record<string, any> {
  if (!raw.startsWith("---")) return {};

  const endIndex = raw.indexOf("\n---", 3);
  if (endIndex === -1) return {};

  const yamlBlock = raw.slice(4, endIndex).trim();
  const result: Record<string, any> = {};

  // Simple YAML parser for flat + nested fields
  let currentKey = "";
  let indent = 0;

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    if (value === "" || value === "|" || value === ">") {
      // Nested object or block scalar — skip for now
      currentKey = key;
      continue;
    }

    // Strip quotes
    const cleaned = value.replace(/^["']|["']$/g, "");
    result[key] = cleaned;
  }

  // Try parsing metadata as JSON if it exists
  const metadataMatch = raw.match(/metadata:\s*\n([\s\S]*?)(?=\n---)/);
  if (metadataMatch) {
    try {
      // Look for JSON block in metadata
      const jsonMatch = raw.match(/metadata:\s*\n\s*(\{[\s\S]*?\})\s*\n---/);
      if (jsonMatch) {
        result.metadata = JSON.parse(jsonMatch[1]);
      }
    } catch {
      // Skip malformed metadata
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Skill loading
// ---------------------------------------------------------------------------

/**
 * Load a single skill from a SKILL.md file.
 */
async function loadSkill(
  skillDir: string,
  tier: "personal" | "coding" | "system",
): Promise<Skill | null> {
  const skillPath = path.join(skillDir, "SKILL.md");

  try {
    const raw = await fs.readFile(skillPath, "utf-8");
    const frontmatter = parseFrontmatter(raw);
    const content = stripFrontMatter(raw);

    const name =
      frontmatter.name ?? path.basename(skillDir);
    const description = frontmatter.description ?? "";

    const metadata: SkillMetadata = {
      name,
      description,
      requires: frontmatter.metadata?.requires,
      approval: frontmatter.metadata?.approval,
      agent: frontmatter.metadata?.agent,
    };

    return {
      name,
      description,
      tier,
      filePath: skillPath,
      content,
      metadata,
    };
  } catch {
    return null;
  }
}

/**
 * Load all skills from the skills directory.
 * Scans personal/, coding/, system/ subdirectories.
 * Higher tiers override lower ones (personal > coding > system).
 */
export async function loadAllSkills(
  skillsDir: string,
): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  const tiers: Array<"system" | "coding" | "personal"> = [
    "system",
    "coding",
    "personal",
  ]; // Load in priority order (last wins)

  for (const tier of tiers) {
    const tierDir = path.join(skillsDir, tier);

    try {
      const entries = await fs.readdir(tierDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skill = await loadSkill(path.join(tierDir, entry.name), tier);
        if (skill) {
          skills.set(skill.name, skill); // Higher tier overrides
        }
      }
    } catch {
      // Tier directory doesn't exist yet — that's fine
    }
  }

  return skills;
}

/**
 * Filter skills that are available to a specific agent.
 */
export function filterSkillsForAgent(
  skills: Map<string, Skill>,
  agentTools: string[],
  agentSkillTiers: string[],
): Skill[] {
  const filtered: Skill[] = [];

  for (const skill of skills.values()) {
    // Check tier is allowed for this agent
    if (!agentSkillTiers.includes(skill.tier)) {
      continue;
    }

    // Check required tools are available to this agent
    const requiredTools = skill.metadata.requires?.tools ?? [];
    const hasAllTools = requiredTools.every((t) => agentTools.includes(t));
    if (!hasAllTools) {
      continue;
    }

    filtered.push(skill);
  }

  return filtered;
}

/**
 * Format skills for injection into system prompt.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const lines: string[] = [
    "## Available Skills",
    "",
    "Before replying, check if a skill matches the task.",
    "If one clearly applies, follow its instructions.",
    "",
    "<available_skills>",
  ];

  for (const skill of skills) {
    lines.push(
      `- **/${skill.name}**: ${skill.description}`,
      `  Location: ${skill.filePath}`,
      `  Tier: ${skill.tier}`,
    );
  }

  lines.push("</available_skills>", "");

  return lines.join("\n");
}
