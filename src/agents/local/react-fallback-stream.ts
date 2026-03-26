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

  const toolCalls: ReActParsedResponse["toolCalls"] = [];
  const actionMarker = "Action:";
  let lastIndex = 0;
  let textOutput = "";

  while (true) {
    const markerRegex = /(?:^|[\r\n])Action:/g;
    markerRegex.lastIndex = lastIndex;
    const match = markerRegex.exec(cleanedText);

    if (!match) {
      textOutput += cleanedText.substring(lastIndex);
      break;
    }

    const actionIndex = match.index + (match[0].length - actionMarker.length);

    // Append text leading up to the Action: marker
    textOutput += cleanedText.substring(lastIndex, actionIndex);

    // Look for JSON after Action:
    const part = cleanedText.substring(actionIndex + actionMarker.length);
    let braceCount = 0;
    let jsonStartIndex = -1;
    let jsonEndIndex = -1;

    let inString = false;
    let stringChar = "";
    let isEscaped = false;

    // Sequential scan to find the FIRST balanced JSON object
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
        if (jsonStartIndex === -1) {
          jsonStartIndex = j;
        }
        braceCount++;
      } else if (char === "}") {
        if (jsonStartIndex !== -1) {
          braceCount--;
          if (braceCount === 0) {
            jsonEndIndex = j;
            break;
          }
        }
      }
    }

    if (jsonStartIndex !== -1 && jsonEndIndex !== -1) {
      const jsonStr = part.substring(jsonStartIndex, jsonEndIndex + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.tool && parsed.args) {
          toolCalls.push({
            id: `react_call_${Date.now().toString(36)}_${(reactCallCounter++).toString(36)}`,
            name: parsed.tool,
            arguments: parsed.args,
          });
          // Move lastIndex to after the JSON block
          lastIndex = actionIndex + actionMarker.length + jsonEndIndex + 1;
          continue;
        }
      } catch {
        // Fall through to treatment as normal text if JSON is invalid
      }
    }

    // If no valid JSON found, treat "Action:" as normal text and move past it
    textOutput += actionMarker;
    lastIndex = actionIndex + actionMarker.length;
  }

  return {
    text: textOutput.trim(),
    toolCalls,
  };
}

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import {
  getModelCapability,
  updateModelCapability,
  type CapabilityStatus,
} from "./capabilities-cache.js";
import { discoverLocalCapabilities, isLocalProvider } from "./capabilities-discovery.js";
import { runBackgroundCapabilityProbe } from "./capability-prober.js";

let reactCallCounter = 0;

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
    providerId: string;
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

    let currentStatus: CapabilityStatus = "native";
    if (isLocal) {
      currentStatus = configDir
        ? await getModelCapability(configDir, config.providerId, config.modelId)
        : "unknown";

      if (currentStatus === "unknown" && configDir && config.toolFallback !== "none") {
        // Trigger background probe for all new models unless explicitly disabled
        queueMicrotask(() =>
          runBackgroundCapabilityProbe({
            streamFn: nativeStreamFn,
            model: model,
            providerId: config.providerId,
            configDir,
          }),
        );
      }
    }

    let shouldApplyFallback = false;
    const effectiveFallback = config.toolFallback ?? "auto";

    if (effectiveFallback === "react") {
      shouldApplyFallback = true;
    } else if (effectiveFallback === "auto") {
      if (currentStatus === "react") {
        shouldApplyFallback = true;
      } else if (currentStatus === "unknown" && isLocal && capabilities.toolFormat === "none") {
        shouldApplyFallback = true;
      }
    }

    if (!shouldApplyFallback || !context.tools || context.tools.length === 0) {
      const native = await nativeStreamFn(model, context, options);

      // Snoop result even for native pass if unknown to help update cache
      if (isLocal && configDir && currentStatus === "unknown") {
        const wrappedStream = createAssistantMessageEventStream();

        const snoop = async () => {
          let hasNativeToolCall = false;
          let hasReActAction = false;
          try {
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
                const hasTools = (context.tools?.length ?? 0) > 0;
                if (
                  hasTools &&
                  (/(?:^|[\r\n])Action:/g.test(textOutput) ||
                    /(?:^|[\r\n])Thought:/g.test(textOutput))
                ) {
                  hasReActAction = true;
                }
              }
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (err: any) {
            wrappedStream.push({
              type: "error",
              reason: "error",
              error: {
                role: "assistant",
                content: [],
                stopReason: "error",
                api: err?.api || config.providerType,
                provider: err?.provider || config.providerId,
                model: err?.model || config.modelId,
                errorMessage: err?.message || String(err),
                usage: err?.usage || {
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
          } finally {
            wrappedStream.end();
          }

          // Side-effect: update cache (best-effort)
          try {
            if (hasNativeToolCall) {
              await updateModelCapability(configDir, config.providerId, config.modelId, "native");
            } else if (hasReActAction) {
              await updateModelCapability(configDir, config.providerId, config.modelId, "react");
            }
          } catch {
            // Silence cache update errors to avoid polluting the log/stream
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        wrappedStream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            api: err?.api || config.providerType,
            provider: err?.provider || config.providerId,
            model: err?.model || config.modelId,
            errorMessage: err?.message || String(err),
            usage: err?.usage || {
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
