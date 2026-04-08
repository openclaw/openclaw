import { isRecord } from "openclaw/plugin-sdk/text-runtime";

/**
 * Bocha-specific configuration.
 *
 * These fields live under `plugins.entries.bocha.config.webSearch.*` in the
 * main OpenClaw configuration file.
 */
export type BochaConfig = {
  /** Bocha API key. Fallback: tools.web.search.apiKey or BOCHA_API_KEY env. */
  apiKey?: unknown;
  /** Bocha API base URL. Fallback: https://api.bocha.cn/v1. */
  baseUrl?: unknown;
  /** Whether to return original web contents (summary). Default: true. */
  summary?: boolean;
};

export const DEFAULT_BOCHA_BASE_URL = "https://api.bocha.cn/v1";

/**
 * Resolves Bocha-specific configuration from the search tool config.
 *
 * The searchConfig passed here is expected to be the merged result of
 * top-level `tools.web.search` and plugin-specific config.
 */
export function resolveBochaConfig(searchConfig?: Record<string, unknown>): BochaConfig {
  const bocha = searchConfig?.bocha;
  return isRecord(bocha) ? (bocha as BochaConfig) : {};
}
