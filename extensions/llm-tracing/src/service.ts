import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk";
import { normalizeEndpoint, resolveOtelTracesUrl } from "./config.js";
import type { LlmTracingConfig } from "./config.js";

const DEFAULT_SERVICE_NAME = "openclaw";

// GenAI Semantic Convention attribute keys
// Ref: https://opentelemetry.io/docs/specs/semconv/gen-ai/
const GEN_AI_SYSTEM = "gen_ai.system";
const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const GEN_AI_PROMPT = "gen_ai.prompt";
const GEN_AI_COMPLETION = "gen_ai.completion";

function resolveSampleRate(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const asRecord = part as Record<string, unknown>;
        if (asRecord.type === "text" && typeof asRecord.text === "string") {
          return asRecord.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function formatInputMessages(
  systemPrompt: string | undefined,
  historyMessages: unknown[],
  prompt: string,
): string {
  const messages: Array<{ role: string; content: string }> = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const msg of historyMessages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const m = msg as { role?: unknown; content?: unknown };
    const role = typeof m.role === "string" ? m.role : "unknown";
    messages.push({ role, content: extractTextContent(m.content) });
  }

  messages.push({ role: "user", content: prompt });

  return JSON.stringify(messages);
}

export function createLlmTracingService(api: OpenClawPluginApi): OpenClawPluginService {
  let sdk: NodeSDK | null = null;

  return {
    id: "llm-tracing",
    async start(ctx) {
      const cfg: LlmTracingConfig = ctx.config.diagnostics?.llmTracing ?? {};

      if (!cfg.enabled) {
        ctx.logger.info("llm-tracing: disabled (set diagnostics.llmTracing.enabled = true)");
        return;
      }

      const endpoint = normalizeEndpoint(cfg.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
      const tracesUrl = resolveOtelTracesUrl(endpoint);

      if (!tracesUrl) {
        ctx.logger.warn("llm-tracing: no endpoint configured, skipping initialization");
        return;
      }

      const serviceName =
        cfg.serviceName?.trim() || process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
      const headers = cfg.headers;
      const sampleRate = resolveSampleRate(cfg.sampleRate);

      const resource = resourceFromAttributes({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      });

      const traceExporter = new OTLPTraceExporter({
        url: tracesUrl,
        headers,
      });

      sdk = new NodeSDK({
        resource,
        traceExporter,
        ...(sampleRate !== undefined
          ? {
              sampler: new ParentBasedSampler({
                root: new TraceIdRatioBasedSampler(sampleRate),
              }),
            }
          : {}),
      });

      await Promise.resolve(sdk.start());

      const tracer = trace.getTracer("llm-tracing", "1.0.0");
      ctx.logger.info(`llm-tracing: initialized, endpoint=${tracesUrl}`);

      // runId → active span: correlates llm_input with llm_output for the same LLM call
      const pendingSpans = new Map<string, Span>();

      // llm_input fires before each LLM API call with full input context including systemPrompt.
      // Create one OTel span per LLM call.
      api.on("llm_input", async (event, hookCtx) => {
        try {
          const input = formatInputMessages(
            event.systemPrompt,
            event.historyMessages,
            event.prompt,
          );
          const span = tracer.startSpan(`${event.provider}/${event.model}`);

          span.setAttribute(GEN_AI_SYSTEM, event.provider);
          span.setAttribute(GEN_AI_REQUEST_MODEL, event.model);
          span.setAttribute(GEN_AI_PROMPT, input);
          span.setAttribute("openclaw.run_id", event.runId);
          span.setAttribute("openclaw.session_id", event.sessionId);

          if (hookCtx?.sessionKey) {
            span.setAttribute("openclaw.session_key", hookCtx.sessionKey);
          }
          if (hookCtx?.agentId) {
            span.setAttribute("openclaw.agent_id", hookCtx.agentId);
          }
          if (hookCtx?.hostId) {
            span.setAttribute("openclaw.host_id", hookCtx.hostId);
          }
          if (hookCtx?.gatewayInstanceId) {
            span.setAttribute("openclaw.gateway_instance_id", hookCtx.gatewayInstanceId);
          }

          pendingSpans.set(event.runId, span);
          ctx.logger.info(
            `llm-tracing: started span for runId=${event.runId} model=${event.provider}/${event.model}`,
          );
        } catch (err) {
          ctx.logger.error(`llm-tracing: failed to start span: ${String(err)}`);
        }
      });

      // llm_output fires after the LLM responds. Complete the matching span with output + usage.
      api.on("llm_output", async (event) => {
        const span = pendingSpans.get(event.runId);
        if (!span) {
          return;
        }

        try {
          const output = JSON.stringify({
            role: "assistant",
            content: event.assistantTexts.join("\n"),
          });

          span.setAttribute(GEN_AI_COMPLETION, output);

          if (event.usage?.input) {
            span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, event.usage.input);
          }
          if (event.usage?.output) {
            span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, event.usage.output);
          }

          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          ctx.logger.info(`llm-tracing: completed span for runId=${event.runId}`);
        } catch (err) {
          ctx.logger.error(`llm-tracing: failed to complete span: ${String(err)}`);
        } finally {
          pendingSpans.delete(event.runId);
        }
      });

      // agent_end: clean up any spans that didn't receive an llm_output (e.g., aborted calls).
      api.on("agent_end", async (event) => {
        if (!event.success && pendingSpans.size > 0) {
          for (const [runId, span] of pendingSpans) {
            try {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: event.error ?? "Agent execution failed",
              });
              span.end();
            } catch {
              // best-effort cleanup
            }
            pendingSpans.delete(runId);
          }
        }
      });
    },
    async stop() {
      if (sdk) {
        await sdk.shutdown().catch(() => undefined);
        sdk = null;
      }
    },
  } satisfies OpenClawPluginService;
}
