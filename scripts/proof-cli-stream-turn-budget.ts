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
 *  5. start-snapshot-bound — 240 tool blocks (under the 256-block cap, so only
 *                       the character bound can hold) each opened past
 *                       exhaustion with a complete 512 KiB `content_block_start`
 *                       input and never stopped. Pins that the decoded start
 *                       snapshots are bounded in aggregate, that the blocks with
 *                       room keep their input, and that a block past the bound
 *                       still reports a tool start.
 *  6. subagent-exempt — 3x both budgets streamed as forwarded subagent traffic
 *                       (`parent_tool_use_id` set), which the parent lane
 *                       discards. Pins that no budget is spent and the parent's
 *                       own answer is still assembled normally.
 *  7. progress-past-budget — after the budget IS spent by parent traffic, the
 *                       parser still emits tool start, tool result and
 *                       attributed subagent progress. Pins the liveness facts
 *                       the gateway's stall detector reads once a tool is
 *                       active; without them a healthy run is aborted as stuck.
 *  8. consumer-retention-bound — the same post-budget tool events delivered to
 *                       the REAL runner consumer, `createCliEventHandlers` over
 *                       a real `createCliToolTracking`, instead of to this
 *                       harness's own sinks. 48 MiB of decoded tool arguments
 *                       across 3,072 calls whose results never arrive. Pins that
 *                       the consumer's per-call maps stay inside their caps and
 *                       that every start still reaches it.
 *  9. messaging-retention-bound — 48 unresolved visible `message` sends past
 *                       exhaustion, 1 MiB of arguments each, held under the
 *                       64-entry delivery-evidence cap so only a byte bound can
 *                       hold. Pins that the third holder of those arguments is
 *                       bounded too, and — settling one send from each side of
 *                       the bound — that delivery, the source reply and the
 *                       send's target still settle from the facts it keeps.
 * 10. tool-split-reply — "Before." streams, a tool starts, the budget is spent,
 *                       then the final message and a terminal result carrying
 *                       only that message arrive. Pins that the reply keeps the
 *                       pre-tool text exactly as an unbudgeted turn does, and —
 *                       as a control — that a non-tool boundary still drops a
 *                       superseded draft.
 * 11. reduced-final-flag — a `message` send past the retention bound whose
 *                       decoded arguments put 1,000 small provider fields ahead
 *                       of a trailing `final: false`, settled through the real
 *                       consumer pair. Pins that the reduced entry still settles
 *                       as a progress send, not as the final reply.
 *
 * Both overflow helpers drive the parser until IT reports the budget spent and
 * assert that, rather than assuming a byte or line count spends it: partial
 * text deltas are exempt from the line odometer and charged below their raw
 * size, so a fixed count can silently leave the budget unspent.
 *
 * Run: pnpm tsx scripts/proof-cli-stream-turn-budget.ts
 */
// MUST stay first: it isolates the state directory before `src/config/paths.ts`
// resolves it. See `scripts/proof-isolated-state.ts`.
import "./proof-isolated-state.js";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type {
  CliToolResultDelta,
  CliToolUseStartDelta,
} from "../src/agents/cli-output-contracts.js";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../src/agents/cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "../src/agents/cli-output-stream.js";
import {
  MAX_REDUCED_MESSAGING_ARG_CHARS,
  MAX_RETAINED_TOOL_ARG_CHARS,
  MAX_TRACKED_TOOL_SUMMARIES,
  MAX_UNFINISHED_TOOL_CALLS,
} from "../src/agents/cli-runner/execute-event-retention.js";
import { createCliEventHandlers } from "../src/agents/cli-runner/execute-events.js";
import { CLI_MESSAGING_EVIDENCE_MAX_CALLS } from "../src/agents/cli-runner/execute-messaging.js";
import { createCliToolTracking } from "../src/agents/cli-runner/execute-tool-tracking.js";
import type { PreparedCliRunContext } from "../src/agents/cli-runner/types.js";

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

/**
 * Proves the budget is spent before a scenario depends on it. With no terminal
 * result yet, a spent budget still reads as the hard limit error.
 */
function assertBudgetSpent(parser: Parser, measure: string, streamed: number): void {
  const errorText = parser.getErrorText();
  assert(
    errorText?.includes(`JSONL output exceeded ${measure}`),
    `overflow: ${streamed} streamed without spending the ${measure} budget (error text ${JSON.stringify(errorText)}); every post-budget assertion would be vacuous`,
  );
}

