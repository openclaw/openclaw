// Firecrawl config schema module implements Zod validation for Firecrawl configuration.
// This schema validates the canonical plugin config path and legacy nested paths.
import { z } from "zod";

/**
 * Zod schema for Firecrawl web search configuration.
 * Supports both canonical plugin config and legacy tools.web.search.firecrawl paths.
 */
export const FirecrawlSearchConfigSchema = z.object({
  /** API key for Firecrawl authentication (optional, can use env var) */
  apiKey: z.string().optional(),
  /** Custom base URL for self-hosted Firecrawl instances */
  baseUrl: z.string().url().optional(),
});

/**
 * Zod schema for Firecrawl web fetch configuration.
 * Supports both canonical plugin config and legacy tools.web.fetch.firecrawl paths.
 */
export const FirecrawlFetchConfigSchema = z.object({
  /** API key for Firecrawl authentication (optional, can use env var) */
  apiKey: z.string().optional(),
  /** Custom base URL for self-hosted Firecrawl instances */
  baseUrl: z.string().url().optional(),
  /** Whether to extract only main content (default: true) */
  onlyMainContent: z.boolean().optional().default(true),
  /** Maximum age of cached content in milliseconds (default: 172800000 = 48h) */
  maxAgeMs: z.number().int().min(0).optional(),
  /** Timeout in seconds for scrape operations */
  timeoutSeconds: z.number().int().positive().optional(),
});

/**
 * Zod schema for Firecrawl plugin configuration.
 * This is the canonical configuration path: plugins.entries.firecrawl.config
 */
export const FirecrawlPluginConfigSchema = z.object({
  /** Firecrawl configuration for web search */
  webSearch: FirecrawlSearchConfigSchema.optional(),
  /** Firecrawl configuration for web fetch */
  webFetch: FirecrawlFetchConfigSchema.optional(),
});

/**
 * Zod schema for the legacy tools.web.search.firecrawl path.
 * Uses Object.hasOwn() semantics at runtime to reject prototype-inherited properties.
 */
export const LegacyFirecrawlSearchEntrySchema = z.object({
  firecrawl: FirecrawlSearchConfigSchema.optional(),
});

/**
 * Zod schema for the legacy tools.web.fetch.firecrawl path.
 * Uses Object.hasOwn() semantics at runtime to reject prototype-inherited properties.
 */
export const LegacyFirecrawlFetchEntrySchema = z.object({
  firecrawl: FirecrawlFetchConfigSchema.optional(),
});
