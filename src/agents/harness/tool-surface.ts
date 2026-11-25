/** Whether a plugin harness constructs OpenClaw tools inside its runtime. */
export function agentHarnessBuildsOpenClawTools(harnessId: string): boolean {
  return harnessId === "codex" || harnessId === "copilot";
}

export function agentHarnessExposesOpenClawTools(harnessId: string): boolean {
  return harnessId === "openclaw" || agentHarnessBuildsOpenClawTools(harnessId);
}
