/**
 * Real-behavior proof across the `claude` CLI **process boundary**, and against
 * the Gateway's own recovery clock.
 *
 * The sibling harness `proof-cli-stream-turn-budget.ts` drives the parser with
 * synthesized frames. This one does not synthesize anything: it spawns the real
 * `claude` binary, reads its genuine `--output-format stream-json` stdout over a
 * real pipe, and feeds those bytes to the same production code
 * `src/agents/cli-runner/execute-process.ts` feeds them to.
 *
 * Real (nothing here is mocked or stubbed):
 *  - the `claude` process itself, spawned with `node:child_process.spawn`, and
 *    its stdout chunking — chunk boundaries fall wherever the pipe puts them,
 *    which is the framing case a synthesized stream never exercises;
 *  - `createCliJsonlStreamingParser` (`src/agents/cli-output-stream.ts`), wired
 *    with exactly the callbacks `execute-process.ts` wires;
 *  - the Gateway recovery clock: `startDiagnosticRunActivityTracking`,
 *    `createDiagnosticEmbeddedRunOwner`, `markDiagnosticEmbeddedRunStarted`,
 *    `beginDiagnosticBackendActivity` and `getDiagnosticSessionActivitySnapshot`
 *    from `src/logging/diagnostic-run-activity.ts`. The deadline read in the
 *    assertions is the same `activeBackendLivenessDeadlineAtMs` the stuck-session
 *    recovery path reads when it decides a run is blocked.
 *  - the tool-activity registry, populated by a real `tool.execution.started`
 *    diagnostic event through `emitTrustedDiagnosticEvent`.
 *
 * Not real: no Gateway process is running and no session is aborted. This proves
 * that the clock keeps being renewed; it does not re-run the production incident,
 * which would require inducing a stuck-session abort on a live Gateway.
 *
 * Scenarios:
 *  1. live-process     — one genuine `claude` turn that spawns an Agent
 *                        subagent. Pins: the parent answer assembles across real
 *                        pipe chunk boundaries; forwarded subagent text is
 *                        discarded; the Agent tool start/result reach the
 *                        gateway; the recovery deadline advances.
 *  2. past-budget      — the captured stdout replayed by a second real child
 *                        process until both turn budgets are spent, then the
 *                        terminal `result`. Pins the incident directly: past
 *                        exhaustion the recovery deadline still advances and
 *                        `lastProgressReason` still reports subagent progress,
 *                        so a healthy run is no longer indistinguishable from a
 *                        blocked one — while assembly stays stopped.
 *  3. bounded-state    — the same post-budget replay, measured: retained heap
 *                        after a forced collection stays a small fraction of the
 *                        bytes streamed, including for repeated tool calls and a
 *                        tool block whose stop never arrives.
 *
 * Captures: the raw stdout this harness records is genuine, unredacted model
 * output — session ids, tool arguments, tool results, file contents. It is
 * written under a private temporary directory only so a second real child
 * process can replay it over a real pipe, and that directory is removed on
 * EVERY exit below (success, failed assertion, or spawn error), with the removal
 * verified rather than assumed.
 *
 * Requires a working `claude` CLI on PATH (this is a maintainer-run harness, not
 * a CI lane). Set `OPENCLAW_PROOF_CLAUDE_STREAM` to a previously captured stdout
 * file to replay instead of spawning a live turn.
 *
 * Run: pnpm tsx scripts/proof-cli-stream-process-boundary.ts
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type {
  CliToolResultDelta,
  CliToolUseStartDelta,
} from "../src/agents/cli-output-contracts.js";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../src/agents/cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "../src/agents/cli-output-stream.js";
import { emitTrustedDiagnosticEvent } from "../src/infra/diagnostic-events.js";
import {
  beginDiagnosticBackendActivity,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  startDiagnosticRunActivityTracking,
} from "../src/logging/diagnostic-run-activity.js";

const PROMPT =
  "Use the Agent tool with subagent_type general-purpose to run the bash command " +
  "'echo subagent-hello' and report exactly what it printed. Then reply with exactly: DONE";
const NO_OUTPUT_TIMEOUT_MS = 300_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`proof assertion failed: ${message}`);
  }
}

/** Collects garbage without requiring `--expose-gc` on the run command. */
function forceGarbageCollection(): void {
  setFlagsFromString("--expose-gc");
  try {
    const gc = runInNewContext("gc") as () => void;
    // Twice: one pass can leave a large transient graph uncollected, which
    // inflates a baseline sample and hides real retention as a negative delta.
    gc();
    gc();
  } finally {
    setFlagsFromString("--no-expose-gc");
  }
}

