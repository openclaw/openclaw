import { PROBE_EVENT_TYPES, type ProbeEventSeverity } from "../types.js";
import type { ProbeMappedEventInput } from "./collector.js";
import { redactSensitiveText } from "./redact.js";

type LogMeta = {
  logLevelName?: string;
  date?: Date;
  name?: string;
  parentNames?: string[];
};

type ParsedLogRecord = {
  message: string;
  level: string;
  occurredAt: number;
  loggerName?: string;
  loggerParents?: string[];
  bindings?: Record<string, unknown>;
};

function toProbeSeverity(level: string): ProbeEventSeverity {
  if (level === "FATAL") {
    return "critical";
  }
  if (level === "ERROR") {
    return "error";
  }
  if (level === "WARN") {
    return "warn";
  }
  return "info";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseLogRecord(logObj: Record<string, unknown>): ParsedLogRecord {
  const meta = (logObj._meta as LogMeta | undefined) ?? {};
  const numericArgs = Object.entries(logObj)
    .filter(([key]) => /^\d+$/.test(key))
    .toSorted((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, value]) => value);

  let bindings: Record<string, unknown> | undefined;
  if (typeof numericArgs[0] === "string" && numericArgs[0].trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(numericArgs[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        bindings = parsed as Record<string, unknown>;
        numericArgs.shift();
      }
    } catch {
      // ignore malformed bindings
    }
  }

  let message = "";
  if (numericArgs.length > 0 && typeof numericArgs[numericArgs.length - 1] === "string") {
    message = String(numericArgs.pop());
  } else if (numericArgs.length === 1) {
    message = safeStringify(numericArgs[0]);
  } else if (numericArgs.length > 1) {
    message = safeStringify(numericArgs);
  }

  return {
    message: message || "log",
    level: (meta.logLevelName ?? "INFO").toUpperCase(),
    occurredAt: meta.date instanceof Date ? meta.date.getTime() : Date.now(),
    loggerName: meta.name,
    loggerParents: meta.parentNames,
    bindings,
  };
}

function parseMessagePairs(message: string): Record<string, string> {
  const map: Record<string, string> = {};
  const regex = /([a-zA-Z][a-zA-Z0-9]*)=([^\s]+)/g;
  for (const match of message.matchAll(regex)) {
    const key = match[1];
    const value = match[2];
    if (key && value) {
      map[key] = value;
    }
  }
  return map;
}

function getSubsystem(parsed: ParsedLogRecord): string | undefined {
  const subsystem = parsed.bindings?.subsystem;
  if (typeof subsystem === "string" && subsystem.trim().length > 0) {
    return subsystem;
  }
  if (parsed.loggerParents && parsed.loggerParents.length > 0) {
    return parsed.loggerParents.join(".");
  }
  return parsed.loggerName;
}

export function mapAppLogRecord(logObj: Record<string, unknown>): ProbeMappedEventInput[] {
  const parsed = parseLogRecord(logObj);
  const lowered = parsed.message.toLowerCase();
  const severity = toProbeSeverity(parsed.level);
  const events: ProbeMappedEventInput[] = [];

  if (parsed.level === "ERROR" || parsed.level === "FATAL") {
    const hasCoreKeyword = /\b(bind|config|listen)\b/i.test(parsed.message);
    events.push({
      eventType: PROBE_EVENT_TYPES.OPS_SUBSYSTEM_ERROR,
      source: "app_log",
      severity,
      occurredAt: parsed.occurredAt,
      payload: {
        level: parsed.level,
        subsystem: getSubsystem(parsed) ?? null,
        message: redactSensitiveText(parsed.message),
        hasCoreKeyword,
      },
    });
  }

  if (lowered.includes("unauthorized conn=") && lowered.includes("reason=")) {
    const kv = parseMessagePairs(parsed.message);
    events.push({
      eventType: PROBE_EVENT_TYPES.SECURITY_WS_UNAUTHORIZED,
      source: "app_log",
      severity: "warn",
      occurredAt: parsed.occurredAt,
      payload: {
        connId: kv.conn ?? null,
        remoteIp: kv.remote ?? null,
        client: kv.client ?? null,
        reason: kv.reason ?? null,
        message: redactSensitiveText(parsed.message),
      },
    });
  }

  if (
    lowered.includes("tools-invoke: tool execution failed") ||
    (lowered.includes("tools-invoke") &&
      (lowered.includes("eacces") || lowered.includes("permission denied")))
  ) {
    events.push({
      eventType: PROBE_EVENT_TYPES.SECURITY_HTTP_TOOL_INVOKE_FAILED,
      source: "app_log",
      severity: "error",
      occurredAt: parsed.occurredAt,
      payload: {
        subsystem: getSubsystem(parsed) ?? null,
        permissionDenied: lowered.includes("eacces") || lowered.includes("permission denied"),
        message: redactSensitiveText(parsed.message),
      },
    });
  }

  const malformedReason = lowered.includes("invalid json")
    ? "invalid_json"
    : lowered.includes("connection reset by peer")
      ? "connection_reset"
      : lowered.includes("request body timeout")
        ? "request_body_timeout"
        : lowered.includes("connection closed")
          ? "connection_closed"
          : null;

  if (malformedReason) {
    events.push({
      eventType: PROBE_EVENT_TYPES.SECURITY_HTTP_MALFORMED_OR_RESET,
      source: "app_log",
      severity: malformedReason === "connection_reset" ? "warn" : "info",
      occurredAt: parsed.occurredAt,
      payload: {
        reason: malformedReason,
        message: redactSensitiveText(parsed.message),
      },
    });
  }

  if (
    lowered.includes("security audit: device access upgrade requested") &&
    lowered.includes("roleto=")
  ) {
    const kv = parseMessagePairs(parsed.message);
    const roleTo = kv.roleTo ?? null;
    events.push({
      eventType: PROBE_EVENT_TYPES.SECURITY_DEVICE_ROLE_ESCALATION,
      source: "app_log",
      severity: roleTo === "owner" ? "critical" : "warn",
      occurredAt: parsed.occurredAt,
      payload: {
        reason: kv.reason ?? null,
        deviceId: kv.device ?? null,
        roleFrom: kv.roleFrom ?? null,
        roleTo,
        scopesFrom: kv.scopesFrom ?? null,
        scopesTo: kv.scopesTo ?? null,
        remoteIp: kv.ip ?? null,
        authMethod: kv.auth ?? null,
        client: kv.client ?? null,
      },
    });
  }

  return events;
}
