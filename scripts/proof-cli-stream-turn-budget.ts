/**
 * Real-behavior proof for the Claude stream-json cumulative turn budget.
 *
 * Real: `createCliJsonlStreamingParser` from `src/agents/cli-output-stream.ts`,
 * driven exactly as `src/agents/cli-runner/execute-process.ts` drives it — raw
 * stdout chunks through `push()`, then `finish()`, then `getErrorText()` /
 * `getOutput()`. Nothing in the parser, its record decoding, its budget
 * accounting or its output assembly is stubbed or mocked.
 *
 * Stubbed: only the process edge. No `claude` subprocess is spawned; the
 * frames below are the stream-json shapes the CLI emits under
 * `--include-partial-messages --verbose` (partial text deltas plus large
 * tool_result payloads), synthesized in-process.
 *
 * Scenarios:
 *  1. recovered-raw   — >8 MiB of stream-json, then a terminal `result`.
 *                       Pins: no error text (so `execute-process.ts` does not
 *                       raise the `format` FailoverError that failed the run),
 *                       the finished answer survives, truncation is reported.
 *  2. unknowable-raw  — the same overflow with NO terminal result. Pins that
 *                       the guard is NOT removed: the turn still fails.
 *  3. recovered-lines — the same recovery for the 20,000-line budget.
 *  4. retention-flat  — 32 MiB pushed AFTER the budget is spent emits zero new
 *                       assistant text and grows the heap by a tiny fraction of
 *                       the bytes streamed. The post-budget traffic is the shape
 *                       that makes tool tracking grow: a distinct, never-repeated
 *                       tool id per iteration plus one tool block whose
 *                       `content_block_stop` never arrives. Pins that the bound
 *                       holds and that it does not cost the progress signal.
 *  5. subagent-exempt — 3x both budgets streamed as forwarded subagent traffic
 *                       (`parent_tool_use_id` set), which the parent lane
 *                       discards. Pins that no budget is spent and the parent's
 *                       own answer is still assembled normally.
 *  6. progress-past-budget — after the budget IS spent by parent traffic, the
 *                       parser still emits tool start, tool result and
 *                       attributed subagent progress. Pins the liveness facts
 *                       the gateway's stall detector reads once a tool is
 *                       active; without them a healthy run is aborted as stuck.
 *
 * Run: pnpm tsx scripts/proof-cli-stream-turn-budget.ts
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type {
  CliToolResultDelta,
  CliToolUseStartDelta,
} from "../src/agents/cli-output-contracts.js";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../src/agents/cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "../src/agents/cli-output-stream.js";

const SESSION_ID = "proof-budget-session";
const FINAL_ANSWER = "Report written to ~/reports/theseus-research/context-epidemiology.md";

/**
 * Collects garbage without requiring `--expose-gc` on the run command, so the
 * retention assertion below measures RETAINED bytes. Post-budget lines are now
 * decoded to recover progress events, and the transient parse garbage that
 * produces would otherwise read as retention.
 */
function forceGarbageCollection(): void {
  setFlagsFromString("--expose-gc");
  try {
    const gc = runInNewContext("gc") as () => void;
    // Twice: one pass can leave a large transient graph uncollected, which
    // inflates a baseline sample and then hides real retention as a negative
    // delta. A silently non-discriminating retention gate is worse than none.
    gc();
    gc();
  } finally {
    setFlagsFromString("--no-expose-gc");
  }
}

/**
 * Module-level keep-alive. A parser held only in a function local is dead once
 * the loop that feeds it ends, and V8 will collect it — together with the tool
 * tracker whose retention the measurement below is trying to observe. Without
 * this, `retention-flat` reports a flat heap even against a build with no bound
 * at all, which is a green assertion that cannot fail.
 */
const retainedForMeasurement: unknown[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`proof assertion failed: ${message}`);
  }
}

function textDeltaFrame(text: string): string {
  return JSON.stringify({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text },
    },
  });
}

function toolResultFrame(index: number, payloadChars: number): string {
  return JSON.stringify({
    type: "user",
    session_id: SESSION_ID,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: `toolu_proof_${index}`,
          content: [{ type: "text", text: "r".repeat(payloadChars) }],
        },
      ],
    },
  });
}

function terminalResultFrame(): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: SESSION_ID,
    result: FINAL_ANSWER,
  });
}

function createParser(assistantDeltas: string[]) {
  return createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: (delta) => assistantDeltas.push(delta.delta),
  });
}

type Parser = ReturnType<typeof createParser>;

