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

type NodeLlamaCpp = Awaited<ReturnType<typeof importNodeLlamaCpp>>;
type Llama = Awaited<ReturnType<NodeLlamaCpp["getLlama"]>>;
type LlamaModel = Awaited<ReturnType<Llama["loadModel"]>>;
type LlamaContext = Awaited<ReturnType<LlamaModel["createContext"]>>;
type LlamaChatSession = InstanceType<NodeLlamaCpp["LlamaChatSession"]>;

interface LoadedModel {
  llama: Llama;
  model: LlamaModel;
  context: LlamaContext;
  session: LlamaChatSession;
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

  const { getLlama, LlamaChatSession } = await importNodeLlamaCpp();

  const llama = await getLlama();

  log.info(`loading model with gpuLayers: ${gpuLayers ?? "default"}`);
  const model = await llama.loadModel({
    modelPath,
    gpuLayers: 0,
  });

  log.info(`creating context...`);
  const context = await model.createContext();

  log.info(`getting sequence...`);
  const sequence = context.getSequence();

  log.info(`creating chat session...`);
  const session = new LlamaChatSession({
    contextSequence: sequence,
  });

  const elapsed = Date.now() - startTime;
  log.info(`llama.cpp model loaded in ${elapsed}ms`);

  return { llama, model, context, session };
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

function convertToFunctions(
  tools: Tool[] | undefined,
): Record<string, { description: string; params: Record<string, unknown> }> | undefined {
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  const functions: Record<string, { description: string; params: Record<string, unknown> }> = {};
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
        const { session } = await getOrLoadModel(modelPath, gpuLayers);

        const functions = convertToFunctions(context.tools);

        let accumulatedText = "";
        const functionCalls: Array<{
          functionName: string;
          params: Record<string, unknown>;
        }> = [];

        const userMessage = context.messages
          ?.filter((msg) => msg.role === "user")
          .map((msg) => extractTextContent(msg.content))
          .join("\n");

        const response = await session.prompt(userMessage || "", {
          systemPrompt: context.systemPrompt,
          ...(functions ? { functions } : {}),
          signal: options?.signal,
          maxTokens: options?.maxTokens,
          temperature: options?.temperature ?? 0.8,

          onTextChunk: (text) => {
            accumulatedText += text;
          },
        });

        if (response.responseText) {
          accumulatedText = response.responseText;
        }

        if (response.functionCalls && response.functionCalls.length > 0) {
          for (const fc of response.functionCalls) {
            functionCalls.push({
              functionName: fc.functionName,
              params: (fc.params ?? {}) as Record<string, unknown>,
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
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`error disposing llama.cpp model: ${errorMessage}`);
      }
    }
  }
}
