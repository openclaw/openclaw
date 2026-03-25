/**
 * ReAct Fallback Core Logic
 *
 * Provides pure functions to inject ReAct prompts and parse ReAct responses out of standard text streams.
 */

export type ReactProfile = "minimal" | "verbose";

export interface ReActParsedResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

export function injectReActPrompt(
  currentSystemPrompt: string | undefined,
  tools: unknown[],
  profile: ReactProfile = "minimal",
): string {
  if (!tools || tools.length === 0) {
    return currentSystemPrompt || "";
  }

  const toolsTyped = tools as Array<{ name: string; description: string; parameters: unknown }>;
  const toolDefs = JSON.stringify(
    toolsTyped.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    null,
    2,
  );

  let reactInstruction = "";

  if (profile === "minimal") {
    reactInstruction = `
You have access to the following tools:
${toolDefs}

To use a tool, you MUST output exactly:
Action: {"tool": "tool_name", "args": {"arg1": "value"}}
`;
  } else {
    reactInstruction = `
You are an autonomous agent with access to external tools.
You MUST use the following tools to fulfill the user's request if necessary:
${toolDefs}

Your response must follow this EXACT format:
Thought: [Your internal reasoning about what to do next]
Action: {"tool": "tool_name", "args": {"param": "value"}}

Only output ONE Action per turn. If you do not need to use a tool, simply respond to the user normally and DO NOT output an Action block.
`;
  }

  const basePrompt = currentSystemPrompt ? currentSystemPrompt.trim() + "\n\n" : "";
  return basePrompt + reactInstruction.trim();
}

/**
 * Sanitizes reasoning blocks and extracts tool calls.
 */
export function parseReActResponse(
  responseText: string,
  isReasoningModel: boolean,
): ReActParsedResponse {
  let cleanedText = responseText;

  // 1. Sanitize Reasoning (Fix for LMStudio recursive internal thought parser bug)
  if (isReasoningModel) {
    // Remove everything between <think> and </think>
    // Also handle cases where the model forgets </think> and streams to the end
    cleanedText = cleanedText.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
  }

  // 2. Extract Tool Calls
  const toolCalls: ReActParsedResponse["toolCalls"] = [];

  // Split by Action: marker to handle multiple calls and nested JSON safely
  const actionSplitRegex = /Action:\s*/gi;
  const parts = cleanedText.split(actionSplitRegex);

  let textOutput = parts[0] ?? "";

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    let braceCount = 0;
    let jsonEndIndex = -1;
    let foundFirstBrace = false;

    let inString = false;
    let stringChar = "";
    let isEscaped = false;

    // A robust brace counter to locate the exact end of the JSON object, respecting strings
    for (let j = 0; j < part.length; j++) {
      const char = part[j];

      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === "\\") {
        isEscaped = true;
        continue;
      }

      if (inString) {
        if (char === stringChar) {
          inString = false;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        inString = true;
        stringChar = char;
        continue;
      }

      if (char === "{") {
        braceCount++;
        foundFirstBrace = true;
      } else if (char === "}") {
        braceCount--;
        if (foundFirstBrace && braceCount === 0) {
          jsonEndIndex = j;
          break;
        }
      }
    }

    if (jsonEndIndex !== -1) {
      const jsonStr = part.substring(0, jsonEndIndex + 1);
      const trailingText = part.substring(jsonEndIndex + 1);

      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.tool && parsed.args) {
          toolCalls.push({
            id: `react_call_${Math.random().toString(36).substring(2, 9)}`,
            name: parsed.tool,
            arguments: parsed.args,
          });
          // Valid tool call parsed, append any trailing text but hide the JSON
          textOutput += trailingText;
        } else {
          // Valid JSON but not a tool call, restore it
          textOutput += "Action: " + part;
        }
      } catch {
        // Invalid JSON, restore it
        textOutput += "Action: " + part;
      }
    } else {
      // No valid braces found, restore it
      textOutput += "Action: " + part;
    }
  }

  return {
    text: textOutput.trim(),
    toolCalls,
  };
}

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { getModelCapability, updateModelCapability } from "./capabilities-cache.js";
import { discoverLocalCapabilities, isLocalProvider } from "./capabilities-discovery.js";
import { runBackgroundCapabilityProbe } from "./capability-prober.js";

export interface DiscoveryOptions {
  modelId: string;
  providerType: "ollama" | "openai-compatible" | "llama.cpp" | "lmstudio" | (string & {});
}

/**
 * Wraps any Pi Agent StreamFn with the ReAct fallback parser and prompt injector.
 */
