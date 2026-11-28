/** System-prompt contribution that keeps the agent's learned (Workshop) skills current. */
export const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

/** Build the system-prompt section for Skill Workshop. */
export function buildSkillWorkshopPromptSection(): string[] {
  return [
    "## Skill Workshop",
    "Used a wrong/incomplete learned skill, or finished hard multi-step work this user will repeat? Patch/create with `skill_workshop`. Codebase knowledge: repository docs/AGENTS.md.",
    "",
  ];
}
