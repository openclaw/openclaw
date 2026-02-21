import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from "@mariozechner/pi-ai";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { calculateCost } from "@mariozechner/pi-ai/dist/models.js";
import {
  buildBaseOptions,
  adjustMaxTokensForThinking,
} from "@mariozechner/pi-ai/dist/providers/simple-options.js";
import { transformMessages } from "@mariozechner/pi-ai/dist/providers/transform-messages.js";
import { AssistantMessageEventStream as EventStream } from "@mariozechner/pi-ai/dist/utils/event-stream.js";
import { parseStreamingJson } from "@mariozechner/pi-ai/dist/utils/json-parse.js";
import { sanitizeSurrogates } from "@mariozechner/pi-ai/dist/utils/sanitize-unicode.js";
import { GoogleAuth } from "google-auth-library";

type VertexStreamOptions = StreamOptions & {
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  effort?: string;
  interleavedThinking?: boolean;
  toolChoice?: string | { type: string; name?: string };
};

let cachedClient: AnthropicVertex | null = null;

function getClient(): AnthropicVertex {
  if (cachedClient) return cachedClient;

  const region = process.env.ANTHROPIC_VERTEX_REGION || "europe-west1";
  const projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID;

  if (!projectId) {
    throw new Error("ANTHROPIC_VERTEX_PROJECT_ID is required. Set it to your GCP project ID.");
  }

  const keyFile =
    process.env.SERVICE_ACCOUNT_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;

  const googleAuth = keyFile
    ? new GoogleAuth({
        keyFile,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      })
    : new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });

  cachedClient = new AnthropicVertex({ region, projectId, googleAuth });
  return cachedClient;
}

function mapStopReason(reason: string): "stop" | "length" | "toolUse" | "error" {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
    case "sensitive":
      return "error";
    default:
      throw new Error(`Unhandled stop reason: ${reason}`);
  }
}

function normalizeToolCallId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertContentBlocks(content: any[]) {
  const hasImages = content.some((c: any) => c.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(content.map((c: any) => c.text ?? "").join("\n"));
  }
  const blocks = content.map((block: any) => {
    if (block.type === "text") {
      return { type: "text", text: sanitizeSurrogates(block.text ?? "") };
    }
    return {
      type: "image",
      source: { type: "base64", media_type: block.mimeType, data: block.data },
    };
  });
  if (!blocks.some((b: any) => b.type === "text")) {
    blocks.unshift({ type: "text", text: "(see attached image)" });
  }
  return blocks;
}

function buildVertexMessages(contextMessages: any[], model: any) {
  const params: any[] = [];
  const transformed = transformMessages(contextMessages, model, normalizeToolCallId);

  for (let i = 0; i < transformed.length; i++) {
    const msg: any = transformed[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
        }
      } else {
        const blocks = msg.content.map((item: any) => {
          if (item.type === "text") {
            return { type: "text", text: sanitizeSurrogates(item.text) };
          }
          return {
            type: "image",
            source: { type: "base64", media_type: item.mimeType, data: item.data },
          };
        });
        let filtered = !model?.input.includes("image")
          ? blocks.filter((b: any) => b.type !== "image")
          : blocks;
        filtered = filtered.filter((b: any) => b.type !== "text" || b.text.trim().length > 0);
        if (filtered.length === 0) continue;
        params.push({ role: "user", content: filtered });
      }
    } else if (msg.role === "assistant") {
      const blocks: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) continue;
          blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
        } else if (block.type === "thinking") {
          if (block.thinking.trim().length === 0) continue;
          if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
            blocks.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
          } else {
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature: block.thinkingSignature,
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments ?? {},
          });
        }
      }
      if (blocks.length === 0) continue;
      params.push({ role: "assistant", content: blocks });
    } else if (msg.role === "toolResult") {
      const toolResults: any[] = [];
      toolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: convertContentBlocks(msg.content),
        is_error: msg.isError,
      });
      let j = i + 1;
      while (j < transformed.length && (transformed[j] as any).role === "toolResult") {
        const next: any = transformed[j];
        toolResults.push({
          type: "tool_result",
          tool_use_id: next.toolCallId,
          content: convertContentBlocks(next.content),
          is_error: next.isError,
        });
        j++;
      }
      i = j - 1;
      params.push({ role: "user", content: toolResults });
    }
  }
  return params;
}

function convertTools(tools: any) {
  if (!tools) return [];
  return tools.map((tool: any) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: tool.parameters?.properties || {},
      required: tool.parameters?.required || [],
    },
  }));
}

function supportsAdaptiveThinking(modelId: string) {
  return modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}

function mapThinkingLevelToEffort(level: string): "low" | "medium" | "high" | "max" {
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "max";
    default:
      return "high";
  }
}

function buildParams(model: any, context: any, options?: VertexStreamOptions) {
  const params: any = {
    model: model.id,
    messages: buildVertexMessages(context.messages, model),
    max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
    stream: true,
  };

  if (context.systemPrompt) {
    params.system = [{ type: "text", text: sanitizeSurrogates(context.systemPrompt) }];
  }

  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  if (context.tools) {
    params.tools = convertTools(context.tools);
  }

  if (options?.thinkingEnabled && model.reasoning) {
    if (supportsAdaptiveThinking(model.id)) {
      params.thinking = { type: "adaptive" };
      if (options.effort) {
        params.output_config = { effort: options.effort };
      }
    } else {
      params.thinking = { type: "enabled", budget_tokens: options.thinkingBudgetTokens || 1024 };
    }
  }

  if (options?.toolChoice) {
    params.tool_choice =
      typeof options.toolChoice === "string" ? { type: options.toolChoice } : options.toolChoice;
  }

  return params;
}

