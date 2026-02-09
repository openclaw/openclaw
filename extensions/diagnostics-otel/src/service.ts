import type { SeverityNumber } from "@opentelemetry/api-logs";
import type { DiagnosticEventPayload, EasyHubPluginService } from "EasyHub/plugin-sdk";
import { metrics, trace, SpanStatusCode } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { onDiagnosticEvent, registerLogTransport } from "EasyHub/plugin-sdk";

const DEFAULT_SERVICE_NAME = "EasyHub";

function normalizeEndpoint(endpoint?: string): string | undefined {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function resolveOtelUrl(endpoint: string | undefined, path: string): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  if (endpoint.includes("/v1/")) {
    return endpoint;
  }
  return `${endpoint}/${path}`;
}

function resolveSampleRate(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

export function createDiagnosticsOtelService(): EasyHubPluginService {
  let sdk: NodeSDK | null = null;
  let logProvider: LoggerProvider | null = null;
  let stopLogTransport: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    id: "diagnostics-otel",
    async start(ctx) {
      const cfg = ctx.config.diagnostics;
      const otel = cfg?.otel;
      if (!cfg?.enabled || !otel?.enabled) {
        return;
      }

      const protocol = otel.protocol ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf";
      if (protocol !== "http/protobuf") {
        ctx.logger.warn(`diagnostics-otel: unsupported protocol ${protocol}`);
        return;
      }

      const endpoint = normalizeEndpoint(otel.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
      const headers = otel.headers ?? undefined;
      const serviceName =
        otel.serviceName?.trim() || process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
      const sampleRate = resolveSampleRate(otel.sampleRate);

      const tracesEnabled = otel.traces !== false;
      const metricsEnabled = otel.metrics !== false;
      const logsEnabled = otel.logs === true;
      if (!tracesEnabled && !metricsEnabled && !logsEnabled) {
        return;
      }

      const resource = new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      });

      const traceUrl = resolveOtelUrl(endpoint, "v1/traces");
      const metricUrl = resolveOtelUrl(endpoint, "v1/metrics");
      const logUrl = resolveOtelUrl(endpoint, "v1/logs");
      const traceExporter = tracesEnabled
        ? new OTLPTraceExporter({
            ...(traceUrl ? { url: traceUrl } : {}),
            ...(headers ? { headers } : {}),
          })
        : undefined;

      const metricExporter = metricsEnabled
        ? new OTLPMetricExporter({
            ...(metricUrl ? { url: metricUrl } : {}),
            ...(headers ? { headers } : {}),
          })
        : undefined;

      const metricReader = metricExporter
        ? new PeriodicExportingMetricReader({
            exporter: metricExporter,
            ...(typeof otel.flushIntervalMs === "number"
              ? { exportIntervalMillis: Math.max(1000, otel.flushIntervalMs) }
              : {}),
          })
        : undefined;

      if (tracesEnabled || metricsEnabled) {
        sdk = new NodeSDK({
          resource,
          ...(traceExporter ? { traceExporter } : {}),
          ...(metricReader ? { metricReader } : {}),
          ...(sampleRate !== undefined
            ? {
                sampler: new ParentBasedSampler({
                  root: new TraceIdRatioBasedSampler(sampleRate),
                }),
              }
            : {}),
        });

        sdk.start();
      }

      const logSeverityMap: Record<string, SeverityNumber> = {
        TRACE: 1 as SeverityNumber,
        DEBUG: 5 as SeverityNumber,
        INFO: 9 as SeverityNumber,
        WARN: 13 as SeverityNumber,
        ERROR: 17 as SeverityNumber,
        FATAL: 21 as SeverityNumber,
      };

      const meter = metrics.getMeter("EasyHub");
      const tracer = trace.getTracer("EasyHub");

      const tokensCounter = meter.createCounter("EasyHub.tokens", {
        unit: "1",
        description: "Token usage by type",
      });
      const costCounter = meter.createCounter("EasyHub.cost.usd", {
        unit: "1",
        description: "Estimated model cost (USD)",
      });
      const durationHistogram = meter.createHistogram("EasyHub.run.duration_ms", {
        unit: "ms",
        description: "Agent run duration",
      });
      const contextHistogram = meter.createHistogram("EasyHub.context.tokens", {
        unit: "1",
        description: "Context window size and usage",
      });
      const webhookReceivedCounter = meter.createCounter("EasyHub.webhook.received", {
        unit: "1",
        description: "Webhook requests received",
      });
      const webhookErrorCounter = meter.createCounter("EasyHub.webhook.error", {
        unit: "1",
        description: "Webhook processing errors",
      });
      const webhookDurationHistogram = meter.createHistogram("EasyHub.webhook.duration_ms", {
        unit: "ms",
        description: "Webhook processing duration",
      });
      const messageQueuedCounter = meter.createCounter("EasyHub.message.queued", {
        unit: "1",
        description: "Messages queued for processing",
      });
      const messageProcessedCounter = meter.createCounter("EasyHub.message.processed", {
        unit: "1",
        description: "Messages processed by outcome",
      });
      const messageDurationHistogram = meter.createHistogram("EasyHub.message.duration_ms", {
        unit: "ms",
        description: "Message processing duration",
      });
      const queueDepthHistogram = meter.createHistogram("EasyHub.queue.depth", {
        unit: "1",
        description: "Queue depth on enqueue/dequeue",
      });
      const queueWaitHistogram = meter.createHistogram("EasyHub.queue.wait_ms", {
        unit: "ms",
        description: "Queue wait time before execution",
      });
      const laneEnqueueCounter = meter.createCounter("EasyHub.queue.lane.enqueue", {
        unit: "1",
        description: "Command queue lane enqueue events",
      });
      const laneDequeueCounter = meter.createCounter("EasyHub.queue.lane.dequeue", {
        unit: "1",
        description: "Command queue lane dequeue events",
      });
      const sessionStateCounter = meter.createCounter("EasyHub.session.state", {
        unit: "1",
        description: "Session state transitions",
      });
      const sessionStuckCounter = meter.createCounter("EasyHub.session.stuck", {
        unit: "1",
        description: "Sessions stuck in processing",
      });
      const sessionStuckAgeHistogram = meter.createHistogram("EasyHub.session.stuck_age_ms", {
        unit: "ms",
        description: "Age of stuck sessions",
      });
      const runAttemptCounter = meter.createCounter("EasyHub.run.attempt", {
        unit: "1",
        description: "Run attempts",
      });

      if (logsEnabled) {
        const logExporter = new OTLPLogExporter({
          ...(logUrl ? { url: logUrl } : {}),
          ...(headers ? { headers } : {}),
        });
        logProvider = new LoggerProvider({ resource });
        logProvider.addLogRecordProcessor(
          new BatchLogRecordProcessor(
            logExporter,
            typeof otel.flushIntervalMs === "number"
              ? { scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs) }
              : {},
          ),
        );
        const otelLogger = logProvider.getLogger("EasyHub");

        stopLogTransport = registerLogTransport((logObj) => {
          const safeStringify = (value: unknown) => {
            try {
              return JSON.stringify(value);
            } catch {
              return String(value);
            }
          };
          const meta = (logObj as Record<string, unknown>)._meta as
            | {
                logLevelName?: string;
                date?: Date;
                name?: string;
                parentNames?: string[];
                path?: {
                  filePath?: string;
                  fileLine?: string;
                  fileColumn?: string;
                  filePathWithLine?: string;
                  method?: string;
                };
              }
            | undefined;
          const logLevelName = meta?.logLevelName ?? "INFO";
          const severityNumber = logSeverityMap[logLevelName] ?? (9 as SeverityNumber);

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
              // ignore malformed json bindings
            }
          }

          let message = "";
          if (numericArgs.length > 0 && typeof numericArgs[numericArgs.length - 1] === "string") {
            message = String(numericArgs.pop());
          } else if (numericArgs.length === 1) {
            message = safeStringify(numericArgs[0]);
            numericArgs.length = 0;
          }
          if (!message) {
            message = "log";
          }

          const attributes: Record<string, string | number | boolean> = {
            "easyhub.log.level": logLevelName,
          };
          if (meta?.name) {
            attributes["easyhub.logger"] = meta.name;
          }
          if (meta?.parentNames?.length) {
            attributes["easyhub.logger.parents"] = meta.parentNames.join(".");
          }
          if (bindings) {
            for (const [key, value] of Object.entries(bindings)) {
              if (
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean"
              ) {
                attributes[`EasyHub.${key}`] = value;
              } else if (value != null) {
                attributes[`EasyHub.${key}`] = safeStringify(value);
              }
            }
          }
          if (numericArgs.length > 0) {
            attributes["easyhub.log.args"] = safeStringify(numericArgs);
          }
          if (meta?.path?.filePath) {
            attributes["code.filepath"] = meta.path.filePath;
          }
          if (meta?.path?.fileLine) {
            attributes["code.lineno"] = Number(meta.path.fileLine);
          }
          if (meta?.path?.method) {
            attributes["code.function"] = meta.path.method;
          }
          if (meta?.path?.filePathWithLine) {
            attributes["EasyHub.code.location"] = meta.path.filePathWithLine;
          }

          otelLogger.emit({
            body: message,
            severityText: logLevelName,
            severityNumber,
            attributes,
            timestamp: meta?.date ?? new Date(),
          });
        });
      }

      const spanWithDuration = (
        name: string,
        attributes: Record<string, string | number>,
        durationMs?: number,
      ) => {
        const startTime =
          typeof durationMs === "number" ? Date.now() - Math.max(0, durationMs) : undefined;
        const span = tracer.startSpan(name, {
          attributes,
          ...(startTime ? { startTime } : {}),
        });
        return span;
      };

      const recordModelUsage = (evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>) => {
        const attrs = {
          "EasyHub.channel": evt.channel ?? "unknown",
          "EasyHub.provider": evt.provider ?? "unknown",
          "EasyHub.model": evt.model ?? "unknown",
        };

        const usage = evt.usage;
        if (usage.input) {
          tokensCounter.add(usage.input, { ...attrs, "EasyHub.token": "input" });
        }
        if (usage.output) {
          tokensCounter.add(usage.output, { ...attrs, "EasyHub.token": "output" });
        }
        if (usage.cacheRead) {
          tokensCounter.add(usage.cacheRead, { ...attrs, "EasyHub.token": "cache_read" });
        }
        if (usage.cacheWrite) {
          tokensCounter.add(usage.cacheWrite, { ...attrs, "EasyHub.token": "cache_write" });
        }
        if (usage.promptTokens) {
          tokensCounter.add(usage.promptTokens, { ...attrs, "EasyHub.token": "prompt" });
        }
        if (usage.total) {
          tokensCounter.add(usage.total, { ...attrs, "EasyHub.token": "total" });
        }

        if (evt.costUsd) {
          costCounter.add(evt.costUsd, attrs);
        }
        if (evt.durationMs) {
          durationHistogram.record(evt.durationMs, attrs);
        }
        if (evt.context?.limit) {
          contextHistogram.record(evt.context.limit, {
            ...attrs,
            "EasyHub.context": "limit",
          });
        }
        if (evt.context?.used) {
          contextHistogram.record(evt.context.used, {
            ...attrs,
            "EasyHub.context": "used",
          });
        }

        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "EasyHub.sessionKey": evt.sessionKey ?? "",
          "EasyHub.sessionId": evt.sessionId ?? "",
          "EasyHub.tokens.input": usage.input ?? 0,
          "EasyHub.tokens.output": usage.output ?? 0,
          "EasyHub.tokens.cache_read": usage.cacheRead ?? 0,
          "EasyHub.tokens.cache_write": usage.cacheWrite ?? 0,
          "EasyHub.tokens.total": usage.total ?? 0,
        };

        const span = spanWithDuration("EasyHub.model.usage", spanAttrs, evt.durationMs);
        span.end();
      };

      const recordWebhookReceived = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.received" }>,
      ) => {
        const attrs = {
          "EasyHub.channel": evt.channel ?? "unknown",
          "EasyHub.webhook": evt.updateType ?? "unknown",
        };
        webhookReceivedCounter.add(1, attrs);
      };

      const recordWebhookProcessed = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.processed" }>,
      ) => {
        const attrs = {
          "EasyHub.channel": evt.channel ?? "unknown",
          "EasyHub.webhook": evt.updateType ?? "unknown",
        };
        if (typeof evt.durationMs === "number") {
          webhookDurationHistogram.record(evt.durationMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.chatId !== undefined) {
          spanAttrs["EasyHub.chatId"] = String(evt.chatId);
        }
        const span = spanWithDuration("EasyHub.webhook.processed", spanAttrs, evt.durationMs);
        span.end();
      };

      const recordWebhookError = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.error" }>,
      ) => {
        const attrs = {
          "EasyHub.channel": evt.channel ?? "unknown",
          "EasyHub.webhook": evt.updateType ?? "unknown",
        };
        webhookErrorCounter.add(1, attrs);
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "EasyHub.error": evt.error,
        };
        if (evt.chatId !== undefined) {
          spanAttrs["EasyHub.chatId"] = String(evt.chatId);
        }
        const span = tracer.startSpan("EasyHub.webhook.error", {
          attributes: spanAttrs,
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
        span.end();
      };

      const recordMessageQueued = (
        evt: Extract<DiagnosticEventPayload, { type: "message.queued" }>,
      ) => {
        const attrs = {
          "EasyHub.channel": evt.channel ?? "unknown",
          "EasyHub.source": evt.source ?? "unknown",
        };
        messageQueuedCounter.add(1, attrs);
        if (typeof evt.queueDepth === "number") {
          queueDepthHistogram.record(evt.queueDepth, attrs);
        }
      };

      const recordMessageProcessed = (
        evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
      ) => {
        const attrs = {
          "EasyHub.channel": evt.channel ?? "unknown",
          "EasyHub.outcome": evt.outcome ?? "unknown",
        };
        messageProcessedCounter.add(1, attrs);
        if (typeof evt.durationMs === "number") {
          messageDurationHistogram.record(evt.durationMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.sessionKey) {
          spanAttrs["EasyHub.sessionKey"] = evt.sessionKey;
        }
        if (evt.sessionId) {
          spanAttrs["EasyHub.sessionId"] = evt.sessionId;
        }
        if (evt.chatId !== undefined) {
          spanAttrs["EasyHub.chatId"] = String(evt.chatId);
        }
        if (evt.messageId !== undefined) {
          spanAttrs["EasyHub.messageId"] = String(evt.messageId);
        }
        if (evt.reason) {
          spanAttrs["EasyHub.reason"] = evt.reason;
        }
        const span = spanWithDuration("EasyHub.message.processed", spanAttrs, evt.durationMs);
        if (evt.outcome === "error") {
          span.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
        }
        span.end();
      };

      const recordLaneEnqueue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.enqueue" }>,
      ) => {
        const attrs = { "EasyHub.lane": evt.lane };
        laneEnqueueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
      };

      const recordLaneDequeue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.dequeue" }>,
      ) => {
        const attrs = { "EasyHub.lane": evt.lane };
        laneDequeueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
        if (typeof evt.waitMs === "number") {
          queueWaitHistogram.record(evt.waitMs, attrs);
        }
      };

      const recordSessionState = (
        evt: Extract<DiagnosticEventPayload, { type: "session.state" }>,
      ) => {
        const attrs: Record<string, string> = { "EasyHub.state": evt.state };
        if (evt.reason) {
          attrs["EasyHub.reason"] = evt.reason;
        }
        sessionStateCounter.add(1, attrs);
      };

      const recordSessionStuck = (
        evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>,
      ) => {
        const attrs: Record<string, string> = { "EasyHub.state": evt.state };
        sessionStuckCounter.add(1, attrs);
        if (typeof evt.ageMs === "number") {
          sessionStuckAgeHistogram.record(evt.ageMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.sessionKey) {
          spanAttrs["EasyHub.sessionKey"] = evt.sessionKey;
        }
        if (evt.sessionId) {
          spanAttrs["EasyHub.sessionId"] = evt.sessionId;
        }
        spanAttrs["EasyHub.queueDepth"] = evt.queueDepth ?? 0;
        spanAttrs["EasyHub.ageMs"] = evt.ageMs;
        const span = tracer.startSpan("EasyHub.session.stuck", { attributes: spanAttrs });
        span.setStatus({ code: SpanStatusCode.ERROR, message: "session stuck" });
        span.end();
      };

      const recordRunAttempt = (evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>) => {
        runAttemptCounter.add(1, { "EasyHub.attempt": evt.attempt });
      };

      const recordHeartbeat = (
        evt: Extract<DiagnosticEventPayload, { type: "diagnostic.heartbeat" }>,
      ) => {
        queueDepthHistogram.record(evt.queued, { "EasyHub.channel": "heartbeat" });
      };

      unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        switch (evt.type) {
          case "model.usage":
            recordModelUsage(evt);
            return;
          case "webhook.received":
            recordWebhookReceived(evt);
            return;
          case "webhook.processed":
            recordWebhookProcessed(evt);
            return;
          case "webhook.error":
            recordWebhookError(evt);
            return;
          case "message.queued":
            recordMessageQueued(evt);
            return;
          case "message.processed":
            recordMessageProcessed(evt);
            return;
          case "queue.lane.enqueue":
            recordLaneEnqueue(evt);
            return;
          case "queue.lane.dequeue":
            recordLaneDequeue(evt);
            return;
          case "session.state":
            recordSessionState(evt);
            return;
          case "session.stuck":
            recordSessionStuck(evt);
            return;
          case "run.attempt":
            recordRunAttempt(evt);
            return;
          case "diagnostic.heartbeat":
            recordHeartbeat(evt);
            return;
        }
      });

      if (logsEnabled) {
        ctx.logger.info("diagnostics-otel: logs exporter enabled (OTLP/HTTP)");
      }
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      stopLogTransport?.();
      stopLogTransport = null;
      if (logProvider) {
        await logProvider.shutdown().catch(() => undefined);
        logProvider = null;
      }
      if (sdk) {
        await sdk.shutdown().catch(() => undefined);
        sdk = null;
      }
    },
  } satisfies EasyHubPluginService;
}
