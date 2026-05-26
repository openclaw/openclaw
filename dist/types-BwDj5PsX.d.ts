import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { p as SecretRef } from "./types.secrets-tbFW-hY6.js";

//#region src/agents/auth-profiles/types.d.ts
type OAuthProvider = string;
type OAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  provider?: OAuthProvider;
  email?: string;
  enterpriseUrl?: string;
  projectId?: string;
  accountId?: string;
  chatgptPlanType?: string;
  idToken?: string;
};
type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key?: string;
  keyRef?: SecretRef; /** Explicit opt-out for copying this profile when creating another agent. */
  copyToAgents?: boolean;
  email?: string;
  displayName?: string; /** Optional provider-specific metadata (e.g., account IDs, gateway IDs). */
  metadata?: Record<string, string>;
};
type TokenCredential = {
  /**
   * Static bearer-style token (often OAuth access token / PAT).
   * Not refreshable by OpenClaw (unlike `type: "oauth"`).
   */
  type: "token";
  provider: string;
  token?: string;
  tokenRef?: SecretRef; /** Explicit opt-out for copying this profile when creating another agent. */
  copyToAgents?: boolean; /** Optional expiry timestamp (ms since epoch). */
  expires?: number;
  email?: string;
  displayName?: string;
};
type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: string;
  clientId?: string;
  /**
   * OAuth refresh tokens are not portable by default. Provider-owned flows may
   * set this only when copying refresh material across agents is known safe.
   */
  copyToAgents?: boolean;
  email?: string;
  displayName?: string;
};
type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;
type AuthProfileFailureReason = "auth" | "auth_permanent" | "format" | "overloaded" | "rate_limit" | "billing" | "timeout" | "model_not_found" | "session_expired" | "empty_response" | "no_error_details" | "unclassified" | "unknown";
type AuthProfileBlockedReason = "subscription_limit";
type AuthProfileBlockedSource = "codex_rate_limits" | "wham";
/** Per-profile usage statistics for round-robin and cooldown tracking */
type ProfileUsageStats = {
  lastUsed?: number;
  blockedUntil?: number;
  blockedReason?: AuthProfileBlockedReason;
  blockedSource?: AuthProfileBlockedSource;
  blockedModel?: string;
  cooldownUntil?: number;
  cooldownReason?: AuthProfileFailureReason;
  cooldownModel?: string;
  disabledUntil?: number;
  disabledReason?: AuthProfileFailureReason;
  errorCount?: number;
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastFailureAt?: number;
};
type AuthProfileState = {
  /**
   * Optional per-agent preferred profile order overrides.
   * This lets you lock/override auth rotation for a specific agent without
   * changing the global config.
   */
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>; /** Usage statistics per profile for round-robin rotation */
  usageStats?: Record<string, ProfileUsageStats>;
};
type AuthProfileSecretsStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
};
type AuthProfileStore = AuthProfileSecretsStore & AuthProfileState;
type AuthProfileIdRepairResult = {
  config: OpenClawConfig;
  changes: string[];
  migrated: boolean;
  fromProfileId?: string;
  toProfileId?: string;
};
//#endregion
export { AuthProfileFailureReason as a, OAuthCredential as c, TokenCredential as d, AuthProfileCredential as i, OAuthProvider as l, AuthProfileBlockedReason as n, AuthProfileIdRepairResult as o, AuthProfileBlockedSource as r, AuthProfileStore as s, ApiKeyCredential as t, ProfileUsageStats as u };