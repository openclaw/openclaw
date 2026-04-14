/**
 * Type definitions for the discovery-verification plugin.
 *
 * The plugin is schema-agnostic: each manifest format (ADP, A2A Agent Card,
 * agent.json) gets its own resolver that produces a normalized
 * `DiscoveryResult` consumed by the `before_tool_call` hook.
 */

/** A single declared service inside an ADP discovery document. */
export interface AdpService {
  readonly name: string;
  readonly description?: string;
  readonly endpoint?: string;
  readonly auth?: string;
  readonly governance?: string;
  readonly free_tier?: boolean;
}

/** Normalized form of a fetched ADP discovery document. */
export interface AdpDiscoveryResult {
  readonly format: "adp";
  readonly domain: string;
  readonly version: string;
  readonly services: ReadonlyArray<AdpService>;
  readonly trust?: Readonly<Record<string, unknown>>;
  /** Raw payload, kept for downstream resolvers that want richer access. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * Discriminated union for any discovery format. The first commit only
 * handles ADP; future commits add `"a2a-agent-card"` and `"agent-json"`
 * variants behind the same `format` discriminator.
 */
export type DiscoveryResult = AdpDiscoveryResult;

export interface ResolverConfig {
  readonly cacheTtlSeconds: number;
  readonly requestTimeoutMs: number;
  readonly maxBodyBytes: number;
}

export const DEFAULT_RESOLVER_CONFIG: ResolverConfig = {
  cacheTtlSeconds: 3600,
  requestTimeoutMs: 5000,
  maxBodyBytes: 1024 * 1024,
};