/** Streams realistic frames until the parser reports the character budget spent. */
function overflowRawCharBudget(parser: Parser): number {
  let streamed = 0;
  // Partial deltas are charged below their raw size, so raw bytes streamed is
  // not the stop condition; the parser's own verdict is. Capped so a parser
  // that never charges cannot loop forever.
  const cap = 4 * CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars;
  for (let index = 0; parser.getErrorText() === null && streamed <= cap; index += 1) {
    const frames = [
      textDeltaFrame(`step ${index} `),
      toolResultFrame(index, 96_000),
      textDeltaFrame(`observed ${index}\n`),
    ];
    const chunk = `${frames.join("\n")}\n`;
    streamed += chunk.length;
    parser.push(chunk);
  }
  assertBudgetSpent(
    parser,
    `${CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars} characters`,
    streamed,
  );
  return streamed;
}

/**
 * Streams ordinary records until the line budget is spent. Partial-message
 * text deltas are exempt from the line odometer, so they cannot spend it.
 */
function overflowLineBudget(parser: Parser): number {
  const lines = CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines + 1;
  const ordinaryRecord = JSON.stringify({
    type: "system",
    subtype: "status",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  parser.push(`${ordinaryRecord}\n`.repeat(lines));
  assertBudgetSpent(parser, `${CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines} lines`, lines);
  return lines;
}

function scenarioRecovered(
  name: string,
  overflow: (parser: Parser) => number,
  unit: "chars" | "lines",
): void {
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
    `[${name}] streamed ${streamed} ${unit} to spend the budget, recovered "${output.text}"; truncation: ${truncation}`,
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

/**
 * One `content_block_start` carrying the COMPLETE tool input, as the backends
 * documented on `PendingToolUse.blockInput` send it — no `input_json_delta`
 * follows and no `content_block_stop` ever arrives, so the decoded snapshot is
 * retained for the life of the turn. Each block's payload is distinct, so the
 * measurement below observes real retention rather than one shared string.
 */
function largeStartSnapshotFrame(index: number, inputChars: number): string {
  return JSON.stringify({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    event: {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: `toolu_proof_snapshot_${index}`,
        name: "Write",
        input: { content: `${index}`.padEnd(inputChars, "s") },
      },
    },
  });
}

function blockStopFrame(index: number): string {
  return JSON.stringify({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    event: { type: "content_block_stop", index },
  });
}

function scenarioStartSnapshotBound(): void {
  const starts: CliToolUseStartDelta[] = [];
  const parser = createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {},
    onToolUseStart: (tool) => starts.push(tool),
  });
  retainedForMeasurement.push(parser);
  overflowRawCharBudget(parser);
  forceGarbageCollection();
  const heapAtOverflow = process.memoryUsage().heapUsed;

  // Deliberately under the 256-block cap, so the block COUNT cannot be what
  // bounds this: only the aggregate character bound on retained start snapshots
  // can, which is the path the review flagged.
  const blocks = 240;
  const snapshotChars = 512 * 1024;
  let streamedAfter = 0;
  for (let index = 0; index < blocks; index += 1) {
    const line = `${largeStartSnapshotFrame(index, snapshotChars)}\n`;
    streamedAfter += line.length;
    parser.push(line);
  }
  forceGarbageCollection();
  const heapGrowth = process.memoryUsage().heapUsed - heapAtOverflow;

  const snapshotCharsStreamed = blocks * snapshotChars;
  assert(
    blocks < 256,
    `start-snapshot-bound: ${blocks} blocks reaches the pending-block cap, so the character bound was not what held`,
  );
  assert(
    snapshotCharsStreamed > CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars,
    `start-snapshot-bound: only ${snapshotCharsStreamed} snapshot chars streamed; the aggregate bound never engaged`,
  );
  assert(
    heapGrowth < streamedAfter / 8,
    `start-snapshot-bound: heap grew ${heapGrowth} bytes while streaming ${snapshotCharsStreamed} chars of start-snapshot input across ${blocks} never-stopping tool blocks past exhaustion; the snapshots are not bounded`,
  );

  // The bound costs the arguments of the blocks that overran it, never the
  // progress signal: both the first block (snapshot kept) and the last (snapshot
  // refused) still settle into a tool start when their stop finally arrives.
  parser.push(`${blockStopFrame(0)}\n${blockStopFrame(blocks - 1)}\n`);
  const firstStart = starts.find((tool) => tool.toolCallId === "toolu_proof_snapshot_0");
  const lastStart = starts.find((tool) => tool.toolCallId === `toolu_proof_snapshot_${blocks - 1}`);
  assert(
    typeof firstStart?.args.content === "string" &&
      (firstStart.args.content as string).length === snapshotChars,
    "start-snapshot-bound: the first block lost its start snapshot, so the bound is discarding input it had room for",
  );
  assert(
    lastStart !== undefined && Object.keys(lastStart.args).length === 0,
    "start-snapshot-bound: the block past the bound did not settle into a start with empty args",
  );
  console.log(
    `[start-snapshot-bound] ${snapshotCharsStreamed} chars of start-snapshot input across ${blocks} never-stopping tool blocks past exhaustion; heap delta ${heapGrowth} bytes against ${streamedAfter} streamed; first block kept its ${snapshotChars}-char snapshot, the block past the bound still reported a start`,
  );
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

/**
 * A tool call carrying a large decoded `input`, with an id nothing reuses and a
 * result that never arrives — the shape that reaches the runner's per-call maps
 * and stays there.
 */
function largeArgToolUseFrame(index: number, argChars: number): string {
  return JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      id: `msg_consumer_${index}`,
      content: [
        {
          type: "tool_use",
          id: `toolu_consumer_${index}`,
          name: "Bash",
          // Distinct per call, so the measurement observes real retention
          // rather than one shared string.
          input: { command: `${index}:${"c".repeat(argChars)}` },
        },
      ],
    },
  });
}

