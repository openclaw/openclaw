import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/prompt-caching");

export type PromptCachingConfig = {
  enabled: boolean;
};

type ContentBlock = {
  type: string;
  text?: string;
  cache_control?: { type: string };
  [key: string]: unknown;
};

type ContextLike = {
  system?: string | ContentBlock[];
  messages?: Array<{
    role?: string;
    content?: string | ContentBlock[];
    [key: string]: unknown;
  }>;
  tools?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export function resolvePromptCachingConfig(cfg?: OpenClawConfig): PromptCachingConfig {
  const raw = cfg?.agents?.defaults?.promptCaching;
  return {
    enabled: raw?.enabled ?? true,
  };
}

function isAnthropicProvider(model: Model<Api> | undefined): boolean {
  if (!model) {
    return false;
  }
  return (model as { api?: unknown }).api === "anthropic-messages";
}

/**
 * Normalize system prompt into an array of content blocks for cache_control injection.
 */
function normalizeSystemBlocks(system: string | ContentBlock[] | undefined): ContentBlock[] | null {
  if (!system) {
    return null;
  }
  if (typeof system === "string") {
    return [{ type: "text", text: system }];
  }
  if (Array.isArray(system)) {
    return system.map((block) => ({ ...block }));
  }
  return null;
}

/**
 * Add cache_control breakpoint to the last content block in an array.
 * Returns a shallow copy with the breakpoint added.
 */
export function addCacheBreakpoint(blocks: ContentBlock[]): ContentBlock[] {
  if (blocks.length === 0) {
    return blocks;
  }
  const result = blocks.map((block) => ({ ...block }));
  result[result.length - 1] = {
    ...result[result.length - 1],
    cache_control: { type: "ephemeral" },
  };
  return result;
}

/**
 * Inject cache_control breakpoints into the Anthropic API context.
 *
 * Breakpoints are placed at:
 * 1. End of system prompt (AGENTS.md + SOUL.md + TOOLS.md content)
 * 2. End of tool/skill definitions (last tool in tools array)
 * 3. End of stable conversation prefix (messages before the last 3 user turns)
 *
 * Reference: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
export function injectCacheBreakpoints(context: ContextLike): ContextLike {
  const result = { ...context };

  // Breakpoint 1: End of system prompt
  const systemBlocks = normalizeSystemBlocks(result.system);
  if (systemBlocks && systemBlocks.length > 0) {
    result.system = addCacheBreakpoint(systemBlocks);
  }

  // Breakpoint 2: End of tool definitions
  if (Array.isArray(result.tools) && result.tools.length > 0) {
    const toolsCopy = result.tools.map((tool) => ({ ...tool }));
    toolsCopy[toolsCopy.length - 1] = {
      ...toolsCopy[toolsCopy.length - 1],
      cache_control: { type: "ephemeral" },
    };
    result.tools = toolsCopy;
  }

  // Breakpoint 3: End of stable conversation history prefix
  // We mark the boundary before the last 3 user turns to cache the stable history.
  if (Array.isArray(result.messages) && result.messages.length > 0) {
    const messages = result.messages.map((msg) => ({ ...msg }));
    let userTurnCount = 0;
    let breakpointIndex = -1;

    // Walk backwards to find where stable history ends
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userTurnCount++;
        if (userTurnCount === 3) {
          // Place breakpoint on the message just before this user turn
          breakpointIndex = i > 0 ? i - 1 : -1;
          break;
        }
      }
    }

    if (breakpointIndex >= 0) {
      const msg = messages[breakpointIndex];
      const content = msg.content;
      if (typeof content === "string") {
        messages[breakpointIndex] = {
          ...msg,
          content: [{ type: "text", text: content, cache_control: { type: "ephemeral" } }],
        };
      } else if (Array.isArray(content) && content.length > 0) {
        const contentCopy = content.map((block: ContentBlock) => ({ ...block }));
        contentCopy[contentCopy.length - 1] = {
          ...contentCopy[contentCopy.length - 1],
          cache_control: { type: "ephemeral" },
        };
        messages[breakpointIndex] = { ...msg, content: contentCopy };
      }
    }

    result.messages = messages;
  }

  return result;
}

export type CacheMetrics = {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  inputTokens: number;
  hitRate: number;
};

/**
 * Extract cache metrics from assistant message usage.
 */
export function extractCacheMetrics(
  usage: Record<string, unknown> | undefined | null,
): CacheMetrics | null {
  if (!usage) {
    return null;
  }
  const cacheCreation =
    typeof usage.cacheCreationInputTokens === "number" ? usage.cacheCreationInputTokens : 0;
  const cacheRead = typeof usage.cacheReadInputTokens === "number" ? usage.cacheReadInputTokens : 0;
  const input = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;

  const totalInput = input + cacheCreation + cacheRead;
  if (totalInput === 0) {
    return null;
  }

  return {
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    inputTokens: input,
    hitRate: totalInput > 0 ? cacheRead / totalInput : 0,
  };
}

/**
 * Create a streamFn wrapper that injects Anthropic prompt caching breakpoints
 * and logs cache hit rates.
 */
export function createPromptCachingWrapper(
  streamFn: StreamFn,
  config: PromptCachingConfig,
): StreamFn {
  if (!config.enabled) {
    return streamFn;
  }

  return (model, context, options) => {
    if (!isAnthropicProvider(model)) {
      return streamFn(model, context, options);
    }

    const modifiedContext = injectCacheBreakpoints(context as ContextLike);

    const originalOnMessage = options?.onMessage;
    const wrappedOptions = {
      ...options,
      onMessage: (message: Record<string, unknown>) => {
        // Extract and log cache metrics from the response
        const usage = message?.usage as Record<string, unknown> | undefined;
        const metrics = extractCacheMetrics(usage);
        if (metrics) {
          const hitPct = (metrics.hitRate * 100).toFixed(1);
          log.info(
            `cache metrics: hit_rate=${hitPct}% ` +
              `cache_read=${metrics.cacheReadInputTokens} ` +
              `cache_creation=${metrics.cacheCreationInputTokens} ` +
              `input=${metrics.inputTokens}`,
          );
        }
        originalOnMessage?.(message);
      },
    };

    return streamFn(model, modifiedContext, wrappedOptions);
  };
}
