import { createHmac, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

type Phase = "setup" | "warmup" | "load" | "shutdown";
const MAX_RECORDS = 512;
const MAX_BYTES = 128 * 1024;
const MAX_LOG_LINE_BYTES = 16 * 1024;
const STATES = new Set(["current", "stale", "updating", "unavailable"]);
const LOG_MESSAGES = new Set([
  "Activity recap deferred",
  "Activity recap background work failed",
  "Activity summary publication failed",
]);
const KNOWN_ERRORS = new Map([
  ["Activity recap timed out", "timeout"],
  ["Activity recap returned no visible text", "empty-result"],
  ["Activity recap lifecycle or utility model changed", "cancelled"],
]);
type Fact = Record<string, string | number | boolean | null>;

/** Passive, content-free observations; absence is never proof of a scheduler decision. */
export function createActivitySummaryDiagnostics(startedAt: number) {
  const key = randomBytes(32);
  const records: Fact[] = [];
  let phase: Phase = "setup";
  let bytes = 0;
  let dropped = 0;
  let oversizedLogLines = 0;
  let incompleteLogLines = 0;
  let malformedLogLines = 0;
  let invalidFields = 0;
  const streams = new Map<
    "stdout" | "stderr",
    {
      decoder: StringDecoder;
      pending: string;
      discarding: boolean;
    }
  >();
  const identity = (domain: string, value: unknown) => {
    if (typeof value !== "string" || !value) {
      return null;
    }
    if (Buffer.byteLength(value, "utf8") > MAX_LOG_LINE_BYTES) {
      invalidFields += 1;
      return null;
    }
    return createHmac("sha256", key).update(domain).update("\0").update(value).digest("hex");
  };
  const nonNegativeInteger = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const append = (fact: Fact) => {
    const record = { atMs: performance.now() - startedAt, phase, ...fact };
    const size = Buffer.byteLength(JSON.stringify(record), "utf8");
    if (records.length >= MAX_RECORDS || bytes + size > MAX_BYTES) {
      dropped += 1;
      return;
    }
    bytes += size;
    records.push(record);
  };
  const observeSummary = (row: Record<string, unknown>, fact: Fact) => {
    const summary = row.activitySummary;
    const present = Object.hasOwn(row, "activitySummary");
    const state =
      isRecord(summary) && typeof summary.state === "string" && STATES.has(summary.state)
        ? summary.state
        : null;
    if (present && state === null) {
      invalidFields += 1;
    }
    append({
      ...fact,
      agent: identity("agent", row.agentId),
      session: identity("session", row.sessionKey ?? row.key),
      sessionId: identity("session-id", row.sessionId),
      summaryPresent: present,
      state,
      updatedAt: isRecord(summary) ? nonNegativeInteger(summary.updatedAt) : null,
      hasText: isRecord(summary)
        ? typeof summary.text === "string" && summary.text.length > 0
        : null,
    });
  };
  const observeLog = (line: string) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (line.trimStart().startsWith("{")) {
        malformedLogLines += 1;
      }
      return;
    }
    if (!isRecord(value) || typeof value.message !== "string" || !LOG_MESSAGES.has(value.message)) {
      return;
    }
    const expectedSubsystem =
      value.message === "Activity summary publication failed"
        ? "gateway"
        : "gateway/activity-summary";
    if (value.subsystem !== expectedSubsystem) {
      return;
    }
    const error =
      typeof value.error === "string"
        ? value.error
        : isRecord(value.error) && typeof value.error.message === "string"
          ? value.error.message
          : undefined;
    // Error messages can contain paths, credentials, or provider content. Only exact
    // owner literals and a per-capture fingerprint cross this retention boundary.
    append({
      source: "log",
      message: value.message,
      agent: identity("agent", value.agentId),
      emittedAt:
        typeof value.time === "string" && Number.isFinite(Date.parse(value.time))
          ? Date.parse(value.time)
          : null,
      errorPresent: Object.hasOwn(value, "error"),
      retryScheduled: typeof value.retryScheduled === "boolean" ? value.retryScheduled : null,
      errorKind: error ? (KNOWN_ERRORS.get(error) ?? "unclassified") : "unavailable",
      errorFingerprint: identity("error", error),
    });
  };
  append({ source: "phase" });
  return {
    setPhase(next: Phase) {
      phase = next;
      append({ source: "phase" });
    },
    onEvent(event: { event: string; seq?: number; payload?: unknown }) {
      const payload = event.payload;
      if (!isRecord(payload)) {
        return;
      }
      const seq = nonNegativeInteger(event.seq);
      if (event.event === "sessions.changed") {
        // Per-connection presentation replaces the nested row after the producer
        // snapshot. An absent nested recap must not revive an older top-level one.
        const row = isRecord(payload.session) ? payload.session : payload;
        observeSummary(
          {
            ...row,
            agentId: row.agentId ?? payload.agentId,
            sessionKey: row.key ?? payload.sessionKey,
          },
          {
            source: "event",
            seq,
            projection: row === payload ? "event" : "session",
            activitySummaryChange: payload.reason === "activity-summary",
          },
        );
      } else if (
        event.event === "agent" &&
        payload.stream === "lifecycle" &&
        isRecord(payload.data)
      ) {
        const lifecycle = payload.data.phase;
        if (
          typeof lifecycle === "string" &&
          ["start", "finishing", "end", "error"].includes(lifecycle)
        ) {
          append({
            source: "lifecycle",
            seq,
            lifecycle,
            run: identity("run", payload.runId),
            session: identity("session", payload.sessionKey),
          });
        }
      }
    },
    onProbe(payload: unknown) {
      append({
        source: "probe-receipt",
        rows: isRecord(payload) && Array.isArray(payload.sessions) ? payload.sessions.length : null,
      });
      if (isRecord(payload) && Array.isArray(payload.sessions)) {
        for (const row of payload.sessions) {
          if (isRecord(row)) {
            observeSummary(row, { source: "probe" });
          }
        }
      }
    },
    onOutput(this: void, stream: "stdout" | "stderr", chunk: Buffer) {
      let state = streams.get(stream);
      if (!state) {
        state = { decoder: new StringDecoder("utf8"), pending: "", discarding: false };
        streams.set(stream, state);
      }
      // Discard an oversized line through its newline, never parse a clipped suffix.
      const text = state.decoder.write(chunk);
      let offset = 0;
      while (offset < text.length) {
        const newline = text.indexOf("\n", offset);
        const end = newline < 0 ? text.length : newline;
        const part = text.slice(offset, end);
        if (!state.discarding) {
          if (
            Buffer.byteLength(state.pending, "utf8") + Buffer.byteLength(part, "utf8") >
            MAX_LOG_LINE_BYTES
          ) {
            oversizedLogLines += 1;
            state.pending = "";
            state.discarding = true;
          } else {
            state.pending += part;
          }
        }
        if (newline < 0) {
          break;
        }
        if (!state.discarding) {
          observeLog(state.pending);
        }
        state.pending = "";
        state.discarding = false;
        offset = newline + 1;
      }
    },
    finish() {
      for (const state of streams.values()) {
        const tail = state.decoder.end();
        if (state.pending || tail) {
          incompleteLogLines += 1;
        }
      }
      streams.clear();
      return {
        delivery: "best-effort; missing events do not identify a scheduling decision" as const,
        phaseClock: "observation arrival; may follow the originating work phase" as const,
        instrumentation: "debug JSON console; not comparable performance evidence" as const,
        identityScope: "per-capture opaque fingerprints" as const,
        limits: { records: MAX_RECORDS, bytes: MAX_BYTES, logLineBytes: MAX_LOG_LINE_BYTES },
        bytes,
        dropped,
        oversizedLogLines,
        incompleteLogLines,
        malformedLogLines,
        invalidFields,
        truncated:
          dropped > 0 || oversizedLogLines > 0 || incompleteLogLines > 0 || malformedLogLines > 0,
        records: [...records],
      };
    },
  };
}
