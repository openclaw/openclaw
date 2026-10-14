export type SkillInstructionResult = {
  name: string;
  location: string;
  locationNote?: string;
  content: string;
};

/** Keep model-facing context separate from the complete, unmodified instruction body. */
export function formatSkillInstructions(result: SkillInstructionResult): string {
  const context = [
    `Skill location: ${result.location}`,
    "Resolve relative resource paths from the directory containing this SKILL.md.",
  ];
  if (result.locationNote) {
    context.push(result.locationNote);
  }
  return `${context.join("\n")}\n\n${result.content}`;
}
