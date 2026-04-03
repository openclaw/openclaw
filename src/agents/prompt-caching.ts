/**
 * Prompt Caching Support
 * 
 * Adds Anthropic Prompt Caching support to reduce token costs.
 * For eligible providers, adds cache_control to large content blocks.
 * 
 * @see https://docs.anthropic.com/claude/docs/prompt-caching
 */

import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";

/**
 * Providers that support Anthropic-style Prompt Caching
 */
const CACHE_ELIGIBLE_PROVIDERS = new Set([
  "anthropic",
  "anthropic-bedrock",
  "anthropic-vertex",
  "openrouter", // OpenRouter supports cache_control for Anthropic models
]);

/**
 * Minimum content length (in characters) to enable caching
 * 1024 characters ≈ 256-512 tokens (varies by content)
 */
const DEFAULT_CACHE_THRESHOLD_CHARS = 1024;

/**
 * Configuration for Prompt Caching
 */
export interface PromptCacheConfig {
  /** Whether caching is enabled (default: true) */
  enabled?: boolean;
  /** Minimum characters to trigger caching (default: 1024) */
  thresholdChars?: number;
  /** Provider IDs eligible for caching */
  providers?: string[];
}

/**
 * Check if a provider supports Prompt Caching
 */
export function isCacheEligibleProvider(
  provider: string,
  modelApi?: string,
): boolean {
  const normalizedProvider = provider.toLowerCase().trim();
  
  // Check if provider is in the eligible list
  if (CACHE_ELIGIBLE_PROVIDERS.has(normalizedProvider)) {
    return true;
  }
  
  // Check for custom Anthropic API
  if (modelApi === "anthropic-messages") {
    return true;
  }
  
  return false;
}

/**
 * Content block with optional cache_control
 */
export type CacheableContentBlock = ContentBlock & {
  cache_control?: { type: "ephemeral" };
};

/**
 * Add cache_control to a text block if eligible
 */
export function addCacheControlToText(
  text: string,
  provider: string,
  config?: PromptCacheConfig,
): CacheableContentBlock {
  const enabled = config?.enabled ?? true;
  const threshold = config?.thresholdChars ?? DEFAULT_CACHE_THRESHOLD_CHARS;
  const providers = config?.providers 
    ? new Set(config.providers.map(p => p.toLowerCase()))
    : CACHE_ELIGIBLE_PROVIDERS;
  
  const isEligible = enabled && 
    text.length >= threshold && 
    (providers.has(provider.toLowerCase()) || isCacheEligibleProvider(provider));
  
  const block: CacheableContentBlock = {
    type: "text",
    text,
  };
  
  if (isEligible) {
    block.cache_control = { type: "ephemeral" };
  }
  
  return block;
}

/**
 * Add cache_control to content blocks
 * 
 * For each text block that exceeds the threshold, add cache_control.
 * This enables Anthropic's Prompt Caching to cache large content blocks.
 */
export function addCacheControlToBlocks(
  blocks: ContentBlock[],
  provider: string,
  config?: PromptCacheConfig,
): CacheableContentBlock[] {
  const enabled = config?.enabled ?? true;
  const threshold = config?.thresholdChars ?? DEFAULT_CACHE_THRESHOLD_CHARS;
  const providers = config?.providers
    ? new Set(config.providers.map(p => p.toLowerCase()))
    : CACHE_ELIGIBLE_PROVIDERS;
  
  const isProviderEligible = enabled && 
    (providers.has(provider.toLowerCase()) || isCacheEligibleProvider(provider));
  
  if (!isProviderEligible) {
    return blocks as CacheableContentBlock[];
  }
  
  return blocks.map((block) => {
    // Only add cache_control to text blocks that exceed threshold
    if (block.type === "text" && block.text.length >= threshold) {
      return {
        ...block,
        cache_control: { type: "ephemeral" },
      };
    }
    return block as CacheableContentBlock;
  });
}

/**
 * Add cache_control to system prompt
 * 
 * System prompts are typically large and reused across turns,
 * making them ideal candidates for caching.
 */
