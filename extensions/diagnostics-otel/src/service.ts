import type { SeverityNumber } from "@opentelemetry/api-logs";
import type {
  AgentEventPayload,
  DiagnosticEventPayload,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { context, metrics, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { onAgentEvent, onDiagnosticEvent, registerLogTransport } from "openclaw/plugin-sdk";

interface ActiveTrace {
  span: Span;
  startedAt: number;
  sessionKey?: string;
  channel?: string;
  agentId?: string;
}

// GenAI semantic convention attribute names (based on OpenTelemetry GenAI spec)
const GENAI_ATTRS = {
  // System and model
  SYSTEM: "gen_ai.system",
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",

  // Token usage
  INPUT_TOKENS: "gen_ai.usage.input_tokens",
  OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  TOTAL_TOKENS: "gen_ai.usage.total_tokens",

  // Prompts and completions
  PROMPT: "gen_ai.prompt",
  COMPLETION: "gen_ai.completion",

  // Session and user (OpenTelemetry semantic conventions)
  SESSION_ID: "session.id",
  USER_ID: "enduser.id", // OpenTelemetry standard

  // MLflow-specific (for MLflow UI columns)
  MLFLOW_TRACE_SESSION: "mlflow.trace.session",
  MLFLOW_TRACE_USER: "mlflow.trace.user",
  MLFLOW_SPAN_INPUTS: "mlflow.spanInputs",
  MLFLOW_SPAN_OUTPUTS: "mlflow.spanOutputs",

  // OpenClaw-specific
  OPENCLAW_SESSION_KEY: "openclaw.session_key",
  OPENCLAW_AGENT_ID: "openclaw.agent_id",
  OPENCLAW_CHANNEL: "openclaw.channel",
  OPENCLAW_SOURCE: "openclaw.source",
  OPENCLAW_QUEUE_DEPTH: "openclaw.queue_depth",
} as const;

const DEFAULT_SERVICE_NAME = "openclaw";

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

export function createDiagnosticsOtelService(): OpenClawPluginService {
  let sdk: NodeSDK | null = null;
  let logProvider: LoggerProvider | null = null;
  let stopLogTransport: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeAgentEvents: (() => void) | null = null;

  // Active traces for nested span hierarchy (message → llm → tools)
  const activeTraces = new Map<string, ActiveTrace>();
  const activeSpans = new Map<string, Span>(); // toolCallId -> span

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

      const resource = resourceFromAttributes({
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
        const spanProcessors = traceExporter
          ? [
              new BatchSpanProcessor(traceExporter, {
                scheduledDelayMillis: otel.flushIntervalMs || 5000,
              }),
            ]
          : undefined;

        sdk = new NodeSDK({
          resource,
          ...(spanProcessors ? { spanProcessors } : {}),
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
        ctx.logger.info(
          `diagnostics-otel: SDK started (traces=${tracesEnabled}, metrics=${metricsEnabled}, endpoint=${endpoint})`,
        );
      }

      const logSeverityMap: Record<string, SeverityNumber> = {
        TRACE: 1 as SeverityNumber,
        DEBUG: 5 as SeverityNumber,
        INFO: 9 as SeverityNumber,
        WARN: 13 as SeverityNumber,
        ERROR: 17 as SeverityNumber,
        FATAL: 21 as SeverityNumber,
      };

      const meter = metrics.getMeter("openclaw");
      const tracer = trace.getTracer("openclaw");

      const tokensCounter = meter.createCounter("openclaw.tokens", {
        unit: "1",
        description: "Token usage by type",
      });
      const costCounter = meter.createCounter("openclaw.cost.usd", {
        unit: "1",
        description: "Estimated model cost (USD)",
      });
      const durationHistogram = meter.createHistogram("openclaw.run.duration_ms", {
        unit: "ms",
        description: "Agent run duration",
      });
      const contextHistogram = meter.createHistogram("openclaw.context.tokens", {
        unit: "1",
        description: "Context window size and usage",
      });
      const webhookReceivedCounter = meter.createCounter("openclaw.webhook.received", {
        unit: "1",
        description: "Webhook requests received",
      });
      const webhookErrorCounter = meter.createCounter("openclaw.webhook.error", {
        unit: "1",
        description: "Webhook processing errors",
      });
      const webhookDurationHistogram = meter.createHistogram("openclaw.webhook.duration_ms", {
        unit: "ms",
        description: "Webhook processing duration",
      });
      const messageQueuedCounter = meter.createCounter("openclaw.message.queued", {
        unit: "1",
        description: "Messages queued for processing",
      });
      const messageProcessedCounter = meter.createCounter("openclaw.message.processed", {
        unit: "1",
        description: "Messages processed by outcome",
      });
      const messageDurationHistogram = meter.createHistogram("openclaw.message.duration_ms", {
        unit: "ms",
        description: "Message processing duration",
      });
      const queueDepthHistogram = meter.createHistogram("openclaw.queue.depth", {
        unit: "1",
        description: "Queue depth on enqueue/dequeue",
      });
      const queueWaitHistogram = meter.createHistogram("openclaw.queue.wait_ms", {
        unit: "ms",
        description: "Queue wait time before execution",
      });
      const laneEnqueueCounter = meter.createCounter("openclaw.queue.lane.enqueue", {
        unit: "1",
        description: "Command queue lane enqueue events",
      });
      const laneDequeueCounter = meter.createCounter("openclaw.queue.lane.dequeue", {
        unit: "1",
        description: "Command queue lane dequeue events",
      });
      const sessionStateCounter = meter.createCounter("openclaw.session.state", {
        unit: "1",
        description: "Session state transitions",
      });
      const sessionStuckCounter = meter.createCounter("openclaw.session.stuck", {
        unit: "1",
        description: "Sessions stuck in processing",
      });
      const sessionStuckAgeHistogram = meter.createHistogram("openclaw.session.stuck_age_ms", {
        unit: "ms",
        description: "Age of stuck sessions",
      });
      const runAttemptCounter = meter.createCounter("openclaw.run.attempt", {
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
        const otelLogger = logProvider.getLogger("openclaw");

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
            "openclaw.log.level": logLevelName,
          };
          if (meta?.name) {
            attributes["openclaw.logger"] = meta.name;
          }
          if (meta?.parentNames?.length) {
            attributes["openclaw.logger.parents"] = meta.parentNames.join(".");
          }
          if (bindings) {
            for (const [key, value] of Object.entries(bindings)) {
              if (
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean"
              ) {
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
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.provider": evt.provider ?? "unknown",
          "openclaw.model": evt.model ?? "unknown",
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
            "openclaw.context": "limit",
          });
        }
        if (evt.context?.used) {
          contextHistogram.record(evt.context.used, {
            ...attrs,
            "openclaw.context": "used",
          });
        }

        if (!tracesEnabled) {
          return;
        }

        // Create nested LLM span under root message.process span
        const activeTrace = evt.sessionKey ? activeTraces.get(evt.sessionKey) : null;
        if (activeTrace) {
          try {
            // CRITICAL: MLflow UI populates Request/Response columns from ROOT SPAN attributes
            // Set prompt/completion on root span using OpenAI chat message format
            if (evt.prompt) {
              activeTrace.span.setAttribute(GENAI_ATTRS.PROMPT, evt.prompt);
              activeTrace.span.setAttribute(
                GENAI_ATTRS.MLFLOW_SPAN_INPUTS,
                JSON.stringify({ role: "user", content: evt.prompt }),
              );
            }
            if (evt.completion) {
              activeTrace.span.setAttribute(GENAI_ATTRS.COMPLETION, evt.completion);
              activeTrace.span.setAttribute(
                GENAI_ATTRS.MLFLOW_SPAN_OUTPUTS,
                JSON.stringify({ role: "assistant", content: evt.completion }),
              );
            }

            const parentContext = trace.setSpan(context.active(), activeTrace.span);

            const llmSpan = tracer.startSpan(
              `llm.${evt.provider || "unknown"}.${evt.model || "unknown"}`,
              {
                kind: 3, // CLIENT
                attributes: {
                  [GENAI_ATTRS.SYSTEM]: evt.provider || "unknown",
                  [GENAI_ATTRS.REQUEST_MODEL]: evt.model || "unknown",
                  [GENAI_ATTRS.RESPONSE_MODEL]: evt.model || "unknown",
                  [GENAI_ATTRS.INPUT_TOKENS]: evt.usage?.input || evt.usage?.promptTokens || 0,
                  [GENAI_ATTRS.OUTPUT_TOKENS]: evt.usage?.output || 0,
                  [GENAI_ATTRS.TOTAL_TOKENS]: evt.usage?.total || 0,
                  // Prompt and completion for child span (GenAI semantic conventions)
                  ...(evt.prompt && { [GENAI_ATTRS.PROMPT]: evt.prompt }),
                  ...(evt.completion && { [GENAI_ATTRS.COMPLETION]: evt.completion }),
                },
              },
              parentContext,
            );

            llmSpan.end();
          } catch (error) {
            ctx.logger.warn(`Failed to create LLM span: ${String(error)}`);
          }
        }
      };

      const recordWebhookReceived = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.received" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown",
        };
        webhookReceivedCounter.add(1, attrs);
      };

      const recordWebhookProcessed = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.processed" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown",
        };
        if (typeof evt.durationMs === "number") {
          webhookDurationHistogram.record(evt.durationMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.chatId !== undefined) {
          spanAttrs["openclaw.chatId"] = String(evt.chatId);
        }
        const span = spanWithDuration("openclaw.webhook.processed", spanAttrs, evt.durationMs);
        span.end();
      };

      const recordWebhookError = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.error" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown",
        };
        webhookErrorCounter.add(1, attrs);
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "openclaw.error": evt.error,
        };
        if (evt.chatId !== undefined) {
          spanAttrs["openclaw.chatId"] = String(evt.chatId);
        }
        const span = tracer.startSpan("openclaw.webhook.error", {
          attributes: spanAttrs,
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
        span.end();
      };

      const recordMessageQueued = (
        evt: Extract<DiagnosticEventPayload, { type: "message.queued" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.source": evt.source ?? "unknown",
        };
        messageQueuedCounter.add(1, attrs);
        if (typeof evt.queueDepth === "number") {
          queueDepthHistogram.record(evt.queueDepth, attrs);
        }

        // Create root span for nested trace hierarchy (message → llm → tools)
        if (tracesEnabled && evt.sessionKey) {
          try {
            const agentId = evt.sessionKey?.split(":")[1] || "unknown";

            const rootSpan = tracer.startSpan("message.process", {
              kind: 1, // SERVER
              attributes: {
                [GENAI_ATTRS.SESSION_ID]: evt.sessionKey,
                [GENAI_ATTRS.USER_ID]: agentId,
                [GENAI_ATTRS.OPENCLAW_SESSION_KEY]: evt.sessionKey,
                [GENAI_ATTRS.OPENCLAW_AGENT_ID]: agentId,
                [GENAI_ATTRS.OPENCLAW_CHANNEL]: evt.channel || "unknown",
                [GENAI_ATTRS.OPENCLAW_SOURCE]: evt.source,
                [GENAI_ATTRS.OPENCLAW_QUEUE_DEPTH]: evt.queueDepth || 0,

                // CRITICAL: MLflow UI reads these for Session/User columns
                [GENAI_ATTRS.MLFLOW_TRACE_SESSION]: evt.sessionKey,
                [GENAI_ATTRS.MLFLOW_TRACE_USER]: agentId,
              },
            });

            activeTraces.set(evt.sessionKey, {
              span: rootSpan,
              startedAt: evt.ts || Date.now(),
              sessionKey: evt.sessionKey,
              agentId,
              channel: evt.channel,
            });

            ctx.logger.debug(
              `diagnostics-otel: created root span for session=${evt.sessionKey} agent=${agentId}`,
            );
          } catch (error) {
            ctx.logger.warn(`Failed to start root trace: ${String(error)}`);
          }
        }
      };

      const recordMessageProcessed = (
        evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.outcome": evt.outcome ?? "unknown",
        };
        messageProcessedCounter.add(1, attrs);
        if (typeof evt.durationMs === "number") {
          messageDurationHistogram.record(evt.durationMs, attrs);
        }

        // End root trace span
        const activeTrace = evt.sessionKey ? activeTraces.get(evt.sessionKey) : null;
        if (activeTrace) {
          try {
            if (evt.outcome === "error" && evt.error) {
              activeTrace.span.setStatus({
                code: SpanStatusCode.ERROR,
                message: evt.error,
              });
            } else {
              activeTrace.span.setStatus({ code: SpanStatusCode.OK });
            }

            activeTrace.span.end();
            activeTraces.delete(evt.sessionKey!);
          } catch (error) {
            ctx.logger.warn(`Failed to end root trace: ${String(error)}`);
          }
        } else {
          ctx.logger.warn(
            `diagnostics-otel: message.processed but no active trace for sessionKey=${evt.sessionKey}`,
          );
        }
      };

      const recordLaneEnqueue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.enqueue" }>,
      ) => {
        const attrs = { "openclaw.lane": evt.lane };
        laneEnqueueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
      };

      const recordLaneDequeue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.dequeue" }>,
      ) => {
        const attrs = { "openclaw.lane": evt.lane };
        laneDequeueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
        if (typeof evt.waitMs === "number") {
          queueWaitHistogram.record(evt.waitMs, attrs);
        }
      };

      const recordSessionState = (
        evt: Extract<DiagnosticEventPayload, { type: "session.state" }>,
      ) => {
        const attrs: Record<string, string> = { "openclaw.state": evt.state };
        if (evt.reason) {
          attrs["openclaw.reason"] = evt.reason;
        }
        sessionStateCounter.add(1, attrs);
      };

      const recordSessionStuck = (
        evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>,
      ) => {
        const attrs: Record<string, string> = { "openclaw.state": evt.state };
        sessionStuckCounter.add(1, attrs);
        if (typeof evt.ageMs === "number") {
          sessionStuckAgeHistogram.record(evt.ageMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.sessionKey) {
          spanAttrs["openclaw.sessionKey"] = evt.sessionKey;
        }
        if (evt.sessionId) {
          spanAttrs["openclaw.sessionId"] = evt.sessionId;
        }
        spanAttrs["openclaw.queueDepth"] = evt.queueDepth ?? 0;
        spanAttrs["openclaw.ageMs"] = evt.ageMs;
        const span = tracer.startSpan("openclaw.session.stuck", { attributes: spanAttrs });
        span.setStatus({ code: SpanStatusCode.ERROR, message: "session stuck" });
        span.end();
      };

      const recordRunAttempt = (evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>) => {
        runAttemptCounter.add(1, { "openclaw.attempt": evt.attempt });
      };

      const recordHeartbeat = (
        evt: Extract<DiagnosticEventPayload, { type: "diagnostic.heartbeat" }>,
      ) => {
        queueDepthHistogram.record(evt.queued, { "openclaw.channel": "heartbeat" });
      };

      ctx.logger.info("diagnostics-otel: registering diagnostic event listener");
      unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        ctx.logger.info(`diagnostics-otel: received event type=${evt.type}`);

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

      // Subscribe to agent events for tool/lifecycle spans
      if (tracesEnabled) {
        unsubscribeAgentEvents = onAgentEvent((evt: AgentEventPayload) => {
          const activeTrace = evt.sessionKey ? activeTraces.get(evt.sessionKey) : null;

          switch (evt.stream) {
            case "tool": {
              const data = evt.data as {
                phase?: "start" | "end" | "result";
                name?: string;
                toolCallId?: string;
                args?: Record<string, unknown>;
                result?: unknown;
                error?: string;
              };

              if (!activeTrace) {
                ctx.logger.warn(
                  `diagnostics-otel: no active trace for tool event sessionKey=${evt.sessionKey} phase=${data.phase} name=${data.name}`,
                );
                return;
              }

              const phase = data.phase;
              const toolName = data.name || "unknown";
              const toolCallId = data.toolCallId || `tool-${Date.now()}`;

              if (phase === "start") {
                try {
                  const parentContext = trace.setSpan(context.active(), activeTrace.span);

                  const span = tracer.startSpan(
                    `tool.${toolName}`,
                    {
                      kind: 1, // SERVER
                      attributes: {
                        "tool.name": toolName,
                        "tool.call_id": toolCallId,
                        "tool.run_id": evt.runId,
                      },
                    },
                    parentContext,
                  );

                  activeSpans.set(toolCallId, span);
                } catch (error) {
                  ctx.logger.warn(`Failed to start tool span for ${toolName}: ${String(error)}`);
                }
              } else if (phase === "end" || phase === "result") {
                const span = activeSpans.get(toolCallId);
                if (span) {
                  try {
                    if (data.error) {
                      span.setStatus({ code: SpanStatusCode.ERROR, message: data.error });
                    } else {
                      span.setStatus({ code: SpanStatusCode.OK });
                    }
                    span.end();
                  } catch (error) {
                    ctx.logger.warn(`Failed to end tool span for ${toolName}: ${String(error)}`);
                  }
                  activeSpans.delete(toolCallId);
                } else {
                  ctx.logger.warn(
                    `diagnostics-otel: no active span found for tool.${toolName} callId=${toolCallId} phase=${phase}`,
                  );
                }
              }
              break;
            }

            case "error": {
              if (!activeTrace) return;

              const data = evt.data as { error?: string; message?: string; stack?: string };
              try {
                activeTrace.span.recordException({
                  name: data.error || data.message || "Unknown error",
                  message: data.message,
                  stack: data.stack,
                });
                activeTrace.span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: data.error || data.message || "Unknown error",
                });
              } catch (error) {
                ctx.logger.warn(`Failed to record error on span: ${String(error)}`);
              }
              break;
            }
          }
        });
      }

      if (logsEnabled) {
        ctx.logger.info("diagnostics-otel: logs exporter enabled (OTLP/HTTP)");
      }

      ctx.logger.info(
        `diagnostics-otel: service ready (subscribed to diagnostic${tracesEnabled ? " and agent" : ""} events)`,
      );
    },
    async stop() {
      // End any remaining tool spans
      for (const [, span] of activeSpans) {
        try {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "Service stopped" });
          span.end();
        } catch {
          // Ignore errors during cleanup
        }
      }
      activeSpans.clear();

      // End any remaining root traces
      for (const [, activeTrace] of activeTraces) {
        if (activeTrace.span) {
          try {
            activeTrace.span.setStatus({ code: SpanStatusCode.ERROR, message: "Service stopped" });
            activeTrace.span.end();
          } catch {
            // Ignore errors during cleanup
          }
        }
      }
      activeTraces.clear();

      unsubscribe?.();
      unsubscribe = null;
      unsubscribeAgentEvents?.();
      unsubscribeAgentEvents = null;
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
  } satisfies OpenClawPluginService;
}
