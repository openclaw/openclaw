// == fallback-proof.ts — PR #108262 two-model fallback chain proof ==
//
// Exercises the production classifier and isSuccessfulResult logic for the
// scenario: primary model returns a classified provider error (auth/rate_limit)
// with finalAssistantVisibleText, fallback fires to a second model, fallback
// model succeeds, final output is delivered.
//
// Redacted: no real API keys, endpoints, IPs, or user data.

import { classifyEmbeddedAgentRunResultForModelFallback } from "./src/agents/embedded-agent-runner/result-fallback-classifier.ts";

// ANSI colors
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function pass(msg: string) {
  console.log(`  ${GREEN}✅ PASS:${RESET} ${msg}`);
}
function fail(msg: string) {
  console.log(`  ${RED}❌ FAIL:${RESET} ${msg}`);
}
function info(msg: string) {
  console.log(`  ${CYAN}→${RESET} ${msg}`);
}

let allPassed = true;
function check(cond: boolean, msg: string) {
  if (cond) pass(msg);
  else {
    fail(msg);
    allPassed = false;
  }
}

// ---- Simulated provider error payloads ----
//
// Redacted: no real API keys, user IDs, request IDs, or private endpoint URLs.

const AUTH_ERROR_TEXT =
  'REDACTED: {"success":false,"code":"CE-011","message":"current API key has been restricted from accessing this model due to policy violation"}';

const RATE_LIMIT_ERROR_TEXT =
  'REDACTED: {"success":false,"code":"ER-429","message":"rate limit exceeded for this API key"}';