/**
 * The production CLI event consumer, wired to the real parser as
 * `execute-process.ts` wires it — `createCliEventHandlers` over a real
 * `createCliToolTracking`, not a substitute sink. The earlier scenarios prove
 * the PARSER stays bounded past exhaustion; this one proves the runner state
 * those preserved events now reach stays bounded too, and that bounding it does
 * not cost the tool starts the gateway's stall detector reads.
 *
 * The run context is a literal (no gateway, no session file, no channel).
 * Everything between the parser and the retained maps is the production path.
 */
function buildProofRunContext(runId: string, sessionKey: string): PreparedCliRunContext {
  const backend = { command: "claude", args: [], output: "jsonl" as const, serialize: true };
  return {
    params: {
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey,
      workspaceDir: "/tmp",
      prompt: "proof",
      provider: "claude-cli",
      model: "claude-haiku-4-5",
      timeoutMs: 1_000,
      runId,
    },
    started: Date.now(),
    startedMonotonicMs: performance.now(),
    workspaceDir: "/tmp",
    backendResolved: { id: "claude-cli", config: backend, bundleMcp: false },
    preparedBackend: { backend, env: {} },
    executionTarget: { kind: "process" },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "claude-haiku-4-5",
    normalizedModel: "claude-haiku-4-5",
    systemPrompt: "system",
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  } as unknown as PreparedCliRunContext;
}

