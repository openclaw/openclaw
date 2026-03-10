/**
 * Local Model Fallback Layer
 *
 * Provides automatic fallback to local models (Ollama/LM Studio) when cloud APIs
 * (specifically Anthropic) are down or rate-limited.
 */

import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isTimeoutError, describeFailoverError } from "./failover-error.js";
import {
  runWithModelFallback,
  type ModelFallbackRunResult,
  type ModelFallbackRunFn,
  type ModelFallbackErrorHandler,
} from "./model-fallback.js";
import { OLLAMA_NATIVE_BASE_URL } from "./ollama-stream.js";
import { cosineSimilarity } from "./semantic-cache-store.js";

export { cosineSimilarity };

const log = createSubsystemLogger("local-model-fallback");

export type LocalModelProvider = "ollama" | "lmstudio";

export type LocalModelConfig = {
  provider: LocalModelProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
  enabled: boolean;
  timeoutMs: number;
  healthCheckIntervalMs: number;
  maxRetries: number;
};

export type LocalFallbackOptions = {
  /** Trigger fallback on these HTTP status codes */
  triggerStatusCodes: number[];
  /** Trigger fallback on timeout */
  triggerOnTimeout: boolean;
  /** Trigger fallback on rate limit errors */
  triggerOnRateLimit: boolean;
  /** Minimum consecutive failures before fallback */
  minConsecutiveFailures: number;
};

export type HealthStatus = {
  isHealthy: boolean;
  lastChecked: number;
  consecutiveFailures: number;
  lastError?: string;
};

const healthStatusMap = new Map<string, HealthStatus>();
// Tracks consecutive cloud-chain failures per provider:model key across invocations.
const cloudFailureCountMap = new Map<string, number>();
const DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234";
const DEFAULT_LOCAL_MODEL = "llama3.2";
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;

/**
 * Resolve local model configuration from OpenClaw config
 */