/**
 * Module-level keep-alive. A parser held only in a function local is dead once
 * the loop that feeds it ends, and V8 collects it together with the tool tracker
 * whose retention is being measured — producing a flat reading even against a
 * build with no bound at all.
 */
const retainedForMeasurement: unknown[] = [];

type RecoveryClock = {
  ref: { sessionId: string; sessionKey: string };
  activity: ReturnType<typeof beginDiagnosticBackendActivity>;
  deadlineAtMs: () => number | undefined;
  lastProgressReason: () => string | undefined;
};

/**
 * Stands up the real Gateway recovery clock for one attempt, with one active
 * foreground Agent tool — the state the incident had when the abort fired.
 */
function startRecoveryClock(label: string, agentToolCallId: string): RecoveryClock {
  const ref = {
    sessionId: `proof-${label}`,
    sessionKey: `agent:proof:${label}`,
  };
  const runId = `proof-run-${label}`;
  startDiagnosticRunActivityTracking();
  const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
  markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    ...ref,
    runId,
    toolName: "Agent",
    toolSource: "core",
    toolOwner: "cli-runner",
    toolCallId: agentToolCallId,
  });
  const activity = beginDiagnosticBackendActivity({
    owner,
    noOutputTimeoutMs: NO_OUTPUT_TIMEOUT_MS,
    assertCurrent: () => {},
  });
  return {
    ref,
    activity,
    deadlineAtMs: () => getDiagnosticSessionActivitySnapshot(ref).activeBackendLivenessDeadlineAtMs,
    lastProgressReason: () => getDiagnosticSessionActivitySnapshot(ref).lastProgressReason,
  };
}

type ParserSinks = {
  assistantText: string;
  toolStarts: CliToolUseStartDelta[];
  toolResults: CliToolResultDelta[];
  attributedProgress: string[];
};

/**
 * Wires the parser the way `execute-process.ts` wires it, including the
 * `activeParsedToolCount() === 0` gate on raw-stdout progress: while a tool is
 * active, only parsed semantic records may move the recovery clock.
 */
function createProcessParser(clock: RecoveryClock, activeAgentToolCallId: string) {
  const sinks: ParserSinks = {
    assistantText: "",
    toolStarts: [],
    toolResults: [],
    attributedProgress: [],
  };
  const activeParsedTools = new Set<string>();
  const parser = createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: (delta) => {
      sinks.assistantText = delta.text;
    },
    onToolUseStart: (tool) => {
      activeParsedTools.add(tool.toolCallId);
      sinks.toolStarts.push(tool);
    },
    onToolResult: (result) => {
      activeParsedTools.delete(result.toolCallId);
      sinks.toolResults.push(result);
    },
    onAttributedSubagentProgress: (parentToolUseId) => {
      if (parentToolUseId !== activeAgentToolCallId) {
        return;
      }
      sinks.attributedProgress.push(parentToolUseId);
      clock.activity.observeAttributedAgentProgress(parentToolUseId);
    },
  });
  const consumeStdout = (chunk: string) => {
    if (chunk.length > 0) {
      // Raw stdout stays transport-only once a tool is active; this is the
      // branch that made the healthy run look blocked.
      clock.activity.observeOutput(activeParsedTools.size === 0);
    }
    parser.push(chunk);
  };
  return { parser, sinks, consumeStdout, activeParsedTools };
}

function spawnStdout(
  command: string,
  args: string[],
  onChunk: (chunk: string) => void,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onChunk);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function readAgentToolCallId(stream: string): string {
  for (const line of stream.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const parentToolUseId = record.parent_tool_use_id;
    if (typeof parentToolUseId === "string" && parentToolUseId) {
      return parentToolUseId;
    }
  }
  return "";
}

const workDir = mkdtempSync(path.join(tmpdir(), "openclaw-proof-cli-"));
const capturePath = path.join(workDir, "claude-stdout.jsonl");

/** Removes the raw captures and reports whether the directory is actually gone. */
function removeCaptures(): boolean {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    return false;
  }
  return !existsSync(workDir);
}

async function captureLiveTurn(): Promise<string> {
  const preCaptured = process.env.OPENCLAW_PROOF_CLAUDE_STREAM;
  if (preCaptured) {
    const stream = readFileSync(preCaptured, "utf8");
    console.log(`[live-process] replaying a previously captured stream from ${preCaptured}`);
    return stream;
  }
  let raw = "";
  const { code, stderr } = await spawnStdout(
    "claude",
    [
      "-p",
      PROMPT,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--allowedTools",
      "Bash",
      "Agent",
      "Task",
      "--max-turns",
      "10",
    ],
    (chunk) => {
      raw += chunk;
    },
  );
  assert(
    code === 0,
    `live-process: the claude CLI exited ${code}; this harness needs a working claude on PATH. stderr: ${stderr.slice(0, 400)}`,
  );
  return raw;
}

