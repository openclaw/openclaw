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

export function addTranscriptEntry(
  call: CallRecord,
  speaker: "bot" | "user",
  text: string,
  timestamp = Date.now(),
): void {
  call.transcript.push({
    timestamp,
    speaker,
    text,
    isFinal: true,
  });
  // Caller ASR can finalize after its reply; equal timestamps retain arrival order.
  call.transcript.sort((a, b) => a.timestamp - b.timestamp);
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
