import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { c as OAuthCredential, o as AuthProfileIdRepairResult, s as AuthProfileStore } from "./types-BwDj5PsX.js";

//#region src/agents/auth-profiles/constants.d.ts
/** @deprecated Anthropic provider-owned CLI profile id; do not use from third-party plugins. */
declare const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
/** @deprecated OpenAI Codex provider-owned CLI profile id; do not use from third-party plugins. */
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