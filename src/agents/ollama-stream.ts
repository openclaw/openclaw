import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ToolCall,
  Tool,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import { OLLAMA_DEFAULT_BASE_URL } from "./ollama-defaults.js";
import {
  buildAssistantMessage as buildStreamAssistantMessage,
  buildAssistantMessageWithZeroUsage,
  buildStreamErrorAssistantMessage,
  buildUsageWithNoCost,
} from "./stream-message-shared.js";

// ── Privacy Protection Filter ────────────────────────────────────────────────
//
// Filter out potentially sensitive information from content before processing
// to ensure user privacy is maintained throughout the streaming process.

/**
 * Patterns for identifying potentially sensitive information
 */
const SENSITIVE_PATTERNS = [
  // Personal identification
  /\b\d{15,18}\b/g,                    // ID numbers (15-18 digits)
  /\b\d{11}\b/g,                       // Phone numbers (11 digits)
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,  // Email addresses
  
  // Financial information
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,     // Credit card numbers
  /\b\d{16}\b/g,                       // 16-digit card numbers
  /\b[A-Z]{2}\d{10}[A-Z]?\b/g,        // IBAN numbers
  
  // Authentication credentials
  /(password|passwd|pwd)["'`:\s]*[^\s"']+/gi,         // Password patterns
  /(token|apikey|api_key)["'`:\s]*[^\s"']+/gi,       // Token patterns
  /(secret|credential)["'`:\s]*[^\s"']+/gi,          // Secret patterns
  
  // Network information
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,         // IP addresses
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, // UUIDs
];

/**
 * Filter sensitive information from content
 * @param content The content to filter
 * @returns Filtered content with sensitive information masked
 */
function filterSensitiveInformation(content: string): string {
  let filteredContent = content;
  
  // Apply each sensitive pattern filter
  for (const pattern of SENSITIVE_PATTERNS) {
    filteredContent = filteredContent.replace(pattern, (match) => {
      // Preserve the length of the match but mask the content
      if (match.includes('@')) {
        // Special handling for email addresses
        const [localPart, domain] = match.split('@');
        const maskedLocal = localPart.charAt(0) + '*'.repeat(Math.max(0, localPart.length - 2)) + 
                          (localPart.length > 1 ? localPart.charAt(localPart.length - 1) : '');
        return `${maskedLocal}@${domain}`;
      } else if (/^\d+$/.test(match)) {
        // For numeric sequences, partially mask
        if (match.length >= 11) {
          // Phone numbers or similar
          return match.substring(0, 3) + '*'.repeat(Math.max(0, match.length - 6)) + match.substring(match.length - 3);
        } else if (match.length >= 4) {
          // General numbers
          return match.substring(0, 2) + '*'.repeat(Math.max(0, match.length - 4)) + match.substring(match.length - 2);
        }
      }
      // For other patterns, mask completely
      return '*'.repeat(Math.min(match.length, 20)); // Limit mask length
    });
  }
  
  return filteredContent;
}

// Import config utilities
import { loadManusilizedConfig, applyStreamingMode, type ManusilizedConfig } from "./config-utils.js";

const log = createSubsystemLogger("ollama-stream");

export const OLLAMA_NATIVE_BASE_URL = OLLAMA_DEFAULT_BASE_URL;

export function resolveOllamaBaseUrlForRun(params: {
  modelBaseUrl?: string;
  providerBaseUrl?: string;
}): string {
  const providerBaseUrl = params.providerBaseUrl?.trim();
  if (providerBaseUrl) {
    return providerBaseUrl;
  }
  const modelBaseUrl = params.modelBaseUrl?.trim();
  if (modelBaseUrl) {
    return modelBaseUrl;
  }
  return OLLAMA_NATIVE_BASE_URL;
}

// ── Ollama /api/chat request types ──────────────────────────────────────────

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
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
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

const MAX_SAFE_INTEGER_ABS_STR = String(Number.MAX_SAFE_INTEGER);

function isAsciiDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function parseJsonNumberToken(
  input: string,
  start: number,
): { token: string; end: number; isInteger: boolean } | null {
  let idx = start;
  if (input[idx] === "-") {
    idx += 1;
  }
  if (idx >= input.length) {
    return null;
  }

  if (input[idx] === "0") {
    idx += 1;
  } else if (isAsciiDigit(input[idx]) && input[idx] !== "0") {
    while (isAsciiDigit(input[idx])) {
      idx += 1;
    }
  } else {
    return null;
  }

  let isInteger = true;
  if (input[idx] === ".") {
    isInteger = false;
    idx += 1;
    if (!isAsciiDigit(input[idx])) {
      return null;
    }
    while (isAsciiDigit(input[idx])) {
      idx += 1;
    }
  }

  if (input[idx] === "e" || input[idx] === "E") {
    isInteger = false;
    idx += 1;
    if (input[idx] === "+" || input[idx] === "-") {
      idx += 1;
    }
    if (!isAsciiDigit(input[idx])) {
      return null;
    }
    while (isAsciiDigit(input[idx])) {
      idx += 1;
    }
  }

  return {
    token: input.slice(start, idx),
    end: idx,
    isInteger,
  };
}

function isUnsafeIntegerLiteral(token: string): boolean {
  const digits = token[0] === "-" ? token.slice(1) : token;
  if (digits.length < MAX_SAFE_INTEGER_ABS_STR.length) {
    return false;
  }
  if (digits.length > MAX_SAFE_INTEGER_ABS_STR.length) {
    return true;
  }
  return digits > MAX_SAFE_INTEGER_ABS_STR;
}

function quoteUnsafeIntegerLiterals(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let idx = 0;

  while (idx < input.length) {
    const ch = input[idx] ?? "";
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      idx += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      idx += 1;
      continue;
    }

    if (ch === "-" || isAsciiDigit(ch)) {
      const parsed = parseJsonNumberToken(input, idx);
      if (parsed) {
        if (parsed.isInteger && isUnsafeIntegerLiteral(parsed.token)) {
          out += `"${parsed.token}"`;
        } else {
          out += parsed.token;
        }
        idx = parsed.end;
        continue;
      }
    }

    out += ch;
    idx += 1;
  }

  return out;
}

function parseJsonPreservingUnsafeIntegers(input: string): unknown {
  return JSON.parse(quoteUnsafeIntegerLiterals(input)) as unknown;
}

// ── Ollama /api/chat response types ─────────────────────────────────────────

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

// ── Message conversion ──────────────────────────────────────────────────────

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

function extractOllamaImages(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as InputContentPart[])
    .filter((part): part is { type: "image"; data: string } => part.type === "image")
    .map((part) => part.data);
}

function extractToolCalls(content: unknown): OllamaToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts = content as InputContentPart[];
  const result: OllamaToolCall[] = [];
  for (const part of parts) {
    if (part.type === "toolCall") {
      result.push({ function: { name: part.name, arguments: part.arguments } });
    } else if (part.type === "tool_use") {
      result.push({ function: { name: part.name, arguments: part.input } });
    }
  }
  return result;
}

