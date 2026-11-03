/** Host-side Workshop access requires an unsandboxed run. */
export function resolveSkillWorkshopToolConstructionBlock(context: {
  sandboxed?: boolean;
}): { detail: string; fix: string } | undefined {
  if (context.sandboxed) {
    return {
      detail:
        '"skill_workshop" is unavailable in a sandboxed run without library-authoring authority.',
      fix: "Use a non-sandboxed session for this agent, or a human turn with host-granted library-authoring authority. The openclaw skills workshop CLI is also available.",
    };
  }
  return undefined;
}
