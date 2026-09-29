/**
 * Sustained-cost measurement for the Claude stream-json post-budget path.
 *
 * Why this exists: recovering a turn whose cumulative budget is spent means the
 * parser keeps reading. Before the change, exhausting the budget latched an
 * error and every later line was dropped at the top of `handleJsonlLine` after
 * only newline framing. After the change, every later line is decoded so the
 * terminal result and the liveness events the gateway's stall detector reads can
 * still be recovered. That is a real, deliberate cost on the hottest path a
 * long CLI turn has, and `src/agents/AGENTS.md` requires performance edits to be
 * benchmarked before and after. This harness is that benchmark: wall-clock
 * seconds and RSS for a sustained post-budget stream.
 *
 * Real: `createCliJsonlStreamingParser` from `src/agents/cli-output-stream.ts`,
 * driven exactly as `src/agents/cli-runner/execute-process.ts` drives it — raw
 * stdout chunks through `push()`. Nothing in the parser, its framing, its budget
 * accounting or its record decoding is stubbed.
 *
 * Stubbed: only the process edge. No `claude` subprocess is spawned; the frames
 * are the stream-json shapes the CLI emits under `--include-partial-messages`.
 *
 * Deliberately imports ONLY parser surface that exists on both the pre-change
 * and post-change trees, so the identical file is the measuring instrument on
 * both and the delta is attributable to the production code rather than to the
 * harness. It therefore does NOT attach the runner's event consumers; the
 * decode loop under measurement lives in the parser.
 *
 * Method, and why each step is here:
 *  - A full-size warm-up round runs first and is discarded. JIT tiering and the
 *    one-time module graph otherwise land inside the first measured window and
 *    dominate it (an earlier scenario on this PR measured ~200 MB of one-time
 *    plugin-metadata module load and read it as retention).
 *  - Each round exhausts the budget OUTSIDE the measured window, so the sample
 *    covers post-budget lines only.
 *  - RSS is sampled synchronously inside the streaming loop, because the loop
 *    blocks the event loop and no timer-based sampler can run during it.
 *  - Three measured rounds at each of three volumes. Post-budget output is
 *    unbounded by construction, so a single volume cannot answer the
 *    availability question: the table reports seconds per MiB at 16, 64 and 256
 *    MiB and the assertion pins that it stays flat. Linear cost is survivable at
 *    any volume; superlinear cost is the hang the reviewer is asking about.
 *
 * Run: pnpm tsx scripts/proof-cli-stream-post-budget-cost.ts
 */
// MUST stay first: it isolates the state directory before `src/config/paths.ts`
// resolves it. See `scripts/proof-isolated-state.ts`.
import "./proof-isolated-state.js";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../src/agents/cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "../src/agents/cli-output-stream.js";

const SESSION_ID = "proof-post-budget-cost";
/**
 * Post-budget volumes per measured round, ascending. The largest is far past
 * anything a turn plausibly emits; it is there to make superlinear cost visible.
 */
const SUSTAINED_VOLUMES_BYTES = [16 * 1024 * 1024, 64 * 1024 * 1024, 256 * 1024 * 1024];
/** The volume the headline numbers quote. */
const HEADLINE_BYTES = 64 * 1024 * 1024;
const ROUNDS_PER_VOLUME = 3;
const RSS_SAMPLE_EVERY_ITERATIONS = 64;
/**
 * Regression ceilings. Generous on purpose: these guard against the decode loop
 * becoming pathological, not against one host's throughput drifting.
 */
const MAX_SECONDS_PER_MIB = 0.25;
const MAX_RSS_GROWTH_RATIO = 0.25;
/**
 * Cost must stay flat across a 16x volume range. 2.0 leaves room for cache
 * effects while still failing any superlinear term, which at 16x would show as a
 * ratio near 4 (quadratic) rather than near 1.
 */
const MAX_COST_SCALING_RATIO = 2;

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
    // inflates a baseline sample and then hides real growth as a negative delta.
    gc();
    gc();
  } finally {
    setFlagsFromString("--no-expose-gc");
  }
}

