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
 *  4. tool-split-silent / tool-split-commentary — pre-tool text, a tool call,
 *                       the budget spent, then the closing message. Pins that
 *                       the envelope does not erase the answer's pre-tool half.
 *  5. superseded-draft — the same shape with NO tool split. Pins that recovery
 *                       does not resurrect a draft the envelope supersedes.
 *  6. discounted-output-seen — a recognized partial delta and no terminal
 *                       envelope. Pins that discounted frames still count as
 *                       observed output for interrupted-run recovery.
 *  7. retention-flat  — 32 MiB pushed AFTER the budget is spent emits zero new
 *                       assistant text and grows the heap by a tiny fraction of
 *                       the bytes streamed. Pins that memory is still bounded.
 *
 * Run: pnpm tsx scripts/proof-cli-stream-turn-budget.ts
 */
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../src/agents/cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "../src/agents/cli-output-stream.js";

const SESSION_ID = "proof-budget-session";
const FINAL_ANSWER = "Report written to ~/reports/theseus-research/context-epidemiology.md";

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
 * A spent budget is observable from outside the parser: with no terminal result
 * yet, `getErrorText()` is exactly the budget's own refusal. Streamed bytes are
 * NOT a usable stand-in — partial-message envelopes are discounted (#153545), so
 * a byte-counted loop stops ~96 KB short of the odometer it means to spend.
 */
function budgetSpent(parser: Parser): boolean {
  return parser.getErrorText() !== null;
}

/** Streams realistic frames until the cumulative character budget is spent. */
function overflowRawCharBudget(parser: Parser): number {
  let streamed = 0;
  const ceiling = CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars * 4;
  for (let index = 0; !budgetSpent(parser); index += 1) {
    assert(streamed < ceiling, `raw budget was not spent after streaming ${streamed} chars`);
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
  assert(
    budgetSpent(parser),
    `line budget was not spent after ${lines} blank frames; ordinary frames are no longer charged`,
  );
  return lines;
}

function messageStartFrame(): string {
  return JSON.stringify({
    type: "stream_event",
    session_id: SESSION_ID,
    event: { type: "message_start", message: { id: "msg_proof" } },
  });
}

function toolUseStartFrame(id: string): string {
  return JSON.stringify({
    type: "stream_event",
    session_id: SESSION_ID,
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id, name: "Read" },
    },
  });
}

/**
 * The reply the operator actually loses: pre-tool text, then a tool call, then
 * the budget is spent, then the closing message and a terminal envelope that
 * restates only that closing message. The complete answer is both halves, so
 * selecting the envelope alone erases the first one.
 *
 * Two overflow shapes, because they exercise different preserved state:
 *  - `silent` spends the line budget on blank frames, so nothing streams
 *    between the tool call and the result. This is the review's exact repro.
 *  - `commentary` spends the character budget on real post-tool text, so the
 *    preserved half is pre-tool text plus everything assembled before the stop.
 */
function scenarioToolSplitRecovered(mode: "silent" | "commentary"): void {
  const assistantDeltas: string[] = [];
  const parser = createParser(assistantDeltas);
  const name = `tool-split-${mode}`;

  parser.push(`${messageStartFrame()}\n`);
  parser.push(`${textDeltaFrame("Before.")}\n`);
  parser.push(`${toolUseStartFrame("toolu_proof_split")}\n`);
  const streamed = mode === "silent" ? overflowLineBudget(parser) : overflowRawCharBudget(parser);

  parser.push(`${messageStartFrame()}\n`);
  parser.push(`${textDeltaFrame(FINAL_ANSWER)}\n`);
  parser.push(`${terminalResultFrame()}\n`);
  parser.finish();

  const output = parser.getOutput();
  assert(parser.getErrorText() === null, `${name}: parser reported "${parser.getErrorText()}"`);
  assert(output !== null, `${name}: no output produced`);
  assert(
    output.text.startsWith("Before."),
    `${name}: pre-tool answer text was erased; got ${JSON.stringify(output.text.slice(0, 120))}`,
  );
  assert(
    output.text.endsWith(FINAL_ANSWER),
    `${name}: the recovered answer is missing; got ${JSON.stringify(output.text.slice(-120))}`,
  );
  if (mode === "silent") {
    const expected = `Before.\n\n${FINAL_ANSWER}`;
    assert(
      output.text === expected,
      `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(output.text)}`,
    );
  }
  assert(
    parser.getOutputTruncationText()?.includes("stopped assembling output"),
    `${name}: truncation was not reported to the operator`,
  );
  console.log(
    `[${name}] ${streamed} frames/chars spent between the tool call and the result; recovered ${output.text.length} chars, both halves present`,
  );
}

