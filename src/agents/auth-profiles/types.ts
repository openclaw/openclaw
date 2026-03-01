import type { OAuthCredentials } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { SecretRef } from "../../config/types.secrets.js";

export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key?: string;
  keyRef?: SecretRef;
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
  tokenRef?: SecretRef;
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
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "unknown";

/** Per-profile usage statistics for round-robin and cooldown tracking */
export type ProfileUsageStats = {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: AuthProfileFailureReason;
  errorCount?: number;
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastFailureAt?: number;
};

/**
 * Cooldown entry for providers that don't use discrete auth profiles
 * (e.g., aws-sdk authentication for Bedrock). Keyed by `provider:model`.
 */
export type ProviderCooldownEntry = {
  cooldownUntil?: number;
  errorCount?: number;
  lastFailureAt?: number;
  reason?: AuthProfileFailureReason;
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
  /**
   * Provider-level cooldown for auth modes without discrete profiles (e.g.,
   * aws-sdk). Keyed by `normalizedProvider:model`. This allows the outer
   * fallback loop to skip rate-limited providers even when no auth profile
   * IDs exist for cooldown tracking.
   */
  providerCooldown?: Record<string, ProviderCooldownEntry>;
};

export type AuthProfileIdRepairResult = {
  config: OpenClawConfig;
  changes: string[];
  migrated: boolean;
  fromProfileId?: string;
  toProfileId?: string;
};