export function resolveLocalModelConfig(cfg: OpenClawConfig | undefined): LocalModelConfig | null {
  const localConfig = cfg?.agents?.defaults?.localModelFallback;

  if (!localConfig?.enabled) {
    return null;
  }

  const provider = localConfig.provider ?? "ollama";
  const baseUrl =
    localConfig.baseUrl ??
    (provider === "ollama" ? OLLAMA_NATIVE_BASE_URL : DEFAULT_LMSTUDIO_BASE_URL);

  return {
    provider,
    baseUrl,
    model: localConfig.model ?? DEFAULT_LOCAL_MODEL,
    apiKey: localConfig.apiKey,
    enabled: true,
    timeoutMs: localConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    healthCheckIntervalMs: localConfig.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    maxRetries: localConfig.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}

/**
 * Check if a local model provider is healthy
 */
export async function checkLocalModelHealth(config: LocalModelConfig): Promise<HealthStatus> {
  const cacheKey = `${config.provider}:${config.baseUrl}`;
  const cached = healthStatusMap.get(cacheKey);
  const now = Date.now();

  // Return cached result if within health check interval
  if (cached && now - cached.lastChecked < config.healthCheckIntervalMs) {
    return cached;
  }

  try {
    const healthUrl =
      config.provider === "ollama" ? `${config.baseUrl}/api/tags` : `${config.baseUrl}/v1/models`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(healthUrl, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const isHealthy = response.ok;
    const status: HealthStatus = {
      isHealthy,
      lastChecked: now,
      consecutiveFailures: isHealthy ? 0 : (cached?.consecutiveFailures ?? 0) + 1,
      lastError: isHealthy ? undefined : `HTTP ${response.status}`,
    };

    healthStatusMap.set(cacheKey, status);
    return status;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const status: HealthStatus = {
      isHealthy: false,
      lastChecked: now,
      consecutiveFailures: (cached?.consecutiveFailures ?? 0) + 1,
      lastError: errorMessage,
    };
    healthStatusMap.set(cacheKey, status);
    return status;
  }
}

/**
 * Determine if fallback to local model should be triggered
 */
export function shouldTriggerLocalFallback(
  error: unknown,
  options: LocalFallbackOptions,
  consecutiveFailures: number,
): boolean {
  // Check minimum consecutive failures
  if (consecutiveFailures < options.minConsecutiveFailures) {
    return false;
  }

  // Get error description for analysis
  const errorDesc = describeFailoverError(error);

  // Check status code triggers from error description
  if (errorDesc.status && options.triggerStatusCodes.includes(errorDesc.status)) {
    return true;
  }

  // Check rate limit trigger
  if (options.triggerOnRateLimit && errorDesc.reason === "rate_limit") {
    return true;
  }

  // Check timeout trigger
  if (options.triggerOnTimeout && isTimeoutError(error)) {
    return true;
  }

  return false;
}

/**
 * Return the provider/model strings to use for local model invocation.
 * Both Ollama and LM Studio are addressed via the "ollama" provider in the
 * model config since LM Studio exposes an OpenAI-compatible API.
 */
export function createLocalModelStreamFn(config: LocalModelConfig): {
  provider: string;
  model: string;
} {
  // LM Studio is OpenAI-compatible; resolve as "ollama" provider in pi-agent.
  return { provider: config.provider, model: config.model };
}

/**
 * Run with local model fallback.
 *
 * Wraps `runWithModelFallback` and, when all cloud candidates are exhausted and
 * the error qualifies for local fallback, retries by invoking `params.run` with
 * the local provider/model strings (e.g. "ollama" / "llama3.2").  The caller's
 * `run` callback already knows how to talk to any provider — we just tell it
 * which one to use.
 */
export async function runWithLocalModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentDir?: string;
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
  localFallbackOptions?: LocalFallbackOptions;
}): Promise<ModelFallbackRunResult<T>> {
  const localConfig = resolveLocalModelConfig(params.cfg);

  if (!localConfig) {
    // Local fallback not configured — delegate to standard cloud fallback.
    return runWithModelFallback({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      agentDir: params.agentDir,
      run: params.run,
      onError: params.onError,
    });
  }

  const fallbackOptions: LocalFallbackOptions = params.localFallbackOptions ?? {
    triggerStatusCodes: [429, 503, 502, 500],
    triggerOnTimeout: true,
    triggerOnRateLimit: true,
    minConsecutiveFailures: 1,
  };

  // First attempt: run through the normal cloud model-fallback chain.
  let cloudResult: ModelFallbackRunResult<T> | null = null;
  let cloudError: unknown = null;

  const cloudKey = `${params.provider}:${params.model}`;

  try {
    cloudResult = await runWithModelFallback({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      agentDir: params.agentDir,
      run: params.run,
      onError: params.onError,
    });
  } catch (err) {
    cloudError = err;
  }

  if (cloudResult) {
    // Reset failure counter on success.
    cloudFailureCountMap.delete(cloudKey);
    return cloudResult;
  }

  // Track consecutive failures and check whether this error qualifies for local fallback.
  // Evict the oldest entry if the map grows beyond a small bound (guard against unbounded growth
  // in pathological configs with many distinct provider:model keys).
  const consecutiveFailures = (cloudFailureCountMap.get(cloudKey) ?? 0) + 1;
  if (!cloudFailureCountMap.has(cloudKey) && cloudFailureCountMap.size >= 100) {
    cloudFailureCountMap.delete(cloudFailureCountMap.keys().next().value!);
  }
  cloudFailureCountMap.set(cloudKey, consecutiveFailures);

  if (!shouldTriggerLocalFallback(cloudError, fallbackOptions, consecutiveFailures)) {
    throw cloudError;
  }

  // Check local model health.
  const health = await checkLocalModelHealth(localConfig);
  if (!health.isHealthy) {
    log.warn(`Local model ${localConfig.provider} is not healthy: ${health.lastError}`);
    throw cloudError;
  }

  log.info(`Triggering local model fallback to ${localConfig.provider}/${localConfig.model}`);

  // Re-run the caller's run function with the local provider/model.
  const localResult = await params.run(localConfig.provider, localConfig.model);
  return {
    result: localResult,
    provider: localConfig.provider,
    model: localConfig.model,
    attempts: [],
  };
}
