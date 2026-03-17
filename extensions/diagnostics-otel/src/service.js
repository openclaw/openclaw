import { metrics, trace, SpanStatusCode } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  onDiagnosticEvent,
  redactSensitiveText,
  registerLogTransport
} from "openclaw/plugin-sdk/diagnostics-otel";
const DEFAULT_SERVICE_NAME = "openclaw";
function normalizeEndpoint(endpoint) {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : void 0;
}
function resolveOtelUrl(endpoint, path) {
  if (!endpoint) {
    return void 0;
  }
  const endpointWithoutQueryOrFragment = endpoint.split(/[?#]/, 1)[0] ?? endpoint;
  if (/\/v1\/(?:traces|metrics|logs)$/i.test(endpointWithoutQueryOrFragment)) {
    return endpoint;
  }
  return `${endpoint}/${path}`;
}
function resolveSampleRate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return void 0;
  }
  if (value < 0 || value > 1) {
    return void 0;
  }
  return value;
}
function formatError(err) {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
function redactOtelAttributes(attributes) {
  const redactedAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    redactedAttributes[key] = typeof value === "string" ? redactSensitiveText(value) : value;
  }
  return redactedAttributes;
}
function createDiagnosticsOtelService() {
  let sdk = null;
  let logProvider = null;
  let stopLogTransport = null;
  let unsubscribe = null;
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
      const headers = otel.headers ?? void 0;
      const serviceName = otel.serviceName?.trim() || process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
      const sampleRate = resolveSampleRate(otel.sampleRate);
      const tracesEnabled = otel.traces !== false;
      const metricsEnabled = otel.metrics !== false;
      const logsEnabled = otel.logs === true;
      if (!tracesEnabled && !metricsEnabled && !logsEnabled) {
        return;
      }
      const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName
      });
      const traceUrl = resolveOtelUrl(endpoint, "v1/traces");
      const metricUrl = resolveOtelUrl(endpoint, "v1/metrics");
      const logUrl = resolveOtelUrl(endpoint, "v1/logs");
      const traceExporter = tracesEnabled ? new OTLPTraceExporter({
        ...traceUrl ? { url: traceUrl } : {},
        ...headers ? { headers } : {}
      }) : void 0;
      const metricExporter = metricsEnabled ? new OTLPMetricExporter({
        ...metricUrl ? { url: metricUrl } : {},
        ...headers ? { headers } : {}
      }) : void 0;
      const metricReader = metricExporter ? new PeriodicExportingMetricReader({
        exporter: metricExporter,
        ...typeof otel.flushIntervalMs === "number" ? { exportIntervalMillis: Math.max(1e3, otel.flushIntervalMs) } : {}
      }) : void 0;
      if (tracesEnabled || metricsEnabled) {
        sdk = new NodeSDK({
          resource,
          ...traceExporter ? { traceExporter } : {},
          ...metricReader ? { metricReader } : {},
          ...sampleRate !== void 0 ? {
            sampler: new ParentBasedSampler({
              root: new TraceIdRatioBasedSampler(sampleRate)
            })
          } : {}
        });
        try {
          await sdk.start();
        } catch (err) {
          ctx.logger.error(`diagnostics-otel: failed to start SDK: ${formatError(err)}`);
          throw err;
        }
      }
      const logSeverityMap = {
        TRACE: 1,
        DEBUG: 5,
        INFO: 9,
        WARN: 13,
        ERROR: 17,
        FATAL: 21
      };
      const meter = metrics.getMeter("openclaw");
      const tracer = trace.getTracer("openclaw");
      const tokensCounter = meter.createCounter("openclaw.tokens", {
        unit: "1",
        description: "Token usage by type"
      });
      const costCounter = meter.createCounter("openclaw.cost.usd", {
        unit: "1",
        description: "Estimated model cost (USD)"
      });
      const durationHistogram = meter.createHistogram("openclaw.run.duration_ms", {
        unit: "ms",
        description: "Agent run duration"
      });
      const contextHistogram = meter.createHistogram("openclaw.context.tokens", {
        unit: "1",
        description: "Context window size and usage"
      });
      const webhookReceivedCounter = meter.createCounter("openclaw.webhook.received", {
        unit: "1",
        description: "Webhook requests received"
      });
      const webhookErrorCounter = meter.createCounter("openclaw.webhook.error", {
        unit: "1",
        description: "Webhook processing errors"
      });
      const webhookDurationHistogram = meter.createHistogram("openclaw.webhook.duration_ms", {
        unit: "ms",
        description: "Webhook processing duration"
      });
      const messageQueuedCounter = meter.createCounter("openclaw.message.queued", {
        unit: "1",
        description: "Messages queued for processing"
      });
      const messageProcessedCounter = meter.createCounter("openclaw.message.processed", {
        unit: "1",
        description: "Messages processed by outcome"
      });
      const messageDurationHistogram = meter.createHistogram("openclaw.message.duration_ms", {
        unit: "ms",
        description: "Message processing duration"
      });
      const queueDepthHistogram = meter.createHistogram("openclaw.queue.depth", {
        unit: "1",
        description: "Queue depth on enqueue/dequeue"
      });
      const queueWaitHistogram = meter.createHistogram("openclaw.queue.wait_ms", {
        unit: "ms",
        description: "Queue wait time before execution"
      });
      const laneEnqueueCounter = meter.createCounter("openclaw.queue.lane.enqueue", {
        unit: "1",
        description: "Command queue lane enqueue events"
      });
      const laneDequeueCounter = meter.createCounter("openclaw.queue.lane.dequeue", {
        unit: "1",
        description: "Command queue lane dequeue events"
      });
      const sessionStateCounter = meter.createCounter("openclaw.session.state", {
        unit: "1",
        description: "Session state transitions"
      });
      const sessionStuckCounter = meter.createCounter("openclaw.session.stuck", {
        unit: "1",
        description: "Sessions stuck in processing"
      });
      const sessionStuckAgeHistogram = meter.createHistogram("openclaw.session.stuck_age_ms", {
        unit: "ms",
        description: "Age of stuck sessions"
      });
      const runAttemptCounter = meter.createCounter("openclaw.run.attempt", {
        unit: "1",
        description: "Run attempts"
      });
      if (logsEnabled) {
        const logExporter = new OTLPLogExporter({
          ...logUrl ? { url: logUrl } : {},
          ...headers ? { headers } : {}
        });
        const logProcessor = new BatchLogRecordProcessor(
          logExporter,
          typeof otel.flushIntervalMs === "number" ? { scheduledDelayMillis: Math.max(1e3, otel.flushIntervalMs) } : {}
        );
        logProvider = new LoggerProvider({
          resource,
          processors: [logProcessor]
        });
        const otelLogger = logProvider.getLogger("openclaw");
        stopLogTransport = registerLogTransport((logObj) => {
          try {
            const safeStringify = (value) => {
              try {
                return JSON.stringify(value);
              } catch {
                return String(value);
              }
            };
            const meta = logObj._meta;
            const logLevelName = meta?.logLevelName ?? "INFO";
            const severityNumber = logSeverityMap[logLevelName] ?? 9;
            const numericArgs = Object.entries(logObj).filter(([key]) => /^\d+$/.test(key)).toSorted((a, b) => Number(a[0]) - Number(b[0])).map(([, value]) => value);
            let bindings;
            if (typeof numericArgs[0] === "string" && numericArgs[0].trim().startsWith("{")) {
              try {
                const parsed = JSON.parse(numericArgs[0]);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  bindings = parsed;
                  numericArgs.shift();
                }
              } catch {
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
            const attributes = {
              "openclaw.log.level": logLevelName
            };
            if (meta?.name) {
              attributes["openclaw.logger"] = meta.name;
            }
            if (meta?.parentNames?.length) {
              attributes["openclaw.logger.parents"] = meta.parentNames.join(".");
            }
            if (bindings) {
              for (const [key, value] of Object.entries(bindings)) {
                if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
                  attributes[`openclaw.${key}`] = value;
                } else if (value != null) {
                  attributes[`openclaw.${key}`] = safeStringify(value);
                }
              }
            }
            if (numericArgs.length > 0) {
              attributes["openclaw.log.args"] = safeStringify(numericArgs);
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
              attributes["openclaw.code.location"] = meta.path.filePathWithLine;
            }
            otelLogger.emit({
              body: redactSensitiveText(message),
              severityText: logLevelName,
              severityNumber,
              attributes: redactOtelAttributes(attributes),
              timestamp: meta?.date ?? /* @__PURE__ */ new Date()
            });
          } catch (err) {
            ctx.logger.error(`diagnostics-otel: log transport failed: ${formatError(err)}`);
          }
        });
      }
      const spanWithDuration = (name, attributes, durationMs) => {
        const startTime = typeof durationMs === "number" ? Date.now() - Math.max(0, durationMs) : void 0;
        const span = tracer.startSpan(name, {
          attributes,
          ...startTime ? { startTime } : {}
        });
        return span;
      };
      const recordModelUsage = (evt) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.provider": evt.provider ?? "unknown",
          "openclaw.model": evt.model ?? "unknown"
        };
        const usage = evt.usage;
        if (usage.input) {
          tokensCounter.add(usage.input, { ...attrs, "openclaw.token": "input" });
        }
        if (usage.output) {
          tokensCounter.add(usage.output, { ...attrs, "openclaw.token": "output" });
        }
        if (usage.cacheRead) {
          tokensCounter.add(usage.cacheRead, { ...attrs, "openclaw.token": "cache_read" });
        }
        if (usage.cacheWrite) {
          tokensCounter.add(usage.cacheWrite, { ...attrs, "openclaw.token": "cache_write" });
        }
        if (usage.promptTokens) {
          tokensCounter.add(usage.promptTokens, { ...attrs, "openclaw.token": "prompt" });
        }
        if (usage.total) {
          tokensCounter.add(usage.total, { ...attrs, "openclaw.token": "total" });
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
            "openclaw.context": "limit"
          });
        }
        if (evt.context?.used) {
          contextHistogram.record(evt.context.used, {
            ...attrs,
            "openclaw.context": "used"
          });
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs = {
          ...attrs,
          "openclaw.sessionKey": evt.sessionKey ?? "",
          "openclaw.sessionId": evt.sessionId ?? "",
          "openclaw.tokens.input": usage.input ?? 0,
          "openclaw.tokens.output": usage.output ?? 0,
          "openclaw.tokens.cache_read": usage.cacheRead ?? 0,
          "openclaw.tokens.cache_write": usage.cacheWrite ?? 0,
          "openclaw.tokens.total": usage.total ?? 0
        };
        const span = spanWithDuration("openclaw.model.usage", spanAttrs, evt.durationMs);
        span.end();
      };
      const recordWebhookReceived = (evt) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown"
        };
        webhookReceivedCounter.add(1, attrs);
      };
      const recordWebhookProcessed = (evt) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown"
        };
        if (typeof evt.durationMs === "number") {
          webhookDurationHistogram.record(evt.durationMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs = { ...attrs };
        if (evt.chatId !== void 0) {
          spanAttrs["openclaw.chatId"] = String(evt.chatId);
        }
        const span = spanWithDuration("openclaw.webhook.processed", spanAttrs, evt.durationMs);
        span.end();
      };
      const recordWebhookError = (evt) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown"
        };
        webhookErrorCounter.add(1, attrs);
        if (!tracesEnabled) {
          return;
        }
        const redactedError = redactSensitiveText(evt.error);
        const spanAttrs = {
          ...attrs,
          "openclaw.error": redactedError
        };
        if (evt.chatId !== void 0) {
          spanAttrs["openclaw.chatId"] = String(evt.chatId);
        }
        const span = tracer.startSpan("openclaw.webhook.error", {
          attributes: spanAttrs
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: redactedError });
        span.end();
      };
      const recordMessageQueued = (evt) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.source": evt.source ?? "unknown"
        };
        messageQueuedCounter.add(1, attrs);
        if (typeof evt.queueDepth === "number") {
          queueDepthHistogram.record(evt.queueDepth, attrs);
        }
      };
      const addSessionIdentityAttrs = (spanAttrs, evt) => {
        if (evt.sessionKey) {
          spanAttrs["openclaw.sessionKey"] = evt.sessionKey;
        }
        if (evt.sessionId) {
          spanAttrs["openclaw.sessionId"] = evt.sessionId;
        }
      };
      const recordMessageProcessed = (evt) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.outcome": evt.outcome ?? "unknown"
        };
        messageProcessedCounter.add(1, attrs);
        if (typeof evt.durationMs === "number") {
          messageDurationHistogram.record(evt.durationMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs = { ...attrs };
        addSessionIdentityAttrs(spanAttrs, evt);
        if (evt.chatId !== void 0) {
          spanAttrs["openclaw.chatId"] = String(evt.chatId);
        }
        if (evt.messageId !== void 0) {
          spanAttrs["openclaw.messageId"] = String(evt.messageId);
        }
        if (evt.reason) {
          spanAttrs["openclaw.reason"] = redactSensitiveText(evt.reason);
        }
        const span = spanWithDuration("openclaw.message.processed", spanAttrs, evt.durationMs);
        if (evt.outcome === "error" && evt.error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: redactSensitiveText(evt.error) });
        }
        span.end();
      };
      const recordLaneEnqueue = (evt) => {
        const attrs = { "openclaw.lane": evt.lane };
        laneEnqueueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
      };
      const recordLaneDequeue = (evt) => {
        const attrs = { "openclaw.lane": evt.lane };
        laneDequeueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
        if (typeof evt.waitMs === "number") {
          queueWaitHistogram.record(evt.waitMs, attrs);
        }
      };
      const recordSessionState = (evt) => {
        const attrs = { "openclaw.state": evt.state };
        if (evt.reason) {
          attrs["openclaw.reason"] = redactSensitiveText(evt.reason);
        }
        sessionStateCounter.add(1, attrs);
      };
      const recordSessionStuck = (evt) => {
        const attrs = { "openclaw.state": evt.state };
        sessionStuckCounter.add(1, attrs);
        if (typeof evt.ageMs === "number") {
          sessionStuckAgeHistogram.record(evt.ageMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs = { ...attrs };
        addSessionIdentityAttrs(spanAttrs, evt);
        spanAttrs["openclaw.queueDepth"] = evt.queueDepth ?? 0;
        spanAttrs["openclaw.ageMs"] = evt.ageMs;
        const span = tracer.startSpan("openclaw.session.stuck", { attributes: spanAttrs });
        span.setStatus({ code: SpanStatusCode.ERROR, message: "session stuck" });
        span.end();
      };
      const recordRunAttempt = (evt) => {
        runAttemptCounter.add(1, { "openclaw.attempt": evt.attempt });
      };
      const recordHeartbeat = (evt) => {
        queueDepthHistogram.record(evt.queued, { "openclaw.channel": "heartbeat" });
      };
      unsubscribe = onDiagnosticEvent((evt) => {
        try {
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
        } catch (err) {
          ctx.logger.error(
            `diagnostics-otel: event handler failed (${evt.type}): ${formatError(err)}`
          );
        }
      });
      if (logsEnabled) {
        ctx.logger.info("diagnostics-otel: logs exporter enabled (OTLP/Protobuf)");
      }
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      stopLogTransport?.();
      stopLogTransport = null;
      if (logProvider) {
        await logProvider.shutdown().catch(() => void 0);
        logProvider = null;
      }
      if (sdk) {
        await sdk.shutdown().catch(() => void 0);
        sdk = null;
      }
    }
  };
}
export {
  createDiagnosticsOtelService
};