function scenarioConsumerRetentionBound(): void {
  const context = buildProofRunContext("proof-consumer-retention", "agent:proof:consumer");
  const toolTracking = createCliToolTracking(context);
  const handlers = createCliEventHandlers({
    context,
    toolTracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const parser = createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: handlers.emitCliAssistantDelta,
    onCompletedReply: handlers.emitCliCompletedReply,
    onToolUseStart: handlers.emitParsedToolUseStart,
    onToolResult: handlers.emitParsedToolResult,
    onDisplayToolUseStart: handlers.emitCliDisplayToolUseStart,
    onDisplayToolResult: handlers.emitCliDisplayToolResult,
  });
  // Keep-alive: the maps under measurement die with these otherwise, and the
  // scenario would report a flat heap against a build with no bound at all.
  retainedForMeasurement.push(parser, handlers, toolTracking);

  overflowRawCharBudget(parser);
  const callsAtOverflow = handlers.getToolSummary().calls;
  forceGarbageCollection();
  const heapAtOverflow = process.memoryUsage().heapUsed;

  const argChars = 16 * 1024;
  let streamedAfter = 0;
  let argCharsStreamed = 0;
  let uniqueToolCalls = 0;
  while (argCharsStreamed < 48 * 1024 * 1024) {
    const frame = `${largeArgToolUseFrame(uniqueToolCalls, argChars)}\n`;
    uniqueToolCalls += 1;
    argCharsStreamed += argChars;
    streamedAfter += frame.length;
    parser.push(frame);
  }
  parser.push(`${terminalResultFrame()}\n`);
  parser.finish();
  forceGarbageCollection();
  const heapGrowth = process.memoryUsage().heapUsed - heapAtOverflow;
  const retainedBound = 2 * MAX_RETAINED_TOOL_ARG_CHARS;

  // Both bounds have to engage, or the measurement proves nothing.
  assert(
    uniqueToolCalls > MAX_UNFINISHED_TOOL_CALLS,
    `consumer-retention-bound: only ${uniqueToolCalls} unfinished calls; the count bound never engaged`,
  );
  assert(
    argCharsStreamed > MAX_RETAINED_TOOL_ARG_CHARS * 4,
    `consumer-retention-bound: only ${argCharsStreamed} argument chars streamed; the character bound never engaged`,
  );
  // Read before the heap assertion so a failure reports the composition, not
  // just the number. A build without the bound fails on the measurement itself
  // rather than on a missing accessor, because the measurement comes first.
  const retained = handlers.getRetainedStateSizes?.();
  assert(
    heapGrowth < retainedBound,
    `consumer-retention-bound: heap grew ${heapGrowth} bytes while the runner's event consumer took ${uniqueToolCalls} post-budget tool starts carrying ${argCharsStreamed} argument chars; retained runner state is not bounded (bound ${retainedBound}, consumer state ${JSON.stringify(retained)})`,
  );
  assert(
    retained !== undefined,
    "consumer-retention-bound: the consumer exposes no retained-state sizes to check against its caps",
  );
  assert(
    retained.retainedToolArgChars <= MAX_RETAINED_TOOL_ARG_CHARS &&
      retained.unfinishedToolCalls <= MAX_UNFINISHED_TOOL_CALLS &&
      retained.toolSummaries <= MAX_TRACKED_TOOL_SUMMARIES &&
      retained.activeParsedTools <= MAX_UNFINISHED_TOOL_CALLS,
    `consumer-retention-bound: consumer state outside its caps: ${JSON.stringify(retained)}`,
  );
  // Bounding retention must not cost the liveness this branch restores.
  const postBudgetCalls = handlers.getToolSummary().calls - callsAtOverflow;
  assert(
    postBudgetCalls === uniqueToolCalls,
    `consumer-retention-bound: ${postBudgetCalls} of ${uniqueToolCalls} post-budget tool starts reached the consumer; the stall detector would stop seeing progress`,
  );
  assert(
    handlers.activeParsedToolCount() > 0,
    "consumer-retention-bound: no tool reads as active, so the blocked-tool clock would not be held at all",
  );
  console.log(
    `[consumer-retention-bound] ${uniqueToolCalls} post-budget tool starts carrying ${argCharsStreamed} argument chars ` +
      `through the real createCliEventHandlers/createCliToolTracking; heap delta ${heapGrowth} bytes against ${streamedAfter} streamed; ` +
      `retained ${JSON.stringify(retained)}; all ${uniqueToolCalls} starts still counted`,
  );
}

/** An unresolved visible `message` send carrying a large decoded payload. */
function messageSendToolUseFrame(index: number, contentChars: number): string {
  return JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      id: `msg_send_${index}`,
      content: [
        {
          type: "tool_use",
          id: `toolu_send_${index}`,
          name: "mcp__openclaw__message",
          input: {
            action: "send",
            channel: "slack",
            target: "C0PROOF",
            content: `${index}:${"m".repeat(contentChars)}`,
          },
        },
      ],
    },
  });
}

/** The settled delivery the MCP message tool returns for a real send. */
function messageSendResultFrame(index: number): string {
  return JSON.stringify({
    type: "user",
    session_id: SESSION_ID,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: `toolu_send_${index}`,
          content: {
            details: {
              messageDelivery: {
                status: "settled",
                partialDelivery: false,
                createdThreadIds: [],
                sourceReplyDelivered: true,
              },
            },
          },
        },
      ],
    },
  });
}

/**
 * The third holder of a post-budget tool start's decoded arguments:
 * `pendingMessagingCalls` inside `createCliToolTracking`, which keeps the
 * arguments of a visible message send until its result settles the delivery.
 * The consumer scenario above bounds the two runner maps; this one drives
 * unresolved SENDS instead of ordinary tool calls, which is the traffic that
 * reaches this holder at all.
 *
 * Entirely production path: the frames are the stream-json shapes the CLI emits
 * for an MCP message call and its `tool_result`, and the settlement below is
 * whatever the real `handleCliToolResult` and `withExecutionEvidence` produce
 * from them. Nothing about delivery is asserted by construction.
 */
