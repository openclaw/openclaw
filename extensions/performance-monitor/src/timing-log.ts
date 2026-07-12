// Writes performance timing records into the shared OpenClaw file log (/tmp/openclaw by default).
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { DiagnosticEventPayload } from "../api.js";
import type { PerformanceEventKind } from "./types.js";

export type PerformanceTimingLogFields = {
  kind: PerformanceEventKind;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  extensionId?: string;
  hookName?: string;
  handlerName?: string;
  handlerSource?: string;
  handlerRef?: string;
  toolName?: string;
  toolSource?: string;
  mcpServerName?: string;
  mcpToolName?: string;
  provider?: string;
  model?: string;
  providerPluginId?: string;
  harnessId?: string;
  api?: string;
  transport?: string;
  phaseName?: string;
  callId?: string;
  toolCallId?: string;
  durationMs?: number;
  outcome?: string;
};

export type PerformanceTimingLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
};

const PERF_TIMING_PREFIX = "perf timing:";

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function appendKv(parts: string[], key: string, value: string | number | undefined): void {
  if (value === undefined || value === null) {
    return;
  }
  const text = typeof value === "number" ? String(value) : value.trim();
  if (!text) {
    return;
  }
  parts.push(`${key}=${text}`);
}

export function buildPerformanceTimingLogMessage(fields: PerformanceTimingLogFields): string {
  const parts: string[] = [];
  appendKv(parts, "kind", fields.kind);
  appendKv(parts, "pluginId", fields.extensionId);
  appendKv(parts, "hookName", fields.hookName);
  appendKv(parts, "handlerName", fields.handlerName);
  appendKv(parts, "handlerSource", fields.handlerSource);
  appendKv(parts, "handlerRef", fields.handlerRef);
  appendKv(parts, "toolName", fields.toolName);
  appendKv(parts, "toolSource", fields.toolSource);
  appendKv(parts, "mcpServerName", fields.mcpServerName);
  appendKv(parts, "mcpToolName", fields.mcpToolName);
  appendKv(parts, "provider", fields.provider);
  appendKv(parts, "model", fields.model);
  appendKv(parts, "providerPluginId", fields.providerPluginId);
  appendKv(parts, "harnessId", fields.harnessId);
  appendKv(parts, "api", fields.api);
  appendKv(parts, "transport", fields.transport);
  appendKv(parts, "phaseName", fields.phaseName);
  appendKv(parts, "callId", fields.callId);
  appendKv(parts, "toolCallId", fields.toolCallId);
  appendKv(parts, "durationMs", fields.durationMs);
  appendKv(parts, "outcome", fields.outcome);
  appendKv(parts, "runId", fields.runId);
  appendKv(parts, "traceId", fields.traceId);
  appendKv(parts, "spanId", fields.spanId);
  appendKv(parts, "sessionKey", fields.sessionKey);
  appendKv(parts, "sessionId", fields.sessionId);
  return `${PERF_TIMING_PREFIX} ${parts.join(" ")}`.trim();
}

export function buildPerformanceTimingLogMeta(
  fields: PerformanceTimingLogFields,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    perfTiming: true,
    kind: fields.kind,
  };
  if (fields.runId) {
    meta.runId = fields.runId;
  }
  if (fields.sessionKey) {
    meta.sessionKey = fields.sessionKey;
  }
  if (fields.sessionId) {
    meta.sessionId = fields.sessionId;
  }
  if (fields.traceId) {
    meta.trace = {
      traceId: fields.traceId,
      ...(fields.spanId ? { spanId: fields.spanId } : {}),
      ...(fields.parentSpanId ? { parentSpanId: fields.parentSpanId } : {}),
    };
    meta.traceId = fields.traceId;
    if (fields.spanId) {
      meta.spanId = fields.spanId;
    }
  }
  if (fields.durationMs !== undefined) {
    meta.durationMs = fields.durationMs;
  }
  if (fields.outcome) {
    meta.outcome = fields.outcome;
  }
  if (fields.extensionId) {
    meta.pluginId = fields.extensionId;
  }
  if (fields.hookName) {
    meta.hookName = fields.hookName;
  }
  if (fields.handlerName) {
    meta.handlerName = fields.handlerName;
  }
  if (fields.handlerSource) {
    meta.handlerSource = fields.handlerSource;
  }
  if (fields.handlerRef) {
    meta.handlerRef = fields.handlerRef;
  }
  if (fields.toolName) {
    meta.toolName = fields.toolName;
  }
  if (fields.toolCallId) {
    meta.toolCallId = fields.toolCallId;
  }
  if (fields.callId) {
    meta.callId = fields.callId;
  }
  if (fields.phaseName) {
    meta.phaseName = fields.phaseName;
  }
  return meta;
}

