// Performance Monitor service subscribes to diagnostics and exposes HTTP reports.
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginService,
} from "../api.js";
import { isInternalDiagnosticEventMetadata } from "../api.js";
import { createPerformanceMonitor, type PerformanceMonitor } from "./monitor.js";
import {
  createPerformanceTimingLogger,
  diagnosticEventToTimingLogFields,
  logPerformanceTimingEvent,
  type PerformanceTimingLogger,
} from "./timing-log.js";
import type { PerformanceMonitorConfig } from "./types.js";

function shouldRecordDiagnosticEvent(metadata: DiagnosticEventMetadata): boolean {
  return metadata.trusted || isInternalDiagnosticEventMetadata(metadata);
}

function parsePluginConfig(raw: Record<string, unknown> | undefined): PerformanceMonitorConfig {
  const maxRuns =
    typeof raw?.maxRuns === "number" && Number.isFinite(raw.maxRuns)
      ? Math.min(1000, Math.max(1, Math.floor(raw.maxRuns)))
      : 100;
  const maxEventsPerRun =
    typeof raw?.maxEventsPerRun === "number" && Number.isFinite(raw.maxEventsPerRun)
      ? Math.min(10_000, Math.max(10, Math.floor(raw.maxEventsPerRun)))
      : 500;
  const logTimingEvents = raw?.logTimingEvents !== false;
  return { maxRuns, maxEventsPerRun, logTimingEvents };
}

