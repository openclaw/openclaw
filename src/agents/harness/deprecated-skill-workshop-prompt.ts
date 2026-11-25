// Frozen copy of the Skill Workshop prompt section for the deprecated Plugin SDK exports in
// `agent-harness-runtime`. The skill-workshop plugin owns the live section (its tool's prompt
// guidance); harnesses get it through listToolPromptGuidance.
export const DEPRECATED_SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

/** @deprecated Use listToolPromptGuidance with the run's callable tool names. */
export function buildDeprecatedSkillWorkshopPromptSection(): string[] {
  return [
    "## Skill Workshop",
    "`skill_workshop` edits your learned skills: procedures for tasks this user repeats, so you do not work them out from scratch again. When a learned skill you used was wrong or incomplete, view it and patch the misleading step. After hard multi-step work the user will repeat, save the working procedure: patch the skill that covers it or create one. Knowledge about one codebase belongs in that repository's docs or AGENTS.md, not a learned skill. Every change keeps the previous version. When the user says undo right after a 💾 Learned notice, they mean that skill change: restore the named skill, or archive it if the notice says it was created.",
    "Skills the user owns (repository or workspace `skills/`, `.agents/skills/`, configured skill dirs) are ordinary files: edit them directly when asked, never through skill_workshop.",
    "",
  ];
}
