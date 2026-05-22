import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { a as AuthProfileStore, i as AuthProfileIdRepairResult, o as OAuthCredential } from "./types-DNLAqYp7.js";

//#region src/agents/auth-profiles/constants.d.ts
declare const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
declare const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
//#endregion
//#region src/agents/auth-profiles/credential-state.d.ts
type AuthCredentialReasonCode = "ok" | "missing_credential" | "invalid_expires" | "expired" | "unresolved_ref";
declare const DEFAULT_OAUTH_REFRESH_MARGIN_MS: number;
type TokenExpiryState = "missing" | "valid" | "expiring" | "expired" | "invalid_expires";
declare function hasUsableOAuthCredential(credential: OAuthCredential | undefined, opts?: {
  now?: number;
  refreshMarginMs?: number;
}): boolean;
//#endregion
//#region src/agents/auth-profiles/repair.d.ts
declare function suggestOAuthProfileIdForLegacyDefault(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  legacyProfileId: string;
}): string | null;
declare function repairOAuthProfileIdMismatch(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  legacyProfileId?: string;
}): AuthProfileIdRepairResult;
//#endregion
export { TokenExpiryState as a, CODEX_CLI_PROFILE_ID as c, DEFAULT_OAUTH_REFRESH_MARGIN_MS as i, suggestOAuthProfileIdForLegacyDefault as n, hasUsableOAuthCredential as o, AuthCredentialReasonCode as r, CLAUDE_CLI_PROFILE_ID as s, repairOAuthProfileIdMismatch as t };