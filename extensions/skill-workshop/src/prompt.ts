/** System-prompt contribution that keeps the agent's learned (Workshop) skills current. */
export const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

/** Build the system-prompt section for Skill Workshop. */
export function buildSkillWorkshopPromptSection(): string[] {
  return [
    "## Skill Workshop",
    "`skill_workshop` edits your learned skills: procedures for tasks this user repeats. Patch a learned skill you used that was wrong or incomplete; after hard multi-step work the user will repeat, patch or create the skill that covers it. Codebase knowledge belongs in that repository's docs or AGENTS.md. Changes are versioned; undo right after a 💾 Learned notice means restore that skill (archive it if the notice says it was created).",
    "User-owned skills (repository or workspace `skills/`, `.agents/skills/`, configured skill dirs) are ordinary files: edit them directly when asked, never through skill_workshop.",
    "",
  ];
}
