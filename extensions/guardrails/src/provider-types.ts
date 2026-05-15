import type { CheckContext, GuardrailsDecision, HttpProviderType } from "./config.js";

/**
 * Resolved HTTP configuration handed to provider adapters.
 *
 * `apiKey` is the runtime-resolved plaintext secret string. It is built at the
 * boundary of each `check()` invocation from the plugin entry's secret
 * resolver and must not be retained beyond the request.
 */
export type ResolvedHttpConfig = {
  provider: HttpProviderType;
  apiKey: string;
  apiUrl: string;
  model: string;
  params: Record<string, unknown>;
};

/**
 * Non-sensitive HTTP configuration passed to provider `init()`.
 *
 * Adapters must not require the secret during initialization — secrets are
 * supplied only at `check()` time via {@link ResolvedHttpConfig}.
 */
export type ProviderInitConfig = Omit<ResolvedHttpConfig, "apiKey">;

/**
 * Interface for HTTP provider adapters.
 *
 * init() is called once per non-sensitive config combination for global,
 * one-time initialization (auth, connection pools, model loading, etc.).
 * It MUST NOT receive any secret material.
 *
 * check() receives the runtime-resolved config (including the plaintext
 * apiKey) and returns a GuardrailsDecision with action "pass" or "block".
 */
export interface GuardrailsProviderAdapter {
  init?(config: ProviderInitConfig): Promise<void> | void;
  check(
    text: string,
    context: CheckContext,
    config: ResolvedHttpConfig,
    fallbackOnError: "pass" | "block",
    timeoutMs: number,
  ): Promise<GuardrailsDecision>;
}
