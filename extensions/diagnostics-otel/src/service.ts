import { metrics, trace } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";

import type {
  ClawdbotPluginService,
  DiagnosticUsageEvent,
} from "clawdbot/plugin-sdk";
import { onDiagnosticEvent } from "clawdbot/plugin-sdk";

const DEFAULT_SERVICE_NAME = "clawdbot";

function normalizeEndpoint(endpoint?: string): string | undefined {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function resolveOtelUrl(endpoint: string | undefined, path: string): string | undefined {
  if (!endpoint) return undefined;
  if (endpoint.includes("/v1/")) return endpoint;
  return `${endpoint}/${path}`;
}

function resolveSampleRate(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

export function createDiagnosticsOtelService(): ClawdbotPluginService {
  let sdk: NodeSDK | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    id: "diagnostics-otel",
    async start(ctx) {
      const cfg = ctx.config.diagnostics;
      const otel = cfg?.otel;
      if (!cfg?.enabled || !otel?.enabled) return;

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
      if (!tracesEnabled && !metricsEnabled) return;

      const resource = new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      });

      const traceUrl = resolveOtelUrl(endpoint, "v1/traces");
      const metricUrl = resolveOtelUrl(endpoint, "v1/metrics");
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

      await sdk.start();

      const meter = metrics.getMeter("clawdbot");
      const tracer = trace.getTracer("clawdbot");

      const tokensCounter = meter.createCounter("clawdbot.tokens", {
        unit: "1",
        description: "Token usage by type",
      });
      const costCounter = meter.createCounter("clawdbot.cost.usd", {
        unit: "1",
        description: "Estimated model cost (USD)",
      });
      const durationHistogram = meter.createHistogram("clawdbot.run.duration_ms", {
        unit: "ms",
        description: "Agent run duration",
      });
      const contextHistogram = meter.createHistogram("clawdbot.context.tokens", {
        unit: "1",
        description: "Context window size and usage",
      });

      unsubscribe = onDiagnosticEvent((evt) => {
        if (evt.type !== "model.usage") return;
        const usageEvent = evt as DiagnosticUsageEvent;
        const attrs = {
          "clawdbot.channel": usageEvent.channel ?? "unknown",
          "clawdbot.provider": usageEvent.provider ?? "unknown",
          "clawdbot.model": usageEvent.model ?? "unknown",
        };

        const usage = usageEvent.usage;
        if (usage.input) tokensCounter.add(usage.input, { ...attrs, "clawdbot.token": "input" });
        if (usage.output)
          tokensCounter.add(usage.output, { ...attrs, "clawdbot.token": "output" });
        if (usage.cacheRead)
          tokensCounter.add(usage.cacheRead, { ...attrs, "clawdbot.token": "cache_read" });
        if (usage.cacheWrite)
          tokensCounter.add(usage.cacheWrite, { ...attrs, "clawdbot.token": "cache_write" });
        if (usage.promptTokens)
          tokensCounter.add(usage.promptTokens, { ...attrs, "clawdbot.token": "prompt" });
        if (usage.total)
          tokensCounter.add(usage.total, { ...attrs, "clawdbot.token": "total" });

        if (usageEvent.costUsd) costCounter.add(usageEvent.costUsd, attrs);
        if (usageEvent.durationMs) durationHistogram.record(usageEvent.durationMs, attrs);
        if (usageEvent.context?.limit)
          contextHistogram.record(usageEvent.context.limit, {
            ...attrs,
            "clawdbot.context": "limit",
          });
        if (usageEvent.context?.used)
          contextHistogram.record(usageEvent.context.used, {
            ...attrs,
            "clawdbot.context": "used",
          });

        if (!tracesEnabled) return;
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "clawdbot.sessionKey": usageEvent.sessionKey ?? "",
          "clawdbot.sessionId": usageEvent.sessionId ?? "",
          "clawdbot.tokens.input": usage.input ?? 0,
          "clawdbot.tokens.output": usage.output ?? 0,
          "clawdbot.tokens.cache_read": usage.cacheRead ?? 0,
          "clawdbot.tokens.cache_write": usage.cacheWrite ?? 0,
          "clawdbot.tokens.total": usage.total ?? 0,
        };

        const startTime = usageEvent.durationMs
          ? Date.now() - Math.max(0, usageEvent.durationMs)
          : undefined;
        const span = tracer.startSpan("clawdbot.model.usage", {
          attributes: spanAttrs,
          ...(startTime ? { startTime } : {}),
        });
        span.end();
      });

      if (otel.logs) {
        ctx.logger.warn("diagnostics-otel: logs exporter not wired yet");
      }
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      if (sdk) {
        await sdk.shutdown().catch(() => undefined);
        sdk = null;
      }
    },
  } satisfies ClawdbotPluginService;
}
