import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { n as resolveNormalizedAccountEntry } from "./account-lookup-CQEoGO1F.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./account-resolution-Dy8RKAMt.js";
import { randomUUID } from "node:crypto";
//#region extensions/twitch/src/token.ts
/**
* Twitch access token resolution with environment variable support.
*
* Supports reading Twitch OAuth access tokens from config or environment variable.
* The OPENCLAW_TWITCH_ACCESS_TOKEN env var is only used for the default account.
*
* Token resolution priority:
* 1. Account access token from merged config (accounts.{id} or base-level for default)
* 2. Environment variable: OPENCLAW_TWITCH_ACCESS_TOKEN (default account only)
*/
/**
* Normalize a Twitch OAuth token - ensure it has the oauth: prefix
*/
function normalizeTwitchToken(raw) {
	if (!raw) return;
	const trimmed = raw.trim();
	if (!trimmed) return;
	return trimmed.startsWith("oauth:") ? trimmed : `oauth:${trimmed}`;
}
/**
* Resolve Twitch access token from config or environment variable.
*
* Priority:
* 1. Account access token (from merged config - base-level for default, or accounts.{accountId})
* 2. Environment variable: OPENCLAW_TWITCH_ACCESS_TOKEN (default account only)
*
* The getAccountConfig function handles merging base-level config with accounts.default,
* so this logic works for both simplified and multi-account patterns.
*
* @param cfg - OpenClaw config
* @param opts - Options including accountId and optional envToken override
* @returns Token resolution with source
*/
function resolveTwitchToken(cfg, opts = {}) {
	const accountId = normalizeAccountId(opts.accountId);
	const twitchCfg = cfg?.channels?.twitch;
	const accounts = twitchCfg?.accounts;
	const accountCfg = resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId);
	let token;
	if (accountId === "default") token = normalizeTwitchToken((typeof twitchCfg?.accessToken === "string" ? twitchCfg.accessToken : void 0) || accountCfg?.accessToken);
	else token = normalizeTwitchToken(accountCfg?.accessToken);
	if (token) return {
		token,
		source: "config"
	};
	const envToken = accountId === "default" ? normalizeTwitchToken(opts.envToken ?? process.env.OPENCLAW_TWITCH_ACCESS_TOKEN) : void 0;
	if (envToken) return {
		token: envToken,
		source: "env"
	};
	return {
		token: "",
		source: "none"
	};
}
//#endregion
//#region extensions/twitch/src/utils/twitch.ts
/**
* Twitch-specific utility functions
*/
/**
* Normalize Twitch channel names.
*
* Removes the '#' prefix if present, converts to lowercase, and trims whitespace.
* Twitch channel names are case-insensitive and don't use the '#' prefix in the API.
*
* @param channel - The channel name to normalize
* @returns Normalized channel name
*
* @example
* normalizeTwitchChannel("#TwitchChannel") // "twitchchannel"
* normalizeTwitchChannel("MyChannel") // "mychannel"
*/
function normalizeTwitchChannel(channel) {
	const trimmed = normalizeLowercaseStringOrEmpty(channel);
	return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}
/**
* Create a standardized error message for missing target.
*
* @param provider - The provider name (e.g., "Twitch")
* @param hint - Optional hint for how to fix the issue
* @returns Error object with descriptive message
*/
function missingTargetError(provider, hint) {
	return /* @__PURE__ */ new Error(`Delivering to ${provider} requires target${hint ? ` ${hint}` : ""}`);
}
/**
* Generate a unique message ID for Twitch messages.
*
* Twurple's say() doesn't return the message ID, so we generate one
* for tracking purposes.
*
* @returns A unique message ID
*/
function generateMessageId() {
	return `${Date.now()}-${randomUUID()}`;
}
/**
* Normalize OAuth token by removing the "oauth:" prefix if present.
*
* Twurple doesn't require the "oauth:" prefix, so we strip it for consistency.
*
* @param token - The OAuth token to normalize
* @returns Normalized token without "oauth:" prefix
*
* @example
* normalizeToken("oauth:abc123") // "abc123"
* normalizeToken("abc123") // "abc123"
*/
function normalizeToken(token) {
	return token.startsWith("oauth:") ? token.slice(6) : token;
}
/**
* Check if an account is properly configured with required credentials.
*
* @param account - The Twitch account config to check
* @returns true if the account has required credentials
*/
function isAccountConfigured(account, resolvedToken) {
	const token = resolvedToken ?? account?.accessToken;
	return Boolean(account?.username && token && account?.clientId);
}
//#endregion
export { normalizeTwitchChannel as a, normalizeToken as i, isAccountConfigured as n, resolveTwitchToken as o, missingTargetError as r, generateMessageId as t };
