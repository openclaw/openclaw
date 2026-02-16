import type { OAuthCredentials } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";

export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key?: string;
  email?: string;
  /** Optional provider-specific metadata (e.g., account IDs, gateway IDs). */
  metadata?: Record<string, string>;
};

export type TokenCredential = {
  /**
   * Static bearer-style token (often OAuth access token / PAT).
   * Not refreshable by OpenClaw (unlike `type: "oauth"`).
   */
  type: "token";
  provider: string;
  token: string;
  /** Optional expiry timestamp (ms since epoch). */
  expires?: number;
  email?: string;
};

export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: string;
  clientId?: string;
  email?: string;
};

export type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;

export type AuthProfileFailureReason =
  | "auth"
  | "format"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "unknown";

/** Per-model cooldown stats for rate-limit scoping */
export type ModelCooldownStats = {
  cooldownUntil?: number;
  errorCount?: number;
  lastFailureAt?: number;
};

/**
 * Returns true if the given failure reason should be tracked per-model
 * rather than per-profile. Rate limits are model-scoped because providers
 * (Anthropic, Google, etc.) enforce separate quotas per model.
 */
export function isModelScopedFailure(reason: AuthProfileFailureReason): boolean {
  return reason === "rate_limit";
}

/** Per-profile usage statistics for round-robin and cooldown tracking */
export type ProfileUsageStats = {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: AuthProfileFailureReason;
  errorCount?: number;
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastFailureAt?: number;
  /**
   * Per-model cooldown tracking. Rate-limit errors are scoped to the specific
   * model that was rate-limited, allowing other models on the same provider/profile
   * to remain available. Account-level failures (billing, auth) still apply profile-wide.
   */
  modelCooldowns?: Record<string, ModelCooldownStats>;
};

export type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  /**
   * Optional per-agent preferred profile order overrides.
   * This lets you lock/override auth rotation for a specific agent without
   * changing the global config.
   */
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  /** Usage statistics per profile for round-robin rotation */
  usageStats?: Record<string, ProfileUsageStats>;
};

export type AuthProfileIdRepairResult = {
  config: OpenClawConfig;
  changes: string[];
  migrated: boolean;
  fromProfileId?: string;
  toProfileId?: string;
};
