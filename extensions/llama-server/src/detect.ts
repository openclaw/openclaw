/**
 * Auto-detect llama-server endpoints and determine compat settings.
 */

export type LlamaServerInfo = {
  isLlamaServer: boolean;
  version?: string;
  modelId?: string;
  contextLength?: number;
  parallelSlots?: number;
};

/**
 * Probe a URL to determine if it's a llama-server instance.
 * Checks /health and /v1/models for llama-server signatures.
 */
export async function detectLlamaServer(baseUrl: string): Promise<LlamaServerInfo> {
  const normalizedUrl = baseUrl.replace(/\/v1\/?$/, "");

  try {
    // Check /health endpoint
    const healthRes = await fetch(`${normalizedUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!healthRes.ok) {
      return { isLlamaServer: false };
    }

    const health = (await healthRes.json()) as {
      status?: string;
      slots_idle?: number;
      slots_processing?: number;
    };

    // llama-server returns { status: "ok" } with optional slot info
    const hasSlotInfo = health.slots_idle !== undefined || health.slots_processing !== undefined;

    // Check /v1/models for llamacpp signature
    const modelsRes = await fetch(`${normalizedUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!modelsRes.ok) {
      return { isLlamaServer: hasSlotInfo, parallelSlots: computeSlots(health) };
    }

    const models = (await modelsRes.json()) as {
      data?: Array<{
        id?: string;
        owned_by?: string;
        meta?: { n_ctx_train?: number; n_vocab?: number };
      }>;
    };

    const firstModel = models.data?.[0];
    const isLlamaCpp = firstModel?.owned_by === "llamacpp";

    return {
      isLlamaServer: isLlamaCpp || hasSlotInfo,
      modelId: firstModel?.id,
      contextLength: firstModel?.meta?.n_ctx_train,
      parallelSlots: computeSlots(health),
    };
  } catch {
    return { isLlamaServer: false };
  }
}

function computeSlots(health: {
  slots_idle?: number;
  slots_processing?: number;
}): number | undefined {
  if (health.slots_idle === undefined && health.slots_processing === undefined) {
    return undefined;
  }
  return (health.slots_idle ?? 0) + (health.slots_processing ?? 0);
}

/**
 * Compat defaults for llama-server endpoints.
 * Applied automatically when a llama-server is detected.
 */
export const LLAMA_SERVER_COMPAT_DEFAULTS = {
  supportsDeveloperRole: false,
  supportsStrictMode: false,
  supportsUsageInStreaming: false,
  supportsStore: false,
  requiresStringContent: true,
  maxTokensField: "max_tokens" as const,
};