export function convertToOllamaMessages(
  messages: Array<{ role: string; content: unknown }>,
  system?: string,
): OllamaChatMessage[] {
  const result: OllamaChatMessage[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    const { role } = msg;

    if (role === "user") {
      const text = extractTextContent(msg.content);
      const images = extractOllamaImages(msg.content);
      result.push({
        role: "user",
        content: text,
        ...(images.length > 0 ? { images } : {}),
      });
    } else if (role === "assistant") {
      const text = extractTextContent(msg.content);
      const toolCalls = extractToolCalls(msg.content);
      result.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (role === "tool" || role === "toolResult") {
      // SDK uses "toolResult" (camelCase) for tool result messages.
      // Ollama API expects "tool" role with tool_name per the native spec.
      const text = extractTextContent(msg.content);
      const toolName =
        typeof (msg as { toolName?: unknown }).toolName === "string"
          ? (msg as { toolName?: string }).toolName
          : undefined;
      result.push({
        role: "tool",
        content: text,
        ...(toolName ? { tool_name: toolName } : {}),
      });
    }
  }

  return result;
}

// ── Tool extraction ─────────────────────────────────────────────────────────

function extractOllamaTools(tools: Tool[] | undefined): OllamaTool[] {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }
  const result: OllamaTool[] = [];
  for (const tool of tools) {
    if (typeof tool.name !== "string" || !tool.name) {
      continue;
    }
    result.push({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: (tool.parameters ?? {}) as Record<string, unknown>,
      },
    });
  }
  return result;
}

