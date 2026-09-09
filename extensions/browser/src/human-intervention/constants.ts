const HUMAN_INTERVENTION_HANDOFF_OWNER = "browser_human_intervention";

export function humanInterventionHandoffOwner(toolCallId: string): string {
  return `${HUMAN_INTERVENTION_HANDOFF_OWNER}:${toolCallId}`;
}
