const SKILLS_SECTION_HEADING = "## Skills";
const NEXT_SECTION_RE = /\n##\s+/g;

export function stripOpenClawSkillsPromptSection(systemPrompt: string): string {
  const start = systemPrompt.indexOf(SKILLS_SECTION_HEADING);
  if (start < 0) {
    return systemPrompt;
  }

  NEXT_SECTION_RE.lastIndex = start + SKILLS_SECTION_HEADING.length;
  const nextSection = NEXT_SECTION_RE.exec(systemPrompt);
  const end = nextSection?.index ?? systemPrompt.length;
  const before = systemPrompt.slice(0, start).replace(/\n+$/u, "");
  const after = systemPrompt.slice(end).replace(/^\n+/u, "");

  if (!before) {
    return after;
  }
  if (!after) {
    return before;
  }
  return `${before}\n\n${after}`;
}
