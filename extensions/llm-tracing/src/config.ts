/**
 * Configuration for LLM content tracing.
 */
export type LlmTracingConfig = {
  /** Enable/disable tracing (default: false) */
  enabled?: boolean;
  /** OTLP endpoint URL (e.g., "https://api.honeycomb.io/v1/traces" or a self-hosted OTel collector) */
  endpoint?: string;
  /** HTTP headers for authentication (e.g., { "Authorization": "Basic xxx" }) */
  headers?: Record<string, string>;
  /** Service name for traces (default: "openclaw") */
  serviceName?: string;
  /** Sample rate 0-1 (default: 1.0) */
  sampleRate?: number;
};

export function normalizeEndpoint(endpoint?: string): string | undefined {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

export function resolveOtelTracesUrl(endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  // If endpoint already contains /v1/traces, use as-is
  if (endpoint.includes("/v1/traces")) {
    return endpoint;
  }
  // Otherwise append the path
  return `${endpoint}/v1/traces`;
}
