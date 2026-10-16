#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";

// Fixed categories only: unknown or future labels cannot disclose user content.
const operations = new Set(
  `direct worker ordered-read doctor-telegram-general-topic
session-entry-target.patch session-entry.patch
session-migration.legacy-main-copy session-migration.legacy-main-in-place session-migration.legacy-main-quarantine
session.agent-purge.commit session.agent-purge.prepare
session.archive.publish-commit session.archive.publish-prepare session.archive.retention-commit session.archive.retention-prepare
session.canonical-repair.generations session.canonical-validation.certify session.canonical-validation.prepare
session.checkpoint.branch session.checkpoint.restore session.entry-replacements session.entry.create-with-transcript
session.goal.mutate session.history.archive-prune session.history.eviction-prepare session.history.free-pages session.history.reclamation-plan
session.import.batch session.lifecycle session.lifecycle.archive-plan session.lifecycle.artifacts-prepare session.lifecycle.delete-prepare
session.lifecycle.mutate session.lifecycle.reclamation-plan session.lifecycle.reset
session.maintenance.finalize session.maintenance.plan session.message-cut.mutate session.parent.fork-entry session.parent.fork-transcript
session.pending-input.stage session.reclamation.in-process session.reclamation.prepare session.reclamation.retain session.reclamation.worker-commit
session.restart.recover session.transcript.batch session.transcript.branch session.transcript.compact session.transcript.event-append
session.transcript.locked-write session.transcript.message-append session.transcript.message-rewrite session.transcript.replace
session.transcript.report session.transcript.rewrite-exact session.transcript.turn
sessions.transcript-index.active-chunk sessions.transcript-index.claim sessions.transcript-index.delete-chunk
sessions.transcript-index.finalize sessions.transcript-index.fts-chunk sessions.transcript-index.orphan-sweep sessions.transcript-index.preflight`.split(
    /\s+/,
  ),
);
const transactionOperations = new Set([
  "session.actor.read",
  "session.actor.acceptInput",
  "session.actor.adoptRun",
  "session.actor.appendToolResult",
  "session.actor.appendTranscriptEvent",
  "session.actor.completeTurn",
  "session.actor.deliveryPending",
  "session.actor.deliverySettled",
  "session.actor.patch",
]);
const phaseNames = ["prepareMs", "beginMs", "hostAdmissionWaitMs", "sqlMs", "commitMs"] as const;
const messages = new Set([
  "slow agent database reservation",
  "slow SQLite session write",
  "SQLite session write failed",
]);
const limitations = [
  "Slow/error warnings only; reservation sums are censored observations, not total occupancy or utilization.",
  "Intervals use log emission time as a completion proxy, minus completionDelayMs; logging delay and rounding remain uncertain.",
  "Wait overlap is a lower bound from observed intervals within each process/thread, across unidentified databases; it is not queue depth or causal holder attribution.",
  "Native transaction phases are separate observations, never added to reservation time or causally correlated; sqlMs is residual elapsed time, not measured SQL CPU. Transaction bounds select emission time, and phases may overlap.",
  "Reentrant records and lifecycle queue warnings are excluded. Input must contain one copy of each event from one host.",
];

type Reservation = {
  operation: string;
  scope: string;
  queued: number;
  start: number;
  end: number;
};

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function duration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseReservation(value: unknown): Reservation | undefined {
  if (!isRecord(value) || !messages.has(String(value["2"]))) {
    return undefined;
  }
  const fields = value["1"];
  const meta = value._meta;
  if (!isRecord(fields) || !isRecord(meta) || meta.logLevelName !== "WARN") {
    return undefined;
  }
  const time = timestamp(value.time);
  const { elapsedMs, queueWaitMs, writerExecutionMs, completionDelayMs } = fields;
  if (
    fields.reentrant !== false ||
    !Number.isFinite(time) ||
    !duration(elapsedMs) ||
    !duration(queueWaitMs) ||
    !duration(writerExecutionMs) ||
    !duration(completionDelayMs) ||
    Math.abs(elapsedMs - queueWaitMs - writerExecutionMs - completionDelayMs) > 3 ||
    typeof fields.pid !== "number" ||
    !Number.isSafeInteger(fields.pid) ||
    typeof fields.threadId !== "number" ||
    !Number.isSafeInteger(fields.threadId)
  ) {
    return undefined;
  }
  const end = time - completionDelayMs;
  const start = end - writerExecutionMs;
  const queued = start - queueWaitMs;
  if (!Number.isFinite(queued) || !Number.isFinite(new Date(queued).getTime())) {
    return undefined;
  }
  const operation = typeof fields.operation === "string" ? fields.operation : "other";
  return {
    operation: operations.has(operation) ? operation : "other",
    scope: `${fields.pid}:${fields.threadId}`,
    queued,
    start,
    end,
  };
}