export function diagnosticEventToTimingLogFields(
  event: DiagnosticEventPayload,
): PerformanceTimingLogFields | undefined {
  const traceId = trimOptional(event.trace?.traceId);
  const spanId = trimOptional(event.trace?.spanId);
  const parentSpanId = trimOptional(event.trace?.parentSpanId);
  const base = {
    runId: trimOptional(event.runId),
    sessionKey: trimOptional(event.sessionKey),
    sessionId: trimOptional(event.sessionId),
    traceId,
    spanId,
    parentSpanId,
  };

  switch (event.type) {
    case "hook.handler.completed":
      return {
        ...base,
        kind: "hook_handler",
        extensionId: trimOptional(event.pluginId),
        hookName: trimOptional(event.hookName),
        handlerName: trimOptional(event.handlerName),
        handlerSource: trimOptional(event.handlerSource),
        handlerRef:
          trimOptional(event.handlerRef) ??
          (event.pluginId && event.hookName
            ? `hook:${event.pluginId}:${event.hookName}`
            : undefined),
        durationMs: event.durationMs,
        outcome: trimOptional(event.outcome),
      };
    case "diagnostic.phase.completed":
      return {
        ...base,
        kind: "phase",
        phaseName: trimOptional(event.name),
        durationMs: event.durationMs,
        outcome: "completed",
      };
    case "tool.execution.completed":
      return {
        ...base,
        kind: "tool",
        extensionId: trimOptional(event.toolOwner ?? event.toolSource),
        toolName: trimOptional(event.toolName),
        handlerName: trimOptional(event.handlerName),
        handlerRef: trimOptional(event.handlerRef),
        toolSource: trimOptional(event.toolSource),
        mcpServerName: trimOptional(event.mcpServerName),
        mcpToolName: trimOptional(event.mcpToolName),
        toolCallId: trimOptional(event.toolCallId),
        durationMs: event.durationMs,
        outcome: "completed",
      };
    case "tool.execution.error":
      return {
        ...base,
        kind: "tool",
        extensionId: trimOptional(event.toolOwner ?? event.toolSource),
        toolName: trimOptional(event.toolName),
        handlerName: trimOptional(event.handlerName),
        handlerRef: trimOptional(event.handlerRef),
        toolSource: trimOptional(event.toolSource),
        mcpServerName: trimOptional(event.mcpServerName),
        mcpToolName: trimOptional(event.mcpToolName),
        toolCallId: trimOptional(event.toolCallId),
        durationMs: event.durationMs,
        outcome: "error",
      };
    case "model.call.completed":
      return {
        ...base,
        kind: "llm",
        extensionId: trimOptional(event.providerPluginId ?? event.harnessId ?? event.provider),
        provider: trimOptional(event.provider),
        model: trimOptional(event.model),
        providerPluginId: trimOptional(event.providerPluginId),
        harnessId: trimOptional(event.harnessId),
        handlerRef: trimOptional(event.handlerRef),
        api: trimOptional(event.api),
        transport: trimOptional(event.transport),
        callId: trimOptional(event.callId),
        durationMs: event.durationMs,
        outcome: "completed",
      };
    case "model.call.error":
      return {
        ...base,
        kind: "llm",
        extensionId: trimOptional(event.providerPluginId ?? event.harnessId ?? event.provider),
        provider: trimOptional(event.provider),
        model: trimOptional(event.model),
        providerPluginId: trimOptional(event.providerPluginId),
        harnessId: trimOptional(event.harnessId),
        handlerRef: trimOptional(event.handlerRef),
        api: trimOptional(event.api),
        transport: trimOptional(event.transport),
        callId: trimOptional(event.callId),
        durationMs: event.durationMs,
        outcome: "error",
      };
    case "run.started":
      return {
        ...base,
        kind: "run",
        outcome: "started",
      };
    case "run.completed":
      return {
        ...base,
        kind: "run",
        durationMs: event.durationMs,
        outcome: trimOptional(event.outcome) ?? "completed",
      };
    case "harness.run.completed":
      return {
        ...base,
        kind: "harness",
        extensionId: trimOptional(event.pluginId ?? event.harnessId),
        harnessId: trimOptional(event.harnessId),
        durationMs: event.durationMs,
        outcome: trimOptional(event.outcome) ?? "completed",
      };
    case "harness.run.error":
      return {
        ...base,
        kind: "harness",
        extensionId: trimOptional(event.pluginId ?? event.harnessId),
        harnessId: trimOptional(event.harnessId),
        durationMs: event.durationMs,
        outcome: "error",
      };
    default:
      return undefined;
  }
}

export function logPerformanceTimingEvent(
  logger: PerformanceTimingLogger,
  fields: PerformanceTimingLogFields,
): void {
  const message = buildPerformanceTimingLogMessage(fields);
  const meta = buildPerformanceTimingLogMeta(fields);
  logger.info(message, meta);
}

export function createPerformanceTimingLogger(): PerformanceTimingLogger {
  const log = createSubsystemLogger("plugins/performance-monitor");
  return {
    info: (message, meta) => log.info(message, meta),
  };
}

export function logDiagnosticPerformanceTimingEvent(
  logger: PerformanceTimingLogger,
  event: DiagnosticEventPayload,
): void {
  const fields = diagnosticEventToTimingLogFields(event);
  if (!fields) {
    return;
  }
  logPerformanceTimingEvent(logger, fields);
}

export const testApi = {
  PERF_TIMING_PREFIX,
};

export { testApi as __test__ };