/**
 * Module-level keep-alive. A parser held only in a function local is dead once
 * the loop feeding it ends, so V8 may collect it mid-round and the RSS sample
 * would describe a parser that no longer exists.
 */
const retainedForMeasurement: unknown[] = [];

function textDeltaFrame(text: string): string {
  return JSON.stringify({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
  });
}

function toolUseFrame(index: number, inputChars: number): string {
  return JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      id: `msg_post_budget_${index}`,
      content: [
        {
          type: "tool_use",
          id: `toolu_post_budget_${index}`,
          name: "Bash",
          input: { command: `rg -n "pattern-${index}"`, description: "d".repeat(inputChars) },
        },
      ],
    },
  });
}

function toolResultFrame(index: number, payloadChars: number): string {
  return JSON.stringify({
    type: "user",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: `toolu_post_budget_${index}`,
          content: [{ type: "text", text: "r".repeat(payloadChars) }],
        },
      ],
    },
  });
}

type Sinks = {
  assistantDeltas: number;
  toolStarts: number;
  toolResults: number;
};

function createCountingParser(sinks: Sinks) {
  // Counted, never retained: holding the delivered payloads would measure this
  // harness's own arrays instead of the parser.
  return createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {
      sinks.assistantDeltas += 1;
    },
    onToolUseStart: () => {
      sinks.toolStarts += 1;
    },
    onToolResult: () => {
      sinks.toolResults += 1;
    },
  });
}

type Parser = ReturnType<typeof createCountingParser>;

/** Spends the cumulative character budget with realistic frames, outside any measured window. */
function exhaustBudget(parser: Parser): void {
  let streamed = 0;
  for (let index = 0; streamed <= CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars; index += 1) {
    const chunk = `${textDeltaFrame(`step ${index} `)}\n${toolResultFrame(index, 96_000)}\n`;
    streamed += chunk.length;
    parser.push(chunk);
  }
}

type RoundSample = {
  label: string;
  targetBytes: number;
  streamedBytes: number;
  lines: number;
  seconds: number;
  rssBeforeBytes: number;
  rssPeakBytes: number;
  rssAfterBytes: number;
  heapAfterDeltaBytes: number;
  postBudgetAssistantDeltas: number;
  postBudgetToolStarts: number;
  postBudgetToolResults: number;
};

/**
 * One round: build a parser, spend its budget, then stream `targetBytes` of
 * post-budget traffic with the clock and the RSS sampler running.
 */
