import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ToolCall,
  Tool,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { importNodeLlamaCpp } from "../memory/node-llama.js";

const log = createSubsystemLogger("llama-cpp-stream");

type LlamaInstance = Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>;
type LlamaModel = Awaited<
  ReturnType<Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>["loadModel"]>
>;
type LlamaContext = Awaited<ReturnType<LlamaModel["createContext"]>>;
type LlamaChat = InstanceType<Awaited<ReturnType<typeof import("node-llama-cpp")>>["LlamaChat"]>;
type ChatModelFunctions = Record<string, { description: string; params: Record<string, unknown> }>;

interface LoadedModel {
  llama: LlamaInstance;
  model: LlamaModel;
  context: LlamaContext;
  chat: LlamaChat;
}

const modelCache = new Map<string, Promise<LoadedModel>>();

async function getOrLoadModel(modelPath: string, gpuLayers?: number | "max"): Promise<LoadedModel> {
  const cacheKey = `${modelPath}:${gpuLayers ?? "max"}`;
  if (!modelCache.has(cacheKey)) {
    modelCache.set(cacheKey, loadModel(modelPath, gpuLayers));
  }
  return modelCache.get(cacheKey)!;
}

async function loadModel(modelPath: string, gpuLayers?: number | "max"): Promise<LoadedModel> {
  log.info(`loading llama.cpp model from ${modelPath}`);
  const startTime = Date.now();

  const { getLlama, LlamaChat } = await importNodeLlamaCpp();

  const llama = await getLlama();
  const model = await llama.loadModel({
    modelPath,
    gpuLayers: gpuLayers ?? "max",
  });

  const context = await model.createContext();
  const sequence = await context.getSequence();
  const chat = new LlamaChat({ contextSequence: sequence });

  const elapsed = Date.now() - startTime;
  log.info(`llama.cpp model loaded in ${elapsed}ms`);

  return { llama, model, context, chat };
}

type InputContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as InputContentPart[])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function extractToolCalls(content: unknown): Array<{
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}> {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts = content as InputContentPart[];
  const result: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  for (const part of parts) {
    if (part.type === "toolCall") {
      result.push({ id: part.id, name: part.name, arguments: part.arguments });
    } else if (part.type === "tool_use") {
      result.push({ id: part.id, name: part.name, arguments: part.input });
    }
  }
  return result;
}

function extractToolResultContent(msg: { role: string; content: unknown; toolCallId?: string }): {
  toolCallId?: string;
  result: string;
} {
  return {
    toolCallId: msg.toolCallId,
    result: extractTextContent(msg.content),
  };
}

type FunctionCallResponse = {
  type: "functionCall";
  name: string;
  params: Record<string, unknown>;
  result?: unknown;
};

type ChatHistoryItem =
  | { type: "system"; text: string }
  | { type: "user"; text: string }
  | {
      type: "model";
      response: Array<string | FunctionCallResponse>;
    };

interface InputMessage {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolName?: string;
}

export function convertToChatHistory(messages: InputMessage[]): {
  chatHistory: ChatHistoryItem[];
  pendingToolCalls: Map<string, string>;
} {
  const chatHistory: ChatHistoryItem[] = [];
  const pendingToolCalls = new Map<string, string>();

  for (const msg of messages) {
    const { role } = msg;

    if (role === "system") {
      chatHistory.push({
        type: "system",
        text: extractTextContent(msg.content),
      });
    } else if (role === "user") {
      chatHistory.push({
        type: "user",
        text: extractTextContent(msg.content),
      });
    } else if (role === "assistant") {
      const text = extractTextContent(msg.content);
      const toolCalls = extractToolCalls(msg.content);

      const response: Array<string | FunctionCallResponse> = [];

      if (text) {
        response.push(text);
      }

      for (const tc of toolCalls) {
        pendingToolCalls.set(tc.id, tc.name);
        response.push({
          type: "functionCall",
          name: tc.name,
          params: tc.arguments,
        });
      }

      if (response.length > 0) {
        chatHistory.push({
          type: "model",
          response,
        });
      }
    } else if (role === "tool" || role === "toolResult") {
      const { toolCallId, result } = extractToolResultContent(msg);
      const toolName = pendingToolCalls.get(toolCallId ?? "");

      if (toolName && chatHistory.length > 0) {
        const lastItem = chatHistory[chatHistory.length - 1];
        if (lastItem?.type === "model") {
          for (const resp of lastItem.response) {
            if (
              typeof resp === "object" &&
              resp !== null &&
              "type" in resp &&
              resp.type === "functionCall" &&
              "name" in resp &&
              resp.name === toolName &&
              resp.result === undefined
            ) {
              try {
                resp.result = JSON.parse(result);
              } catch {
                resp.result = result;
              }
              break;
            }
          }
        }
      }
    }
  }

  return { chatHistory, pendingToolCalls };
}