export const streamAnthropicVertex = (
  model: Model<Api>,
  context: Context,
  options?: VertexStreamOptions,
): AssistantMessageEventStream => {
  const stream: any = new (EventStream as any)();

  (async () => {
    const output: any = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const client = getClient();
      const params = buildParams(model, context, options);
      options?.onPayload?.(params);

      const anthropicStream = client.messages.stream(params, { signal: options?.signal });

      stream.push({ type: "start", partial: output });
      const blocks: any[] = output.content;

      for await (const event of anthropicStream) {
        if (event.type === "message_start") {
          const mu = (event as any).message.usage;
          output.usage.input = mu.input_tokens || 0;
          output.usage.output = mu.output_tokens || 0;
          output.usage.cacheRead = mu.cache_read_input_tokens || 0;
          output.usage.cacheWrite = mu.cache_creation_input_tokens || 0;
          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
          calculateCost(model as any, output.usage);
        } else if (event.type === "content_block_start") {
          const cb = (event as any).content_block;
          const idx = (event as any).index;

          if (cb.type === "text") {
            blocks.push({ type: "text", text: "", index: idx });
            stream.push({ type: "text_start", contentIndex: blocks.length - 1, partial: output });
          } else if (cb.type === "thinking") {
            blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: idx });
            stream.push({
              type: "thinking_start",
              contentIndex: blocks.length - 1,
              partial: output,
            });
          } else if (cb.type === "tool_use") {
            blocks.push({
              type: "toolCall",
              id: cb.id,
              name: cb.name,
              arguments: cb.input ?? {},
              partialJson: "",
              index: idx,
            });
            stream.push({
              type: "toolcall_start",
              contentIndex: blocks.length - 1,
              partial: output,
            });
          }
        } else if (event.type === "content_block_delta") {
          const delta = (event as any).delta;
          const idx = (event as any).index;
          const index = blocks.findIndex((b: any) => b.index === idx);
          const block = blocks[index];

          if (delta.type === "text_delta" && block?.type === "text") {
            block.text += delta.text;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta: delta.text,
              partial: output,
            });
          } else if (delta.type === "thinking_delta" && block?.type === "thinking") {
            block.thinking += delta.thinking;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta: delta.thinking,
              partial: output,
            });
          } else if (delta.type === "input_json_delta" && block?.type === "toolCall") {
            block.partialJson += delta.partial_json;
            block.arguments = parseStreamingJson(block.partialJson);
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta: delta.partial_json,
              partial: output,
            });
          } else if (delta.type === "signature_delta" && block?.type === "thinking") {
            block.thinkingSignature = (block.thinkingSignature || "") + delta.signature;
          }
        } else if (event.type === "content_block_stop") {
          const idx = (event as any).index;
          const index = blocks.findIndex((b: any) => b.index === idx);
          const block = blocks[index];
          if (block) {
            delete block.index;
            if (block.type === "text") {
              stream.push({
                type: "text_end",
                contentIndex: index,
                content: block.text,
                partial: output,
              });
            } else if (block.type === "thinking") {
              stream.push({
                type: "thinking_end",
                contentIndex: index,
                content: block.thinking,
                partial: output,
              });
            } else if (block.type === "toolCall") {
              block.arguments = parseStreamingJson(block.partialJson);
              delete block.partialJson;
              stream.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall: block,
                partial: output,
              });
            }
          }
        } else if (event.type === "message_delta") {
          const delta = (event as any).delta;
          const eu = (event as any).usage;

          if (delta.stop_reason) {
            output.stopReason = mapStopReason(delta.stop_reason);
          }
          if (eu.input_tokens != null) output.usage.input = eu.input_tokens;
          if (eu.output_tokens != null) output.usage.output = eu.output_tokens;
          if (eu.cache_read_input_tokens != null)
            output.usage.cacheRead = eu.cache_read_input_tokens;
          if (eu.cache_creation_input_tokens != null)
            output.usage.cacheWrite = eu.cache_creation_input_tokens;
          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
          calculateCost(model as any, output.usage);
        }
      }

      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) delete block.index;
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamSimpleAnthropicVertex = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const base = buildBaseOptions(model, options, (options as any)?.apiKey ?? "");

  if (!(options as any)?.reasoning) {
    return streamAnthropicVertex(model, context, { ...base, thinkingEnabled: false });
  }

  if (supportsAdaptiveThinking(model.id)) {
    const effort = mapThinkingLevelToEffort((options as any).reasoning);
    return streamAnthropicVertex(model, context, { ...base, thinkingEnabled: true, effort });
  }

  const adjusted = adjustMaxTokensForThinking(
    base.maxTokens || 0,
    model.maxTokens,
    (options as any).reasoning,
    (options as any).thinkingBudgets,
  );
  return streamAnthropicVertex(model, context, {
    ...base,
    maxTokens: adjusted.maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: adjusted.thinkingBudget,
  });
};
