import type { SeverityNumber } from "@opentelemetry/api-logs";
import type {
  DiagnosticEventPayload,
  OpenClawConfig,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import {
  context,
  isSpanContextValid,
  metrics,
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
} from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { resolveAgentIdFromSessionKey, resolveAgentIdentity } from "openclaw/plugin-sdk";
import { onDiagnosticEvent, registerLogTransport } from "openclaw/plugin-sdk";
import {
  recordRunCompleted,
  recordRunStarted,
  recordModelInferenceStarted,
  recordModelInference,
  recordWebhookReceived,
  recordWebhookProcessed,
  recordWebhookError,
  recordMessageQueued,
  recordMessageProcessed,
  recordLaneEnqueue,
  recordLaneDequeue,
  recordSessionState,
  recordSessionStuck,
  recordRunAttempt,
  recordToolExecution,
  recordHeartbeat,
  type AgentInfo,
  type OtelHandlerCtx,
} from "./otel-event-handlers.js";
import { createMetricInstruments } from "./otel-metrics.js";
import {
  DEFAULT_SERVICE_NAME,
  OTEL_DEBUG_ENV,
  OTEL_DUMP_ENV,
  normalizeEndpoint,
  resolveCaptureContent,
  resolveOtelUrl,
  resolveSampleRate,
  LoggingTraceExporter,
  formatTraceparent,
  type ActiveTrace,
  type TraceHeaders,
} from "./otel-utils.js";

// Global trace context registry for W3C Trace Context propagation.
// Stores pre-formatted headers to avoid requiring @opentelemetry/api in main package.
// Shared via Symbol.for so trace-context-propagator.ts can read without importing this module.
const TRACE_CONTEXT_REGISTRY_KEY = Symbol.for("openclaw.diagnostics-otel.trace-headers");

function getTraceHeadersRegistry(): Map<string, TraceHeaders> {
  const globalStore = globalThis as {
    [TRACE_CONTEXT_REGISTRY_KEY]?: Map<string, TraceHeaders>;
  };
  if (!globalStore[TRACE_CONTEXT_REGISTRY_KEY]) {
    globalStore[TRACE_CONTEXT_REGISTRY_KEY] = new Map();
  }
  return globalStore[TRACE_CONTEXT_REGISTRY_KEY];
}

function formatError(err: unknown): string {
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
        [ATTR_SERVICE_NAME]: serviceName,
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
          ...(sampleRate !== undefined
            ? {
                sampler: new ParentBasedSampler({
                  root: new TraceIdRatioBasedSampler(sampleRate),
                }),
              }
            : {}),
        });

        try {
          await sdk.start();
        } catch (err) {
          ctx.logger.error(`diagnostics-otel: failed to start SDK: ${formatError(err)}`);
          throw err;
        }
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
      const otelMetrics = createMetricInstruments(meter);

      // Trace attribute constants (standard OTEL semantic conventions only)
      const TRACE_ATTRS = {
        SESSION_ID: "session.id",
      } as const;

      if (logsEnabled) {
        const logExporter = new OTLPLogExporter({
          ...(logUrl ? { url: logUrl } : {}),
          ...(headers ? { headers } : {}),
        });
        const logProcessor = new BatchLogRecordProcessor(
          logExporter,
          typeof otel.flushIntervalMs === "number"
            ? { scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs) }
            : {},
        );
        logProvider = new LoggerProvider({
          resource,
          processors: [logProcessor],
        });
        const otelLogger = logProvider.getLogger("openclaw");

        stopLogTransport = registerLogTransport((logObj) => {
          try {
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
          } catch (err) {
            ctx.logger.error(`diagnostics-otel: log transport failed: ${formatError(err)}`);
          }
        });
      }

      const captureContent = resolveCaptureContent(otel.captureContent);

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

      const runSpans = new Map<string, { span: Span; createdAt: number }>();
      const RUN_SPAN_TTL_MS = 10 * 60 * 1000;
      const inferenceSpans = new Map<string, { span: Span; createdAt: number }>();
      const INFERENCE_SPAN_TTL_MS = 10 * 60 * 1000;
      const activeInferenceSpanByRunId = new Map<string, Span>();
      const runProviderByRunId = new Map<string, string>();

      const createToolSpan = (
        evt: Extract<DiagnosticEventPayload, { type: "tool.execution" }>,
        parentCtx?: ReturnType<typeof context.active>,
      ) => {
        const spanAttrs: Record<string, string | number> = {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": evt.toolName,
          "gen_ai.tool.type": evt.toolType ?? "function",
        };
        if (evt.runId) {
          const provider = runProviderByRunId.get(evt.runId);
          if (provider) {
            spanAttrs["gen_ai.provider.name"] = provider;
          }
        }
        if (evt.toolCallId) {
          spanAttrs["gen_ai.tool.call.id"] = evt.toolCallId;
        }
        if (evt.channel) {
          spanAttrs["openclaw.channel"] = evt.channel;
        }
        if (captureContent.toolContent) {
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

      const agentInfoCache = new Map<string, AgentInfo | null>();
      const resolveAgentInfo = (sessionKey?: string): AgentInfo | null => {
        if (!sessionKey) {
          return null;
        }
        const cached = agentInfoCache.get(sessionKey);
        if (cached !== undefined) {
          return cached;
        }
        const agentId = resolveAgentIdFromSessionKey(sessionKey);
        const identity = resolveAgentIdentity(ctx.config, agentId);
        const info: AgentInfo = { id: agentId, name: identity?.name?.trim() || undefined };
        agentInfoCache.set(sessionKey, info);
        return info;
      };

      const ensureRunSpan = (params: {
        runId?: string;
        sessionKey?: string;
        sessionId?: string;
        channel?: string;
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
          "openclaw.type": "openclaw.agent.turn",
          ...params.attributes,
        };
        if (params.sessionKey) {
          spanAttrs["openclaw.sessionKey"] = params.sessionKey;
          spanAttrs[TRACE_ATTRS.SESSION_ID] = params.sessionKey;
        }
        if (params.sessionId) {
          spanAttrs["openclaw.sessionId"] = params.sessionId;
          spanAttrs["gen_ai.conversation.id"] = params.sessionId;
        }
        if (params.channel) {
          spanAttrs["openclaw.channel"] = params.channel;
        }

        // GenAI agent identity attributes (gen_ai.agent.*)
        const agentInfo = resolveAgentInfo(params.sessionKey);
        if (agentInfo) {
          spanAttrs["gen_ai.agent.id"] = agentInfo.id;
          if (agentInfo.name) {
            spanAttrs["gen_ai.agent.name"] = agentInfo.name;
          }
        }
        spanAttrs["gen_ai.operation.name"] = "invoke_agent";

        // Parent under root trace span if available (created by message.queued)
        const rootTrace = params.sessionKey ? activeTraces.get(params.sessionKey) : undefined;
        const parentCtx = rootTrace
          ? trace.setSpan(context.active(), rootTrace.span)
          : context.active();

        const spanName = agentInfo?.name ? `invoke_agent ${agentInfo.name}` : "invoke_agent";
        const span = tracer.startSpan(
          spanName,
          {
            attributes: spanAttrs,
            ...(typeof params.startTimeMs === "number" ? { startTime: params.startTimeMs } : {}),
            kind: SpanKind.INTERNAL,
          },
          parentCtx,
        );
        runSpans.set(runId, { span, createdAt: Date.now() });

        // Store W3C trace headers for propagation to downstream LLM providers
        if (params.sessionKey) {
          const spanContext = span.spanContext();
          if (isSpanContextValid(spanContext)) {
            getTraceHeadersRegistry().set(params.sessionKey, {
              traceparent: formatTraceparent(spanContext),
              ...(spanContext.traceState && { tracestate: spanContext.traceState.serialize() }),
            });
          }
        }

        if (debugExports) {
          ctx.logger.info(`diagnostics-otel: span created ${spanName}`);
        }
        return span;
      };

      // Construct the handler context object used by all event handlers
      const hctx: OtelHandlerCtx = {
        tracer,
        metrics: otelMetrics,
        captureContent,
        tracesEnabled,
        debugExports,
        logger: ctx.logger,
        activeTraces,
        runSpans,
        inferenceSpans,
        activeInferenceSpanByRunId,
        runProviderByRunId,
        resolveAgentInfo,
        spanWithDuration,
        safeJsonStringify,
        createToolSpan,
        ensureRunSpan,
        TRACE_ATTRS,
        getTraceHeadersRegistry,
      };

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
        // Clean up stale provider entries for completed/expired runs
        for (const runId of runProviderByRunId.keys()) {
          if (!runSpans.has(runId)) {
            runProviderByRunId.delete(runId);
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
        // Clean up orphaned trace headers whose session has no active trace or run span
        const registry = getTraceHeadersRegistry();
        for (const sessionKey of registry.keys()) {
          if (!activeTraces.has(sessionKey)) {
            registry.delete(sessionKey);
          }
        }
      }, 60_000);
      bufferCleanupTimer.unref?.();

      unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        try {
          if (debugExports) {
            ctx.logger.info(`diagnostics-otel: event received ${evt.type}`);
          }
          switch (evt.type) {
            case "model.inference.started":
              recordModelInferenceStarted(hctx, evt);
              return;
            case "model.inference":
              recordModelInference(hctx, evt);
              return;
            case "run.completed":
              recordRunCompleted(hctx, evt);
              return;
            case "webhook.received":
              recordWebhookReceived(hctx, evt);
              return;
            case "webhook.processed":
              recordWebhookProcessed(hctx, evt);
              return;
            case "webhook.error":
              recordWebhookError(hctx, evt);
              return;
            case "message.queued":
              recordMessageQueued(hctx, evt);
              return;
            case "message.processed":
              recordMessageProcessed(hctx, evt);
              return;
            case "queue.lane.enqueue":
              recordLaneEnqueue(hctx, evt);
              return;
            case "queue.lane.dequeue":
              recordLaneDequeue(hctx, evt);
              return;
            case "session.state":
              recordSessionState(hctx, evt);
              return;
            case "session.stuck":
              recordSessionStuck(hctx, evt);
              return;
            case "run.attempt":
              recordRunAttempt(hctx, evt);
              return;
            case "run.started":
              recordRunStarted(hctx, evt);
              return;
            case "diagnostic.heartbeat":
              recordHeartbeat(hctx, evt);
              return;
            case "tool.execution":
              recordToolExecution(hctx, evt);
              return;
          }
        } catch (err) {
          ctx.logger.error(
            `diagnostics-otel: event handler failed (${evt.type}): ${formatError(err)}`,
          );
        }
      });

      if (logsEnabled) {
        ctx.logger.info("diagnostics-otel: logs exporter enabled (OTLP/HTTP)");
      }
    },
    async stop(_ctx) {
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
      getTraceHeadersRegistry().clear();
      if (sdk) {
        await sdk.shutdown().catch(() => undefined);
        sdk = null;
      }
    },
  } satisfies OpenClawPluginService;
}
