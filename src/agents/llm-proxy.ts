/**
 * LLM API proxy support.
 *
 * Uses undici's ProxyAgent to route all fetch() calls through a configured proxy.
 * This is needed because pi-ai uses globalThis.fetch internally and doesn't
 * accept a custom fetch function.
 */
import { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

import type { OpenClawConfig } from "../config/config.js";

let originalDispatcher: Dispatcher | null = null;
let currentProxyUrl: string | null = null;

/**
 * Configure the global fetch dispatcher to use an HTTP proxy for all requests.
 * Call this before making LLM API calls when models.proxy is configured.
 *
 * Safe to call multiple times - only reconfigures if the proxy URL changes.
 */
export function setupLlmProxy(cfg: OpenClawConfig | undefined): void {
  // If a global proxy is configured, do not override it.
  // Global proxy covers LLM calls too, and keeps other subsystems (Discord, Slack, etc.) consistent.
  if (cfg?.proxy?.trim()) return;

  const proxyUrl = cfg?.models?.proxy?.trim();

  // No proxy configured - restore original dispatcher if we changed it
  if (!proxyUrl) {
    if (originalDispatcher) {
      setGlobalDispatcher(originalDispatcher);
      originalDispatcher = null;
      currentProxyUrl = null;
    }
    return;
  }

  // Same proxy already configured - no action needed
  if (proxyUrl === currentProxyUrl) {
    return;
  }

  // Save original dispatcher on first proxy setup
  if (!originalDispatcher) {
    originalDispatcher = getGlobalDispatcher();
  }

  // Set up new proxy agent
  const proxyAgent = new ProxyAgent(proxyUrl);
  setGlobalDispatcher(proxyAgent);
  currentProxyUrl = proxyUrl;
}

/**
 * Check if an LLM proxy is currently configured and active.
 */
export function isLlmProxyActive(): boolean {
  return currentProxyUrl !== null;
}

/**
 * Get the currently configured proxy URL, if any.
 */
export function getLlmProxyUrl(): string | null {
  return currentProxyUrl;
}
