import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { normalizeEndpoint, resolveOtelTracesUrl, type LlmTracingConfig } from "./config.js";

const DEFAULT_SERVICE_NAME = "openclaw";

// GenAI Semantic Convention attribute keys
// Ref: https://opentelemetry.io/docs/specs/semconv/gen-ai/
const GEN_AI_SYSTEM = "gen_ai.system";
const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
// Using standard attributes for prompt/completion (even if evolving, these are the standard targets)
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

type AgentToolCall = {
  type: "function";
  id: string;
  function: {
    name: string;
    arguments: string;
  };
};

type AgentMessage = {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AgentToolCall[];
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
  };
};

function parseToolCalls(value: unknown): AgentToolCall[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object") {
        return null;
      }
      const record = toolCall as Record<string, unknown>;
      if (record.type && record.type !== "function") {
        return null;
      }
      const functionRecord =
        typeof record.function === "object" && record.function !== null
          ? (record.function as Record<string, unknown>)
          : {};
      const name = typeof functionRecord.name === "string" ? functionRecord.name.trim() : "";
      if (!name) {
        return null;
      }
      const id = typeof record.id === "string" ? record.id : "unknown";
      const argsValue = functionRecord.arguments;
      let args = "{}";
      if (typeof argsValue === "string") {
        args = argsValue;
      } else {
        try {
          args = JSON.stringify(argsValue ?? {});
        } catch {
          args = "{}";
        }
      }

      return {
        type: "function",
        id,
        function: {
          name,
          arguments: args,
        },
      };
    })
    .filter((toolCall): toolCall is AgentToolCall => toolCall !== null);

  return parsed.length > 0 ? parsed : undefined;
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
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return "";
}

function parseMessages(messages: unknown[]): AgentMessage[] {
  return messages
    .filter((msg): msg is Record<string, unknown> => msg != null && typeof msg === "object")
    .map((msg) => {
      const role = typeof msg.role === "string" ? msg.role : "unknown";

      // Extract tool calls
      const tool_calls = parseToolCalls(msg.tool_calls);

      return {
        role,
        content: msg.content,
        name: typeof msg.name === "string" ? msg.name : undefined,
        tool_call_id: typeof msg.tool_call_id === "string" ? msg.tool_call_id : undefined,
        tool_calls,
        model: typeof msg.model === "string" ? msg.model : undefined,
        usage:
          msg.usage && typeof msg.usage === "object"
            ? (msg.usage as AgentMessage["usage"])
            : undefined,
      };
    });
}

function findLastAssistant(messages: AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      return messages[i];
    }
  }
  return undefined;
}

// Convert messages to a generic chat format for tracing
// This maps to the gen_ai.prompt attribute
function formatLlmInput(messages: AgentMessage[], systemPrompt?: string): string {
  const lastAssistantIndex = messages.findLastIndex((m) => m.role === "assistant");
  const inputMessages = lastAssistantIndex >= 0 ? messages.slice(0, lastAssistantIndex) : messages;

  const formattedMessages = inputMessages.map((msg) => {
    const base: Record<string, unknown> = {
      role: msg.role,
      content: extractTextContent(msg.content),
    };

    if (msg.name) {
      base.name = msg.name;
    }
    if (msg.tool_call_id) {
      base.tool_call_id = msg.tool_call_id;
    }
    if (msg.tool_calls) {
      base.tool_calls = msg.tool_calls;
    }

    return base;
  });

  if (systemPrompt) {
    formattedMessages.unshift({
      role: "system",
      content: systemPrompt,
    });
  }
  return JSON.stringify(formattedMessages);
}
function formatLlmOutput(message: AgentMessage): string {
  const base: Record<string, unknown> = {
    role: message.role,
    content: extractTextContent(message.content),
  };

  if (message.tool_calls) {
    base.tool_calls = message.tool_calls;
  }

  return JSON.stringify(base);
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

      // Initialize OpenTelemetry SDK using factory function
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

      // Normalize sync/async SDK start across OpenTelemetry versions.
      await Promise.resolve(sdk.start());

      // Get tracer after SDK is started
      const tracer = trace.getTracer("llm-tracing", "1.0.0");

      ctx.logger.info(`llm-tracing: initialized, endpoint=${tracesUrl}`);
      ctx.logger.info("llm-tracing: registering agent_end hook in service.start()");

      api.on("agent_end", async (event, hookCtx) => {
        ctx.logger.info(
          `llm-tracing: agent_end hook triggered, messages count: ${event.messages?.length ?? 0}`,
        );
        ctx.logger.info(
          `llm-tracing: hook context: sessionKey=${hookCtx?.sessionKey}, agentId=${hookCtx?.agentId}`,
        );

        if (!event.messages || event.messages.length === 0) {
          ctx.logger.warn("llm-tracing: no messages in event");
          return;
        }

        try {
          const messages = parseMessages(event.messages);

          // Log the last few messages roles to verify structure
          const lastRoles = messages
            .slice(-3)
            .map((m) => m.role)
            .join(", ");
          ctx.logger.info(`llm-tracing: parsed messages last roles: [${lastRoles}]`);

          // The 'assistant' message is usually the very last message in the conversation for a completion event
          // OR it's the specific generation we just did.
          // However, 'event.messages' usually contains the FULL history including the new assistant response.
          const lastAssistant = findLastAssistant(messages);

          if (!lastAssistant) {
            ctx.logger.warn(
              "llm-tracing: no assistant message found in history, skipping trace generation",
            );
            return;
          }

          const systemPrompt = event.systemPrompt;
          const input = formatLlmInput(messages, systemPrompt);
          const output = formatLlmOutput(lastAssistant);
          const model = lastAssistant.model ?? "unknown";
          const usage = lastAssistant.usage;

          ctx.logger.info(
            `llm-tracing: preparing span for model=${model}, input_len=${input.length}, output_len=${output.length}`,
          );

          const startTime = event.durationMs
            ? Date.now() - Math.max(0, event.durationMs)
            : undefined;

          const span = tracer.startSpan("chat_completion", { startTime });

          // GenAI attributes
          span.setAttribute(GEN_AI_SYSTEM, "openai"); // Assuming OpenAI-compatible structure for now
          span.setAttribute(GEN_AI_REQUEST_MODEL, model);

          // Content attributes
          span.setAttribute(GEN_AI_PROMPT, input);
          span.setAttribute(GEN_AI_COMPLETION, output);

          if (usage?.input) {
            span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.input);
          }
          if (usage?.output) {
            span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.output);
          }

          // Session context - keep as custom attributes
          if (hookCtx?.hostId) {
            span.setAttribute("openclaw.host_id", hookCtx.hostId);
          }
          if (hookCtx?.gatewayInstanceId) {
            span.setAttribute("openclaw.gateway_instance_id", hookCtx.gatewayInstanceId);
          }
          if (event.runId) {
            span.setAttribute("openclaw.run_id", event.runId);
          }
          if (hookCtx?.sessionId) {
            span.setAttribute("openclaw.session_id", hookCtx.sessionId);
          }
          if (hookCtx?.sessionKey) {
            span.setAttribute("openclaw.session_key", hookCtx.sessionKey);
          }
          if (hookCtx?.agentId) {
            span.setAttribute("openclaw.agent_id", hookCtx.agentId);
          }

          if (!event.success) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: event.error ?? "Agent execution failed",
            });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }

          span.end();

          ctx.logger.info(
            `llm-tracing: traced generation for model=${model}, spanId=${span.spanContext().spanId}`,
          );
        } catch (err) {
          ctx.logger.error(`llm-tracing: failed to trace: ${String(err)}`);
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
