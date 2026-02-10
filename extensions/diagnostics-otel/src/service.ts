import type { SeverityNumber } from "@opentelemetry/api-logs";
import type { ExportResult } from "@opentelemetry/core";
import type { DiagnosticEventPayload, OpenClawPluginService } from "openclaw/plugin-sdk";
import { context, metrics, trace, SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import { ExportResultCode, hrTimeToMilliseconds } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import fs from "node:fs";
import { onDiagnosticEvent, registerLogTransport } from "openclaw/plugin-sdk";

const DEFAULT_SERVICE_NAME = "openclaw";
const OTEL_DEBUG_ENV = "OPENCLAW_OTEL_DEBUG";
const OTEL_DUMP_ENV = "OPENCLAW_OTEL_DUMP";

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

/** Map internal provider names to gen_ai.provider.name enum values. */
function mapProviderName(provider?: string): string {
  if (!provider) {
    return "unknown";
  }
  const p = provider.toLowerCase();
  if (p.includes("openai") || p === "orq") {
    return "openai";
  }
  if (p.includes("anthropic") || p.includes("claude")) {
    return "anthropic";
  }
  if (p.includes("google") || p.includes("gemini")) {
    return "gcp.gemini";
  }
  if (p.includes("bedrock")) {
    return "aws.bedrock";
  }
  if (p.includes("mistral")) {
    return "mistral_ai";
  }
  if (p.includes("deepseek")) {
    return "deepseek";
  }
  if (p.includes("groq")) {
    return "groq";
  }
  if (p.includes("cohere")) {
    return "cohere";
  }
  if (p.includes("perplexity")) {
    return "perplexity";
  }
  return provider;
}

class LoggingTraceExporter implements SpanExporter {
  #inner: SpanExporter;
  #log: { info: (msg: string) => void };
  #dumpPath?: string;
  #dumpFailed = false;

  constructor(inner: SpanExporter, log: { info: (msg: string) => void }, dumpPath?: string) {
    this.#inner = inner;
    this.#log = log;
    this.#dumpPath = dumpPath;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void) {
    const first = spans[0];
    const details = first ? ` first=${first.name}` : "";
    this.#log.info(`diagnostics-otel: exporting ${spans.length} spans.${details}`);
    if (this.#dumpPath && !this.#dumpFailed) {
      try {
        for (const span of spans) {
          const startMs = hrTimeToMilliseconds(span.startTime);
          const endMs = hrTimeToMilliseconds(span.endTime);
          const parentCtxField = (span as { parentSpanContext?: { spanId?: string } })
            .parentSpanContext;
          const payload = {
            ts: new Date().toISOString(),
            name: span.name,
            traceId: span.spanContext().traceId,
            spanId: span.spanContext().spanId,
            parentSpanId: parentCtxField?.spanId,
            kind: span.kind,
            status: span.status,
            attributes: span.attributes,
            resource: span.resource?.attributes,
            startTimeMs: startMs,
            endTimeMs: endMs,
            durationMs: endMs - startMs,
          };
          fs.appendFileSync(
            this.#dumpPath,
            `${JSON.stringify(payload, (_key, value) =>
              typeof value === "bigint" ? Number(value) : value,
            )}\n`,
          );
        }
      } catch (err) {
        this.#dumpFailed = true;
        this.#log.info(`diagnostics-otel: failed to write dump file: ${String(err)}`);
      }
    }
    try {
      this.#inner.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          this.#log.info(
            `diagnostics-otel: export failed code=${result.code} error=${String(result.error)}`,
          );
        }
        resultCallback(result);
      });
    } catch (err) {
      this.#log.info(`diagnostics-otel: export threw: ${String(err)}`);
      resultCallback({ code: ExportResultCode.FAILED, error: err as Error });
    }
  }

  async shutdown() {
    await this.#inner.shutdown();
  }

  async forceFlush() {
    if (this.#inner.forceFlush) {
      await this.#inner.forceFlush();
    }
  }
}

