import type { LogRecord, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import type { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  assignOtelLogAttribute,
  assignOtelLogEventAttributes,
  assignOtelSecurityAttributes,
  redactOtelAttributes,
  securitySeverityText,
  writeStdoutDiagnosticLogRecord,
} from "./service-attributes.js";
import {
  LOG_RECORD_EXPORT_FAILURE_REPORT_INTERVAL_MS,
  MAX_OTEL_LOG_BODY_CHARS,
} from "./service-constants.js";
import { normalizeOtelLogString } from "./service-content-normalization.js";
import { observeOtlpExporterHealth, type ExporterHealthUpdate } from "./service-exporter-health.js";
import { errorCategory, formatError } from "./service-exporter.js";
import { contextForTraceContext, normalizedTrustedTraceContext } from "./service-trace-context.js";
import type { OtelHttpAgentFactory, OtelHttpAgentOptions, OtelLogger } from "./service-types.js";

const LOG_SEVERITY_MAP: Record<string, SeverityNumber> = {
  TRACE: 1 as SeverityNumber,
  DEBUG: 5 as SeverityNumber,
  INFO: 9 as SeverityNumber,
  WARN: 13 as SeverityNumber,
  ERROR: 17 as SeverityNumber,
  FATAL: 21 as SeverityNumber,
};

export function createDiagnosticsLogExporter(params: {
  captureContent: boolean;
  emitExporterEvent: (event: ExporterHealthUpdate) => void;
  flushIntervalMs?: number;
  headers?: Record<string, string>;
  logger: OtelLogger;
  logsToOtlp: boolean;
  logsToStdout: boolean;
  logHttpAgentOptions?: OtelHttpAgentFactory | OtelHttpAgentOptions;
  logUrl?: string;
  resource: Resource;
  serviceName: string;
}) {
  const {
    captureContent,
    emitExporterEvent,
    flushIntervalMs,
    headers,
    logger,
    logsToOtlp,
    logsToStdout,
    logHttpAgentOptions,
    logUrl,
    resource,
    serviceName,
  } = params;
  let logProvider: LoggerProvider | null = null;
  if (!logsToOtlp && !logsToStdout) {
    return { logProvider, recordLogEvent: undefined };
  }
  let logRecordExportFailureLastReportedAt = Number.NEGATIVE_INFINITY;
  let otelLogger: { emit: (logRecord: LogRecord) => void } | undefined;
  const activeTransports: ExporterHealthUpdate["transport"][] = [
    ...(logsToOtlp ? (["otlp-http-protobuf"] as const) : []),
    ...(logsToStdout ? (["stdout"] as const) : []),
  ];
  if (logsToOtlp) {
    const logExporter = observeOtlpExporterHealth(
      new OTLPLogExporter({
        ...(logUrl ? { url: logUrl } : {}),
        ...(headers ? { headers } : {}),
        ...(logHttpAgentOptions ? { httpAgentOptions: logHttpAgentOptions } : {}),
      }),
      { emitExporterEvent, signal: "logs" },
    );
    const logProcessor = new BatchLogRecordProcessor({
      exporter: logExporter,
      ...(typeof flushIntervalMs === "number"
        ? { scheduledDelayMillis: Math.max(1000, flushIntervalMs) }
        : {}),
    });
    logProvider = new LoggerProvider({
      resource,
      processors: [logProcessor],
    });
    otelLogger = logProvider.getLogger("openclaw");
  }

  const reportLogExportFailure = (
    err: unknown,
    label: "log record" | "security event",
    transport: ExporterHealthUpdate["transport"],
  ) => {
    emitExporterEvent({
      exporter: "diagnostics-otel",
      signal: "logs",
      transport,
      status: "failure",
      reason: "emit_failed",
      errorCategory: errorCategory(err),
    });
    const now = Date.now();
    if (
      now - logRecordExportFailureLastReportedAt >=
      LOG_RECORD_EXPORT_FAILURE_REPORT_INTERVAL_MS
    ) {
      logRecordExportFailureLastReportedAt = now;
      logger.error(`diagnostics-otel: ${label} export failed: ${formatError(err)}`);
    }
  };
  const recordLogEvent = (
    evt: Extract<DiagnosticEventPayload, { type: "log.record" | "security.event" }>,
    metadata: DiagnosticEventMetadata,
  ) => {
    if (evt.type === "security.event" && !metadata.trusted) {
      return;
    }
    const label = evt.type === "log.record" ? "log record" : "security event";
    try {
      const attributes = Object.create(null) as Record<string, string | number | boolean>;
      let severityText: string;
      let body: string;
      if (evt.type === "log.record") {
        severityText = evt.level || "INFO";
        body = captureContent
          ? normalizeOtelLogString(evt.message || "log", MAX_OTEL_LOG_BODY_CHARS)
          : "log";
        assignOtelLogAttribute(attributes, "openclaw.log.level", severityText);
        if (evt.loggerName) {
          assignOtelLogAttribute(attributes, "openclaw.logger", evt.loggerName);
        }
        if (evt.loggerParents?.length) {
          assignOtelLogAttribute(
            attributes,
            "openclaw.logger.parents",
            evt.loggerParents.join("."),
          );
        }
        assignOtelLogEventAttributes(attributes, evt.attributes);
        if (evt.code?.line) {
          assignOtelLogAttribute(attributes, "code.lineno", evt.code.line);
        }
        if (evt.code?.functionName) {
          assignOtelLogAttribute(attributes, "code.function", evt.code.functionName);
        }
      } else {
        severityText = securitySeverityText(evt.severity);
        body = "openclaw.security.event";
        assignOtelSecurityAttributes(attributes, evt);
      }
      const traceContext = normalizedTrustedTraceContext(evt, metadata);
      if (evt.type === "log.record" && traceContext?.traceFlags) {
        attributes["openclaw.traceFlags"] = traceContext.traceFlags;
      }
      const logRecord: LogRecord = {
        body,
        severityText,
        severityNumber: LOG_SEVERITY_MAP[severityText] ?? (9 as SeverityNumber),
        attributes: redactOtelAttributes(attributes),
        timestamp: evt.ts,
      };
      const logContext = contextForTraceContext(traceContext);
      if (logContext) {
        logRecord.context = logContext;
      }
      for (const transport of activeTransports) {
        try {
          if (transport === "otlp-http-protobuf") {
            otelLogger?.emit(logRecord);
          } else {
            writeStdoutDiagnosticLogRecord({
              logRecord,
              serviceName,
              ...(traceContext ? { traceContext } : {}),
            });
          }
          emitExporterEvent({
            exporter: "diagnostics-otel",
            signal: "logs",
            transport,
            status: "recovered",
            reason: "emit_failed",
          });
        } catch (error) {
          reportLogExportFailure(error, label, transport);
        }
      }
    } catch (err) {
      for (const transport of activeTransports) {
        reportLogExportFailure(err, label, transport);
      }
    }
  };
  return { logProvider, recordLogEvent };
}