/** Streams realistic frames until the cumulative character budget is spent. */
function overflowRawCharBudget(parser: Parser): number {
  let streamed = 0;
  for (let index = 0; streamed <= CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars; index += 1) {
    const frames = [
      textDeltaFrame(`step ${index} `),
      toolResultFrame(index, 96_000),
      textDeltaFrame(`observed ${index}\n`),
    ];
    const chunk = `${frames.join("\n")}\n`;
    streamed += chunk.length;
    parser.push(chunk);
  }
  return streamed;
}

/** Streams blank frames until the cumulative line budget is spent. */
function overflowLineBudget(parser: Parser): number {
  const lines = CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines + 1;
  parser.push("\n".repeat(lines));
  return lines;
}

function scenarioRecovered(name: string, overflow: (parser: Parser) => number): void {
  const assistantDeltas: string[] = [];
  const parser = createParser(assistantDeltas);
  const streamed = overflow(parser);
  const deltasAtOverflow = assistantDeltas.length;

  parser.push(`${textDeltaFrame("post-budget commentary")}\n`);
  parser.push(`${terminalResultFrame()}\n`);
  parser.finish();

  const output = parser.getOutput();
  assert(
    parser.getErrorText() === null,
    `${name}: parser reported "${parser.getErrorText()}"; execute-process would raise a format FailoverError and fail a finished run`,
  );
  assert(parser.hasTerminalResult(), `${name}: terminal result was not observed`);
  assert(output !== null, `${name}: no output produced`);
  assert(
    output.text === FINAL_ANSWER,
    `${name}: expected the finished answer, got ${JSON.stringify(output.text)}`,
  );
  assert(output.errorText === undefined, `${name}: output carried errorText ${output.errorText}`);
  assert(output.sessionId === SESSION_ID, `${name}: session continuity lost`);
  const truncation = parser.getOutputTruncationText();
  assert(
    truncation?.includes("stopped assembling output"),
    `${name}: truncation was not reported to the operator`,
  );
  assert(
    assistantDeltas.length === deltasAtOverflow,
    `${name}: ${assistantDeltas.length - deltasAtOverflow} assistant delta(s) were assembled after the budget was spent`,
  );
  console.log(
    `[${name}] streamed ${streamed} chars past the budget, recovered "${output.text}"; truncation: ${truncation}`,
  );
}

function scenarioUnknowable(): void {
  const assistantDeltas: string[] = [];
  const parser = createParser(assistantDeltas);
  overflowRawCharBudget(parser);
  parser.push(`${textDeltaFrame("still going")}\n`);
  parser.finish();

  const errorText = parser.getErrorText();
  assert(
    errorText?.includes("refusing to parse output"),
    `unknowable-raw: a turn with no terminal result must still fail, got ${JSON.stringify(errorText)}`,
  );
  assert(!parser.hasTerminalResult(), "unknowable-raw: unexpected terminal result");
  assert(
    parser.getOutput()?.errorText === errorText,
    "unknowable-raw: output did not carry the budget error",
  );
  assert(
    parser.getOutputTruncationText() === null,
    "unknowable-raw: a failed turn must not be reported as a recovered truncation",
  );
  console.log(`[unknowable-raw] still fails as designed: ${errorText}`);
}

/** A tool call with an id no other frame reuses: the unbounded-ids case. */
function uniqueToolUseFrame(index: number): string {
  return JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      id: `msg_proof_${index}`,
      content: [
        {
          type: "tool_use",
          id: `toolu_proof_unique_${index}`,
          name: "Bash",
          input: { command: `echo ${index}` },
        },
      ],
    },
  });
}

function uniqueToolResultFrame(index: number): string {
  return JSON.stringify({
    type: "user",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      content: [{ type: "tool_result", tool_use_id: `toolu_proof_unique_${index}`, content: "ok" }],
    },
  });
}

/** Argument fragments for a tool block whose `content_block_stop` never arrives. */
function unfinishedToolInputFrame(chars: number): string {
  return JSON.stringify({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    event: {
      type: "content_block_delta",
      index: 99,
      delta: { type: "input_json_delta", partial_json: "u".repeat(chars) },
    },
  });
}

function unfinishedToolStartFrame(): string {
  return JSON.stringify({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    event: {
      type: "content_block_start",
      index: 99,
      content_block: { type: "tool_use", id: "toolu_proof_never_stops", name: "Write", input: {} },
    },
  });
}

