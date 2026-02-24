const GEC_LEGAL_END_STATES = ["CLOSURE PACKET", "BLOCKED PACKET", "CHECKPOINT PLAN"];
const GEC_HEDGING_RE = /\b(if you want|would you like me to|i can|let me know if)\b/i;
const GEC_PROMISE_RE = /\b(i['’]ll\s+do|i\s+will\s+do|i['’]m\s+executing\s+now|i\s+am\s+executing\s+now|running\s+end-to-end)\b/i;
const GEC_DECISION_RE = /\b(should i|do you want|would you like|which option|choose one|pick one|confirm)\b|\?/i;

const hasGecLegalEndState = (text) => {
  const upper = text.toUpperCase();
  return GEC_LEGAL_END_STATES.some((token) => upper.includes(token));
};
const isDecisionRequestText = (text) => GEC_DECISION_RE.test(text);
const buildGecCheckpointPlan = (originalText) => {
  const objective = (originalText || "Execution update").replace(/\s+/g, " ").trim().slice(0, 220);
  return `CHECKPOINT PLAN\n1) Capture objective + scope from request. Proof: objective statement logged.\n2) Execute exactly one bounded step toward objective. Proof: artifact path/command output.\n3) Return with one legal end state (Closure Packet / Blocked Packet / Checkpoint Plan) and evidence. Proof: end-state packet posted.\n\nObjective: ${objective}`;
};
const enforceGlobalExecutionConstitution = (text) => {
  const raw = (text ?? "").trim();
  if (!raw) return { blocked: false, rewrittenText: raw, reason: null };
  const hasLegalState = hasGecLegalEndState(raw);
  const promiseViolation = GEC_PROMISE_RE.test(raw);
  const hedgingViolation = GEC_HEDGING_RE.test(raw) && !isDecisionRequestText(raw);
  if (!hasLegalState && (promiseViolation || hedgingViolation)) {
    return {
      blocked: true,
      rewrittenText: buildGecCheckpointPlan(raw),
      reason: promiseViolation ? "forbidden_future_tense_execution_promise" : "forbidden_hedging_without_decision",
    };
  }
  return { blocked: false, rewrittenText: raw, reason: null };
};

const cases = [
  ["forbidden_promise", "I'll do it now and post status once done."],
  ["hedging_without_decision", "If you want, I can run this now."],
  ["valid_closure_packet", "CLOSURE PACKET\n- Complete\n- Proof: commit abc123"],
  ["decision_request_allowed", "Would you like me to proceed with option A or B?"],
];

for (const [name, input] of cases) {
  console.log(`CASE=${name}`);
  console.log(JSON.stringify(enforceGlobalExecutionConstitution(input), null, 2));
}
