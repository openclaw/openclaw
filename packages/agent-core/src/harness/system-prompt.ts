// Agent Core module implements system prompt behavior with live LLMOps integration lanes.
import * as fs from "node:fs";
import { LlmOpsSubsystem } from "../llmops/index.js";
import type { Skill } from "./types.js";

/** Format model-visible skill metadata for inclusion in the harness system prompt. */
export function formatSkillsForSystemPrompt(skills: Skill[]): string {
  // Hidden skills can still be invoked directly by host code, but should not be
  // advertised to the model for autonomous selection.
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the full skill file when the task matches its description.",
    "If a skill's <version> differs from a previous turn, re-read its SKILL.md before using it.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    if (skill.promptVersion) {
      lines.push(`    <version>${escapeXml(skill.promptVersion)}</version>`);
    }
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

/**
 * 🎯 THE SYSTEM PROMPT ORCHESTRATOR: Resolves AGENTS.md from Langfuse
 * and attaches the synchronized runtime skill matrix blocks.
 */
export async function compileSystemPrompt(
  localAgentsMdPath: string,
  availableSkills: Skill[],
  contextVars: Record<string, any> = {},
): Promise<string> {
  // 1. Establish pristine disk fallback from your baked container filesystem
  let agentsMarkdownBase = "";
  try {
    if (fs.existsSync(localAgentsMdPath)) {
      agentsMarkdownBase = fs.readFileSync(localAgentsMdPath, "utf-8");
    }
  } catch (error) {
    console.error(`[SystemPrompt] Warning: Static fallback file missing at ${localAgentsMdPath}`);
  }

  // 2. Query the active LLMOps telemetry client state
  const llmOps = LlmOpsSubsystem.getInstance();
  const promptName = "openclaw-agents-manifest";

  if (llmOps?.tracker && llmOps.tracker.config?.prompts?.enabled) {
    try {
      const remotePrompt = await llmOps.tracker.getPrompt(promptName);
      if (remotePrompt) {
        // Compile the markdown with real-time runtime token variables
        agentsMarkdownBase = remotePrompt.compile({
          clusterNode: process.env.TARGET_NODE || "guardianhub-edge",
          timestamp: new Date().toISOString(),
          ...contextVars,
        });
        console.log(
          `[LLMOps] Synchronized core agent framework from registry template: "${promptName}"`,
        );
      }
    } catch (error) {
      // Fail-Soft safety guardrail: Outage or timeout will NOT crash your pods
      console.warn(
        `[LLMOps] Cache miss/network timeout for "${promptName}". Reverting to container disk asset.`,
      );
    }
  }

  // 3. Append the formatted skills XML mapping block to the base guidelines string
  const formattedSkills = formatSkillsForSystemPrompt(availableSkills);

  return formattedSkills ? `${agentsMarkdownBase}\n\n${formattedSkills}` : agentsMarkdownBase;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
