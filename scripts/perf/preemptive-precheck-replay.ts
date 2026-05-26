/**
 * Embedded-runner pre-prompt precheck replay harness.
 *
 * Mirrors the call shape used in `src/agents/embedded-agent-runner/run/attempt.ts`
 * at the precheck site: precompute the boundary estimate with the internal
 * append-only cached estimator, then pass it to `shouldPreemptivelyCompactBeforePrompt`
 * via `llmBoundaryTokenPressure`. The public helper itself stays fresh; the
 * WeakMap-backed cache is confined to the embedded-runner's append-only path.
 *
 * Use this to reproduce the cached-vs-fresh wall time locally without a
 * provider call or a captured session log. Produces stdout suitable for
 * inclusion in a PR body Evidence section.
 *
 * Run:
 *   pnpm exec tsx scripts/perf/preemptive-precheck-replay.ts
 */

import { performance } from "node:perf_hooks";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import {
  estimateAppendOnlyLlmBoundaryTokenPressure,
  estimateLlmBoundaryTokenPressure,
  shouldPreemptivelyCompactBeforePrompt,
} from "../../src/agents/embedded-agent-runner/run/preemptive-compaction.js";

const CONTEXT_TOKEN_BUDGET = 200_000;
const RESERVE_TOKENS = 16_000;
const SYSTEM_PROMPT = "You are a helpful assistant. ".repeat(60);
const PROMPT = "ping";

let timestamp = 1;

function makeUserMessage(words: number): AgentMessage {
  return {
    role: "user",
    content: "lorem ipsum dolor sit amet ".repeat(words),
    timestamp: timestamp++,
  } as unknown as AgentMessage;
}

function makeAssistantText(words: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "alpha beta gamma delta ".repeat(words) }],
    timestamp: timestamp++,
  } as unknown as AgentMessage;
}

function makeAssistantToolCall(argChars: number): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `call_${timestamp}`,
        name: "Read",
        arguments: {
          file_path: "/tmp/example/file.ts",
          payload: "x".repeat(Math.max(1, argChars - 60)),
        },
      },
    ],
    timestamp: timestamp++,
  } as unknown as AgentMessage;
}

