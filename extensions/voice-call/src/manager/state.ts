import { TerminalStates, type CallRecord, type CallState } from "../types.js";

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
