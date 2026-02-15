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

/** Per-profile usage statistics for round-robin and cooldown tracking */
export type ProfileUsageStats = {
  lastUsed?: number;
  /** Profile-level cooldown (for auth/billing/unknown errors) */
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: AuthProfileFailureReason;
  errorCount?: number;
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastFailureAt?: number;
  /** Per-model cooldown timestamps (model -> cooldownUntil). Used for rate_limit errors. */
  modelCooldowns?: Record<string, number>;
  /** Per-model error counts (model -> errorCount). Used for rate_limit backoff calculation. */
  modelErrorCounts?: Record<string, number>;
  /** Per-model last failure timestamps (model -> lastFailureAt). */
  modelLastFailureAt?: Record<string, number>;
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
