export function buildSessionsYieldContextMessage(
  message: string,
  options?: { nativeInterruptMarker?: boolean },
) {
  // Native harnesses end the turn with an interrupt, which Codex records as a user interruption.
  const nativeInterruptNote = options?.nativeInterruptMarker
    ? " This was an agent-requested pause, not a user interruption. If Codex recorded a <turn_aborted> marker for this yield, its user-interruption wording describes OpenClaw's turn/interrupt mechanism, not a user request to stop or cancel the task. Continue the pending task when the expected follow-up arrives."
    : "";
  return {
    customType: "openclaw.sessions_yield",
    content: `${message}\n\n[Context: The previous turn ended intentionally via sessions_yield while waiting for a follow-up event.${nativeInterruptNote}]`,
    display: false,
    details: { source: "sessions_yield", message },
  };
}
