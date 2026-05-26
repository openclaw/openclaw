import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { Hn as ProviderWrapStreamFnContext } from "./types-Vx7Jq4_-2.js";
import { AssistantMessage } from "@earendil-works/pi-ai";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/ollama/src/stream.d.ts
declare const OLLAMA_NATIVE_BASE_URL = "http://127.0.0.1:11434";
declare function resolveOllamaBaseUrlForRun(params: {
  modelBaseUrl?: string;
  providerBaseUrl?: string;
}): string;
declare function isOllamaCompatProvider(model: {
  provider?: string;
  baseUrl?: string;
  api?: string;
}): boolean;
declare function resolveOllamaCompatNumCtxEnabled(params: {
  config?: OpenClawConfig;
  providerId?: string;
}): boolean;
declare function shouldInjectOllamaCompatNumCtx(params: {
  model: {
    api?: string;
    provider?: string;
    baseUrl?: string;
  };
  config?: OpenClawConfig;
  providerId?: string;
}): boolean;
declare function wrapOllamaCompatNumCtx(baseFn: StreamFn | undefined, numCtx: number): StreamFn;
type OllamaThinkValue = boolean | "low" | "medium" | "high";
declare function createConfiguredOllamaCompatStreamWrapper(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
/** @deprecated Use createConfiguredOllamaCompatStreamWrapper. */
declare const createConfiguredOllamaCompatNumCtxWrapper: typeof createConfiguredOllamaCompatStreamWrapper;
declare function buildOllamaChatRequest(params: {
  modelId: string;
  providerId?: string;
  messages: OllamaChatMessage[];
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
  requestParams?: Record<string, unknown>;
  stream?: boolean;
}): OllamaChatRequest;
type StreamModelDescriptor = {
  api: string;
  provider: string;
  id: string;
};
type OllamaUsageFallback = {
  input?: number;
  output?: number;
};
interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
  think?: OllamaThinkValue;
}
interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}
interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}
interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: "assistant";
    content: string;
    thinking?: string;
    reasoning?: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}
type OllamaToolCallNameOptions = {
  availableToolNames?: ReadonlySet<string>;
};
declare function convertToOllamaMessages(messages: Array<{
  role: string;
  content: unknown;
}>, system?: string, options?: OllamaToolCallNameOptions): OllamaChatMessage[];
declare function buildAssistantMessage(response: OllamaChatResponse, modelInfo: StreamModelDescriptor, usageFallback?: OllamaUsageFallback, options?: OllamaToolCallNameOptions): AssistantMessage;
declare function parseNdjsonStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<OllamaChatResponse>;
declare function createOllamaStreamFn(baseUrl: string, defaultHeaders?: Record<string, string>): StreamFn;
declare function createConfiguredOllamaStreamFn(params: {
  model: {
    baseUrl?: string;
    headers?: unknown;
  };
  providerBaseUrl?: string;
}): StreamFn;
//#endregion
export { createConfiguredOllamaCompatNumCtxWrapper as a, createOllamaStreamFn as c, resolveOllamaBaseUrlForRun as d, resolveOllamaCompatNumCtxEnabled as f, convertToOllamaMessages as i, isOllamaCompatProvider as l, wrapOllamaCompatNumCtx as m, buildAssistantMessage as n, createConfiguredOllamaCompatStreamWrapper as o, shouldInjectOllamaCompatNumCtx as p, buildOllamaChatRequest as r, createConfiguredOllamaStreamFn as s, OLLAMA_NATIVE_BASE_URL as t, parseNdjsonStream as u };