function scenarioMessagingRetentionBound(): void {
  const context = buildProofRunContext("proof-messaging-retention", "agent:proof:messaging");
  const toolTracking = createCliToolTracking(context);
  const handlers = createCliEventHandlers({
    context,
    toolTracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const parser = createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: handlers.emitCliAssistantDelta,
    onCompletedReply: handlers.emitCliCompletedReply,
    onToolUseStart: handlers.emitParsedToolUseStart,
    onToolResult: handlers.emitParsedToolResult,
    onDisplayToolUseStart: handlers.emitCliDisplayToolUseStart,
    onDisplayToolResult: handlers.emitCliDisplayToolResult,
  });
  retainedForMeasurement.push(parser, handlers, toolTracking);

  // Warm the production delivery path on a throwaway tracking before the
  // baseline. Classifying a send resolves channel plugins through the plugin
  // metadata snapshot, whose module graph is a ~200 MB one-time process cost —
  // charged inside the window it would read as per-send retention and the
  // measurement would be meaningless in both directions.
  createCliToolTracking(context).handleCliToolUseStart({
    toolCallId: "toolu_send_warmup",
    name: "mcp__openclaw__message",
    kind: "mcp_tool_use",
    args: { action: "send", channel: "slack", target: "C0PROOF", content: "warm" },
  });

  overflowRawCharBudget(parser);
  forceGarbageCollection();
  const heapAtOverflow = process.memoryUsage().heapUsed;

  // Deliberately under the 64-entry holder cap, so only a byte bound can hold:
  // 48 sends of 1 MiB is 48 MiB against the runner's 8 MiB retention budget.
  const contentChars = 1024 * 1024;
  const sends = 48;
  let streamedAfter = 0;
  for (let index = 0; index < sends; index += 1) {
    const frame = `${messageSendToolUseFrame(index, contentChars)}\n`;
    streamedAfter += frame.length;
    parser.push(frame);
  }
  forceGarbageCollection();
  const heapGrowth = process.memoryUsage().heapUsed - heapAtOverflow;
  const retained = handlers.getRetainedStateSizes();
  const retainedBound = 2 * MAX_RETAINED_TOOL_ARG_CHARS;

  assert(
    sends < CLI_MESSAGING_EVIDENCE_MAX_CALLS,
    `messaging-retention-bound: ${sends} sends reaches the ${CLI_MESSAGING_EVIDENCE_MAX_CALLS}-entry count cap, so the byte bound was not what held`,
  );
  assert(
    contentChars * sends > MAX_RETAINED_TOOL_ARG_CHARS * 4,
    `messaging-retention-bound: only ${contentChars * sends} argument chars streamed; the byte bound never engaged`,
  );
  assert(
    heapGrowth < retainedBound,
    `messaging-retention-bound: heap grew ${heapGrowth} bytes while ${sends} unresolved message sends carrying ${contentChars * sends} argument chars reached the real tracking; delivery evidence is not bounded (bound ${retainedBound}, consumer state ${JSON.stringify(retained)})`,
  );
  assert(
    retained.pendingMessagingCalls === sends,
    `messaging-retention-bound: ${retained.pendingMessagingCalls} of ${sends} sends are held as delivery evidence; the holder under measurement was not exercised`,
  );
  assert(
    retained.reducedMessagingCalls > 0 &&
      retained.reducedMessagingArgChars <=
        retained.reducedMessagingCalls * MAX_REDUCED_MESSAGING_ARG_CHARS,
    `messaging-retention-bound: delivery evidence outside its bound: ${JSON.stringify(retained)}`,
  );

  // Bounding the holder must not cost what it exists for. Settle one send whose
  // arguments were released and one whose arguments were kept, and read the
  // production evidence.
  parser.push(`${messageSendResultFrame(sends - 1)}\n`);
  parser.push(`${messageSendResultFrame(0)}\n`);
  parser.push(`${terminalResultFrame()}\n`);
  parser.finish();
  const evidence = toolTracking.withExecutionEvidence({ text: "" });
  assert(
    evidence.didSendViaMessagingTool === true,
    "messaging-retention-bound: a settled send past the bound was not recorded as a visible send; a failed turn could duplicate it",
  );
  assert(
    evidence.didDeliverSourceReplyViaMessageTool === true && evidence.sourceReplyDelivered === true,
    `messaging-retention-bound: source-reply settlement was lost (${JSON.stringify({
      didDeliverSourceReplyViaMessageTool: evidence.didDeliverSourceReplyViaMessageTool,
      sourceReplyDelivered: evidence.sourceReplyDelivered,
    })})`,
  );
  assert(
    evidence.messagingToolSentTargets?.some((target) => target.provider === "slack") === true,
    `messaging-retention-bound: the send's target was not recorded: ${JSON.stringify(evidence.messagingToolSentTargets)}`,
  );
  const sentTexts = evidence.messagingToolSentTexts ?? [];
  assert(
    sentTexts.some((text) => text.startsWith("0:")),
    "messaging-retention-bound: the send inside the bound lost its content evidence, so the bound is discarding payloads it had room for",
  );
  assert(
    !sentTexts.some((text) => text.startsWith(`${sends - 1}:`)),
    "messaging-retention-bound: the send past the bound still echoed its full content as evidence; its payload was never released",
  );
  console.log(
    `[messaging-retention-bound] ${sends} unresolved message sends carrying ${contentChars * sends} argument chars ` +
      `through the real parser and createCliToolTracking; heap delta ${heapGrowth} bytes against ${streamedAfter} streamed; ` +
      `retained ${JSON.stringify(retained)}; both settled sends recorded delivery and the source reply, only the send inside the bound kept its content`,
  );
}

