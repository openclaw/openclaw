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
  tools: any[], 
  profile: ReactProfile = "minimal"
): string {
  if (!tools || tools.length === 0) {
    return currentSystemPrompt || "";
  }

  const toolDefs = JSON.stringify(tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
  })), null, 2);

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
  isReasoningModel: boolean
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

    // A robust brace counter to locate the exact end of the JSON object
    for (let j = 0; j < part.length; j++) {
      if (part[j] === '{') {
        braceCount++;
        foundFirstBrace = true;
      } else if (part[j] === '}') {
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
            arguments: parsed.args
          });
          // Valid tool call parsed, append any trailing text but hide the JSON
          textOutput += trailingText;
        } else {
          // Valid JSON but not a tool call, restore it
          textOutput += "Action: " + part;
        }
      } catch (e) {
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
    toolCalls
  };
}

import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { discoverLocalCapabilities } from "./capabilities-discovery.js";

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
  }
): StreamFn {
  return (model, context, options) => {
    const capabilities = discoverLocalCapabilities({
      modelId: config.modelId,
      providerType: config.providerType,
    });
    
    let shouldApplyFallback = false;
    if (config.toolFallback === "react") {
      shouldApplyFallback = true;
    } else if (config.toolFallback !== "none" && capabilities.toolFormat === "none") {
      shouldApplyFallback = true;
    }

    if (!shouldApplyFallback || !context.tools || context.tools.length === 0) {
      // Pass through natively
      return nativeStreamFn(model, context, options);
    }

    // Apply fallback logic
    const wrappedStream = createAssistantMessageEventStream();
    
    // Disable native tools since we mapped them to the prompt
    const newContext = { ...context };
    newContext.tools = undefined;
    newContext.systemPrompt = injectReActPrompt(
      context.systemPrompt, 
      context.tools ?? [], 
      config.reactProfile
    );

    const run = async () => {
      try {
        const native = await nativeStreamFn(model, newContext, options);
        for await (const chunk of native) {
          if (chunk.type === "done") {
             // Intercept done: Extract text parts
             const textParts = chunk.message.content
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("");

             const parsed = parseReActResponse(textParts, capabilities.isReasoningModel);
             
             const newContent: any[] = [];
             if (parsed.text) {
               newContent.push({ type: "text", text: parsed.text });
             }
             for (const tc of parsed.toolCalls) {
               newContent.push({ 
                 type: "toolCall", 
                 id: tc.id, 
                 name: tc.name, 
                 arguments: tc.arguments 
               });
             }

             chunk.message.content = newContent;
             chunk.reason = parsed.toolCalls.length > 0 ? "toolUse" : chunk.reason;
             
             wrappedStream.push(chunk);
          } else {
            wrappedStream.push(chunk);
          }
        }
        wrappedStream.end();
      } catch (err) {
        wrappedStream.push({ 
          type: "error", 
          reason: "error", 
          error: { role: "assistant", content: [], stopReason: "error" } as any 
        });
        wrappedStream.end();
      }
    };

    queueMicrotask(() => void run());
    return wrappedStream;
  };
}