export function addCacheControlToSystemPrompt(
  systemPrompt: string,
  provider: string,
  config?: PromptCacheConfig,
): CacheableContentBlock[] {
  const threshold = config?.thresholdChars ?? DEFAULT_CACHE_THRESHOLD_CHARS;
  
  // Always try to cache system prompts if they're large enough
  if (systemPrompt.length >= threshold && isCacheEligibleProvider(provider)) {
    return [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ];
  }
  
  return [{ type: "text", text: systemPrompt }];
}

/**
 * Message with cacheable content
 */
export interface CacheableMessage {
  role: "user" | "assistant";
  content: string | CacheableContentBlock[];
}

/**
 * Add cache_control to messages
 * 
 * For user messages with large content, add cache_control to enable caching.
 * This is especially useful for:
 * - File contents read via the read tool
 * - Large code blocks
 * - Context files (MEMORY.md, AGENTS.md, etc.)
 */
export function addCacheControlToMessages(
  messages: Array<{ role: string; content: string | ContentBlock[] }>,
  provider: string,
  config?: PromptCacheConfig,
): Array<{ role: string; content: string | CacheableContentBlock[] }> {
  const enabled = config?.enabled ?? true;
  
  if (!enabled || !isCacheEligibleProvider(provider)) {
    return messages as Array<{ role: string; content: string | CacheableContentBlock[] }>;
  }
  
  return messages.map((msg) => {
    // Only process user messages (system prompts are handled separately)
    if (msg.role !== "user") {
      return msg as { role: string; content: string | CacheableContentBlock[] };
    }
    
    // Handle string content
    if (typeof msg.content === "string") {
      const threshold = config?.thresholdChars ?? DEFAULT_CACHE_THRESHOLD_CHARS;
      if (msg.content.length >= threshold) {
        return {
          role: msg.role,
          content: [
            {
              type: "text",
              text: msg.content,
              cache_control: { type: "ephemeral" },
            },
          ],
        };
      }
      return msg as { role: string; content: string | CacheableContentBlock[] };
    }
    
    // Handle array content
    return {
      role: msg.role,
      content: addCacheControlToBlocks(msg.content, provider, config),
    };
  });
}

/**
 * Extract cache statistics from API response
 * 
 * Anthropic API returns cache usage in the response:
 * - cache_read_input_tokens: tokens read from cache
 * - cache_creation_input_tokens: tokens written to cache
 */
export interface CacheStats {
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export function extractCacheStats(response: unknown): CacheStats {
  if (!response || typeof response !== "object") {
    return {};
  }
  
  const r = response as Record<string, unknown>;
  return {
    cacheReadInputTokens: typeof r.cache_read_input_tokens === "number" 
      ? r.cache_read_input_tokens 
      : undefined,
    cacheCreationInputTokens: typeof r.cache_creation_input_tokens === "number"
      ? r.cache_creation_input_tokens
      : undefined,
  };
}

/**
 * Calculate cost savings from cache
 * 
 * Anthropic Prompt Caching pricing:
 * - Cache write: 25% more than base input price
 * - Cache read: 10% of base input price (90% savings!)
 */
export interface CacheSavings {
  tokensCached: number;
  tokensReadFromCache: number;
  estimatedSavingsPercent: number;
}

export function calculateCacheSavings(
  cacheReadTokens: number,
  cacheWriteTokens: number,
): CacheSavings {
  // Cache read: 90% savings (10% of input price)
  // Cache write: 25% extra cost
  const savingsFromRead = cacheReadTokens * 0.9; // 90% off
  const costFromWrite = cacheWriteTokens * 0.25; // 25% extra
  
  const netSavings = savingsFromRead - costFromWrite;
  const totalTokens = cacheReadTokens + cacheWriteTokens;
  
  // Net savings percentage
  const estimatedSavingsPercent = totalTokens > 0 
    ? (netSavings / (totalTokens + costFromWrite)) * 100 
    : 0;
  
  return {
    tokensCached: cacheWriteTokens,
    tokensReadFromCache: cacheReadTokens,
    estimatedSavingsPercent: Math.max(0, estimatedSavingsPercent),
  };
}
