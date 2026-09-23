import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const MAX_BYTES = 1024 * 1024;
const MAX_SPANS = 64;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_TASKS = 64;
const MAX_OUTPUT_BYTES = 32 * 1024;
type HistoryRequest =
  | { status: "unknown" }
  | { status: "matched"; connection: number; request: number };
type HistoryWorkerTask = {
  ordinal: number;
  finishedMs: number;
  outcome: "ok" | "failed";
  queueMs: number;
  preparationMs: number;
  runMs: number;
  // postMessage cost is inside runMs, not a fourth additive phase.
  transferMs: number;
};
type HistoryPhase = "session_entry" | "history_page" | "startup_projection" | "session_info";
type HistorySpan = {
  ordinal: number;
  phase: HistoryPhase;
  // Relative timeline wall-clock times, not the proxy's monotonic request clock.
  startedMs: number | null;
  finishedMs: number | null;
  outcome: "pending" | "end" | "error";
  request?: HistoryRequest;
  workerTasks?: { rows: HistoryWorkerTask[]; invalid: boolean; truncated: boolean };
};
type NativeHistoryWindow = {
  startedAtMs: number;
  offset: number | null;
  identity: { dev: number; ino: number } | null;
};
type NativeHistoryDiagnostic = {
  readStatus:
    | "captured"
    | "missing"
    | "read-error"
    | "start-unavailable"
    | "changed-file"
    | "oversize"
    | "short-read";
  // The child buffers timeline writes. Even a complete file read cannot prove non-execution.
  writerMayBeBuffered: true;
  cutoff: "through-native-process-failure";
  truncated: boolean;
  incompleteLine: boolean;
  malformedLine: boolean;
  orphanedTerminal: boolean;
  orphanedWorkerTask: boolean;
  spans: HistorySpan[];
};

function privateKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function milliseconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function matchHistoryRequest(
  id: unknown,
  match: ((id: unknown) => unknown) | undefined,
): HistoryRequest {
  try {
    const result = privateKey(id) ? match?.(id) : undefined;
    if (
      isRecord(result) &&
      result.status === "matched" &&
      Number.isInteger(result.connection) &&
      Number(result.connection) >= 1 &&
      Number(result.connection) <= 4 &&
      Number.isInteger(result.request) &&
      Number(result.request) >= 1 &&
      Number(result.request) <= 32
    ) {
      return {
        status: "matched",
        connection: Number(result.connection),
        request: Number(result.request),
      };
    }
  } catch {
    /* Optional correlation cannot replace the native failure. */
  }
  return { status: "unknown" };
}

function boundProjection(result: NativeHistoryDiagnostic): NativeHistoryDiagnostic {
  // All fields are fixed or numeric and counts are already bounded. If their
  // combined encoding exceeds the public cap, retain phases and omit task rows.
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) {
    result.truncated = true;
    for (const span of result.spans) {
      if (span.workerTasks?.rows.length) {
        span.workerTasks.rows = [];
        span.workerTasks.truncated = true;
      }
    }
  }
  return result;
}

/** Excludes fixture setup bytes without probing or warming the Gateway. */
export async function captureNativeHistoryWindow(file: string): Promise<NativeHistoryWindow> {
  try {
    const stat = await fs.stat(file);
    return {
      startedAtMs: Date.now(),
      offset: stat.isFile() ? stat.size : null,
      identity: { dev: stat.dev, ino: stat.ino },
    };
  } catch (error) {
    return {
      startedAtMs: Date.now(),
      offset: isRecord(error) && error.code === "ENOENT" ? 0 : null,
      identity: null,
    };
  }
}

function historyPhase(name: unknown): HistoryPhase | undefined {
  switch (name) {
    case "gateway.chat.history.session_entry":
      return "session_entry";
    case "gateway.chat.history.history_page":
      return "history_page";
    case "gateway.chat.history.startup_projection":
      return "startup_projection";
    case "gateway.chat.history.session_info":
      return "session_info";
    default:
      return undefined;
  }
}