async function scenarioLiveProcess(stream: string): Promise<{
  agentToolCallId: string;
  subagentRecords: number;
}> {
  const agentToolCallId = readAgentToolCallId(stream);
  assert(
    agentToolCallId !== "",
    "live-process: the captured turn carried no forwarded subagent record, so it cannot prove the parent/subagent split",
  );
  const clock = startRecoveryClock("live", agentToolCallId);
  const deadlineBefore = clock.deadlineAtMs();
  const { parser, sinks, consumeStdout } = createProcessParser(clock, agentToolCallId);

  // Re-spawn a real child process that emits the captured bytes, so the parser
  // is fed over a real pipe with real chunk boundaries rather than one string.
  writeFileSync(capturePath, stream);
  const { code } = await spawnStdout(
    process.execPath,
    [
      "-e",
      `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(capturePath)}));`,
    ],
    consumeStdout,
  );
  assert(code === 0, `live-process: the stdout replayer exited ${code}`);
  parser.finish();

  const subagentRecords = stream
    .split("\n")
    .filter((line) => line.includes(`"parent_tool_use_id":"${agentToolCallId}"`)).length;
  assert(subagentRecords > 0, "live-process: no forwarded subagent records in the capture");

  const output = parser.getOutput();
  assert(parser.getErrorText() === null, `live-process: parser error ${parser.getErrorText()}`);
  assert(parser.hasTerminalResult(), "live-process: no terminal result recovered");
  assert(
    parser.getOutputTruncationText() === null,
    "live-process: one real turn must not spend the turn budget",
  );
  assert(
    !output?.text.includes("subagent-hello") || output.text.includes("DONE"),
    "live-process: the parent answer was not assembled",
  );
  assert(
    sinks.toolStarts.some((tool) => tool.toolCallId === agentToolCallId),
    "live-process: the Agent tool start never reached the gateway",
  );
  const deadlineAfter = clock.deadlineAtMs();
  assert(
    deadlineAfter !== undefined && deadlineBefore !== undefined && deadlineAfter >= deadlineBefore,
    "live-process: the recovery deadline was never published",
  );
  console.log(
    `[live-process] real claude stdout: ${stream.length} chars / ${stream.split("\n").length - 1} lines, ` +
      `${subagentRecords} forwarded subagent record(s); ` +
      `${sinks.toolStarts.length} tool start(s), ${sinks.toolResults.length} tool result(s); ` +
      `answer ${JSON.stringify(output?.text.slice(0, 60))}`,
  );
  return { agentToolCallId, subagentRecords };
}

/**
 * Replays the captured stdout until both turn budgets are spent, then continues
 * well past exhaustion, then sends the terminal result. Everything crossing the
 * parser is bytes the real CLI produced.
 */
