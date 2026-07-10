/**
 * System-prompt contribution for routing durable skill edits through the
 * Skill Workshop tool instead of direct filesystem writes.
 */
export const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

/** Build the system-prompt section for Skill Workshop routing rules. */
export function buildSkillWorkshopPromptSection(): string[] {
  return [
    "## Skill Workshop",
    "Route durable skill work — creating, updating, or managing reusable skills, playbooks, or standing workflows — through the `skill_workshop` tool; never write proposal or skill files directly.",
    "Generated skills are pending proposals. Apply, reject, or quarantine only when the user explicitly asks.",
    "",
  ];
}
