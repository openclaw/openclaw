// Host policy ports for the reusable transport package. Fetch guarding,
// secret redaction, strict-tool policy, and diagnostics logging are owned by
// the embedding application (OpenClaw core installs its implementations via
// configureAiTransportHost); the library defaults below are inert so external
// consumers get safe, dependency-free behavior without wiring anything.
import type { Model } from "@openclaw/llm-core";

/** Strict-tool policy inputs for OpenAI-compatible routes. */
export interface OpenAIStrictToolSettingOptions {
  transport?: "stream" | "websocket";
  supportsStrictMode?: boolean;
}

/** Narrow host ports consumed by the built-in provider adapters. */
export interface AiTransportHost {
  /**
   * Builds a policy-guarded fetch for one model request.
   * Returning undefined keeps the provider SDK's default fetch.
   */
  buildModelFetch(
    model: Model,
    timeoutMs?: number,
    options?: { sanitizeSse?: boolean },
  ): typeof fetch | undefined;
  /** Redacts secrets inside structured tool-result payloads. */
  redactSecrets<T>(value: T): T;
  /** Redacts secret-bearing text in tool payload strings. */
  redactToolPayloadText(text: string): string;
  /**
   * Resolves the host strict-tool default for OpenAI-compatible routes.
   * undefined lets the request omit the strict flag entirely.
   */
  resolveOpenAIStrictToolSetting(
    model: Pick<Model, "provider" | "api" | "baseUrl" | "id"> & { compat?: unknown },
    options?: OpenAIStrictToolSettingOptions,
  ): boolean | undefined;
  /**
   * Emits one transport diagnostic; build runs only when the host logs it and
   * may return null to suppress the entry (e.g. de-duplication).
   */
  logDebug(
    subsystem: string,
    build: () => { message: string; data?: Record<string, unknown> } | null,
  ): void;
}

const inertAiTransportHost: AiTransportHost = {
  buildModelFetch: () => undefined,
  redactSecrets: (value) => value,
  redactToolPayloadText: (text) => text,
  resolveOpenAIStrictToolSetting: (_model, options) =>
    options?.supportsStrictMode ? false : undefined,
  logDebug: () => {},
};

let activeAiTransportHost = inertAiTransportHost;

/** Installs host implementations for the transport policy ports. */
export function configureAiTransportHost(host: Partial<AiTransportHost>): void {
  activeAiTransportHost = { ...inertAiTransportHost, ...host };
}

/** Returns the active transport host (inert defaults unless configured). */
export function getAiTransportHost(): AiTransportHost {
  return activeAiTransportHost;
}
