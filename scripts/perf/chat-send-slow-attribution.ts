/**
 * Rank slow chat.send detail timings without retaining or printing source log records.
 *
 * Usage: node scripts/perf/chat-send-slow-attribution.ts [--json] < gateway.log
 * Accepts plain console lines, JSON console envelopes and tslog JSONL records.
 * Counts are reports containing a span, not calls within that span. Timings are
 * inclusive and can overlap; their sums must not be added into a request total.
 * reply.admit_dispatch is an expected FIFO wait and is reported separately.
 * Only slow reports are sampled: this is attribution, not a latency distribution.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";

const STAGES = ["request", "startup", "steer", "queued"] as const;
type Stage = (typeof STAGES)[number];
type Timing = { span: string; sumMs: number; count: number; maxMs: number };
const FIFO_SPAN = "detail.reply.admit_dispatch";
const LIMITATIONS =
  "Inclusive spans overlap; do not add their sums. Counts are reports, not invocations. Slow reports only; not a latency distribution.";

function messageFromLine(line: string): string | undefined {
  const text = stripVTControlCharacters(line).trim();
  if (!text.startsWith("{")) {
    return text;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
    // tslog stores the subsystem and message in separate positional fields.
    for (const [key, item] of Object.entries(record)) {
      if (/^\d+$/.test(key) && typeof item === "string" && item.startsWith("slow chat send ")) {
        return item;
      }
    }
  } catch {
    // Never echo a malformed record: it may contain private data.
  }
  return undefined;
}

export async function attributeSlowChatSend(lines: Iterable<string> | AsyncIterable<string>) {
  const stages = new Map<Stage, { reports: number; details: Map<string, Timing> }>();
  let observedLines = 0;
  let ignoredLines = 0;
  for await (const line of lines) {
    const message = messageFromLine(line);
    const header = message?.match(
      /(?:^|\s)slow chat send \d+ms stage=(request|startup|steer|queued)(?=\s|$)/,
    );
    if (!header || !message) {
      ignoredLines++;
      continue;
    }
    observedLines++;
    const stage = header[1] as Stage;
    let group = stages.get(stage);
    if (!group) {
      group = { reports: 0, details: new Map() };
      stages.set(stage, group);
    }
    group.reports++;
    const suffix = message.slice((header.index ?? 0) + header[0].length);
    // Read only the diagnostic timing vocabulary, never arbitrary metadata values.
    for (const match of suffix.matchAll(
      /(?:^|\s)(detail\.[A-Za-z][A-Za-z0-9_.-]*)=(\d+(?:\.\d+)?)ms(?=\s|$)/g,
    )) {
      const span = match[1];
      const durationMs = Number(match[2]);
      if (!span || !Number.isFinite(durationMs)) {
        continue;
      }
      const timing = group.details.get(span);
      if (timing) {
        timing.sumMs += durationMs;
        timing.count++;
        timing.maxMs = Math.max(timing.maxMs, durationMs);
      } else {
        group.details.set(span, { span, sumMs: durationMs, count: 1, maxMs: durationMs });
      }
    }
  }
  return {
    limitations: LIMITATIONS,
    observedLines,
    ignoredLines,
    stages: STAGES.flatMap((stage) => {
      const group = stages.get(stage);
      if (!group) {
        return [];
      }
      const excludedFifo = group.details.get(FIFO_SPAN);
      group.details.delete(FIFO_SPAN);
      return [
        {
          stage,
          reports: group.reports,
          details: [...group.details.values()].toSorted(
            (a, b) => b.sumMs - a.sumMs || b.maxMs - a.maxMs || a.span.localeCompare(b.span),
          ),
          excludedFifo: excludedFifo ?? { span: FIFO_SPAN, sumMs: 0, count: 0, maxMs: 0 },
        },
      ];
    }),
  };
}

async function main() {
  const { values } = parseArgs({
    options: { json: { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help) {
    console.log("Usage: node scripts/perf/chat-send-slow-attribution.ts [--json] < gateway.log");
    return;
  }
  const report = await attributeSlowChatSend(
    createInterface({ input: process.stdin, crlfDelay: Infinity }),
  );
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(report.limitations);
  console.log(`Slow reports: ${report.observedLines}; ignored lines: ${report.ignoredLines}`);
  for (const group of report.stages) {
    console.log(`\nStage: ${group.stage} (${group.reports} reports)`);
    console.log("span\tsum ms\tcount\tmax ms");
    for (const row of group.details) {
      console.log(`${row.span}\t${row.sumMs}\t${row.count}\t${row.maxMs}`);
    }
    const wait = group.excludedFifo;
    console.log(
      `Excluded FIFO ${wait.span}: sum=${wait.sumMs}ms count=${wait.count} max=${wait.maxMs}ms`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Slow chat.send attribution failed; check stdin and options (--help).");
    process.exitCode = 1;
  });
}
