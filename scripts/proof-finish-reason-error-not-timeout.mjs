import {
  classifyFailoverReason,
  formatAssistantErrorText,
} from "../src/agents/embedded-agent-helpers/errors.ts";
/**
 * Runtime proof for #109218 — exercises production classifier modules.
 * Run: pnpm exec tsx scripts/proof-finish-reason-error-not-timeout.mjs
 *
 * Bare finish_reason/stop-reason `error` must classify as server_error (failover
 * eligible) without user-facing "LLM request timed out." copy. Abort/network
 * finish reasons stay in the timeout lane.
 */
import {
  isProviderCompletedErrorFinishReasonMessage,
  isTimeoutErrorMessage,
} from "../src/agents/embedded-agent-helpers/failover-matches.ts";

const providerErrorSamples = [
  "Provider finish_reason: error",
  "finish_reason: error",
  "stop reason: error",
  "Unhandled stop reason: error",
];
const timeoutSamples = [
  "Provider finish_reason: network_error",
  "Provider finish_reason: abort",
  "Provider finish_reason: malformed_response",
];

console.log("BEFORE contract (expected failure modes without the fix):");
console.log(
  "  finish_reason:error matched ERROR_PATTERNS.timeout → reason=timeout, copy=LLM request timed out.",
);
console.log("");
console.log("AFTER (production modules on this branch):");

let ok = true;
for (const sample of providerErrorSamples) {
  const reason = classifyFailoverReason(sample);
  const isTimeout = isTimeoutErrorMessage(sample);
  const isProvider = isProviderCompletedErrorFinishReasonMessage(sample);
  const line = { sample, reason, isTimeout, isProvider };
  console.log(`  ${JSON.stringify(line)}`);
  if (reason !== "server_error" || isTimeout || !isProvider) {
    ok = false;
  }
}
for (const sample of timeoutSamples) {
  const reason = classifyFailoverReason(sample);
  const isTimeout = isTimeoutErrorMessage(sample);
  const isProvider = isProviderCompletedErrorFinishReasonMessage(sample);
  console.log(`  ${JSON.stringify({ sample, reason, isTimeout, isProvider })}`);
  if (reason !== "timeout" || !isTimeout || isProvider) {
    ok = false;
  }
}

const msg = {
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: "Provider finish_reason: error",
  api: "openai-completions",
  provider: "openrouter",
  model: "google/gemini-2.5-flash-lite",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  timestamp: Date.now(),
};
const text = formatAssistantErrorText(msg, {
  provider: "openrouter",
  model: "google/gemini-2.5-flash-lite",
});
console.log(`  userFacing=${JSON.stringify(text)}`);
if (text === "LLM request timed out." || !/finish_reason/i.test(text)) {
  ok = false;
}

console.log(
  `\nRESULT: ${ok ? "PASS — bare finish_reason:error is server_error, not timeout" : "FAIL"}`,
);
if (!ok) {
  process.exit(1);
}