// ── Response conversion ─────────────────────────────────────────────────────

export function buildAssistantMessage(
  response: OllamaChatResponse,
  modelInfo: { api: string; provider: string; id: string },
): AssistantMessage {
  const content: (TextContent | ToolCall)[] = [];

  // Native Ollama reasoning fields are internal model output. The reply text
  // must come from `content`; reasoning visibility is controlled elsewhere.
  const text = response.message.content || "";
  if (text) {
    content.push({ type: "text", text });
  }

  const toolCalls = response.message.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      content.push({
        type: "toolCall",
        id: `ollama_call_${randomUUID()}`,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }

  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const stopReason: StopReason = hasToolCalls ? "toolUse" : "stop";

  return buildStreamAssistantMessage({
    model: modelInfo,
    content,
    stopReason,
    usage: buildUsageWithNoCost({
      input: response.prompt_eval_count ?? 0,
      output: response.eval_count ?? 0,
    }),
  });
}

// ── Markdown tool-call fallback extractor ──────────────────────────────────
//
// Some open-source models (e.g. older Llama3, GLM variants) do not emit
// structured `tool_calls` in the Ollama response.  Instead they embed a JSON
// object inside a fenced code block in the `content` field, e.g.:
//
//   ```json
//   {"name": "bash", "arguments": {"command": "ls"}}
//   ```
//
// `extractMarkdownToolCalls` scans the accumulated content string for these
// patterns and converts them into proper `OllamaToolCall` objects so the rest
// of the pipeline can treat them identically to native tool calls.

// The regex is created via a factory function so each call-site gets a fresh
// RegExp instance with lastIndex = 0, avoiding shared mutable state across
// call-sites (extractMarkdownToolCalls + content stripping).
//
// The inner pattern uses a negative lookahead `(?!``)` to prevent matching
// across fence boundaries (three consecutive backticks end the block) while
// still allowing single or double backticks inside JSON string values (e.g.
// shell commands like `echo \`date\``).  This is more permissive than the
// previous `[^\`]` approach, which incorrectly rejected any backtick.
function makeMarkdownToolCallRe(): RegExp {
  return /```(?:json)?\s*\n?\s*(\{(?:(?!```)\s|\S)*?"name"\s*:\s*"[^"]+"(?:(?!```)\s|\S)*?\})\s*\n?```/g;
}

// Additional patterns for better tool call detection (excluding duplicate of main pattern)
const ADDITIONAL_TOOL_CALL_PATTERNS = [
  /\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[\s\S]*?\})[\s\S]*?\}/g,
  /<tool_call>([\s\S]*?)<\/tool_call>/g,
  /```(?:ya?ml)\s*\n([\s\S]*?name:\s*[^\n]+[\s\S]*?arguments:\s*\{[\s\S]*?\})\s*\n```/g,
  /(?:^|\n)(name:\s*[^\n]+\narguments:\s*\{[\s\S]*?\})(?=\n|$)/gm,
];

/**
 * Parse YAML-style tool call content
 * @param yamlContent YAML formatted tool call string
 * @returns Parsed tool call object
 */
