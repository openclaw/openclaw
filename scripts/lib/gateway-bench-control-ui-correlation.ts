import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

export type ControlUiRequestMeasurement = {
  clientIndex: number;
  requestId: string;
  sessionKey: string;
  token: string;
  sentMs: number;
  ackMs: number | null;
  firstDeltaMs: number | null;
  finalMs: number | null;
  replyRunId: string | null;
  error: string | null;
};

function assistantText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant") {
    return "";
  }
  if (typeof message.text === "string") {
    return message.text;
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return Array.isArray(message.content)
    ? message.content
        .flatMap((part) =>
          isRecord(part) &&
          (part.type === "text" || part.type === "output_text") &&
          typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("")
    : "";
}

export function controlUiRequestSettled(row: ControlUiRequestMeasurement): boolean {
  return row.error !== null || (row.ackMs !== null && row.finalMs !== null);
}

/** Synthetic reply tokens bridge queued runs without treating custody finals as replies. */
export class ControlUiReplyCorrelation {
  readonly requests: ControlUiRequestMeasurement[] = [];
  private readonly byId = new Map<string, ControlUiRequestMeasurement>();
  private readonly byToken = new Map<string, ControlUiRequestMeasurement>();
  private readonly sessions = new Set<string>();
  private readonly runs = new Map<
    string,
    { firstDeltaMs: number | null; row?: ControlUiRequestMeasurement }
  >();

  register(
    input: Pick<
      ControlUiRequestMeasurement,
      "clientIndex" | "requestId" | "sessionKey" | "token" | "sentMs"
    >,
  ): ControlUiRequestMeasurement {
    if (
      this.requests.length >= 100_000 ||
      this.byId.has(input.requestId) ||
      this.byToken.has(input.token)
    ) {
      throw new Error("Control UI request identity duplicated or recording limit exceeded");
    }
    const row = {
      ...input,
      ackMs: null,
      firstDeltaMs: null,
      finalMs: null,
      replyRunId: null,
      error: null,
    };
    this.requests.push(row);
    this.byId.set(row.requestId, row);
    this.byToken.set(row.token, row);
    this.sessions.add(row.sessionKey);
    return row;
  }

  acknowledge(requestId: string, payload: unknown, atMs: number): void {
    const row = this.byId.get(requestId);
    if (!row) {
      throw new Error("ACK has no registered request");
    }
    row.ackMs ??= atMs;
    if (
      !isRecord(payload) ||
      payload.runId !== requestId ||
      typeof payload.status !== "string" ||
      !["started", "in_flight", "ok"].includes(payload.status)
    ) {
      row.error = "chat.send rejected or changed the request identity";
    }
  }

  observe(payload: unknown, atMs: number) {
    if (
      !isRecord(payload) ||
      typeof payload.sessionKey !== "string" ||
      typeof payload.runId !== "string" ||
      !this.sessions.has(payload.sessionKey)
    ) {
      return undefined;
    }
    const key = JSON.stringify([payload.sessionKey, payload.runId]);
    const prior = this.runs.get(key);
    if (payload.state === "delta") {
      const text =
        typeof payload.deltaText === "string" ? payload.deltaText : assistantText(payload.message);
      if (text.length > 0 && prior?.row?.finalMs == null) {
        if (this.runs.size >= 200_000 && !prior) {
          throw new Error("Control UI reply stream recording limit exceeded");
        }
        this.runs.set(key, { ...prior, firstDeltaMs: prior?.firstDeltaMs ?? atMs });
        const row = this.byId.get(payload.runId);
        if (row?.sessionKey === payload.sessionKey) {
          row.firstDeltaMs ??= atMs;
          return row;
        }
        if (!prior) {
          return {
            kind: "delta" as const,
            sessionKey: payload.sessionKey,
            runId: payload.runId,
            firstDeltaMs: atMs,
          };
        }
      }
      return undefined;
    }
    if (payload.state === "error" || payload.state === "aborted") {
      const row = prior?.row ?? this.byId.get(payload.runId);
      if (!row || row.sessionKey !== payload.sessionKey) {
        throw new Error("Uncorrelated Control UI reply failure");
      }
      const detail =
        typeof payload.errorMessage === "string"
          ? payload.errorMessage
          : typeof payload.stopReason === "string"
            ? payload.stopReason
            : "unknown";
      row.error = `chat ${payload.state}: ${detail}`;
      return row;
    }
    if (payload.state !== "final") {
      return undefined;
    }
    const token = assistantText(payload.message).trim();
    if (!token) {
      return undefined; // Custody can finish before or after its independently named visible reply.
    }
    const row = this.byToken.get(token);
    if (!row || row.sessionKey !== payload.sessionKey) {
      throw new Error("Control UI final has an unexpected synthetic reply token or session");
    }
    if (row.finalMs !== null) {
      if (row.replyRunId !== payload.runId) {
        throw new Error("Multiple visible reply runs for one Control UI request");
      }
      return undefined;
    }
    if (
      atMs < row.sentMs ||
      (prior?.firstDeltaMs !== undefined &&
        prior.firstDeltaMs !== null &&
        prior.firstDeltaMs < row.sentMs)
    ) {
      throw new Error("Control UI reply predates its request");
    }
    row.firstDeltaMs = prior?.firstDeltaMs ?? null;
    row.finalMs = atMs;
    row.replyRunId = payload.runId;
    this.runs.set(key, { firstDeltaMs: row.firstDeltaMs, row });
    return row;
  }
}

export function summarizeControlUiRequests(
  rows: readonly ControlUiRequestMeasurement[],
  durationMs: number,
  activeClients: number,
) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Control UI duration must be positive");
  }
  const summarize = (values: number[]) => {
    if (!values.length) {
      return null;
    }
    values.sort((a, b) => a - b);
    const percentile = (fraction: number) => values[Math.ceil(values.length * fraction) - 1]!;
    return { count: values.length, p50: percentile(0.5), p95: percentile(0.95) };
  };
  const completed = rows.filter(
    (row) => row.error === null && row.ackMs !== null && row.finalMs !== null,
  );
  const replies = completed.filter((row) => row.finalMs! <= durationMs).length;
  const participants = new Set(
    rows.filter((row) => row.sentMs >= 0 && row.sentMs < durationMs).map((row) => row.clientIndex),
  );
  const latency = (field: "ackMs" | "firstDeltaMs" | "finalMs") =>
    summarize(rows.flatMap((row) => (row[field] === null ? [] : [row[field] - row.sentMs])));
  return {
    missingActiveClients: Array.from({ length: activeClients }, (_, index) => index).filter(
      (index) => !participants.has(index),
    ),
    started: rows.length,
    replies,
    drainedReplies: completed.length - replies,
    errors: rows.filter((row) => row.error !== null).length,
    pending: rows.filter((row) => !controlUiRequestSettled(row)).length,
    repliesPerSecond: replies / (durationMs / 1_000),
    ackMs: latency("ackMs"),
    firstDeltaMs: latency("firstDeltaMs"),
    finalMs: latency("finalMs"),
  };
}
