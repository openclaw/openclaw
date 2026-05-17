import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";

export const DEFAULT_IDENTITY_LINE = "You are a personal assistant running inside OpenClaw.";

export type IdentityMode = "default" | "none" | "custom";

/**
 * Resolve the identity line for the system prompt opening.
 * Returns the line to emit, or `null` to suppress it entirely.
 * Per-agent settings override defaults.
 */
export function resolveIdentityLine(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): string | null {
  const config = params.config;
  if (!config) {
    return DEFAULT_IDENTITY_LINE;
  }

  const agentCfg = params.agentId ? resolveAgentConfig(config, params.agentId) : undefined;

  const mode: IdentityMode =
    agentCfg?.identityMode ?? config.agents?.defaults?.identityMode ?? "default";

  if (mode === "none") {
    return null;
  }

  if (mode === "custom") {
    const line =
      trimNonEmpty(agentCfg?.identityLine) ?? trimNonEmpty(config.agents?.defaults?.identityLine);
    return line ?? DEFAULT_IDENTITY_LINE;
  }

  return DEFAULT_IDENTITY_LINE;
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