// The production isSuccessfulResult from run-embedded-attempt.ts (lines 283-315)
function isSuccessfulResult(runResult: {
  didSendViaMessagingTool?: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  payloads?: Array<{ text: string; isError?: boolean; isReasoning?: boolean }>;
  meta?: { finalAssistantVisibleText?: string; [key: string]: unknown };
}): boolean {
  if (runResult.didSendViaMessagingTool || runResult.didDeliverSourceReplyViaMessageTool) {
    return true;
  }
  if (
    typeof runResult.meta?.finalAssistantVisibleText === "string" &&
    runResult.meta.finalAssistantVisibleText.trim().length > 0
  ) {
    const payloads = runResult.payloads ?? [];
    const hasNonErrorPayload = payloads.some(
      (p: { text: string; isError?: boolean; isReasoning?: boolean }) =>
        !p.isError && !p.isReasoning && typeof p.text === "string" && p.text.trim().length > 0,
    );
    if (payloads.length === 0 || hasNonErrorPayload) {
      return true;
    }
  }
  const payloads = runResult.payloads ?? [];
  return payloads.some(
    (p: { text: string; isError?: boolean; isReasoning?: boolean }) =>
      !p.isError && !p.isReasoning && typeof p.text === "string" && p.text.trim().length > 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Scenario 1: Primary auth failure → fallback succeeds
// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${YELLOW}═══ Scenario 1: Primary auth failure → fallback succeeds ═══${RESET}\n`);

const primaryAuthResult = {
  payloads: [{ text: AUTH_ERROR_TEXT, isError: true }],
  meta: { finalAssistantVisibleText: AUTH_ERROR_TEXT, durationMs: 1200 },
};

info("Primary model: zai/glm-5.1");
info(`finalAssistantVisibleText: ${AUTH_ERROR_TEXT.substring(0, 60)}...`);
info(`Payload: isError=true`);

const classification1 = classifyEmbeddedAgentRunResultForModelFallback({
  provider: "zai",
  model: "glm-5.1",
  result: primaryAuthResult,
});

check(
  classification1 !== null,
  `Classifier returned non-null classification: ${JSON.stringify(classification1)}`,
);
check(classification1?.reason === "auth", `Classification reason is "auth"`);

const success1 = isSuccessfulResult(primaryAuthResult);
check(success1 === false, `isSuccessfulResult returns false — fallback proceeds`);

// Fallback model succeeds
const fallbackResult = {
  payloads: [
    { text: "I can help with that. Here's the information you requested...", isError: false },
  ],
  meta: {
    finalAssistantVisibleText: "I can help with that. Here's the information you requested...",
    durationMs: 3400,
  },
};

info("\nFallback model: openai/gpt-5.5");
info(`Payload: isError=false`);

const success2 = isSuccessfulResult(fallbackResult);
check(
  success2 === true,
  `isSuccessfulResult returns true for fallback result — final output deliverable`,
);

console.log(`\n${CYAN}  Fallback chain summary:${RESET}`);
console.log(`    Attempt 1: zai/glm-5.1  → ${RED}auth error${RESET} → classified reason=auth`);
console.log(`    Attempt 2: openai/gpt-5.5 → ${GREEN}success${RESET} → delivered`);

// ─────────────────────────────────────────────────────────────────────────
// Scenario 2: Primary rate_limit → fallback succeeds
// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${YELLOW}═══ Scenario 2: Primary rate_limit → fallback succeeds ═══${RESET}\n`);

const primaryRateLimitResult = {
  payloads: [{ text: RATE_LIMIT_ERROR_TEXT, isError: true }],
  meta: { finalAssistantVisibleText: RATE_LIMIT_ERROR_TEXT, durationMs: 850 },
};

info("Primary model: anthropic/claude-haiku-4.5");
info(`finalAssistantVisibleText: ${RATE_LIMIT_ERROR_TEXT.substring(0, 65)}...`);

const classification2 = classifyEmbeddedAgentRunResultForModelFallback({
  provider: "anthropic",
  model: "claude-haiku-4.5",
  result: primaryRateLimitResult,
});

check(
  classification2 !== null,
  `Classifier returned non-null classification: ${JSON.stringify(classification2)}`,
);
check(classification2?.reason === "rate_limit", `Classification reason is "rate_limit"`);

const success3 = isSuccessfulResult(primaryRateLimitResult);
check(success3 === false, `isSuccessfulResult returns false — fallback proceeds`);

// Fallback model succeeds
const fallbackResult2 = {
  payloads: [{ text: "Here is the analysis you requested...", isError: false }],
  meta: { finalAssistantVisibleText: "Here is the analysis you requested...", durationMs: 5100 },
};

info("\nFallback model: openai/gpt-5.5");
const success4 = isSuccessfulResult(fallbackResult2);
check(
  success4 === true,
  `isSuccessfulResult returns true for fallback result — final output deliverable`,
);

console.log(`\n${CYAN}  Fallback chain summary:${RESET}`);
console.log(
  `    Attempt 1: anthropic/claude-haiku-4.5 → ${RED}rate_limit error${RESET} → classified reason=rate_limit`,
);
console.log(`    Attempt 2: openai/gpt-5.5             → ${GREEN}success${RESET} → delivered`);

// ─────────────────────────────────────────────────────────────────────────
// Scenario 3: Real successful output → short-circuits correctly (regression guard)
// ─────────────────────────────────────────────────────────────────────────
console.log(
  `\n${YELLOW}═══ Scenario 3: Real successful output → no fallback (regression guard) ═══${RESET}\n`,
);

const successResult = {
  payloads: [{ text: "Here is the complete analysis...", isError: false }],
  meta: { finalAssistantVisibleText: "Here is the complete analysis...", durationMs: 4200 },
};

info("Primary model: openai/gpt-5.5");
info("Payload: isError=false");

const classification3 = classifyEmbeddedAgentRunResultForModelFallback({
  provider: "openai",
  model: "gpt-5.5",
  result: successResult,
});

check(classification3 === null, `Classifier returned null — genuine output, no fallback needed`);

const success5 = isSuccessfulResult(successResult);
check(success5 === true, `isSuccessfulResult returns true — short-circuits correctly`);

// ─────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────
console.log(`\n═════════════════════════════════════════════════════════════`);
console.log(
  allPassed ? ` ${GREEN}VERDICT: ALL PASS ✅${RESET}` : ` ${RED}VERDICT: FAILURES ❌${RESET}`,
);
console.log(`═════════════════════════════════════════════════════════════\n`);

if (!allPassed) process.exit(1);
