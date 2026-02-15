/**
 * MemoryRouter Integration
 *
 * Routes LLM API calls through MemoryRouter for automatic memory/RAG.
 * When enabled, Clawdbot intercepts model API calls and routes them through
 * MemoryRouter instead of directly to the provider.
 *
 * Without MemoryRouter: Clawdbot → Anthropic/OpenAI/etc.
 * With MemoryRouter:    Clawdbot → MemoryRouter → Anthropic/OpenAI/etc.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model, StreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";

const MEMORYROUTER_ENDPOINT = "https://api.memoryrouter.ai/v1";

/**
 * Providers that MemoryRouter supports.
 * If a model uses an unsupported provider, we skip MR routing and call provider directly.
 */
const SUPPORTED_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "xai",
  "cerebras",
  "deepseek",
  "mistral",
  "openrouter",
  "azure",
  "azure-openai-responses",
  "ollama",
]);

/**
 * API types that can be routed through MemoryRouter.
 */
const ROUTABLE_APIS = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
]);

export interface MemoryRouterState {
  enabled: boolean;
  originalBaseUrl?: string;
  memoryKey?: string;
  endpoint?: string;
}

/**
 * Check if MemoryRouter is enabled in config.
 */
export function isMemoryRouterEnabled(cfg?: OpenClawConfig): boolean {
  return cfg?.memoryRouter?.enabled === true && !!cfg?.memoryRouter?.key;
}

/**
 * Check if the provider is supported by MemoryRouter.
 */
export function isProviderSupported(provider: string): boolean {
  return SUPPORTED_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Check if the API type is routable through MemoryRouter.
 */
export function isApiRoutable(api: string): boolean {
  return ROUTABLE_APIS.has(api);
}

/**
 * Determine if a request should be routed through MemoryRouter.
 */
export function shouldRouteThrough(
  cfg: OpenClawConfig | undefined,
  provider: string,
  api: string,
): boolean {
  if (!isMemoryRouterEnabled(cfg)) {
    return false;
  }
  if (!isProviderSupported(provider)) {
    return false;
  }
  if (!isApiRoutable(api)) {
    return false;
  }
  return true;
}

/**
 * Apply MemoryRouter routing to a model.
 * Returns a modified model with baseUrl pointing to MemoryRouter.
 */
export function applyMemoryRouterToModel<T extends Api>(
  model: Model<T>,
  cfg: OpenClawConfig,
): { model: Model<T>; state: MemoryRouterState } {
  const mrConfig = cfg.memoryRouter!;
  const endpoint = mrConfig.endpoint ?? MEMORYROUTER_ENDPOINT;

  // Store original baseUrl for potential fallback
  const state: MemoryRouterState = {
    enabled: true,
    originalBaseUrl: model.baseUrl,
    memoryKey: mrConfig.key,
    endpoint,
  };

  // Map Clawdbot API types to MemoryRouter endpoints
  let routedBaseUrl: string;
  if (model.api === "anthropic-messages") {
    // MemoryRouter's /v1/messages endpoint (native Anthropic)
    routedBaseUrl = endpoint.replace(/\/v1$/, "");
  } else {
    // MemoryRouter's /v1/chat/completions endpoint (OpenAI-compatible)
    routedBaseUrl = endpoint;
  }

  const modifiedModel: Model<T> = {
    ...model,
    baseUrl: routedBaseUrl,
  };

  return { model: modifiedModel, state };
}

/**
 * Build headers for MemoryRouter request.
 * Memory key goes in X-Memory-Key, provider key stays in Authorization.
 *
 * Storage policy:
 *   - Subagents: never store (they're ephemeral workers)
 *   - Tool-use iterations: never store (internal work)
 *   - Direct user ↔ AI conversation: store both sides
 */
export function buildMemoryRouterHeaders(
  memoryKey: string,
  sessionKey?: string,
  isSubagent = false,
  isToolIteration = false,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Memory-Key": memoryKey,
  };
  // NOTE: Do NOT send X-Session-ID — MemoryRouter's resolveVaultsForQuery
  // only searches session vault when sessionId is set, missing core vault entirely.
  // All memory should live in the core vault until MR supports multi-vault queries.

  // Only store direct user ↔ AI conversation, not subagent work or tool iterations
  const shouldStore = !isSubagent && !isToolIteration;
  headers["X-Memory-Store"] = shouldStore ? "true" : "false";
  return headers;
}

