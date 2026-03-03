/**
 * OpenMork Adapter (Skeleton)
 *
 * Optional local-first runtime adapter for OpenClaw.
 * Disabled by default — requires explicit opt-in.
 *
 * @see docs/integrations/openmork.md
 */

export interface OpenMorkConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  retryAttempts?: number;
  fallback?: {
    provider: string;
    model: string;
  };
}

export interface OpenMorkAdapter {
  /** Check if OpenMork is available */
  isReady(): Promise<boolean>;

  /** Generate completion */
  complete(_prompt: string, _options: CompletionOptions): Promise<CompletionResult>;

  /** Stream completion */
  streamComplete(_prompt: string, _options: CompletionOptions): AsyncIterable<StreamChunk>;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface StreamChunk {
  text: string;
  finishReason?: string;
}

/**
 * Create OpenMork adapter instance.
 * Returns null if not enabled or misconfigured.
 */
export async function createOpenMorkAdapter(
  config: OpenMorkConfig,
): Promise<OpenMorkAdapter | null> {
  if (!config.enabled) {
    return null;
  }

  if (!config.baseUrl) {
    console.warn("[openmork] adapter disabled: baseUrl missing");
    return null;
  }

  // TODO: Implement actual adapter
  // This skeleton is provided as a reference for community contributions

  console.warn("[openmork] adapter skeleton loaded — implementation pending");

  return {
    async isReady(): Promise<boolean> {
      try {
        const response = await fetch(`${config.baseUrl}/health`, {
          method: "GET",
          headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
          signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },

    async complete(_prompt: string, _options: CompletionOptions): Promise<CompletionResult> {
      // TODO: Implement actual completion
      throw new Error("[openmork] complete() not implemented — adapter is skeleton only");
    },

    async *streamComplete(
      _prompt: string,
      _options: CompletionOptions,
    ): AsyncIterable<StreamChunk> {
      // TODO: Implement actual streaming
      // eslint-disable-next-line no-unreachable
      yield { text: "", finishReason: "not_implemented" };
      throw new Error("[openmork] streamComplete() not implemented — adapter is skeleton only");
    },
  };
}

/**
 * Feature flag for OpenMork integration.
 * Set to true to enable the adapter.
 */
export const OPENMORK_FEATURE_FLAG = false;

/**
 * Check if OpenMork integration is enabled.
 */
export function isOpenMorkEnabled(config?: Partial<OpenMorkConfig>): boolean {
  return OPENMORK_FEATURE_FLAG && (config?.enabled ?? false);
}
