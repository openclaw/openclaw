import type { Span, SpanContext } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode, hrTimeToMilliseconds } from "@opentelemetry/core";
import fs from "node:fs";

export const DEFAULT_SERVICE_NAME = "openclaw";
export const OTEL_DEBUG_ENV = "OPENCLAW_OTEL_DEBUG";
export const OTEL_DUMP_ENV = "OPENCLAW_OTEL_DUMP";

export function normalizeEndpoint(endpoint?: string): string | undefined {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

export function resolveOtelUrl(endpoint: string | undefined, path: string): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  if (endpoint.includes("/v1/")) {
    return endpoint;
  }
  return `${endpoint}/${path}`;
}

export function resolveSampleRate(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

/** Map internal provider names to gen_ai.provider.name enum values. */
export function mapProviderName(provider?: string): string {
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

export class LoggingTraceExporter implements SpanExporter {
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

export type ResolvedCaptureContent = {
  inputMessages: boolean;
  outputMessages: boolean;
  systemInstructions: boolean;
  toolDefinitions: boolean;
  toolContent: boolean;
};

/**
 * Resolve captureContent config to granular booleans.
 * - `true` → all enabled
 * - `false` / `undefined` → all disabled
 * - object → strict opt-in per field (`true` required; omitted/undefined = disabled)
 */
export function resolveCaptureContent(
  raw: boolean | Record<string, boolean | undefined> | undefined,
): ResolvedCaptureContent {
  if (raw === true) {
    return {
      inputMessages: true,
      outputMessages: true,
      systemInstructions: true,
      toolDefinitions: true,
      toolContent: true,
    };
  }
  if (!raw || typeof raw !== "object") {
    return {
      inputMessages: false,
      outputMessages: false,
      systemInstructions: false,
      toolDefinitions: false,
      toolContent: false,
    };
  }
  return {
    inputMessages: raw.inputMessages === true,
    outputMessages: raw.outputMessages === true,
    systemInstructions: raw.systemInstructions === true,
    toolDefinitions: raw.toolDefinitions === true,
    toolContent: raw.toolContent === true,
  };
}

/** Format a W3C Trace Context traceparent header from a SpanContext. */
export function formatTraceparent(spanContext: SpanContext): string {
  return `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, "0")}`;
}

export type TraceHeaders = {
  traceparent: string;
  tracestate?: string;
};

export interface ActiveTrace {
  span: Span;
  context: ReturnType<typeof import("@opentelemetry/api").context.active>;
  startedAt: number;
  sessionKey?: string;
  channel?: string;
  agentId?: string;
}