function parentStreamEventFrame(event: Record<string, unknown>): string {
  return JSON.stringify({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    event,
  });
}

/**
 * The tool-split reply contract across a spent budget. Unbudgeted, a turn that
 * says "Before.", runs a tool and then answers in a new message yields
 * "Before.\n\n<answer>" even though the terminal result carries only the
 * answer. The budget is spent between the tool and the final message, so the
 * final message's text reaches the parser only as dropped post-budget traffic.
 */
function scenarioToolSplitReply(): void {
  const preToolText = "Here is what the subagents found.";
  const run = (name: string, toolSplit: boolean): string | undefined => {
    const assistantDeltas: string[] = [];
    const parser = createParser(assistantDeltas);
    const frames = [
      parentStreamEventFrame({ type: "message_start", message: { id: `msg_${name}_1` } }),
      parentStreamEventFrame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: preToolText },
      }),
      ...(toolSplit
        ? [
            parentStreamEventFrame({
              type: "content_block_start",
              index: 1,
              content_block: { type: "tool_use", id: `toolu_${name}`, name: "Agent" },
            }),
          ]
        : []),
    ];
    parser.push(`${frames.join("\n")}\n`);
    overflowLineBudget(parser);
    const deltasAtOverflow = assistantDeltas.length;
    parser.push(
      `${[
        parentStreamEventFrame({ type: "message_stop" }),
        parentStreamEventFrame({ type: "message_start", message: { id: `msg_${name}_2` } }),
        parentStreamEventFrame({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: FINAL_ANSWER },
        }),
        terminalResultFrame(),
      ].join("\n")}\n`,
    );
    parser.finish();
    assert(parser.getErrorText() === null, `${name}: ${parser.getErrorText()}`);
    assert(
      parser.getOutputTruncationText()?.includes("kept watching for the terminal result"),
      `${name}: truncation was not reported`,
    );
    assert(
      assistantDeltas.length === deltasAtOverflow,
      `${name}: text was assembled after the budget was spent`,
    );
    return parser.getOutput()?.text;
  };

  const expected = `${preToolText}\n\n${FINAL_ANSWER}`;
  const split = run("tool-split-reply", true);
  assert(
    split === expected,
    `tool-split-reply: expected ${JSON.stringify(expected)}, got ${JSON.stringify(split)}; the pre-tool explanation was erased`,
  );
  const draft = run("tool-split-reply-control", false);
  assert(
    draft === FINAL_ANSWER,
    `tool-split-reply-control: a non-tool boundary must still drop the superseded draft, got ${JSON.stringify(draft)}`,
  );
  console.log(
    `[tool-split-reply] budget spent between the tool and the final message; reply ${JSON.stringify(split)}; ` +
      `control without a tool split kept only ${JSON.stringify(draft)}`,
  );
}