function parseTransaction(value: unknown) {
  if (!isRecord(value) || value["2"] !== "slow SQLite transaction hold") {
    return undefined;
  }
  const fields = value["1"];
  const meta = value._meta;
  const time = timestamp(value.time);
  if (
    !isRecord(fields) ||
    !isRecord(meta) ||
    meta.logLevelName !== "WARN" ||
    !Number.isFinite(time) ||
    !duration(fields.elapsedMs) ||
    !isRecord(fields.phases)
  ) {
    return undefined;
  }
  const phases: Partial<Record<(typeof phaseNames)[number], number>> = {};
  for (const key of phaseNames) {
    const amount = fields.phases[key];
    if (amount !== undefined) {
      if (!duration(amount)) {
        return undefined;
      }
      phases[key] = amount;
    }
  }
  const operation = typeof fields.operation === "string" ? fields.operation : "other";
  return {
    time,
    operation: transactionOperations.has(operation) ? operation : "other",
    elapsedMs: fields.elapsedMs,
    phases,
  };
}

/** Streams log input and retains only the numeric/category reservation observations. */
export async function attributeWriterOccupancy(
  lines: AsyncIterable<string> | Iterable<string>,
  bounds: { from?: string; until?: string } = {},
) {
  const from = bounds.from === undefined ? -Infinity : timestamp(bounds.from);
  const until = bounds.until === undefined ? Infinity : timestamp(bounds.until);
  if (Number.isNaN(from) || Number.isNaN(until) || from >= until) {
    throw new Error("Provide an increasing --from/--until range with explicit UTC offsets");
  }
  const reservations: Reservation[] = [];
  const transactions = new Map<
    string,
    {
      count: number;
      elapsedMs: number;
      maxElapsedMs: number;
      phases: Partial<Record<(typeof phaseNames)[number], number>>;
    }
  >();
  let ignoredLines = 0;
  for await (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      ignoredLines++;
      continue;
    }
    const transaction = parseTransaction(value);
    if (transaction) {
      if (transaction.time >= from && transaction.time < until) {
        const total = transactions.get(transaction.operation) ?? {
          count: 0,
          elapsedMs: 0,
          maxElapsedMs: 0,
          phases: {},
        };
        total.count++;
        total.elapsedMs += transaction.elapsedMs;
        total.maxElapsedMs = Math.max(total.maxElapsedMs, transaction.elapsedMs);
        for (const key of phaseNames) {
          const amount = transaction.phases[key];
          if (amount !== undefined) {
            total.phases[key] = (total.phases[key] ?? 0) + amount;
          }
        }
        transactions.set(transaction.operation, total);
      }
      continue;
    }
    const reservation = parseReservation(value);
    if (!reservation) {
      ignoredLines++;
    } else if (reservation.end > from && reservation.queued < until) {
      reservations.push({
        ...reservation,
        queued: Math.max(from, reservation.queued),
        start: Math.min(until, Math.max(from, reservation.start)),
        end: Math.min(until, reservation.end),
      });
    }
  }
  const minuteRows = new Map<
    number,
    {
      operations: Map<string, { reservationMs: number; queueWaitMs: number }>;
      waits: Map<string, Array<[number, number]>>;
    }
  >();
  const totals = new Map<
    string,
    { count: number; reservationMs: number; queueWaitMs: number; maxReservationMs: number }
  >();
  for (const item of reservations) {
    const total = totals.get(item.operation) ?? {
      count: 0,
      reservationMs: 0,
      queueWaitMs: 0,
      maxReservationMs: 0,
    };
    total.count++;
    total.maxReservationMs = Math.max(total.maxReservationMs, item.end - item.start);
    for (
      let minute = Math.floor(item.queued / 60_000) * 60_000;
      minute < item.end;
      minute += 60_000
    ) {
      const low = minute;
      const high = minute + 60_000;
      const reservationMs = Math.max(0, Math.min(high, item.end) - Math.max(low, item.start));
      const waitStart = Math.max(low, item.queued);
      const waitEnd = Math.min(high, item.start);
      const queueWaitMs = Math.max(0, waitEnd - waitStart);
      const row = minuteRows.get(minute) ?? { operations: new Map(), waits: new Map() };
      const operation = row.operations.get(item.operation) ?? { reservationMs: 0, queueWaitMs: 0 };
      operation.reservationMs += reservationMs;
      operation.queueWaitMs += queueWaitMs;
      total.reservationMs += reservationMs;
      total.queueWaitMs += queueWaitMs;
      row.operations.set(item.operation, operation);
      if (queueWaitMs > 0) {
        const events = row.waits.get(item.scope) ?? [];
        events.push([waitStart, 1], [waitEnd, -1]);
        row.waits.set(item.scope, events);
      }
      minuteRows.set(minute, row);
    }
    totals.set(item.operation, total);
  }
  return {
    limitations,
    ignoredLines,
    observedReservations: reservations.length,
    nativeTransactions: [...transactions]
      .map(([operation, values]) => Object.assign({ operation }, values))
      .toSorted((a, b) => b.elapsedMs - a.elapsedMs),
    operations: [...totals]
      .map(([operation, values]) => Object.assign({ operation }, values))
      .toSorted((a, b) => b.reservationMs - a.reservationMs),
    minutes: [...minuteRows]
      .toSorted(([a], [b]) => a - b)
      .map(([minute, row]) => {
        let maxObservedWaitOverlap = 0;
        for (const events of row.waits.values()) {
          let active = 0;
          for (const [, delta] of events.toSorted(([a, x], [b, y]) => a - b || x - y)) {
            active += delta;
            maxObservedWaitOverlap = Math.max(maxObservedWaitOverlap, active);
          }
        }
        return {
          minute: new Date(minute).toISOString(),
          maxObservedWaitOverlap,
          operations: [...row.operations]
            .map(([operation, values]) => Object.assign({ operation }, values))
            .toSorted((a, b) => b.reservationMs - a.reservationMs),
        };
      }),
    topReservations: reservations
      .toSorted((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, 20)
      .map((item) => ({
        estimatedEnd: new Date(item.end).toISOString(),
        operation: item.operation,
        reservationMs: item.end - item.start,
        queueWaitMs: item.start - item.queued,
      })),
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean" },
      from: { type: "string" },
      until: { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/diagnostic-writer-occupancy.mts [--json] [--from ISO] [--until ISO] [log.jsonl|-]\nRange clips reconstructed intervals; timestamps require explicit UTC offsets. Default input is stdin.",
    );
    return;
  }
  if (positionals.length > 1) {
    throw new Error("Provide one JSONL file or stdin");
  }
  const input =
    positionals[0] && positionals[0] !== "-" ? createReadStream(positionals[0]) : process.stdin;
  const lines = createInterface({ input, crlfDelay: Infinity });
  const report = await attributeWriterOccupancy(lines, values);
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(report.limitations.join("\n"));
  console.log(
    "minute UTC\toperation\treservation ms\twait ms\tmax observed wait overlap (process/thread)",
  );
  for (const minute of report.minutes) {
    for (const row of minute.operations) {
      console.log(
        `${minute.minute}\t${row.operation}\t${row.reservationMs}\t${row.queueWaitMs}\t${minute.maxObservedWaitOverlap}`,
      );
    }
  }
  console.log("Top observed reservations:");
  console.table(report.topReservations);
  console.log("Separate native transaction observations (phases may overlap):");
  console.table(report.nativeTransactions.map(({ phases, ...row }) => Object.assign(row, phases)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      "Writer occupancy report failed: check input readability, JSONL format and timestamp options (--help).",
    );
    process.exitCode = 1;
  });
}