function convertToFunctions(tools: Tool[] | undefined): ChatModelFunctions | undefined {
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  const functions: ChatModelFunctions = {};
  for (const tool of tools) {
    if (typeof tool.name !== "string" || !tool.name) {
      continue;
    }
    functions[tool.name] = {
      description: typeof tool.description === "string" ? tool.description : "",
      params: (tool.parameters ?? {}) as Record<string, unknown>,
    };
  }
  return functions;
}

export function buildAssistantMessage(
  text: string,
  functionCalls:
    | Array<{
        functionName: string;
        params: Record<string, unknown>;
      }>
    | undefined,
  modelInfo: { api: string; provider: string; id: string },
): AssistantMessage {
  const content: (TextContent | ToolCall)[] = [];

  if (text) {
    content.push({ type: "text", text });
  }

  if (functionCalls && functionCalls.length > 0) {
    for (const fc of functionCalls) {
      content.push({
        type: "toolCall",
        id: `llamacpp_call_${randomUUID()}`,
        name: fc.functionName,
        arguments: fc.params,
      });
    }
  }

  const hasToolCalls = functionCalls && functionCalls.length > 0;
  const stopReason: StopReason = hasToolCalls ? "toolUse" : "stop";

  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  return {
    role: "assistant",
    content,
    stopReason,
    api: modelInfo.api,
    provider: modelInfo.provider,
    model: modelInfo.id,
    usage,
    timestamp: Date.now(),
  };
}

export function createLlamaCppStreamFn(modelPath: string, gpuLayers?: number | "max"): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const { chat } = await getOrLoadModel(modelPath, gpuLayers);

        const { chatHistory } = convertToChatHistory(context.messages ?? []);
        const functions = convertToFunctions(context.tools);

        let accumulatedText = "";
        const functionCalls: Array<{
          functionName: string;
          params: Record<string, unknown>;
        }> = [];

        const response = await chat.generateResponse(chatHistory, {
          systemPrompt: context.systemPrompt,
          functions,
          signal: options?.signal,
          maxTokens: options?.maxTokens,
          temperature: options?.temperature ?? 0.8,

          onTextChunk: (text) => {
            accumulatedText += text;
          },

          onFunctionCall: (functionCallResult) => {
            functionCalls.push({
              functionName: functionCallResult.functionName,
              params: functionCallResult.params ?? {},
            });
          },
        });

        if (response.responseText) {
          accumulatedText = response.responseText;
        }

        if (response.functionCalls && response.functionCalls.length > 0) {
          for (const fc of response.functionCalls) {
            functionCalls.push({
              functionName: fc.functionName,
              params: fc.params ?? {},
            });
          }
        }

        const assistantMessage = buildAssistantMessage(accumulatedText, functionCalls, {
          api: model.api,
          provider: model.provider,
          id: model.id,
        });

        const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
          assistantMessage.stopReason === "toolUse" ? "toolUse" : "stop";

        stream.push({
          type: "done",
          reason,
          message: assistantMessage,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error(`llama.cpp inference error: ${errorMessage}`);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant" as const,
            content: [],
            stopReason: "error" as StopReason,
            errorMessage,
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
            timestamp: Date.now(),
          },
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}

export async function disposeLlamaCppModels(): Promise<void> {
  const models = await Promise.allSettled(Array.from(modelCache.values()));
  modelCache.clear();

  for (const result of models) {
    if (result.status === "fulfilled") {
      try {
        await result.value.context.dispose();
        await result.value.model.dispose();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`error disposing llama.cpp model: ${errorMessage}`);
      }
    }
  }
}
