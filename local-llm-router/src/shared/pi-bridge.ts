/**
 * Pi Framework Bridge
 *
 * Wraps Pi's model APIs into a clean interface for our router.
 * Handles Ollama (local) and Anthropic (cloud) provider configuration.
 */

import { streamSimple, completeSimple, getModel } from "@mariozechner/pi-ai";
import type { Model, AssistantMessage } from "@mariozechner/pi-ai";
import type { ModelRef } from "../types.js";

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

/**
 * Build a Pi Model object from our config.
 * Ollama uses the openai-completions API (OpenAI-compatible).
 * Anthropic uses the native anthropic-messages API.
 */
export function buildPiModel(ref: ModelRef, contextWindow?: number): Model<any> {
  if (ref.provider === "ollama") {
    return {
      id: ref.model,
      name: ref.model,
      api: "openai-completions",
      provider: "ollama",
      baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: contextWindow ?? 32768,
      maxTokens: 4096,
    } as unknown as Model<any>;
  }

  if (ref.provider === "anthropic") {
    try {
      return getModel("anthropic", ref.model as any);
    } catch {
      return {
        id: ref.model,
        name: ref.model,
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: ref.model.includes("opus") || ref.model.includes("sonnet"),
        input: ["text", "image"],
        cost: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 },
        contextWindow: contextWindow ?? 200000,
        maxTokens: 8192,
      } as unknown as Model<any>;
    }
  }

  if (ref.provider === "openai") {
    try {
      return getModel("openai", ref.model as any);
    } catch {
      return {
        id: ref.model,
        name: ref.model,
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0.005, output: 0.015, cacheRead: 0, cacheWrite: 0 },
        contextWindow: contextWindow ?? 128000,
        maxTokens: 4096,
      } as unknown as Model<any>;
    }
  }

  throw new Error(`Unsupported provider: ${ref.provider}`);
}

/**
 * Get the API key for a provider.
 */
export function getApiKey(provider: string): string | undefined {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "ollama":
      return "ollama";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Simple completion (for router classifier)
// ---------------------------------------------------------------------------

/**
 * Call a model and get the full text response.
 * Used by the router for classification and simple tasks.
 */
export async function callModelSimple(
  ref: ModelRef,
  prompt: string,
  opts?: {
    systemPrompt?: string;
    contextWindow?: number;
    maxTokens?: number;
    temperature?: number;
  },
): Promise<string> {
  const model = buildPiModel(ref, opts?.contextWindow);
  const apiKey = getApiKey(ref.provider);

  const context = {
    systemPrompt: opts?.systemPrompt,
    messages: [
      {
        role: "user" as const,
        content: prompt,
        timestamp: Date.now(),
      },
    ],
  };

  const response: AssistantMessage = await completeSimple(model, context as any, {
    apiKey,
    maxTokens: opts?.maxTokens ?? 4096,
    temperature: opts?.temperature,
  });

  const textParts = response.content
    .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text);

  return textParts.join("");
}

// ---------------------------------------------------------------------------
// Streaming completion (for agent interactions)
// ---------------------------------------------------------------------------

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onDone?: (fullText: string) => void;
  onError?: (error: Error) => void;
}

/**
 * Stream a model response with callbacks.
 * Used by agents for interactive tasks.
 */
export async function callModelStream(
  ref: ModelRef,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  opts?: {
    systemPrompt?: string;
    contextWindow?: number;
    maxTokens?: number;
    temperature?: number;
    callbacks?: StreamCallbacks;
  },
): Promise<string> {
  const model = buildPiModel(ref, opts?.contextWindow);
  const apiKey = getApiKey(ref.provider);

  const context = {
    systemPrompt: opts?.systemPrompt,
    messages: messages.map((m) => ({
      ...m,
      timestamp: Date.now(),
    })),
  };

  const stream = streamSimple(model, context as any, {
    apiKey,
    maxTokens: opts?.maxTokens ?? 4096,
    temperature: opts?.temperature,
  });

  let fullText = "";

  for await (const event of stream) {
    if (event.type === "text_delta") {
      const text = (event as any).text ?? "";
      fullText += text;
      opts?.callbacks?.onText?.(text);
    }

    if (event.type === "done") {
      opts?.callbacks?.onDone?.(fullText);
    }
  }

  return fullText;
}
