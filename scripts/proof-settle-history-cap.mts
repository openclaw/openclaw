#!/usr/bin/env node
// Local proof: cap requester-settle history without losing the original request.
//
// This script exercises the actual production history-limit helpers on a
// synthetic but realistic long DM transcript, then reports before/after message
// and token counts. It does not touch a live OpenClaw service, gateway, or
// provider; it uses only the in-process resolver and trimmer that the embedded
// runner calls during settle preparation.

import {
  limitHistoryTurns,
  resolveHistoryLimitForAttempt,
} from "../src/agents/embedded-agent-runner/history.js";
import { estimateTokens, type AgentMessage } from "../src/agents/runtime/index.js";

const TURN_COUNT = 80;
const TURN_TEXT_WORDS = 250;
const TOOL_RESULT_WORDS = 400;

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i % 1000}_${Math.floor(i / 1000)}`).join(" ");
}

function userMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as AgentMessage;
}

function assistantToolCall(name: string, args: unknown): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `I'll run ${name}.` },
      { type: "toolCall", id: `call-${name}`, name, arguments: args },
    ],
  } as AgentMessage;
}

function toolResult(name: string, output: string): AgentMessage {
  return {
    role: "toolResult",
    content: [{ type: "text", text: `[${name}] ${output}` }],
  } as AgentMessage;
}

function buildLongSessionTranscript(): AgentMessage[] {
  const messages: AgentMessage[] = [];
  // The original user request: contains constraints that must survive settle.
  messages.push(
    userMessage(
      [
        "Review and refactor the statement-pipeline cdk stack.",
        "Keep all existing behavior, do not delete any S3 buckets or Lambdas,",
        "preserve the Langfuse exporter, and reply only when the refactor is fully tested.",
        "Use TypeScript, keep changes under 500 lines, and do not start new migrations.",
      ].join(" "),
    ),
  );

  for (let i = 0; i < TURN_COUNT; i++) {
    messages.push(assistantMessage(`Assistant response turn ${i}: ${words(TURN_TEXT_WORDS)}`));
    messages.push(userMessage(`User follow-up turn ${i}: ${words(TURN_TEXT_WORDS)}`));
    if (i % 3 === 0) {
      const toolName = `tool-${i}`;
      messages.push(assistantToolCall(toolName, { query: words(20) }));
      messages.push(toolResult(toolName, `Tool output turn ${i}: ${words(TOOL_RESULT_WORDS)}`));
    }
  }

  // The settle wake is injected as a final synthetic user message with subagent_settle provenance.
  messages.push(
    userMessage(
      "[Subagent Context] Every subagent spawned from this session has now settled — none are still running.",
    ),
  );
  return messages;
}

function estimateTranscriptTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function scenario(name: string, limit: ReturnType<typeof resolveHistoryLimitForAttempt>) {
  const messages = buildLongSessionTranscript();
  const trimmed = limitHistoryTurns(messages, limit);
  return {
    name,
    limit:
      typeof limit === "object"
        ? `settle cap ${limit.limit} keepFirstUser`
        : limit === undefined
          ? "unlimited"
          : `limit ${limit}`,
    totalMessages: messages.length,
    keptMessages: trimmed.length,
    userTurnsKept: trimmed.filter((m) => m.role === "user").length,
    estimatedInputTokens: estimateTranscriptTokens(trimmed),
    firstUserText: trimmed.find((m) => m.role === "user")?.content?.[0]?.text.slice(0, 80),
  };
}

const baseline = scenario(
  "Baseline (current main, no settle cap)",
  resolveHistoryLimitForAttempt({
    sessionKey: "agent:main:telegram:dm:123",
    config: {},
    inputProvenance: { sourceTool: "subagent_announce" },
  }),
);

const candidate = scenario(
  "Candidate (settle cap, keep first user turn)",
  resolveHistoryLimitForAttempt({
    sessionKey: "agent:main:telegram:dm:123",
    config: {},
    inputProvenance: { sourceTool: "subagent_settle" },
  }),
);

console.log("# Proof: settle history cap reduces input without dropping the original request\n");
console.log(
  "Synthetic long DM session:",
  TURN_COUNT,
  "turns + tool results + original request + settle wake.\n",
);

console.log(
  "| Scenario | Kept messages | Kept user turns | Est. input tokens | First user text preserved |",
);
console.log("|---|---:|---:|---:|:---|");
for (const result of [baseline, candidate]) {
  const preserved = result.firstUserText?.startsWith("Review and refactor") ? "yes" : "NO";
  console.log(
    `| ${result.name} | ${result.keptMessages} | ${result.userTurnsKept} | ${result.estimatedInputTokens.toLocaleString()} | ${preserved} |`,
  );
}

const reduction =
  baseline.estimatedInputTokens > 0
    ? 1 - candidate.estimatedInputTokens / baseline.estimatedInputTokens
    : 0;

console.log("\n## Inspectable output\n");
console.log(
  JSON.stringify(
    {
      node: process.version,
      syntheticTurns: TURN_COUNT,
      baseline,
      candidate,
      reductionPercent: Number((reduction * 100).toFixed(2)),
      originalRequestPreserved: candidate.firstUserText?.startsWith("Review and refactor") ?? false,
    },
    null,
    2,
  ),
);

console.log("\n## Limits");
console.log(
  "Controlled local execution of production history-limit helpers only; no live gateway, provider,",
);
console.log(
  "or remote session store. Token estimates use the production estimateTokens heuristic, not a",
);
console.log(
  "provider tokenizer. Timings are not measured because this is a pure context-size proof.",
);
