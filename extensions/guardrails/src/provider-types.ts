import type { CheckContext, GuardrailsDecision, HttpConfig } from "./config.js";

/**
 * Interface for HTTP provider adapters.
 *
 * init() is called once at plugin registration for global, one-time
 * initialization (auth, connection pools, model loading, etc.).
 *
 * check() returns a GuardrailsDecision with action "pass" or "block".
 */
export interface GuardrailsProviderAdapter {
  init?(config: HttpConfig): Promise<void> | void;
  check(
    text: string,
    context: CheckContext,
    config: HttpConfig,
    fallbackOnError: "pass" | "block",
    timeoutMs: number,
  ): Promise<GuardrailsDecision>;
}