function measureRound(label: string, targetBytes: number): RoundSample {
  const sinks: Sinks = { assistantDeltas: 0, toolStarts: 0, toolResults: 0 };
  const parser = createCountingParser(sinks);
  retainedForMeasurement.push(parser);
  exhaustBudget(parser);
  const atBudget = { ...sinks };

  forceGarbageCollection();
  const rssBefore = process.memoryUsage.rss();
  const heapBefore = process.memoryUsage().heapUsed;
  let rssPeak = rssBefore;

  let streamedBytes = 0;
  let lines = 0;
  const startedAt = process.hrtime.bigint();
  for (let index = 0; streamedBytes < targetBytes; index += 1) {
    // The mix a long turn actually emits past exhaustion: partial text, a tool
    // call the tracker has never seen, and its result.
    const chunk =
      `${textDeltaFrame(`late ${index} `)}\n` +
      `${toolUseFrame(index, 512)}\n` +
      `${toolResultFrame(index, 8_192)}\n`;
    streamedBytes += chunk.length;
    lines += 3;
    parser.push(chunk);
    if (index % RSS_SAMPLE_EVERY_ITERATIONS === 0) {
      // Sampled in-loop: the loop blocks the event loop, so a timer-based
      // sampler cannot observe the peak it is meant to catch.
      const rss = process.memoryUsage.rss();
      if (rss > rssPeak) {
        rssPeak = rss;
      }
    }
  }
  const elapsedNs = process.hrtime.bigint() - startedAt;

  const rssAfterStream = process.memoryUsage.rss();
  if (rssAfterStream > rssPeak) {
    rssPeak = rssAfterStream;
  }
  forceGarbageCollection();
  const rssAfter = process.memoryUsage.rss();
  const heapAfterDelta = process.memoryUsage().heapUsed - heapBefore;

  return {
    label,
    targetBytes,
    streamedBytes,
    lines,
    seconds: Number(elapsedNs) / 1e9,
    rssBeforeBytes: rssBefore,
    rssPeakBytes: rssPeak,
    rssAfterBytes: rssAfter,
    heapAfterDeltaBytes: heapAfterDelta,
    postBudgetAssistantDeltas: sinks.assistantDeltas - atBudget.assistantDeltas,
    postBudgetToolStarts: sinks.toolStarts - atBudget.toolStarts,
    postBudgetToolResults: sinks.toolResults - atBudget.toolResults,
  };
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * Heartbeat from a worker, never a main-thread timer: the streaming loop is
 * synchronous, so a `setInterval` on this thread cannot fire while it runs and
 * a watchdog would read a working process as hung.
 */
function startHeartbeat(): Worker {
  return new Worker(
    `const { parentPort } = require('node:worker_threads');
     const startedAt = Date.now();
     setInterval(() => {
       process.stdout.write('[post-budget-cost] still streaming, ' +
         Math.round((Date.now() - startedAt) / 1000) + 's elapsed\\n');
     }, 15_000).unref();
     setInterval(() => {}, 1 << 30);`,
    { eval: true },
  );
}

type VolumeSummary = {
  targetBytes: number;
  medianSeconds: number;
  medianSecondsPerMib: number;
  medianRssGrowthBytes: number;
};

function main(): void {
  const heartbeat = startHeartbeat();
  try {
    // Discarded: JIT tiering and the one-time module graph would otherwise land
    // inside the first measured window and dominate it.
    const warmup = measureRound("warm-up (discarded)", HEADLINE_BYTES);
    console.log(
      `[post-budget-cost] warm-up discarded: ${mib(warmup.streamedBytes)} MiB in ${warmup.seconds.toFixed(3)}s`,
    );
    console.log(
      `[post-budget-cost] ${SUSTAINED_VOLUMES_BYTES.map(mib).join("/")} MiB of post-budget stream-json, ` +
        `${ROUNDS_PER_VOLUME} rounds each; the ${CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars}-char turn budget ` +
        "is spent before the clock starts, so every sample is post-budget work only",
    );
    console.log(
      "volume_MiB\tround\tseconds\ts/MiB\tMiB/s\trss_before_MiB\trss_peak_MiB\trss_after_MiB\trss_growth_MiB\tlines\tdeltas\ttool_starts\ttool_results",
    );

    const rounds: RoundSample[] = [];
    const summaries: VolumeSummary[] = [];
    for (const targetBytes of SUSTAINED_VOLUMES_BYTES) {
      const volumeRounds: RoundSample[] = [];
      for (let round = 1; round <= ROUNDS_PER_VOLUME; round += 1) {
        const sample = measureRound(`round ${round}`, targetBytes);
        volumeRounds.push(sample);
        rounds.push(sample);
        const perMib = sample.seconds / (sample.streamedBytes / (1024 * 1024));
        console.log(
          [
            mib(sample.targetBytes),
            sample.label,
            sample.seconds.toFixed(3),
            perMib.toFixed(4),
            (1 / perMib).toFixed(1),
            mib(sample.rssBeforeBytes),
            mib(sample.rssPeakBytes),
            mib(sample.rssAfterBytes),
            mib(sample.rssPeakBytes - sample.rssBeforeBytes),
            String(sample.lines),
            String(sample.postBudgetAssistantDeltas),
            String(sample.postBudgetToolStarts),
            String(sample.postBudgetToolResults),
          ].join("\t"),
        );
      }
      const medianSeconds = median(volumeRounds.map((sample) => sample.seconds));
      summaries.push({
        targetBytes,
        medianSeconds,
        medianSecondsPerMib: medianSeconds / (targetBytes / (1024 * 1024)),
        medianRssGrowthBytes: median(
          volumeRounds.map((sample) => sample.rssPeakBytes - sample.rssBeforeBytes),
        ),
      });
    }

    for (const summary of summaries) {
      console.log(
        `[post-budget-cost] ${mib(summary.targetBytes)} MiB: median ${summary.medianSeconds.toFixed(3)}s ` +
          `(${summary.medianSecondsPerMib.toFixed(4)} s/MiB, ${(1 / summary.medianSecondsPerMib).toFixed(1)} MiB/s); ` +
          `median peak RSS growth ${mib(summary.medianRssGrowthBytes)} MiB`,
      );
    }

    const headline = summaries.find((summary) => summary.targetBytes === HEADLINE_BYTES);
    assert(headline, `no summary for the headline volume ${HEADLINE_BYTES}`);
    const costs = summaries.map((summary) => summary.medianSecondsPerMib);
    const scalingRatio = Math.max(...costs) / Math.min(...costs);
    console.log(
      `[post-budget-cost] cost per MiB across a ${Math.round(
        SUSTAINED_VOLUMES_BYTES[SUSTAINED_VOLUMES_BYTES.length - 1]! / SUSTAINED_VOLUMES_BYTES[0]!,
      )}x volume range: ${costs.map((cost) => cost.toFixed(4)).join(" -> ")} s/MiB ` +
        `(spread ${scalingRatio.toFixed(2)}x); heap delta after collection ` +
        `${rounds.map((sample) => sample.heapAfterDeltaBytes).join(", ")} bytes`,
    );

    // Assertions run AFTER the table so a tree that fails one still publishes
    // its numbers. On the pre-change tree the liveness assertion is expected to
    // fail: dropping post-budget lines is exactly what made the turn go dark.
    for (const sample of rounds) {
      assert(
        sample.streamedBytes >= sample.targetBytes,
        `${sample.label}: only ${sample.streamedBytes} of ${sample.targetBytes} post-budget bytes streamed; the measurement window never filled`,
      );
      assert(
        sample.seconds > 0,
        `${sample.label}: elapsed time measured as ${sample.seconds}s; the clock did not run`,
      );
    }
    assert(
      rounds.every((sample) => sample.postBudgetToolStarts > 0 && sample.postBudgetToolResults > 0),
      `post-budget lines produced no tool events (${rounds
        .map((sample) => `${sample.postBudgetToolStarts}/${sample.postBudgetToolResults}`)
        .join(
          ", ",
        )}); the decode path under measurement did not run, so these timings describe dropped lines`,
    );
    assert(
      rounds.every((sample) => sample.postBudgetAssistantDeltas === 0),
      `post-budget lines assembled assistant text (${rounds
        .map((sample) => sample.postBudgetAssistantDeltas)
        .join(", ")}); recovery must not re-open the answer the budget closed`,
    );
    assert(
      headline.medianSecondsPerMib < MAX_SECONDS_PER_MIB,
      `post-budget decoding cost ${headline.medianSecondsPerMib.toFixed(4)} s/MiB, over the ${MAX_SECONDS_PER_MIB} s/MiB ceiling`,
    );
    for (const summary of summaries) {
      assert(
        summary.medianRssGrowthBytes < summary.targetBytes * MAX_RSS_GROWTH_RATIO,
        `peak RSS grew ${summary.medianRssGrowthBytes} bytes while streaming ${summary.targetBytes} post-budget bytes, over the ${MAX_RSS_GROWTH_RATIO} ratio`,
      );
    }
    assert(
      scalingRatio < MAX_COST_SCALING_RATIO,
      `cost per MiB varied ${scalingRatio.toFixed(2)}x across the volume sweep (${costs
        .map((cost) => cost.toFixed(4))
        .join(", ")} s/MiB); post-budget decoding is not linear in output size`,
    );

    console.log("All runtime assertions passed.");
  } finally {
    void heartbeat.terminate();
  }
}

try {
  main();
  // Explicit: the heartbeat worker's teardown is asynchronous, and a proof that
  // relies on the event loop draining can hang instead of reporting.
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