function makeToolResult(textChars: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${timestamp}`,
    toolName: "Read",
    content: [
      {
        type: "text",
        text: "fake line of output\n".repeat(Math.max(1, Math.ceil(textChars / 20))),
      },
    ],
    isError: false,
    timestamp: timestamp++,
  } as unknown as AgentMessage;
}

function buildToolHeavyTranscript(turns: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(makeUserMessage(8));
    out.push(makeAssistantToolCall(2_500));
    out.push(makeToolResult(8_000));
    out.push(makeAssistantText(40));
  }
  return out;
}

function cachedPrecheck(messages: AgentMessage[]) {
  // Mirrors the embedded-runner attempt.ts precheck site: feed the
  // append-only cached estimator into shouldPreemptivelyCompactBeforePrompt.
  const estimatedPromptTokens = estimateAppendOnlyLlmBoundaryTokenPressure({
    messages,
    systemPrompt: SYSTEM_PROMPT,
    prompt: PROMPT,
  });
  return shouldPreemptivelyCompactBeforePrompt({
    messages,
    systemPrompt: SYSTEM_PROMPT,
    prompt: PROMPT,
    contextTokenBudget: CONTEXT_TOKEN_BUDGET,
    reserveTokens: RESERVE_TOKENS,
    llmBoundaryTokenPressure: {
      estimatedPromptTokens,
      source: "transcript_estimate",
    },
  });
}

function freshPrecheck(messages: AgentMessage[]) {
  // Baseline: same caller shape, but using the public fresh estimator.
  // This is the path SDK consumers exercise when they do not opt into the
  // internal append-only cache.
  const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
    messages,
    systemPrompt: SYSTEM_PROMPT,
    prompt: PROMPT,
  });
  return shouldPreemptivelyCompactBeforePrompt({
    messages,
    systemPrompt: SYSTEM_PROMPT,
    prompt: PROMPT,
    contextTokenBudget: CONTEXT_TOKEN_BUDGET,
    reserveTokens: RESERVE_TOKENS,
    llmBoundaryTokenPressure: {
      estimatedPromptTokens,
      source: "transcript_estimate",
    },
  });
}

function timed<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function main(): void {
  const baseTurns = 250;
  const messages = buildToolHeavyTranscript(baseTurns);

  // Cold + warm runs against the cached embedded-runner-equivalent path.
  const cold = timed(() => cachedPrecheck(messages));

  const warmRuns: number[] = [];
  for (let i = 0; i < 20; i++) {
    warmRuns.push(timed(() => cachedPrecheck(messages)).ms);
  }
  const warmMean = warmRuns.reduce((s, x) => s + x, 0) / warmRuns.length;

  // Fresh (uncached) baseline: same caller shape but using the public helper.
  // Builds a parallel transcript so the cached WeakMap from the warm runs
  // does not bleed into the fresh measurement.
  const freshMessages = buildToolHeavyTranscript(baseTurns);
  // Warm up so JIT/inline caches stabilize before the measurement.
  freshPrecheck(freshMessages);
  const freshRuns: number[] = [];
  for (let i = 0; i < 20; i++) {
    freshRuns.push(timed(() => freshPrecheck(freshMessages)).ms);
  }
  const freshMean = freshRuns.reduce((s, x) => s + x, 0) / freshRuns.length;

  const appendMs: number[] = [];
  const appendRoutes: string[] = [];
  const appendEstimates: number[] = [];
  for (let turn = 0; turn < 10; turn++) {
    messages.push(makeUserMessage(8));
    const r = timed(() => cachedPrecheck(messages));
    appendMs.push(r.ms);
    appendRoutes.push(r.value.route);
    appendEstimates.push(r.value.estimatedPromptTokens);
  }
  const appendMean = appendMs.reduce((s, x) => s + x, 0) / appendMs.length;

  const finalDecision = cachedPrecheck(messages);

  // Sanity: the cached and fresh estimators must return the same number
  // when called on identical inputs without intervening mutation.
  const parityMessages = buildToolHeavyTranscript(32);
  const cachedEstimate = estimateAppendOnlyLlmBoundaryTokenPressure({
    messages: parityMessages,
    systemPrompt: SYSTEM_PROMPT,
    prompt: PROMPT,
  });
  const freshEstimate = estimateLlmBoundaryTokenPressure({
    messages: parityMessages,
    systemPrompt: SYSTEM_PROMPT,
    prompt: PROMPT,
  });

  console.log("openclaw preemptive-precheck-replay (embedded-runner path)");
  console.log(`commit                      ${process.env.PROBE_HEAD ?? "(set $PROBE_HEAD)"}`);
  console.log(`messages_in                 ${messages.length}`);
  console.log(`budget_tokens               ${CONTEXT_TOKEN_BUDGET}`);
  console.log(`reserve                     ${RESERVE_TOKENS}`);
  console.log("");
  console.log(`cold_precheck_ms            ${cold.ms.toFixed(3)} (append-only cached path)`);
  console.log(
    `warm_precheck_ms_mean       ${warmMean.toFixed(3)} (20 repeats, append-only cached path)`,
  );
  console.log(
    `fresh_precheck_ms_mean      ${freshMean.toFixed(3)} (20 repeats, public fresh helper, parallel transcript)`,
  );
  console.log(
    `append_step_ms_mean         ${appendMean.toFixed(3)} (10 turns, one new user msg each, cached path)`,
  );
  console.log("");
  console.log(`estimator_parity_cached     ${cachedEstimate}`);
  console.log(`estimator_parity_fresh      ${freshEstimate}`);
  console.log(`estimator_parity_match      ${cachedEstimate === freshEstimate}`);
  console.log("");
  console.log("per-append measurements (cached path):");
  for (let i = 0; i < appendMs.length; i++) {
    const turn = pad(String(i + 1).padStart(2), 2);
    const ms = appendMs[i].toFixed(3).padStart(8);
    const route = pad(appendRoutes[i], 22);
    const tokens = appendEstimates[i];
    console.log(`  turn ${turn} ms=${ms} route=${route} estimatedPromptTokens=${tokens}`);
  }
  console.log("");
  console.log(`final_route                 ${finalDecision.route}`);
  console.log(`final_estimatedPromptTokens ${finalDecision.estimatedPromptTokens}`);
  console.log(`final_overflowTokens        ${finalDecision.overflowTokens}`);
  console.log(`final_promptBudgetBefRes    ${finalDecision.promptBudgetBeforeReserve}`);
}

main();
