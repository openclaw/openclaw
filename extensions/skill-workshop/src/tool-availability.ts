/** Host-side Workshop access requires an unsandboxed run. */
export function resolveSkillWorkshopToolConstructionBlock(context: {
  sandboxed?: boolean;
}): { detail: string; fix: string } | undefined {
  if (context.sandboxed) {
    return {
      detail: '"skill_workshop" is unavailable in sandboxed runs.',
      fix: "Use a non-sandboxed session for this agent, or manage its learned skills with the openclaw skills workshop CLI.",
    };
  }
  return undefined;
}