/** Reads only the private failure window; never returns raw IDs, attributes, paths, or errors. */
export async function readNativeHistoryDiagnostic(
  file: string,
  window: NativeHistoryWindow,
  failedAtMs: number,
  matchRequest?: (id: unknown) => unknown,
): Promise<NativeHistoryDiagnostic> {
  const result: NativeHistoryDiagnostic = {
    readStatus: "start-unavailable",
    writerMayBeBuffered: true,
    cutoff: "through-native-process-failure",
    truncated: false,
    incompleteLine: false,
    malformedLine: false,
    orphanedTerminal: false,
    orphanedWorkerTask: false,
    spans: [],
  };
  if (window.offset === null) {
    return result;
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < window.offset ||
      (window.identity && (stat.dev !== window.identity.dev || stat.ino !== window.identity.ino))
    ) {
      result.readStatus = "changed-file";
      return result;
    }
    const length = stat.size - window.offset;
    if (length > MAX_BYTES) {
      result.readStatus = "oversize";
      result.truncated = true;
      return result;
    }
    // Check the size before allocation/read/parse, including on a noisy failed Gateway.
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, window.offset);
    if (bytesRead !== length) {
      result.readStatus = "short-read";
      return result;
    }
    result.readStatus = "captured";
    result.incompleteLine = buffer.length > 0 && buffer.at(-1) !== 10;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const spans = new Map<string, HistorySpan>();
    let taskCount = 0;
    // One bounded framing pass; never parse oversized or partial lines.
    for (let offset = 0; offset < buffer.length;) {
      const end = buffer.indexOf(10, offset);
      if (end < 0) {
        break;
      }
      const start = offset;
      offset = end + 1;
      if (end === start) {
        continue;
      }
      if (end - start > MAX_LINE_BYTES) {
        result.malformedLine = result.truncated = true;
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(decoder.decode(buffer.subarray(start, end)));
      } catch {
        result.malformedLine = true;
        continue;
      }
      if (!isRecord(event) || event.schemaVersion !== "openclaw.diagnostics.v1") {
        result.malformedLine = true;
        continue;
      }
      const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
      if (!Number.isFinite(at)) {
        result.malformedLine = true;
        continue;
      }
      if (at < window.startedAtMs || at > failedAtMs) {
        continue;
      }
      if (event.type === "mark" && event.name === "worker.task") {
        const span = privateKey(event.parentSpanId) ? spans.get(event.parentSpanId) : undefined;
        if (!span?.workerTasks || span.startedMs === null || span.outcome !== "pending") {
          result.orphanedWorkerTask = true;
          continue;
        }
        const tasks = span.workerTasks;
        const fields = event.attributes;
        if (!isRecord(fields)) {
          tasks.invalid = true;
          continue;
        }
        if (fields.status === "invalid") {
          tasks.invalid = true;
          continue;
        }
        if (fields.status === "truncated") {
          tasks.truncated = result.truncated = true;
          continue;
        }
        const { outcome, queueMs, preparationMs, runMs, transferMs } = fields;
        if (
          fields.status !== "captured" ||
          (outcome !== "ok" && outcome !== "failed") ||
          !milliseconds(queueMs) ||
          !milliseconds(preparationMs) ||
          !milliseconds(runMs) ||
          !milliseconds(transferMs)
        ) {
          tasks.invalid = true;
          continue;
        }
        if (tasks.rows.length === 4 || taskCount === MAX_TASKS) {
          tasks.truncated = result.truncated = true;
          continue;
        }
        taskCount++;
        // Pool ok may contain a domain failure, and coalesced followers may have
        // no mark. Completion can also occur after the client's request timeout.
        tasks.rows.push({
          ordinal: tasks.rows.length + 1,
          finishedMs: at - window.startedAtMs,
          outcome,
          queueMs,
          preparationMs,
          runMs,
          transferMs,
        });
        continue;
      }
      const phase = historyPhase(event.name);
      if (
        !phase ||
        (event.type !== "span.start" && event.type !== "span.end" && event.type !== "span.error")
      ) {
        continue;
      }
      if (!privateKey(event.spanId)) {
        result.malformedLine = true;
        continue;
      }
      let span = spans.get(event.spanId);
      if (!span) {
        if (spans.size === MAX_SPANS) {
          result.truncated = true;
          continue;
        }
        span = {
          ordinal: spans.size + 1,
          phase,
          startedMs: null,
          finishedMs: null,
          outcome: "pending",
          ...(phase === "history_page"
            ? {
                request: { status: "unknown" } as HistoryRequest,
                workerTasks: { rows: [], invalid: false, truncated: false },
              }
            : {}),
        };
        spans.set(event.spanId, span);
        result.spans.push(span);
      }
      if (
        span.phase !== phase ||
        span.outcome !== "pending" ||
        (event.type === "span.start" && span.startedMs !== null)
      ) {
        result.malformedLine = true;
        if (span.request) {
          span.request = { status: "unknown" };
        }
        continue;
      }
      if (event.type === "span.start") {
        span.startedMs = at - window.startedAtMs;
        if (span.request) {
          span.request = matchHistoryRequest(
            isRecord(event.attributes) ? event.attributes.requestId : undefined,
            matchRequest,
          );
        }
      } else {
        result.orphanedTerminal ||= span.startedMs === null;
        span.finishedMs = at - window.startedAtMs;
        span.outcome = event.type === "span.end" ? "end" : "error";
      }
    }
    return boundProjection(result);
  } catch (error) {
    result.readStatus = isRecord(error) && error.code === "ENOENT" ? "missing" : "read-error";
    return result;
  } finally {
    await handle?.close().catch(() => {
      result.readStatus = "read-error";
    });
  }
}