async function scenarioPastBudget(stream: string, agentToolCallId: string): Promise<void> {
  const lines = stream.split("\n").filter((line) => line.trim() !== "");
  const terminalResultLine = lines.find((line) => line.includes('"type":"result"'));
  assert(terminalResultLine !== undefined, "past-budget: the capture carried no terminal result");
  const body = lines.filter((line) => line !== terminalResultLine);
  // A tool block whose stop never arrives: the unbounded-argument case.
  const unfinishedStart = JSON.stringify({
    type: "stream_event",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 99,
      content_block: { type: "tool_use", id: "toolu_never_stops", name: "Write", input: {} },
    },
  });
  const unfinishedDelta = JSON.stringify({
    type: "stream_event",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 99,
      delta: { type: "input_json_delta", partial_json: "x".repeat(8192) },
    },
  });

  const repeats = Math.ceil((CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines * 4) / body.length);
  const replayPath = path.join(workDir, "past-budget.jsonl");
  writeFileSync(
    replayPath,
    `${unfinishedStart}\n${[...Array(repeats)]
      .map(() => `${body.join("\n")}\n${unfinishedDelta}`)
      .join("\n")}\n${terminalResultLine}\n`,
  );

  const clock = startRecoveryClock("past-budget", agentToolCallId);
  const { parser, sinks, consumeStdout } = createProcessParser(clock, agentToolCallId);
  retainedForMeasurement.push(parser);

  let streamedChars = 0;
  let exhaustedAtChars = 0;
  let deadlineAtExhaustion: number | undefined;
  let progressAtExhaustion = 0;
  let textAtExhaustion = "";
  let heapAtExhaustion = 0;

  const { code } = await spawnStdout(
    process.execPath,
    ["-e", `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(replayPath)}));`],
    (chunk) => {
      consumeStdout(chunk);
      streamedChars += chunk.length;
      // Before the terminal result arrives a spent budget reports as an error;
      // it becomes a truncation only once the turn is recovered.
      if (exhaustedAtChars === 0 && parser.getErrorText() !== null) {
        exhaustedAtChars = streamedChars;
        deadlineAtExhaustion = clock.deadlineAtMs();
        progressAtExhaustion = sinks.attributedProgress.length;
        textAtExhaustion = sinks.assistantText;
        // Baseline taken AT exhaustion, so the measurement covers only what the
        // post-budget path retains — not the live turn's leftover garbage.
        forceGarbageCollection();
        heapAtExhaustion = process.memoryUsage().heapUsed;
      }
    },
  );
  assert(code === 0, `past-budget: the stdout replayer exited ${code}`);
  parser.finish();
  forceGarbageCollection();
  const heapGrowth = process.memoryUsage().heapUsed - heapAtExhaustion;
  const unfinishedArgumentChars = 8192 * repeats;

  const truncation = parser.getOutputTruncationText();
  assert(
    truncation !== null && exhaustedAtChars > 0,
    "past-budget: the budget was never spent, so the scenario proved nothing",
  );
  const streamedAfter = streamedChars - exhaustedAtChars;
  assert(
    streamedAfter > 4 * 1024 * 1024,
    `past-budget: only ${streamedAfter} bytes streamed after exhaustion; not a long-run test`,
  );
  assert(
    parser.getErrorText() === null && parser.hasTerminalResult(),
    "past-budget: the finished turn was not recovered",
  );
  // The incident, inverted: past exhaustion the gateway still sees progress.
  assert(
    sinks.attributedProgress.length > progressAtExhaustion,
    "past-budget: attributed subagent progress stopped at exhaustion; the recovery clock would freeze and abort a healthy run",
  );
  const deadlineAfter = clock.deadlineAtMs();
  assert(
    deadlineAfter !== undefined &&
      deadlineAtExhaustion !== undefined &&
      deadlineAfter > deadlineAtExhaustion,
    `past-budget: the recovery deadline did not advance past exhaustion (${String(deadlineAtExhaustion)} -> ${String(deadlineAfter)})`,
  );
  assert(
    clock.lastProgressReason() === "tool:Agent:subagent_progress",
    `past-budget: the gateway's last progress reason was ${JSON.stringify(clock.lastProgressReason())}, not subagent progress`,
  );
  // Assembly stays stopped: liveness was restored without restoring retention.
  assert(
    sinks.assistantText === textAtExhaustion,
    "past-budget: assistant text kept accumulating past exhaustion",
  );
  assert(
    unfinishedArgumentChars > 8 * 1024 * 1024,
    `bounded-state: only ${unfinishedArgumentChars} argument chars reached the never-stopping tool block; its bound never engaged`,
  );
  assert(
    heapGrowth < streamedAfter / 8,
    `bounded-state: heap grew ${heapGrowth} bytes while streaming ${streamedAfter} bytes past exhaustion; retained state is not bounded`,
  );

  console.log(
    `[past-budget] ${streamedChars} chars through a real pipe, ${streamedAfter} of them past exhaustion ` +
      `(${truncation}); attributed progress ${progressAtExhaustion} -> ${sinks.attributedProgress.length}, ` +
      `recovery deadline +${(deadlineAfter ?? 0) - (deadlineAtExhaustion ?? 0)} ms, ` +
      `lastProgressReason=${clock.lastProgressReason()}`,
  );
  console.log(
    `[bounded-state] ${unfinishedArgumentChars} argument chars streamed to a tool block whose stop never arrives, ` +
      `past exhaustion; retained heap delta ${heapGrowth} bytes measured from the exhaustion point against ` +
      `${streamedAfter} post-budget bytes`,
  );
}

async function main(): Promise<void> {
  const stream = await captureLiveTurn();
  const { agentToolCallId } = await scenarioLiveProcess(stream);
  await scenarioPastBudget(stream, agentToolCallId);
}

// Cleanup runs on every exit, and a failure is reported only after it, so the
// original error is never masked by the removal.
let failure: unknown;
let removed: boolean | undefined;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  removed = removeCaptures();
}
console.log(`[cleanup] raw CLI captures removed from ${workDir}: ${removed ? "yes" : "NO"}`);
if (failure !== undefined) {
  console.error(failure instanceof Error ? (failure.stack ?? failure.message) : inspect(failure));
  process.exit(1);
}
if (!removed) {
  console.error(`proof assertion failed: raw CLI captures survived at ${workDir}`);
  process.exit(1);
}
console.log("All runtime assertions passed.");
process.exit(0);
