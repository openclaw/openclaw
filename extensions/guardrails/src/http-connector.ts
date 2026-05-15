import type { BackendFn, CheckContext, HttpConfig, HttpProviderType, Logger } from "./config.js";
import type {
  GuardrailsProviderAdapter,
  ProviderInitConfig,
  ResolvedHttpConfig,
} from "./provider-types.js";
import { createDKnownAIAdapter } from "./providers/dknownai.js";
import { createHidylanAdapter } from "./providers/hidylan.js";
import { createSecraAdapter } from "./providers/secra.js";

export type { GuardrailsProviderAdapter, ProviderInitConfig, ResolvedHttpConfig };

export type HttpBackendHandle = {
  backendFn: BackendFn;
  dispose: () => void;
};

/**
 * Runtime resolver invoked at each `check()` boundary to materialise
 * plaintext apiKey. Keeping resolution lazy lets to plugin entry source
 * secret from an external SecretRef without retaining plaintext in
 * long-lived configuration.
 */
export type ApiKeyResolver = () => Promise<string> | string;

// ── Provider registry ───────────────────────────────────────────────────

const providerRegistry = new Map<string, GuardrailsProviderAdapter>();
const builtInProviderNames = new Set(["dknownai", "secra", "hidylan"]);

/**
 * Register a custom HTTP provider adapter by name.
 * The name can then be used as http.provider in the plugin config.
 * Built-in providers ("dknownai", "secra", "hidylan") cannot be overridden.
 */
export function registerHttpProvider(name: string, adapter: GuardrailsProviderAdapter): void {
  if (builtInProviderNames.has(name)) {
    throw new Error(`guardrail-bridge: cannot register built-in provider "${name}"`);
  }
  providerRegistry.set(name, adapter);
}

/** @internal — test-only: clear all registered providers. */
export function _resetRegistryForTesting(): void {
  providerRegistry.clear();
}

// ── Adapter resolution ──────────────────────────────────────────────────

/**
 * Build a non-sensitive init config from an HttpConfig.
 *
 * Provider init() must not receive secret apiKey — only to non-sensitive
 * fields (provider, apiUrl, model, params) are forwarded.
 */
function toInitConfig(config: HttpConfig): ProviderInitConfig {
  return {
    provider: config.provider,
    apiUrl: config.apiUrl,
    model: config.model,
    params: config.params,
  };
}

/**
 * Resolve and initialize an HTTP provider adapter.
 *
 * Provider resolution priority:
 *   1. built-in providers ("dknownai", "secra", "hidylan")
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
  if (config.provider === "dknownai") {
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
        `guardrail-bridge: unknown http provider "${config.provider}" — register it with registerHttpProvider()`,
      );
    }
  }

  // Run optional one-time init with non-sensitive config only
  if (adapter?.init) {
    try {
      await adapter.init(toInitConfig(config));
    } catch (err) {
      logger.error(`guardrail-bridge: provider init failed: ${String(err)}`);
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
 * The optional `resolveApiKey` callback is invoked on every check to obtain
 * the plaintext secret string; when omitted, the plain-string value carried
 * on `config.apiKey` is used (SecretRef objects resolve to an empty string,
 * which providers treat as missing credentials).
 *
 * For multi-provider per-channel setups, index.ts uses resolveHttpAdapter()
 * directly and builds per-channel BackendFns itself.
 */
export async function createHttpBackend(
  config: HttpConfig,
  fallbackOnError: "pass" | "block",
  timeoutMs: number,
  logger: Logger,
  resolveApiKey?: ApiKeyResolver,
): Promise<HttpBackendHandle> {
  const adapter = await resolveHttpAdapter(config, logger);

  const fallbackResolver: ApiKeyResolver = () =>
    typeof config.apiKey === "string" ? config.apiKey : "";
  const resolver: ApiKeyResolver = resolveApiKey ?? fallbackResolver;

  const backendFn: BackendFn = async (text: string, context: CheckContext) => {
    if (!adapter) {
      return { action: fallbackOnError };
    }
    const apiKey = await resolver();
    const resolved: ResolvedHttpConfig = {
      provider: config.provider,
      apiKey,
      apiUrl: config.apiUrl,
      model: config.model,
      params: config.params,
    };
    return adapter.check(text, context, resolved, fallbackOnError, timeoutMs);
  };

  return {
    backendFn,
    dispose: () => {},
  };
}