function scenarioRetentionFlat(): void {
  let assistantDeltaCount = 0;
  let toolStartCount = 0;
  let toolResultCount = 0;
  // Counted, never retained: holding the delivered payloads here would measure
  // this harness's own arrays instead of the parser's retention.
  const parser = createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {
      assistantDeltaCount += 1;
    },
    onToolUseStart: () => {
      toolStartCount += 1;
    },
    onToolResult: () => {
      toolResultCount += 1;
    },
  });
  retainedForMeasurement.push(parser);
  overflowRawCharBudget(parser);
  const deltasAtOverflow = assistantDeltaCount;
  // A tool block that opens before exhaustion and never stops, so nothing but
  // the tracker's own bound limits its argument fragments.
  parser.push(`${unfinishedToolStartFrame()}\n`);
  forceGarbageCollection();
  const heapAtOverflow = process.memoryUsage().heapUsed;

  let streamedAfter = 0;
  let uniqueToolCalls = 0;
  let unfinishedArgumentChars = 0;
  const argumentFragmentChars = 1024;
  const unfinishedArgumentLine = unfinishedToolInputFrame(argumentFragmentChars);
  for (let index = 0; streamedAfter < 32 * 1024 * 1024; index += 1) {
    // Every post-budget iteration adds a tool id the tracker has never seen and
    // another slab of arguments to a block that will never be closed — the two
    // shapes that make post-budget tool tracking grow without limit.
    const chunk =
      `${textDeltaFrame(`late ${index} `)}\n` +
      `${uniqueToolUseFrame(index)}\n` +
      `${uniqueToolResultFrame(index)}\n` +
      `${unfinishedArgumentLine}\n`;
    uniqueToolCalls += 1;
    unfinishedArgumentChars += argumentFragmentChars;
    streamedAfter += chunk.length;
    parser.push(chunk);
  }
  forceGarbageCollection();
  const heapGrowth = process.memoryUsage().heapUsed - heapAtOverflow;

  assert(
    assistantDeltaCount === deltasAtOverflow,
    `retention-flat: ${assistantDeltaCount - deltasAtOverflow} assistant delta(s) assembled after the budget was spent`,
  );
  // Both bounds must actually engage, or the measurement proves nothing.
  assert(
    uniqueToolCalls > 4096,
    `retention-flat: only ${uniqueToolCalls} unique tool ids streamed; the tracked-id bound never engaged`,
  );
  assert(
    unfinishedArgumentChars > 8 * 1024 * 1024,
    `retention-flat: only ${unfinishedArgumentChars} argument chars streamed to the unfinished block; the buffered-argument bound never engaged`,
  );
  assert(
    toolStartCount >= uniqueToolCalls && toolResultCount >= uniqueToolCalls,
    `retention-flat: only ${toolStartCount} start(s)/${toolResultCount} result(s) for ${uniqueToolCalls} post-budget tool calls; bounding the state must not cost the progress signal`,
  );
  assert(
    heapGrowth < streamedAfter / 8,
    `retention-flat: heap grew ${heapGrowth} bytes while streaming ${streamedAfter} post-budget bytes across ${uniqueToolCalls} unique tool calls and ${unfinishedArgumentChars} argument chars on an unfinished tool block; retention is not flat`,
  );
  console.log(
    `[retention-flat] streamed ${streamedAfter} post-budget bytes across ${uniqueToolCalls} unique tool call(s) and ${unfinishedArgumentChars} argument chars on a never-stopping tool block; heap delta ${heapGrowth} bytes; ${toolStartCount} tool start(s) still reported; 0 new assistant deltas`,
  );
}

const PARENT_AGENT_TOOL_CALL_ID = "toolu_proof_parent_agent";

/** One forwarded subagent record, exactly as Claude Code writes it on the parent's stdout. */
function subagentFrame(index: number, payloadChars: number): string {
  return JSON.stringify({
    type: "assistant",
    parent_tool_use_id: PARENT_AGENT_TOOL_CALL_ID,
    session_id: SESSION_ID,
    message: {
      id: `msg_subagent_${index}`,
      content: [{ type: "text", text: "s".repeat(payloadChars) }],
    },
  });
}

function parentToolUseFrame(toolCallId: string, name: string): string {
  return JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      id: "msg_parent_tool",
      content: [{ type: "tool_use", id: toolCallId, name, input: { command: "sleep 60" } }],
    },
  });
}

function parentToolResultFrame(toolCallId: string): string {
  return JSON.stringify({
    type: "user",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      content: [{ type: "tool_result", tool_use_id: toolCallId, content: "Exit code 1" }],
    },
  });
}

function createLivenessParser(sinks: {
  assistantDeltas: string[];
  toolStarts: CliToolUseStartDelta[];
  toolResults: CliToolResultDelta[];
  attributedProgress: string[];
}) {
  return createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: (delta) => sinks.assistantDeltas.push(delta.delta),
    onToolUseStart: (tool) => sinks.toolStarts.push(tool),
    onToolResult: (result) => sinks.toolResults.push(result),
    onAttributedSubagentProgress: (id) => sinks.attributedProgress.push(id),
  });
}