function parseYamlToolCall(yamlContent: string): Record<string, unknown> {
  const lines = yamlContent.trim().split('\n');
  const result: Record<string, unknown> = {};
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('name:')) {
      result.name = trimmed.substring(5).trim().replace(/^["']|["']$/g, '');
    } else if (trimmed.startsWith('arguments:')) {
      // Extract JSON portion after arguments:
      const argsMatch = trimmed.match(/arguments:\s*(\{.*\})/);
      if (argsMatch && argsMatch[1]) {
        try {
          result.arguments = JSON.parse(argsMatch[1]);
        } catch {
          // If JSON parsing fails, try to extract key-value pairs
          const argsObj: Record<string, unknown> = {};
          const argsLines = trimmed.substring(10).trim();
          if (argsLines.startsWith('{') && argsLines.endsWith('}')) {
            // Simplified JSON parsing for common cases
            const keyValuePairs = argsLines.substring(1, argsLines.length - 1).split(',');
            for (const pair of keyValuePairs) {
              const [key, value] = pair.split(':').map(s => s.trim());
              if (key && value) {
                // Try to parse value as JSON or keep as string
                try {
                  argsObj[key.replace(/^["']|["']$/g, '')] = JSON.parse(value);
                } catch {
                  argsObj[key.replace(/^["']|["']$/g, '')] = value.replace(/^["']|["']$/g, '');
                }
              }
            }
            result.arguments = argsObj;
          }
        }
      }
    }
  }
  
  return result;
}

export function extractMarkdownToolCalls(
  content: string,
  allowedToolNames?: Set<string>,
): OllamaToolCall[] {
  const results: OllamaToolCall[] = [];
  const re = makeMarkdownToolCallRe();
  // Primary pattern (via factory for fresh lastIndex)
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    // match[1] is the captured JSON object (inside the fence), extracted
    // directly by the capturing group — no need for post-hoc string replacement.
    const raw = (match[1] ?? match[0]
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, ""))
      .trim();
    try {
      const parsed = parseJsonPreservingUnsafeIntegers(raw) as Record<string, unknown>;
      const name = typeof parsed.name === "string" ? parsed.name : undefined;
      if (!name) {
        continue;
      }
      // Guard: only promote to a tool call when the name matches a configured
      // tool.  Without this check any fenced JSON with a `name` field (e.g.
      // `{"name":"Alice","age":30}`) would be reclassified as a tool-use turn,
      // stripping the JSON from visible content and corrupting the conversation.
      if (allowedToolNames && !allowedToolNames.has(name)) {
        log.debug(`[manusilized] Skipping Markdown block: '${name}' is not a configured tool`);
        continue;
      }
      const args =
        parsed.arguments != null && typeof parsed.arguments === "object"
          ? (parsed.arguments as Record<string, unknown>)
          : parsed.parameters != null && typeof parsed.parameters === "object"
            ? (parsed.parameters as Record<string, unknown>)
            : {};
      results.push({ function: { name, arguments: args } });
    } catch {
      log.warn(`[manusilized] Failed to parse Markdown tool call: ${raw.slice(0, 120)}`);
    }
  }
  
  // Additional patterns
  for (const pattern of ADDITIONAL_TOOL_CALL_PATTERNS) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(content)) !== null) {
      try {
        let parsed: Record<string, unknown>;
        if (match.length >= 3) {
          // For patterns with separate name and arguments captures
          const name = match[1];
          const argsRaw = match[2];
          parsed = { name, arguments: JSON.parse(argsRaw) };
        } else if (pattern.source.includes("ya?ml")) {
          // Handle YAML format
          const yamlContent = match[1] || match[0];
          parsed = parseYamlToolCall(yamlContent);
        } else {
          // For patterns with single capture containing full JSON
          const raw = match[1] || match[0];
          parsed = parseJsonPreservingUnsafeIntegers(raw) as Record<string, unknown>;
        }
        
        const name = typeof parsed.name === "string" ? parsed.name : undefined;
        if (!name) {
          continue;
        }
        
        // Guard: only promote to a tool call when the name matches a configured tool.
        // This check must be applied to ALL patterns, not just the primary one.
        if (allowedToolNames && !allowedToolNames.has(name)) {
          log.debug(`[manusilized] Skipping additional pattern match: '${name}' is not a configured tool`);
          continue;
        }
        
        const args =
          parsed.arguments != null && typeof parsed.arguments === "object"
            ? (parsed.arguments as Record<string, unknown>)
            : parsed.parameters != null && typeof parsed.parameters === "object"
              ? (parsed.parameters as Record<string, unknown>)
              : {};
              
        results.push({ function: { name, arguments: args } });
      } catch (err) {
        log.warn(`[manusilized] Failed to parse additional tool call pattern: ${match[0].slice(0, 120)}`);
      }
    }
  }
  
  return results;
}

// ── NDJSON streaming parser with enhanced buffering ─────────────────────────

export async function* parseNdjsonStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bufferSize: number = 1024, // Configurable buffer size for smoother streaming
): AsyncGenerator<OllamaChatResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    
    // Process each line immediately as it arrives (original NDJSON streaming behavior)
    // Accumulate only incomplete lines for the next iteration
    accumulatedBuffer += buffer;
    
    const lines = accumulatedBuffer.split("\n");
    // Keep the last (potentially incomplete) line in the buffer
    accumulatedBuffer = lines.pop() ?? "";

    // Process all complete lines immediately
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        yield parseJsonPreservingUnsafeIntegers(trimmed) as OllamaChatResponse;
      } catch {
        log.warn(`Skipping malformed NDJSON line: ${trimmed.slice(0, 120)}`);
      }
    }
    
    buffer = ""; // Reset buffer for next iteration
  }

  // Handle any remaining data after stream ends
  if (accumulatedBuffer.trim()) {
    try {
      yield parseJsonPreservingUnsafeIntegers(accumulatedBuffer.trim()) as OllamaChatResponse;
    } catch {
      log.warn(`Skipping malformed trailing data: ${accumulatedBuffer.trim().slice(0, 120)}`);
    }
  }
}

