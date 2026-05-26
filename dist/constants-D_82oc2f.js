import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
//#region src/agents/auth-profiles/constants.ts
/** @deprecated Anthropic provider-owned CLI profile id; do not use from third-party plugins. */
const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
/** @deprecated OpenAI Codex provider-owned CLI profile id; do not use from third-party plugins. */
const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
/** @deprecated MiniMax provider-owned CLI profile id; do not use from third-party plugins. */
const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";
const AUTH_STORE_LOCK_OPTIONS = {
	retries: {
		retries: 10,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 1e4,
		randomize: true
	},
	stale: 3e4
};
const OAUTH_REFRESH_LOCK_OPTIONS = {
	retries: {
		retries: 20,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 1e4,
		randomize: true
	},
	stale: 18e4
};
const OAUTH_REFRESH_CALL_TIMEOUT_MS = 12e4;
const EXTERNAL_CLI_SYNC_TTL_MS = 900 * 1e3;
const log = createSubsystemLogger("agents/auth-profiles");
//#endregion
export { MINIMAX_CLI_PROFILE_ID as a, OPENAI_CODEX_DEFAULT_PROFILE_ID as c, EXTERNAL_CLI_SYNC_TTL_MS as i, log as l, CLAUDE_CLI_PROFILE_ID as n, OAUTH_REFRESH_CALL_TIMEOUT_MS as o, CODEX_CLI_PROFILE_ID as r, OAUTH_REFRESH_LOCK_OPTIONS as s, AUTH_STORE_LOCK_OPTIONS as t };