function recordDiagnosticEvent(
  monitor: PerformanceMonitor,
  event: DiagnosticEventPayload,
  options?: { timingLogger?: PerformanceTimingLogger; logTimingEvents?: boolean },
): void {
  const timingFields = diagnosticEventToTimingLogFields(event);
  const trace = {
    ...(timingFields?.traceId ? { traceId: timingFields.traceId } : {}),
    ...(timingFields?.spanId ? { spanId: timingFields.spanId } : {}),
  };

  switch (event.type) {
    case "hook.handler.completed":
      monitor.recordEvent({
        runId: event.runId,
        sessionKey: event.sessionKey,
        sessionId: event.sessionId,
        kind: "hook_handler",
        extensionId: event.pluginId,
        hookName: event.hookName,
        handlerName: event.handlerName,
        handlerSource: event.handlerSource,
        handlerRef: event.handlerRef ?? `hook:${event.pluginId}:${event.hookName}`,
        durationMs: event.durationMs,
        outcome: event.outcome,
        ...trace,
      });
      break;
    case "diagnostic.phase.completed":
      monitor.recordEvent({
        runId: event.runId,
        sessionKey: event.sessionKey,
        sessionId: event.sessionId,
        kind: "phase",
        phaseName: event.name,
        at: event.endedAt ?? event.startedAt,
        durationMs: event.durationMs,
        metadata: event.details,
        ...trace,
      });
      break;
    case "tool.execution.completed":
      monitor.recordEvent({
        runId: event.runId,
        sessionKey: event.sessionKey,
        sessionId: event.sessionId,
        kind: "tool",
        extensionId: event.toolOwner ?? event.toolSource,
        toolName: event.toolName,
        handlerName: event.handlerName,
        handlerRef: event.handlerRef,
        toolSource: event.toolSource,
        mcpServerName: event.mcpServerName,
        mcpToolName: event.mcpToolName,
        durationMs: event.durationMs,
        outcome: "completed",
        toolCallId: event.toolCallId,
        metadata: {
          source: "diagnostics",
          ...(event.toolSource ? { toolSource: event.toolSource } : {}),
        },
        ...trace,
      });
      break;
    case "tool.execution.error":
      monitor.recordEvent({
        runId: event.runId,
        sessionKey: event.sessionKey,
        sessionId: event.sessionId,
        kind: "tool",
        extensionId: event.toolOwner ?? event.toolSource,
        toolName: event.toolName,
        handlerName: event.handlerName,
        handlerRef: event.handlerRef,
        toolSource: event.toolSource,
        mcpServerName: event.mcpServerName,
        mcpToolName: event.mcpToolName,
        durationMs: event.durationMs,
        outcome: "error",
        toolCallId: event.toolCallId,
        metadata: {
          source: "diagnostics",
          errorCategory: event.errorCategory,
          ...(event.toolSource ? { toolSource: event.toolSource } : {}),
        },
        ...trace,
      });
      break;
    case "model.call.completed":
      monitor.recordEvent({
        runId: event.runId,
        sessionKey: event.sessionKey,
        sessionId: event.sessionId,
        kind: "llm",
        extensionId: event.providerPluginId ?? event.harnessId ?? event.provider,
        provider: event.provider,
        model: event.model,
        providerPluginId: event.providerPluginId,
        harnessId: event.harnessId,
        handlerRef: event.handlerRef,
        api: event.api,
        transport: event.transport,
        durationMs: event.durationMs,
        outcome: "completed",
        callId: event.callId,
        metadata: {
          source: "diagnostics",
          ...(event.timeToFirstByteMs !== undefined
            ? { timeToFirstByteMs: event.timeToFirstByteMs }
            : {}),
        },
        ...trace,
      });
      break;
    case "model.call.error":
      monitor.recordEvent({
        runId: event.runId,
        sessionKey: event.sessionKey,
        sessionId: event.sessionId,
        kind: "llm",
        extensionId: event.providerPluginId ?? event.harnessId ?? event.provider,
        provider: event.provider,
        model: event.model,
        providerPluginId: event.providerPluginId,
        harnessId: event.harnessId,
        handlerRef: event.handlerRef,
        api: event.api,
        transport: event.transport,
        durationMs: event.durationMs,
        outcome: "error",
        callId: event.callId,
        metadata: {
          source: "diagnostics",
          errorCategory: event.errorCategory,
        },
        ...trace,
      });
      break;
    case "run.started":
      monitor.recordEvent({
        runId: event.runId,
        sessionKey: event.sessionKey,
        sessionId: event.sessionId,
        kind: "run",
        ...trace,
      });
      break;
    case "run.completed":
      monitor.recordEvent({
        runId: event.runId,
        sessionKey: event.sessionKey,
        sessionId: event.sessionId,
        kind: "run",
        durationMs: event.durationMs,
        outcome: event.outcome,
        ...trace,
      });
      monitor.finalizeRun({
        runId: event.runId,
        durationMs: event.durationMs,
        outcome: event.outcome,
      });
      break;
    case "harness.run.completed":
      monitor.recordEvent({
        runId: event.runId,
        sessionKey: event.sessionKey,
        sessionId: event.sessionId,
        kind: "harness",
        extensionId: event.pluginId ?? event.harnessId,
        durationMs: event.durationMs,
        outcome: event.outcome,
        metadata: {
          harnessId: event.harnessId,
        },
        ...trace,
      });
      break;
    case "harness.run.error":
      monitor.recordEvent({
        runId: event.runId,
        sessionKey: event.sessionKey,
        sessionId: event.sessionId,
        kind: "harness",
        extensionId: event.pluginId ?? event.harnessId,
        durationMs: event.durationMs,
        outcome: "error",
        metadata: {
          harnessId: event.harnessId,
          phase: event.phase,
          errorCategory: event.errorCategory,
        },
        ...trace,
      });
      break;
    default:
      break;
  }

  if (timingFields && options?.logTimingEvents !== false && options?.timingLogger) {
    logPerformanceTimingEvent(options.timingLogger, timingFields);
  }
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function createHttpHandler(monitor: PerformanceMonitor): OpenClawPluginHttpRouteHandler {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end("Method Not Allowed");
      return true;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (pathname === "/api/performance-monitor/report") {
      if (req.method === "HEAD") {
        res.statusCode = 200;
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return true;
      }
      writeJson(res, 200, monitor.getReport());
      return true;
    }

    const runMatch = pathname.match(/^\/api\/performance-monitor\/runs\/([^/]+)$/u);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1] ?? "");
      const trace = monitor.getRunTrace(runId);
      if (!trace) {
        writeJson(res, 404, { error: "run_not_found", runId });
        return true;
      }
      if (req.method === "HEAD") {
        res.statusCode = 200;
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return true;
      }
      writeJson(res, 200, trace);
      return true;
    }

    writeJson(res, 404, { error: "not_found" });
    return true;
  };
}

export function createPerformanceMonitorService(pluginConfig?: Record<string, unknown>): {
  monitor: PerformanceMonitor;
  handler: OpenClawPluginHttpRouteHandler;
  service: OpenClawPluginService;
} {
  const config = parsePluginConfig(pluginConfig);
  const monitor = createPerformanceMonitor(config);
  const timingLogger = config.logTimingEvents ? createPerformanceTimingLogger() : undefined;
  let unsubscribe: (() => void) | undefined;

  const service = {
    id: "performance-monitor",
    start(ctx) {
      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.warn(
          "performance-monitor: internal diagnostics unavailable; enable diagnostics.enabled",
        );
      } else {
        unsubscribe = subscribe((event, metadata) => {
          if (!shouldRecordDiagnosticEvent(metadata)) {
            return;
          }
          try {
            recordDiagnosticEvent(monitor, event, {
              timingLogger,
              logTimingEvents: config.logTimingEvents,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.logger.error(
              `performance-monitor: diagnostic handler failed (${event.type}): ${message}`,
            );
          }
        });
      }
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      monitor.reset();
    },
  } satisfies OpenClawPluginService;

  return {
    monitor,
    handler: createHttpHandler(monitor),
    service,
  };
}

export const testApi = {
  parsePluginConfig,
  recordDiagnosticEvent,
  shouldRecordDiagnosticEvent,
};

export { testApi as __test__ };
