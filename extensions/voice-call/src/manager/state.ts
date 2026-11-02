import { TerminalStates, type CallRecord, type CallState, type EndReason } from "../types.js";

const ConversationStates = new Set<CallState>(["speaking", "listening"]);

const StateOrder: readonly CallState[] = [
  "initiated",
  "ringing",
  "answered",
  "active",
  "speaking",
  "listening",
];

export function transitionState(call: CallRecord, newState: CallState): void {
  if (call.state === newState || TerminalStates.has(call.state)) {
    return;
  }

  // Calls advance monotonically except for speaking/listening conversation turns.
  if (
    TerminalStates.has(newState) ||
    (ConversationStates.has(call.state) && ConversationStates.has(newState)) ||
    StateOrder.indexOf(newState) > StateOrder.indexOf(call.state)
  ) {
    call.state = newState;
  }
}

export type CallPlaybackOutcome =
  | { kind: "provider"; status: string; error?: string }
  | { kind: "restart" };

/** Terminal snapshots must settle playback before persistence and publication. */
export function markCallEnded(
  call: CallRecord,
  endReason: EndReason,
  options: { endedAt?: number; playbackOutcome?: CallPlaybackOutcome } = {},
): void {
  call.endedAt = options.endedAt ?? Date.now();
  call.endReason = endReason;
  transitionState(call, endReason);
  const outcome = options.playbackOutcome;
  for (const kind of ["notify", "voicemail"] as const) {
    const statusKey = `${kind}Status`;
    if (call.metadata?.[statusKey] !== "playing") {
      continue;
    }
    // A local voicemail end follows completed realtime playback; other local ends do not.
    const completed =
      outcome?.kind === "provider"
        ? outcome.status === "completed"
        : !outcome && kind === "voicemail" && endReason === "voicemail";
    const label = kind === "notify" ? "notification" : "voicemail";
    const error =
      outcome?.kind === "restart"
        ? `${kind === "notify" ? "Notification" : "Voicemail"} outcome could not be confirmed after a restart`
        : outcome?.kind === "provider" && outcome.error !== undefined
          ? outcome.error
          : `Call ended before ${label} completed: ${outcome?.kind === "provider" ? outcome.status : endReason}`;
    call.metadata = {
      ...call.metadata,
      [statusKey]: completed ? "left" : "failed",
      ...(!completed ? { [`${kind}Error`]: error } : {}),
    };
  }
}

export function addTranscriptEntry(call: CallRecord, speaker: "bot" | "user", text: string): void {
  call.transcript.push({
    timestamp: Date.now(),
    speaker,
    text,
    isFinal: true,
  });
}

/** Stage persisted changes without exposing uncommitted state through active-call getters. */
export function copyCallRecord(call: CallRecord): CallRecord {
  return {
    ...call,
    transcript: [...call.transcript],
    processedEventIds: [...call.processedEventIds],
    ...(call.metadata ? { metadata: { ...call.metadata } } : {}),
  };
}
