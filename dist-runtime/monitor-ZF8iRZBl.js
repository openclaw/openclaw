import { o as __toESM, r as __exportAll, t as __commonJSMin } from "./chunk-DORXReHP.js";
import { g as DEFAULT_ACCOUNT_ID$1, v as normalizeAccountId } from "./session-key-BSZsryCD.js";
import { $o as createReplyPrefixOptions, Tu as formatDocsLink, y as createPluginRuntimeStore } from "./auth-profiles-B70DPAVa.js";
import { randomUUID } from "node:crypto";
import { WebSocket as WebSocket$2 } from "ws";
import * as tls from "tls";
import { Socket } from "net";
//#region extensions/twitch/src/config.ts
/**
* Default account ID for Twitch
*/
const DEFAULT_ACCOUNT_ID = "default";
/**
* Get account config from core config
*
* Handles two patterns:
* 1. Simplified single-account: base-level properties create implicit "default" account
* 2. Multi-account: explicit accounts object
*
* For "default" account, base-level properties take precedence over accounts.default
* For other accounts, only the accounts object is checked
*/
function getAccountConfig(coreConfig, accountId) {
	if (!coreConfig || typeof coreConfig !== "object") return null;
	const twitchRaw = coreConfig.channels?.twitch;
	const accounts = twitchRaw?.accounts;
	if (accountId === "default") {
		const accountFromAccounts = accounts?.[DEFAULT_ACCOUNT_ID];
		const baseLevel = {
			username: typeof twitchRaw?.username === "string" ? twitchRaw.username : void 0,
			accessToken: typeof twitchRaw?.accessToken === "string" ? twitchRaw.accessToken : void 0,
			clientId: typeof twitchRaw?.clientId === "string" ? twitchRaw.clientId : void 0,
			channel: typeof twitchRaw?.channel === "string" ? twitchRaw.channel : void 0,
			enabled: typeof twitchRaw?.enabled === "boolean" ? twitchRaw.enabled : void 0,
			allowFrom: Array.isArray(twitchRaw?.allowFrom) ? twitchRaw.allowFrom : void 0,
			allowedRoles: Array.isArray(twitchRaw?.allowedRoles) ? twitchRaw.allowedRoles : void 0,
			requireMention: typeof twitchRaw?.requireMention === "boolean" ? twitchRaw.requireMention : void 0,
			clientSecret: typeof twitchRaw?.clientSecret === "string" ? twitchRaw.clientSecret : void 0,
			refreshToken: typeof twitchRaw?.refreshToken === "string" ? twitchRaw.refreshToken : void 0,
			expiresIn: typeof twitchRaw?.expiresIn === "number" ? twitchRaw.expiresIn : void 0,
			obtainmentTimestamp: typeof twitchRaw?.obtainmentTimestamp === "number" ? twitchRaw.obtainmentTimestamp : void 0
		};
		const merged = {
			...accountFromAccounts,
			...baseLevel
		};
		if (merged.username) return merged;
		if (accountFromAccounts) return accountFromAccounts;
		return null;
	}
	if (!accounts || !accounts[accountId]) return null;
	return accounts[accountId];
}
/**
* List all configured account IDs
*
* Includes both explicit accounts and implicit "default" from base-level config
*/
function listAccountIds(cfg) {
	const twitchRaw = cfg.channels?.twitch;
	const accountMap = twitchRaw?.accounts;
	const ids = [];
	if (accountMap) ids.push(...Object.keys(accountMap));
	if (twitchRaw && (typeof twitchRaw.username === "string" || typeof twitchRaw.accessToken === "string" || typeof twitchRaw.channel === "string") && !ids.includes("default")) ids.push(DEFAULT_ACCOUNT_ID);
	return ids;
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
	const trimmed = channel.trim().toLowerCase();
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
//#region extensions/twitch/src/setup-surface.ts
const channel = "twitch";
function setTwitchAccount(cfg, account) {
	const existing = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
	const merged = {
		username: account.username ?? existing?.username ?? "",
		accessToken: account.accessToken ?? existing?.accessToken ?? "",
		clientId: account.clientId ?? existing?.clientId ?? "",
		channel: account.channel ?? existing?.channel ?? "",
		enabled: account.enabled ?? existing?.enabled ?? true,
		allowFrom: account.allowFrom ?? existing?.allowFrom,
		allowedRoles: account.allowedRoles ?? existing?.allowedRoles,
		requireMention: account.requireMention ?? existing?.requireMention,
		clientSecret: account.clientSecret ?? existing?.clientSecret,
		refreshToken: account.refreshToken ?? existing?.refreshToken,
		expiresIn: account.expiresIn ?? existing?.expiresIn,
		obtainmentTimestamp: account.obtainmentTimestamp ?? existing?.obtainmentTimestamp
	};
	return {
		...cfg,
		channels: {
			...cfg.channels,
			twitch: {
				...cfg.channels?.twitch,
				enabled: true,
				accounts: {
					...(cfg.channels?.twitch)?.accounts,
					[DEFAULT_ACCOUNT_ID]: merged
				}
			}
		}
	};
}
async function noteTwitchSetupHelp(prompter) {
	await prompter.note([
		"Twitch requires a bot account with OAuth token.",
		"1. Create a Twitch application at https://dev.twitch.tv/console",
		"2. Generate a token with scopes: chat:read and chat:write",
		"   Use https://twitchtokengenerator.com/ or https://twitchapps.com/tmi/",
		"3. Copy the token (starts with 'oauth:') and Client ID",
		"Env vars supported: OPENCLAW_TWITCH_ACCESS_TOKEN",
		`Docs: ${formatDocsLink("/channels/twitch", "channels/twitch")}`
	].join("\n"), "Twitch setup");
}
async function promptToken(prompter, account, envToken) {
	const existingToken = account?.accessToken ?? "";
	if (existingToken && !envToken) {
		if (await prompter.confirm({
			message: "Access token already configured. Keep it?",
			initialValue: true
		})) return existingToken;
	}
	return String(await prompter.text({
		message: "Twitch OAuth token (oauth:...)",
		initialValue: envToken ?? "",
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) return "Required";
			if (!raw.startsWith("oauth:")) return "Token should start with 'oauth:'";
		}
	})).trim();
}
async function promptUsername(prompter, account) {
	return String(await prompter.text({
		message: "Twitch bot username",
		initialValue: account?.username ?? "",
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
}
async function promptClientId(prompter, account) {
	return String(await prompter.text({
		message: "Twitch Client ID",
		initialValue: account?.clientId ?? "",
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
}
async function promptChannelName(prompter, account) {
	return String(await prompter.text({
		message: "Channel to join",
		initialValue: account?.channel ?? "",
		validate: (value) => value?.trim() ? void 0 : "Required"
	})).trim();
}
async function promptRefreshTokenSetup(prompter, account) {
	if (!await prompter.confirm({
		message: "Enable automatic token refresh (requires client secret and refresh token)?",
		initialValue: Boolean(account?.clientSecret && account?.refreshToken)
	})) return {};
	return {
		clientSecret: String(await prompter.text({
			message: "Twitch Client Secret (for token refresh)",
			initialValue: account?.clientSecret ?? "",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim() || void 0,
		refreshToken: String(await prompter.text({
			message: "Twitch Refresh Token",
			initialValue: account?.refreshToken ?? "",
			validate: (value) => value?.trim() ? void 0 : "Required"
		})).trim() || void 0
	};
}
async function configureWithEnvToken(cfg, prompter, account, envToken, forceAllowFrom, dmPolicy) {
	if (!await prompter.confirm({
		message: "Twitch env var OPENCLAW_TWITCH_ACCESS_TOKEN detected. Use env token?",
		initialValue: true
	})) return null;
	const cfgWithAccount = setTwitchAccount(cfg, {
		username: await promptUsername(prompter, account),
		clientId: await promptClientId(prompter, account),
		accessToken: "",
		enabled: true
	});
	if (forceAllowFrom && dmPolicy.promptAllowFrom) return { cfg: await dmPolicy.promptAllowFrom({
		cfg: cfgWithAccount,
		prompter
	}) };
	return { cfg: cfgWithAccount };
}
function setTwitchAccessControl(cfg, allowedRoles, requireMention) {
	const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
	if (!account) return cfg;
	return setTwitchAccount(cfg, {
		...account,
		allowedRoles,
		requireMention
	});
}
function resolveTwitchGroupPolicy(cfg) {
	const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
	if (account?.allowedRoles?.includes("all")) return "open";
	if (account?.allowedRoles?.includes("moderator")) return "allowlist";
	return "disabled";
}
function setTwitchGroupPolicy(cfg, policy) {
	return setTwitchAccessControl(cfg, policy === "open" ? ["all"] : policy === "allowlist" ? ["moderator", "vip"] : [], true);
}
const twitchDmPolicy = {
	label: "Twitch",
	channel,
	policyKey: "channels.twitch.allowedRoles",
	allowFromKey: "channels.twitch.accounts.default.allowFrom",
	getCurrent: (cfg) => {
		const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
		if (account?.allowedRoles?.includes("all")) return "open";
		if (account?.allowFrom && account.allowFrom.length > 0) return "allowlist";
		return "disabled";
	},
	setPolicy: (cfg, policy) => {
		return setTwitchAccessControl(cfg, policy === "open" ? ["all"] : policy === "allowlist" ? [] : ["moderator"], true);
	},
	promptAllowFrom: async ({ cfg, prompter }) => {
		const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
		const existingAllowFrom = account?.allowFrom ?? [];
		const entry = await prompter.text({
			message: "Twitch allowFrom (user IDs, one per line, recommended for security)",
			placeholder: "123456789",
			initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0
		});
		const allowFrom = String(entry ?? "").split(/[\n,;]+/g).map((s) => s.trim()).filter(Boolean);
		return setTwitchAccount(cfg, {
			...account ?? void 0,
			allowFrom
		});
	}
};
const twitchGroupAccess = {
	label: "Twitch chat",
	placeholder: "",
	skipAllowlistEntries: true,
	currentPolicy: ({ cfg }) => resolveTwitchGroupPolicy(cfg),
	currentEntries: ({ cfg }) => {
		return getAccountConfig(cfg, "default")?.allowFrom ?? [];
	},
	updatePrompt: ({ cfg }) => {
		const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
		return Boolean(account?.allowedRoles?.length || account?.allowFrom?.length);
	},
	setPolicy: ({ cfg, policy }) => setTwitchGroupPolicy(cfg, policy),
	resolveAllowlist: async () => [],
	applyAllowlist: ({ cfg }) => cfg
};
const twitchSetupAdapter = {
	resolveAccountId: () => DEFAULT_ACCOUNT_ID,
	applyAccountConfig: ({ cfg }) => setTwitchAccount(cfg, { enabled: true })
};
const twitchSetupWizard = {
	channel,
	resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
	resolveShouldPromptAccountIds: () => false,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs username, token, and clientId",
		configuredHint: "configured",
		unconfiguredHint: "needs setup",
		resolveConfigured: ({ cfg }) => {
			const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
			return account ? isAccountConfigured(account) : false;
		},
		resolveStatusLines: ({ cfg }) => {
			const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
			return [`Twitch: ${(account ? isAccountConfigured(account) : false) ? "configured" : "needs username, token, and clientId"}`];
		}
	},
	credentials: [],
	finalize: async ({ cfg, prompter, forceAllowFrom }) => {
		const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
		if (!account || !isAccountConfigured(account)) await noteTwitchSetupHelp(prompter);
		const envToken = process.env.OPENCLAW_TWITCH_ACCESS_TOKEN?.trim();
		if (envToken && !account?.accessToken) {
			const envResult = await configureWithEnvToken(cfg, prompter, account, envToken, forceAllowFrom, twitchDmPolicy);
			if (envResult) return envResult;
		}
		const username = await promptUsername(prompter, account);
		const token = await promptToken(prompter, account, envToken);
		const clientId = await promptClientId(prompter, account);
		const channelName = await promptChannelName(prompter, account);
		const { clientSecret, refreshToken } = await promptRefreshTokenSetup(prompter, account);
		const cfgWithAccount = setTwitchAccount(cfg, {
			username,
			accessToken: token,
			clientId,
			channel: channelName,
			clientSecret,
			refreshToken,
			enabled: true
		});
		return { cfg: forceAllowFrom && twitchDmPolicy.promptAllowFrom ? await twitchDmPolicy.promptAllowFrom({
			cfg: cfgWithAccount,
			prompter
		}) : cfgWithAccount };
	},
	dmPolicy: twitchDmPolicy,
	groupAccess: twitchGroupAccess,
	disable: (cfg) => {
		const twitch = cfg.channels?.twitch;
		return {
			...cfg,
			channels: {
				...cfg.channels,
				twitch: {
					...twitch,
					enabled: false
				}
			}
		};
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/decorators/Enumerable.mjs
function Enumerable(enumerable) {
	if (enumerable === void 0) enumerable = true;
	return function(target, key) {
		Object.defineProperty(target, key, {
			get: function() {},
			set: function(val) {
				Object.defineProperty(this, key, {
					value: val,
					writable: true,
					enumerable
				});
			},
			enumerable
		});
	};
}
//#endregion
//#region node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs
/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
var extendStatics = function(d, b) {
	extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
		d.__proto__ = b;
	} || function(d, b) {
		for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p];
	};
	return extendStatics(d, b);
};
function __extends(d, b) {
	if (typeof b !== "function" && b !== null) throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
	extendStatics(d, b);
	function __() {
		this.constructor = d;
	}
	d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
}
function __decorate(decorators, target, key, desc) {
	var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
	if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
	else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
	return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function __awaiter(thisArg, _arguments, P, generator) {
	function adopt(value) {
		return value instanceof P ? value : new P(function(resolve) {
			resolve(value);
		});
	}
	return new (P || (P = Promise))(function(resolve, reject) {
		function fulfilled(value) {
			try {
				step(generator.next(value));
			} catch (e) {
				reject(e);
			}
		}
		function rejected(value) {
			try {
				step(generator["throw"](value));
			} catch (e) {
				reject(e);
			}
		}
		function step(result) {
			result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
		}
		step((generator = generator.apply(thisArg, _arguments || [])).next());
	});
}
function __generator(thisArg, body) {
	var _ = {
		label: 0,
		sent: function() {
			if (t[0] & 1) throw t[1];
			return t[1];
		},
		trys: [],
		ops: []
	}, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
	return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() {
		return this;
	}), g;
	function verb(n) {
		return function(v) {
			return step([n, v]);
		};
	}
	function step(op) {
		if (f) throw new TypeError("Generator is already executing.");
		while (g && (g = 0, op[0] && (_ = 0)), _) try {
			if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
			if (y = 0, t) op = [op[0] & 2, t.value];
			switch (op[0]) {
				case 0:
				case 1:
					t = op;
					break;
				case 4:
					_.label++;
					return {
						value: op[1],
						done: false
					};
				case 5:
					_.label++;
					y = op[1];
					op = [0];
					continue;
				case 7:
					op = _.ops.pop();
					_.trys.pop();
					continue;
				default:
					if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
						_ = 0;
						continue;
					}
					if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
						_.label = op[1];
						break;
					}
					if (op[0] === 6 && _.label < t[1]) {
						_.label = t[1];
						t = op;
						break;
					}
					if (t && _.label < t[2]) {
						_.label = t[2];
						_.ops.push(op);
						break;
					}
					if (t[2]) _.ops.pop();
					_.trys.pop();
					continue;
			}
			op = body.call(thisArg, _);
		} catch (e) {
			op = [6, e];
			y = 0;
		} finally {
			f = t = 0;
		}
		if (op[0] & 5) throw op[1];
		return {
			value: op[0] ? op[1] : void 0,
			done: true
		};
	}
}
function __read(o, n) {
	var m = typeof Symbol === "function" && o[Symbol.iterator];
	if (!m) return o;
	var i = m.call(o), r, ar = [], e;
	try {
		while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
	} catch (error) {
		e = { error };
	} finally {
		try {
			if (r && !r.done && (m = i["return"])) m.call(i);
		} finally {
			if (e) throw e.error;
		}
	}
	return ar;
}
function __spreadArray(to, from, pack) {
	if (pack || arguments.length === 2) {
		for (var i = 0, l = from.length, ar; i < l; i++) if (ar || !(i in from)) {
			if (!ar) ar = Array.prototype.slice.call(from, 0, i);
			ar[i] = from[i];
		}
	}
	return to.concat(ar || Array.prototype.slice.call(from));
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/functions/config/resolveConfigValue.mjs
function resolveConfigValue(value) {
	return __awaiter(this, void 0, Promise, function() {
		return __generator(this, function(_a) {
			switch (_a.label) {
				case 0:
					if (!(typeof value === "function")) return [3, 2];
					return [4, value()];
				case 1: return [2, _a.sent()];
				case 2: return [2, value];
			}
		});
	});
}
function resolveConfigValueSync(value) {
	if (typeof value === "function") return value();
	return value;
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/functions/math/fib.mjs
function fibWithLimit(limit) {
	var current, next;
	var _a;
	return __generator(this, function(_b) {
		switch (_b.label) {
			case 0:
				current = 0;
				next = 1;
				_b.label = 1;
			case 1:
				if (!(current < limit)) return [3, 3];
				return [4, current];
			case 2:
				_b.sent();
				_a = __read([next, current + next], 2), current = _a[0], next = _a[1];
				return [3, 1];
			case 3: return [4, limit];
			case 4:
				_b.sent();
				return [3, 3];
			case 5: return [2];
		}
	});
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/functions/object/arrayToObject.mjs
function arrayToObject(arr, fn) {
	return Object.assign.apply(Object, __spreadArray([{}], __read(arr.map(fn)), false));
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/functions/object/forEachObjectEntry.mjs
function forEachObjectEntry(obj, fn) {
	Object.entries(obj).forEach(function(_a) {
		var _b = __read(_a, 2), key = _b[0], value = _b[1];
		return fn(value, key);
	});
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/functions/optional/mapOptional.mjs
function isNullish(value) {
	return value == null;
}
function mapNullable(value, cb) {
	return isNullish(value) ? null : cb(value);
}
function mapOptional(value, cb) {
	return isNullish(value) ? void 0 : cb(value);
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/functions/promise/delay.mjs
function delay(ms) {
	return __awaiter(this, void 0, Promise, function() {
		return __generator(this, function(_a) {
			switch (_a.label) {
				case 0: return [4, new Promise(function(resolve) {
					return setTimeout(resolve, ms);
				})];
				case 1:
					_a.sent();
					return [2];
			}
		});
	});
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/functions/promise/withResolvers.mjs
function promiseWithResolvers() {
	var resolve;
	var reject;
	return {
		promise: new Promise(function(_resolve, _reject) {
			resolve = _resolve;
			reject = _reject;
		}),
		resolve,
		reject
	};
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/functions/string/padLeft.mjs
function padLeft(str, length, padding) {
	if (typeof str === "number") str = str.toString();
	length = length - str.length;
	if (length <= 0) return str;
	if (padding === void 0) padding = " ";
	var paddingStr = "";
	do {
		if ((length & 1) === 1) paddingStr += padding;
		length >>= 1;
		if (length) padding += padding;
	} while (length);
	return paddingStr + str;
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/functions/string/splitWithLimit.mjs
function splitWithLimit(str, delim, count) {
	var parts = str.split(delim);
	if (parts.length <= count) return parts;
	return __spreadArray(__spreadArray([], __read(parts.slice(0, count - 1)), false), [parts.slice(count - 1).join(delim)], false);
}
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/AccessToken.js
const EXPIRY_GRACE_PERIOD = 6e4;
function getExpiryMillis(token) {
	return mapNullable(token.expiresIn, (_) => token.obtainmentTimestamp + _ * 1e3 - EXPIRY_GRACE_PERIOD);
}
/**
* Calculates whether the given access token is expired.
*
* A one-minute grace period is applied for smooth handling of API latency.
*
* @param token The access token.
*/
function accessTokenIsExpired(token) {
	return mapNullable(getExpiryMillis(token), (_) => Date.now() > _) ?? false;
}
//#endregion
//#region node_modules/.pnpm/@twurple+common@8.0.3/node_modules/@twurple/common/lib/DataObject.js
/** @private */
const rawDataSymbol = Symbol("twurpleRawData");
/** @private */
var DataObject = class {
	/** @private */ [rawDataSymbol];
	/** @private */
	constructor(data) {
		this[rawDataSymbol] = data;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+common@8.0.3/node_modules/@twurple/common/lib/mockApiPort.js
/** @private */
function getMockApiPort() {
	try {
		return process.env.TWURPLE_MOCK_API_PORT ?? null;
	} catch {
		try {
			return import.meta.env.TWURPLE_MOCK_API_PORT ?? null;
		} catch {
			return null;
		}
	}
}
//#endregion
//#region node_modules/.pnpm/@twurple+common@8.0.3/node_modules/@twurple/common/lib/qs.js
function qsStringify(obj) {
	if (!obj) return "";
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(obj)) if (value === null) params.append(key, "");
	else if (Array.isArray(value)) for (const v of value) params.append(key, v.toString());
	else if (value !== void 0) params.append(key, value.toString());
	const result = params.toString();
	return result ? `?${result}` : "";
}
//#endregion
//#region node_modules/.pnpm/@twurple+common@8.0.3/node_modules/@twurple/common/lib/errors/CustomError.js
/** @private */
var CustomError$1 = class extends Error {
	constructor(message, options) {
		super(message, options);
		Object.setPrototypeOf(this, new.target.prototype);
		Error.captureStackTrace?.(this, new.target.constructor);
	}
	get name() {
		return this.constructor.name;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+common@8.0.3/node_modules/@twurple/common/lib/rtfm.js
/** @private */
function rtfm(pkg, name, idKey) {
	return (clazz) => {
		const fn = idKey ? function() {
			return `[${name}#${this[idKey]} - please check https://twurple.js.org/reference/${pkg}/classes/${name}.html for available properties]`;
		} : function() {
			return `[${name} - please check https://twurple.js.org/reference/${pkg}/classes/${name}.html for available properties]`;
		};
		Object.defineProperty(clazz.prototype, Symbol.for("nodejs.util.inspect.custom"), {
			value: fn,
			enumerable: false
		});
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+common@8.0.3/node_modules/@twurple/common/lib/errors/HellFreezesOverError.js
/**
* These are the kind of errors that should never happen.
*
* If you see one thrown, please file a bug in the GitHub issue tracker.
*/
var HellFreezesOverError = class extends CustomError$1 {
	constructor(message) {
		super(`${message} - this should never happen, please file a bug in the GitHub issue tracker`);
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+common@8.0.3/node_modules/@twurple/common/lib/userResolvers.js
/**
* Extracts the user ID from an argument that is possibly an object containing that ID.
*
* @param user The user ID or object.
*/
function extractUserId(user) {
	if (typeof user === "string") return user;
	if (typeof user === "number") return user.toString(10);
	return user.id;
}
/**
* Extracts the username from an argument that is possibly an object containing that name.
*
* @param user The username or object.
*/
function extractUserName(user) {
	return typeof user === "string" ? user : user.name;
}
//#endregion
//#region node_modules/.pnpm/@twurple+api-call@8.0.3/node_modules/@twurple/api-call/lib/errors/HttpStatusCodeError.js
/**
* Thrown whenever a HTTP error occurs. Some HTTP errors are handled in the library when they're expected.
*/
var HttpStatusCodeError = class extends CustomError$1 {
	_statusCode;
	_url;
	_method;
	_body;
	/** @private */
	constructor(_statusCode, statusText, _url, _method, _body, isJson) {
		super(`Encountered HTTP status code ${_statusCode}: ${statusText}\n\nURL: ${_url}\nMethod: ${_method}\nBody:\n${!isJson && _body.length > 150 ? `${_body.slice(0, 147)}...` : _body}`);
		this._statusCode = _statusCode;
		this._url = _url;
		this._method = _method;
		this._body = _body;
	}
	/**
	* The HTTP status code of the error.
	*/
	get statusCode() {
		return this._statusCode;
	}
	/**
	* The URL that was requested.
	*/
	get url() {
		return this._url;
	}
	/**
	* The HTTP method that was used for the request.
	*/
	get method() {
		return this._method;
	}
	/**
	* The body that was used for the request, as a string.
	*/
	get body() {
		return this._body;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+api-call@8.0.3/node_modules/@twurple/api-call/lib/helpers/transform.js
/** @private */
async function handleTwitchApiResponseError(response, options) {
	if (!response.ok) {
		const isJson = response.headers.get("Content-Type") === "application/json";
		const text = isJson ? JSON.stringify(await response.json(), null, 2) : await response.text();
		const params = qsStringify(options.query);
		const fullUrl = `${options.url}${params}`;
		throw new HttpStatusCodeError(response.status, response.statusText, fullUrl, options.method ?? "GET", text, isJson);
	}
}
/** @private */
async function transformTwitchApiResponse(response) {
	if (response.status === 204) return;
	const text = await response.text();
	if (!text) return;
	return JSON.parse(text);
}
//#endregion
//#region node_modules/.pnpm/@twurple+api-call@8.0.3/node_modules/@twurple/api-call/lib/helpers/url.js
/** @internal */
function getTwitchApiUrl(url, type) {
	const mockServerPort = getMockApiPort();
	switch (type) {
		case "helix": {
			const unprefixedUrl = url.replace(/^\//, "");
			return mockServerPort ? unprefixedUrl === "eventsub/subscriptions" ? `http://localhost:${mockServerPort}/${unprefixedUrl}` : `http://localhost:${mockServerPort}/mock/${unprefixedUrl}` : `https://api.twitch.tv/helix/${unprefixedUrl}`;
		}
		case "auth": {
			const unprefixedUrl = url.replace(/^\//, "");
			return mockServerPort ? `http://localhost:${mockServerPort}/auth/${unprefixedUrl}` : `https://id.twitch.tv/oauth2/${unprefixedUrl}`;
		}
		case "custom": return url;
		default: return url;
	}
}
//#endregion
//#region node_modules/.pnpm/@twurple+api-call@8.0.3/node_modules/@twurple/api-call/lib/apiCall.js
/**
* Makes a call to the Twitch API using the given credentials, returning the raw Response object.
*
* @param options The configuration of the call.
* @param clientId The client ID of your application.
* @param accessToken The access token to call the API with.
*
* You need to obtain one using one of the [Twitch OAuth flows](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/).
* @param authorizationType The type of Authorization header to send.
*
* Defaults to "Bearer" for Helix and "OAuth" for everything else.
* @param fetchOptions Additional options to be passed to the `fetch` function.
*/
async function callTwitchApiRaw(options, clientId, accessToken, authorizationType, fetchOptions = {}) {
	const type = options.type ?? "helix";
	const url = getTwitchApiUrl(options.url, type);
	const params = qsStringify(options.query);
	const headers = new Headers({ Accept: "application/json" });
	let body = void 0;
	if (options.jsonBody) {
		body = JSON.stringify(options.jsonBody);
		headers.append("Content-Type", "application/json");
	}
	if (clientId && type !== "auth") headers.append("Client-ID", clientId);
	if (accessToken) headers.append("Authorization", `${type === "helix" ? authorizationType ?? "Bearer" : "OAuth"} ${accessToken}`);
	const requestOptions = {
		...fetchOptions,
		method: options.method ?? "GET",
		headers,
		body
	};
	return await fetch(`${url}${params}`, requestOptions);
}
/**
* Makes a call to the Twitch API using given credentials.
*
* @param options The configuration of the call.
* @param clientId The client ID of your application.
* @param accessToken The access token to call the API with.
*
* You need to obtain one using one of the [Twitch OAuth flows](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/).
* @param authorizationType The type of Authorization header to send.
*
* Defaults to "Bearer" for Helix and "OAuth" for everything else.
* @param fetchOptions Additional options to be passed to the `fetch` function.
*/
async function callTwitchApi(options, clientId, accessToken, authorizationType, fetchOptions = {}) {
	const response = await callTwitchApiRaw(options, clientId, accessToken, authorizationType, fetchOptions);
	await handleTwitchApiResponseError(response, options);
	return await transformTwitchApiResponse(response);
}
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/errors/InvalidTokenError.js
/**
* Thrown whenever an invalid token is supplied.
*/
var InvalidTokenError = class extends CustomError$1 {
	/** @private */
	constructor(options) {
		super("Invalid token supplied", options);
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/errors/InvalidTokenTypeError.js
/**
* Thrown whenever a different token type (user vs. app) is expected in the method you're calling.
*/
var InvalidTokenTypeError = class extends CustomError$1 {};
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/helpers.external.js
/** @internal */
function createExchangeCodeQuery(clientId, clientSecret, code, redirectUri) {
	return {
		grant_type: "authorization_code",
		client_id: clientId,
		client_secret: clientSecret,
		code,
		redirect_uri: redirectUri
	};
}
/** @internal */
function createGetAppTokenQuery(clientId, clientSecret) {
	return {
		grant_type: "client_credentials",
		client_id: clientId,
		client_secret: clientSecret
	};
}
/** @internal */
function createRefreshTokenQuery(clientId, clientSecret, refreshToken) {
	return {
		grant_type: "refresh_token",
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: refreshToken
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/TokenInfo.js
/**
* Information about an access token.
*/
let TokenInfo = class TokenInfo extends DataObject {
	_obtainmentDate;
	/** @internal */
	constructor(data) {
		super(data);
		this._obtainmentDate = /* @__PURE__ */ new Date();
	}
	/**
	* The client ID.
	*/
	get clientId() {
		return this[rawDataSymbol].client_id;
	}
	/**
	* The ID of the authenticated user.
	*/
	get userId() {
		return this[rawDataSymbol].user_id ?? null;
	}
	/**
	* The name of the authenticated user.
	*/
	get userName() {
		return this[rawDataSymbol].login ?? null;
	}
	/**
	* The scopes for which the token is valid.
	*/
	get scopes() {
		return this[rawDataSymbol].scopes;
	}
	/**
	* The time when the token will expire.
	*
	* If this returns null, it means that the token never expires (happens with some old client IDs).
	*/
	get expiryDate() {
		return mapNullable(this[rawDataSymbol].expires_in, (v) => new Date(this._obtainmentDate.getTime() + v * 1e3));
	}
};
TokenInfo = __decorate([rtfm("auth", "TokenInfo", "clientId")], TokenInfo);
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/helpers.js
/** @internal */
function createAccessTokenFromData(data) {
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token || null,
		scope: data.scope ?? [],
		expiresIn: data.expires_in ?? null,
		obtainmentTimestamp: Date.now()
	};
}
/**
* Gets an access token with your client credentials and an authorization code.
*
* @param clientId The client ID of your application.
* @param clientSecret The client secret of your application.
* @param code The authorization code.
* @param redirectUri The redirect URI.
*
* This serves no real purpose here, but must still match one of the redirect URIs you configured in the Twitch Developer dashboard.
*/
async function exchangeCode(clientId, clientSecret, code, redirectUri) {
	return createAccessTokenFromData(await callTwitchApi({
		type: "auth",
		url: "token",
		method: "POST",
		query: createExchangeCodeQuery(clientId, clientSecret, code, redirectUri)
	}));
}
/**
* Gets an app access token with your client credentials.
*
* @param clientId The client ID of your application.
* @param clientSecret The client secret of your application.
*/
async function getAppToken(clientId, clientSecret) {
	return createAccessTokenFromData(await callTwitchApi({
		type: "auth",
		url: "token",
		method: "POST",
		query: createGetAppTokenQuery(clientId, clientSecret)
	}));
}
/**
* Refreshes an expired access token with your client credentials and the refresh token that was given by the initial authentication.
*
* @param clientId The client ID of your application.
* @param clientSecret The client secret of your application.
* @param refreshToken The refresh token.
*/
async function refreshUserToken(clientId, clientSecret, refreshToken) {
	return createAccessTokenFromData(await callTwitchApi({
		type: "auth",
		url: "token",
		method: "POST",
		query: createRefreshTokenQuery(clientId, clientSecret, refreshToken)
	}));
}
/**
* Gets information about an access token.
*
* @param accessToken The access token to get the information of.
* @param clientId The client ID of your application.
*
* You need to obtain one using one of the [Twitch OAuth flows](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/).
*/
async function getTokenInfo(accessToken, clientId) {
	try {
		return new TokenInfo(await callTwitchApi({
			type: "auth",
			url: "validate"
		}, clientId, accessToken));
	} catch (e) {
		if (e instanceof HttpStatusCodeError && e.statusCode === 401) throw new InvalidTokenError({ cause: e });
		throw e;
	}
}
const scopeEquivalencies = new Map([
	["channel_commercial", ["channel:edit:commercial"]],
	["channel_editor", ["channel:manage:broadcast"]],
	["channel_read", ["channel:read:stream_key"]],
	["channel_subscriptions", ["channel:read:subscriptions"]],
	["user_blocks_read", ["user:read:blocked_users"]],
	["user_blocks_edit", ["user:manage:blocked_users"]],
	["user_follows_edit", ["user:edit:follows"]],
	["user_read", ["user:read:email"]],
	["user_subscriptions", ["user:read:subscriptions"]],
	["user:edit:broadcast", ["channel:manage:broadcast", "channel:manage:extensions"]]
]);
/**
* Compares scopes for a non-upgradable {@link AuthProvider} instance.
*
* @param scopesToCompare The scopes to compare against.
* @param requestedScopes The scopes you requested.
*/
function compareScopes(scopesToCompare, requestedScopes) {
	if (requestedScopes?.length) {
		const scopes = new Set(scopesToCompare.flatMap((scope) => [scope, ...scopeEquivalencies.get(scope) ?? []]));
		if (requestedScopes.every((scope) => !scopes.has(scope))) {
			const scopesStr = requestedScopes.join(", ");
			throw new Error(`This token does not have any of the requested scopes (${scopesStr}) and can not be upgraded.
If you need dynamically upgrading scopes, please implement the AuthProvider interface accordingly:

\thttps://twurple.js.org/reference/auth/interfaces/AuthProvider.html`);
		}
	}
}
/**
* Compares scope sets for a non-upgradable {@link AuthProvider} instance.
*
* @param scopesToCompare The scopes to compare against.
* @param requestedScopeSets The scope sets you requested.
*/
function compareScopeSets(scopesToCompare, requestedScopeSets) {
	for (const requestedScopes of requestedScopeSets) compareScopes(scopesToCompare, requestedScopes);
}
/**
* Compares scopes for a non-upgradable `AuthProvider` instance, loading them from the token if necessary,
* and returns them together with the user ID.
*
* @param clientId The client ID of your application.
* @param token The access token.
* @param userId The user ID that was already loaded.
* @param loadedScopes The scopes that were already loaded.
* @param requestedScopeSets The scope sets you requested.
*/
async function loadAndCompareTokenInfo(clientId, token, userId, loadedScopes, requestedScopeSets) {
	if (requestedScopeSets?.length || !userId) {
		const userInfo = await getTokenInfo(token, clientId);
		if (!userInfo.userId) throw new Error("Trying to use an app access token as a user access token");
		const scopesToCompare = loadedScopes ?? userInfo.scopes;
		if (requestedScopeSets) compareScopeSets(scopesToCompare, requestedScopeSets.filter((val) => Boolean(val)));
		return [scopesToCompare, userInfo.userId];
	}
	return [loadedScopes, userId];
}
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/TokenFetcher.js
var TokenFetcher = class {
	_executor;
	_newTokenScopeSets = [];
	_newTokenPromise = null;
	_queuedScopeSets = [];
	_queueExecutor = null;
	_queuePromise = null;
	constructor(executor) {
		this._executor = executor;
	}
	async fetch(...scopeSets) {
		const filteredScopeSets = scopeSets.filter((val) => Boolean(val));
		if (this._newTokenPromise) {
			if (!filteredScopeSets.length) return await this._newTokenPromise;
			if (this._queueExecutor) this._queuedScopeSets.push(...filteredScopeSets);
			else this._queuedScopeSets = [...filteredScopeSets];
			if (!this._queuePromise) {
				const { promise, resolve, reject } = promiseWithResolvers();
				this._queuePromise = promise;
				this._queueExecutor = async () => {
					if (!this._queuePromise) return;
					this._newTokenScopeSets = this._queuedScopeSets;
					this._queuedScopeSets = [];
					this._newTokenPromise = this._queuePromise;
					this._queuePromise = null;
					this._queueExecutor = null;
					try {
						resolve(await this._executor(this._newTokenScopeSets));
					} catch (e) {
						reject(e);
					} finally {
						this._newTokenPromise = null;
						this._newTokenScopeSets = [];
						this._queueExecutor?.();
					}
				};
			}
			return await this._queuePromise;
		}
		this._newTokenScopeSets = [...filteredScopeSets];
		const { promise, resolve, reject } = promiseWithResolvers();
		this._newTokenPromise = promise;
		try {
			resolve(await this._executor(this._newTokenScopeSets));
		} catch (e) {
			reject(e);
		} finally {
			this._newTokenPromise = null;
			this._newTokenScopeSets = [];
			this._queueExecutor?.();
		}
		return await promise;
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+typed-event-emitter@3.3.3/node_modules/@d-fischer/typed-event-emitter/es/Listener.mjs
var Listener = class {
	/** @private */
	constructor(owner, event, listener, _internal = false) {
		this.owner = owner;
		this.event = event;
		this.listener = listener;
		this._internal = _internal;
	}
	unbind() {
		this.owner.removeListener(this);
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+typed-event-emitter@3.3.3/node_modules/@d-fischer/typed-event-emitter/es/EventEmitter.mjs
var EventEmitter = class {
	constructor() {
		this._eventListeners = /* @__PURE__ */ new Map();
		this._internalEventListeners = /* @__PURE__ */ new Map();
	}
	on(event, listener) {
		return this._addListener(false, event, listener);
	}
	addListener(event, listener) {
		return this._addListener(false, event, listener);
	}
	removeListener(idOrEvent, listener) {
		this._removeListener(false, idOrEvent, listener);
	}
	registerEvent() {
		const eventBinder = (handler) => this.addListener(eventBinder, handler);
		return eventBinder;
	}
	emit(event, ...args) {
		if (this._eventListeners.has(event)) for (const listener of this._eventListeners.get(event)) listener(...args);
		if (this._internalEventListeners.has(event)) for (const listener of this._internalEventListeners.get(event)) listener(...args);
	}
	registerInternalEvent() {
		const eventBinder = (handler) => this.addInternalListener(eventBinder, handler);
		return eventBinder;
	}
	addInternalListener(event, listener) {
		return this._addListener(true, event, listener);
	}
	removeInternalListener(idOrEvent, listener) {
		this._removeListener(true, idOrEvent, listener);
	}
	_addListener(internal, event, listener) {
		const listenerMap = internal ? this._eventListeners : this._internalEventListeners;
		if (listenerMap.has(event)) listenerMap.get(event).push(listener);
		else listenerMap.set(event, [listener]);
		return new Listener(this, event, listener, internal);
	}
	_removeListener(internal, idOrEvent, listener) {
		const listenerMap = internal ? this._eventListeners : this._internalEventListeners;
		if (!idOrEvent) listenerMap.clear();
		else if (typeof idOrEvent === "object") {
			const id = idOrEvent;
			this._removeListener(id._internal, id.event, id.listener);
		} else {
			const event = idOrEvent;
			if (listenerMap.has(event)) if (listener) {
				const listeners = listenerMap.get(event);
				let idx = 0;
				while ((idx = listeners.indexOf(listener)) !== -1) listeners.splice(idx, 1);
			} else listenerMap.delete(event);
		}
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/errors/CachedRefreshFailureError.js
/**
* Thrown whenever you try to execute an action in the context of a user
* who is already known to have an invalid token saved in its {@link AuthProvider}.
*/
var CachedRefreshFailureError = class extends CustomError$1 {
	userId;
	constructor(userId) {
		super(`The user context for the user ${userId} has been disabled.
This happened because the access token became invalid (e.g. by expiry) and refreshing it failed (e.g. because the account's password was changed).

Use .addUser(), .addUserForToken() or .addUserForCode() for the same user context to re-enable the user with a new, valid token.`);
		this.userId = userId;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/errors/IntermediateUserRemovalError.js
/**
* Thrown whenever a user is removed from an {@link AuthProvider}
* and at the same time you try to execute an action in that user's context.
*/
var IntermediateUserRemovalError = class extends CustomError$1 {
	userId;
	constructor(userId) {
		super(`User ${userId} was removed while trying to fetch a token.

Make sure you're not executing any actions when you want to remove a user.`);
		this.userId = userId;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/errors/UnknownIntentError.js
/**
* Thrown when an intent is requested that was not recognized by the {@link AuthProvider}.
*/
var UnknownIntentError = class extends CustomError$1 {
	/**
	* The intent that was requested.
	*/
	intent;
	/** @private */
	constructor(intent) {
		super(`Unknown intent: ${intent}`);
		this.intent = intent;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/providers/RefreshingAuthProvider.js
/**
* An auth provider with the ability to make use of refresh tokens,
* automatically refreshing the access token whenever necessary.
*/
let RefreshingAuthProvider = class RefreshingAuthProvider extends EventEmitter {
	_clientId;
	/** @internal */ _clientSecret;
	_redirectUri;
	/** @internal */ _userAccessTokens = /* @__PURE__ */ new Map();
	/** @internal */ _userTokenFetchers = /* @__PURE__ */ new Map();
	_intentToUserId = /* @__PURE__ */ new Map();
	_userIdToIntents = /* @__PURE__ */ new Map();
	_cachedRefreshFailures = /* @__PURE__ */ new Set();
	/** @internal */ _appAccessToken;
	/** @internal */ _appTokenFetcher;
	_appImpliedScopes;
	/**
	* Fires when a user token is refreshed.
	*
	* @param userId The ID of the user whose token was successfully refreshed.
	* @param token The refreshed token data.
	*/
	onRefresh = this.registerEvent();
	/**
	* Fires when a user token fails to refresh.
	*
	* @param userId The ID of the user whose token wasn't successfully refreshed.
	*/
	onRefreshFailure = this.registerEvent();
	/**
	* Creates a new auth provider based on the given one that can automatically
	* refresh access tokens.
	*
	* @param refreshConfig The information necessary to automatically refresh an access token.
	*/
	constructor(refreshConfig) {
		super();
		this._clientId = refreshConfig.clientId;
		this._clientSecret = refreshConfig.clientSecret;
		this._redirectUri = refreshConfig.redirectUri;
		this._appImpliedScopes = refreshConfig.appImpliedScopes ?? [];
		this._appTokenFetcher = new TokenFetcher(async (scopes) => await this._fetchAppToken(scopes));
	}
	/**
	* Adds the given user with their corresponding token to the provider.
	*
	* @param user The user to add.
	* @param initialToken The token for the user.
	* @param intents The intents to add to the user.
	*
	* Any intents that were already set before will be overwritten to point to this user instead.
	*/
	addUser(user, initialToken, intents) {
		const userId = extractUserId(user);
		if (!initialToken.refreshToken) throw new Error(`Trying to add user ${userId} without refresh token`);
		this._cachedRefreshFailures.delete(userId);
		this._userAccessTokens.set(userId, {
			...initialToken,
			userId
		});
		if (!this._userTokenFetchers.has(userId)) this._userTokenFetchers.set(userId, new TokenFetcher(async (scopes) => await this._fetchUserToken(userId, scopes)));
		if (intents) this.addIntentsToUser(user, intents);
	}
	/**
	* Figures out the user associated to the given token and adds them to the provider.
	*
	* If you already know the ID of the user you're adding,
	* consider using {@link RefreshingAuthProvider#addUser} instead.
	*
	* @param initialToken The token for the user.
	* @param intents The intents to add to the user.
	*
	* Any intents that were already set before will be overwritten to point to the associated user instead.
	*/
	async addUserForToken(initialToken, intents) {
		let tokenWithInfo = null;
		if (initialToken.accessToken && !accessTokenIsExpired(initialToken)) try {
			tokenWithInfo = [initialToken, await getTokenInfo(initialToken.accessToken)];
		} catch (e) {
			if (!(e instanceof InvalidTokenError)) throw e;
		}
		if (!tokenWithInfo) {
			if (!initialToken.refreshToken) throw new InvalidTokenError();
			const refreshedToken = await refreshUserToken(this._clientId, this._clientSecret, initialToken.refreshToken);
			const tokenInfo = await getTokenInfo(refreshedToken.accessToken);
			this.emit(this.onRefresh, tokenInfo.userId, refreshedToken);
			tokenWithInfo = [refreshedToken, tokenInfo];
		}
		const [tokenToAdd, tokenInfo] = tokenWithInfo;
		if (!tokenInfo.userId) throw new InvalidTokenTypeError("Could not determine a user ID for your token; you might be trying to disguise an app token as a user token.");
		const token = tokenToAdd.scope ? tokenToAdd : {
			...tokenToAdd,
			scope: tokenInfo.scopes
		};
		this.addUser(tokenInfo.userId, token, intents);
		return tokenInfo.userId;
	}
	/**
	* Gets an OAuth token from the given authorization code and adds the user to the provider.
	*
	* An authorization code can be obtained using the
	* [OAuth Authorization Code flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow).
	*
	* @param code The authorization code.
	* @param intents The intents to add to the user.
	*
	* Any intents that were already set before will be overwritten to point to the associated user instead.
	*/
	async addUserForCode(code, intents) {
		if (!this._redirectUri) throw new Error("This method requires you to pass a `redirectUri` as a configuration property");
		const token = await exchangeCode(this._clientId, this._clientSecret, code, this._redirectUri);
		return await this.addUserForToken(token, intents);
	}
	/**
	* Checks whether a user was added to the provider.
	*
	* @param user The user to check.
	*/
	hasUser(user) {
		return this._userTokenFetchers.has(extractUserId(user));
	}
	/**
	* Removes a user from the provider.
	*
	* This also makes all intents this user was assigned to unusable.
	*
	* @param user The user to remove.
	*/
	removeUser(user) {
		const userId = extractUserId(user);
		if (this._userIdToIntents.has(userId)) {
			const intents = this._userIdToIntents.get(userId);
			for (const intent of intents) this._intentToUserId.delete(intent);
			this._userIdToIntents.delete(userId);
		}
		this._userAccessTokens.delete(userId);
		this._userTokenFetchers.delete(userId);
		this._cachedRefreshFailures.delete(userId);
	}
	/**
	* Adds intents to a user.
	*
	* Any intents that were already set before will be overwritten to point to this user instead.
	*
	* @param user The user to add intents to.
	* @param intents The intents to add to the user.
	*/
	addIntentsToUser(user, intents) {
		const userId = extractUserId(user);
		if (!this._userAccessTokens.has(userId)) throw new Error("Trying to add intents to a user that was not added to this provider");
		for (const intent of intents) {
			if (this._intentToUserId.has(intent)) this._userIdToIntents.get(this._intentToUserId.get(intent)).delete(intent);
			this._intentToUserId.set(intent, userId);
			if (this._userIdToIntents.has(userId)) this._userIdToIntents.get(userId).add(intent);
			else this._userIdToIntents.set(userId, new Set([intent]));
		}
	}
	/**
	* Gets all intents assigned to the given user.
	*
	* @param user The user to get intents of.
	*/
	getIntentsForUser(user) {
		const userId = extractUserId(user);
		return this._userIdToIntents.has(userId) ? Array.from(this._userIdToIntents.get(userId)) : [];
	}
	/**
	* Removes all given intents from any user who they might be assigned to.
	*
	* Intents that have not been assigned are silently ignored.
	*
	* @param intents The intents to remove.
	*/
	removeIntents(intents) {
		for (const intent of intents) if (this._intentToUserId.has(intent)) {
			const userId = this._intentToUserId.get(intent);
			this._userIdToIntents.get(userId)?.delete(intent);
			this._intentToUserId.delete(intent);
		}
	}
	/**
	* Requests that the provider fetches a new token from Twitch for the given user.
	*
	* @param user The user to refresh the token for.
	*/
	async refreshAccessTokenForUser(user) {
		const userId = extractUserId(user);
		if (this._cachedRefreshFailures.has(userId)) throw new CachedRefreshFailureError(userId);
		const previousTokenData = this._userAccessTokens.get(userId);
		if (!previousTokenData) throw new Error("Trying to refresh token for user that was not added to the provider");
		const tokenData = await this._refreshUserTokenWithCallback(userId, previousTokenData.refreshToken);
		this._checkIntermediateUserRemoval(userId);
		this._userAccessTokens.set(userId, {
			...tokenData,
			userId
		});
		this.emit(this.onRefresh, userId, tokenData);
		return {
			...tokenData,
			userId
		};
	}
	/**
	* Requests that the provider fetches a new token from Twitch for the given intent.
	*
	* @param intent The intent to refresh the token for.
	*/
	async refreshAccessTokenForIntent(intent) {
		if (!this._intentToUserId.has(intent)) throw new UnknownIntentError(intent);
		const userId = this._intentToUserId.get(intent);
		return await this.refreshAccessTokenForUser(userId);
	}
	/**
	* The client ID.
	*/
	get clientId() {
		return this._clientId;
	}
	/**
	* Gets the scopes that are currently available using the access token.
	*
	* @param user The user to get the current scopes for.
	*/
	getCurrentScopesForUser(user) {
		const token = this._userAccessTokens.get(extractUserId(user));
		if (!token) throw new Error("Trying to get scopes for user that was not added to the provider");
		return token.scope ?? [];
	}
	/**
	* Gets an access token for the given user.
	*
	* @param user The user to get an access token for.
	* @param scopeSets The requested scopes.
	*/
	async getAccessTokenForUser(user, ...scopeSets) {
		const userId = extractUserId(user);
		const fetcher = this._userTokenFetchers.get(userId);
		if (!fetcher) return null;
		if (this._cachedRefreshFailures.has(userId)) throw new CachedRefreshFailureError(userId);
		compareScopeSets(this.getCurrentScopesForUser(userId), scopeSets.filter(Boolean));
		return await fetcher.fetch(...scopeSets);
	}
	/**
	* Fetches a token for a user identified by the given intent.
	*
	* @param intent The intent to fetch a token for.
	* @param scopeSets The requested scopes.
	*/
	async getAccessTokenForIntent(intent, ...scopeSets) {
		if (!this._intentToUserId.has(intent)) return null;
		const userId = this._intentToUserId.get(intent);
		const newToken = await this.getAccessTokenForUser(userId, ...scopeSets);
		if (!newToken) throw new HellFreezesOverError(`Found intent ${intent} corresponding to user ID ${userId} but no token was found`);
		return {
			...newToken,
			userId
		};
	}
	/**
	* Fetches any token to use with a request that supports both user and app tokens,
	* i.e. public data relating to a user.
	*
	* @param user The user.
	*/
	async getAnyAccessToken(user) {
		if (user) {
			const userId = extractUserId(user);
			if (this._userAccessTokens.has(userId)) {
				const token = await this.getAccessTokenForUser(userId);
				if (!token) throw new HellFreezesOverError(`Token for user ID ${userId} exists but nothing was returned by getAccessTokenForUser`);
				return {
					...token,
					userId
				};
			}
		}
		return await this.getAppAccessToken();
	}
	/**
	* Fetches an app access token.
	*
	* @param forceNew Whether to always get a new token, even if the old one is still deemed valid internally.
	*/
	async getAppAccessToken(forceNew = false) {
		if (forceNew) this._appAccessToken = void 0;
		return await this._appTokenFetcher.fetch(...this._appImpliedScopes.map((scopes) => [scopes]));
	}
	_checkIntermediateUserRemoval(userId) {
		if (!this._userTokenFetchers.has(userId)) {
			this._cachedRefreshFailures.delete(userId);
			throw new IntermediateUserRemovalError(userId);
		}
	}
	async _fetchUserToken(userId, scopeSets) {
		const previousToken = this._userAccessTokens.get(userId);
		if (!previousToken) throw new Error("Trying to get token for user that was not added to the provider");
		if (previousToken.accessToken && !accessTokenIsExpired(previousToken)) try {
			if (previousToken.scope) {
				compareScopeSets(previousToken.scope, scopeSets);
				return previousToken;
			}
			const [scope = []] = await loadAndCompareTokenInfo(this._clientId, previousToken.accessToken, userId, previousToken.scope, scopeSets);
			const newToken = {
				...previousToken,
				scope
			};
			this._checkIntermediateUserRemoval(userId);
			this._userAccessTokens.set(userId, newToken);
			return newToken;
		} catch (e) {
			if (!(e instanceof InvalidTokenError)) throw e;
		}
		this._checkIntermediateUserRemoval(userId);
		const refreshedToken = await this.refreshAccessTokenForUser(userId);
		compareScopeSets(refreshedToken.scope, scopeSets);
		return refreshedToken;
	}
	async _refreshUserTokenWithCallback(userId, refreshToken) {
		try {
			return await refreshUserToken(this.clientId, this._clientSecret, refreshToken);
		} catch (e) {
			this._cachedRefreshFailures.add(userId);
			this.emit(this.onRefreshFailure, userId, e);
			throw e;
		}
	}
	async _fetchAppToken(scopeSets) {
		if (scopeSets.length > 0) for (const scopes of scopeSets) if (this._appImpliedScopes.length) {
			if (scopes.every((scope) => !this._appImpliedScopes.includes(scope))) throw new Error(`One of the scopes ${scopes.join(", ")} requested but only the scope ${this._appImpliedScopes.join(", ")} is implied`);
		} else throw new Error(`One of the scopes ${scopes.join(", ")} requested but the client credentials flow does not support scopes`);
		if (!this._appAccessToken || accessTokenIsExpired(this._appAccessToken)) return await this._refreshAppToken();
		return this._appAccessToken;
	}
	async _refreshAppToken() {
		return this._appAccessToken = await getAppToken(this._clientId, this._clientSecret);
	}
};
__decorate([Enumerable(false)], RefreshingAuthProvider.prototype, "_clientSecret", void 0);
__decorate([Enumerable(false)], RefreshingAuthProvider.prototype, "_userAccessTokens", void 0);
__decorate([Enumerable(false)], RefreshingAuthProvider.prototype, "_userTokenFetchers", void 0);
__decorate([Enumerable(false)], RefreshingAuthProvider.prototype, "_appAccessToken", void 0);
__decorate([Enumerable(false)], RefreshingAuthProvider.prototype, "_appTokenFetcher", void 0);
RefreshingAuthProvider = __decorate([rtfm("auth", "RefreshingAuthProvider", "clientId")], RefreshingAuthProvider);
//#endregion
//#region node_modules/.pnpm/@twurple+auth@8.0.3/node_modules/@twurple/auth/lib/providers/StaticAuthProvider.js
/**
* An auth provider that always returns the same initially given credentials.
*
* You are advised to roll your own auth provider that can handle scope upgrades,
* or to plan ahead and supply only access tokens that account for all scopes
* you will ever need.
*/
let StaticAuthProvider = class StaticAuthProvider {
	/** @internal */ _clientId;
	/** @internal */ _accessToken;
	_userId;
	_scopes;
	/**
	* Creates a new auth provider with static credentials.
	*
	* @param clientId The client ID of your application.
	* @param accessToken The access token to provide.
	*
	* You need to obtain one using one of the [Twitch OAuth flows](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/).
	* @param scopes The scopes the supplied token has.
	*
	* If this argument is given, the scopes need to be correct, or weird things might happen. If it's not (i.e. it's `undefined`), we fetch the correct scopes for you.
	*
	* If you can't exactly say which scopes your token has, don't use this parameter/set it to `undefined`.
	*/
	constructor(clientId, accessToken, scopes) {
		this._clientId = clientId || "";
		this._accessToken = typeof accessToken === "string" ? {
			accessToken,
			refreshToken: null,
			scope: scopes ?? [],
			expiresIn: null,
			obtainmentTimestamp: Date.now()
		} : accessToken;
		this._scopes = scopes;
	}
	/**
	* The client ID.
	*/
	get clientId() {
		return this._clientId;
	}
	/**
	* Gets the static access token.
	*
	* If the current access token does not have the requested scopes, this method throws.
	* This makes supplying an access token with the correct scopes from the beginning necessary.
	*
	* @param user Ignored.
	* @param scopeSets The requested scopes.
	*/
	async getAccessTokenForUser(user, ...scopeSets) {
		return await this._getAccessToken(scopeSets);
	}
	/**
	* Gets the static access token.
	*
	* If the current access token does not have the requested scopes, this method throws.
	* This makes supplying an access token with the correct scopes from the beginning necessary.
	*
	* @param intent Ignored.
	* @param scopeSets The requested scopes.
	*/
	async getAccessTokenForIntent(intent, ...scopeSets) {
		return await this._getAccessToken(scopeSets);
	}
	/**
	* Gets the static access token.
	*/
	async getAnyAccessToken() {
		return await this._getAccessToken();
	}
	/**
	* The scopes that are currently available using the access token.
	*/
	getCurrentScopesForUser() {
		return this._scopes ?? [];
	}
	async _getAccessToken(requestedScopeSets) {
		const [scopes, userId] = await loadAndCompareTokenInfo(this._clientId, this._accessToken.accessToken, this._userId, this._scopes, requestedScopeSets);
		this._scopes = scopes;
		this._userId = userId;
		return {
			...this._accessToken,
			userId
		};
	}
};
__decorate([Enumerable(false)], StaticAuthProvider.prototype, "_clientId", void 0);
__decorate([Enumerable(false)], StaticAuthProvider.prototype, "_accessToken", void 0);
StaticAuthProvider = __decorate([rtfm("auth", "StaticAuthProvider", "clientId")], StaticAuthProvider);
//#endregion
//#region node_modules/.pnpm/@d-fischer+detect-node@3.0.1/node_modules/@d-fischer/detect-node/index.js
var require_detect_node = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports.isNode = Object.prototype.toString.call(typeof process !== "undefined" ? process : 0) === "[object process]";
}));
//#endregion
//#region node_modules/.pnpm/@d-fischer+logger@4.2.4/node_modules/@d-fischer/logger/es/LogLevel.mjs
var import_detect_node = require_detect_node();
var _a$2;
var LogLevel;
(function(LogLevel) {
	LogLevel[LogLevel["CRITICAL"] = 0] = "CRITICAL";
	LogLevel[LogLevel["ERROR"] = 1] = "ERROR";
	LogLevel[LogLevel["WARNING"] = 2] = "WARNING";
	LogLevel[LogLevel["INFO"] = 3] = "INFO";
	LogLevel[LogLevel["DEBUG"] = 4] = "DEBUG";
	LogLevel[LogLevel["TRACE"] = 7] = "TRACE";
})(LogLevel || (LogLevel = {}));
function resolveLogLevel(level) {
	if (typeof level === "number") {
		if (Object.prototype.hasOwnProperty.call(LogLevel, level)) return level;
		var eligibleLevels = Object.keys(LogLevel).map(function(k) {
			return parseInt(k, 10);
		}).filter(function(k) {
			return !isNaN(k) && k < level;
		});
		if (!eligibleLevels.length) return LogLevel.WARNING;
		return Math.max.apply(Math, eligibleLevels);
	}
	var strLevel = level.replace(/\d+$/, "").toUpperCase();
	if (!Object.prototype.hasOwnProperty.call(LogLevel, strLevel)) throw new Error("Unknown log level string: ".concat(level));
	return LogLevel[strLevel];
}
var debugFunction = import_detect_node.isNode ? console.log.bind(console) : console.debug.bind(console);
var LogLevelToConsoleFunction = (_a$2 = {}, _a$2[LogLevel.CRITICAL] = console.error.bind(console), _a$2[LogLevel.ERROR] = console.error.bind(console), _a$2[LogLevel.WARNING] = console.warn.bind(console), _a$2[LogLevel.INFO] = console.info.bind(console), _a$2[LogLevel.DEBUG] = debugFunction.bind(console), _a$2[LogLevel.TRACE] = console.trace.bind(console), _a$2);
//#endregion
//#region node_modules/.pnpm/@d-fischer+logger@4.2.4/node_modules/@d-fischer/logger/es/getMinLogLevelFromEnv.mjs
var _a$1, _b$1;
var data = typeof process === "undefined" ? [] : (_b$1 = (_a$1 = process.env.LOGGING) === null || _a$1 === void 0 ? void 0 : _a$1.split(";").map(function(part) {
	var _a = part.split("=", 2), namespace = _a[0], strLevel = _a[1];
	if (strLevel) return [namespace === "default" ? void 0 : namespace.split(":"), resolveLogLevel(strLevel)];
	return null;
}).filter(function(v) {
	return !!v;
}).sort(function(_a, _b) {
	var _c, _d;
	var a = _a[0];
	var b = _b[0];
	return ((_c = b === null || b === void 0 ? void 0 : b.length) !== null && _c !== void 0 ? _c : 0) - ((_d = a === null || a === void 0 ? void 0 : a.length) !== null && _d !== void 0 ? _d : 0);
})) !== null && _b$1 !== void 0 ? _b$1 : [];
var defaultIndex = data.findIndex(function(_a) {
	return !_a[0];
});
var defaultLevel = void 0;
if (defaultIndex !== -1) {
	defaultLevel = data[defaultIndex][1];
	data.splice(defaultIndex);
}
function isPrefix(value, prefix) {
	return prefix.length <= value.length && prefix.every(function(item, i) {
		return item === value[i];
	});
}
function getMinLogLevelFromEnv(name) {
	var nameSplit = name.split(":");
	for (var _i = 0, data_1 = data; _i < data_1.length; _i++) {
		var _a = data_1[_i], nsParts = _a[0], level = _a[1];
		if (isPrefix(nameSplit, nsParts)) return level;
	}
	return defaultLevel;
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+logger@4.2.4/node_modules/@d-fischer/logger/es/BaseLogger.mjs
var BaseLogger = function() {
	function BaseLogger(_a) {
		var name = _a.name, minLevel = _a.minLevel, _b = _a.emoji, emoji = _b === void 0 ? false : _b, colors = _a.colors, _c = _a.timestamps, timestamps = _c === void 0 ? import_detect_node.isNode : _c;
		var _d, _e;
		this._name = name;
		this._minLevel = (_e = (_d = mapOptional(minLevel, function(lv) {
			return resolveLogLevel(lv);
		})) !== null && _d !== void 0 ? _d : getMinLogLevelFromEnv(name)) !== null && _e !== void 0 ? _e : LogLevel.WARNING;
		this._emoji = emoji;
		this._colors = colors;
		this._timestamps = timestamps;
	}
	BaseLogger.prototype.crit = function(message) {
		this.log(LogLevel.CRITICAL, message);
	};
	BaseLogger.prototype.error = function(message) {
		this.log(LogLevel.ERROR, message);
	};
	BaseLogger.prototype.warn = function(message) {
		this.log(LogLevel.WARNING, message);
	};
	BaseLogger.prototype.info = function(message) {
		this.log(LogLevel.INFO, message);
	};
	BaseLogger.prototype.debug = function(message) {
		this.log(LogLevel.DEBUG, message);
	};
	BaseLogger.prototype.trace = function(message) {
		this.log(LogLevel.TRACE, message);
	};
	return BaseLogger;
}();
//#endregion
//#region node_modules/.pnpm/@d-fischer+logger@4.2.4/node_modules/@d-fischer/logger/es/BrowserLogger.mjs
var BrowserLogger = function(_super) {
	__extends(BrowserLogger, _super);
	function BrowserLogger() {
		return _super !== null && _super.apply(this, arguments) || this;
	}
	BrowserLogger.prototype.log = function(level, message) {
		if (level > this._minLevel) return;
		var logFn = LogLevelToConsoleFunction[level];
		var formattedMessage = "[".concat(this._name, "] ").concat(message);
		if (this._timestamps) formattedMessage = "[".concat((/* @__PURE__ */ new Date()).toISOString(), "] ").concat(message);
		logFn(formattedMessage);
	};
	return BrowserLogger;
}(BaseLogger);
//#endregion
//#region node_modules/.pnpm/@d-fischer+logger@4.2.4/node_modules/@d-fischer/logger/es/CustomLoggerWrapper.mjs
var CustomLoggerWrapper = function() {
	function CustomLoggerWrapper(_a) {
		var name = _a.name, minLevel = _a.minLevel, custom = _a.custom;
		var _b;
		this._minLevel = (_b = mapOptional(minLevel, function(lv) {
			return resolveLogLevel(lv);
		})) !== null && _b !== void 0 ? _b : getMinLogLevelFromEnv(name);
		this._override = typeof custom === "function" ? { log: custom } : custom;
	}
	CustomLoggerWrapper.prototype.log = function(level, message) {
		if (this._shouldLog(level)) this._override.log(level, message);
	};
	CustomLoggerWrapper.prototype.crit = function(message) {
		if (!this._override.crit) this.log(LogLevel.CRITICAL, message);
		else if (this._shouldLog(LogLevel.CRITICAL)) this._override.crit(message);
	};
	CustomLoggerWrapper.prototype.error = function(message) {
		if (!this._override.error) this.log(LogLevel.ERROR, message);
		else if (this._shouldLog(LogLevel.ERROR)) this._override.error(message);
	};
	CustomLoggerWrapper.prototype.warn = function(message) {
		if (!this._override.warn) this.log(LogLevel.WARNING, message);
		else if (this._shouldLog(LogLevel.WARNING)) this._override.warn(message);
	};
	CustomLoggerWrapper.prototype.info = function(message) {
		if (!this._override.info) this.log(LogLevel.INFO, message);
		else if (this._shouldLog(LogLevel.INFO)) this._override.info(message);
	};
	CustomLoggerWrapper.prototype.debug = function(message) {
		if (!this._override.debug) this.log(LogLevel.DEBUG, message);
		else if (this._shouldLog(LogLevel.DEBUG)) this._override.debug(message);
	};
	CustomLoggerWrapper.prototype.trace = function(message) {
		if (!this._override.trace) this.log(LogLevel.TRACE, message);
		else if (this._shouldLog(LogLevel.TRACE)) this._override.trace(message);
	};
	CustomLoggerWrapper.prototype._shouldLog = function(level) {
		return this._minLevel === void 0 || this._minLevel >= level;
	};
	return CustomLoggerWrapper;
}();
//#endregion
//#region node_modules/.pnpm/@d-fischer+logger@4.2.4/node_modules/@d-fischer/logger/es/NodeLogger.mjs
var _a, _b, _c;
var LogLevelToEmoji = (_a = {}, _a[LogLevel.CRITICAL] = "🛑", _a[LogLevel.ERROR] = "❌", _a[LogLevel.WARNING] = "⚠️ ", _a[LogLevel.INFO] = "ℹ️ ", _a[LogLevel.DEBUG] = "🐞", _a[LogLevel.TRACE] = "🐾", _a);
var colors = {
	black: 30,
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
	magenta: 35,
	cyan: 36,
	white: 37,
	blackBright: 90,
	redBright: 91,
	greenBright: 92,
	yellowBright: 93,
	blueBright: 94,
	magentaBright: 95,
	cyanBright: 96,
	whiteBright: 97
};
var bgColors = {
	bgBlack: 40,
	bgRed: 41,
	bgGreen: 42,
	bgYellow: 43,
	bgBlue: 44,
	bgMagenta: 45,
	bgCyan: 46,
	bgWhite: 47,
	bgBlackBright: 100,
	bgRedBright: 101,
	bgGreenBright: 102,
	bgYellowBright: 103,
	bgBlueBright: 104,
	bgMagentaBright: 105,
	bgCyanBright: 106,
	bgWhiteBright: 107
};
function createGenericWrapper(color, ending, inner) {
	return function(str) {
		return "\x1B[".concat(color, "m").concat(inner ? inner(str) : str, "\x1B[").concat(ending, "m");
	};
}
function createColorWrapper(color) {
	return createGenericWrapper(colors[color], 39);
}
function createBgWrapper(color, fgWrapper) {
	return createGenericWrapper(bgColors[color], 49, fgWrapper);
}
var LogLevelToColor = (_b = {}, _b[LogLevel.CRITICAL] = createColorWrapper("red"), _b[LogLevel.ERROR] = createColorWrapper("redBright"), _b[LogLevel.WARNING] = createColorWrapper("yellow"), _b[LogLevel.INFO] = createColorWrapper("blue"), _b[LogLevel.DEBUG] = createColorWrapper("magenta"), _b[LogLevel.TRACE] = createGenericWrapper(0, 0), _b);
var LogLevelToBackgroundColor = (_c = {}, _c[LogLevel.CRITICAL] = createBgWrapper("bgRed", createColorWrapper("white")), _c[LogLevel.ERROR] = createBgWrapper("bgRedBright", createColorWrapper("white")), _c[LogLevel.WARNING] = createBgWrapper("bgYellow", createColorWrapper("black")), _c[LogLevel.INFO] = createBgWrapper("bgBlue", createColorWrapper("white")), _c[LogLevel.DEBUG] = createBgWrapper("bgMagenta", createColorWrapper("black")), _c[LogLevel.TRACE] = createGenericWrapper(7, 27), _c);
var NodeLogger = function(_super) {
	__extends(NodeLogger, _super);
	function NodeLogger() {
		return _super !== null && _super.apply(this, arguments) || this;
	}
	NodeLogger.prototype.log = function(level, message) {
		var _a, _b, _c;
		if (level > this._minLevel) return;
		var logFn = LogLevelToConsoleFunction[level];
		var builtMessage = "";
		if (this._timestamps) builtMessage += "[".concat((/* @__PURE__ */ new Date()).toISOString(), "] ");
		if (this._emoji) {
			var emoji = LogLevelToEmoji[level];
			builtMessage += "".concat(emoji, " ");
		}
		if ((_c = (_a = this._colors) !== null && _a !== void 0 ? _a : (_b = process.stdout) === null || _b === void 0 ? void 0 : _b.isTTY) !== null && _c !== void 0 ? _c : true) builtMessage += "".concat(LogLevelToBackgroundColor[level](this._name), " ").concat(LogLevelToBackgroundColor[level](LogLevel[level]), " ").concat(LogLevelToColor[level](message));
		else builtMessage += "[".concat(this._name, ":").concat(LogLevel[level].toLowerCase(), "] ").concat(message);
		logFn(builtMessage);
	};
	return NodeLogger;
}(BaseLogger);
//#endregion
//#region node_modules/.pnpm/@d-fischer+logger@4.2.4/node_modules/@d-fischer/logger/es/createLogger.mjs
function createLogger(options) {
	if (options.custom) return new CustomLoggerWrapper(options);
	if (import_detect_node.isNode) return new NodeLogger(options);
	return new BrowserLogger(options);
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+rate-limiter@1.1.0/node_modules/@d-fischer/rate-limiter/es/errors/CustomError.mjs
/** @private */
var CustomError = class extends Error {
	constructor(...params) {
		var _a;
		super(...params);
		Object.setPrototypeOf(this, new.target.prototype);
		(_a = Error.captureStackTrace) === null || _a === void 0 || _a.call(Error, this, new.target.constructor);
	}
	get name() {
		return this.constructor.name;
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+rate-limiter@1.1.0/node_modules/@d-fischer/rate-limiter/es/errors/RateLimiterDestroyedError.mjs
var RateLimiterDestroyedError = class extends CustomError {};
//#endregion
//#region node_modules/.pnpm/@d-fischer+rate-limiter@1.1.0/node_modules/@d-fischer/rate-limiter/es/errors/RateLimitReachedError.mjs
var RateLimitReachedError = class extends CustomError {};
//#endregion
//#region node_modules/.pnpm/@d-fischer+rate-limiter@1.1.0/node_modules/@d-fischer/rate-limiter/es/limiters/PartitionedTimeBasedRateLimiter.mjs
var PartitionedTimeBasedRateLimiter = class {
	constructor({ logger, bucketSize, timeFrame, doRequest, getPartitionKey }) {
		this._partitionedQueue = /* @__PURE__ */ new Map();
		this._usedFromBucket = /* @__PURE__ */ new Map();
		this._counterTimers = /* @__PURE__ */ new Set();
		this._paused = false;
		this._destroyed = false;
		this._logger = createLogger({
			name: "rate-limiter",
			emoji: true,
			...logger
		});
		this._bucketSize = bucketSize;
		this._timeFrame = timeFrame;
		this._callback = doRequest;
		this._partitionKeyCallback = getPartitionKey;
	}
	async request(req, options) {
		return await new Promise((resolve, reject) => {
			var _a, _b;
			if (this._destroyed) {
				reject(new RateLimiterDestroyedError("Rate limiter was destroyed"));
				return;
			}
			const reqSpec = {
				req,
				resolve,
				reject,
				limitReachedBehavior: (_a = options === null || options === void 0 ? void 0 : options.limitReachedBehavior) !== null && _a !== void 0 ? _a : "enqueue"
			};
			const partitionKey = this._partitionKeyCallback(req);
			const usedFromBucket = (_b = this._usedFromBucket.get(partitionKey)) !== null && _b !== void 0 ? _b : 0;
			if (usedFromBucket >= this._bucketSize || this._paused) switch (reqSpec.limitReachedBehavior) {
				case "enqueue": {
					const queue = this._getPartitionedQueue(partitionKey);
					queue.push(reqSpec);
					if (usedFromBucket + queue.length >= this._bucketSize) this._logger.warn(`Rate limit of ${this._bucketSize} for ${partitionKey ? `partition ${partitionKey}` : "default partition"} was reached, waiting for ${this._paused ? "the limiter to be unpaused" : "a free bucket entry"}; queue size is ${queue.length}`);
					else this._logger.info(`Enqueueing request for ${partitionKey ? `partition ${partitionKey}` : "default partition"} because the rate limiter is paused; queue size is ${queue.length}`);
					break;
				}
				case "null":
					reqSpec.resolve(null);
					if (this._paused) this._logger.info(`Returning null for request for ${partitionKey ? `partition ${partitionKey}` : "default partition"} because the rate limiter is paused`);
					else this._logger.warn(`Rate limit of ${this._bucketSize} for ${partitionKey ? `partition ${partitionKey}` : "default partition"} was reached, dropping request and returning null`);
					break;
				case "throw":
					reqSpec.reject(new RateLimitReachedError(`Request dropped because ${this._paused ? "the rate limiter is paused" : `the rate limit for ${partitionKey ? `partition ${partitionKey}` : "default partition"} was reached`}`));
					break;
				default: throw new Error("this should never happen");
			}
			else this._runRequest(reqSpec, partitionKey);
		});
	}
	clear() {
		this._partitionedQueue.clear();
	}
	pause() {
		this._paused = true;
	}
	resume() {
		this._paused = false;
		for (const partitionKey of this._partitionedQueue.keys()) this._runNextRequest(partitionKey);
	}
	destroy() {
		this._paused = false;
		this._destroyed = true;
		this._counterTimers.forEach((timer) => {
			clearTimeout(timer);
		});
		for (const queue of this._partitionedQueue.values()) for (const req of queue) req.reject(new RateLimiterDestroyedError("Rate limiter was destroyed"));
		this._partitionedQueue.clear();
	}
	_getPartitionedQueue(partitionKey) {
		if (this._partitionedQueue.has(partitionKey)) return this._partitionedQueue.get(partitionKey);
		const newQueue = [];
		this._partitionedQueue.set(partitionKey, newQueue);
		return newQueue;
	}
	async _runRequest(reqSpec, partitionKey) {
		var _a;
		const queue = this._getPartitionedQueue(partitionKey);
		this._logger.debug(`doing a request for ${partitionKey ? `partition ${partitionKey}` : "default partition"}, new queue length is ${queue.length}`);
		this._usedFromBucket.set(partitionKey, ((_a = this._usedFromBucket.get(partitionKey)) !== null && _a !== void 0 ? _a : 0) + 1);
		const { req, resolve, reject } = reqSpec;
		try {
			resolve(await this._callback(req));
		} catch (e) {
			reject(e);
		} finally {
			const counterTimer = setTimeout(() => {
				this._counterTimers.delete(counterTimer);
				const newUsed = this._usedFromBucket.get(partitionKey) - 1;
				this._usedFromBucket.set(partitionKey, newUsed);
				if (queue.length && newUsed < this._bucketSize) this._runNextRequest(partitionKey);
			}, this._timeFrame);
			this._counterTimers.add(counterTimer);
		}
	}
	_runNextRequest(partitionKey) {
		if (this._paused) return;
		const reqSpec = this._getPartitionedQueue(partitionKey).shift();
		if (reqSpec) this._runRequest(reqSpec, partitionKey);
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+rate-limiter@1.1.0/node_modules/@d-fischer/rate-limiter/es/limiters/TimeBasedRateLimiter.mjs
var TimeBasedRateLimiter = class {
	constructor({ logger, bucketSize, timeFrame, doRequest }) {
		this._queue = [];
		this._usedFromBucket = 0;
		this._counterTimers = /* @__PURE__ */ new Set();
		this._paused = false;
		this._destroyed = false;
		this._logger = createLogger({
			name: "rate-limiter",
			emoji: true,
			...logger
		});
		this._bucketSize = bucketSize;
		this._timeFrame = timeFrame;
		this._callback = doRequest;
	}
	async request(req, options) {
		return await new Promise((resolve, reject) => {
			var _a;
			if (this._destroyed) {
				reject(new RateLimiterDestroyedError("Rate limiter was destroyed"));
				return;
			}
			const reqSpec = {
				req,
				resolve,
				reject,
				limitReachedBehavior: (_a = options === null || options === void 0 ? void 0 : options.limitReachedBehavior) !== null && _a !== void 0 ? _a : "enqueue"
			};
			if (this._usedFromBucket >= this._bucketSize || this._paused) switch (reqSpec.limitReachedBehavior) {
				case "enqueue":
					this._queue.push(reqSpec);
					if (this._usedFromBucket + this._queue.length >= this._bucketSize) this._logger.warn(`Rate limit of ${this._bucketSize} was reached, waiting for ${this._paused ? "the limiter to be unpaused" : "a free bucket entry"}; queue size is ${this._queue.length}`);
					else this._logger.info(`Enqueueing request because the rate limiter is paused; queue size is ${this._queue.length}`);
					break;
				case "null":
					reqSpec.resolve(null);
					this._logger.warn(`Rate limit of ${this._bucketSize} was reached, dropping request and returning null`);
					if (this._paused) this._logger.info("Returning null for request because the rate limiter is paused");
					else this._logger.warn(`Rate limit of ${this._bucketSize} was reached, dropping request and returning null`);
					break;
				case "throw":
					reqSpec.reject(new RateLimitReachedError(`Request dropped because ${this._paused ? "the rate limiter is paused" : "the rate limit was reached"}`));
					break;
				default: throw new Error("this should never happen");
			}
			else this._runRequest(reqSpec);
		});
	}
	clear() {
		this._queue = [];
	}
	pause() {
		this._paused = true;
	}
	resume() {
		this._paused = false;
		this._runNextRequest();
	}
	destroy() {
		this._paused = false;
		this._destroyed = true;
		this._counterTimers.forEach((timer) => {
			clearTimeout(timer);
		});
		for (const req of this._queue) req.reject(new RateLimiterDestroyedError("Rate limiter was destroyed"));
		this._queue = [];
	}
	async _runRequest(reqSpec) {
		this._logger.debug(`doing a request, new queue length is ${this._queue.length}`);
		this._usedFromBucket += 1;
		const { req, resolve, reject } = reqSpec;
		try {
			resolve(await this._callback(req));
		} catch (e) {
			reject(e);
		} finally {
			const counterTimer = setTimeout(() => {
				this._counterTimers.delete(counterTimer);
				this._usedFromBucket -= 1;
				if (this._queue.length && this._usedFromBucket < this._bucketSize) this._runNextRequest();
			}, this._timeFrame);
			this._counterTimers.add(counterTimer);
		}
	}
	_runNextRequest() {
		if (this._paused) return;
		const reqSpec = this._queue.shift();
		if (reqSpec) this._runRequest(reqSpec);
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+rate-limiter@1.1.0/node_modules/@d-fischer/rate-limiter/es/limiters/TimedPassthruRateLimiter.mjs
var TimedPassthruRateLimiter = class extends TimeBasedRateLimiter {
	constructor(child, config) {
		super({
			...config,
			async doRequest(req, options) {
				return await child.request(req, options);
			}
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+connection@9.0.0/node_modules/@d-fischer/connection/es/AbstractConnection.mjs
var AbstractConnection = class extends EventEmitter {
	constructor({ lineBased, logger, additionalOptions } = {}) {
		super();
		this._currentLine = "";
		this._connecting = false;
		this._connected = false;
		this.onReceive = this.registerEvent();
		this.onConnect = this.registerEvent();
		this.onDisconnect = this.registerEvent();
		this.onEnd = this.registerEvent();
		this._lineBased = lineBased !== null && lineBased !== void 0 ? lineBased : false;
		this._logger = logger;
		this._additionalOptions = additionalOptions;
	}
	get isConnecting() {
		return this._connecting;
	}
	get isConnected() {
		return this._connected;
	}
	sendLine(line) {
		if (this._connected) {
			line = line.replace(/[\0\r\n]/g, "");
			this.sendRaw(`${line}\r\n`);
		}
	}
	assumeExternalDisconnect() {
		var _a;
		(_a = this._logger) === null || _a === void 0 || _a.trace("AbstractConnection assumeExternalDisconnect");
		this._connected = false;
		this._connecting = false;
		this.clearSocket();
		this.emit(this.onDisconnect, false);
	}
	receiveRaw(data) {
		var _a, _b;
		if (!this._lineBased) {
			this.emit(this.onReceive, data);
			return;
		}
		const receivedLines = data.split("\r\n");
		this._currentLine += (_a = receivedLines.shift()) !== null && _a !== void 0 ? _a : "";
		if (receivedLines.length) {
			this.emit(this.onReceive, this._currentLine);
			this._currentLine = (_b = receivedLines.pop()) !== null && _b !== void 0 ? _b : "";
			for (const line of receivedLines) this.emit(this.onReceive, line);
		}
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+connection@9.0.0/node_modules/@d-fischer/connection/es/DirectConnection.mjs
var DirectConnection = class extends AbstractConnection {
	constructor(target, options) {
		var _a;
		super(options);
		this._socket = null;
		this._closingOnDemand = false;
		this._hadError = false;
		if (!target.hostName || !target.port) throw new Error("DirectConnection requires hostName and port to be set");
		this._host = target.hostName;
		this._port = target.port;
		this._secure = (_a = target.secure) !== null && _a !== void 0 ? _a : true;
	}
	get hasSocket() {
		return !!this._socket;
	}
	sendRaw(line) {
		var _a;
		(_a = this._socket) === null || _a === void 0 || _a.write(line);
	}
	connect() {
		var _a;
		(_a = this._logger) === null || _a === void 0 || _a.trace("DirectConnection connect");
		this._connecting = true;
		if (this._secure) this._socket = tls.connect(this._port, this._host);
		else {
			this._socket = new Socket();
			this._socket.connect(this._port, this._host);
		}
		this._socket.on("connect", () => {
			var _a;
			(_a = this._logger) === null || _a === void 0 || _a.trace("DirectConnection onConnect");
			this._connecting = false;
			this._connected = true;
			this._closingOnDemand = false;
			this._hadError = false;
			this.emit(this.onConnect);
		});
		this._socket.on("error", (err) => {
			var _a;
			(_a = this._logger) === null || _a === void 0 || _a.trace(`DirectConnection onError message:${err.message}`);
			this._connected = false;
			this._connecting = false;
			this.emit(this.onDisconnect, false, err);
			this._hadError = true;
		});
		this._socket.on("data", (data) => {
			this.receiveRaw(data.toString());
		});
		this._socket.on("close", () => {
			var _a;
			(_a = this._logger) === null || _a === void 0 || _a.trace(`DirectConnection onClose closingOnDemand:${this._closingOnDemand.toString()} hadError:${this._hadError.toString()}`);
			if (!this._hadError) {
				this._connected = false;
				this._connecting = false;
				this.emit(this.onDisconnect, this._closingOnDemand);
			}
			this._closingOnDemand = false;
			this._hadError = false;
			this.clearSocket();
		});
	}
	disconnect() {
		var _a, _b;
		(_a = this._logger) === null || _a === void 0 || _a.trace("DirectConnection disconnect");
		this._closingOnDemand = true;
		(_b = this._socket) === null || _b === void 0 || _b.end();
	}
	clearSocket() {
		if (this._socket) {
			this._socket.removeAllListeners("connect");
			this._socket.removeAllListeners("error");
			this._socket.removeAllListeners("data");
			this._socket.removeAllListeners("close");
			this._socket = null;
		}
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+connection@9.0.0/node_modules/@d-fischer/connection/es/PersistentConnection.mjs
var PersistentConnection = class extends EventEmitter {
	constructor(_type, _target, _config = {}) {
		var _a;
		super();
		this._type = _type;
		this._target = _target;
		this._config = _config;
		this._retryLimit = Infinity;
		this._initialRetryLimit = 3;
		this._connecting = false;
		this._connectionRetryCount = 0;
		this.onReceive = this.registerEvent();
		this.onConnect = this.registerEvent();
		this.onDisconnect = this.registerEvent();
		this.onEnd = this.registerEvent();
		this._retryLimit = (_a = _config.retryLimit) !== null && _a !== void 0 ? _a : Infinity;
		this._logger = _config.logger;
	}
	get isConnected() {
		var _a, _b;
		return (_b = (_a = this._currentConnection) === null || _a === void 0 ? void 0 : _a.isConnected) !== null && _b !== void 0 ? _b : false;
	}
	get isConnecting() {
		var _a, _b;
		return (_b = (_a = this._currentConnection) === null || _a === void 0 ? void 0 : _a.isConnecting) !== null && _b !== void 0 ? _b : this._connecting;
	}
	get hasSocket() {
		var _a, _b;
		return (_b = (_a = this._currentConnection) === null || _a === void 0 ? void 0 : _a.hasSocket) !== null && _b !== void 0 ? _b : false;
	}
	sendLine(line) {
		var _a;
		(_a = this._currentConnection) === null || _a === void 0 || _a.sendLine(line);
	}
	connect() {
		if (this._currentConnection || this._connecting) throw new Error("Connection already present");
		this._connecting = true;
		this._connectionRetryCount = 0;
		this._tryConnect(true);
	}
	disconnect() {
		var _a;
		(_a = this._logger) === null || _a === void 0 || _a.trace(`PersistentConnection disconnect currentConnectionExists:${Boolean(this._currentConnection).toString()} connecting:${this._connecting.toString()}`);
		this._connecting = false;
		if (this._currentConnection) {
			const lastConnection = this._currentConnection;
			this._currentConnection = void 0;
			lastConnection.disconnect();
		}
	}
	assumeExternalDisconnect() {
		var _a, _b;
		(_a = this._logger) === null || _a === void 0 || _a.trace("PersistentConnection assumeExternalDisconnect");
		(_b = this._currentConnection) === null || _b === void 0 || _b.assumeExternalDisconnect();
	}
	reconnect() {
		this._reconnect(true);
	}
	acknowledgeSuccessfulReconnect() {
		if (this._previousConnection) {
			this._previousConnection.disconnect();
			this._previousConnection = void 0;
		}
	}
	_startTryingToConnect(userGenerated = false) {
		this._connecting = true;
		this._connectionRetryCount = 0;
		this._tryConnect(userGenerated);
	}
	_tryConnect(userGenerated = false) {
		var _a, _b;
		(_a = this._logger) === null || _a === void 0 || _a.trace(`PersistentConnection tryConnect currentConnectionExists:${Boolean(this._currentConnection).toString()} connecting:${this._connecting.toString()}`);
		const retryLimit = userGenerated ? this._initialRetryLimit : this._retryLimit;
		(_b = this._retryTimerGenerator) !== null && _b !== void 0 || (this._retryTimerGenerator = fibWithLimit(120));
		const newConnection = this._currentConnection = new this._type(resolveConfigValueSync(this._target), this._config);
		newConnection.onReceive((line) => this.emit(this.onReceive, line));
		newConnection.onConnect(() => {
			this.emit(this.onConnect);
			this._connecting = false;
			this._retryTimerGenerator = void 0;
		});
		newConnection.onDisconnect((manually, reason) => {
			var _a, _b, _c;
			this.emit(this.onDisconnect, manually, reason);
			if (manually) {
				this.emit(this.onEnd, true);
				this._connecting = false;
				this._retryTimerGenerator = void 0;
				newConnection.disconnect();
				if (this._currentConnection === newConnection) this._currentConnection = void 0;
				if (this._previousConnection === newConnection) this._previousConnection = void 0;
			} else if (this._connecting) {
				(_a = this._logger) === null || _a === void 0 || _a.debug(`Connection error caught: ${(_b = reason === null || reason === void 0 ? void 0 : reason.message) !== null && _b !== void 0 ? _b : "unknown error"}`);
				if (this._connectionRetryCount >= retryLimit) return;
				this._connectionRetryCount++;
				const secs = this._retryTimerGenerator.next().value;
				if (secs !== 0) (_c = this._logger) === null || _c === void 0 || _c.info(`Retrying in ${secs} seconds`);
				setTimeout(() => {
					var _a;
					if (!this._connecting) return;
					(_a = this._logger) === null || _a === void 0 || _a.info(userGenerated ? "Retrying connection" : "Trying to reconnect");
					this._tryConnect();
				}, secs * 1e3);
			} else this._reconnect();
		});
		newConnection.connect();
	}
	_reconnect(userGenerated = false) {
		if (userGenerated && this._config.overlapManualReconnect) {
			this._previousConnection = this._currentConnection;
			this._currentConnection = void 0;
		} else this.disconnect();
		this._startTryingToConnect(userGenerated);
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+connection@9.0.0/node_modules/@d-fischer/connection/es/WebSocketConnection.mjs
var WebSocketConnection = class extends AbstractConnection {
	constructor(target, options) {
		super(options);
		this._socket = null;
		this._closingOnDemand = false;
		if (target.hostName && target.port) this._url = `ws${target.secure ? "s" : ""}://${target.hostName}:${target.port}`;
		else if (target.url) this._url = target.url;
		else throw new Error("WebSocketConnection requires either hostName & port or url to be set");
	}
	get hasSocket() {
		return !!this._socket;
	}
	sendRaw(line) {
		var _a;
		(_a = this._socket) === null || _a === void 0 || _a.send(line);
	}
	connect() {
		var _a, _b;
		(_a = this._logger) === null || _a === void 0 || _a.trace("WebSocketConnection connect");
		this._connecting = true;
		this._socket = new WebSocket$2(this._url, (_b = this._additionalOptions) === null || _b === void 0 ? void 0 : _b.wsOptions);
		this._socket.onopen = () => {
			var _a;
			(_a = this._logger) === null || _a === void 0 || _a.trace("WebSocketConnection onOpen");
			this._connected = true;
			this._connecting = false;
			this._closingOnDemand = false;
			this.emit(this.onConnect);
		};
		this._socket.onmessage = ({ data }) => {
			this.receiveRaw(data.toString());
		};
		this._socket.onerror = (e) => {
			var _a;
			(_a = this._logger) === null || _a === void 0 || _a.trace(`WebSocketConnection onError message:${e.message}`);
		};
		this._socket.onclose = (e) => {
			var _a;
			const wasConnected = this._connected;
			const wasConnecting = this._connecting;
			(_a = this._logger) === null || _a === void 0 || _a.trace(`WebSocketConnection onClose wasConnected:${wasConnected.toString()} wasConnecting:${wasConnecting.toString()} closingOnDemand:${this._closingOnDemand.toString()} wasClean:${e.wasClean.toString()}`);
			this._connected = false;
			this._connecting = false;
			if (this._closingOnDemand) {
				this._closingOnDemand = false;
				this.emit(this.onDisconnect, true);
				this.emit(this.onEnd, true);
			} else {
				const err = /* @__PURE__ */ new Error(`[${e.code}] ${e.reason}`);
				this.emit(this.onDisconnect, false, err);
				this.emit(this.onEnd, false, err);
			}
			this.clearSocket();
		};
	}
	disconnect() {
		var _a, _b;
		(_a = this._logger) === null || _a === void 0 || _a.trace("WebSocketConnection disconnect");
		this._closingOnDemand = true;
		(_b = this._socket) === null || _b === void 0 || _b.close();
	}
	clearSocket() {
		if (this._socket) {
			this._socket.onopen = null;
			this._socket.onmessage = null;
			this._socket.onerror = null;
			this._socket.onclose = null;
			this._socket = null;
		}
	}
};
//#endregion
//#region node_modules/.pnpm/klona@2.0.6/node_modules/klona/json/index.mjs
function klona(val) {
	var k, out, tmp;
	if (Array.isArray(val)) {
		out = Array(k = val.length);
		while (k--) out[k] = (tmp = val[k]) && typeof tmp === "object" ? klona(tmp) : tmp;
		return out;
	}
	if (Object.prototype.toString.call(val) === "[object Object]") {
		out = {};
		for (k in val) if (k === "__proto__") Object.defineProperty(out, k, {
			value: klona(val[k]),
			configurable: true,
			enumerable: true,
			writable: true
		});
		else out[k] = (tmp = val[k]) && typeof tmp === "object" ? klona(tmp) : tmp;
		return out;
	}
	return val;
}
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/AwayNotifyCapability.mjs
const AwayNotifyCapability = { name: "away-notify" };
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Errors/NotEnoughParametersError.mjs
var NotEnoughParametersError = class NotEnoughParametersError extends Error {
	constructor(_command, _expectedParams, _actualParams) {
		super(`command "${_command}" expected ${_expectedParams} or more parameters, got ${_actualParams}`);
		this._command = _command;
		this._expectedParams = _expectedParams;
		this._actualParams = _actualParams;
		Object.setPrototypeOf(this, NotEnoughParametersError.prototype);
		if (Error.captureStackTrace) Error.captureStackTrace(this, NotEnoughParametersError);
	}
	get command() {
		return this._command;
	}
	get expectedParams() {
		return this._expectedParams;
	}
	get actualParams() {
		return this._actualParams;
	}
};
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Errors/ParameterRequirementMismatchError.mjs
var ParameterRequirementMismatchError = class ParameterRequirementMismatchError extends Error {
	constructor(_command, _paramName, _paramSpec, _givenValue) {
		var _a;
		super(`required parameter "${_paramName}" did not validate against ${(_a = _paramSpec.type) !== null && _a !== void 0 ? _a : "regex"} validation: "${_givenValue}"`);
		this._command = _command;
		this._paramName = _paramName;
		this._paramSpec = _paramSpec;
		this._givenValue = _givenValue;
		Object.setPrototypeOf(this, ParameterRequirementMismatchError.prototype);
		if (Error.captureStackTrace) Error.captureStackTrace(this, ParameterRequirementMismatchError);
	}
	get command() {
		return this._command;
	}
	get paramName() {
		return this._paramName;
	}
	get paramSpec() {
		return this._paramSpec;
	}
	get givenValue() {
		return this._givenValue;
	}
};
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/ServerProperties.mjs
const defaultServerProperties = {
	channelTypes: "#&",
	supportedUserModes: "iwso",
	supportedChannelModes: {
		prefix: "ov",
		list: "b",
		alwaysWithParam: "ovk",
		paramWhenSet: "l",
		noParam: "imnpst"
	},
	prefixes: [{
		modeChar: "v",
		prefix: "+"
	}, {
		modeChar: "o",
		prefix: "@"
	}]
};
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Toolkit/StringTools.mjs
var import_escape_string_regexp = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = (string) => {
		if (typeof string !== "string") throw new TypeError("Expected a string");
		return string.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
	};
	module.exports.default = module.exports;
})))(), 1);
function isChannel(str, validTypes = "#&") {
	return new RegExp(`^[${(0, import_escape_string_regexp.default)(validTypes)}][^ \b\0\n\r,]+$`).test(str);
}
const ctcpEscapeMap = {
	0: "\0",
	n: "\n",
	r: "\r",
	"": ""
};
function decodeCtcp(message) {
	if (!message.startsWith("")) return false;
	message = message.substring(1);
	if (message.endsWith("")) message = message.slice(0, -1);
	if (!message) return false;
	message = message.replace(/\x10(.)/, (_, escapedChar) => escapedChar in ctcpEscapeMap ? ctcpEscapeMap[escapedChar] : "");
	let [command, params = ""] = splitWithLimit(message, " ", 2);
	command = command ? command.toUpperCase() : "";
	return {
		command,
		params
	};
}
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/Message.mjs
const tagEscapeMap = {
	"\\": "\\",
	";": ":",
	"\n": "n",
	"\r": "r",
	" ": "s"
};
function escapeTag(str) {
	return str.replace(/[\\;\n\r ]/g, (match) => `\\${tagEscapeMap[match]}`);
}
function prefixToString(prefix) {
	let result = `${prefix.nick}`;
	if (prefix.user) result += `!${prefix.user}`;
	if (prefix.host) result += `@${prefix.host}`;
	return result;
}
function createMessage(type, params, prefix, tags, serverProperties = defaultServerProperties, isServer = false) {
	const message = new type(type.COMMAND, void 0, { serverProperties });
	const parsedParams = {};
	if (message._paramSpec) forEachObjectEntry(message._paramSpec, (paramSpec, paramName) => {
		if (isServer && paramSpec.noServer) return;
		if (!isServer && paramSpec.noClient) return;
		if (paramName in params) {
			const param = params[paramName];
			if (param !== void 0) {
				if (type.checkParam(param, paramSpec, serverProperties)) parsedParams[paramName] = {
					value: param,
					trailing: Boolean(paramSpec.trailing)
				};
				else if (!paramSpec.optional) throw new Error(`required parameter "${paramName}" did not suit requirements: "${param}"`);
			}
		}
		if (!(paramName in parsedParams) && !paramSpec.optional) throw new Error(`required parameter "${paramName}" not found in command "${type.COMMAND}"`);
	});
	message._parsedParams = parsedParams;
	if (message._paramSpec) for (const key of Object.keys(message._paramSpec)) Object.defineProperty(message, key, { get() {
		var _a, _b;
		return (_b = (_a = this._parsedParams) === null || _a === void 0 ? void 0 : _a[key]) === null || _b === void 0 ? void 0 : _b.value;
	} });
	message._initPrefixAndTags(prefix, tags);
	return message;
}
var Message = class Message {
	static checkParam(param, spec, serverProperties = defaultServerProperties) {
		if (spec.type === "channel") {
			if (!isChannel(param, serverProperties.channelTypes)) return false;
		}
		if (spec.type === "channelList") {
			if (!param.split(",").every((chan) => isChannel(chan, serverProperties.channelTypes))) return false;
		}
		if (spec.match) {
			if (!spec.match.test(param)) return false;
		}
		return true;
	}
	constructor(command, { params, tags, prefix, rawLine } = {}, { serverProperties = defaultServerProperties, isServer = false, shouldParseParams = true } = {}, paramSpec) {
		this._params = [];
		this._serverProperties = defaultServerProperties;
		this._paramSpec = paramSpec;
		this._command = command;
		this._params = params;
		this._tags = tags !== null && tags !== void 0 ? tags : /* @__PURE__ */ new Map();
		this._prefix = prefix;
		this._serverProperties = serverProperties;
		this._raw = rawLine;
		if (shouldParseParams) this.parseParams(isServer);
	}
	getMinParamCount(isServer = false) {
		if (!this._paramSpec) return 0;
		return Object.values(this._paramSpec).filter((spec) => {
			if (spec.noServer && isServer) return false;
			if (spec.noClient && !isServer) return false;
			return !spec.optional;
		}).length;
	}
	get paramCount() {
		var _a, _b;
		return (_b = (_a = this._params) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0;
	}
	prefixToString() {
		if (!this._prefix) return "";
		return prefixToString(this._prefix);
	}
	tagsToString() {
		return [...this._tags.entries()].map(([key, value]) => value ? `${key}=${escapeTag(value)}` : key).join(";");
	}
	toString(includePrefix = false, fromRawParams = false) {
		const parts = [fromRawParams ? this._buildCommandFromRawParams() : this._buildCommandFromNamedParams()];
		if (includePrefix) {
			const prefix = this.prefixToString();
			if (prefix) parts.unshift(`:${prefix}`);
		}
		const tags = this.tagsToString();
		if (tags) parts.unshift(`@${tags}`);
		return parts.join(" ");
	}
	/** @private */
	_initPrefixAndTags(prefix, tags) {
		this._prefix = prefix;
		if (tags) this._tags = tags;
	}
	parseParams(isServer = false) {
		if (this._params) {
			let requiredParamsLeft = this.getMinParamCount(isServer);
			if (requiredParamsLeft > this._params.length) throw new NotEnoughParametersError(this._command, requiredParamsLeft, this._params.length);
			const paramSpecList = this._paramSpec;
			if (!paramSpecList) return;
			let i = 0;
			const parsedParams = {};
			for (const [paramName, paramSpec] of Object.entries(paramSpecList)) {
				if (paramSpec.noServer && isServer) continue;
				if (paramSpec.noClient && !isServer) continue;
				if (this._params.length - i <= requiredParamsLeft) {
					if (paramSpec.optional) continue;
					else if (this._params.length - i !== requiredParamsLeft) throw new Error("not enough parameters left for required parameters parsing (this is a library bug)");
				}
				let param = this._params[i];
				if (!param) {
					if (paramSpec.optional) break;
					throw new Error("unexpected parameter underflow");
				}
				if (paramSpec.rest) {
					const restParams = [];
					while (this._params[i] && !this._params[i].trailing) {
						restParams.push(this._params[i].value);
						++i;
					}
					if (!restParams.length) {
						if (paramSpec.optional) continue;
						throw new Error(`no parameters left for required rest parameter "${paramName}"`);
					}
					param = {
						value: restParams.join(" "),
						trailing: false
					};
				}
				if (Message.checkParam(param.value, paramSpec)) {
					parsedParams[paramName] = { ...param };
					if (!paramSpec.optional) --requiredParamsLeft;
					if (!paramSpec.rest) ++i;
				} else if (!paramSpec.optional) throw new ParameterRequirementMismatchError(this._command, paramName, paramSpec, param.value);
				if (paramSpec.trailing) break;
			}
			this._parsedParams = parsedParams;
			if (this._paramSpec) for (const key of Object.keys(this._paramSpec)) Object.defineProperty(this, key, { get() {
				var _a, _b;
				return (_b = (_a = this._parsedParams) === null || _a === void 0 ? void 0 : _a[key]) === null || _b === void 0 ? void 0 : _b.value;
			} });
		}
	}
	get rawParamValues() {
		var _a, _b;
		return (_b = (_a = this._params) === null || _a === void 0 ? void 0 : _a.map((param) => param.value)) !== null && _b !== void 0 ? _b : [];
	}
	get prefix() {
		return this._prefix;
	}
	get command() {
		return this._command;
	}
	get tags() {
		return this._tags;
	}
	get rawLine() {
		return this._raw;
	}
	isResponseTo(originalMessage) {
		return false;
	}
	endsResponseTo(originalMessage) {
		return false;
	}
	_acceptsInReplyCollection(message) {
		return message.isResponseTo(this);
	}
	_buildCommandFromNamedParams() {
		const specKeys = this._paramSpec ? Object.keys(this._paramSpec) : [];
		return [this._command, ...specKeys.map((paramName) => {
			var _a;
			const param = (_a = this._parsedParams) === null || _a === void 0 ? void 0 : _a[paramName];
			if (param) return (param.trailing ? ":" : "") + param.value;
		}).filter((param) => param !== void 0)].join(" ");
	}
	_buildCommandFromRawParams() {
		var _a, _b;
		return [this._command, ...(_b = (_a = this._params) === null || _a === void 0 ? void 0 : _a.map((param) => `${param.trailing ? ":" : ""}${param.value}`)) !== null && _b !== void 0 ? _b : []].join(" ");
	}
};
Message.COMMAND = "";
Message.SUPPORTS_CAPTURE = false;
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/BatchCapability/MessageTypes/Commands/Batch.mjs
var Batch = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			reference: {},
			type: { optional: true },
			additionalParams: { optional: true }
		});
	}
};
Batch.COMMAND = "BATCH";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/BatchCapability/index.mjs
const BatchCapability = {
	name: "batch",
	messageTypes: [Batch],
	usesTags: true
};
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/CapNotifyCapability.mjs
const CapNotifyCapability = { name: "cap-notify" };
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/ChgHostCapability/MessageTypes/Commands/ChgHost.mjs
var ChgHost = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			newUser: {},
			newHost: {}
		});
	}
};
ChgHost.COMMAND = "CHGHOST";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/ChgHostCapability/index.mjs
const ChgHostCapability = {
	name: "chghost",
	messageTypes: [ChgHost]
};
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/InviteNotifyCapability.mjs
const InviteNotifyCapability = { name: "invite-notify" };
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/LabeledResponseCapability/MessageTypes/Commands/Acknowledgement.mjs
var Acknowledgement = class extends Message {};
Acknowledgement.COMMAND = "ACK";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/LabeledResponseCapability/index.mjs
const LabeledResponseCapability = {
	name: "labeled-response",
	messageTypes: [Acknowledgement],
	usesTags: true
};
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/MessageTagsCapability.mjs
const MessageTagsCapability = {
	name: "message-tags",
	usesTags: true
};
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/MultiPrefixCapability.mjs
const MultiPrefixCapability = { name: "multi-prefix" };
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Capability/CoreCapabilities/index.mjs
var CoreCapabilities_exports = /* @__PURE__ */ __exportAll({
	AwayNotify: () => AwayNotifyCapability,
	Batch: () => BatchCapability,
	CapNotify: () => CapNotifyCapability,
	ChgHost: () => ChgHostCapability,
	InviteNotify: () => InviteNotifyCapability,
	LabeledResponse: () => LabeledResponseCapability,
	MessageTags: () => MessageTagsCapability,
	MultiPrefix: () => MultiPrefixCapability
});
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageCollector.mjs
var MessageCollector = class {
	constructor(_client, _originalMessage, ...types) {
		this._client = _client;
		this._originalMessage = _originalMessage;
		this._messages = [];
		this._endEventHandlers = /* @__PURE__ */ new Map();
		this._types = new Set(types);
	}
	untilEvent(eventType) {
		this._cleanEndEventHandler(eventType);
		const listener = this._client.on(eventType, () => this.end());
		this._endEventHandlers.set(eventType, listener);
	}
	async promise() {
		this._promise || (this._promise = new Promise((resolve) => {
			this._promiseResolve = resolve;
		}));
		return await this._promise;
	}
	collect(message) {
		if (!this._originalMessage._acceptsInReplyCollection(message)) return false;
		this._messages.push(message);
		if (message.endsResponseTo(this._originalMessage)) this.end();
		return true;
	}
	end() {
		this._client.stopCollect(this);
		this._cleanEndEventHandlers();
		if (this._promiseResolve) this._promiseResolve(this._messages);
	}
	_cleanEndEventHandlers() {
		this._endEventHandlers.forEach((listener) => {
			this._client.removeListener(listener);
		});
		this._endEventHandlers.clear();
	}
	_cleanEndEventHandler(eventType) {
		if (this._endEventHandlers.has(eventType)) {
			this._client.removeListener(this._endEventHandlers.get(eventType));
			this._endEventHandlers.delete(eventType);
		}
	}
};
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Password.mjs
var Password = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { password: {} });
	}
};
Password.COMMAND = "PASS";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/NickChange.mjs
var NickChange = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { nick: {} });
	}
};
NickChange.COMMAND = "NICK";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/UserRegistration.mjs
var UserRegistration = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			user: {},
			mode: {},
			unused: {},
			realName: { trailing: true }
		});
	}
};
UserRegistration.COMMAND = "USER";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/OperLogin.mjs
var OperLogin = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			name: {},
			password: {}
		});
	}
};
OperLogin.COMMAND = "OPER";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/ClientQuit.mjs
var ClientQuit = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { text: {
			trailing: true,
			optional: true
		} });
	}
};
ClientQuit.COMMAND = "QUIT";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/ServerQuit.mjs
var ServerQuit = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			server: {},
			reason: { trailing: true }
		});
	}
};
ServerQuit.COMMAND = "SQUIT";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/ChannelJoin.mjs
var ChannelJoin = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			channel: { type: "channel" },
			key: { optional: true }
		});
	}
};
ChannelJoin.COMMAND = "JOIN";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/ChannelPart.mjs
var ChannelPart = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			channel: { type: "channel" },
			reason: {
				trailing: true,
				optional: true
			}
		});
	}
};
ChannelPart.COMMAND = "PART";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Errors/UnknownChannelModeCharError.mjs
var UnknownChannelModeCharError = class UnknownChannelModeCharError extends Error {
	constructor(_char) {
		super(`Unknown channel mode character ${_char}`);
		this._char = _char;
		Object.setPrototypeOf(this, UnknownChannelModeCharError.prototype);
		if (Error.captureStackTrace) Error.captureStackTrace(this, UnknownChannelModeCharError);
	}
	get char() {
		return this._char;
	}
};
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Mode.mjs
var Mode = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			target: {},
			modes: {
				rest: true,
				optional: true
			}
		});
	}
	get isChannel() {
		return isChannel(this.target, this._serverProperties.channelTypes);
	}
	separate() {
		const result = [];
		const modeRestParam = this.modes;
		if (!modeRestParam) throw new Error("can't separate a channel mode request, just set actions");
		const modeParams = modeRestParam.split(" ");
		const modes = modeParams.shift();
		let currentModeAction = "add";
		for (const ch of modes) {
			let thisModeAction = currentModeAction;
			switch (ch) {
				case "+":
					currentModeAction = "add";
					break;
				case "-":
					currentModeAction = "remove";
					break;
				default: {
					let requiresParam = false;
					let known = true;
					if (this.isChannel) if (this._serverProperties.supportedChannelModes.alwaysWithParam.includes(ch) || this._serverProperties.supportedChannelModes.prefix.includes(ch)) requiresParam = true;
					else if (this._serverProperties.supportedChannelModes.paramWhenSet.includes(ch)) {
						if (currentModeAction === "add") requiresParam = true;
					} else if (this._serverProperties.supportedChannelModes.list.includes(ch)) if (modeParams.length) requiresParam = true;
					else thisModeAction = "getList";
					else if (this._serverProperties.supportedChannelModes.noParam.includes(ch)) {} else throw new UnknownChannelModeCharError(ch);
					else known = this._serverProperties.supportedUserModes.includes(ch);
					if (requiresParam && !modeParams.length) continue;
					result.push({
						prefix: this._prefix,
						action: thisModeAction,
						letter: ch,
						param: requiresParam ? modeParams.shift() : void 0,
						known
					});
				}
			}
		}
		return result;
	}
};
Mode.COMMAND = "MODE";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Topic.mjs
var Topic = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			channel: { type: "channel" },
			newTopic: {
				optional: true,
				trailing: true
			}
		});
	}
};
Topic.COMMAND = "TOPIC";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Names.mjs
var Names = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { channel: {
			type: "channelList",
			optional: true
		} });
	}
};
Names.COMMAND = "NAMES";
Names.SUPPORTS_CAPTURE = true;
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/ChannelList.mjs
var ChannelList = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			channel: { optional: true },
			server: { optional: true }
		});
	}
};
ChannelList.COMMAND = "LIST";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/ChannelInvite.mjs
var ChannelInvite = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			target: {},
			channel: { type: "channel" }
		});
	}
};
ChannelInvite.COMMAND = "INVITE";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/ChannelKick.mjs
var ChannelKick = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			channel: { type: "channel" },
			target: {},
			reason: {
				trailing: true,
				optional: true
			}
		});
	}
};
ChannelKick.COMMAND = "KICK";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Time.mjs
var Time = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { server: { optional: true } });
	}
};
Time.COMMAND = "TIME";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/PrivateMessage.mjs
var PrivateMessage = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			target: {},
			text: { trailing: true }
		});
	}
};
PrivateMessage.COMMAND = "PRIVMSG";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Notice.mjs
var Notice = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			target: {},
			text: { trailing: true }
		});
	}
};
Notice.COMMAND = "NOTICE";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/WhoQuery.mjs
var WhoQuery = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			mask: {},
			flags: { optional: true },
			extendedMask: {
				optional: true,
				trailing: true
			}
		});
	}
};
WhoQuery.COMMAND = "WHO";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/WhoIsQuery.mjs
var WhoIsQuery = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			server: { optional: true },
			nickMask: {}
		});
	}
};
WhoIsQuery.COMMAND = "WHOIS";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/WhoWasQuery.mjs
var WhoWasQuery = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			nick: {},
			count: { optional: true },
			server: { optional: true }
		});
	}
};
WhoWasQuery.COMMAND = "WHOWAS";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Kill.mjs
var Kill = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			target: {},
			reason: {
				trailing: true,
				optional: true
			}
		});
	}
};
Kill.COMMAND = "KILL";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Ping.mjs
var Ping = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { text: { trailing: true } });
	}
};
Ping.COMMAND = "PING";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Pong.mjs
var Pong = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			server: { noClient: true },
			text: { trailing: true }
		});
	}
};
Pong.COMMAND = "PONG";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/ErrorMessage.mjs
var ErrorMessage = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { text: { trailing: true } });
	}
};
ErrorMessage.COMMAND = "ERROR";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Away.mjs
var Away = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { text: {
			trailing: true,
			optional: true
		} });
	}
};
Away.COMMAND = "AWAY";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Rehash.mjs
var Rehash = class extends Message {};
Rehash.COMMAND = "REHASH";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/Restart.mjs
var Restart = class extends Message {};
Restart.COMMAND = "RESTART";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/WallopsMessage.mjs
var WallopsMessage = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { text: { trailing: true } });
	}
};
WallopsMessage.COMMAND = "WALLOPS";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/UserHostQuery.mjs
var UserHostQuery = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { nicks: { rest: true } });
	}
};
UserHostQuery.COMMAND = "USERHOST";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/IsOnQuery.mjs
var IsOnQuery = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { nicks: { rest: true } });
	}
};
IsOnQuery.COMMAND = "ISON";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/CapabilityNegotiation.mjs
var CapabilityNegotiation = class CapabilityNegotiation extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			target: {
				match: /^(?:[a-z_\-\[\]\\^{}|`][a-z0-9_\-\[\]\\^{}|`]+|\*)$/i,
				optional: true,
				noClient: true
			},
			subCommand: { match: /^(?:LS|LIST|REQ|ACK|NAK|END|NEW|DEL)$/i },
			version: {
				match: /^\d+$/,
				optional: true
			},
			continued: {
				match: /^\*$/,
				optional: true
			},
			capabilities: {
				trailing: true,
				optional: true
			}
		});
	}
	isResponseTo(originalMessage) {
		if (!(originalMessage instanceof CapabilityNegotiation)) return false;
		switch (this.subCommand) {
			case "ACK":
			case "NAK": return originalMessage.subCommand === "REQ" && originalMessage.capabilities === this.capabilities.trim();
			case "LS":
			case "LIST": return originalMessage.subCommand === this.subCommand;
			default: return false;
		}
	}
	endsResponseTo(originalMessage) {
		if (!(originalMessage instanceof CapabilityNegotiation)) return false;
		switch (this.subCommand) {
			case "LS":
			case "LIST": return !this.continued;
			default: return true;
		}
	}
};
CapabilityNegotiation.COMMAND = "CAP";
CapabilityNegotiation.SUPPORTS_CAPTURE = true;
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/TagMessage.mjs
var TagMessage = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, { target: {} });
	}
};
TagMessage.COMMAND = "TAGMSG";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Commands/index.mjs
var Commands_exports = /* @__PURE__ */ __exportAll({
	Away: () => Away,
	CapabilityNegotiation: () => CapabilityNegotiation,
	ChannelInvite: () => ChannelInvite,
	ChannelJoin: () => ChannelJoin,
	ChannelKick: () => ChannelKick,
	ChannelList: () => ChannelList,
	ChannelPart: () => ChannelPart,
	ClientQuit: () => ClientQuit,
	ErrorMessage: () => ErrorMessage,
	IsOnQuery: () => IsOnQuery,
	Kill: () => Kill,
	Mode: () => Mode,
	Names: () => Names,
	NickChange: () => NickChange,
	Notice: () => Notice,
	OperLogin: () => OperLogin,
	Password: () => Password,
	Ping: () => Ping,
	Pong: () => Pong,
	PrivateMessage: () => PrivateMessage,
	Rehash: () => Rehash,
	Restart: () => Restart,
	ServerQuit: () => ServerQuit,
	TagMessage: () => TagMessage,
	Time: () => Time,
	Topic: () => Topic,
	UserHostQuery: () => UserHostQuery,
	UserRegistration: () => UserRegistration,
	Wallops: () => WallopsMessage,
	WhoIsQuery: () => WhoIsQuery,
	WhoQuery: () => WhoQuery,
	WhoWasQuery: () => WhoWasQuery
});
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply001Welcome.mjs
var Reply001Welcome = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			welcomeText: { trailing: true }
		});
	}
};
Reply001Welcome.COMMAND = "001";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply002YourHost.mjs
var Reply002YourHost = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			yourHost: { trailing: true }
		});
	}
};
Reply002YourHost.COMMAND = "002";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply003Created.mjs
var Reply003Created = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			createdText: { trailing: true }
		});
	}
};
Reply003Created.COMMAND = "003";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply004ServerInfo.mjs
var Reply004ServerInfo = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			serverName: {},
			version: {},
			userModes: {},
			channelModes: {},
			channelModesWithParam: { optional: true }
		});
	}
};
Reply004ServerInfo.COMMAND = "004";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply005Isupport.mjs
var Reply005Isupport = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			supports: { rest: true },
			suffix: { trailing: true }
		});
	}
};
Reply005Isupport.COMMAND = "005";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply221UmodeIs.mjs
var Reply221UmodeIs = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			modes: {}
		});
	}
};
Reply221UmodeIs.COMMAND = "221";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply301Away.mjs
var Reply301Away = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			nick: {},
			text: { trailing: true }
		});
	}
};
Reply301Away.COMMAND = "301";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply302UserHost.mjs
var Reply302UserHost = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			hosts: { trailing: true }
		});
	}
};
Reply302UserHost.COMMAND = "302";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply305UnAway.mjs
var Reply305UnAway = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
};
Reply305UnAway.COMMAND = "305";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply306NowAway.mjs
var Reply306NowAway = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
};
Reply306NowAway.COMMAND = "306";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply311WhoisUser.mjs
var Reply311WhoisUser = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			nick: {},
			username: {},
			host: {},
			_unused: {},
			realname: { trailing: true }
		});
	}
};
Reply311WhoisUser.COMMAND = "311";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply315EndOfWho.mjs
var Reply315EndOfWho = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			query: {},
			suffix: { trailing: true }
		});
	}
	isResponseTo(originalMessage) {
		return originalMessage instanceof WhoQuery;
	}
	endsResponseTo() {
		return true;
	}
};
Reply315EndOfWho.COMMAND = "315";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply318EndOfWhois.mjs
var Reply318EndOfWhois = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			nickMask: {},
			suffix: { trailing: true }
		});
	}
};
Reply318EndOfWhois.COMMAND = "318";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply319WhoisChannels.mjs
var Reply319WhoisChannels = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			nick: {},
			channels: { trailing: true }
		});
	}
};
Reply319WhoisChannels.COMMAND = "319";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply322List.mjs
var Reply322List = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			memberCount: {},
			topic: { trailing: true }
		});
	}
};
Reply322List.COMMAND = "322";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply323ListEnd.mjs
var Reply323ListEnd = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
};
Reply323ListEnd.COMMAND = "323";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply324ChannelModeIs.mjs
var Reply324ChannelModeIs = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			modes: { rest: true }
		});
	}
};
Reply324ChannelModeIs.COMMAND = "324";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply331NoTopic.mjs
var Reply331NoTopic = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
};
Reply331NoTopic.COMMAND = "331";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply332Topic.mjs
var Reply332Topic = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			topic: { trailing: true }
		});
	}
};
Reply332Topic.COMMAND = "332";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply333TopicWhoTime.mjs
var Reply333TopicWhoTime = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			who: {},
			ts: {}
		});
	}
};
Reply333TopicWhoTime.COMMAND = "333";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply341Inviting.mjs
var Reply341Inviting = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			nick: {},
			channel: { type: "channel" }
		});
	}
};
Reply341Inviting.COMMAND = "341";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply348ExceptList.mjs
var Reply348ExceptList = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			mask: {},
			creatorName: { optional: true },
			timestamp: { optional: true }
		});
	}
};
Reply348ExceptList.COMMAND = "348";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply349EndOfExceptList.mjs
var Reply349EndOfExceptList = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
};
Reply349EndOfExceptList.COMMAND = "349";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply352WhoReply.mjs
var Reply352WhoReply = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: {},
			user: {},
			host: {},
			server: {},
			nick: {},
			flags: {},
			hopsAndRealName: { trailing: true }
		});
	}
	/**
	* Checks whether the found user is /away.
	*/
	get isAway() {
		return this.flags.includes("G");
	}
	/**
	* Checks whether the found user is an IRCOp.
	*/
	get isOper() {
		return this.flags.includes("*");
	}
	/**
	* Checks whether the found user is a bot.
	*/
	get isBot() {
		return this.flags.includes("B");
	}
	isResponseTo(originalMessage) {
		return originalMessage instanceof WhoQuery;
	}
};
Reply352WhoReply.COMMAND = "352";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply353NamesReply.mjs
var Reply353NamesReply = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channelType: {},
			channel: { type: "channel" },
			names: { trailing: true }
		});
	}
	isResponseTo(originalMessage) {
		return originalMessage instanceof Names;
	}
};
Reply353NamesReply.COMMAND = "353";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply366EndOfNames.mjs
var Reply366EndOfNames = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: {},
			suffix: { trailing: true }
		});
	}
	isResponseTo(originalMessage) {
		return originalMessage instanceof Names;
	}
	endsResponseTo() {
		return true;
	}
};
Reply366EndOfNames.COMMAND = "366";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply367BanList.mjs
var Reply367BanList = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			mask: {},
			creatorName: { optional: true },
			timestamp: { optional: true }
		});
	}
};
Reply367BanList.COMMAND = "367";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply368EndOfBanList.mjs
var Reply368EndOfBanList = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
};
Reply368EndOfBanList.COMMAND = "368";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply372Motd.mjs
var Reply372Motd = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			line: { trailing: true }
		});
	}
};
Reply372Motd.COMMAND = "372";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply375MotdStart.mjs
var Reply375MotdStart = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			line: { trailing: true }
		});
	}
};
Reply375MotdStart.COMMAND = "375";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply376EndOfMotd.mjs
var Reply376EndOfMotd = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
};
Reply376EndOfMotd.COMMAND = "376";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply381YoureOper.mjs
var Reply381YoureOper = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
};
Reply381YoureOper.COMMAND = "381";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Reply391Time.mjs
var Reply391Time = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			server: { optional: true },
			timestamp: { trailing: true }
		});
	}
};
Reply391Time.COMMAND = "391";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error401NoSuchNick.mjs
var Error401NoSuchNick = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			nick: {},
			suffix: { trailing: true }
		});
	}
};
Error401NoSuchNick.COMMAND = "401";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error402NoSuchServer.mjs
var Error402NoSuchServer = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			server: {},
			suffix: { trailing: true }
		});
	}
};
Error402NoSuchServer.COMMAND = "402";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error403NoSuchChannel.mjs
var Error403NoSuchChannel = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: {},
			suffix: { trailing: true }
		});
	}
};
Error403NoSuchChannel.COMMAND = "403";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error404CanNotSendToChan.mjs
var Error404CanNotSendToChan = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
};
Error404CanNotSendToChan.COMMAND = "404";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error405TooManyChannels.mjs
var Error405TooManyChannels = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
};
Error405TooManyChannels.COMMAND = "405";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error410InvalidCapCmd.mjs
var Error410InvalidCapCmd = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			subCommand: {},
			suffix: { trailing: true }
		});
	}
};
Error410InvalidCapCmd.COMMAND = "410";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error421UnknownCommand.mjs
var Error421UnknownCommand = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			originalCommand: {},
			suffix: { trailing: true }
		});
	}
	isResponseTo(originalMessage) {
		return originalMessage.command === this.originalCommand;
	}
	endsResponseTo() {
		return true;
	}
};
Error421UnknownCommand.COMMAND = "421";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error422NoMotd.mjs
var Error422NoMotd = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
};
Error422NoMotd.COMMAND = "422";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error431NoNickNameGiven.mjs
var Error431NoNickNameGiven = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
	isResponseTo(originalMessage) {
		return originalMessage.command === "NICK";
	}
	endsResponseTo() {
		return true;
	}
};
Error431NoNickNameGiven.COMMAND = "431";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error432ErroneusNickname.mjs
var Error432ErroneusNickname = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			nick: {},
			suffix: { trailing: true }
		});
	}
	isResponseTo(originalMessage) {
		return originalMessage.command === "NICK";
	}
	endsResponseTo() {
		return true;
	}
};
Error432ErroneusNickname.COMMAND = "432";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error433NickNameInUse.mjs
var Error433NickNameInUse = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			nick: {},
			suffix: { trailing: true }
		});
	}
	isResponseTo(originalMessage) {
		return originalMessage.command === "NICK";
	}
	endsResponseTo() {
		return true;
	}
};
Error433NickNameInUse.COMMAND = "433";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error436NickCollision.mjs
var Error436NickCollision = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			nick: {},
			suffix: { trailing: true }
		});
	}
	isResponseTo(originalMessage) {
		return originalMessage.command === "NICK";
	}
	endsResponseTo() {
		return true;
	}
};
Error436NickCollision.COMMAND = "436";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error441UserNotInChannel.mjs
var Error441UserNotInChannel = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			nick: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
	isResponseTo(originalMessage) {
		return originalMessage.command === "NICK";
	}
	endsResponseTo() {
		return true;
	}
};
Error441UserNotInChannel.COMMAND = "441";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error442NotOnChannel.mjs
var Error442NotOnChannel = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
	isResponseTo(originalMessage) {
		return originalMessage.command === "NICK";
	}
	endsResponseTo() {
		return true;
	}
};
Error442NotOnChannel.COMMAND = "442";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error443UserOnChannel.mjs
var Error443UserOnChannel = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			nick: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
	isResponseTo(originalMessage) {
		return originalMessage.command === "NICK";
	}
	endsResponseTo() {
		return true;
	}
};
Error443UserOnChannel.COMMAND = "443";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error451NotRegistered.mjs
var Error451NotRegistered = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
};
Error451NotRegistered.COMMAND = "451";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error461NeedMoreParams.mjs
var Error461NeedMoreParams = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			originalCommand: {},
			suffix: { trailing: true }
		});
	}
};
Error461NeedMoreParams.COMMAND = "461";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error462AlreadyRegistered.mjs
var Error462AlreadyRegistered = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
};
Error462AlreadyRegistered.COMMAND = "462";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error471ChannelIsFull.mjs
var Error471ChannelIsFull = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
};
Error471ChannelIsFull.COMMAND = "471";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error472UnknownMode.mjs
var Error472UnknownMode = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			char: {},
			suffix: { trailing: true }
		});
	}
};
Error472UnknownMode.COMMAND = "472";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error473InviteOnlyChan.mjs
var Error473InviteOnlyChan = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
};
Error473InviteOnlyChan.COMMAND = "473";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error474BannedFromChan.mjs
var Error474BannedFromChan = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
};
Error474BannedFromChan.COMMAND = "474";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error475BadChannelKey.mjs
var Error475BadChannelKey = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: { type: "channel" },
			suffix: { trailing: true }
		});
	}
};
Error475BadChannelKey.COMMAND = "475";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error479BadChanName.mjs
var Error479BadChanName = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: {},
			suffix: { trailing: true }
		});
	}
};
Error479BadChanName.COMMAND = "479";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error481NoPrivileges.mjs
var Error481NoPrivileges = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
};
Error481NoPrivileges.COMMAND = "481";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error482ChanOpPrivsNeeded.mjs
var Error482ChanOpPrivsNeeded = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			channel: {},
			suffix: { trailing: true }
		});
	}
};
Error482ChanOpPrivsNeeded.COMMAND = "482";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error491NoOperHost.mjs
var Error491NoOperHost = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
};
Error491NoOperHost.COMMAND = "491";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error501UmodeUnknownFlag.mjs
var Error501UmodeUnknownFlag = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			modeChar: {
				optional: true,
				match: /^\w$/
			},
			suffix: { trailing: true }
		});
	}
};
Error501UmodeUnknownFlag.COMMAND = "501";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/Error502UsersDontMatch.mjs
var Error502UsersDontMatch = class extends Message {
	constructor(command, contents, config) {
		super(command, contents, config, {
			me: {},
			suffix: { trailing: true }
		});
	}
};
Error502UsersDontMatch.COMMAND = "502";
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/Numerics/index.mjs
var Numerics_exports = /* @__PURE__ */ __exportAll({
	Error401NoSuchNick: () => Error401NoSuchNick,
	Error402NoSuchServer: () => Error402NoSuchServer,
	Error403NoSuchChannel: () => Error403NoSuchChannel,
	Error404CanNotSendToChan: () => Error404CanNotSendToChan,
	Error405TooManyChannels: () => Error405TooManyChannels,
	Error410InvalidCapCmd: () => Error410InvalidCapCmd,
	Error421UnknownCommand: () => Error421UnknownCommand,
	Error422NoMotd: () => Error422NoMotd,
	Error431NoNickNameGiven: () => Error431NoNickNameGiven,
	Error432ErroneusNickname: () => Error432ErroneusNickname,
	Error433NickNameInUse: () => Error433NickNameInUse,
	Error436NickCollision: () => Error436NickCollision,
	Error441UserNotInChannel: () => Error441UserNotInChannel,
	Error442NotOnChannel: () => Error442NotOnChannel,
	Error443UserOnChannel: () => Error443UserOnChannel,
	Error451NotRegistered: () => Error451NotRegistered,
	Error461NeedMoreParams: () => Error461NeedMoreParams,
	Error462AlreadyRegistered: () => Error462AlreadyRegistered,
	Error471ChannelIsFull: () => Error471ChannelIsFull,
	Error472UnknownMode: () => Error472UnknownMode,
	Error473InviteOnlyChan: () => Error473InviteOnlyChan,
	Error474BannedFromChan: () => Error474BannedFromChan,
	Error475BadChannelKey: () => Error475BadChannelKey,
	Error479BadChanName: () => Error479BadChanName,
	Error481NoPrivileges: () => Error481NoPrivileges,
	Error482ChanOpPrivsNeeded: () => Error482ChanOpPrivsNeeded,
	Error491NoOperHost: () => Error491NoOperHost,
	Error501UmodeUnknownFlag: () => Error501UmodeUnknownFlag,
	Error502UsersDontMatch: () => Error502UsersDontMatch,
	Reply001Welcome: () => Reply001Welcome,
	Reply002YourHost: () => Reply002YourHost,
	Reply003Created: () => Reply003Created,
	Reply004ServerInfo: () => Reply004ServerInfo,
	Reply005Isupport: () => Reply005Isupport,
	Reply221UmodeIs: () => Reply221UmodeIs,
	Reply301Away: () => Reply301Away,
	Reply302UserHost: () => Reply302UserHost,
	Reply305UnAway: () => Reply305UnAway,
	Reply306NowAway: () => Reply306NowAway,
	Reply311WhoisUser: () => Reply311WhoisUser,
	Reply315EndOfWho: () => Reply315EndOfWho,
	Reply318EndOfWhois: () => Reply318EndOfWhois,
	Reply319WhoisChannels: () => Reply319WhoisChannels,
	Reply322List: () => Reply322List,
	Reply323ListEnd: () => Reply323ListEnd,
	Reply324ChannelModeIs: () => Reply324ChannelModeIs,
	Reply331NoTopic: () => Reply331NoTopic,
	Reply332Topic: () => Reply332Topic,
	Reply333TopicWhoTime: () => Reply333TopicWhoTime,
	Reply341Inviting: () => Reply341Inviting,
	Reply348ExceptList: () => Reply348ExceptList,
	Reply349EndOfExceptList: () => Reply349EndOfExceptList,
	Reply352WhoReply: () => Reply352WhoReply,
	Reply353NamesReply: () => Reply353NamesReply,
	Reply366EndOfNames: () => Reply366EndOfNames,
	Reply367BanList: () => Reply367BanList,
	Reply368EndOfBanList: () => Reply368EndOfBanList,
	Reply372Motd: () => Reply372Motd,
	Reply375MotdStart: () => Reply375MotdStart,
	Reply376EndOfMotd: () => Reply376EndOfMotd,
	Reply381YoureOper: () => Reply381YoureOper,
	Reply391Time: () => Reply391Time
});
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageTypes/index.mjs
const all = new Map([...Object.values(Commands_exports), ...Object.values(Numerics_exports)].map((cmd) => [cmd.COMMAND, cmd]));
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/Message/MessageParser.mjs
function parsePrefix(raw) {
	const [nick, hostName] = splitWithLimit(raw, "!", 2);
	if (hostName) {
		const [user, host] = splitWithLimit(hostName, "@", 2);
		if (host) return {
			nick,
			user,
			host
		};
		return {
			nick,
			host: user
		};
	}
	return { nick };
}
const tagUnescapeMap = {
	":": ";",
	n: "\n",
	r: "\r",
	s: " "
};
function parseTags(raw) {
	const tags = /* @__PURE__ */ new Map();
	const tagStrings = raw.split(";");
	for (const tagString of tagStrings) {
		const [tagName, tagValue] = splitWithLimit(tagString, "=", 2);
		if (tagName === "") continue;
		tags.set(tagName, tagValue ? tagValue.replace(/\\(.?)/g, (_, match) => Object.prototype.hasOwnProperty.call(tagUnescapeMap, match) ? tagUnescapeMap[match] : match) : "");
	}
	return tags;
}
function parseMessage(rawLine, serverProperties = defaultServerProperties, knownCommands = all, isServer = false, nonConformingCommands = [], shouldParseParams = true) {
	const splitLine = rawLine.split(" ");
	let token;
	let command;
	const params = [];
	let tags = void 0;
	let prefix;
	while (splitLine.length) {
		[token] = splitLine;
		if (token.startsWith("@") && !tags && !command && !prefix) tags = parseTags(token.slice(1));
		else if (token.startsWith(":")) if (!prefix && !command) {
			if (token.length > 1) prefix = parsePrefix(token.slice(1));
		} else {
			params.push({
				value: splitLine.join(" ").slice(1),
				trailing: true
			});
			break;
		}
		else if (command) params.push({
			value: token,
			trailing: false
		});
		else command = token.toUpperCase();
		splitLine.shift();
	}
	tags || (tags = /* @__PURE__ */ new Map());
	if (!command) throw new Error(`line without command received: ${rawLine}`);
	shouldParseParams && (shouldParseParams = !nonConformingCommands.includes(command));
	let messageClass = Message;
	if (knownCommands.has(command)) messageClass = knownCommands.get(command);
	return new messageClass(command, {
		params,
		tags,
		prefix,
		rawLine
	}, {
		serverProperties,
		isServer,
		shouldParseParams
	});
}
//#endregion
//#region node_modules/.pnpm/ircv3@0.33.0/node_modules/ircv3/es/IrcClient.mjs
var IrcClient = class extends EventEmitter {
	constructor(options) {
		super();
		this._registered = false;
		this._supportsCapabilities = true;
		this._events = /* @__PURE__ */ new Map();
		this._registeredMessageTypes = /* @__PURE__ */ new Map();
		/**
		* @eventListener
		*/
		this.onConnect = this.registerEvent();
		/**
		* @eventListener
		*/
		this.onRegister = this.registerEvent();
		/**
		* @eventListener
		*/
		this.onDisconnect = this.registerEvent();
		/**
		* @eventListener
		*/
		this.onPrivmsg = this.registerEvent();
		/**
		* @eventListener
		*/
		this.onAction = this.registerEvent();
		/**
		* @eventListener
		*/
		this.onNotice = this.registerEvent();
		/**
		* @eventListener
		*/
		this.onNickChange = this.registerEvent();
		/**
		* @eventListener
		*/
		this.onCtcp = this.registerEvent();
		/**
		* @eventListener
		*/
		this.onCtcpReply = this.registerEvent();
		/**
		* @eventListener
		*/
		this.onPasswordError = this.registerEvent();
		/**
		* @eventListener
		*/
		this.onAnyMessage = this.registerEvent();
		this._serverProperties = klona(defaultServerProperties);
		this._supportedFeatures = {};
		this._collectors = [];
		this._clientCapabilities = /* @__PURE__ */ new Map();
		this._serverCapabilities = /* @__PURE__ */ new Map();
		this._negotiatedCapabilities = /* @__PURE__ */ new Map();
		this._currentChannels = /* @__PURE__ */ new Set();
		this._hasRegisteredBefore = false;
		this._channelsFromLastRegister = /* @__PURE__ */ new Set();
		this._initialConnectionSetupDone = false;
		const { connection, credentials, channels, channelTypes, webSocket, logger = {} } = options;
		this._options = options;
		const { pingOnInactivity = 60, pingTimeout = 10 } = connection;
		this._pingOnInactivity = pingOnInactivity;
		this._pingTimeout = pingTimeout;
		this._currentNick = credentials.nick;
		this._logger = createLogger({
			name: "ircv3",
			emoji: true,
			...logger
		});
		this.registerCoreMessageTypes();
		const { hostName, secure, reconnect = true } = connection;
		const connectionTarget = {
			hostName,
			port: this.port,
			secure
		};
		const connectionOptions = {
			lineBased: true,
			logger: this._logger,
			additionalOptions: options.connectionOptions
		};
		const ConnectionType = webSocket ? WebSocketConnection : DirectConnection;
		if (reconnect) this._connection = new PersistentConnection(ConnectionType, connectionTarget, connectionOptions);
		else this._connection = new ConnectionType(connectionOptions, this._logger, options.connectionOptions);
		for (const cap of Object.values(CoreCapabilities_exports)) this.addCapability(cap);
		this.addInternalListener(this.onRegister, async () => {
			const hasRegisteredBefore = this._hasRegisteredBefore;
			const channelsFromLastRegister = this._channelsFromLastRegister;
			this._hasRegisteredBefore = true;
			this._channelsFromLastRegister = /* @__PURE__ */ new Set();
			const resolvedChannels = hasRegisteredBefore && this._options.rejoinChannelsOnReconnect ? channelsFromLastRegister : await resolveConfigValue(channels);
			if (resolvedChannels) for (const channel of resolvedChannels) this.join(channel);
		});
		this.onTypedMessage(CapabilityNegotiation, async ({ subCommand, capabilities }) => {
			const caps = capabilities.split(" ");
			switch (subCommand.toUpperCase()) {
				case "NEW": {
					this._logger.debug(`Server registered new capabilities: ${caps.join(", ")}`);
					const capList = arrayToObject(caps, (part) => {
						if (!part) return {};
						const [cap, param] = splitWithLimit(part, "=", 2);
						return { [cap]: {
							name: cap,
							param: param || true
						} };
					});
					for (const [name, cap] of Object.entries(capList)) this._serverCapabilities.set(name, cap);
					const capNames = Object.keys(capList);
					await this._negotiateCapabilities(Array.from(this._clientCapabilities.entries()).filter(([name]) => capNames.includes(name)).map(([, cap]) => cap));
					break;
				}
				case "DEL":
					this._logger.debug(`Server removed capabilities: ${caps.join(", ")}`);
					for (const cap of caps) {
						this._serverCapabilities.delete(cap);
						this._negotiatedCapabilities.delete(cap);
					}
			}
		});
		this.onTypedMessage(Ping, ({ text }) => {
			this.sendMessage(Pong, { text });
		});
		this.onTypedMessage(Reply001Welcome, ({ me }) => this._handleReceivedClientNick(me));
		this.onTypedMessage(Reply004ServerInfo, ({ userModes }) => {
			if (userModes) this._serverProperties.supportedUserModes = userModes;
		});
		this.onTypedMessage(Reply005Isupport, ({ supports }) => {
			const newFeatures = arrayToObject(supports.split(" "), (part) => {
				const [support, param] = splitWithLimit(part, "=", 2);
				return { [support]: param || true };
			});
			this._supportedFeatures = {
				...this._supportedFeatures,
				...newFeatures
			};
		});
		this.onTypedMessage(Reply376EndOfMotd, ({ me }) => {
			if (!this._registered) {
				this._handleReceivedClientNick(me);
				this._registered = true;
				this.emit(this.onRegister);
			}
		});
		this.onTypedMessage(Error422NoMotd, ({ me }) => {
			if (!this._registered) {
				this._handleReceivedClientNick(me);
				this._registered = true;
				this.emit(this.onRegister);
			}
		});
		this.onTypedMessage(Error462AlreadyRegistered, ({ me }) => {
			if (!this._registered) {
				this._logger.warn("We thought we're not registered yet, but we actually are");
				this._handleReceivedClientNick(me);
				this._registered = true;
				this.emit(this.onRegister);
			}
		});
		this.onTypedMessage(PrivateMessage, (msg) => {
			var _a;
			const { target, text } = msg;
			const ctcpMessage = decodeCtcp(text);
			const nick = (_a = msg.prefix) === null || _a === void 0 ? void 0 : _a.nick;
			if (ctcpMessage) if (ctcpMessage.command === "ACTION") this.emit(this.onAction, target, nick, ctcpMessage.params, msg);
			else this.emit(this.onCtcp, target, nick, ctcpMessage.command, ctcpMessage.params, msg);
			else this.emit(this.onPrivmsg, target, nick, text, msg);
		});
		this.onTypedMessage(NickChange, (msg) => {
			var _a;
			const { nick: newNick } = msg;
			const oldNick = (_a = msg.prefix) === null || _a === void 0 ? void 0 : _a.nick;
			if (oldNick === this._currentNick) this._currentNick = newNick;
			this.emit(this.onNickChange, oldNick, newNick, msg);
		});
		this.onTypedMessage(Notice, (msg) => {
			var _a;
			const { target, text } = msg;
			const ctcpMessage = decodeCtcp(text);
			const nick = (_a = msg.prefix) === null || _a === void 0 ? void 0 : _a.nick;
			if (ctcpMessage) this.emit(this.onCtcpReply, target, nick, ctcpMessage.command, ctcpMessage.params, msg);
			this.emit(this.onNotice, target, nick, text, msg);
		});
		if (!this._options.manuallyAcknowledgeJoins) this.onTypedMessage(ChannelJoin, ({ channel, prefix }) => {
			if ((prefix === null || prefix === void 0 ? void 0 : prefix.nick) === this._currentNick) this.acknowledgeJoin(channel);
		});
		this.onTypedMessage(ChannelPart, (msg) => {
			var _a;
			if (((_a = msg.prefix) === null || _a === void 0 ? void 0 : _a.nick) === this._currentNick) {
				this._currentChannels.delete(msg.channel);
				this._channelsFromLastRegister.delete(msg.channel);
			}
		});
		this.addInternalListener(this.onRegister, () => this._startPingCheckTimer());
		this._desiredNick = credentials.nick;
		this._userName = credentials.userName;
		this._realName = credentials.realName;
		if (channelTypes) this._serverProperties.channelTypes = channelTypes;
	}
	receiveLine(line) {
		var _a;
		this._logger.debug(`Received message: ${line}`);
		let parsedMessage;
		try {
			parsedMessage = parseMessage(line, this._serverProperties, this._registeredMessageTypes, true, this._options.nonConformingCommands);
		} catch (e) {
			this._logger.error(`Error parsing message: ${e.message}`);
			this._logger.trace((_a = e.stack) !== null && _a !== void 0 ? _a : "No stack available");
			return;
		}
		this._logger.trace(`Parsed message: ${JSON.stringify(parsedMessage)}`);
		this._startPingCheckTimer();
		this.emit(this.onAnyMessage, parsedMessage);
		this._handleEvents(parsedMessage);
	}
	get serverProperties() {
		return klona(this._serverProperties);
	}
	get port() {
		const { webSocket, connection: { port, secure } } = this._options;
		if (port) return port;
		if (webSocket) return secure ? 443 : 80;
		return secure ? 6697 : 6667;
	}
	pingCheck() {
		const now = Date.now();
		const nowStr = now.toString();
		const handler = this.onTypedMessage(Pong, (msg) => {
			const { text } = msg;
			if (text === nowStr) {
				this._logger.debug(`Current ping: ${Date.now() - now}ms`);
				if (this._pingTimeoutTimer) clearTimeout(this._pingTimeoutTimer);
				this.removeMessageListener(handler);
			}
		});
		this._pingTimeoutTimer = setTimeout(() => {
			this.removeMessageListener(handler);
			if (this._options.connection.reconnect === false) this._logger.error(`Disconnecting because the last ping took over ${this._pingTimeout} seconds`);
			else this._logger.warn(`Reconnecting because the last ping took over ${this._pingTimeout} seconds`);
			this._connection.assumeExternalDisconnect();
		}, this._pingTimeout * 1e3);
		this.sendMessage(Ping, { text: nowStr });
	}
	reconnect(message) {
		this.quit(message);
		this.connect();
	}
	registerMessageType(cls) {
		if (cls.COMMAND !== "") {
			this._logger.trace(`Registering message type ${cls.COMMAND}`);
			this._registeredMessageTypes.set(cls.COMMAND.toUpperCase(), cls);
		}
	}
	knowsCommand(command) {
		return this._registeredMessageTypes.has(command.toUpperCase());
	}
	getCommandClass(command) {
		return this._registeredMessageTypes.get(command.toUpperCase());
	}
	acknowledgeJoin(channel) {
		this._currentChannels.add(channel);
		this._channelsFromLastRegister.add(channel);
	}
	connect() {
		this._supportsCapabilities = false;
		this._negotiatedCapabilities = /* @__PURE__ */ new Map();
		this._currentChannels = /* @__PURE__ */ new Set();
		this._currentNick = this._desiredNick;
		this._setupConnection();
		this._logger.info(`Connecting to ${this._options.connection.hostName}:${this.port}`);
		this._connection.connect();
	}
	addCapability(cap) {
		this._clientCapabilities.set(cap.name, cap);
		if (cap.messageTypes) for (const messageType of Object.values(cap.messageTypes)) this.registerMessageType(messageType);
	}
	async registerCapability(cap) {
		this.addCapability(cap);
		if (this._serverCapabilities.has(cap.name)) return await this._negotiateCapabilities([cap]);
		return [];
	}
	send(message) {
		this.sendRaw(message.toString());
	}
	sendRaw(line) {
		if (this._connection.isConnected) {
			this._logger.debug(`Sending message: ${line}`);
			this._connection.sendLine(line);
		}
	}
	onNamedMessage(commandName, handler, handlerName) {
		if (!this._events.has(commandName)) this._events.set(commandName, /* @__PURE__ */ new Map());
		const handlerList = this._events.get(commandName);
		if (!handlerName) do
			handlerName = `${commandName}:${padLeft(Math.random() * 1e4, 4, "0")}`;
		while (handlerList.has(handlerName));
		handlerList.set(handlerName, handler);
		return handlerName;
	}
	onTypedMessage(type, handler, handlerName) {
		return this.onNamedMessage(type.COMMAND, handler, handlerName);
	}
	removeMessageListener(handlerName) {
		const [commandName] = handlerName.split(":");
		if (!this._events.has(commandName)) return;
		this._events.get(commandName).delete(handlerName);
	}
	createMessage(type, params, tags) {
		return createMessage(type, params, void 0, tags ? new Map(Object.entries(tags)) : void 0, this.serverProperties);
	}
	sendMessage(type, params, tags) {
		this.send(this.createMessage(type, params, tags));
	}
	async sendMessageAndCaptureReply(type, params) {
		if (!type.SUPPORTS_CAPTURE) throw new Error(`The command "${type.COMMAND}" does not support reply capture`);
		const message = this.createMessage(type, params);
		const promise = this.collect(message).promise();
		this.send(message);
		return await promise;
	}
	get isConnected() {
		return this._connection.isConnected;
	}
	get isConnecting() {
		return this._connection.isConnecting;
	}
	get isRegistered() {
		return this._registered;
	}
	get currentNick() {
		return this._currentNick;
	}
	get currentChannels() {
		return Array.from(this._currentChannels);
	}
	/** @private */
	collect(originalMessage, ...types) {
		const collector = new MessageCollector(this, originalMessage, ...types);
		this._collectors.push(collector);
		return collector;
	}
	/** @private */
	stopCollect(collector) {
		this._collectors.splice(this._collectors.findIndex((value) => value === collector), 1);
	}
	join(channel, key) {
		this.sendMessage(ChannelJoin, {
			channel,
			key
		});
	}
	part(channel) {
		this.sendMessage(ChannelPart, { channel });
	}
	quit(text) {
		this.sendMessage(ClientQuit, { text });
		this.quitAbruptly();
	}
	quitAbruptly() {
		this._registered = false;
		this._connection.disconnect();
	}
	say(target, text, tags = {}) {
		this.sendMessage(PrivateMessage, {
			target,
			text
		}, tags);
	}
	sendCtcp(target, type, message) {
		this.say(target, `\x01${type.toUpperCase()} ${message}\x01`);
	}
	action(target, message) {
		this.sendCtcp(target, "ACTION", message);
	}
	changeNick(newNick) {
		if (this._currentNick === newNick) return;
		this._desiredNick = newNick;
		if (this.isRegistered) this.sendMessage(NickChange, { nick: newNick });
	}
	registerCoreMessageTypes() {
		forEachObjectEntry(Commands_exports, (type) => {
			this.registerMessageType(type);
		});
		forEachObjectEntry(Numerics_exports, (type) => {
			this.registerMessageType(type);
		});
	}
	async _negotiateCapabilityBatch(capabilities) {
		return await Promise.all(capabilities.filter((list) => list.length).map(async (capList) => await this._negotiateCapabilities(capList)));
	}
	async _negotiateCapabilities(capList) {
		const mappedCapList = arrayToObject(capList, (cap) => ({ [cap.name]: cap }));
		const capReply = (await this.sendMessageAndCaptureReply(CapabilityNegotiation, {
			subCommand: "REQ",
			capabilities: capList.map((cap) => cap.name).join(" ")
		})).shift();
		if (!capReply) throw new Error("capability negotiation failed unexpectedly without any reply");
		if (!(capReply instanceof CapabilityNegotiation)) throw new Error(`capability negotiation failed unexpectedly with "${capReply.command}" command`);
		const negotiatedCapNames = capReply.capabilities.split(" ").filter((c) => c);
		if (capReply.subCommand === "ACK") {
			this._logger.debug(`Successfully negotiated capabilities: ${negotiatedCapNames.join(", ")}`);
			const newNegotiatedCaps = negotiatedCapNames.map((capName) => mappedCapList[capName]);
			for (const newCap of newNegotiatedCaps) {
				const mergedCap = this._clientCapabilities.get(newCap.name);
				mergedCap.param = newCap.param;
				this._negotiatedCapabilities.set(mergedCap.name, mergedCap);
			}
			return newNegotiatedCaps;
		}
		this._logger.warn(`Failed to negotiate capabilities: ${negotiatedCapNames.join(", ")}`);
		return /* @__PURE__ */ new Error("capabilities failed to negotiate");
	}
	_setupConnection() {
		if (this._initialConnectionSetupDone) return;
		this._connection.onConnect(async () => {
			var _a, _b;
			this._logger.info(`Connection to server ${this._options.connection.hostName}:${this.port} established`);
			this.emit(this.onConnect);
			this._logger.debug("Determining connection password");
			try {
				const [password] = await Promise.all([resolveConfigValue(this._options.credentials.password), this.sendMessageAndCaptureReply(CapabilityNegotiation, {
					subCommand: "LS",
					version: "302"
				}).then(async (capReply) => {
					if (!capReply.length || !(capReply[0] instanceof CapabilityNegotiation)) {
						this._logger.debug("Server does not support capabilities");
						return [];
					}
					this._supportsCapabilities = true;
					const capLists = capReply.map((line) => arrayToObject(line.capabilities.split(" "), (part) => {
						if (!part) return {};
						const [cap, param] = splitWithLimit(part, "=", 2);
						return { [cap]: {
							name: cap,
							param: param || true
						} };
					}));
					this._serverCapabilities = new Map(Object.entries(Object.assign({}, ...capLists)));
					this._logger.debug(`Capabilities supported by server: ${Array.from(this._serverCapabilities.keys()).join(", ")}`);
					const capabilitiesToNegotiate = capLists.map((list) => {
						const capNames = Object.keys(list);
						return Array.from(this._clientCapabilities.entries()).filter(([name]) => capNames.includes(name)).map(([, cap]) => cap);
					});
					return await this._negotiateCapabilityBatch(capabilitiesToNegotiate);
				}).then(() => {
					this.sendMessage(CapabilityNegotiation, { subCommand: "END" });
				})]);
				if (password) this.sendMessage(Password, { password });
				this.sendMessage(NickChange, { nick: this._desiredNick });
				this.sendMessage(UserRegistration, {
					user: (_a = this._userName) !== null && _a !== void 0 ? _a : this._desiredNick,
					mode: "8",
					unused: "*",
					realName: (_b = this._realName) !== null && _b !== void 0 ? _b : this._desiredNick
				});
			} catch (e) {
				this.emit(this.onPasswordError, e);
				this.quit();
			}
		});
		this._initialConnectionSetupDone = true;
		this._connection.onReceive((line) => {
			this.receiveLine(line);
		});
		this._connection.onDisconnect((manually, reason) => {
			var _a;
			this._registered = false;
			if (this._pingCheckTimer) clearTimeout(this._pingCheckTimer);
			if (this._pingTimeoutTimer) clearTimeout(this._pingTimeoutTimer);
			if (manually) this._logger.info("Disconnected");
			else {
				const willReconnect = (_a = this._options.connection.reconnect) !== null && _a !== void 0 ? _a : true;
				const message = reason ? `Disconnected unexpectedly: ${reason.message}` : "Disconnected unexpectedly";
				if (willReconnect) this._logger.warn(`${message}; trying to reconnect`);
				else this._logger.error(message);
			}
			this.emit(this.onDisconnect, manually, reason);
		});
		this._connection.onEnd((manually) => {
			if (!manually) this._logger.warn("No further retries will be made");
		});
	}
	_handleReceivedClientNick(me) {
		if (this._currentNick !== me) {
			if (this._currentNick !== "") this._logger.warn(`Mismatching nicks: passed ${this._currentNick}, but you're actually ${me}`);
			this._currentNick = me;
		}
	}
	_handleEvents(message) {
		this._collectors.some((collector) => collector.collect(message));
		const handlers = this._events.get(message.constructor.COMMAND);
		if (!handlers) return;
		for (const handler of handlers.values()) handler(message);
	}
	_startPingCheckTimer() {
		if (this._pingCheckTimer) clearTimeout(this._pingCheckTimer);
		if (this._connection.isConnected) this._pingCheckTimer = setTimeout(() => this.pingCheck(), this._pingOnInactivity * 1e3);
		else this._pingCheckTimer = void 0;
	}
};
__decorate([Enumerable(false)], IrcClient.prototype, "_options", void 0);
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/caps/twitchCommands/messageTypes/ClearChat.js
var ClearChat = class extends Message {
	static COMMAND = "CLEARCHAT";
	constructor(command, contents, config) {
		super(command, contents, config, {
			channel: { type: "channel" },
			user: {
				trailing: true,
				optional: true
			}
		});
	}
	get date() {
		const timestamp = this._tags.get("tmi-sent-ts");
		return new Date(Number(timestamp));
	}
	get channelId() {
		return this._tags.get("room-id");
	}
	get targetUserId() {
		return this._tags.get("target-user-id") ?? null;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/caps/twitchCommands/messageTypes/Reconnect.js
/** @private */
var Reconnect = class extends Message {
	static COMMAND = "RECONNECT";
};
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/caps/twitchCommands/messageTypes/RoomState.js
var RoomState = class extends Message {
	static COMMAND = "ROOMSTATE";
	constructor(command, contents, config) {
		super(command, contents, config, { channel: { type: "channel" } });
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+cache-decorators@4.0.1/node_modules/@d-fischer/cache-decorators/es/utils/createCacheKey.mjs
function createSingleCacheKey(param) {
	switch (typeof param) {
		case "undefined": return "";
		case "object": {
			if (param === null) return "";
			if ("cacheKey" in param) return param.cacheKey;
			const objKey = JSON.stringify(param);
			if (objKey !== "{}") return objKey;
		}
		default: return param.toString();
	}
}
function createCacheKey(propName, params, prefix) {
	return [propName, ...params.map(createSingleCacheKey)].join("/") + (prefix ? "/" : "");
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+cache-decorators@4.0.1/node_modules/@d-fischer/cache-decorators/es/decorators/Cacheable.mjs
const cacheSymbol = Symbol("cache");
function Cacheable(cls) {
	var _a, _b;
	return _b = class extends cls {
		constructor() {
			super(...arguments);
			this[_a] = /* @__PURE__ */ new Map();
		}
		getFromCache(cacheKey) {
			this._cleanCache();
			if (this[cacheSymbol].has(cacheKey)) {
				const entry = this[cacheSymbol].get(cacheKey);
				if (entry) return entry.value;
			}
		}
		setCache(cacheKey, value, timeInSeconds) {
			this[cacheSymbol].set(cacheKey, {
				value,
				expires: Date.now() + timeInSeconds * 1e3
			});
		}
		removeFromCache(cacheKey, prefix) {
			const internalCacheKey = this._getInternalCacheKey(cacheKey, prefix);
			if (prefix) this[cacheSymbol].forEach((val, key) => {
				if (key.startsWith(internalCacheKey)) this[cacheSymbol].delete(key);
			});
			else this[cacheSymbol].delete(internalCacheKey);
		}
		_cleanCache() {
			const now = Date.now();
			this[cacheSymbol].forEach((val, key) => {
				if (val.expires < now) this[cacheSymbol].delete(key);
			});
		}
		_getInternalCacheKey(cacheKey, prefix) {
			if (typeof cacheKey === "string") {
				let internalCacheKey = cacheKey;
				if (!internalCacheKey.endsWith("/")) internalCacheKey += "/";
				return internalCacheKey;
			} else return createCacheKey(cacheKey.shift(), cacheKey, prefix);
		}
	}, _a = cacheSymbol, _b;
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+cache-decorators@4.0.1/node_modules/@d-fischer/cache-decorators/es/decorators/CachedGetter.mjs
function CachedGetter(timeInSeconds = Infinity) {
	return function(target, propName, descriptor) {
		if (descriptor.get) {
			const origFn = descriptor.get;
			descriptor.get = function() {
				const cacheKey = createCacheKey(propName, []);
				const cachedValue = this.getFromCache(cacheKey);
				if (cachedValue) return cachedValue;
				const result = origFn.call(this);
				this.setCache(cacheKey, result, timeInSeconds);
				return result;
			};
		}
		return descriptor;
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/ChatUser.js
var ChatUser_1;
/**
* A user in chat.
*/
let ChatUser = ChatUser_1 = class ChatUser {
	/** @internal */ _userData;
	_userName;
	/** @internal */
	constructor(userName, userData) {
		this._userName = userName.toLowerCase();
		this._userData = userData ? new Map(userData) : /* @__PURE__ */ new Map();
	}
	static _parseBadgesLike(badgesLikeStr) {
		if (!badgesLikeStr) return /* @__PURE__ */ new Map();
		return new Map(badgesLikeStr.split(",").map((badge) => {
			const slashIndex = badge.indexOf("/");
			if (slashIndex === -1) return [badge, ""];
			return [badge.slice(0, slashIndex), badge.slice(slashIndex + 1)];
		}));
	}
	/**
	* The name of the user.
	*/
	get userName() {
		return this._userName;
	}
	/**
	* The display name of the user.
	*/
	get displayName() {
		return this._userData.get("display-name") ?? this._userName;
	}
	/**
	* The color the user chose to display in chat.
	*
	* Returns undefined if the user didn't choose a color.
	* In this case, you should generate your own color for this user and stick to it at least for one runtime.
	*/
	get color() {
		return this._userData.get("color");
	}
	/**
	* The badges of the user. Returned as a map that maps the badge category to the detail.
	*/
	get badges() {
		const badgesStr = this._userData.get("badges");
		return ChatUser_1._parseBadgesLike(badgesStr);
	}
	/**
	* The badge info of the user. Returned as a map that maps the badge category to the detail.
	*/
	get badgeInfo() {
		const badgeInfoStr = this._userData.get("badge-info");
		return ChatUser_1._parseBadgesLike(badgeInfoStr);
	}
	/**
	* The ID of the user.
	*/
	get userId() {
		return this._userData.get("user-id");
	}
	/**
	* The type of the user.
	* Possible values are undefined, 'mod', 'global_mod', 'admin' and 'staff'.
	*/
	get userType() {
		return this._userData.get("user-type");
	}
	/**
	* Whether the user is the broadcaster.
	*/
	get isBroadcaster() {
		return this.badges.has("broadcaster");
	}
	/**
	* Whether the user is subscribed to the channel.
	*/
	get isSubscriber() {
		return this.badges.has("subscriber") || this.isFounder;
	}
	/**
	* Whether the user is a Founder of the channel.
	*/
	get isFounder() {
		return this.badges.has("founder");
	}
	/**
	* Whether the user is a moderator of the channel.
	*/
	get isMod() {
		return this.badges.has("moderator") || this.isLeadMod;
	}
	/**
	* Whether the user is a lead moderator of the channel.
	*/
	get isLeadMod() {
		return this.badges.has("lead_moderator");
	}
	/**
	* Whether the user is a VIP in the channel.
	*/
	get isVip() {
		const badgeValue = this._userData.get("vip");
		return badgeValue != null && badgeValue !== "0";
	}
	/**
	* Whether the user is an artist of the channel.
	*/
	get isArtist() {
		return this.badges.has("artist-badge");
	}
};
__decorate([Enumerable(false)], ChatUser.prototype, "_userData", void 0);
__decorate([CachedGetter()], ChatUser.prototype, "badges", null);
__decorate([CachedGetter()], ChatUser.prototype, "badgeInfo", null);
ChatUser = ChatUser_1 = __decorate([Cacheable, rtfm("chat", "ChatUser", "userId")], ChatUser);
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/utils/emoteUtil.js
/**
* Parses an emote offset string into a map that maps emote IDs to their position ranges.
*
* @param emotes The emote offset string.
*/
function parseEmoteOffsets(emotes) {
	if (!emotes) return /* @__PURE__ */ new Map();
	return new Map(emotes.split("/").map((emote) => {
		const [emoteId, placements] = emote.split(":", 2);
		if (!placements) return null;
		return [emoteId, placements.split(",")];
	}).filter((e) => e !== null));
}
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/caps/twitchCommands/messageTypes/UserNotice.js
var UserNotice = class extends Message {
	static COMMAND = "USERNOTICE";
	constructor(command, contents, config) {
		super(command, contents, config, {
			channel: { type: "channel" },
			text: {
				trailing: true,
				optional: true
			}
		});
	}
	get id() {
		return this._tags.get("id");
	}
	get date() {
		const timestamp = this._tags.get("tmi-sent-ts");
		return new Date(Number(timestamp));
	}
	get userInfo() {
		return new ChatUser(this._tags.get("login"), this._tags);
	}
	get channelId() {
		return this._tags.get("room-id") ?? null;
	}
	get emoteOffsets() {
		return parseEmoteOffsets(this._tags.get("emotes"));
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/caps/twitchCommands/messageTypes/UserState.js
/** @private */
var UserState = class extends Message {
	static COMMAND = "USERSTATE";
	constructor(command, contents, config) {
		super(command, contents, config, { channel: { type: "channel" } });
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/caps/twitchCommands/messageTypes/Whisper.js
/** @private */
var Whisper = class extends Message {
	static COMMAND = "WHISPER";
	constructor(command, contents, config) {
		super(command, contents, config, {
			target: {},
			text: { trailing: true }
		});
	}
	get userInfo() {
		return new ChatUser(this._prefix.nick, this._tags);
	}
	get emoteOffsets() {
		return parseEmoteOffsets(this._tags.get("emotes"));
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/caps/twitchCommands/index.js
/** @internal */
const TwitchCommandsCapability = {
	name: "twitch.tv/commands",
	messageTypes: [
		ClearChat,
		Reconnect,
		RoomState,
		UserNotice,
		UserState,
		Whisper
	]
};
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/caps/TwitchMembershipCapability.js
/**
* This capability just enables standard IRC commands that Twitch chose to disable by default.
* It has no message types on its own.
*
* @internal
*/
const TwitchMembershipCapability = { name: "twitch.tv/membership" };
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/caps/twitchTags/messageTypes/ClearMsg.js
var ClearMsg = class extends Message {
	static COMMAND = "CLEARMSG";
	constructor(command, contents, config) {
		super(command, contents, config, {
			channel: { type: "channel" },
			text: { trailing: true }
		});
	}
	get date() {
		const timestamp = this._tags.get("tmi-sent-ts");
		return new Date(Number(timestamp));
	}
	get userName() {
		return this._tags.get("login");
	}
	get channelId() {
		return this._tags.get("room-id");
	}
	get targetMessageId() {
		return this._tags.get("target-msg-id");
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/caps/twitchTags/messageTypes/GlobalUserState.js
/**
* This command has no parameters, all information is in tags.
*
* @private
*/
var GlobalUserState = class extends Message {
	static COMMAND = "GLOBALUSERSTATE";
};
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/caps/twitchTags/index.js
/**
* This capability mostly just adds tags to existing commands.
*
* @internal
*/
const TwitchTagsCapability = {
	name: "twitch.tv/tags",
	messageTypes: [GlobalUserState, ClearMsg]
};
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/commands/ChatMessage.js
const HYPE_CHAT_LEVELS = [
	"ONE",
	"TWO",
	"THREE",
	"FOUR",
	"FIVE",
	"SIX",
	"SEVEN",
	"EIGHT",
	"NINE",
	"TEN"
];
/**
* A regular chat message.
*/
let ChatMessage = class ChatMessage extends PrivateMessage {
	/**
	* The ID of the message.
	*/
	get id() {
		return this._tags.get("id");
	}
	/**
	* The date the message was sent at.
	*/
	get date() {
		const timestamp = this._tags.get("tmi-sent-ts");
		return new Date(Number(timestamp));
	}
	/**
	* Info about the user that send the message, like their user ID and their status in the current channel.
	*/
	get userInfo() {
		return new ChatUser(this._prefix.nick, this._tags);
	}
	/**
	* The ID of the channel the message is in.
	*/
	get channelId() {
		return this._tags.get("room-id") ?? null;
	}
	/**
	* Whether the message is a cheer.
	*/
	get isCheer() {
		return this._tags.has("bits");
	}
	/**
	* Whether the message represents a redemption of a custom channel points reward.
	*/
	get isRedemption() {
		return Boolean(this._tags.get("custom-reward-id"));
	}
	/**
	* The ID of the redeemed reward, or `null` if the message does not represent a redemption.
	*/
	get rewardId() {
		return this._tags.get("custom-reward-id") || null;
	}
	/**
	* Whether the message is the first message of the chatter who sent it.
	*/
	get isFirst() {
		return this._tags.get("first-msg") === "1";
	}
	/**
	* Whether the message is sent by a returning chatter.
	*
	* Twitch defines this as a new viewer who has chatted at least twice in the last 30 days.
	*/
	get isReturningChatter() {
		return this._tags.get("returning-chatter") === "1";
	}
	/**
	* Whether the message is highlighted by using channel points.
	*/
	get isHighlight() {
		return this._tags.get("msg-id") === "highlighted-message";
	}
	/**
	* Whether the message is a reply to another message.
	*/
	get isReply() {
		return this._tags.has("reply-parent-msg-id");
	}
	/**
	* The ID of the message that this message is a reply to, or `null` if it's not a reply.
	*/
	get parentMessageId() {
		return this._tags.get("reply-parent-msg-id") ?? null;
	}
	/**
	* The text of the message that this message is a reply to, or `null` if it's not a reply.
	*/
	get parentMessageText() {
		return this._tags.get("reply-parent-msg-body") ?? null;
	}
	/**
	* The ID of the user that wrote the message that this message is a reply to, or `null` if it's not a reply.
	*/
	get parentMessageUserId() {
		return this._tags.get("reply-parent-user-id") ?? null;
	}
	/**
	* The name of the user that wrote the message that this message is a reply to, or `null` if it's not a reply.
	*/
	get parentMessageUserName() {
		return this._tags.get("reply-parent-user-login") ?? null;
	}
	/**
	* The display name of the user that wrote the message that this message is a reply to, or `null` if it's not a reply.
	*/
	get parentMessageUserDisplayName() {
		return this._tags.get("reply-parent-display-name") ?? null;
	}
	/**
	* The ID of the message that is the thread starter of this message, or `null` if it's not a reply.
	*/
	get threadMessageId() {
		return this._tags.get("reply-thread-parent-msg-id") ?? null;
	}
	/**
	* The ID of the user that wrote the thread starter message of this message, or `null` if it's not a reply.
	*/
	get threadMessageUserId() {
		return this._tags.get("reply-thread-parent-user-id") ?? null;
	}
	/**
	* The number of bits cheered with the message.
	*/
	get bits() {
		return Number(this._tags.get("bits") ?? 0);
	}
	/**
	* The offsets of emote usages in the message.
	*/
	get emoteOffsets() {
		return parseEmoteOffsets(this._tags.get("emotes"));
	}
	/**
	* Whether the message is a Hype Chat.
	*/
	get isHypeChat() {
		return this._tags.has("pinned-chat-paid-amount");
	}
	/**
	* The amount of money that was sent for Hype Chat, specified in the currency’s minor unit,
	* or `null` if the message is not a Hype Chat.
	*
	* For example, the minor units for USD is cents, so if the amount is $5.50 USD, `value` is set to 550.
	*/
	get hypeChatAmount() {
		return mapNullable(this._tags.get("pinned-chat-paid-amount"), Number);
	}
	/**
	* The number of decimal places used by the currency used for Hype Chat,
	* or `null` if the message is not a Hype Chat.
	*
	* For example, USD uses two decimal places.
	* Use this number to translate `hypeChatAmount` from minor units to major units by using the formula:
	*
	* `value / 10^decimalPlaces`
	*/
	get hypeChatDecimalPlaces() {
		return mapNullable(this._tags.get("pinned-chat-paid-exponent"), Number);
	}
	/**
	* The localized amount of money sent for Hype Chat, based on the value and the decimal places of the currency,
	* or `null` if the message is not a Hype Chat.
	*
	* For example, the minor units for USD is cents which uses two decimal places,
	* so if `value` is 550, `localizedValue` is set to 5.50.
	*/
	get hypeChatLocalizedAmount() {
		const amount = this.hypeChatAmount;
		if (!amount) return null;
		return amount / 10 ** this.hypeChatDecimalPlaces;
	}
	/**
	* The ISO-4217 three-letter currency code that identifies the currency used for Hype Chat,
	* or `null` if the message is not a Hype Chat.
	*/
	get hypeChatCurrency() {
		return this._tags.get("pinned-chat-paid-currency") ?? null;
	}
	/**
	* The level of the Hype Chat, or `null` if the message is not a Hype Chat.
	*/
	get hypeChatLevel() {
		const levelString = this._tags.get("pinned-chat-paid-level");
		if (!levelString) return null;
		return HYPE_CHAT_LEVELS.indexOf(levelString) + 1;
	}
	/**
	* Whether the system filled in the message for the Hype Chat (because the user didn't type one),
	* or `null` if the message is not a Hype Chat.
	*/
	get hypeChatIsSystemMessage() {
		const flagString = this._tags.get("pinned-chat-paid-is-system-message");
		if (!flagString) return null;
		return Boolean(Number(flagString));
	}
};
ChatMessage = __decorate([rtfm("chat", "ChatMessage", "id")], ChatMessage);
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/ChatMessageAttributes.js
/** @private */
function extractMessageId(message) {
	return message instanceof ChatMessage ? message.tags.get("id") : message;
}
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/utils/messageUtil.js
function splitOnSpaces(text, maxMsgLength) {
	if (text.length <= maxMsgLength) return [text];
	text = text.trim();
	const res = [];
	let startIndex = 0;
	let endIndex = maxMsgLength;
	while (startIndex < text.length) {
		let spaceIndex = text.lastIndexOf(" ", endIndex);
		if (spaceIndex === -1 || spaceIndex <= startIndex || text.length - startIndex + 1 <= maxMsgLength) spaceIndex = startIndex + maxMsgLength;
		const textSlice = text.slice(startIndex, spaceIndex).trim();
		if (textSlice.length) res.push(textSlice);
		startIndex = spaceIndex + (text[spaceIndex] === " " ? 1 : 0);
		endIndex = startIndex + maxMsgLength;
	}
	return res;
}
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/utils/userUtil.js
const validNames = /^[a-z0-9][a-z0-9_]{0,24}$/;
/**
* Converts a chat-compatible channel name to an API-compatible username.
*
* @param channel The name of the channel.
*/
function toUserName(channel) {
	const name = channel.replace(/^#/, "").toLowerCase();
	if (!validNames.test(name)) throw new Error(`"${name}" is not a valid user or channel name. It must be at most 25 characters long, can only include letters, numbers and underscores, and can not start with an underscore.`);
	return name;
}
/**
* Converts an API-compatible username to a chat-compatible channel name.
*
* @param user The name of the user.
*/
function toChannelName(user) {
	return `#${toUserName(user)}`;
}
//#endregion
//#region node_modules/.pnpm/@twurple+chat@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/chat/lib/ChatClient.js
var ChatClient_1;
/**
* An interface to Twitch chat.
*/
let ChatClient = ChatClient_1 = class ChatClient extends EventEmitter {
	/** @internal */ _authProvider;
	_useLegacyScopes;
	_readOnly;
	_authIntents;
	_authToken;
	_authVerified = false;
	_authRetryTimer;
	_authRetryCount = 0;
	_chatLogger;
	_isAlwaysMod;
	_botLevel;
	_messageRateLimiter;
	_joinRateLimiter;
	_ircClient;
	/**
	* Fires when the client successfully connects to the chat server.
	*
	* @eventListener
	*/
	onConnect = this.registerEvent();
	/**
	* Fires when the client disconnects from the chat server.
	*
	* @eventListener
	* @param manually Whether the disconnect was requested by the user.
	* @param reason The error that caused the disconnect, or `undefined` if there was no error.
	*/
	onDisconnect = this.registerEvent();
	/**
	* Fires when a user is timed out from a channel.
	*
	* @eventListener
	* @param channel The channel the user is timed out from.
	* @param user The timed out user.
	* @param duration The duration of the timeout, in seconds.
	* @param msg The full message object containing all message and user information.
	*/
	onTimeout = this.registerEvent();
	/**
	* Fires when a user is permanently banned from a channel.
	*
	* @eventListener
	* @param channel The channel the user is banned from.
	* @param user The banned user.
	* @param msg The full message object containing all message and user information.
	*/
	onBan = this.registerEvent();
	/**
	* Fires when a user upgrades their bits badge in a channel.
	*
	* @eventListener
	* @param channel The channel where the bits badge was upgraded.
	* @param user The user that has upgraded their bits badge.
	* @param ritualInfo Additional information about the upgrade.
	* @param msg The full message object containing all message and user information.
	*/
	onBitsBadgeUpgrade = this.registerEvent();
	/**
	* Fires when the chat of a channel is cleared.
	*
	* @eventListener
	* @param channel The channel whose chat is cleared.
	* @param msg The full message object containing all message and user information.
	*/
	onChatClear = this.registerEvent();
	/**
	* Fires when emote-only mode is toggled in a channel.
	*
	* @eventListener
	* @param channel The channel where emote-only mode is being toggled.
	* @param enabled Whether emote-only mode is being enabled. If false, it's being disabled.
	*/
	onEmoteOnly = this.registerEvent();
	/**
	* Fires when followers-only mode is toggled in a channel.
	*
	* @eventListener
	* @param channel The channel where followers-only mode is being toggled.
	* @param enabled Whether followers-only mode is being enabled. If false, it's being disabled.
	* @param delay The time (in minutes) a user needs to follow the channel to be able to talk. Only available when `enabled === true`.
	*/
	onFollowersOnly = this.registerEvent();
	/**
	* Fires when a user joins a channel.
	*
	* The join/part events are cached by the Twitch chat server and will be batched and sent every 30-60 seconds.
	*
	* Please note that unless you enabled the `requestMembershipEvents` option, this will only react to your own joins.
	*
	* @eventListener
	* @param channel The channel that is being joined.
	* @param user The user that joined.
	*/
	onJoin = this.registerEvent();
	/**
	* Fires when you fail to join a channel.
	*
	* @eventListener
	* @param channel The channel that you tried to join.
	* @param reason The reason for the failure.
	*/
	onJoinFailure = this.registerEvent();
	/**
	* Fires when a user leaves ("parts") a channel.
	*
	* The join/part events are cached by the Twitch chat server and will be batched and sent every 30-60 seconds.
	*
	* Please note that unless you enabled the `requestMembershipEvents` option, this will only react to your own parts.
	*
	* @eventListener
	* @param channel The channel that is being left.
	* @param user The user that left.
	*/
	onPart = this.registerEvent();
	/**
	* Fires when a single message is removed from a channel.
	*
	* @eventListener
	* @param channel The channel where the message was removed.
	* @param messageId The ID of the message that was removed.
	* @param msg The full message object containing all message and user information.
	*
	* This is *not* the message that was removed. The text of the message is available using `msg.params.message` though.
	*/
	onMessageRemove = this.registerEvent();
	/**
	* Fires when unique chat mode is toggled in a channel.
	*
	* @eventListener
	* @param channel The channel where unique chat mode is being toggled.
	* @param enabled Whether unique chat mode is being enabled. If false, it's being disabled.
	*/
	onUniqueChat = this.registerEvent();
	/**
	* Fires when a user raids a channel.
	*
	* @eventListener
	* @param channel The channel that was raided.
	* @param user The user that has raided the channel.
	* @param raidInfo Additional information about the raid.
	* @param msg The full message object containing all message and user information.
	*/
	onRaid = this.registerEvent();
	/**
	* Fires when a user cancels a raid.
	*
	* @eventListener
	* @param channel The channel where the raid was cancelled.
	* @param msg The full message object containing all message and user information.
	*/
	onRaidCancel = this.registerEvent();
	/**
	* Fires when a user performs a "ritual" in a channel.
	*
	* @eventListener
	* @param channel The channel where the ritual was performed.
	* @param user The user that has performed the ritual.
	* @param ritualInfo Additional information about the ritual.
	* @param msg The full message object containing all message and user information.
	*/
	onRitual = this.registerEvent();
	/**
	* Fires when slow mode is toggled in a channel.
	*
	* @eventListener
	* @param channel The channel where slow mode is being toggled.
	* @param enabled Whether slow mode is being enabled. If false, it's being disabled.
	* @param delay The time (in seconds) a user has to wait between sending messages. Only set when enabling slow mode.
	*/
	onSlow = this.registerEvent();
	/**
	* Fires when sub only mode is toggled in a channel.
	*
	* @eventListener
	* @param channel The channel where sub only mode is being toggled.
	* @param enabled Whether sub only mode is being enabled. If false, it's being disabled.
	*/
	onSubsOnly = this.registerEvent();
	/**
	* Fires when a user subscribes to a channel.
	*
	* @eventListener
	* @param channel The channel that was subscribed to.
	* @param user The subscribing user.
	* @param subInfo Additional information about the subscription.
	* @param msg The full message object containing all message and user information.
	*/
	onSub = this.registerEvent();
	/**
	* Fires when a user resubscribes to a channel.
	*
	* @eventListener
	* @param channel The channel that was resubscribed to.
	* @param user The resubscribing user.
	* @param subInfo Additional information about the resubscription.
	* @param msg The full message object containing all message and user information.
	*/
	onResub = this.registerEvent();
	/**
	* Fires when a user gifts a subscription to a channel to another user.
	*
	* Community subs also fire multiple `onSubGift` events.
	* To prevent alert spam, check [Sub gift spam](/docs/examples/chat/sub-gift-spam).
	*
	* @eventListener
	* @param channel The channel that was subscribed to.
	* @param user The user that the subscription was gifted to. The gifting user is defined in `subInfo.gifter`.
	* @param subInfo Additional information about the subscription.
	* @param msg The full message object containing all message and user information.
	*/
	onSubGift = this.registerEvent();
	/**
	* Fires when a user gifts random subscriptions to the community of a channel.
	*
	* Community subs also fire multiple `onSubGift` events.
	* To prevent alert spam, check [Sub gift spam](/docs/examples/chat/sub-gift-spam).
	*
	* @eventListener
	* @param channel The channel that was subscribed to.
	* @param user The gifting user.
	* @param subInfo Additional information about the community subscription.
	* @param msg The full message object containing all message and user information.
	*/
	onCommunitySub = this.registerEvent();
	/**
	* Fires when a user extends their subscription using a Sub Token.
	*
	* @eventListener
	* @param channel The channel where the subscription was extended.
	* @param user The user that extended their subscription.
	* @param subInfo Additional information about the subscription extension.
	* @param msg The full message object containing all message and user information.
	*/
	onSubExtend = this.registerEvent();
	/**
	* Fires when a user gifts rewards during a special event.
	*
	* @eventListener
	* @param channel The channel where the rewards were gifted.
	* @param user The user that gifted the rewards.
	* @param rewardGiftInfo Additional information about the reward gift.
	* @param msg The full message object containing all message and user information.
	*/
	onRewardGift = this.registerEvent();
	/**
	* Fires when a user upgrades their Prime subscription to a paid subscription in a channel.
	*
	* @eventListener
	* @param channel The channel where the subscription was upgraded.
	* @param user The user that upgraded their subscription.
	* @param subInfo Additional information about the subscription upgrade.
	* @param msg The full message object containing all message and user information.
	*/
	onPrimePaidUpgrade = this.registerEvent();
	/**
	* Fires when a user upgrades their gift subscription to a paid subscription in a channel.
	*
	* @eventListener
	* @param channel The channel where the subscription was upgraded.
	* @param user The user that upgraded their subscription.
	* @param subInfo Additional information about the subscription upgrade.
	* @param msg The full message object containing all message and user information.
	*/
	onGiftPaidUpgrade = this.registerEvent();
	/**
	* Fires when a user gifts a Twitch Prime benefit to the channel.
	*
	* @eventListener
	* @param channel The channel where the benefit was gifted.
	* @param user The user that received the gift.
	*
	* **WARNING:** This is a *display name* and thus will not work as an identifier for the API (login) in some cases.
	* @param subInfo Additional information about the gift.
	* @param msg The full message object containing all message and user information.
	*/
	onPrimeCommunityGift = this.registerEvent();
	/**
	* Fires when a user pays forward a subscription that was gifted to them to a specific user.
	*
	* @eventListener
	* @param channel The channel where the gift was forwarded.
	* @param user The user that forwarded the gift.
	* @param forwardInfo Additional information about the gift.
	* @param msg The full message object containing all message and user information.
	*/
	onStandardPayForward = this.registerEvent();
	/**
	* Fires when a user pays forward a subscription that was gifted to them to the community.
	*
	* @eventListener
	* @param channel The channel where the gift was forwarded.
	* @param user The user that forwarded the gift.
	* @param forwardInfo Additional information about the gift.
	* @param msg The full message object containing all message and user information.
	*/
	onCommunityPayForward = this.registerEvent();
	/**
	* Fires when a user sends an announcement (/announce) to a channel.
	*
	* @eventListener
	* @param channel The channel the announcement was sent to.
	* @param user The user that sent the announcement.
	* @param announcementInfo Additional information about the announcement.
	* @param msg The full message object containing all message and user information.
	*/
	onAnnouncement = this.registerEvent();
	/**
	* Fires when receiving a whisper from another user.
	*
	* @eventListener
	* @param user The user that sent the whisper.
	* @param text The message text.
	* @param msg The full message object containing all message and user information.
	*/
	onWhisper = this.registerEvent();
	/**
	* Fires when you tried to execute a command you don't have sufficient permission for.
	*
	* @eventListener
	* @param channel The channel that a command without sufficient permissions was executed on.
	* @param text The message text.
	*/
	onNoPermission = this.registerEvent();
	/**
	* Fires when a message you tried to send gets rejected by the ratelimiter.
	*
	* @eventListener
	* @param channel The channel that was attempted to send to.
	* @param text The message text.
	*/
	onMessageRatelimit = this.registerEvent();
	/**
	* Fires when authentication succeeds.
	*
	* @eventListener
	*/
	onAuthenticationSuccess = this.registerEvent();
	/**
	* Fires when authentication fails.
	*
	* @eventListener
	* @param text The message text.
	* @param retryCount The number of authentication attempts, including this one, that failed in the current attempt to connect.
	*
	* Resets when authentication succeeds.
	*/
	onAuthenticationFailure = this.registerEvent();
	/**
	* Fires when fetching a token fails.
	*
	* @eventListener
	* @param error The error that was thrown.
	*/
	onTokenFetchFailure = this.registerEvent();
	/**
	* Fires when sending a message fails.
	*
	* @eventListener
	* @param channel The channel that rejected the message.
	* @param reason The reason for the failure, e.g. you're banned (msg_banned)
	*/
	onMessageFailed = this.registerEvent();
	/**
	* Fires when a user sends a message to a channel.
	*
	* @eventListener
	* @param channel The channel the message was sent to.
	* @param user The user that sent the message.
	* @param text The message text.
	* @param msg The full message object containing all message and user information.
	*/
	onMessage = this.registerEvent();
	/**
	* Fires when a user sends an action (/me) to a channel.
	*
	* @eventListener
	* @param channel The channel the action was sent to.
	* @param user The user that sent the action.
	* @param text The action text.
	* @param msg The full message object containing all message and user information.
	*/
	onAction = this.registerEvent();
	_onJoinResult = this.registerInternalEvent();
	/**
	* Creates a new Twitch chat client.
	*
	* @expandParams
	*
	* @param config
	*/
	constructor(config = {}) {
		if (config.authProvider && !config.authProvider.getAccessTokenForIntent) throw new InvalidTokenTypeError("You can not connect to chat using an AuthProvider that does not support intents.\nTo get an anonymous, read-only connection, please don't pass an `AuthProvider` at all.\nTo get a read-write connection, please provide an auth provider that provides user access tokens via intents, such as `RefreshingAuthProvider`.");
		super();
		this._ircClient = new IrcClient({
			connection: {
				hostName: config.hostName ?? (config.webSocket ?? true ? "irc-ws.chat.twitch.tv" : "irc.chat.twitch.tv"),
				secure: config.ssl ?? true
			},
			credentials: {
				nick: "",
				password: async () => await this._getAuthToken()
			},
			webSocket: config.webSocket ?? true,
			connectionOptions: config.connectionOptions,
			logger: {
				name: "twurple:chat:irc",
				...config.logger
			},
			nonConformingCommands: ["004"],
			manuallyAcknowledgeJoins: true,
			rejoinChannelsOnReconnect: config.rejoinChannelsOnReconnect
		});
		this._ircClient.onDisconnect((manually, reason) => {
			this._messageRateLimiter?.clear();
			this._messageRateLimiter?.pause();
			this._joinRateLimiter?.clear();
			this._joinRateLimiter?.pause();
			this.emit(this.onDisconnect, manually, reason);
		});
		this._ircClient.registerMessageType(ChatMessage);
		this._chatLogger = createLogger({
			name: "twurple:chat:twitch",
			...config.logger
		});
		this._authProvider = config.authProvider;
		this._useLegacyScopes = !!config.legacyScopes;
		this._readOnly = !!config.readOnly;
		this._authIntents = [...config.authIntents ?? [], "chat"];
		this._isAlwaysMod = config.isAlwaysMod ?? false;
		this._botLevel = config.botLevel ?? "none";
		this._ircClient.addCapability(TwitchTagsCapability);
		this._ircClient.addCapability(TwitchCommandsCapability);
		if (config.requestMembershipEvents) this._ircClient.addCapability(TwitchMembershipCapability);
		this._ircClient.onConnect(() => {
			this.emit(this.onConnect);
		});
		this._ircClient.onRegister(async () => {
			this._messageRateLimiter?.resume();
			this._joinRateLimiter?.resume();
			this._authVerified = true;
			this._authRetryTimer = void 0;
			this._authRetryCount = 0;
			this.emit(this.onAuthenticationSuccess);
			const resolvedChannels = await resolveConfigValue(config.channels);
			if (resolvedChannels) await Promise.all(resolvedChannels.map(async (channel) => {
				try {
					await this.join(channel);
				} catch (e) {
					this._chatLogger.warn(`Failed to join configured channel ${channel}; original message: ${e?.message ?? e}`);
				}
			}));
		});
		this._ircClient.onPasswordError((e) => {
			this._chatLogger.error(`Error fetching a token for connecting to the server: ${e.message}`);
			this.emit(this.onTokenFetchFailure, e);
		});
		this._ircClient.onPrivmsg((channel, user, text, msg) => {
			if (user !== "jtv") this.emit(this.onMessage, toUserName(channel), user, text, msg);
		});
		this._ircClient.onAction((channel, user, text, msg) => {
			this.emit(this.onAction, toUserName(channel), user, text, msg);
		});
		this.addInternalListener(this._onJoinResult, (channel, _, error) => {
			if (error) this.emit(this.onJoinFailure, toUserName(channel), error);
			else this._ircClient.acknowledgeJoin(channel);
		});
		this._ircClient.onTypedMessage(ClearChat, (msg) => {
			const { channel, user, tags } = msg;
			const broadcasterName = toUserName(channel);
			if (user) {
				const duration = tags.get("ban-duration");
				if (duration === void 0) this.emit(this.onBan, broadcasterName, user, msg);
				else this.emit(this.onTimeout, broadcasterName, user, Number(duration), msg);
			} else this.emit(this.onChatClear, broadcasterName, msg);
		});
		this._ircClient.onTypedMessage(ClearMsg, (msg) => {
			const { channel, targetMessageId } = msg;
			this.emit(this.onMessageRemove, toUserName(channel), targetMessageId, msg);
		});
		this._ircClient.onTypedMessage(ChannelJoin, ({ prefix, channel }) => {
			this.emit(this.onJoin, toUserName(channel), prefix.nick);
		});
		this._ircClient.onTypedMessage(ChannelPart, ({ prefix, channel }) => {
			this.emit(this.onPart, toUserName(channel), prefix.nick);
		});
		this._ircClient.onTypedMessage(RoomState, ({ channel, tags }) => {
			let isInitial = false;
			if (tags.has("subs-only") && tags.has("slow")) {
				this.emit(this._onJoinResult, channel, tags);
				isInitial = true;
			}
			if (!isInitial) {
				const broadcasterName = toUserName(channel);
				if (tags.has("slow")) {
					const slowDelay = Number(tags.get("slow"));
					if (slowDelay) this.emit(this.onSlow, broadcasterName, true, slowDelay);
					else this.emit(this.onSlow, broadcasterName, false);
				}
				if (tags.has("followers-only")) {
					const followDelay = Number(tags.get("followers-only"));
					if (followDelay === -1) this.emit(this.onFollowersOnly, broadcasterName, false);
					else this.emit(this.onFollowersOnly, broadcasterName, true, followDelay);
				}
			}
		});
		this._ircClient.onTypedMessage(UserNotice, (userNotice) => {
			const { channel, text: message, tags } = userNotice;
			const messageType = tags.get("msg-id");
			const broadcasterName = toUserName(channel);
			switch (messageType) {
				case "sub":
				case "resub": {
					const event = messageType === "sub" ? this.onSub : this.onResub;
					const plan = tags.get("msg-param-sub-plan");
					const streakMonths = tags.get("msg-param-streak-months");
					const subInfo = {
						userId: tags.get("user-id"),
						displayName: tags.get("display-name"),
						plan,
						planName: tags.get("msg-param-sub-plan-name"),
						isPrime: plan === "Prime",
						months: Number(tags.get("msg-param-cumulative-months")),
						streak: streakMonths ? Number(streakMonths) : void 0,
						message
					};
					if (tags.get("msg-param-was-gifted") === "true") {
						const wasAnonGift = tags.get("msg-param-anon-gift") === "true";
						const duration = Number(tags.get("msg-param-gift-months"));
						const redeemedMonth = Number(tags.get("msg-param-gift-month-being-redeemed"));
						if (wasAnonGift) subInfo.originalGiftInfo = {
							anonymous: true,
							duration,
							redeemedMonth
						};
						else subInfo.originalGiftInfo = {
							anonymous: false,
							duration,
							redeemedMonth,
							userId: tags.get("msg-param-gifter-id"),
							userName: tags.get("msg-param-gifter-login"),
							userDisplayName: tags.get("msg-param-gifter-name")
						};
					}
					this.emit(event, broadcasterName, tags.get("login"), subInfo, userNotice);
					break;
				}
				case "subgift": {
					const plan = tags.get("msg-param-sub-plan");
					const gifter = tags.get("login");
					const isAnon = gifter === "ananonymousgifter";
					const subInfo = {
						userId: tags.get("msg-param-recipient-id"),
						displayName: tags.get("msg-param-recipient-display-name"),
						gifter: isAnon ? void 0 : gifter,
						gifterUserId: isAnon ? void 0 : tags.get("user-id"),
						gifterDisplayName: isAnon ? void 0 : tags.get("display-name"),
						gifterGiftCount: isAnon ? void 0 : Number(tags.get("msg-param-sender-count")),
						giftDuration: Number(tags.get("msg-param-gift-months")),
						plan,
						planName: tags.get("msg-param-sub-plan-name"),
						isPrime: plan === "Prime",
						months: Number(tags.get("msg-param-months"))
					};
					this.emit(this.onSubGift, broadcasterName, tags.get("msg-param-recipient-user-name"), subInfo, userNotice);
					break;
				}
				case "submysterygift": {
					const gifter = tags.get("login");
					const isAnon = gifter === "ananonymousgifter";
					const communitySubInfo = {
						gifter: isAnon ? void 0 : gifter,
						gifterUserId: isAnon ? void 0 : tags.get("user-id"),
						gifterDisplayName: isAnon ? void 0 : tags.get("display-name"),
						gifterGiftCount: isAnon ? void 0 : Number(tags.get("msg-param-sender-count")),
						count: Number(tags.get("msg-param-mass-gift-count")),
						plan: tags.get("msg-param-sub-plan")
					};
					this.emit(this.onCommunitySub, broadcasterName, tags.get("login"), communitySubInfo, userNotice);
					break;
				}
				case "primepaidupgrade": {
					const upgradeInfo = {
						userId: tags.get("user-id"),
						displayName: tags.get("display-name"),
						plan: tags.get("msg-param-sub-plan")
					};
					this.emit(this.onPrimePaidUpgrade, broadcasterName, tags.get("login"), upgradeInfo, userNotice);
					break;
				}
				case "giftpaidupgrade": {
					const upgradeInfo = {
						userId: tags.get("user-id"),
						displayName: tags.get("display-name"),
						gifter: tags.get("msg-param-sender-login"),
						gifterDisplayName: tags.get("msg-param-sender-name")
					};
					this.emit(this.onGiftPaidUpgrade, broadcasterName, tags.get("login"), upgradeInfo, userNotice);
					break;
				}
				case "standardpayforward": {
					const wasAnon = tags.get("msg-param-prior-gifter-anonymous") === "true";
					const forwardInfo = {
						userId: tags.get("user-id"),
						displayName: tags.get("display-name"),
						originalGifterUserId: wasAnon ? void 0 : tags.get("msg-param-prior-gifter-id"),
						originalGifterDisplayName: wasAnon ? void 0 : tags.get("msg-param-prior-gifter-display-name"),
						recipientUserId: tags.get("msg-param-recipient-id"),
						recipientDisplayName: tags.get("msg-param-recipient-display-name")
					};
					this.emit(this.onStandardPayForward, broadcasterName, tags.get("login"), forwardInfo, userNotice);
					break;
				}
				case "communitypayforward": {
					const wasAnon = tags.get("msg-param-prior-gifter-anonymous") === "true";
					const forwardInfo = {
						userId: tags.get("user-id"),
						displayName: tags.get("display-name"),
						originalGifterUserId: wasAnon ? void 0 : tags.get("msg-param-prior-gifter-id"),
						originalGifterDisplayName: wasAnon ? void 0 : tags.get("msg-param-prior-gifter-display-name")
					};
					this.emit(this.onCommunityPayForward, broadcasterName, tags.get("login"), forwardInfo, userNotice);
					break;
				}
				case "primecommunitygiftreceived": {
					const giftInfo = {
						name: tags.get("msg-param-gift-name"),
						gifter: tags.get("login"),
						gifterDisplayName: tags.get("display-name")
					};
					this.emit(this.onPrimeCommunityGift, broadcasterName, tags.get("msg-param-recipient"), giftInfo, userNotice);
					break;
				}
				case "raid": {
					const raidInfo = {
						displayName: tags.get("msg-param-displayName"),
						viewerCount: Number(tags.get("msg-param-viewerCount"))
					};
					this.emit(this.onRaid, broadcasterName, tags.get("login"), raidInfo, userNotice);
					break;
				}
				case "unraid":
					this.emit(this.onRaidCancel, broadcasterName, userNotice);
					break;
				case "ritual": {
					const ritualInfo = {
						ritualName: tags.get("msg-param-ritual-name"),
						message
					};
					this.emit(this.onRitual, broadcasterName, tags.get("login"), ritualInfo, userNotice);
					break;
				}
				case "bitsbadgetier": {
					const badgeUpgradeInfo = {
						displayName: tags.get("display-name"),
						threshold: Number(tags.get("msg-param-threshold"))
					};
					this.emit(this.onBitsBadgeUpgrade, broadcasterName, tags.get("login"), badgeUpgradeInfo, userNotice);
					break;
				}
				case "extendsub": {
					const extendInfo = {
						userId: tags.get("user-id"),
						displayName: tags.get("display-name"),
						plan: tags.get("msg-param-sub-plan"),
						months: Number(tags.get("msg-param-cumulative-months")),
						endMonth: Number(tags.get("msg-param-sub-benefit-end-month"))
					};
					this.emit(this.onSubExtend, broadcasterName, tags.get("login"), extendInfo, userNotice);
					break;
				}
				case "rewardgift": {
					const rewardGiftInfo = {
						domain: tags.get("msg-param-domain"),
						gifterId: tags.get("user-id"),
						gifterDisplayName: tags.get("display-name"),
						count: Number(tags.get("msg-param-selected-count")),
						gifterGiftCount: Number(tags.get("msg-param-total-reward-count")),
						triggerType: tags.get("msg-param-trigger-type")
					};
					this.emit(this.onRewardGift, broadcasterName, tags.get("login"), rewardGiftInfo, userNotice);
					break;
				}
				case "announcement": {
					const announcementInfo = { color: tags.get("msg-param-color") };
					this.emit(this.onAnnouncement, broadcasterName, tags.get("login"), announcementInfo, userNotice);
					break;
				}
				default: this._chatLogger.warn(`Unrecognized usernotice ID: ${messageType}`);
			}
		});
		this._ircClient.onTypedMessage(Whisper, (whisper) => {
			this.emit(this.onWhisper, whisper.prefix.nick, whisper.text, whisper);
		});
		this._ircClient.onTypedMessage(Notice, async ({ target: channel, text, tags }) => {
			const messageType = tags.get("msg-id");
			switch (messageType) {
				case "emote_only_on":
					this.emit(this.onEmoteOnly, toUserName(channel), true);
					break;
				case "emote_only_off":
					this.emit(this.onEmoteOnly, toUserName(channel), false);
					break;
				case "msg_channel_suspended":
				case "msg_banned":
					this.emit(this._onJoinResult, channel, void 0, messageType);
					break;
				case "r9k_on":
					this.emit(this.onUniqueChat, toUserName(channel), true);
					break;
				case "r9k_off":
					this.emit(this.onUniqueChat, toUserName(channel), false);
					break;
				case "subs_on":
					this.emit(this.onSubsOnly, toUserName(channel), true);
					break;
				case "subs_off":
					this.emit(this.onSubsOnly, toUserName(channel), false);
					break;
				case "cmds_available": break;
				case "followers_on":
				case "followers_on_zero":
				case "followers_off":
				case "slow_on":
				case "slow_off": break;
				case "timeout_success": break;
				case "unrecognized_cmd": break;
				case "no_permission":
					this.emit(this.onNoPermission, toUserName(channel), text);
					break;
				case "msg_ratelimit":
					this.emit(this.onMessageRatelimit, toUserName(channel), text);
					break;
				case "msg_duplicate":
				case "msg_emoteonly":
				case "msg_followersonly":
				case "msg_followersonly_followed":
				case "msg_followersonly_zero":
				case "msg_subsonly":
				case "msg_slowmode":
				case "msg_r9k":
				case "msg_verified_email":
				case "msg_timedout":
				case "msg_rejected_mandatory":
				case "msg_channel_blocked":
					this.emit(this.onMessageFailed, toUserName(channel), messageType);
					break;
				case void 0:
					if (text === "Login authentication failed" || text === "Improperly formatted AUTH" || text === "Invalid NICK") {
						this._authVerified = false;
						if (!this._authRetryTimer) {
							this._authRetryTimer = fibWithLimit(120);
							this._authRetryCount = 0;
						}
						const secs = this._authRetryTimer.next().value;
						const authRetries = ++this._authRetryCount;
						this.emit(this.onAuthenticationFailure, text, authRetries);
						if (secs !== 0) this._chatLogger.info(`Retrying authentication in ${secs} seconds`);
						await delay(secs * 1e3);
						this._ircClient.reconnect();
					}
					break;
				default: if (!messageType.startsWith("usage_")) this._chatLogger.warn(`Unrecognized notice ID: '${messageType}'`);
			}
		});
	}
	/**
	* Connects to the chat server.
	*/
	connect() {
		if (!this._authProvider) this._ircClient.changeNick(ChatClient_1._generateJustinfanNick());
		this._initializeRateLimiters();
		this._ircClient.connect();
	}
	/**
	* The underlying IRC client. Use sparingly.
	*/
	get irc() {
		return this._ircClient;
	}
	/**
	* Whether the chat client is currently connected.
	*/
	get isConnected() {
		return this._ircClient.isConnected;
	}
	/**
	* Whether the chat client is currently connecting.
	*/
	get isConnecting() {
		return this._ircClient.isConnecting;
	}
	/**
	* The channels the client is currently in.
	*/
	get currentChannels() {
		return this._ircClient.currentChannels;
	}
	/**
	* Sends a regular chat message to a channel.
	*
	* @param channel The channel to send the message to.
	* @param text The message to send.
	* @param attributes The attributes to add to the message.
	* @param rateLimiterOptions Options to pass to the rate limiter.
	*/
	async say(channel, text, attributes = {}, rateLimiterOptions) {
		const tags = {};
		if (attributes.replyTo) tags["reply-parent-msg-id"] = extractMessageId(attributes.replyTo);
		const texts = splitOnSpaces(text, 500);
		await Promise.all(texts.map(async (msg) => await this._messageRateLimiter.request({
			type: "say",
			channel: toChannelName(channel),
			text: msg,
			tags
		}, rateLimiterOptions)));
	}
	/**
	* Sends an action message (/me) to a channel.
	*
	* @param channel The channel to send the message to.
	* @param text The message to send.
	* @param rateLimiterOptions Options to pass to the rate limiter.
	*/
	async action(channel, text, rateLimiterOptions) {
		const texts = splitOnSpaces(text, 490);
		await Promise.all(texts.map(async (msg) => await this._messageRateLimiter.request({
			type: "action",
			channel: toChannelName(channel),
			text: msg
		}, rateLimiterOptions)));
	}
	/**
	* Joins a channel.
	*
	* @param channel The channel to join.
	*/
	async join(channel) {
		await this._joinRateLimiter.request(toChannelName(channel));
	}
	/**
	* Leaves a channel ("part" in IRC terms).
	*
	* @param channel The channel to leave.
	*/
	part(channel) {
		this._ircClient.part(toChannelName(channel));
	}
	/**
	* Disconnects from the chat server.
	*/
	quit() {
		this._messageRateLimiter?.destroy?.();
		this._joinRateLimiter?.destroy?.();
		this._messageRateLimiter = void 0;
		this._joinRateLimiter = void 0;
		this._ircClient.quitAbruptly();
	}
	/**
	* Reconnects to the chat server.
	*/
	reconnect() {
		this.quit();
		this.connect();
	}
	async _getAuthToken() {
		if (!this._authProvider) {
			this._chatLogger.debug("No authProvider given; connecting anonymously");
			return;
		}
		if (this._authToken && !accessTokenIsExpired(this._authToken) && this._authVerified) {
			this._chatLogger.debug("AccessToken assumed to be correct from last connection");
			return `oauth:${this._authToken.accessToken}`;
		}
		const scopes = this._getNecessaryScopes();
		let lastTokenError = void 0;
		let foundSomeIntent = false;
		for (const intent of this._authIntents) {
			try {
				this._authToken = await this._authProvider.getAccessTokenForIntent(intent, scopes);
				if (!this._authToken) continue;
				foundSomeIntent = true;
				const token = await getTokenInfo(this._authToken.accessToken);
				if (!token.userName) throw new InvalidTokenTypeError("Could not determine a user name for your token; you might be trying to disguise an app token as a user token.");
				this._ircClient.changeNick(token.userName);
				return `oauth:${this._authToken.accessToken}`;
			} catch (e) {
				if (e instanceof InvalidTokenError) lastTokenError = e;
				else this._chatLogger.error(`Retrieving an access token failed: ${e.message}`);
			}
			this._chatLogger.warn("No valid token available; trying to refresh");
			try {
				this._authToken = await this._authProvider.refreshAccessTokenForIntent?.(intent);
				if (this._authToken) {
					const token = await getTokenInfo(this._authToken.accessToken);
					if (!token.userName) throw new InvalidTokenTypeError("Could not determine a user name for your token; you might be trying to disguise an app token as a user token.");
					this._ircClient.changeNick(token.userName);
					return `oauth:${this._authToken.accessToken}`;
				}
			} catch (e) {
				if (e instanceof InvalidTokenError) lastTokenError = e;
				else this._chatLogger.error(`Refreshing the access token failed: ${e.message}`);
			}
		}
		this._authVerified = false;
		throw lastTokenError ?? /* @__PURE__ */ new Error(foundSomeIntent ? "Could not retrieve a valid token" : `None of the queried intents (${this._authIntents.join(", ")}) are known by the auth provider${this._authProvider instanceof RefreshingAuthProvider ? ".\nPlease add one of these to the user you want to connect with using the `addIntentToUser` method or the additional parameter to `addUser` or `addUserForToken`." : ""}`);
	}
	_getNecessaryScopes() {
		if (this._useLegacyScopes) return ["chat_login"];
		if (this._readOnly) return ["chat:read"];
		return ["chat:read", "chat:edit"];
	}
	static _generateJustinfanNick() {
		return `justinfan${Math.floor(Math.random() * 1e5).toString().padStart(5, "0")}`;
	}
	_initializeRateLimiters() {
		const executeChatMessageRequest = async ({ type, text, channel, tags }) => {
			if (type === "say") this._ircClient.say(channel, text, tags);
			else this._ircClient.action(channel, text);
		};
		const executeJoinRequest = async (channel) => {
			const { promise, resolve, reject } = promiseWithResolvers();
			let timer;
			const e = this.addInternalListener(this._onJoinResult, (chan, state, error) => {
				if (chan === channel) {
					clearTimeout(timer);
					if (error) reject(error);
					else resolve();
					this.removeListener(e);
				}
			});
			timer = setTimeout(() => {
				this.removeListener(e);
				this.emit(this._onJoinResult, channel, void 0, "twurple_timeout");
				reject(/* @__PURE__ */ new Error(`Did not receive a reply to join ${channel} in time; assuming that the join failed`));
			}, 1e4);
			this._ircClient.join(channel);
			await promise;
		};
		if (this._isAlwaysMod) this._messageRateLimiter = new TimeBasedRateLimiter({
			bucketSize: this._botLevel === "verified" ? 7500 : 100,
			timeFrame: 32e3,
			doRequest: executeChatMessageRequest
		});
		else {
			let bucketSize = 20;
			if (this._botLevel === "verified") bucketSize = 7500;
			else if (this._botLevel === "known") bucketSize = 50;
			this._messageRateLimiter = new TimedPassthruRateLimiter(new PartitionedTimeBasedRateLimiter({
				bucketSize: 1,
				timeFrame: 1200,
				logger: { minLevel: LogLevel.ERROR },
				doRequest: executeChatMessageRequest,
				getPartitionKey: ({ channel }) => channel
			}), {
				bucketSize,
				timeFrame: 32e3
			});
		}
		this._joinRateLimiter = new TimeBasedRateLimiter({
			bucketSize: this._botLevel === "verified" ? 2e3 : 20,
			timeFrame: 11e3,
			doRequest: executeJoinRequest
		});
		this._messageRateLimiter.pause();
		this._joinRateLimiter.pause();
	}
};
__decorate([Enumerable(false)], ChatClient.prototype, "_authProvider", void 0);
ChatClient = ChatClient_1 = __decorate([rtfm("chat", "ChatClient")], ChatClient);
//#endregion
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
	const accountCfg = accountId === "default" ? twitchCfg?.accounts?.[DEFAULT_ACCOUNT_ID$1] : twitchCfg?.accounts?.[accountId];
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
//#region extensions/twitch/src/twitch-client.ts
/**
* Manages Twitch chat client connections
*/
var TwitchClientManager = class {
	constructor(logger) {
		this.logger = logger;
		this.clients = /* @__PURE__ */ new Map();
		this.messageHandlers = /* @__PURE__ */ new Map();
	}
	/**
	* Create an auth provider for the account.
	*/
	async createAuthProvider(account, normalizedToken) {
		if (!account.clientId) throw new Error("Missing Twitch client ID");
		if (account.clientSecret) {
			const authProvider = new RefreshingAuthProvider({
				clientId: account.clientId,
				clientSecret: account.clientSecret
			});
			await authProvider.addUserForToken({
				accessToken: normalizedToken,
				refreshToken: account.refreshToken ?? null,
				expiresIn: account.expiresIn ?? null,
				obtainmentTimestamp: account.obtainmentTimestamp ?? Date.now()
			}).then((userId) => {
				this.logger.info(`Added user ${userId} to RefreshingAuthProvider for ${account.username}`);
			}).catch((err) => {
				this.logger.error(`Failed to add user to RefreshingAuthProvider: ${err instanceof Error ? err.message : String(err)}`);
			});
			authProvider.onRefresh((userId, token) => {
				this.logger.info(`Access token refreshed for user ${userId} (expires in ${token.expiresIn ? `${token.expiresIn}s` : "unknown"})`);
			});
			authProvider.onRefreshFailure((userId, error) => {
				this.logger.error(`Failed to refresh access token for user ${userId}: ${error.message}`);
			});
			const refreshStatus = account.refreshToken ? "automatic token refresh enabled" : "token refresh disabled (no refresh token)";
			this.logger.info(`Using RefreshingAuthProvider for ${account.username} (${refreshStatus})`);
			return authProvider;
		}
		this.logger.info(`Using StaticAuthProvider for ${account.username} (no clientSecret provided)`);
		return new StaticAuthProvider(account.clientId, normalizedToken);
	}
	/**
	* Get or create a chat client for an account
	*/
	async getClient(account, cfg, accountId) {
		const key = this.getAccountKey(account);
		const existing = this.clients.get(key);
		if (existing) return existing;
		const tokenResolution = resolveTwitchToken(cfg, { accountId });
		if (!tokenResolution.token) {
			this.logger.error(`Missing Twitch token for account ${account.username} (set channels.twitch.accounts.${account.username}.token or OPENCLAW_TWITCH_ACCESS_TOKEN for default)`);
			throw new Error("Missing Twitch token");
		}
		this.logger.debug?.(`Using ${tokenResolution.source} token source for ${account.username}`);
		if (!account.clientId) {
			this.logger.error(`Missing Twitch client ID for account ${account.username}`);
			throw new Error("Missing Twitch client ID");
		}
		const normalizedToken = normalizeToken(tokenResolution.token);
		const client = new ChatClient({
			authProvider: await this.createAuthProvider(account, normalizedToken),
			channels: [account.channel],
			rejoinChannelsOnReconnect: true,
			requestMembershipEvents: true,
			logger: {
				minLevel: LogLevel.WARNING,
				custom: { log: (level, message) => {
					switch (level) {
						case LogLevel.CRITICAL:
							this.logger.error(message);
							break;
						case LogLevel.ERROR:
							this.logger.error(message);
							break;
						case LogLevel.WARNING:
							this.logger.warn(message);
							break;
						case LogLevel.INFO:
							this.logger.info(message);
							break;
						case LogLevel.DEBUG:
							this.logger.debug?.(message);
							break;
						case LogLevel.TRACE:
							this.logger.debug?.(message);
							break;
					}
				} }
			}
		});
		this.setupClientHandlers(client, account);
		client.connect();
		this.clients.set(key, client);
		this.logger.info(`Connected to Twitch as ${account.username}`);
		return client;
	}
	/**
	* Set up message and event handlers for a client
	*/
	setupClientHandlers(client, account) {
		const key = this.getAccountKey(account);
		client.onMessage((channelName, _user, messageText, msg) => {
			const handler = this.messageHandlers.get(key);
			if (handler) {
				const normalizedChannel = channelName.startsWith("#") ? channelName.slice(1) : channelName;
				const from = `twitch:${msg.userInfo.userName}`;
				const preview = messageText.slice(0, 100).replace(/\n/g, "\\n");
				this.logger.debug?.(`twitch inbound: channel=${normalizedChannel} from=${from} len=${messageText.length} preview="${preview}"`);
				handler({
					username: msg.userInfo.userName,
					displayName: msg.userInfo.displayName,
					userId: msg.userInfo.userId,
					message: messageText,
					channel: normalizedChannel,
					id: msg.id,
					timestamp: /* @__PURE__ */ new Date(),
					isMod: msg.userInfo.isMod,
					isOwner: msg.userInfo.isBroadcaster,
					isVip: msg.userInfo.isVip,
					isSub: msg.userInfo.isSubscriber,
					chatType: "group"
				});
			}
		});
		this.logger.info(`Set up handlers for ${key}`);
	}
	/**
	* Set a message handler for an account
	* @returns A function that removes the handler when called
	*/
	onMessage(account, handler) {
		const key = this.getAccountKey(account);
		this.messageHandlers.set(key, handler);
		return () => {
			this.messageHandlers.delete(key);
		};
	}
	/**
	* Disconnect a client
	*/
	async disconnect(account) {
		const key = this.getAccountKey(account);
		const client = this.clients.get(key);
		if (client) {
			client.quit();
			this.clients.delete(key);
			this.messageHandlers.delete(key);
			this.logger.info(`Disconnected ${key}`);
		}
	}
	/**
	* Disconnect all clients
	*/
	async disconnectAll() {
		this.clients.forEach((client) => client.quit());
		this.clients.clear();
		this.messageHandlers.clear();
		this.logger.info(" Disconnected all clients");
	}
	/**
	* Send a message to a channel
	*/
	async sendMessage(account, channel, message, cfg, accountId) {
		try {
			const client = await this.getClient(account, cfg, accountId);
			const messageId = crypto.randomUUID();
			await client.say(channel, message);
			return {
				ok: true,
				messageId
			};
		} catch (error) {
			this.logger.error(`Failed to send message: ${error instanceof Error ? error.message : String(error)}`);
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}
	/**
	* Generate a unique key for an account
	*/
	getAccountKey(account) {
		return `${account.username}:${account.channel}`;
	}
	/**
	* Clear all clients and handlers (for testing)
	*/
	_clearForTest() {
		this.clients.clear();
		this.messageHandlers.clear();
	}
};
//#endregion
//#region extensions/twitch/src/client-manager-registry.ts
/**
* Client manager registry for Twitch plugin.
*
* Manages the lifecycle of TwitchClientManager instances across the plugin,
* ensuring proper cleanup when accounts are stopped or reconfigured.
*/
/**
* Global registry of client managers.
* Keyed by account ID.
*/
const registry = /* @__PURE__ */ new Map();
/**
* Get or create a client manager for an account.
*
* @param accountId - The account ID
* @param logger - Logger instance
* @returns The client manager
*/
function getOrCreateClientManager(accountId, logger) {
	const existing = registry.get(accountId);
	if (existing) return existing.manager;
	const manager = new TwitchClientManager(logger);
	registry.set(accountId, {
		manager,
		accountId,
		logger,
		createdAt: Date.now()
	});
	logger.info(`Registered client manager for account: ${accountId}`);
	return manager;
}
/**
* Get an existing client manager for an account.
*
* @param accountId - The account ID
* @returns The client manager, or undefined if not registered
*/
function getClientManager(accountId) {
	return registry.get(accountId)?.manager;
}
/**
* Disconnect and remove a client manager from the registry.
*
* @param accountId - The account ID
* @returns Promise that resolves when cleanup is complete
*/
async function removeClientManager(accountId) {
	const entry = registry.get(accountId);
	if (!entry) return;
	await entry.manager.disconnectAll();
	registry.delete(accountId);
	entry.logger.info(`Unregistered client manager for account: ${accountId}`);
}
//#endregion
//#region extensions/twitch/src/utils/markdown.ts
/**
* Markdown utilities for Twitch chat
*
* Twitch chat doesn't support markdown formatting, so we strip it before sending.
* Based on OpenClaw's markdownToText in src/agents/tools/web-fetch-utils.ts.
*/
/**
* Strip markdown formatting from text for Twitch compatibility.
*
* Removes images, links, bold, italic, strikethrough, code blocks, inline code,
* headers, and list formatting. Replaces newlines with spaces since Twitch
* is a single-line chat medium.
*
* @param markdown - The markdown text to strip
* @returns Plain text with markdown removed
*/
function stripMarkdownForTwitch(markdown) {
	return markdown.replace(/!\[[^\]]*]\([^)]+\)/g, "").replace(/\[([^\]]+)]\([^)]+\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/_([^_]+)_/g, "$1").replace(/~~([^~]+)~~/g, "$1").replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, "").replace(/```/g, "")).replace(/`([^`]+)`/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*\d+\.\s+/gm, "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}
/**
* Simple word-boundary chunker for Twitch (500 char limit).
* Strips markdown before chunking to avoid breaking markdown patterns.
*
* @param text - The text to chunk
* @param limit - Maximum characters per chunk (Twitch limit is 500)
* @returns Array of text chunks
*/
function chunkTextForTwitch(text, limit) {
	const cleaned = stripMarkdownForTwitch(text);
	if (!cleaned) return [];
	if (limit <= 0) return [cleaned];
	if (cleaned.length <= limit) return [cleaned];
	const chunks = [];
	let remaining = cleaned;
	while (remaining.length > limit) {
		const window = remaining.slice(0, limit);
		const lastSpaceIndex = window.lastIndexOf(" ");
		if (lastSpaceIndex === -1) {
			chunks.push(window);
			remaining = remaining.slice(limit);
		} else {
			chunks.push(window.slice(0, lastSpaceIndex));
			remaining = remaining.slice(lastSpaceIndex + 1);
		}
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}
//#endregion
//#region extensions/twitch/src/runtime.ts
const { setRuntime: setTwitchRuntime, getRuntime: getTwitchRuntime } = createPluginRuntimeStore("Twitch runtime not initialized");
//#endregion
//#region extensions/twitch/src/access-control.ts
/**
* Check if a Twitch message should be allowed based on account configuration
*
* This function implements the access control logic for incoming Twitch messages,
* checking allowlists, role-based restrictions, and mention requirements.
*
* Priority order:
* 1. If `requireMention` is true, message must mention the bot
* 2. If `allowFrom` is set, sender must be in the allowlist (by user ID)
* 3. If `allowedRoles` is set (and `allowFrom` is not), sender must have at least one role
*
* Note: `allowFrom` is a hard allowlist. When set, only those user IDs are allowed.
* Use `allowedRoles` as an alternative when you don't want to maintain an allowlist.
*
* Available roles:
* - "moderator": Moderators
* - "owner": Channel owner/broadcaster
* - "vip": VIPs
* - "subscriber": Subscribers
* - "all": Anyone in the chat
*/
function checkTwitchAccessControl(params) {
	const { message, account, botUsername } = params;
	if (account.requireMention ?? true) {
		if (!extractMentions(message.message).includes(botUsername.toLowerCase())) return {
			allowed: false,
			reason: "message does not mention the bot (requireMention is enabled)"
		};
	}
	if (account.allowFrom !== void 0) {
		const allowFrom = account.allowFrom;
		if (allowFrom.length === 0) return {
			allowed: false,
			reason: "sender is not in allowFrom allowlist"
		};
		const senderId = message.userId;
		if (!senderId) return {
			allowed: false,
			reason: "sender user ID not available for allowlist check"
		};
		if (allowFrom.includes(senderId)) return {
			allowed: true,
			matchKey: senderId,
			matchSource: "allowlist"
		};
		return {
			allowed: false,
			reason: "sender is not in allowFrom allowlist"
		};
	}
	if (account.allowedRoles && account.allowedRoles.length > 0) {
		const allowedRoles = account.allowedRoles;
		if (allowedRoles.includes("all")) return {
			allowed: true,
			matchKey: "all",
			matchSource: "role"
		};
		if (!checkSenderRoles({
			message,
			allowedRoles
		})) return {
			allowed: false,
			reason: `sender does not have any of the required roles: ${allowedRoles.join(", ")}`
		};
		return {
			allowed: true,
			matchKey: allowedRoles.join(","),
			matchSource: "role"
		};
	}
	return { allowed: true };
}
/**
* Check if the sender has any of the allowed roles
*/
function checkSenderRoles(params) {
	const { message, allowedRoles } = params;
	const { isMod, isOwner, isVip, isSub } = message;
	for (const role of allowedRoles) switch (role) {
		case "moderator":
			if (isMod) return true;
			break;
		case "owner":
			if (isOwner) return true;
			break;
		case "vip":
			if (isVip) return true;
			break;
		case "subscriber":
			if (isSub) return true;
			break;
	}
	return false;
}
/**
* Extract @mentions from a Twitch chat message
*
* Returns a list of lowercase usernames that were mentioned in the message.
* Twitch mentions are in the format @username.
*/
function extractMentions(message) {
	const mentionRegex = /@(\w+)/g;
	const mentions = [];
	let match;
	while ((match = mentionRegex.exec(message)) !== null) {
		const username = match[1];
		if (username) mentions.push(username.toLowerCase());
	}
	return mentions;
}
//#endregion
//#region extensions/twitch/src/monitor.ts
/**
* Process an incoming Twitch message and dispatch to agent.
*/
async function processTwitchMessage(params) {
	const { message, account, accountId, config, runtime, core, statusSink } = params;
	const cfg = config;
	const route = core.channel.routing.resolveAgentRoute({
		cfg,
		channel: "twitch",
		accountId,
		peer: {
			kind: "group",
			id: message.channel
		}
	});
	const rawBody = message.message;
	const body = core.channel.reply.formatAgentEnvelope({
		channel: "Twitch",
		from: message.displayName ?? message.username,
		timestamp: message.timestamp?.getTime(),
		envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
		body: rawBody
	});
	const ctxPayload = core.channel.reply.finalizeInboundContext({
		Body: body,
		BodyForAgent: rawBody,
		RawBody: rawBody,
		CommandBody: rawBody,
		From: `twitch:user:${message.userId}`,
		To: `twitch:channel:${message.channel}`,
		SessionKey: route.sessionKey,
		AccountId: route.accountId,
		ChatType: "group",
		ConversationLabel: message.channel,
		SenderName: message.displayName ?? message.username,
		SenderId: message.userId,
		SenderUsername: message.username,
		Provider: "twitch",
		Surface: "twitch",
		MessageSid: message.id,
		OriginatingChannel: "twitch",
		OriginatingTo: `twitch:channel:${message.channel}`
	});
	const storePath = core.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
	await core.channel.session.recordInboundSession({
		storePath,
		sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
		ctx: ctxPayload,
		onRecordError: (err) => {
			runtime.error?.(`Failed updating session meta: ${String(err)}`);
		}
	});
	const tableMode = core.channel.text.resolveMarkdownTableMode({
		cfg,
		channel: "twitch",
		accountId
	});
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg,
		agentId: route.agentId,
		channel: "twitch",
		accountId
	});
	await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
		ctx: ctxPayload,
		cfg,
		dispatcherOptions: {
			...prefixOptions,
			deliver: async (payload) => {
				await deliverTwitchReply({
					payload,
					channel: message.channel,
					account,
					accountId,
					config,
					tableMode,
					runtime,
					statusSink
				});
			}
		},
		replyOptions: { onModelSelected }
	});
}
/**
* Deliver a reply to Twitch chat.
*/
async function deliverTwitchReply(params) {
	const { payload, channel, account, accountId, config, runtime, statusSink } = params;
	try {
		const client = await getOrCreateClientManager(accountId, {
			info: (msg) => runtime.log?.(msg),
			warn: (msg) => runtime.log?.(msg),
			error: (msg) => runtime.error?.(msg),
			debug: (msg) => runtime.log?.(msg)
		}).getClient(account, config, accountId);
		if (!client) {
			runtime.error?.(`No client available for sending reply`);
			return;
		}
		if (!payload.text) {
			runtime.error?.(`No text to send in reply payload`);
			return;
		}
		const textToSend = stripMarkdownForTwitch(payload.text);
		await client.say(channel, textToSend);
		statusSink?.({ lastOutboundAt: Date.now() });
	} catch (err) {
		runtime.error?.(`Failed to send reply: ${String(err)}`);
	}
}
/**
* Main monitor provider for Twitch.
*
* Sets up message handlers and processes incoming messages.
*/
async function monitorTwitchProvider(options) {
	const { account, accountId, config, runtime, abortSignal, statusSink } = options;
	const core = getTwitchRuntime();
	let stopped = false;
	const coreLogger = core.logging.getChildLogger({ module: "twitch" });
	const logVerboseMessage = (message) => {
		if (!core.logging.shouldLogVerbose()) return;
		coreLogger.debug?.(message);
	};
	const clientManager = getOrCreateClientManager(accountId, {
		info: (msg) => coreLogger.info(msg),
		warn: (msg) => coreLogger.warn(msg),
		error: (msg) => coreLogger.error(msg),
		debug: logVerboseMessage
	});
	try {
		await clientManager.getClient(account, config, accountId);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		runtime.error?.(`Failed to connect: ${errorMsg}`);
		throw error;
	}
	const unregisterHandler = clientManager.onMessage(account, (message) => {
		if (stopped) return;
		const botUsername = account.username.toLowerCase();
		if (message.username.toLowerCase() === botUsername) return;
		if (!checkTwitchAccessControl({
			message,
			account,
			botUsername
		}).allowed) return;
		statusSink?.({ lastInboundAt: Date.now() });
		processTwitchMessage({
			message,
			account,
			accountId,
			config,
			runtime,
			core,
			statusSink
		}).catch((err) => {
			runtime.error?.(`Message processing failed: ${String(err)}`);
		});
	});
	const stop = () => {
		stopped = true;
		unregisterHandler();
	};
	abortSignal.addEventListener("abort", stop, { once: true });
	return { stop };
}
//#endregion
export { DataObject as A, Enumerable as B, transformTwitchApiResponse as C, HellFreezesOverError as D, extractUserName as E, mapOptional as F, missingTargetError as G, twitchSetupWizard as H, arrayToObject as I, DEFAULT_ACCOUNT_ID as J, normalizeToken as K, __decorate as L, accessTokenIsExpired as M, promiseWithResolvers as N, rtfm as O, mapNullable as P, __read as R, handleTwitchApiResponseError as S, extractUserId as T, generateMessageId as U, twitchSetupAdapter as V, isAccountConfigured as W, listAccountIds as X, getAccountConfig as Y, EventEmitter as _, getClientManager as a, callTwitchApi as b, ChatClient as c, PartitionedTimeBasedRateLimiter as d, RateLimitReachedError as f, StaticAuthProvider as g, require_detect_node as h, stripMarkdownForTwitch as i, rawDataSymbol as j, CustomError$1 as k, CachedGetter as l, createLogger as m, setTwitchRuntime as n, removeClientManager as o, CustomError as p, normalizeTwitchChannel as q, chunkTextForTwitch as r, resolveTwitchToken as s, monitorTwitchProvider as t, Cacheable as u, TokenInfo as v, HttpStatusCodeError as w, callTwitchApiRaw as x, InvalidTokenError as y, __spreadArray as z };