/**
 * A reduced send's `final: false` survives regardless of where it sits. The
 * send is past the runner's retention bound, so its delivery evidence is cut to
 * the 8 KiB reduced allowance — and 1,000 one-character provider fields ahead of
 * the flag are enough to spend that allowance to within a few bytes.
 */
function scenarioReducedFinalFlag(): void {
  const context = buildProofRunContext("proof-reduced-final", "agent:proof:reduced-final");
  const toolTracking = createCliToolTracking(context);
  const handlers = createCliEventHandlers({
    context,
    toolTracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const parser = createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: handlers.emitCliAssistantDelta,
    onCompletedReply: handlers.emitCliCompletedReply,
    onToolUseStart: handlers.emitParsedToolUseStart,
    onToolResult: handlers.emitParsedToolResult,
    onDisplayToolUseStart: handlers.emitCliDisplayToolUseStart,
    onDisplayToolResult: handlers.emitCliDisplayToolResult,
  });
  overflowRawCharBudget(parser);

  // Fill the runner's retention budget with unresolved sends first, so the send
  // under test is the one whose arguments are refused and reduced.
  const contentChars = 1024 * 1024;
  const fillers = Math.ceil(MAX_RETAINED_TOOL_ARG_CHARS / contentChars) + 1;
  for (let index = 0; index < fillers; index += 1) {
    parser.push(`${messageSendToolUseFrame(index, contentChars)}\n`);
  }
  const smallFields = Object.fromEntries(
    Array.from({ length: 1_000 }, (_, index) => [`p${index}`, "x"]),
  );
  assert(
    JSON.stringify(smallFields).length > MAX_REDUCED_MESSAGING_ARG_CHARS,
    "reduced-final-flag: the small fields do not outgrow the reduced allowance; the bound never engaged",
  );
  const sendId = "toolu_send_reduced_final";
  parser.push(
    `${JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      message: {
        id: "msg_send_reduced_final",
        content: [
          {
            type: "tool_use",
            id: sendId,
            name: "mcp__openclaw__message",
            input: {
              action: "send",
              channel: "slack",
              target: "C0PROOF",
              content: "m".repeat(contentChars),
              ...smallFields,
              final: false,
            },
          },
        ],
      },
    })}\n`,
  );
  const retained = handlers.getRetainedStateSizes();
  assert(
    retained.reducedMessagingCalls > 0,
    `reduced-final-flag: no send was reduced, so the scenario proves nothing: ${JSON.stringify(retained)}`,
  );
  parser.push(
    `${JSON.stringify({
      type: "user",
      session_id: SESSION_ID,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: sendId,
            content: {
              details: {
                messageDelivery: {
                  status: "settled",
                  partialDelivery: false,
                  createdThreadIds: [],
                  sourceReplyDelivered: true,
                },
                sourceReplySink: "internal-ui",
                deliveryStatus: "sent",
                sourceReply: { text: "progress update" },
              },
            },
          },
        ],
      },
    })}\n`,
  );
  parser.push(`${terminalResultFrame()}\n`);
  parser.finish();
  const evidence = toolTracking.withExecutionEvidence({ text: "" });
  const payloads = evidence.messagingToolSourceReplyPayloads ?? [];
  assert(
    evidence.didDeliverSourceReplyViaMessageTool === true && payloads.length === 1,
    `reduced-final-flag: the reduced send did not settle as a source reply: ${JSON.stringify(payloads)}`,
  );
  assert(
    payloads[0]?.sourceReplyFinal === false,
    `reduced-final-flag: a progress send settled as sourceReplyFinal=${String(payloads[0]?.sourceReplyFinal)}; the turn's real reply would be suppressed`,
  );
  console.log(
    `[reduced-final-flag] send reduced past the retention bound (retained ${JSON.stringify(retained)}); ` +
      `final:false behind 1,000 small fields settled as ${JSON.stringify(payloads[0])}`,
  );
}

// The retention scenarios run first: a heap baseline taken after the other
// scenarios carries their transient graphs and can mask the growth these
// measure.
scenarioRetentionFlat();
scenarioStartSnapshotBound();
scenarioConsumerRetentionBound();
scenarioMessagingRetentionBound();
scenarioRecovered("recovered-raw", overflowRawCharBudget, "chars");
scenarioRecovered("recovered-lines", overflowLineBudget, "lines");
scenarioUnknowable();
scenarioSubagentExempt();
scenarioProgressPastBudget();
scenarioToolSplitReply();
scenarioReducedFinalFlag();
console.log("All runtime assertions passed.");
