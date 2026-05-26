/**
 * Embedded-runner pre-prompt precheck replay harness.
 *
 * Exercises `shouldPreemptivelyCompactBeforePrompt` — the same exported helper
 * invoked from `src/agents/pi-embedded-runner/run/attempt.ts` on every prompt
 * submission — on a synthetic activeSession.messages-shaped transcript.
 *
 * Use this to reproduce the per-message identity cache behavior locally
 * without a provider call or a captured session log. Produces stdout suitable
 * for inclusion in a PR body Evidence section.
 *
 * Run:
 *   pnpm exec tsx scripts/perf/preemptive-precheck-replay.ts
 */

import { performance } from "node:perf_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { shouldPreemptivelyCompactBeforePrompt } from "../../src/agents/pi-embedded-runner/run/preemptive-compaction.js";

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

function precheck(messages: AgentMessage[]) {
  return shouldPreemptivelyCompactBeforePrompt({
    messages,
    systemPrompt: SYSTEM_PROMPT,
    prompt: PROMPT,
    contextTokenBudget: CONTEXT_TOKEN_BUDGET,
    reserveTokens: RESERVE_TOKENS,
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

  const cold = timed(() => precheck(messages));

  const warmRuns: number[] = [];
  for (let i = 0; i < 20; i++) {
    warmRuns.push(timed(() => precheck(messages)).ms);
  }
  const warmMean = warmRuns.reduce((s, x) => s + x, 0) / warmRuns.length;

  const appendMs: number[] = [];
  const appendRoutes: string[] = [];
  const appendEstimates: number[] = [];
  for (let turn = 0; turn < 10; turn++) {
    messages.push(makeUserMessage(8));
    const r = timed(() => precheck(messages));
    appendMs.push(r.ms);
    appendRoutes.push(r.value.route);
    appendEstimates.push(r.value.estimatedPromptTokens);
  }
  const appendMean = appendMs.reduce((s, x) => s + x, 0) / appendMs.length;

  const finalDecision = precheck(messages);

  console.log("openclaw preemptive-precheck-replay (embedded-runner path)");
  console.log(`commit                      ${process.env.PROBE_HEAD ?? "(set $PROBE_HEAD)"}`);
  console.log(`messages_in                 ${messages.length}`);
  console.log(`budget_tokens               ${CONTEXT_TOKEN_BUDGET}`);
  console.log(`reserve                     ${RESERVE_TOKENS}`);
  console.log("");
  console.log(`cold_precheck_ms            ${cold.ms.toFixed(3)}`);
  console.log(
    `warm_precheck_ms_mean       ${warmMean.toFixed(3)} (20 repeats over the same transcript)`,
  );
  console.log(
    `append_step_ms_mean         ${appendMean.toFixed(3)} (10 turns, one new user msg each)`,
  );
  console.log("");
  console.log("per-append measurements:");
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