// ── Enhanced Stream Configuration ───────────────────────────────────────────

interface StreamConfig {
  bufferSize?: number;
  throttleDelay?: number;
  enableThinkingOutput?: boolean;
  streamInterval?: number;
}

// ── Main StreamFn factory with enhanced streaming ───────────────────────────

function resolveOllamaChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const normalizedBase = trimmed.replace(/\/v1$/i, "");
  const apiBase = normalizedBase || OLLAMA_NATIVE_BASE_URL;
  return `${apiBase}/api/chat`;
}

function resolveOllamaModelHeaders(model: {
  headers?: unknown;
}): Record<string, string> | undefined {
  if (!model.headers || typeof model.headers !== "object" || Array.isArray(model.headers)) {
    return undefined;
  }
  return model.headers as Record<string, string>;
}

export function createOllamaStreamFn(
  baseUrl: string,
  defaultHeaders?: Record<string, string>,
  streamConfig?: StreamConfig,
  configPath?: string,
): StreamFn {
  // Load configuration from file if available
  let baseConfig: ManusilizedConfig = {
    streaming: {
      mode: "standard",
      bufferSize: 1024,
      throttleDelay: 10,
      enableThinkingOutput: false,
      streamInterval: 50,
    },
    context: {
      enableMegaContext: false,
      maxContextWindow: 262144,
      autoDetectContext: true,
    },
  };
  
  // Try to load config from file
  try {
    if (loadManusilizedConfig) {
      const fileConfig = loadManusilizedConfig(configPath);
      baseConfig = { ...baseConfig, ...fileConfig };
    }
  } catch (err) {
    console.warn("[manusilized] Failed to load config file, using defaults:", err);
  }
  
  // Apply streaming mode presets
  if (applyStreamingMode) {
    baseConfig = applyStreamingMode(baseConfig);
  }
  
  const chatUrl = resolveOllamaChatUrl(baseUrl);
  const config = {
    bufferSize: baseConfig.streaming?.bufferSize || 1024,
    throttleDelay: baseConfig.streaming?.throttleDelay || 10,
    enableThinkingOutput: baseConfig.streaming?.enableThinkingOutput || false,
    streamInterval: baseConfig.streaming?.streamInterval || 50,
    ...streamConfig,
  };

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const ollamaMessages = convertToOllamaMessages(
          context.messages ?? [],
          context.systemPrompt,
        );

        const ollamaTools = extractOllamaTools(context.tools);

        // Ollama defaults to num_ctx=4096 which is too small for large
        // system prompts + many tool definitions. Use model's contextWindow.
        const ollamaOptions: Record<string, unknown> = { 
          num_ctx: model.contextWindow ?? 65536,
          // Enable thinking output for reasoning models
          ...(config.enableThinkingOutput ? { thinking: true } : {})
        };
        if (typeof options?.temperature === "number") {
          ollamaOptions.temperature = options.temperature;
        }
        if (typeof options?.maxTokens === "number") {
          ollamaOptions.num_predict = options.maxTokens;
        }

        const body: OllamaChatRequest = {
          model: model.id,
          messages: ollamaMessages,
          stream: true,
          ...(ollamaTools.length > 0 ? { tools: ollamaTools } : {}),
          options: ollamaOptions,
        };

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...defaultHeaders,
          ...options?.headers,
        };
        if (
          options?.apiKey &&
          (!headers.Authorization || !isNonSecretApiKeyMarker(options.apiKey))
        ) {
          headers.Authorization = `Bearer ${options.apiKey}`;
        }

        const response = await fetch(chatUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`Ollama API error ${response.status}: ${errorText}`);
        }

        if (!response.body) {
          throw new Error("Ollama API returned empty response body");
        }

        const reader = response.body.getReader();
        let accumulatedContent = "";
        const accumulatedToolCalls: OllamaToolCall[] = [];
        let finalResponse: OllamaChatResponse | undefined;
        let contentIndex = 0;
        let lastStreamTime = Date.now();

        // Emit a "start" event so consumers know the assistant has begun.
        stream.push({
          type: "start",
          partial: buildAssistantMessageWithZeroUsage({
            model,
            content: [],
            stopReason: "stop",
          }),
        });

        // Retry mechanism with fresh stream on each attempt
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount <= maxRetries) {
          try {
            // Re-issue HTTP request on each retry to get a fresh stream
            // (ReadableStreamDefaultReader is single-pass and non-rewindable)
            if (retryCount > 0) {
              const retryResponse = await fetch(chatUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(ollamaBody),
                signal: options?.signal,
              });

              if (!retryResponse.ok) {
                throw new Error(`Ollama API error: ${retryResponse.status} ${retryResponse.statusText}`);
              }

              reader = retryResponse.body?.getReader();
              if (!reader) {
                throw new Error("Failed to get stream reader on retry");
              }
            }

            for await (const chunk of parseNdjsonStream(reader, config.bufferSize)) {
              const currentTime = Date.now();
              
              // ── Real-time text_delta events (manusilized: incremental streaming) ──
              // Emit each content fragment immediately so the UI can render a
              // live typewriter effect instead of waiting for the full response.
              if (chunk.message?.content) {
                // DO NOT apply privacy filter to model output - it corrupts legitimate technical content
                // Privacy filtering should be applied to user INPUT before sending to model
                const delta = chunk.message.content;
                accumulatedContent += delta;
                // Throttle streaming to reduce UI updates while still accumulating content
                if (currentTime - lastStreamTime >= config.throttleDelay) {
                  stream.push({
                    type: "text_delta",
                    contentIndex,
                    delta,
                    partial: buildAssistantMessageWithZeroUsage({
                      model,
                      content: [{ type: "text", text: accumulatedContent }],
                      stopReason: "stop",
                    }),
                  });
                  
                  lastStreamTime = currentTime;
                }
              }

              // Include thinking/reasoning output for enhanced experience
              if (config.enableThinkingOutput && chunk.message?.thinking) {
                stream.push({
                  type: "thinking_delta",
                  content: chunk.message.thinking,
                });
              }

              // Ollama sends tool_calls in intermediate (done:false) chunks,
              // NOT in the final done:true chunk. Collect from all chunks.
              if (chunk.message?.tool_calls) {
                accumulatedToolCalls.push(...chunk.message.tool_calls);
              }

              if (chunk.done) {
                finalResponse = chunk;
                break;
              }
            }
            break; // Success, exit retry loop
          } catch (err) {
            retryCount++;
            if (retryCount > maxRetries) {
              throw err; // Re-throw if max retries exceeded
            }
            
            log.warn(`[manusilized] Stream parsing failed, retry ${retryCount}/${maxRetries}:`, err);
            
            // Wait before retry with exponential backoff
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
            
            // Re-initialize the stream if possible
            if (options?.signal?.aborted) {
              throw new Error("Stream aborted by user");
            }
          }
        }

        if (!finalResponse) {
          throw new Error("Ollama API stream ended without a final response");
        }

        // Apply privacy filter to final content
        finalResponse.message.content = accumulatedContent;

        // Emit text_end event to indicate completion of text streaming
        stream.push({
          type: "text_end",
          contentIndex,
          partial: buildAssistantMessageWithZeroUsage({
            model,
            content: [{ type: "text", text: accumulatedContent }],
            stopReason: "stop",
          }),
        });

        // ── Markdown tool-call fallback (manusilized: fault-tolerant adapter) ──
        // If the model produced no native tool_calls but embedded a JSON tool
        // call inside a fenced code block, extract it as a fallback so that
        // open-source models that don't support structured output still work.
        if (accumulatedToolCalls.length === 0 && accumulatedContent) {
          // Pass the configured tool names so random JSON objects with a
          // `name` field are not misidentified as tool calls (manusilized fix).
          const allowedNames = ollamaTools
            ? new Set(ollamaTools.map((t: { function?: { name?: string }; name?: string }) =>
                typeof t.function?.name === "string" ? t.function.name :
                typeof t.name === "string" ? t.name : ""
              ).filter(Boolean))
            : undefined;
          const markdownCalls = extractMarkdownToolCalls(accumulatedContent, allowedNames);
          if (markdownCalls.length > 0) {
            log.debug(
              `[manusilized] Extracted ${markdownCalls.length} tool call(s) from Markdown fallback`,
            );
            accumulatedToolCalls.push(...markdownCalls);
            // Strip the tool-call JSON blocks from the visible content so the
            // user doesn't see raw JSON in the chat bubble.
            // Use the factory regex for a fresh instance (no shared lastIndex)
            let cleanedContent = accumulatedContent
              .replace(makeMarkdownToolCallRe(), "")
              .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
              .replace(/```(?:ya?ml)\s*\n[\s\S]*?\s*\n```/g, "")
              .trim();
            
            // Apply privacy filter to cleaned content
            finalResponse.message.content = cleanedContent;
          }
        }

        if (accumulatedToolCalls.length > 0) {
          finalResponse.message.tool_calls = accumulatedToolCalls;
        }

        // Increment contentIndex after text is done (mirrors OpenAI WS pattern).
        contentIndex += 1;

        const assistantMessage = buildAssistantMessage(finalResponse, {
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
        stream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({
            model,
            errorMessage,
          }),
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}

export function createConfiguredOllamaStreamFn(params: {
  model: { baseUrl?: string; headers?: unknown };
  providerBaseUrl?: string;
  streamConfig?: StreamConfig;
}): StreamFn {
  const modelBaseUrl = typeof params.model.baseUrl === "string" ? params.model.baseUrl : undefined;
  return createOllamaStreamFn(
    resolveOllamaBaseUrlForRun({
      modelBaseUrl,
      providerBaseUrl: params.providerBaseUrl,
    }),
    resolveOllamaModelHeaders(params.model),
    params.streamConfig,
  );
}