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
scenarioUnknowable();
scenarioRetentionFlat();
console.log("All runtime assertions passed.");