export function wrapStreamFnWithReActFallback(
  nativeStreamFn: StreamFn,
  config: {
    modelId: string;
    providerType: string;
    toolFallback?: "react" | "none" | "auto";
    reactProfile?: "minimal" | "verbose";
    configDir?: string;
  },
): StreamFn {
  return async (model, context, options) => {
    const capabilities = discoverLocalCapabilities({
      modelId: config.modelId,
      providerType: config.providerType,
    });

    const isLocal = isLocalProvider(config.providerType);
    const configDir = config.configDir;

    let currentStatus = "native";
    if (isLocal && configDir) {
      currentStatus = await getModelCapability(configDir, config.providerType, config.modelId);
      if (currentStatus === "unknown") {
        // Trigger background probe for all new models
        queueMicrotask(() =>
          runBackgroundCapabilityProbe({
            streamFn: nativeStreamFn,
            modelId: config.modelId,
            providerId: config.providerType,
            configDir,
          }),
        );
      }
    }

    let shouldApplyFallback = false;
    if (config.toolFallback === "react") {
      shouldApplyFallback = true;
    } else if (config.toolFallback === "none") {
      shouldApplyFallback = false;
    } else if (currentStatus === "react") {
      shouldApplyFallback = true;
    } else if (isLocal && currentStatus === "unknown" && capabilities.toolFormat === "none") {
      // Heuristic fallback only if we haven't probed yet and it's a known non-tool-calling model
      shouldApplyFallback = true;
    }

    if (!shouldApplyFallback || !context.tools || context.tools.length === 0) {
      const native = await nativeStreamFn(model, context, options);

      // Snoop result even for native pass if unknown to help update cache
      if (isLocal && configDir && currentStatus === "unknown") {
        const wrappedStream = createAssistantMessageEventStream();

        const snoop = async () => {
          try {
            let hasNativeToolCall = false;
            let hasReActAction = false;
            let firstChunkDoneReceived = false;

            for await (const chunk of native) {
              wrappedStream.push(chunk);
              if (chunk.type === "done" && !firstChunkDoneReceived) {
                firstChunkDoneReceived = true;
                const content = chunk.message.content as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
                if (content.some((p) => p.type === "toolCall")) {
                  hasNativeToolCall = true;
                }
                const textOutput = content
                  .filter((p) => p.type === "text")
                  .map((p) => p.text ?? "")
                  .join("");
                if (textOutput.includes("Action:") || textOutput.includes("Thought:")) {
                  hasReActAction = true;
                }
              }
            }

            if (hasNativeToolCall) {
              await updateModelCapability(configDir, config.providerType, config.modelId, "native");
            } else if (hasReActAction) {
              await updateModelCapability(configDir, config.providerType, config.modelId, "react");
            }
            wrappedStream.end();
          } catch {
            wrappedStream.push({
              type: "error",
              reason: "error",
              error: {
                role: "assistant",
                content: [],
                stopReason: "error",
                api: "",
                provider: "",
                model: "",
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
            } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
            wrappedStream.end();
          }
        };

        queueMicrotask(() => void snoop());
        return wrappedStream;
      }

      return native;
    }

    // Apply fallback logic
    const wrappedStream = createAssistantMessageEventStream();

    // Disable native tools since we mapped them to the prompt
    const newContext = { ...context };
    newContext.tools = undefined;
    newContext.systemPrompt = injectReActPrompt(
      context.systemPrompt,
      context.tools ?? [],
      config.reactProfile,
    );

    const run = async () => {
      try {
        const native = await nativeStreamFn(model, newContext, options);
        for await (const chunk of native) {
          if (chunk.type === "done") {
            // Intercept done: Extract text parts
            const textParts = (chunk.message.content as any[]) // eslint-disable-line @typescript-eslint/no-explicit-any
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("");

            const parsed = parseReActResponse(textParts, capabilities.isReasoningModel);

            const newContent: Array<{
              type: string;
              text?: string;
              id?: string;
              name?: string;
              arguments?: Record<string, unknown>;
            }> = [];
            if (parsed.text) {
              newContent.push({ type: "text", text: parsed.text });
            }
            for (const tc of parsed.toolCalls) {
              newContent.push({
                type: "toolCall",
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
              });
            }

            (chunk as any).message.content = newContent; // eslint-disable-line @typescript-eslint/no-explicit-any
            chunk.reason = parsed.toolCalls.length > 0 ? "toolUse" : chunk.reason;

            wrappedStream.push(chunk);
          } else {
            wrappedStream.push(chunk);
          }
        }
        wrappedStream.end();
      } catch {
        wrappedStream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            api: "",
            provider: "",
            model: "",
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
        } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
        wrappedStream.end();
      }
    };

    queueMicrotask(() => void run());
    return wrappedStream;
  };
}
