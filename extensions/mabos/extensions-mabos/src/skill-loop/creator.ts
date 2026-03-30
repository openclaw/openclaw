import type { SkillRegistry } from "./registry.js";
import type { SkillProposal, SkillManifest } from "./types.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export class SkillCreator {
  constructor(private registry: SkillRegistry) {}

  async proposeSkill(params: {
    taskDescription: string;
    toolsUsed: string[];
    outcome: "success" | "partial" | "failure";
    agentId: string;
    sessionId?: string;
  }): Promise<SkillProposal | null> {
    // Only propose from successful multi-step sessions
    if (params.outcome === "failure") return null;
    if (params.toolsUsed.length < 3) return null;

    // Check if this pattern is already covered
    const existing = this.registry.search(params.taskDescription);
    if (existing.length > 0) return null;

    const name = slugify(params.taskDescription);
    const manifest: SkillManifest = {
      name,
      version: "1.0.0",
      description: params.taskDescription,
      author: params.agentId,
      tags: extractTags(params.toolsUsed),
      toolsRequired: params.toolsUsed,
      createdFromSession: params.sessionId,
      createdAt: new Date().toISOString(),
      confidence: calculateConfidence(params.toolsUsed.length, params.outcome),
    };

    const skillMd = renderSkillMd(params.taskDescription, params.toolsUsed);

    return { name, skillMd, manifest, confidence: manifest.confidence! };
  }
}

function extractTags(tools: string[]): string[] {
  const tags = new Set<string>();
  for (const tool of tools) {
    const prefix = tool.split("_")[0];
    if (prefix) tags.add(prefix);
  }
  return Array.from(tags).slice(0, 5);
}

function calculateConfidence(toolCount: number, outcome: string): number {
  let base = outcome === "success" ? 0.7 : 0.4;
  base += Math.min(toolCount * 0.03, 0.2);
  return Math.min(base, 0.95);
}

function renderSkillMd(description: string, tools: string[]): string {
  return `# ${description}

## Overview
This skill was auto-generated from a successful agent session.

## Tools Used
${tools.map((t) => `- \`${t}\``).join("\n")}

## Steps
1. Analyze the current context
2. Execute the required tool sequence
3. Verify the outcome
`;
}
