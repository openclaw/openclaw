import { TerminalStates } from "../types.js";
const ConversationStates = /* @__PURE__ */ new Set(["speaking", "listening"]);
const StateOrder = [
  "initiated",
  "ringing",
  "answered",
  "active",
  "speaking",
  "listening"
];
function transitionState(call, newState) {
  if (call.state === newState || TerminalStates.has(call.state)) {
    return;
  }
  if (TerminalStates.has(newState)) {
    call.state = newState;
    return;
  }
  if (ConversationStates.has(call.state) && ConversationStates.has(newState)) {
    call.state = newState;
    return;
  }
  const currentIndex = StateOrder.indexOf(call.state);
  const newIndex = StateOrder.indexOf(newState);
  if (newIndex > currentIndex) {
    call.state = newState;
  }
}
function addTranscriptEntry(call, speaker, text) {
  const entry = {
    timestamp: Date.now(),
    speaker,
    text,
    isFinal: true
  };
  call.transcript.push(entry);
}
export {
  addTranscriptEntry,
  transitionState
};