function scenarioSubagentExempt(): void {
  const sinks = {
    assistantDeltas: [] as string[],
    toolStarts: [] as CliToolUseStartDelta[],
    toolResults: [] as CliToolResultDelta[],
    attributedProgress: [] as string[],
  };
  const parser = createLivenessParser(sinks);

  // Three times both budgets, entirely in traffic the parent lane discards.
  let streamed = 0;
  let lines = 0;
  while (
    streamed < CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars * 3 ||
    lines < CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines * 3
  ) {
    const chunk = `${subagentFrame(lines, 480)}\n`;
    streamed += chunk.length;
    lines += 1;
    parser.push(chunk);
  }

  parser.push(`${textDeltaFrame(FINAL_ANSWER)}\n`);
  parser.push(`${terminalResultFrame()}\n`);
  parser.finish();

  assert(
    parser.getErrorText() === null,
    `subagent-exempt: parser reported "${parser.getErrorText()}" for a turn whose parent lane stayed tiny`,
  );
  assert(
    parser.getOutputTruncationText() === null,
    `subagent-exempt: a budget was spent on discarded traffic (${parser.getOutputTruncationText()})`,
  );
  assert(
    parser.getOutput()?.text === FINAL_ANSWER,
    `subagent-exempt: expected the parent answer, got ${JSON.stringify(parser.getOutput()?.text)}`,
  );
  assert(
    sinks.assistantDeltas.join("").includes(FINAL_ANSWER),
    "subagent-exempt: the parent's own streamed text was not assembled",
  );
  assert(
    sinks.attributedProgress.length === lines,
    `subagent-exempt: expected ${lines} attributed progress signals, saw ${sinks.attributedProgress.length}`,
  );
  console.log(
    `[subagent-exempt] streamed ${streamed} chars / ${lines} lines of forwarded subagent traffic (${(streamed / (1024 * 1024)).toFixed(1)} MiB, ${((lines / CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines) * 100).toFixed(0)}% of the line cap); no budget spent, parent answer intact`,
  );
}

function scenarioProgressPastBudget(): void {
  const sinks = {
    assistantDeltas: [] as string[],
    toolStarts: [] as CliToolUseStartDelta[],
    toolResults: [] as CliToolResultDelta[],
    attributedProgress: [] as string[],
  };
  const parser = createLivenessParser(sinks);

  // Parent traffic alone spends the budget, exactly as the incident turn did.
  overflowRawCharBudget(parser);
  const deltasAtOverflow = sinks.assistantDeltas.length;

  const toolCallId = "toolu_proof_bash_after_budget";
  parser.push(`${parentToolUseFrame(toolCallId, "Bash")}\n`);
  parser.push(`${subagentFrame(0, 64)}\n`);
  parser.push(`${parentToolResultFrame(toolCallId)}\n`);
  parser.push(`${terminalResultFrame()}\n`);
  parser.finish();

  assert(
    sinks.toolStarts.some((tool) => tool.toolCallId === toolCallId && tool.name === "Bash"),
    "progress-past-budget: no tool start reached the gateway after the budget was spent; lastProgress would freeze",
  );
  assert(
    sinks.toolResults.some((result) => result.toolCallId === toolCallId),
    "progress-past-budget: no tool result reached the gateway; activeParsedToolCount would never decrement",
  );
  assert(
    sinks.attributedProgress.includes(PARENT_AGENT_TOOL_CALL_ID),
    "progress-past-budget: attributed subagent progress stopped; a long Agent call would read as blocked",
  );
  assert(
    sinks.assistantDeltas.length === deltasAtOverflow,
    "progress-past-budget: assistant text was assembled past the budget; retention is not flat",
  );
  assert(
    parser.getOutputTruncationText() !== null,
    "progress-past-budget: the budget was never spent, so the scenario proved nothing",
  );
  assert(
    parser.getErrorText() === null && parser.getOutput()?.text === FINAL_ANSWER,
    "progress-past-budget: the finished turn was not recovered",
  );
  console.log(
    `[progress-past-budget] past exhaustion: ${sinks.toolStarts.length} tool start(s), ${sinks.toolResults.length} tool result(s), ${sinks.attributedProgress.length} attributed progress signal(s), 0 new assistant deltas`,
  );
}

// Retention runs first: a heap baseline taken after the other scenarios carries
// their transient graphs and can mask the growth this measures.
scenarioRetentionFlat();
scenarioRecovered("recovered-raw", overflowRawCharBudget);
scenarioRecovered("recovered-lines", overflowLineBudget);
scenarioUnknowable();
scenarioSubagentExempt();
scenarioProgressPastBudget();
console.log("All runtime assertions passed.");
