import type { BackendFn, CheckContext, HttpConfig, Logger } from "./config.js";
import type { GuardrailsProviderAdapter } from "./provider-types.js";
import { createDKnownAIAdapter } from "./providers/dknownai.js";
import { createHidylanAdapter } from "./providers/hidylan.js";
import { createOpenAIModerationAdapter } from "./providers/openai-moderation.js";
import { createSecraAdapter } from "./providers/secra.js";

export type { GuardrailsProviderAdapter };

export type HttpBackendHandle = {
  backendFn: BackendFn;
  dispose: () => void;
};

// ── Provider registry ───────────────────────────────────────────────────

const providerRegistry = new Map<string, GuardrailsProviderAdapter>();
const builtInProviderNames = new Set(["openai-moderation", "dknownai", "secra", "hidylan"]);

/**
 * Register a custom HTTP provider adapter by name.
 * The name can then be used as http.provider in the plugin config.
 * Built-in providers ("openai-moderation", "dknownai", "secra", "hidylan") cannot be overridden.
 */
export function registerHttpProvider(name: string, adapter: GuardrailsProviderAdapter): void {
  if (builtInProviderNames.has(name)) {
    throw new Error(`guardrails: cannot register built-in provider "${name}"`);
  }
  providerRegistry.set(name, adapter);
}

/** @internal — test-only: clear all registered providers. */
export function _resetRegistryForTesting(): void {
  providerRegistry.clear();
}

// ── Adapter resolution ──────────────────────────────────────────────────

/**
 * Resolve and initialize an HTTP provider adapter.
 *
 * Provider resolution priority:
 *   1. built-in providers ("openai-moderation", "dknownai", "secra", "hidylan")
 *   2. registered providers (via registerHttpProvider)
 *
 * init() is called once with the provided config for global one-time
 * initialization. For registered providers, the same adapter object from the
 * registry is returned — callers must deduplicate to avoid double-init.
 */
export async function resolveHttpAdapter(
  config: HttpConfig,
  logger: Logger,
): Promise<GuardrailsProviderAdapter | null> {
  let adapter: GuardrailsProviderAdapter | null = null;

  // Built-in providers
  if (config.provider === "openai-moderation") {
    adapter = createOpenAIModerationAdapter(logger);
  } else if (config.provider === "dknownai") {
    adapter = createDKnownAIAdapter(logger);
  } else if (config.provider === "secra") {
    adapter = createSecraAdapter(logger);
  } else if (config.provider === "hidylan") {
    adapter = createHidylanAdapter(logger);
  } else {
    // Registry lookup for custom / community providers
    const registered = providerRegistry.get(config.provider);
    if (registered) {
      adapter = registered;
    } else {
      logger.error(
        `guardrails: unknown http provider "${config.provider}" — register it with registerHttpProvider()`,
      );
    }
  }

  // Run optional one-time init
  if (adapter?.init) {
    try {
      await adapter.init(config);
    } catch (err) {
      logger.error(`guardrails: provider init failed: ${String(err)}`);
      adapter = null;
    }
  }

  return adapter;
}

// ── Backend creation ────────────────────────────────────────────────────

/**
 * Create an HTTP connector with provider routing.
 *
 * Convenience wrapper: resolves the adapter and wraps it in a BackendFn.
 * For multi-provider per-channel setups, index.ts uses resolveHttpAdapter()
 * directly and builds per-channel BackendFns itself.
 */
export async function createHttpBackend(
  config: HttpConfig,
  fallbackOnError: "pass" | "block",
  timeoutMs: number,
  logger: Logger,
): Promise<HttpBackendHandle> {
  const adapter = await resolveHttpAdapter(config, logger);

  const backendFn: BackendFn = async (text: string, context: CheckContext) => {
    if (!adapter) {
      return { action: fallbackOnError };
    }
    return adapter.check(text, context, config, fallbackOnError, timeoutMs);
  };

  return {
    backendFn,
    dispose: () => {},
  };
}