/**
 * The same shape with no tool split: a draft, the budget spent, then a terminal
 * envelope with different text. The envelope still supersedes the draft, as it
 * does on an unbudgeted turn — recovery must not resurrect superseded drafts.
 */
function scenarioSupersededDraft(): void {
  const parser = createParser([]);
  parser.push(`${messageStartFrame()}\n`);
  parser.push(`${textDeltaFrame("draft wording")}\n`);
  overflowLineBudget(parser);
  parser.push(`${terminalResultFrame()}\n`);
  parser.finish();

  const output = parser.getOutput();
  assert(
    output?.text === FINAL_ANSWER,
    `superseded-draft: a draft with no tool split must not survive, got ${JSON.stringify(output?.text)}`,
  );
  console.log(`[superseded-draft] draft correctly superseded by the envelope`);
}

/**
 * Frames the odometers discount are still observed output. An interrupted run
 * with no terminal envelope must still be able to consume the assembled text.
 */
function scenarioDiscountedOutputSeen(): void {
  const assistantDeltas: string[] = [];
  const parser = createParser(assistantDeltas);
  parser.push(`${textDeltaFrame("hello")}\n`);
  parser.finish();

  const output = parser.getOutput();
  assert(
    output?.text === "hello",
    `discounted-output-seen: assembled text was not reported, got ${JSON.stringify(output)}`,
  );
  console.log(`[discounted-output-seen] interrupted run still reports "${output.text}"`);
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

function scenarioRetentionFlat(): void {
  const assistantDeltas: string[] = [];
  const parser = createParser(assistantDeltas);
  overflowRawCharBudget(parser);
  const deltasAtOverflow = assistantDeltas.length;
  const heapAtOverflow = process.memoryUsage().heapUsed;

  let streamedAfter = 0;
  for (let index = 0; streamedAfter < 32 * 1024 * 1024; index += 1) {
    const chunk = `${textDeltaFrame(`late ${index} `)}\n${toolResultFrame(index, 96_000)}\n`;
    streamedAfter += chunk.length;
    parser.push(chunk);
  }
  const heapGrowth = process.memoryUsage().heapUsed - heapAtOverflow;

  assert(
    assistantDeltas.length === deltasAtOverflow,
    `retention-flat: ${assistantDeltas.length - deltasAtOverflow} assistant delta(s) assembled after the budget was spent`,
  );
  assert(
    heapGrowth < streamedAfter / 4,
    `retention-flat: heap grew ${heapGrowth} bytes while streaming ${streamedAfter} post-budget bytes; retention is not flat`,
  );
  console.log(
    `[retention-flat] streamed ${streamedAfter} post-budget bytes; heap delta ${heapGrowth} bytes; 0 new assistant deltas`,
  );
}

scenarioRecovered("recovered-raw", overflowRawCharBudget);
scenarioRecovered("recovered-lines", overflowLineBudget);
scenarioToolSplitRecovered("silent");
scenarioToolSplitRecovered("commentary");
scenarioSupersededDraft();
scenarioDiscountedOutputSeen();
scenarioUnknowable();
scenarioRetentionFlat();
console.log("All runtime assertions passed.");