interface ActiveTrace {
  span: Span;
  startedAt: number;
  sessionKey?: string;
  channel?: string;
}

export function createDiagnosticsOtelService(): OpenClawPluginService {
  let sdk: NodeSDK | null = null;
  let logProvider: LoggerProvider | null = null;
  let stopLogTransport: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let bufferCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Active root traces keyed by sessionKey. Covers the full message lifecycle;
  // child spans (agent.turn, LLM calls, tool executions) are nested under it.
  const activeTraces = new Map<string, ActiveTrace>();
  const ACTIVE_TRACE_TTL_MS = 10 * 60 * 1000;

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
      const debugExports = ["1", "true", "yes", "on"].includes(
        (process.env[OTEL_DEBUG_ENV] ?? "").toLowerCase(),
      );
      const dumpPathRaw = process.env[OTEL_DUMP_ENV]?.trim();
      const dumpPath = dumpPathRaw ? dumpPathRaw : undefined;

      const tracesEnabled = otel.traces !== false;
      const metricsEnabled = otel.metrics !== false;
      const logsEnabled = otel.logs === true;
      if (!tracesEnabled && !metricsEnabled && !logsEnabled) {
        return;
      }
      if (debugExports) {
        ctx.logger.info(
          `diagnostics-otel: debug enabled (traces=${tracesEnabled}, metrics=${metricsEnabled}, logs=${logsEnabled})`,
        );
      }

      const resource = resourceFromAttributes({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      });

      const traceUrl = resolveOtelUrl(endpoint, "v1/traces");
      const metricUrl = resolveOtelUrl(endpoint, "v1/metrics");
      const logUrl = resolveOtelUrl(endpoint, "v1/logs");
      const traceExporter = tracesEnabled
        ? (() => {
            const base = new OTLPTraceExporter({
              ...(traceUrl ? { url: traceUrl } : {}),
              ...(headers ? { headers } : {}),
            });
            if (debugExports) {
              return new LoggingTraceExporter(base, ctx.logger, dumpPath);
            }
            return base;
          })()
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
          // DEBUG ONLY: keep the explicit processor available while validating exports.
          // ...(traceExporter && debugExports
          //   ? {
          //       spanProcessor: new BatchSpanProcessor(traceExporter, {
          //         scheduledDelayMillis: 1000,
          //       }),
          //     }
          //   : {}),
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

      // GenAI semantic convention metrics (v1.38+)
      const genAiOperationDuration = meter.createHistogram("gen_ai.client.operation.duration", {
        unit: "s",
        description: "GenAI operation duration",
      });
      const genAiTokenUsage = meter.createHistogram("gen_ai.client.token.usage", {
        unit: "{token}",
        description: "GenAI token usage",
      });
      const genAiTtft = meter.createHistogram("gen_ai.client.time_to_first_token", {
        unit: "s",
        description: "Time to first token from the model",
      });
      const inferenceErrorCounter = meter.createCounter("openclaw.inference.error", {
        unit: "1",
        description: "Model inference errors by type",
      });

      if (logsEnabled) {
        const logExporter = new OTLPLogExporter({
          ...(logUrl ? { url: logUrl } : {}),
          ...(headers ? { headers } : {}),
        });
        logProvider = new LoggerProvider({
          resource,
          processors: [
            new BatchLogRecordProcessor(
              logExporter,
              typeof otel.flushIntervalMs === "number"
                ? { scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs) }
                : {},
            ),
          ],
        });
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

      const captureContent = otel.captureContent === true;

      const spanWithDuration = (
        name: string,
        attributes: Record<string, string | number | string[]>,
        durationMs?: number,
        kind?: SpanKind,
        parentCtx?: ReturnType<typeof context.active>,
      ) => {
        const startTime =
          typeof durationMs === "number" ? Date.now() - Math.max(0, durationMs) : undefined;
        const span = tracer.startSpan(
          name,
          {
            attributes,
            ...(startTime ? { startTime } : {}),
            ...(kind !== undefined ? { kind } : {}),
          },
          parentCtx,
        );
        return span;
      };

      const safeJsonStringify = (value: unknown): string => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      };

      const createToolSpan = (
        evt: Extract<DiagnosticEventPayload, { type: "tool.execution" }>,
        parentCtx?: ReturnType<typeof context.active>,
      ) => {
        const spanAttrs: Record<string, string | number> = {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": evt.toolName,
          "gen_ai.tool.type": evt.toolType ?? "function",
        };
        if (evt.toolCallId) {
          spanAttrs["gen_ai.tool.call.id"] = evt.toolCallId;
        }
        if (evt.channel) {
          spanAttrs["openclaw.channel"] = evt.channel;
        }
        if (captureContent) {
          if (evt.toolInput != null) {
            spanAttrs["gen_ai.tool.call.arguments"] = safeJsonStringify(evt.toolInput);
          }
          if (evt.toolOutput != null) {
            spanAttrs["gen_ai.tool.call.result"] = safeJsonStringify(evt.toolOutput);
          }
        }

        const spanName = `execute_tool ${evt.toolName}`;
        const span = spanWithDuration(
          spanName,
          spanAttrs,
          evt.durationMs,
          SpanKind.INTERNAL,
          parentCtx,
        );
        if (evt.error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
        }
        if (debugExports) {
          ctx.logger.info(`diagnostics-otel: span created ${spanName}`);
        }
        span.end();
      };

      const ensureRunSpan = (params: {
        runId?: string;
        sessionKey?: string;
        sessionId?: string;
        channel?: string;
        operationName?: string;
        startTimeMs?: number;
        attributes?: Record<string, string | number | string[]>;
      }): Span | null => {
        const runId = params.runId;
        if (!runId) {
          return null;
        }
        const existing = runSpans.get(runId);
        if (existing) {
          if (params.attributes) {
            for (const [key, value] of Object.entries(params.attributes)) {
              existing.span.setAttribute(key, value);
            }
          }
          return existing.span;
        }
        const spanAttrs: Record<string, string | number | string[]> = {
          "openclaw.runId": runId,
          "gen_ai.operation.name": params.operationName ?? "chat",
          ...params.attributes,
        };
        if (params.sessionKey) {
          spanAttrs["openclaw.sessionKey"] = params.sessionKey;
        }
        if (params.sessionId) {
          spanAttrs["openclaw.sessionId"] = params.sessionId;
          // gen_ai.conversation.id is the OTEL GenAI semantic convention for thread/session ID.
          // Use sessionId (the stable conversation identifier) rather than sessionKey
          // (which is a composite key including channel and agent info).
          spanAttrs["gen_ai.conversation.id"] = params.sessionId;
        }
        if (params.channel) {
          spanAttrs["openclaw.channel"] = params.channel;
        }

        // Parent under root trace span if available (created by message.queued)
        const rootTrace = params.sessionKey ? activeTraces.get(params.sessionKey) : undefined;
        const parentCtx = rootTrace
          ? trace.setSpan(context.active(), rootTrace.span)
          : context.active();

        const span = tracer.startSpan(
          "openclaw.agent.turn",
          {
            attributes: spanAttrs,
            ...(typeof params.startTimeMs === "number" ? { startTime: params.startTimeMs } : {}),
            kind: SpanKind.INTERNAL,
          },
          parentCtx,
        );
        runSpans.set(runId, { span, createdAt: Date.now() });
        if (debugExports) {
          ctx.logger.info(`diagnostics-otel: span created openclaw.agent.turn`);
        }
        return span;
      };

      const runSpans = new Map<string, { span: Span; createdAt: number }>();
      const RUN_SPAN_TTL_MS = 10 * 60 * 1000;
      const inferenceSpans = new Map<string, { span: Span; createdAt: number }>();
      const INFERENCE_SPAN_TTL_MS = 10 * 60 * 1000;
      const activeInferenceSpanByRunId = new Map<string, Span>();

      // Periodic cleanup of orphaned buffer entries
      bufferCleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of runSpans) {
          if (now - entry.createdAt > RUN_SPAN_TTL_MS) {
            try {
              entry.span.end();
            } catch {
              // ignore
            }
            runSpans.delete(key);
          }
        }
        for (const [key, entry] of inferenceSpans) {
          if (now - entry.createdAt > INFERENCE_SPAN_TTL_MS) {
            try {
              entry.span.end();
            } catch {
              // ignore
            }
            inferenceSpans.delete(key);
          }
        }
        // If we had to end inference spans due to TTL, don't keep dangling "active" parents.
        for (const [runId, span] of activeInferenceSpanByRunId) {
          if (Array.from(inferenceSpans.values()).every((e) => e.span !== span)) {
            activeInferenceSpanByRunId.delete(runId);
          }
        }
        for (const [key, entry] of activeTraces) {
          if (now - entry.startedAt > ACTIVE_TRACE_TTL_MS) {
            try {
              entry.span.setStatus({ code: SpanStatusCode.ERROR, message: "TTL expired" });
              entry.span.end();
            } catch {
              // ignore
            }
            activeTraces.delete(key);
          }
        }
      }, 60_000);
      bufferCleanupTimer.unref?.();

      const recordRunCompleted = (
        evt: Extract<DiagnosticEventPayload, { type: "run.completed" }>,
      ) => {
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

        const opName = evt.operationName ?? "chat";
        const spanAttrs: Record<string, string | number | string[]> = {
          ...attrs,
          "openclaw.runId": evt.runId,
          "openclaw.sessionKey": evt.sessionKey ?? "",
          "openclaw.sessionId": evt.sessionId ?? "",
          "gen_ai.operation.name": opName,
          "gen_ai.provider.name": mapProviderName(evt.provider),
          "gen_ai.request.model": evt.model ?? "unknown",
        };
        if (typeof usage.input === "number") {
          spanAttrs["openclaw.tokens.input"] = usage.input;
        }
        if (typeof usage.output === "number") {
          spanAttrs["openclaw.tokens.output"] = usage.output;
          spanAttrs["gen_ai.usage.output_tokens"] = usage.output;
        }
        if (typeof usage.cacheRead === "number") {
          spanAttrs["openclaw.tokens.cache_read"] = usage.cacheRead;
          spanAttrs["gen_ai.usage.cache_read.input_tokens"] = usage.cacheRead;
        }
        if (typeof usage.cacheWrite === "number") {
          spanAttrs["openclaw.tokens.cache_write"] = usage.cacheWrite;
          spanAttrs["gen_ai.usage.cache_creation.input_tokens"] = usage.cacheWrite;
        }
        if (typeof usage.total === "number") {
          spanAttrs["openclaw.tokens.total"] = usage.total;
        }
        // OTEL GenAI semconv: gen_ai.usage.input_tokens SHOULD include all input
        // tokens including cached tokens. Use promptTokens (input + cacheRead +
        // cacheWrite) when available, fall back to raw input.
        const inputTokensForOtel = usage.promptTokens ?? usage.input;
        if (typeof inputTokensForOtel === "number") {
          spanAttrs["gen_ai.usage.input_tokens"] = inputTokensForOtel;
        }
        if (evt.responseModel) {
          spanAttrs["gen_ai.response.model"] = evt.responseModel;
        }
        if (evt.responseId) {
          spanAttrs["gen_ai.response.id"] = evt.responseId;
        }
        if (evt.finishReasons?.length) {
          spanAttrs["gen_ai.response.finish_reasons"] = evt.finishReasons;
        }
        if (evt.sessionId) {
          spanAttrs["gen_ai.conversation.id"] = evt.sessionId;
        }
        if (typeof evt.temperature === "number") {
          spanAttrs["gen_ai.request.temperature"] = evt.temperature;
        }
        if (typeof evt.maxOutputTokens === "number") {
          spanAttrs["gen_ai.request.max_tokens"] = evt.maxOutputTokens;
        }
        if (captureContent) {
          if (evt.inputMessages) {
            spanAttrs["gen_ai.input.messages"] = JSON.stringify(evt.inputMessages);
          }
          if (evt.outputMessages) {
            spanAttrs["gen_ai.output.messages"] = JSON.stringify(evt.outputMessages);
          }
          if (evt.systemInstructions) {
            spanAttrs["gen_ai.system_instructions"] = JSON.stringify(evt.systemInstructions);
          }
        }
        const runSpan = ensureRunSpan({
          runId: evt.runId,
          sessionKey: evt.sessionKey,
          sessionId: evt.sessionId,
          channel: evt.channel,
          operationName: opName,
          attributes: spanAttrs,
          startTimeMs:
            typeof evt.durationMs === "number"
              ? Date.now() - Math.max(0, evt.durationMs)
              : undefined,
        });
        const finalRunSpan =
          runSpan ??
          spanWithDuration("openclaw.agent.turn", spanAttrs, evt.durationMs, SpanKind.INTERNAL);

        if (evt.error) {
          finalRunSpan.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
          if (evt.errorType) {
            finalRunSpan.setAttribute("gen_ai.error.type", evt.errorType);
          }
          finalRunSpan.setAttribute("openclaw.error", evt.error);
        }

        finalRunSpan.end();
        runSpans.delete(evt.runId);
      };

      const recordRunStarted = (evt: Extract<DiagnosticEventPayload, { type: "run.started" }>) => {
        if (!tracesEnabled) {
          return;
        }
        ensureRunSpan({
          runId: evt.runId,
          sessionKey: evt.sessionKey,
          sessionId: evt.sessionId,
          channel: evt.channel,
          operationName: "chat",
          startTimeMs: evt.ts,
        });
      };

      const recordModelInferenceStarted = (
        evt: Extract<DiagnosticEventPayload, { type: "model.inference.started" }>,
      ) => {
        if (!tracesEnabled) {
          return;
        }
        const opName = evt.operationName ?? "chat";

        const runSpan = ensureRunSpan({
          runId: evt.runId,
          sessionKey: evt.sessionKey,
          sessionId: evt.sessionId,
          channel: evt.channel,
          operationName: opName,
          startTimeMs: evt.ts,
        });
        const parentCtx = runSpan ? trace.setSpan(context.active(), runSpan) : context.active();

        const spanAttrs: Record<string, string | number | string[]> = {
          "gen_ai.operation.name": opName,
          "gen_ai.provider.name": mapProviderName(evt.provider),
          "gen_ai.request.model": evt.model ?? "unknown",
        };
        if (evt.sessionKey) {
          spanAttrs["openclaw.sessionKey"] = evt.sessionKey;
        }
        if (evt.sessionId) {
          spanAttrs["openclaw.sessionId"] = evt.sessionId;
          spanAttrs["gen_ai.conversation.id"] = evt.sessionId;
        }
        if (typeof evt.callIndex === "number") {
          spanAttrs["openclaw.callIndex"] = evt.callIndex;
        }
        if (typeof evt.temperature === "number") {
          spanAttrs["gen_ai.request.temperature"] = evt.temperature;
        }
        if (typeof evt.maxOutputTokens === "number") {
          spanAttrs["gen_ai.request.max_tokens"] = evt.maxOutputTokens;
        }
        if (captureContent) {
          if (evt.inputMessages) {
            spanAttrs["gen_ai.input.messages"] = JSON.stringify(evt.inputMessages);
          }
          if (evt.systemInstructions) {
            spanAttrs["gen_ai.system_instructions"] = JSON.stringify(evt.systemInstructions);
          }
          if (evt.toolDefinitions) {
            spanAttrs["gen_ai.request.tools"] = JSON.stringify(evt.toolDefinitions);
          }
        }

        const spanName = `${opName} ${evt.model ?? "unknown"}`;
        const span = tracer.startSpan(
          spanName,
          { attributes: spanAttrs, startTime: evt.ts, kind: SpanKind.CLIENT },
          parentCtx,
        );
        if (debugExports) {
          ctx.logger.info(`diagnostics-otel: span created ${spanName}`);
        }

        if (evt.runId && typeof evt.callIndex === "number") {
          inferenceSpans.set(`${evt.runId}:${evt.callIndex}`, { span, createdAt: Date.now() });
        }
        if (evt.runId) {
          activeInferenceSpanByRunId.set(evt.runId, span);
        }
      };

      const recordModelInference = (
        evt: Extract<DiagnosticEventPayload, { type: "model.inference" }>,
      ) => {
        const opName = evt.operationName ?? "chat";
        const usage = evt.usage ?? {};

        // GenAI standard metrics (gen_ai_latest_experimental)
        const genAiMetricAttrs = {
          "gen_ai.operation.name": opName,
          "gen_ai.provider.name": mapProviderName(evt.provider),
          "gen_ai.request.model": evt.model ?? "unknown",
        };
        if (evt.durationMs) {
          genAiOperationDuration.record(evt.durationMs / 1000, genAiMetricAttrs);
        }
        if (usage.input) {
          genAiTokenUsage.record(usage.input, {
            ...genAiMetricAttrs,
            "gen_ai.token.type": "input",
          });
        }
        if (usage.output) {
          genAiTokenUsage.record(usage.output, {
            ...genAiMetricAttrs,
            "gen_ai.token.type": "output",
          });
        }
        if (typeof evt.ttftMs === "number") {
          genAiTtft.record(evt.ttftMs / 1000, genAiMetricAttrs);
        }
        if (evt.error && evt.errorType) {
          inferenceErrorCounter.add(1, {
            ...genAiMetricAttrs,
            "openclaw.error.type": evt.errorType,
          });
        }

        if (!tracesEnabled) {
          return;
        }

        const spanAttrs: Record<string, string | number | string[]> = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.provider": evt.provider ?? "unknown",
          "openclaw.model": evt.model ?? "unknown",
          "openclaw.sessionKey": evt.sessionKey ?? "",
          "openclaw.sessionId": evt.sessionId ?? "",
          "gen_ai.operation.name": opName,
          "gen_ai.provider.name": mapProviderName(evt.provider),
          "gen_ai.request.model": evt.model ?? "unknown",
        };
        if (typeof usage.input === "number") {
          spanAttrs["openclaw.tokens.input"] = usage.input;
        }
        if (typeof usage.output === "number") {
          spanAttrs["openclaw.tokens.output"] = usage.output;
          spanAttrs["gen_ai.usage.output_tokens"] = usage.output;
        }
        if (typeof usage.cacheRead === "number") {
          spanAttrs["openclaw.tokens.cache_read"] = usage.cacheRead;
          spanAttrs["gen_ai.usage.cache_read.input_tokens"] = usage.cacheRead;
        }
        if (typeof usage.cacheWrite === "number") {
          spanAttrs["openclaw.tokens.cache_write"] = usage.cacheWrite;
          spanAttrs["gen_ai.usage.cache_creation.input_tokens"] = usage.cacheWrite;
        }
        if (typeof usage.total === "number") {
          spanAttrs["openclaw.tokens.total"] = usage.total;
        }
        // OTEL GenAI semconv: gen_ai.usage.input_tokens SHOULD include all input
        // tokens including cached tokens. Use promptTokens (input + cacheRead +
        // cacheWrite) when available, fall back to raw input.
        const inputTokensForOtel = usage.promptTokens ?? usage.input;
        if (typeof inputTokensForOtel === "number") {
          spanAttrs["gen_ai.usage.input_tokens"] = inputTokensForOtel;
        }
        if (evt.responseModel) {
          spanAttrs["gen_ai.response.model"] = evt.responseModel;
        }
        if (evt.responseId) {
          spanAttrs["gen_ai.response.id"] = evt.responseId;
        }
        if (evt.finishReasons?.length) {
          spanAttrs["gen_ai.response.finish_reasons"] = evt.finishReasons;
        }
        if (evt.sessionId) {
          spanAttrs["gen_ai.conversation.id"] = evt.sessionId;
        }
        if (typeof evt.temperature === "number") {
          spanAttrs["gen_ai.request.temperature"] = evt.temperature;
        }
        if (typeof evt.maxOutputTokens === "number") {
          spanAttrs["gen_ai.request.max_tokens"] = evt.maxOutputTokens;
        }
        if (typeof evt.ttftMs === "number") {
          spanAttrs["gen_ai.client.time_to_first_token"] = evt.ttftMs;
        }
        if (typeof evt.callIndex === "number") {
          spanAttrs["openclaw.callIndex"] = evt.callIndex;
        }
        if (captureContent && evt.outputMessages) {
          spanAttrs["gen_ai.output.messages"] = JSON.stringify(evt.outputMessages);
        }
        const span =
          evt.runId && typeof evt.callIndex === "number"
            ? inferenceSpans.get(`${evt.runId}:${evt.callIndex}`)?.span
            : undefined;
        const activeSpan = evt.runId ? activeInferenceSpanByRunId.get(evt.runId) : undefined;
        const resolved = span ?? activeSpan;

        if (!tracesEnabled) {
          return;
        }

        const spanName = `${opName} ${evt.model ?? "unknown"}`;
        const runEntry = evt.runId ? runSpans.get(evt.runId) : undefined;
        const parentCtx = runEntry
          ? trace.setSpan(context.active(), runEntry.span)
          : context.active();
        const finalSpan =
          resolved ??
          spanWithDuration(spanName, spanAttrs, evt.durationMs, SpanKind.CLIENT, parentCtx);

        for (const [key, value] of Object.entries(spanAttrs)) {
          finalSpan.setAttribute(key, value);
        }
        if (captureContent && evt.outputMessages) {
          finalSpan.setAttribute("gen_ai.output.messages", JSON.stringify(evt.outputMessages));
        }
        if (evt.error) {
          finalSpan.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
          if (evt.errorType) {
            finalSpan.setAttribute("gen_ai.error.type", evt.errorType);
          }
          finalSpan.setAttribute("openclaw.error", evt.error);
        }
        finalSpan.end();

        if (evt.runId) {
          activeInferenceSpanByRunId.delete(evt.runId);
          if (typeof evt.callIndex === "number") {
            inferenceSpans.delete(`${evt.runId}:${evt.callIndex}`);
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
        if (debugExports) {
          ctx.logger.info(`diagnostics-otel: span created openclaw.webhook.processed`);
        }
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
        if (debugExports) {
          ctx.logger.info(`diagnostics-otel: span created openclaw.webhook.error`);
        }
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

        // Create root span for nested trace hierarchy.
        // The message lifecycle is: message.queued → run.started → model.inference → tools → run.completed → message.processed.
        // This root span covers the entire lifecycle; agent.turn, LLM calls, and tool executions are nested as children.
        // message.processed ends this span (it does not create a new child).
        if (tracesEnabled && evt.sessionKey) {
          const rootSpan = tracer.startSpan("openclaw.message", {
            kind: SpanKind.SERVER,
            attributes: {
              "openclaw.sessionKey": evt.sessionKey,
              "openclaw.channel": evt.channel ?? "unknown",
              "openclaw.source": evt.source ?? "unknown",
              ...(typeof evt.queueDepth === "number"
                ? { "openclaw.queueDepth": evt.queueDepth }
                : {}),
            },
          });

          activeTraces.set(evt.sessionKey, {
            span: rootSpan,
            startedAt: Date.now(),
            sessionKey: evt.sessionKey,
            channel: evt.channel,
          });

          if (debugExports) {
            ctx.logger.info(`diagnostics-otel: created root span for session=${evt.sessionKey}`);
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

        // End root trace span created by message.queued.
        // No standalone span here — the root span covers the full message lifecycle.
        const sessionKey = evt.sessionKey;
        const activeTrace = sessionKey ? activeTraces.get(sessionKey) : null;
        if (activeTrace) {
          activeTrace.span.setAttribute("openclaw.outcome", evt.outcome ?? "unknown");
          if (typeof evt.durationMs === "number") {
            activeTrace.span.setAttribute("openclaw.durationMs", evt.durationMs);
          }
          if (evt.messageId != null) {
            activeTrace.span.setAttribute("openclaw.messageId", String(evt.messageId));
          }
          if (evt.outcome === "error" && evt.error) {
            activeTrace.span.setStatus({
              code: SpanStatusCode.ERROR,
              message: evt.error,
            });
          } else {
            activeTrace.span.setStatus({ code: SpanStatusCode.OK });
          }
          activeTrace.span.end();
          activeTraces.delete(sessionKey);
          if (debugExports) {
            ctx.logger.info(`diagnostics-otel: ended root span for session=${sessionKey}`);
          }
        } else if (debugExports) {
          ctx.logger.info(
            `diagnostics-otel: no active root trace for message.processed sessionKey=${sessionKey ?? "undefined"}`,
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
        if (debugExports) {
          ctx.logger.info(`diagnostics-otel: span created openclaw.session.stuck`);
        }
        span.end();
      };

      const recordRunAttempt = (evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>) => {
        runAttemptCounter.add(1, { "openclaw.attempt": evt.attempt });
      };

      const recordToolExecution = (
        evt: Extract<DiagnosticEventPayload, { type: "tool.execution" }>,
      ) => {
        if (!tracesEnabled) {
          return;
        }
        const runId = evt.runId;
        const inferenceSpan = runId ? activeInferenceSpanByRunId.get(runId) : undefined;
        const runEntry = runId ? runSpans.get(runId) : undefined;
        const parentSpan = inferenceSpan ?? runEntry?.span;
        const parentCtx = parentSpan ? trace.setSpan(context.active(), parentSpan) : undefined;
        createToolSpan(evt, parentCtx);
      };

      const recordHeartbeat = (
        evt: Extract<DiagnosticEventPayload, { type: "diagnostic.heartbeat" }>,
      ) => {
        queueDepthHistogram.record(evt.queued, { "openclaw.channel": "heartbeat" });
      };

      unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        if (debugExports) {
          ctx.logger.info(`diagnostics-otel: event received ${evt.type}`);
        }
        switch (evt.type) {
          case "model.inference.started":
            recordModelInferenceStarted(evt);
            return;
          case "model.inference":
            recordModelInference(evt);
            return;
          case "run.completed":
            recordRunCompleted(evt);
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
          case "run.started":
            recordRunStarted(evt);
            return;
          case "diagnostic.heartbeat":
            recordHeartbeat(evt);
            return;
          case "tool.execution":
            recordToolExecution(evt);
            return;
        }
      });

      if (logsEnabled) {
        ctx.logger.info("diagnostics-otel: logs exporter enabled (OTLP/HTTP)");
      }
    },
    async stop() {
      // End any remaining root traces
      for (const [, activeTrace] of activeTraces) {
        try {
          activeTrace.span.setStatus({ code: SpanStatusCode.ERROR, message: "Service stopped" });
          activeTrace.span.end();
        } catch {
          // Ignore errors during cleanup
        }
      }
      activeTraces.clear();

      unsubscribe?.();
      unsubscribe = null;
      stopLogTransport?.();
      stopLogTransport = null;
      if (bufferCleanupTimer) {
        clearInterval(bufferCleanupTimer);
        bufferCleanupTimer = null;
      }
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
