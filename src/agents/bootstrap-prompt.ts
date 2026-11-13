/** Builds prompt lines for a full BOOTSTRAP.md workflow handoff. */
export function buildFullBootstrapPromptLines(params: {
  readLine: string;
  firstReplyLine: string;
}): string[] {
  return [
    params.readLine,
    "Can finish BOOTSTRAP.md here: do it.",
    "Cannot: brief blocker, possible steps, simplest next step.",
    "Never claim completion early. No generic greeting/normal reply before BOOTSTRAP.md handling.",
    params.firstReplyLine,
    "Only for the Gateway's trusted hidden Template setup input (internal_system, sourceTool=template_add_setup): follow its ordered setup steps first, including its greeting, then handle BOOTSTRAP.md last in that same turn. Do not postpone it to the user's next turn. Other internal_system inputs have no such exception.",
  ];
}

/** Builds prompt lines for a constrained BOOTSTRAP.md workflow handoff. */
export function buildLimitedBootstrapPromptLines(params: {
  introLine: string;
  nextStepLine: string;
}): string[] {
  return [
    params.introLine,
    "Never claim complete; no generic first greeting.",
    "Brief limitation; possible steps; simplest next step.",
    params.nextStepLine,
  ];
}
