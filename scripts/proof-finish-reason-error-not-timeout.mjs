/**
 * Runtime proof for #109218 — controlled OpenAI-compatible provider stream
 * through production stop-reason mapping, failover boundary, and user copy.
 *
 * Run: pnpm exec tsx scripts/proof-finish-reason-error-not-timeout.mjs
 *
 * Bare finish_reason/stop-reason `error` must classify as server_error (status
 * 500, model-fallback eligible) without user-facing "LLM request timed out."
 * Abort/network/malformed finish reasons stay in the timeout lane (status 408).
 */
import { mapOpenAIStopReason } from "../packages/ai/src/providers/openai-stop-reason.ts";
import {
  classifyFailoverReason,
  formatAssistantErrorText,
} from "../src/agents/embedded-agent-helpers/errors.ts";
import {
  isProviderCompletedErrorFinishReasonMessage,
  isTimeoutErrorMessage,
} from "../src/agents/embedded-agent-helpers/failover-matches.ts";
import {
  coerceToFailoverError,
  describeFailoverError,
  resolveFailoverStatus,
  resolveModelFallbackError,
} from "../src/agents/failover-error.ts";

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

console.log("=== Controlled provider stream (OpenAI-compatible finish_reason) ===");
const streamBareError = mapOpenAIStopReason("error");
const streamNetwork = mapOpenAIStopReason("network_error");
console.log(`  stream finish_reason=error → ${JSON.stringify(streamBareError)}`);
console.log(`  stream finish_reason=network_error → ${JSON.stringify(streamNetwork)}`);
console.log("");

console.log("=== Gateway failover boundary (production coerce/resolve) ===");
const bareErr = new Error(streamBareError.errorMessage);
const networkErr = new Error(streamNetwork.errorMessage);
const bareFailover = coerceToFailoverError(bareErr, {
  provider: "openrouter",
  model: "google/gemini-2.5-flash-lite",
});
const networkFailover = coerceToFailoverError(networkErr, {
  provider: "openrouter",
  model: "google/gemini-2.5-flash-lite",
});
const bareFallback = resolveModelFallbackError(bareErr, {
  provider: "openrouter",
  model: "google/gemini-2.5-flash-lite",
});
const networkFallback = resolveModelFallbackError(networkErr, {
  provider: "openrouter",
  model: "google/gemini-2.5-flash-lite",
});

function summarize(label, fo, resolution) {
  const described = fo ? describeFailoverError(fo) : null;
  console.log(
    `  ${label}: ${JSON.stringify({
      reason: described?.reason,
      status:
        described?.status ??
        (described?.reason ? resolveFailoverStatus(described.reason) : undefined),
      message: described?.message,
      modelFallbackKind: resolution.kind,
      advancesModelFallback: resolution.kind === "failover",
    })}`,
  );
  return described;
}

const bareDescribed = summarize("bare finish_reason:error", bareFailover, bareFallback);
const networkDescribed = summarize("finish_reason:network_error", networkFailover, networkFallback);
console.log("");

console.log("=== Classifier matrix (production modules) ===");
let ok = true;
for (const sample of providerErrorSamples) {
  const reason = classifyFailoverReason(sample);
  const isTimeout = isTimeoutErrorMessage(sample);
  const isProvider = isProviderCompletedErrorFinishReasonMessage(sample);
  console.log(`  ${JSON.stringify({ sample, reason, isTimeout, isProvider })}`);
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
  errorMessage: streamBareError.errorMessage,
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
console.log("");
console.log("=== User-facing copy (not timeout rewrite) ===");
console.log(`  userFacing=${JSON.stringify(text)}`);
if (text === "LLM request timed out." || !/finish_reason/i.test(String(text))) {
  ok = false;
}

if (
  !bareDescribed ||
  bareDescribed.reason !== "server_error" ||
  bareDescribed.status !== 500 ||
  bareFallback.kind !== "failover" ||
  !networkDescribed ||
  networkDescribed.reason !== "timeout" ||
  networkDescribed.status !== 408 ||
  networkFallback.kind !== "failover"
) {
  ok = false;
  console.log("  boundary check FAILED", {
    bare: bareDescribed,
    bareFallbackKind: bareFallback.kind,
    network: networkDescribed,
    networkFallbackKind: networkFallback.kind,
  });
}

console.log(
  `\nRESULT: ${
    ok
      ? "PASS — controlled stream: bare error → server_error/500/fallback; network_error → timeout/408/fallback; copy keeps provider signal"
      : "FAIL"
  }`,
);
if (!ok) {
  process.exit(1);
}
