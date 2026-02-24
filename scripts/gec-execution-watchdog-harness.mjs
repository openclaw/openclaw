const GEC_LEGAL_END_STATES = ["CLOSURE PACKET", "BLOCKED PACKET", "CHECKPOINT PLAN"];
const GEC_EXECUTION_INTENT_RE =
  /\b(i['’]m\s+executing|i\s+am\s+executing|running\s+end-to-end|working\s+on\s+it|executing\s+now|starting\s+execution)\b/i;

const hasGecLegalEndState = (text) => {
  const upper = text.toUpperCase();
  return GEC_LEGAL_END_STATES.some((token) => upper.includes(token));
};

const buildGecCheckpointPlan = (originalText) => {
  const objective = (originalText || "Execution update").replace(/\s+/g, " ").trim().slice(0, 220);
  return `CHECKPOINT PLAN\n1) Capture objective + scope from request. Proof: objective statement logged.\n2) Execute exactly one bounded step toward objective. Proof: artifact path/command output.\n3) Return with one legal end state (Closure Packet / Blocked Packet / Checkpoint Plan) and evidence. Proof: end-state packet posted.\n\nObjective: ${objective}`;
};

function evaluateExecutionWatchdog({ text, state, nowMs, windowMs }) {
  const raw = (text ?? "").trim();
  if (!raw) {
    return { state, timedOut: false, rewrittenText: raw, reason: null };
  }

  if (hasGecLegalEndState(raw)) {
    return {
      state: { active: false, startedAtMs: state.startedAtMs, lastProofAtMs: nowMs },
      timedOut: false,
      rewrittenText: raw,
      reason: null,
    };
  }

  if (!state.active && GEC_EXECUTION_INTENT_RE.test(raw)) {
    return {
      state: { active: true, startedAtMs: nowMs, lastProofAtMs: nowMs },
      timedOut: false,
      rewrittenText: raw,
      reason: null,
    };
  }

  if (state.active && nowMs - state.lastProofAtMs > windowMs) {
    return {
      state: { ...state, active: false },
      timedOut: true,
      rewrittenText: buildGecCheckpointPlan(raw),
      reason: "execution_window_exceeded",
    };
  }

  return { state, timedOut: false, rewrittenText: raw, reason: null };
}

let state = { active: false, startedAtMs: 0, lastProofAtMs: 0 };
const windowMs = 1000;
const t0 = 1_000_000;

const start = evaluateExecutionWatchdog({
  text: "I am executing now: processing queue",
  state,
  nowMs: t0,
  windowMs,
});
state = start.state;
console.log("CASE=start_execution_intent");
console.log(JSON.stringify(start, null, 2));

const timeout = evaluateExecutionWatchdog({
  text: "still processing...",
  state,
  nowMs: t0 + 2000,
  windowMs,
});
state = timeout.state;
console.log("CASE=execution_window_exceeded");
console.log(JSON.stringify(timeout, null, 2));

const proof = evaluateExecutionWatchdog({
  text: "CHECKPOINT PLAN\n1) done",
  state,
  nowMs: t0 + 2500,
  windowMs,
});
console.log("CASE=proof_signal_resets_watchdog");
console.log(JSON.stringify(proof, null, 2));
