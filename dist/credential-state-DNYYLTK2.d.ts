import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { c as OAuthCredential, o as AuthProfileIdRepairResult, s as AuthProfileStore } from "./types-Biu67nNB.js";

//#region src/agents/auth-profiles/constants.d.ts
/** @deprecated Anthropic provider-owned CLI profile id; do not use from third-party plugins. */
declare const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
/** @deprecated OpenAI Codex provider-owned CLI profile id; do not use from third-party plugins. */
declare const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
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
//#region src/agents/auth-profiles/credential-state.d.ts
type AuthCredentialReasonCode = "ok" | "missing_credential" | "invalid_expires" | "expired" | "unresolved_ref";
declare const DEFAULT_OAUTH_REFRESH_MARGIN_MS: number;
type TokenExpiryState = "missing" | "valid" | "expiring" | "expired" | "invalid_expires";
declare function hasUsableOAuthCredential(credential: OAuthCredential | undefined, opts?: {
  now?: number;
  refreshMarginMs?: number;
}): boolean;
//#endregion
export { repairOAuthProfileIdMismatch as a, CODEX_CLI_PROFILE_ID as c, hasUsableOAuthCredential as i, DEFAULT_OAUTH_REFRESH_MARGIN_MS as n, suggestOAuthProfileIdForLegacyDefault as o, TokenExpiryState as r, CLAUDE_CLI_PROFILE_ID as s, AuthCredentialReasonCode as t };