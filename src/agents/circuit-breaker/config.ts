import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentConfig } from "../agent-scope.js";
import type { CircuitBreakerConfig } from "./types.js";

/**
 * Resolve circuit breaker config for an agent, merging defaults with per-agent overrides.
 */
export function resolveCircuitBreakerConfig(
  cfg: OpenClawConfig,
  agentId?: string,
): CircuitBreakerConfig | undefined {
  const defaults = cfg.agents?.defaults?.circuitBreaker;
  const overrides = agentId ? resolveAgentConfig(cfg, agentId)?.circuitBreaker : undefined;
  if (!defaults && !overrides) {
    return undefined;
  }
  return { ...defaults, ...overrides };
}
