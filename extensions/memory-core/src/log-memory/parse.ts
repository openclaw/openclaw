// Parse a single raw log line into a normalized record. Supports three formats:
// JSON structured logs, RFC 3164/5424-ish syslog, and plain text with a leading
// ISO-8601 timestamp. Anything we cannot parse falls back to "now" + INFO so
// ingest never fails closed on an exotic format.

export type ParsedLogLine = {
  timestamp: Date;
  level: "ERROR" | "WARN" | "INFO";
  service?: string;
  message: string;
};

const ISO_PREFIX_RE =
  /^(?<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(?<rest>.*)$/s;
const SYSLOG_RE =
  /^(?:<\d+>)?(?<ts>\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(?<host>\S+)\s+(?<svc>[^:\s]+):\s*(?<msg>.*)$/s;
const LEVEL_RE = /\b(ERROR|ERR|FATAL|CRITICAL|WARN|WARNING|INFO|DEBUG|TRACE)\b/i;

function normalizeLevel(raw: string | undefined): ParsedLogLine["level"] {
  if (!raw) {
    return "INFO";
  }
  const upper = raw.toUpperCase();
  if (upper === "ERROR" || upper === "ERR" || upper === "FATAL" || upper === "CRITICAL") {
    return "ERROR";
  }
  if (upper === "WARN" || upper === "WARNING") {
    return "WARN";
  }
  return "INFO";
}

function tryParseJson(line: string): ParsedLogLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const tsRaw = (obj.timestamp ?? obj.time ?? obj.ts ?? obj["@timestamp"]) as
    | string
    | number
    | undefined;
  const timestamp = parseTimestamp(tsRaw);
  const level = normalizeLevel(
    typeof obj.level === "string"
      ? obj.level
      : typeof obj.severity === "string"
        ? obj.severity
        : undefined,
  );
  const service =
    typeof obj.service === "string"
      ? obj.service
      : typeof obj.logger === "string"
        ? obj.logger
        : typeof obj.app === "string"
          ? obj.app
          : undefined;
  const message =
    typeof obj.message === "string" ? obj.message : typeof obj.msg === "string" ? obj.msg : trimmed;
  return { timestamp, level, service, message };
}

function tryParseSyslog(line: string): ParsedLogLine | null {
  const m = SYSLOG_RE.exec(line);
  if (!m?.groups) {
    return null;
  }
  const { ts, svc, msg } = m.groups;
  // Syslog "Mon DD HH:MM:SS" lacks a year — anchor to the current year.
  const year = new Date().getUTCFullYear();
  const parsed = new Date(`${ts} ${year}`);
  const timestamp = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const level = normalizeLevel(LEVEL_RE.exec(msg)?.[1]);
  return { timestamp, level, service: svc, message: msg };
}

function tryParseIsoPrefixed(line: string): ParsedLogLine | null {
  const m = ISO_PREFIX_RE.exec(line);
  if (!m?.groups) {
    return null;
  }
  const { ts, rest } = m.groups;
  const timestamp = parseTimestamp(ts);
  const level = normalizeLevel(LEVEL_RE.exec(rest)?.[1]);
  return { timestamp, level, message: rest.trim() };
}

function parseTimestamp(value: string | number | undefined): Date {
  if (value === undefined) {
    return new Date();
  }
  if (typeof value === "number") {
    // Epoch seconds vs ms: anything below 1e12 is treated as seconds.
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function parseLogLine(raw: string): ParsedLogLine {
  const line = raw.replace(/\r?\n$/, "");
  return (
    tryParseJson(line) ??
    tryParseSyslog(line) ??
    tryParseIsoPrefixed(line) ?? {
      timestamp: new Date(),
      level: normalizeLevel(LEVEL_RE.exec(line)?.[1]),
      message: line,
    }
  );
}
