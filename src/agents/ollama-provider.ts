import type { StreamFn } from "@mariozechner/pi-agent-core";
import { ollamaFetch } from "./ollama-retry.js";
import { createOllamaStreamFn, OLLAMA_NATIVE_BASE_URL } from "./ollama-stream.js";

export interface OllamaProviderConfig {
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Resolve Ollama configuration from environment, user config, and defaults.
 *
 * Priority: userConfig.ollama.baseUrl > OLLAMA_HOST env > default localhost:11434
 */
export function resolveOllamaConfig(userConfig?: Record<string, unknown>): OllamaProviderConfig {
  const ollamaSection =
    userConfig && typeof userConfig.ollama === "object" && userConfig.ollama !== null
      ? (userConfig.ollama as Record<string, unknown>)
      : undefined;

  const configBaseUrl =
    ollamaSection && typeof ollamaSection.baseUrl === "string" ? ollamaSection.baseUrl.trim() : "";

  const envHost = process.env.OLLAMA_HOST?.trim() ?? "";

  const baseUrl = configBaseUrl || envHost || undefined;

  return { baseUrl };
}

/**
 * Resolve the effective Ollama base URL from model/provider config.
 * Used by the agentic loop to pick the right endpoint.
 *
 * Priority: model.baseUrl > providerConfig.baseUrl > OLLAMA_NATIVE_BASE_URL
 */
export function resolveOllamaBaseUrl(modelBaseUrl?: string, providerBaseUrl?: string): string {
  const m = typeof modelBaseUrl === "string" ? modelBaseUrl.trim() : "";
  const p = typeof providerBaseUrl === "string" ? providerBaseUrl.trim() : "";
  return m || p || OLLAMA_NATIVE_BASE_URL;
}

export interface OllamaProvider {
  streamFn: StreamFn;
  checkHealth: () => Promise<boolean>;
}

/**
 * Create an Ollama provider with a streamFn and health check.
 */
export function createOllamaProvider(config?: OllamaProviderConfig): OllamaProvider {
  const baseUrl = config?.baseUrl?.trim() || OLLAMA_NATIVE_BASE_URL;

  const streamFn = createOllamaStreamFn(baseUrl);

  const checkHealth = async (): Promise<boolean> => {
    try {
      const versionUrl = `${baseUrl.replace(/\/+$/, "")}/api/version`;
      const res = await ollamaFetch(
        versionUrl,
        { method: "GET" },
        { maxRetries: 1, timeoutMs: 5000 },
      );
      return res.ok;
    } catch {
      return false;
    }
  };

  return { streamFn, checkHealth };
}