/**
 * Check if a session key represents a subagent.
 */
export function isSubagentSession(sessionKey?: string): boolean {
  return sessionKey?.includes(":subagent:") ?? false;
}

/**
 * Detect if the current LLM call is a tool-use iteration (not direct user conversation).
 * Tool iterations have tool_result (Anthropic) or tool-role (OpenAI) messages
 * after the last real user message.
 */
function isToolUseIteration(context: {
  messages?: Array<{ role: string; content?: unknown }>;
}): boolean {
  const messages = context.messages;
  if (!messages || messages.length === 0) {
    return false;
  }

  // Walk backward from the end of messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    // OpenAI tool results: role === "tool"
    if (msg.role === "tool") {
      return true;
    }

    // Anthropic tool results: role === "user" with content blocks containing type: "tool_result"
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const hasToolResult = (msg.content as Array<{ type?: string }>).some(
        (block) => block.type === "tool_result",
      );
      if (hasToolResult) {
        return true;
      }
    }

    // If we hit a normal user message (string content), this is a fresh user turn
    if (msg.role === "user" && typeof msg.content === "string") {
      return false;
    }

    // If we hit an assistant message, keep looking (could be above a tool result)
    if (msg.role === "assistant") {
      continue;
    }
  }

  return false;
}

/**
 * Create a streamFn wrapper that injects MemoryRouter headers and baseUrl.
 */
export function createMemoryRouterStreamFn(
  baseStreamFn: StreamFn | undefined,
  state: MemoryRouterState,
  sessionKey?: string,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const isSubagent = isSubagentSession(sessionKey);

  return (model, context, options?: StreamOptions) => {
    // Apply MemoryRouter baseUrl to the model
    const mrModel = {
      ...model,
      baseUrl: state.endpoint
        ? model.api === "anthropic-messages"
          ? state.endpoint.replace(/\/v1$/, "")
          : state.endpoint
        : model.baseUrl,
    };

    // Detect tool-use iterations — only store direct user ↔ AI conversation
    const toolIteration = isToolUseIteration(
      context as { messages?: Array<{ role: string; content?: unknown }> },
    );

    // Build headers including MemoryRouter headers
    const mrHeaders = state.memoryKey
      ? buildMemoryRouterHeaders(state.memoryKey, sessionKey, isSubagent, toolIteration)
      : {};

    const mergedOptions: StreamOptions = {
      ...options,
      headers: {
        ...mrHeaders,
        ...options?.headers,
      },
    };

    return underlying(mrModel, context, mergedOptions);
  };
}

/**
 * Apply MemoryRouter integration to an agent's streamFn.
 * This is the main integration point called from attempt.ts.
 */
export function applyMemoryRouterToAgent(
  agent: { streamFn?: StreamFn },
  cfg: OpenClawConfig | undefined,
  provider: string,
  modelApi: string,
  sessionKey?: string,
): MemoryRouterState | undefined {
  if (!shouldRouteThrough(cfg, provider, modelApi)) {
    return undefined;
  }

  const mrConfig = cfg!.memoryRouter!;
  const state: MemoryRouterState = {
    enabled: true,
    memoryKey: mrConfig.key,
    endpoint: mrConfig.endpoint ?? MEMORYROUTER_ENDPOINT,
  };

  agent.streamFn = createMemoryRouterStreamFn(agent.streamFn, state, sessionKey);

  return state;
}
