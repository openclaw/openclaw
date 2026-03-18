import { t as __commonJSMin } from "./chunk-DORXReHP.js";
import { g as DEFAULT_ACCOUNT_ID, s as init_session_key, v as normalizeAccountId } from "./session-key-BSZsryCD.js";
import { A as createDedupeCache, Hr as applyAccountNameToChannelSection, Kr as patchScopedAccountConfig, Zn as buildChannelConfigSchema, j as init_dedupe } from "./resolve-route-CQsiaDZO.js";
import { t as createLoggerBackedRuntime } from "./runtime-Chh5WDL9.js";
import { Tu as formatDocsLink, y as createPluginRuntimeStore } from "./auth-profiles-B70DPAVa.js";
import { H as isBlockedHostnameOrIp, f as fetchWithSsrFGuard } from "./external-content-CxoN_TKD.js";
import { createWriteStream } from "node:fs";
import * as path$1 from "node:path";
import { z } from "zod";
import { homedir } from "node:os";
import crypto$1, { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
//#region extensions/tlon/src/account-fields.ts
function buildTlonAccountFields(input) {
	return {
		...input.ship ? { ship: input.ship } : {},
		...input.url ? { url: input.url } : {},
		...input.code ? { code: input.code } : {},
		...typeof input.allowPrivateNetwork === "boolean" ? { allowPrivateNetwork: input.allowPrivateNetwork } : {},
		...input.groupChannels ? { groupChannels: input.groupChannels } : {},
		...input.dmAllowlist ? { dmAllowlist: input.dmAllowlist } : {},
		...typeof input.autoDiscoverChannels === "boolean" ? { autoDiscoverChannels: input.autoDiscoverChannels } : {},
		...input.ownerShip ? { ownerShip: input.ownerShip } : {}
	};
}
//#endregion
//#region extensions/tlon/src/types.ts
function resolveTlonAccount(cfg, accountId) {
	const base = cfg.channels?.tlon;
	if (!base) return {
		accountId: accountId || "default",
		name: null,
		enabled: false,
		configured: false,
		ship: null,
		url: null,
		code: null,
		allowPrivateNetwork: null,
		groupChannels: [],
		dmAllowlist: [],
		groupInviteAllowlist: [],
		autoDiscoverChannels: null,
		showModelSignature: null,
		autoAcceptDmInvites: null,
		autoAcceptGroupInvites: null,
		defaultAuthorizedShips: [],
		ownerShip: null
	};
	const account = !accountId || accountId === "default" ? base : base.accounts?.[accountId];
	const ship = account?.ship ?? base.ship ?? null;
	const url = account?.url ?? base.url ?? null;
	const code = account?.code ?? base.code ?? null;
	const allowPrivateNetwork = account?.allowPrivateNetwork ?? base.allowPrivateNetwork ?? null;
	const groupChannels = account?.groupChannels ?? base.groupChannels ?? [];
	const dmAllowlist = account?.dmAllowlist ?? base.dmAllowlist ?? [];
	const groupInviteAllowlist = account?.groupInviteAllowlist ?? base.groupInviteAllowlist ?? [];
	const autoDiscoverChannels = account?.autoDiscoverChannels ?? base.autoDiscoverChannels ?? null;
	const showModelSignature = account?.showModelSignature ?? base.showModelSignature ?? null;
	const autoAcceptDmInvites = account?.autoAcceptDmInvites ?? base.autoAcceptDmInvites ?? null;
	const autoAcceptGroupInvites = account?.autoAcceptGroupInvites ?? base.autoAcceptGroupInvites ?? null;
	const ownerShip = account?.ownerShip ?? base.ownerShip ?? null;
	const defaultAuthorizedShips = account?.defaultAuthorizedShips ?? base?.defaultAuthorizedShips ?? [];
	const configured = Boolean(ship && url && code);
	return {
		accountId: accountId || "default",
		name: account?.name ?? base.name ?? null,
		enabled: (account?.enabled ?? base.enabled ?? true) !== false,
		configured,
		ship,
		url,
		code,
		allowPrivateNetwork,
		groupChannels,
		dmAllowlist,
		groupInviteAllowlist,
		autoDiscoverChannels,
		showModelSignature,
		autoAcceptDmInvites,
		autoAcceptGroupInvites,
		defaultAuthorizedShips,
		ownerShip
	};
}
function listTlonAccountIds(cfg) {
	const base = cfg.channels?.tlon;
	if (!base) return [];
	const accounts = base.accounts ?? {};
	return [...base.ship ? ["default"] : [], ...Object.keys(accounts)];
}
//#endregion
//#region extensions/tlon/src/setup-core.ts
init_session_key();
const channel$1 = "tlon";
function applyTlonSetupConfig(params) {
	const { cfg, accountId, input } = params;
	const useDefault = accountId === DEFAULT_ACCOUNT_ID;
	const namedConfig = applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name: input.name
	});
	const base = namedConfig.channels?.tlon ?? {};
	const payload = buildTlonAccountFields(input);
	if (useDefault) return {
		...namedConfig,
		channels: {
			...namedConfig.channels,
			tlon: {
				...base,
				enabled: true,
				...payload
			}
		}
	};
	return patchScopedAccountConfig({
		cfg: namedConfig,
		channelKey: channel$1,
		accountId,
		patch: { enabled: base.enabled ?? true },
		accountPatch: {
			enabled: true,
			...payload
		},
		ensureChannelEnabled: false,
		ensureAccountEnabled: false
	});
}
const tlonSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	validateInput: ({ cfg, accountId, input }) => {
		const setupInput = input;
		const resolved = resolveTlonAccount(cfg, accountId ?? void 0);
		const ship = setupInput.ship?.trim() || resolved.ship;
		const url = setupInput.url?.trim() || resolved.url;
		const code = setupInput.code?.trim() || resolved.code;
		if (!ship) return "Tlon requires --ship.";
		if (!url) return "Tlon requires --url.";
		if (!code) return "Tlon requires --code.";
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => applyTlonSetupConfig({
		cfg,
		accountId,
		input
	})
};
//#endregion
//#region extensions/tlon/src/targets.ts
const SHIP_RE = /^~?[a-z-]+$/i;
const NEST_RE = /^chat\/([^/]+)\/([^/]+)$/i;
function normalizeShip(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return trimmed;
	return trimmed.startsWith("~") ? trimmed : `~${trimmed}`;
}
function parseChannelNest(raw) {
	const match = NEST_RE.exec(raw.trim());
	if (!match) return null;
	return {
		hostShip: normalizeShip(match[1]),
		channelName: match[2]
	};
}
function parseTlonTarget(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	const withoutPrefix = trimmed.replace(/^tlon:/i, "");
	const dmPrefix = withoutPrefix.match(/^dm[/:](.+)$/i);
	if (dmPrefix) return {
		kind: "dm",
		ship: normalizeShip(dmPrefix[1])
	};
	const groupPrefix = withoutPrefix.match(/^(group|room)[/:](.+)$/i);
	if (groupPrefix) {
		const groupTarget = groupPrefix[2].trim();
		if (groupTarget.startsWith("chat/")) {
			const parsed = parseChannelNest(groupTarget);
			if (!parsed) return null;
			return {
				kind: "group",
				nest: `chat/${parsed.hostShip}/${parsed.channelName}`,
				hostShip: parsed.hostShip,
				channelName: parsed.channelName
			};
		}
		const parts = groupTarget.split("/");
		if (parts.length === 2) {
			const hostShip = normalizeShip(parts[0]);
			const channelName = parts[1];
			return {
				kind: "group",
				nest: `chat/${hostShip}/${channelName}`,
				hostShip,
				channelName
			};
		}
		return null;
	}
	if (withoutPrefix.startsWith("chat/")) {
		const parsed = parseChannelNest(withoutPrefix);
		if (!parsed) return null;
		return {
			kind: "group",
			nest: `chat/${parsed.hostShip}/${parsed.channelName}`,
			hostShip: parsed.hostShip,
			channelName: parsed.channelName
		};
	}
	if (SHIP_RE.test(withoutPrefix)) return {
		kind: "dm",
		ship: normalizeShip(withoutPrefix)
	};
	return null;
}
function formatTargetHint() {
	return "dm/~sampel-palnet | ~sampel-palnet | chat/~host-ship/channel | group:~host-ship/channel";
}
//#endregion
//#region extensions/tlon/src/urbit/base-url.ts
function hasScheme(value) {
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}
function validateUrbitBaseUrl(raw) {
	const trimmed = String(raw ?? "").trim();
	if (!trimmed) return {
		ok: false,
		error: "Required"
	};
	const candidate = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;
	let parsed;
	try {
		parsed = new URL(candidate);
	} catch {
		return {
			ok: false,
			error: "Invalid URL"
		};
	}
	if (!["http:", "https:"].includes(parsed.protocol)) return {
		ok: false,
		error: "URL must use http:// or https://"
	};
	if (parsed.username || parsed.password) return {
		ok: false,
		error: "URL must not include credentials"
	};
	const hostname = parsed.hostname.trim().toLowerCase().replace(/\.$/, "");
	if (!hostname) return {
		ok: false,
		error: "Invalid hostname"
	};
	const isIpv6 = hostname.includes(":");
	const host = parsed.port ? `${isIpv6 ? `[${hostname}]` : hostname}:${parsed.port}` : isIpv6 ? `[${hostname}]` : hostname;
	return {
		ok: true,
		baseUrl: `${parsed.protocol}//${host}`,
		hostname
	};
}
function isBlockedUrbitHostname(hostname) {
	const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (!normalized) return false;
	return isBlockedHostnameOrIp(normalized);
}
//#endregion
//#region extensions/tlon/src/setup-surface.ts
init_session_key();
const channel = "tlon";
function isConfigured(account) {
	return Boolean(account.ship && account.url && account.code);
}
function parseList(value) {
	return value.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
}
const tlonSetupWizard = {
	channel,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs setup",
		configuredHint: "configured",
		unconfiguredHint: "urbit messenger",
		configuredScore: 1,
		unconfiguredScore: 4,
		resolveConfigured: ({ cfg }) => {
			const accountIds = listTlonAccountIds(cfg);
			return accountIds.length > 0 ? accountIds.some((accountId) => isConfigured(resolveTlonAccount(cfg, accountId))) : isConfigured(resolveTlonAccount(cfg, DEFAULT_ACCOUNT_ID));
		},
		resolveStatusLines: ({ cfg }) => {
			const accountIds = listTlonAccountIds(cfg);
			return [`Tlon: ${(accountIds.length > 0 ? accountIds.some((accountId) => isConfigured(resolveTlonAccount(cfg, accountId))) : isConfigured(resolveTlonAccount(cfg, "default"))) ? "configured" : "needs setup"}`];
		}
	},
	introNote: {
		title: "Tlon setup",
		lines: [
			"You need your Urbit ship URL and login code.",
			"Example URL: https://your-ship-host",
			"Example ship: ~sampel-palnet",
			"If your ship URL is on a private network (LAN/localhost), you must explicitly allow it during setup.",
			`Docs: ${formatDocsLink("/channels/tlon", "channels/tlon")}`
		]
	},
	credentials: [],
	textInputs: [
		{
			inputKey: "ship",
			message: "Ship name",
			placeholder: "~sampel-palnet",
			currentValue: ({ cfg, accountId }) => resolveTlonAccount(cfg, accountId).ship ?? void 0,
			validate: ({ value }) => String(value ?? "").trim() ? void 0 : "Required",
			normalizeValue: ({ value }) => normalizeShip(String(value).trim()),
			applySet: async ({ cfg, accountId, value }) => applyTlonSetupConfig({
				cfg,
				accountId,
				input: { ship: value }
			})
		},
		{
			inputKey: "url",
			message: "Ship URL",
			placeholder: "https://your-ship-host",
			currentValue: ({ cfg, accountId }) => resolveTlonAccount(cfg, accountId).url ?? void 0,
			validate: ({ value }) => {
				const next = validateUrbitBaseUrl(String(value ?? ""));
				if (!next.ok) return next.error;
			},
			normalizeValue: ({ value }) => String(value).trim(),
			applySet: async ({ cfg, accountId, value }) => applyTlonSetupConfig({
				cfg,
				accountId,
				input: { url: value }
			})
		},
		{
			inputKey: "code",
			message: "Login code",
			placeholder: "lidlut-tabwed-pillex-ridrup",
			currentValue: ({ cfg, accountId }) => resolveTlonAccount(cfg, accountId).code ?? void 0,
			validate: ({ value }) => String(value ?? "").trim() ? void 0 : "Required",
			normalizeValue: ({ value }) => String(value).trim(),
			applySet: async ({ cfg, accountId, value }) => applyTlonSetupConfig({
				cfg,
				accountId,
				input: { code: value }
			})
		}
	],
	finalize: async ({ cfg, accountId, prompter }) => {
		let next = cfg;
		const resolved = resolveTlonAccount(next, accountId);
		const validatedUrl = validateUrbitBaseUrl(resolved.url ?? "");
		if (!validatedUrl.ok) throw new Error(`Invalid URL: ${validatedUrl.error}`);
		let allowPrivateNetwork = resolved.allowPrivateNetwork ?? false;
		if (isBlockedUrbitHostname(validatedUrl.hostname)) {
			allowPrivateNetwork = await prompter.confirm({
				message: "Ship URL looks like a private/internal host. Allow private network access? (SSRF risk)",
				initialValue: allowPrivateNetwork
			});
			if (!allowPrivateNetwork) throw new Error("Refusing private/internal Ship URL without explicit approval");
		}
		next = applyTlonSetupConfig({
			cfg: next,
			accountId,
			input: { allowPrivateNetwork }
		});
		const currentGroups = resolved.groupChannels;
		if (await prompter.confirm({
			message: "Add group channels manually? (optional)",
			initialValue: currentGroups.length > 0
		})) {
			const entry = await prompter.text({
				message: "Group channels (comma-separated)",
				placeholder: "chat/~host-ship/general, chat/~host-ship/support",
				initialValue: currentGroups.join(", ") || void 0
			});
			next = applyTlonSetupConfig({
				cfg: next,
				accountId,
				input: { groupChannels: parseList(String(entry ?? "")) }
			});
		}
		const currentAllowlist = resolved.dmAllowlist;
		if (await prompter.confirm({
			message: "Restrict DMs with an allowlist?",
			initialValue: currentAllowlist.length > 0
		})) {
			const entry = await prompter.text({
				message: "DM allowlist (comma-separated ship names)",
				placeholder: "~zod, ~nec",
				initialValue: currentAllowlist.join(", ") || void 0
			});
			next = applyTlonSetupConfig({
				cfg: next,
				accountId,
				input: { dmAllowlist: parseList(String(entry ?? "")).map((ship) => normalizeShip(ship)) }
			});
		}
		const autoDiscoverChannels = await prompter.confirm({
			message: "Enable auto-discovery of group channels?",
			initialValue: resolved.autoDiscoverChannels ?? true
		});
		next = applyTlonSetupConfig({
			cfg: next,
			accountId,
			input: { autoDiscoverChannels }
		});
		return { cfg: next };
	}
};
//#endregion
//#region src/plugin-sdk/tlon.ts
init_dedupe();
//#endregion
//#region node_modules/.pnpm/@tloncorp+api@https+++codeload.github.com+tloncorp+api-beta+tar.gz+7eede1c1a756977b09f96aa14a92e2b06318ae87/node_modules/@tloncorp/api/dist/index.js
var cA = Object.defineProperty;
var lA = (e, t, n) => t in e ? cA(e, t, {
	enumerable: !0,
	configurable: !0,
	writable: !0,
	value: n
}) : e[t] = n;
var P = (e, t, n) => lA(e, typeof t != "symbol" ? t + "" : t, n);
var yt = typeof globalThis < "u" ? globalThis : typeof window < "u" ? window : typeof global < "u" ? global : typeof self < "u" ? self : {};
var Ja = { exports: {} };
/**
* @license
* Lodash <https://lodash.com/>
* Copyright OpenJS Foundation and other contributors <https://openjsf.org/>
* Released under MIT license <https://lodash.com/license>
* Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
* Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
*/
Ja.exports;
(function(e, t) {
	(function() {
		var n, r = "4.17.23", s = 200, o = "Unsupported core-js use. Try https://npms.io/search?q=ponyfill.", u = "Expected a function", c = "Invalid `variable` option passed into `_.template`", d = "__lodash_hash_undefined__", f = 500, m = "__lodash_placeholder__", y = 1, w = 2, E = 4, A = 1, B = 2, T = 1, $ = 2, V = 4, H = 8, Q = 16, te = 32, ge = 64, De = 128, rt = 256, Je = 512, lr = 30, Zi = "...", ei = 800, $s = 16, ti = 1, xi = 2, Ls = 3, Qn = Infinity, Fn = 9007199254740991, er = 17976931348623157e292, hn = NaN, He = 4294967295, St = He - 1, pn = He >>> 1, fr = [
			["ary", De],
			["bind", T],
			["bindKey", $],
			["curry", H],
			["curryRight", Q],
			["flip", Je],
			["partial", te],
			["partialRight", ge],
			["rearg", rt]
		], zt = "[object Arguments]", dr = "[object Array]", ni = "[object AsyncFunction]", Kt = "[object Boolean]", tr = "[object Date]", kr = "[object DOMException]", Rr = "[object Error]", hr = "[object Function]", An = "[object GeneratorFunction]", Ct = "[object Map]", Tr = "[object Number]", zs = "[object Null]", rn = "[object Object]", Fi = "[object Promise]", Hs = "[object Proxy]", gn = "[object RegExp]", It = "[object Set]", kt = "[object String]", pr = "[object Symbol]", be = "[object Undefined]", ut = "[object WeakMap]", S = "[object WeakSet]", g = "[object ArrayBuffer]", h = "[object DataView]", p = "[object Float32Array]", v = "[object Float64Array]", C = "[object Int8Array]", I = "[object Int16Array]", R = "[object Int32Array]", j = "[object Uint8Array]", ae = "[object Uint8ClampedArray]", de = "[object Uint16Array]", ce = "[object Uint32Array]", me = /\b__p \+= '';/g, sn = /\b(__p \+=) '' \+/g, Vt = /(__e\(.*?\)|\b__t\)) \+\n'';/g, Ji = /&(?:amp|lt|gt|quot|#39);/g, Xi = /[&<>"']/g, Tb = RegExp(Ji.source), Pb = RegExp(Xi.source), Nb = /<%-([\s\S]+?)%>/g, Ob = /<%([\s\S]+?)%>/g, rh = /<%=([\s\S]+?)%>/g, Ub = /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/, Mb = /^\w*$/, $b = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g, zu = /[\\^$.*+?()[\]{}|]/g, Lb = RegExp(zu.source), Hu = /^\s+/, zb = /\s/, Hb = /\{(?:\n\/\* \[wrapped with .+\] \*\/)?\n?/, qb = /\{\n\/\* \[wrapped with (.+)\] \*/, jb = /,? & /, Gb = /[^\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/g, Wb = /[()=,{}\[\]\/\s]/, Kb = /\\(\\)?/g, Vb = /\$\{([^\\}]*(?:\\.[^\\}]*)*)\}/g, ih = /\w*$/, Zb = /^[-+]0x[0-9a-f]+$/i, Jb = /^0b[01]+$/i, Xb = /^\[object .+?Constructor\]$/, Yb = /^0o[0-7]+$/i, Qb = /^(?:0|[1-9]\d*)$/, eE = /[\xc0-\xd6\xd8-\xf6\xf8-\xff\u0100-\u017f]/g, qo = /($^)/, tE = /['\n\r\u2028\u2029\\]/g, jo = "\\ud800-\\udfff", sh = "\\u0300-\\u036f\\ufe20-\\ufe2f\\u20d0-\\u20ff", oh = "\\u2700-\\u27bf", ah = "a-z\\xdf-\\xf6\\xf8-\\xff", sE = "\\xac\\xb1\\xd7\\xf7", oE = "\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf", aE = "\\u2000-\\u206f", uE = " \\t\\x0b\\f\\xa0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u202f\\u205f\\u3000", uh = "A-Z\\xc0-\\xd6\\xd8-\\xde", ch = "\\ufe0e\\ufe0f", lh = sE + oE + aE + uE, qu = "['’]", cE = "[" + jo + "]", fh = "[" + lh + "]", Go = "[" + sh + "]", dh = "\\d+", lE = "[" + oh + "]", hh = "[" + ah + "]", ph = "[^" + jo + lh + dh + oh + ah + uh + "]", ju = "\\ud83c[\\udffb-\\udfff]", fE = "(?:" + Go + "|" + ju + ")", gh = "[^" + jo + "]", Gu = "(?:\\ud83c[\\udde6-\\uddff]){2}", Wu = "[\\ud800-\\udbff][\\udc00-\\udfff]", Yi = "[" + uh + "]", mh = "\\u200d", yh = "(?:" + hh + "|" + ph + ")", dE = "(?:" + Yi + "|" + ph + ")", Dh = "(?:" + qu + "(?:d|ll|m|re|s|t|ve))?", wh = "(?:" + qu + "(?:D|LL|M|RE|S|T|VE))?", bh = fE + "?", Eh = "[" + ch + "]?", hE = "(?:" + mh + "(?:" + [
			gh,
			Gu,
			Wu
		].join("|") + ")" + Eh + bh + ")*", pE = "\\d*(?:1st|2nd|3rd|(?![123])\\dth)(?=\\b|[A-Z_])", gE = "\\d*(?:1ST|2ND|3RD|(?![123])\\dTH)(?=\\b|[a-z_])", vh = Eh + bh + hE, mE = "(?:" + [
			lE,
			Gu,
			Wu
		].join("|") + ")" + vh, yE = "(?:" + [
			gh + Go + "?",
			Go,
			Gu,
			Wu,
			cE
		].join("|") + ")", DE = RegExp(qu, "g"), wE = RegExp(Go, "g"), Ku = RegExp(ju + "(?=" + ju + ")|" + yE + vh, "g"), bE = RegExp([
			Yi + "?" + hh + "+" + Dh + "(?=" + [
				fh,
				Yi,
				"$"
			].join("|") + ")",
			dE + "+" + wh + "(?=" + [
				fh,
				Yi + yh,
				"$"
			].join("|") + ")",
			Yi + "?" + yh + "+" + Dh,
			Yi + "+" + wh,
			gE,
			pE,
			dh,
			mE
		].join("|"), "g"), EE = RegExp("[" + mh + jo + sh + ch + "]"), vE = /[a-z][A-Z]|[A-Z]{2}[a-z]|[0-9][a-zA-Z]|[a-zA-Z][0-9]|[^a-zA-Z0-9 ]/, SE = [
			"Array",
			"Buffer",
			"DataView",
			"Date",
			"Error",
			"Float32Array",
			"Float64Array",
			"Function",
			"Int8Array",
			"Int16Array",
			"Int32Array",
			"Map",
			"Math",
			"Object",
			"Promise",
			"RegExp",
			"Set",
			"String",
			"Symbol",
			"TypeError",
			"Uint8Array",
			"Uint8ClampedArray",
			"Uint16Array",
			"Uint32Array",
			"WeakMap",
			"_",
			"clearTimeout",
			"isFinite",
			"parseInt",
			"setTimeout"
		], CE = -1, nt = {};
		nt[p] = nt[v] = nt[C] = nt[I] = nt[R] = nt[j] = nt[ae] = nt[de] = nt[ce] = !0, nt[zt] = nt[dr] = nt[g] = nt[Kt] = nt[h] = nt[tr] = nt[Rr] = nt[hr] = nt[Ct] = nt[Tr] = nt[rn] = nt[gn] = nt[It] = nt[kt] = nt[ut] = !1;
		var et = {};
		et[zt] = et[dr] = et[g] = et[h] = et[Kt] = et[tr] = et[p] = et[v] = et[C] = et[I] = et[R] = et[Ct] = et[Tr] = et[rn] = et[gn] = et[It] = et[kt] = et[pr] = et[j] = et[ae] = et[de] = et[ce] = !0, et[Rr] = et[hr] = et[ut] = !1;
		var xE = {
			À: "A",
			Á: "A",
			Â: "A",
			Ã: "A",
			Ä: "A",
			Å: "A",
			à: "a",
			á: "a",
			â: "a",
			ã: "a",
			ä: "a",
			å: "a",
			Ç: "C",
			ç: "c",
			Ð: "D",
			ð: "d",
			È: "E",
			É: "E",
			Ê: "E",
			Ë: "E",
			è: "e",
			é: "e",
			ê: "e",
			ë: "e",
			Ì: "I",
			Í: "I",
			Î: "I",
			Ï: "I",
			ì: "i",
			í: "i",
			î: "i",
			ï: "i",
			Ñ: "N",
			ñ: "n",
			Ò: "O",
			Ó: "O",
			Ô: "O",
			Õ: "O",
			Ö: "O",
			Ø: "O",
			ò: "o",
			ó: "o",
			ô: "o",
			õ: "o",
			ö: "o",
			ø: "o",
			Ù: "U",
			Ú: "U",
			Û: "U",
			Ü: "U",
			ù: "u",
			ú: "u",
			û: "u",
			ü: "u",
			Ý: "Y",
			ý: "y",
			ÿ: "y",
			Æ: "Ae",
			æ: "ae",
			Þ: "Th",
			þ: "th",
			ß: "ss",
			Ā: "A",
			Ă: "A",
			Ą: "A",
			ā: "a",
			ă: "a",
			ą: "a",
			Ć: "C",
			Ĉ: "C",
			Ċ: "C",
			Č: "C",
			ć: "c",
			ĉ: "c",
			ċ: "c",
			č: "c",
			Ď: "D",
			Đ: "D",
			ď: "d",
			đ: "d",
			Ē: "E",
			Ĕ: "E",
			Ė: "E",
			Ę: "E",
			Ě: "E",
			ē: "e",
			ĕ: "e",
			ė: "e",
			ę: "e",
			ě: "e",
			Ĝ: "G",
			Ğ: "G",
			Ġ: "G",
			Ģ: "G",
			ĝ: "g",
			ğ: "g",
			ġ: "g",
			ģ: "g",
			Ĥ: "H",
			Ħ: "H",
			ĥ: "h",
			ħ: "h",
			Ĩ: "I",
			Ī: "I",
			Ĭ: "I",
			Į: "I",
			İ: "I",
			ĩ: "i",
			ī: "i",
			ĭ: "i",
			į: "i",
			ı: "i",
			Ĵ: "J",
			ĵ: "j",
			Ķ: "K",
			ķ: "k",
			ĸ: "k",
			Ĺ: "L",
			Ļ: "L",
			Ľ: "L",
			Ŀ: "L",
			Ł: "L",
			ĺ: "l",
			ļ: "l",
			ľ: "l",
			ŀ: "l",
			ł: "l",
			Ń: "N",
			Ņ: "N",
			Ň: "N",
			Ŋ: "N",
			ń: "n",
			ņ: "n",
			ň: "n",
			ŋ: "n",
			Ō: "O",
			Ŏ: "O",
			Ő: "O",
			ō: "o",
			ŏ: "o",
			ő: "o",
			Ŕ: "R",
			Ŗ: "R",
			Ř: "R",
			ŕ: "r",
			ŗ: "r",
			ř: "r",
			Ś: "S",
			Ŝ: "S",
			Ş: "S",
			Š: "S",
			ś: "s",
			ŝ: "s",
			ş: "s",
			š: "s",
			Ţ: "T",
			Ť: "T",
			Ŧ: "T",
			ţ: "t",
			ť: "t",
			ŧ: "t",
			Ũ: "U",
			Ū: "U",
			Ŭ: "U",
			Ů: "U",
			Ű: "U",
			Ų: "U",
			ũ: "u",
			ū: "u",
			ŭ: "u",
			ů: "u",
			ű: "u",
			ų: "u",
			Ŵ: "W",
			ŵ: "w",
			Ŷ: "Y",
			ŷ: "y",
			Ÿ: "Y",
			Ź: "Z",
			Ż: "Z",
			Ž: "Z",
			ź: "z",
			ż: "z",
			ž: "z",
			Ĳ: "IJ",
			ĳ: "ij",
			Œ: "Oe",
			œ: "oe",
			ŉ: "'n",
			ſ: "s"
		}, FE = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			"\"": "&quot;",
			"'": "&#39;"
		}, AE = {
			"&amp;": "&",
			"&lt;": "<",
			"&gt;": ">",
			"&quot;": "\"",
			"&#39;": "'"
		}, _E = {
			"\\": "\\",
			"'": "'",
			"\n": "n",
			"\r": "r",
			"\u2028": "u2028",
			"\u2029": "u2029"
		}, BE = parseFloat, IE = parseInt, Sh = typeof yt == "object" && yt && yt.Object === Object && yt, kE = typeof self == "object" && self && self.Object === Object && self, Ht = Sh || kE || Function("return this")(), Vu = t && !t.nodeType && t, Ai = Vu && e && !e.nodeType && e, Ch = Ai && Ai.exports === Vu, Zu = Ch && Sh.process, $n = function() {
			try {
				return Ai && Ai.require && Ai.require("util").types || Zu && Zu.binding && Zu.binding("util");
			} catch {}
		}(), xh = $n && $n.isArrayBuffer, Fh = $n && $n.isDate, Ah = $n && $n.isMap, _h = $n && $n.isRegExp, Bh = $n && $n.isSet, Ih = $n && $n.isTypedArray;
		function _n(U, G, q) {
			switch (q.length) {
				case 0: return U.call(G);
				case 1: return U.call(G, q[0]);
				case 2: return U.call(G, q[0], q[1]);
				case 3: return U.call(G, q[0], q[1], q[2]);
			}
			return U.apply(G, q);
		}
		function RE(U, G, q, le) {
			for (var Ce = -1, qe = U == null ? 0 : U.length; ++Ce < qe;) {
				var Rt = U[Ce];
				G(le, Rt, q(Rt), U);
			}
			return le;
		}
		function Ln(U, G) {
			for (var q = -1, le = U == null ? 0 : U.length; ++q < le && G(U[q], q, U) !== !1;);
			return U;
		}
		function TE(U, G) {
			for (var q = U == null ? 0 : U.length; q-- && G(U[q], q, U) !== !1;);
			return U;
		}
		function kh(U, G) {
			for (var q = -1, le = U == null ? 0 : U.length; ++q < le;) if (!G(U[q], q, U)) return !1;
			return !0;
		}
		function ri(U, G) {
			for (var q = -1, le = U == null ? 0 : U.length, Ce = 0, qe = []; ++q < le;) {
				var Rt = U[q];
				G(Rt, q, U) && (qe[Ce++] = Rt);
			}
			return qe;
		}
		function Wo(U, G) {
			return !!(U == null ? 0 : U.length) && Qi(U, G, 0) > -1;
		}
		function Ju(U, G, q) {
			for (var le = -1, Ce = U == null ? 0 : U.length; ++le < Ce;) if (q(G, U[le])) return !0;
			return !1;
		}
		function it(U, G) {
			for (var q = -1, le = U == null ? 0 : U.length, Ce = Array(le); ++q < le;) Ce[q] = G(U[q], q, U);
			return Ce;
		}
		function ii(U, G) {
			for (var q = -1, le = G.length, Ce = U.length; ++q < le;) U[Ce + q] = G[q];
			return U;
		}
		function Xu(U, G, q, le) {
			var Ce = -1, qe = U == null ? 0 : U.length;
			for (le && qe && (q = U[++Ce]); ++Ce < qe;) q = G(q, U[Ce], Ce, U);
			return q;
		}
		function PE(U, G, q, le) {
			var Ce = U == null ? 0 : U.length;
			for (le && Ce && (q = U[--Ce]); Ce--;) q = G(q, U[Ce], Ce, U);
			return q;
		}
		function Yu(U, G) {
			for (var q = -1, le = U == null ? 0 : U.length; ++q < le;) if (G(U[q], q, U)) return !0;
			return !1;
		}
		var NE = Qu("length");
		function OE(U) {
			return U.split("");
		}
		function UE(U) {
			return U.match(Gb) || [];
		}
		function Rh(U, G, q) {
			var le;
			return q(U, function(Ce, qe, Rt) {
				if (G(Ce, qe, Rt)) return le = qe, !1;
			}), le;
		}
		function Ko(U, G, q, le) {
			for (var Ce = U.length, qe = q + (le ? 1 : -1); le ? qe-- : ++qe < Ce;) if (G(U[qe], qe, U)) return qe;
			return -1;
		}
		function Qi(U, G, q) {
			return G === G ? ZE(U, G, q) : Ko(U, Th, q);
		}
		function ME(U, G, q, le) {
			for (var Ce = q - 1, qe = U.length; ++Ce < qe;) if (le(U[Ce], G)) return Ce;
			return -1;
		}
		function Th(U) {
			return U !== U;
		}
		function Ph(U, G) {
			var q = U == null ? 0 : U.length;
			return q ? tc(U, G) / q : hn;
		}
		function Qu(U) {
			return function(G) {
				return G == null ? n : G[U];
			};
		}
		function ec(U) {
			return function(G) {
				return U == null ? n : U[G];
			};
		}
		function Nh(U, G, q, le, Ce) {
			return Ce(U, function(qe, Rt, Xe) {
				q = le ? (le = !1, qe) : G(q, qe, Rt, Xe);
			}), q;
		}
		function $E(U, G) {
			var q = U.length;
			for (U.sort(G); q--;) U[q] = U[q].value;
			return U;
		}
		function tc(U, G) {
			for (var q, le = -1, Ce = U.length; ++le < Ce;) {
				var qe = G(U[le]);
				qe !== n && (q = q === n ? qe : q + qe);
			}
			return q;
		}
		function nc(U, G) {
			for (var q = -1, le = Array(U); ++q < U;) le[q] = G(q);
			return le;
		}
		function LE(U, G) {
			return it(G, function(q) {
				return [q, U[q]];
			});
		}
		function Oh(U) {
			return U && U.slice(0, Lh(U) + 1).replace(Hu, "");
		}
		function Bn(U) {
			return function(G) {
				return U(G);
			};
		}
		function rc(U, G) {
			return it(G, function(q) {
				return U[q];
			});
		}
		function qs(U, G) {
			return U.has(G);
		}
		function Uh(U, G) {
			for (var q = -1, le = U.length; ++q < le && Qi(G, U[q], 0) > -1;);
			return q;
		}
		function Mh(U, G) {
			for (var q = U.length; q-- && Qi(G, U[q], 0) > -1;);
			return q;
		}
		function zE(U, G) {
			for (var q = U.length, le = 0; q--;) U[q] === G && ++le;
			return le;
		}
		var HE = ec(xE), qE = ec(FE);
		function jE(U) {
			return "\\" + _E[U];
		}
		function GE(U, G) {
			return U == null ? n : U[G];
		}
		function es(U) {
			return EE.test(U);
		}
		function WE(U) {
			return vE.test(U);
		}
		function KE(U) {
			for (var G, q = []; !(G = U.next()).done;) q.push(G.value);
			return q;
		}
		function ic(U) {
			var G = -1, q = Array(U.size);
			return U.forEach(function(le, Ce) {
				q[++G] = [Ce, le];
			}), q;
		}
		function $h(U, G) {
			return function(q) {
				return U(G(q));
			};
		}
		function si(U, G) {
			for (var q = -1, le = U.length, Ce = 0, qe = []; ++q < le;) {
				var Rt = U[q];
				(Rt === G || Rt === m) && (U[q] = m, qe[Ce++] = q);
			}
			return qe;
		}
		function Vo(U) {
			var G = -1, q = Array(U.size);
			return U.forEach(function(le) {
				q[++G] = le;
			}), q;
		}
		function VE(U) {
			var G = -1, q = Array(U.size);
			return U.forEach(function(le) {
				q[++G] = [le, le];
			}), q;
		}
		function ZE(U, G, q) {
			for (var le = q - 1, Ce = U.length; ++le < Ce;) if (U[le] === G) return le;
			return -1;
		}
		function JE(U, G, q) {
			for (var le = q + 1; le--;) if (U[le] === G) return le;
			return le;
		}
		function ts(U) {
			return es(U) ? YE(U) : NE(U);
		}
		function nr(U) {
			return es(U) ? QE(U) : OE(U);
		}
		function Lh(U) {
			for (var G = U.length; G-- && zb.test(U.charAt(G)););
			return G;
		}
		var XE = ec(AE);
		function YE(U) {
			for (var G = Ku.lastIndex = 0; Ku.test(U);) ++G;
			return G;
		}
		function QE(U) {
			return U.match(Ku) || [];
		}
		function e1(U) {
			return U.match(bE) || [];
		}
		var ns = function U(G) {
			G = G == null ? Ht : ns.defaults(Ht.Object(), G, ns.pick(Ht, SE));
			var q = G.Array, le = G.Date, Ce = G.Error, qe = G.Function, Rt = G.Math, Xe = G.Object, sc = G.RegExp, n1 = G.String, zn = G.TypeError, Zo = q.prototype, r1 = qe.prototype, rs = Xe.prototype, Jo = G["__core-js_shared__"], Xo = r1.toString, Ge = rs.hasOwnProperty, i1 = 0, zh = function() {
				var i = /[^.]+$/.exec(Jo && Jo.keys && Jo.keys.IE_PROTO || "");
				return i ? "Symbol(src)_1." + i : "";
			}(), Yo = rs.toString, s1 = Xo.call(Xe), o1 = Ht._, a1 = sc("^" + Xo.call(Ge).replace(zu, "\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, "$1.*?") + "$"), Qo = Ch ? G.Buffer : n, oi = G.Symbol, ea = G.Uint8Array, Hh = Qo ? Qo.allocUnsafe : n, ta = $h(Xe.getPrototypeOf, Xe), qh = Xe.create, jh = rs.propertyIsEnumerable, na = Zo.splice, Gh = oi ? oi.isConcatSpreadable : n, js = oi ? oi.iterator : n, _i = oi ? oi.toStringTag : n, ra = function() {
				try {
					var i = Ti(Xe, "defineProperty");
					return i({}, "", {}), i;
				} catch {}
			}(), u1 = G.clearTimeout !== Ht.clearTimeout && G.clearTimeout, c1 = le && le.now !== Ht.Date.now && le.now, l1 = G.setTimeout !== Ht.setTimeout && G.setTimeout, ia = Rt.ceil, sa = Rt.floor, oc = Xe.getOwnPropertySymbols, f1 = Qo ? Qo.isBuffer : n, Wh = G.isFinite, d1 = Zo.join, h1 = $h(Xe.keys, Xe), Tt = Rt.max, Zt = Rt.min, p1 = le.now, g1 = G.parseInt, Kh = Rt.random, m1 = Zo.reverse, ac = Ti(G, "DataView"), Gs = Ti(G, "Map"), uc = Ti(G, "Promise"), is = Ti(G, "Set"), Ws = Ti(G, "WeakMap"), Ks = Ti(Xe, "create"), oa = Ws && new Ws(), ss = {}, y1 = Pi(ac), D1 = Pi(Gs), w1 = Pi(uc), b1 = Pi(is), E1 = Pi(Ws), aa = oi ? oi.prototype : n, Vs = aa ? aa.valueOf : n, Vh = aa ? aa.toString : n;
			function x(i) {
				if (ct(i) && !Fe(i) && !(i instanceof Oe)) {
					if (i instanceof Hn) return i;
					if (Ge.call(i, "__wrapped__")) return Zp(i);
				}
				return new Hn(i);
			}
			var os = /* @__PURE__ */ function() {
				function i() {}
				return function(a) {
					if (!st(a)) return {};
					if (qh) return qh(a);
					i.prototype = a;
					var l = new i();
					return i.prototype = n, l;
				};
			}();
			function ua() {}
			function Hn(i, a) {
				this.__wrapped__ = i, this.__actions__ = [], this.__chain__ = !!a, this.__index__ = 0, this.__values__ = n;
			}
			x.templateSettings = {
				escape: Nb,
				evaluate: Ob,
				interpolate: rh,
				variable: "",
				imports: { _: x }
			}, x.prototype = ua.prototype, x.prototype.constructor = x, Hn.prototype = os(ua.prototype), Hn.prototype.constructor = Hn;
			function Oe(i) {
				this.__wrapped__ = i, this.__actions__ = [], this.__dir__ = 1, this.__filtered__ = !1, this.__iteratees__ = [], this.__takeCount__ = He, this.__views__ = [];
			}
			function v1() {
				var i = new Oe(this.__wrapped__);
				return i.__actions__ = mn(this.__actions__), i.__dir__ = this.__dir__, i.__filtered__ = this.__filtered__, i.__iteratees__ = mn(this.__iteratees__), i.__takeCount__ = this.__takeCount__, i.__views__ = mn(this.__views__), i;
			}
			function S1() {
				if (this.__filtered__) {
					var i = new Oe(this);
					i.__dir__ = -1, i.__filtered__ = !0;
				} else i = this.clone(), i.__dir__ *= -1;
				return i;
			}
			function C1() {
				var i = this.__wrapped__.value(), a = this.__dir__, l = Fe(i), D = a < 0, b = l ? i.length : 0, F = Ov(0, b, this.__views__), k = F.start, O = F.end, M = O - k, Z = D ? O : k - 1, J = this.__iteratees__, ee = J.length, oe = 0, ye = Zt(M, this.__takeCount__);
				if (!l || !D && b == M && ye == M) return Dp(i, this.__actions__);
				var Ee = [];
				e: for (; M-- && oe < ye;) {
					Z += a;
					for (var ke = -1, ve = i[Z]; ++ke < ee;) {
						var Pe = J[ke], Me = Pe.iteratee, Rn = Pe.type, un = Me(ve);
						if (Rn == xi) ve = un;
						else if (!un) {
							if (Rn == ti) continue e;
							break e;
						}
					}
					Ee[oe++] = ve;
				}
				return Ee;
			}
			Oe.prototype = os(ua.prototype), Oe.prototype.constructor = Oe;
			function Bi(i) {
				var a = -1, l = i == null ? 0 : i.length;
				for (this.clear(); ++a < l;) {
					var D = i[a];
					this.set(D[0], D[1]);
				}
			}
			function x1() {
				this.__data__ = Ks ? Ks(null) : {}, this.size = 0;
			}
			function F1(i) {
				var a = this.has(i) && delete this.__data__[i];
				return this.size -= a ? 1 : 0, a;
			}
			function A1(i) {
				var a = this.__data__;
				if (Ks) {
					var l = a[i];
					return l === d ? n : l;
				}
				return Ge.call(a, i) ? a[i] : n;
			}
			function _1(i) {
				var a = this.__data__;
				return Ks ? a[i] !== n : Ge.call(a, i);
			}
			function B1(i, a) {
				var l = this.__data__;
				return this.size += this.has(i) ? 0 : 1, l[i] = Ks && a === n ? d : a, this;
			}
			Bi.prototype.clear = x1, Bi.prototype.delete = F1, Bi.prototype.get = A1, Bi.prototype.has = _1, Bi.prototype.set = B1;
			function Pr(i) {
				var a = -1, l = i == null ? 0 : i.length;
				for (this.clear(); ++a < l;) {
					var D = i[a];
					this.set(D[0], D[1]);
				}
			}
			function I1() {
				this.__data__ = [], this.size = 0;
			}
			function k1(i) {
				var a = this.__data__, l = ca(a, i);
				if (l < 0) return !1;
				return l == a.length - 1 ? a.pop() : na.call(a, l, 1), --this.size, !0;
			}
			function R1(i) {
				var a = this.__data__, l = ca(a, i);
				return l < 0 ? n : a[l][1];
			}
			function T1(i) {
				return ca(this.__data__, i) > -1;
			}
			function P1(i, a) {
				var l = this.__data__, D = ca(l, i);
				return D < 0 ? (++this.size, l.push([i, a])) : l[D][1] = a, this;
			}
			Pr.prototype.clear = I1, Pr.prototype.delete = k1, Pr.prototype.get = R1, Pr.prototype.has = T1, Pr.prototype.set = P1;
			function Nr(i) {
				var a = -1, l = i == null ? 0 : i.length;
				for (this.clear(); ++a < l;) {
					var D = i[a];
					this.set(D[0], D[1]);
				}
			}
			function N1() {
				this.size = 0, this.__data__ = {
					hash: new Bi(),
					map: new (Gs || Pr)(),
					string: new Bi()
				};
			}
			function O1(i) {
				var a = Ea(this, i).delete(i);
				return this.size -= a ? 1 : 0, a;
			}
			function U1(i) {
				return Ea(this, i).get(i);
			}
			function M1(i) {
				return Ea(this, i).has(i);
			}
			function $1(i, a) {
				var l = Ea(this, i), D = l.size;
				return l.set(i, a), this.size += l.size == D ? 0 : 1, this;
			}
			Nr.prototype.clear = N1, Nr.prototype.delete = O1, Nr.prototype.get = U1, Nr.prototype.has = M1, Nr.prototype.set = $1;
			function Ii(i) {
				var a = -1, l = i == null ? 0 : i.length;
				for (this.__data__ = new Nr(); ++a < l;) this.add(i[a]);
			}
			function L1(i) {
				return this.__data__.set(i, d), this;
			}
			function z1(i) {
				return this.__data__.has(i);
			}
			Ii.prototype.add = Ii.prototype.push = L1, Ii.prototype.has = z1;
			function rr(i) {
				this.size = (this.__data__ = new Pr(i)).size;
			}
			function H1() {
				this.__data__ = new Pr(), this.size = 0;
			}
			function q1(i) {
				var a = this.__data__, l = a.delete(i);
				return this.size = a.size, l;
			}
			function j1(i) {
				return this.__data__.get(i);
			}
			function G1(i) {
				return this.__data__.has(i);
			}
			function W1(i, a) {
				var l = this.__data__;
				if (l instanceof Pr) {
					var D = l.__data__;
					if (!Gs || D.length < s - 1) return D.push([i, a]), this.size = ++l.size, this;
					l = this.__data__ = new Nr(D);
				}
				return l.set(i, a), this.size = l.size, this;
			}
			rr.prototype.clear = H1, rr.prototype.delete = q1, rr.prototype.get = j1, rr.prototype.has = G1, rr.prototype.set = W1;
			function Zh(i, a) {
				var l = Fe(i), D = !l && Ni(i), b = !l && !D && fi(i), F = !l && !D && !b && ls(i), k = l || D || b || F, O = k ? nc(i.length, n1) : [], M = O.length;
				for (var Z in i) (a || Ge.call(i, Z)) && !(k && (Z == "length" || b && (Z == "offset" || Z == "parent") || F && (Z == "buffer" || Z == "byteLength" || Z == "byteOffset") || $r(Z, M))) && O.push(Z);
				return O;
			}
			function Jh(i) {
				var a = i.length;
				return a ? i[wc(0, a - 1)] : n;
			}
			function K1(i, a) {
				return va(mn(i), ki(a, 0, i.length));
			}
			function V1(i) {
				return va(mn(i));
			}
			function cc(i, a, l) {
				(l !== n && !ir(i[a], l) || l === n && !(a in i)) && Or(i, a, l);
			}
			function Zs(i, a, l) {
				var D = i[a];
				(!(Ge.call(i, a) && ir(D, l)) || l === n && !(a in i)) && Or(i, a, l);
			}
			function ca(i, a) {
				for (var l = i.length; l--;) if (ir(i[l][0], a)) return l;
				return -1;
			}
			function Z1(i, a, l, D) {
				return ai(i, function(b, F, k) {
					a(D, b, l(b), k);
				}), D;
			}
			function Xh(i, a) {
				return i && mr(a, Nt(a), i);
			}
			function J1(i, a) {
				return i && mr(a, Dn(a), i);
			}
			function Or(i, a, l) {
				a == "__proto__" && ra ? ra(i, a, {
					configurable: !0,
					enumerable: !0,
					value: l,
					writable: !0
				}) : i[a] = l;
			}
			function lc(i, a) {
				for (var l = -1, D = a.length, b = q(D), F = i == null; ++l < D;) b[l] = F ? n : jc(i, a[l]);
				return b;
			}
			function ki(i, a, l) {
				return i === i && (l !== n && (i = i <= l ? i : l), a !== n && (i = i >= a ? i : a)), i;
			}
			function qn(i, a, l, D, b, F) {
				var k, O = a & y, M = a & w, Z = a & E;
				if (l && (k = b ? l(i, D, b, F) : l(i)), k !== n) return k;
				if (!st(i)) return i;
				var J = Fe(i);
				if (J) {
					if (k = Mv(i), !O) return mn(i, k);
				} else {
					var ee = Jt(i), oe = ee == hr || ee == An;
					if (fi(i)) return Ep(i, O);
					if (ee == rn || ee == zt || oe && !b) {
						if (k = M || oe ? {} : Lp(i), !O) return M ? Av(i, J1(k, i)) : Fv(i, Xh(k, i));
					} else {
						if (!et[ee]) return b ? i : {};
						k = $v(i, ee, O);
					}
				}
				F || (F = new rr());
				var ye = F.get(i);
				if (ye) return ye;
				F.set(i, k), gg(i) ? i.forEach(function(ve) {
					k.add(qn(ve, a, l, ve, i, F));
				}) : hg(i) && i.forEach(function(ve, Pe) {
					k.set(Pe, qn(ve, a, l, Pe, i, F));
				});
				var ke = J ? n : (Z ? M ? Ic : Bc : M ? Dn : Nt)(i);
				return Ln(ke || i, function(ve, Pe) {
					ke && (Pe = ve, ve = i[Pe]), Zs(k, Pe, qn(ve, a, l, Pe, i, F));
				}), k;
			}
			function X1(i) {
				var a = Nt(i);
				return function(l) {
					return Yh(l, i, a);
				};
			}
			function Yh(i, a, l) {
				var D = l.length;
				if (i == null) return !D;
				for (i = Xe(i); D--;) {
					var b = l[D], F = a[b], k = i[b];
					if (k === n && !(b in i) || !F(k)) return !1;
				}
				return !0;
			}
			function Qh(i, a, l) {
				if (typeof i != "function") throw new zn(u);
				return no(function() {
					i.apply(n, l);
				}, a);
			}
			function Js(i, a, l, D) {
				var b = -1, F = Wo, k = !0, O = i.length, M = [], Z = a.length;
				if (!O) return M;
				l && (a = it(a, Bn(l))), D ? (F = Ju, k = !1) : a.length >= s && (F = qs, k = !1, a = new Ii(a));
				e: for (; ++b < O;) {
					var J = i[b], ee = l == null ? J : l(J);
					if (J = D || J !== 0 ? J : 0, k && ee === ee) {
						for (var oe = Z; oe--;) if (a[oe] === ee) continue e;
						M.push(J);
					} else F(a, ee, D) || M.push(J);
				}
				return M;
			}
			var ai = Fp(gr), ep = Fp(dc, !0);
			function Y1(i, a) {
				var l = !0;
				return ai(i, function(D, b, F) {
					return l = !!a(D, b, F), l;
				}), l;
			}
			function la(i, a, l) {
				for (var D = -1, b = i.length; ++D < b;) {
					var F = i[D], k = a(F);
					if (k != null && (O === n ? k === k && !kn(k) : l(k, O))) var O = k, M = F;
				}
				return M;
			}
			function Q1(i, a, l, D) {
				var b = i.length;
				for (l = Ie(l), l < 0 && (l = -l > b ? 0 : b + l), D = D === n || D > b ? b : Ie(D), D < 0 && (D += b), D = l > D ? 0 : yg(D); l < D;) i[l++] = a;
				return i;
			}
			function tp(i, a) {
				var l = [];
				return ai(i, function(D, b, F) {
					a(D, b, F) && l.push(D);
				}), l;
			}
			function qt(i, a, l, D, b) {
				var F = -1, k = i.length;
				for (l || (l = zv), b || (b = []); ++F < k;) {
					var O = i[F];
					a > 0 && l(O) ? a > 1 ? qt(O, a - 1, l, D, b) : ii(b, O) : D || (b[b.length] = O);
				}
				return b;
			}
			var fc = Ap(), np = Ap(!0);
			function gr(i, a) {
				return i && fc(i, a, Nt);
			}
			function dc(i, a) {
				return i && np(i, a, Nt);
			}
			function fa(i, a) {
				return ri(a, function(l) {
					return Lr(i[l]);
				});
			}
			function Ri(i, a) {
				a = ci(a, i);
				for (var l = 0, D = a.length; i != null && l < D;) i = i[yr(a[l++])];
				return l && l == D ? i : n;
			}
			function rp(i, a, l) {
				var D = a(i);
				return Fe(i) ? D : ii(D, l(i));
			}
			function on(i) {
				return i == null ? i === n ? be : zs : _i && _i in Xe(i) ? Nv(i) : Vv(i);
			}
			function hc(i, a) {
				return i > a;
			}
			function ev(i, a) {
				return i != null && Ge.call(i, a);
			}
			function tv(i, a) {
				return i != null && a in Xe(i);
			}
			function nv(i, a, l) {
				return i >= Zt(a, l) && i < Tt(a, l);
			}
			function pc(i, a, l) {
				for (var D = l ? Ju : Wo, b = i[0].length, F = i.length, k = F, O = q(F), M = Infinity, Z = []; k--;) {
					var J = i[k];
					k && a && (J = it(J, Bn(a))), M = Zt(J.length, M), O[k] = !l && (a || b >= 120 && J.length >= 120) ? new Ii(k && J) : n;
				}
				J = i[0];
				var ee = -1, oe = O[0];
				e: for (; ++ee < b && Z.length < M;) {
					var ye = J[ee], Ee = a ? a(ye) : ye;
					if (ye = l || ye !== 0 ? ye : 0, !(oe ? qs(oe, Ee) : D(Z, Ee, l))) {
						for (k = F; --k;) {
							var ke = O[k];
							if (!(ke ? qs(ke, Ee) : D(i[k], Ee, l))) continue e;
						}
						oe && oe.push(Ee), Z.push(ye);
					}
				}
				return Z;
			}
			function rv(i, a, l, D) {
				return gr(i, function(b, F, k) {
					a(D, l(b), F, k);
				}), D;
			}
			function Xs(i, a, l) {
				a = ci(a, i), i = jp(i, a);
				var D = i == null ? i : i[yr(Gn(a))];
				return D == null ? n : _n(D, i, l);
			}
			function ip(i) {
				return ct(i) && on(i) == zt;
			}
			function iv(i) {
				return ct(i) && on(i) == g;
			}
			function sv(i) {
				return ct(i) && on(i) == tr;
			}
			function Ys(i, a, l, D, b) {
				return i === a ? !0 : i == null || a == null || !ct(i) && !ct(a) ? i !== i && a !== a : ov(i, a, l, D, Ys, b);
			}
			function ov(i, a, l, D, b, F) {
				var k = Fe(i), O = Fe(a), M = k ? dr : Jt(i), Z = O ? dr : Jt(a);
				M = M == zt ? rn : M, Z = Z == zt ? rn : Z;
				var J = M == rn, ee = Z == rn, oe = M == Z;
				if (oe && fi(i)) {
					if (!fi(a)) return !1;
					k = !0, J = !1;
				}
				if (oe && !J) return F || (F = new rr()), k || ls(i) ? Up(i, a, l, D, b, F) : Tv(i, a, M, l, D, b, F);
				if (!(l & A)) {
					var ye = J && Ge.call(i, "__wrapped__"), Ee = ee && Ge.call(a, "__wrapped__");
					if (ye || Ee) {
						var ke = ye ? i.value() : i, ve = Ee ? a.value() : a;
						return F || (F = new rr()), b(ke, ve, l, D, F);
					}
				}
				return oe ? (F || (F = new rr()), Pv(i, a, l, D, b, F)) : !1;
			}
			function av(i) {
				return ct(i) && Jt(i) == Ct;
			}
			function gc(i, a, l, D) {
				var b = l.length, F = b, k = !D;
				if (i == null) return !F;
				for (i = Xe(i); b--;) {
					var O = l[b];
					if (k && O[2] ? O[1] !== i[O[0]] : !(O[0] in i)) return !1;
				}
				for (; ++b < F;) {
					O = l[b];
					var M = O[0], Z = i[M], J = O[1];
					if (k && O[2]) {
						if (Z === n && !(M in i)) return !1;
					} else {
						var ee = new rr();
						if (D) var oe = D(Z, J, M, i, a, ee);
						if (!(oe === n ? Ys(J, Z, A | B, D, ee) : oe)) return !1;
					}
				}
				return !0;
			}
			function sp(i) {
				if (!st(i) || qv(i)) return !1;
				return (Lr(i) ? a1 : Xb).test(Pi(i));
			}
			function uv(i) {
				return ct(i) && on(i) == gn;
			}
			function cv(i) {
				return ct(i) && Jt(i) == It;
			}
			function lv(i) {
				return ct(i) && _a(i.length) && !!nt[on(i)];
			}
			function op(i) {
				return typeof i == "function" ? i : i == null ? wn : typeof i == "object" ? Fe(i) ? cp(i[0], i[1]) : up(i) : _g(i);
			}
			function mc(i) {
				if (!to(i)) return h1(i);
				var a = [];
				for (var l in Xe(i)) Ge.call(i, l) && l != "constructor" && a.push(l);
				return a;
			}
			function fv(i) {
				if (!st(i)) return Kv(i);
				var a = to(i), l = [];
				for (var D in i) D == "constructor" && (a || !Ge.call(i, D)) || l.push(D);
				return l;
			}
			function yc(i, a) {
				return i < a;
			}
			function ap(i, a) {
				var l = -1, D = yn(i) ? q(i.length) : [];
				return ai(i, function(b, F, k) {
					D[++l] = a(b, F, k);
				}), D;
			}
			function up(i) {
				var a = Rc(i);
				return a.length == 1 && a[0][2] ? Hp(a[0][0], a[0][1]) : function(l) {
					return l === i || gc(l, i, a);
				};
			}
			function cp(i, a) {
				return Pc(i) && zp(a) ? Hp(yr(i), a) : function(l) {
					var D = jc(l, i);
					return D === n && D === a ? Gc(l, i) : Ys(a, D, A | B);
				};
			}
			function da(i, a, l, D, b) {
				i !== a && fc(a, function(F, k) {
					if (b || (b = new rr()), st(F)) dv(i, a, k, l, da, D, b);
					else {
						var O = D ? D(Oc(i, k), F, k + "", i, a, b) : n;
						O === n && (O = F), cc(i, k, O);
					}
				}, Dn);
			}
			function dv(i, a, l, D, b, F, k) {
				var O = Oc(i, l), M = Oc(a, l), Z = k.get(M);
				if (Z) {
					cc(i, l, Z);
					return;
				}
				var J = F ? F(O, M, l + "", i, a, k) : n, ee = J === n;
				if (ee) {
					var oe = Fe(M), ye = !oe && fi(M), Ee = !oe && !ye && ls(M);
					J = M, oe || ye || Ee ? Fe(O) ? J = O : dt(O) ? J = mn(O) : ye ? (ee = !1, J = Ep(M, !0)) : Ee ? (ee = !1, J = vp(M, !0)) : J = [] : ro(M) || Ni(M) ? (J = O, Ni(O) ? J = Dg(O) : (!st(O) || Lr(O)) && (J = Lp(M))) : ee = !1;
				}
				ee && (k.set(M, J), b(J, M, D, F, k), k.delete(M)), cc(i, l, J);
			}
			function lp(i, a) {
				var l = i.length;
				if (l) return a += a < 0 ? l : 0, $r(a, l) ? i[a] : n;
			}
			function fp(i, a, l) {
				a.length ? a = it(a, function(F) {
					return Fe(F) ? function(k) {
						return Ri(k, F.length === 1 ? F[0] : F);
					} : F;
				}) : a = [wn];
				var D = -1;
				a = it(a, Bn(we()));
				return $E(ap(i, function(F, k, O) {
					return {
						criteria: it(a, function(Z) {
							return Z(F);
						}),
						index: ++D,
						value: F
					};
				}), function(F, k) {
					return xv(F, k, l);
				});
			}
			function hv(i, a) {
				return dp(i, a, function(l, D) {
					return Gc(i, D);
				});
			}
			function dp(i, a, l) {
				for (var D = -1, b = a.length, F = {}; ++D < b;) {
					var k = a[D], O = Ri(i, k);
					l(O, k) && Qs(F, ci(k, i), O);
				}
				return F;
			}
			function pv(i) {
				return function(a) {
					return Ri(a, i);
				};
			}
			function Dc(i, a, l, D) {
				var b = D ? ME : Qi, F = -1, k = a.length, O = i;
				for (i === a && (a = mn(a)), l && (O = it(i, Bn(l))); ++F < k;) for (var M = 0, Z = a[F], J = l ? l(Z) : Z; (M = b(O, J, M, D)) > -1;) O !== i && na.call(O, M, 1), na.call(i, M, 1);
				return i;
			}
			function hp(i, a) {
				for (var l = i ? a.length : 0, D = l - 1; l--;) {
					var b = a[l];
					if (l == D || b !== F) {
						var F = b;
						$r(b) ? na.call(i, b, 1) : vc(i, b);
					}
				}
				return i;
			}
			function wc(i, a) {
				return i + sa(Kh() * (a - i + 1));
			}
			function gv(i, a, l, D) {
				for (var b = -1, F = Tt(ia((a - i) / (l || 1)), 0), k = q(F); F--;) k[D ? F : ++b] = i, i += l;
				return k;
			}
			function bc(i, a) {
				var l = "";
				if (!i || a < 1 || a > Fn) return l;
				do
					a % 2 && (l += i), a = sa(a / 2), a && (i += i);
				while (a);
				return l;
			}
			function Te(i, a) {
				return Uc(qp(i, a, wn), i + "");
			}
			function mv(i) {
				return Jh(fs(i));
			}
			function yv(i, a) {
				var l = fs(i);
				return va(l, ki(a, 0, l.length));
			}
			function Qs(i, a, l, D) {
				if (!st(i)) return i;
				a = ci(a, i);
				for (var b = -1, F = a.length, k = F - 1, O = i; O != null && ++b < F;) {
					var M = yr(a[b]), Z = l;
					if (M === "__proto__" || M === "constructor" || M === "prototype") return i;
					if (b != k) {
						var J = O[M];
						Z = D ? D(J, M, O) : n, Z === n && (Z = st(J) ? J : $r(a[b + 1]) ? [] : {});
					}
					Zs(O, M, Z), O = O[M];
				}
				return i;
			}
			var pp = oa ? function(i, a) {
				return oa.set(i, a), i;
			} : wn, Dv = ra ? function(i, a) {
				return ra(i, "toString", {
					configurable: !0,
					enumerable: !1,
					value: Kc(a),
					writable: !0
				});
			} : wn;
			function wv(i) {
				return va(fs(i));
			}
			function jn(i, a, l) {
				var D = -1, b = i.length;
				a < 0 && (a = -a > b ? 0 : b + a), l = l > b ? b : l, l < 0 && (l += b), b = a > l ? 0 : l - a >>> 0, a >>>= 0;
				for (var F = q(b); ++D < b;) F[D] = i[D + a];
				return F;
			}
			function bv(i, a) {
				var l;
				return ai(i, function(D, b, F) {
					return l = a(D, b, F), !l;
				}), !!l;
			}
			function ha(i, a, l) {
				var D = 0, b = i == null ? D : i.length;
				if (typeof a == "number" && a === a && b <= pn) {
					for (; D < b;) {
						var F = D + b >>> 1, k = i[F];
						k !== null && !kn(k) && (l ? k <= a : k < a) ? D = F + 1 : b = F;
					}
					return b;
				}
				return Ec(i, a, wn, l);
			}
			function Ec(i, a, l, D) {
				var b = 0, F = i == null ? 0 : i.length;
				if (F === 0) return 0;
				a = l(a);
				for (var k = a !== a, O = a === null, M = kn(a), Z = a === n; b < F;) {
					var J = sa((b + F) / 2), ee = l(i[J]), oe = ee !== n, ye = ee === null, Ee = ee === ee, ke = kn(ee);
					if (k) var ve = D || Ee;
					else Z ? ve = Ee && (D || oe) : O ? ve = Ee && oe && (D || !ye) : M ? ve = Ee && oe && !ye && (D || !ke) : ye || ke ? ve = !1 : ve = D ? ee <= a : ee < a;
					ve ? b = J + 1 : F = J;
				}
				return Zt(F, St);
			}
			function gp(i, a) {
				for (var l = -1, D = i.length, b = 0, F = []; ++l < D;) {
					var k = i[l], O = a ? a(k) : k;
					if (!l || !ir(O, M)) {
						var M = O;
						F[b++] = k === 0 ? 0 : k;
					}
				}
				return F;
			}
			function mp(i) {
				return typeof i == "number" ? i : kn(i) ? hn : +i;
			}
			function In(i) {
				if (typeof i == "string") return i;
				if (Fe(i)) return it(i, In) + "";
				if (kn(i)) return Vh ? Vh.call(i) : "";
				var a = i + "";
				return a == "0" && 1 / i == -Qn ? "-0" : a;
			}
			function ui(i, a, l) {
				var D = -1, b = Wo, F = i.length, k = !0, O = [], M = O;
				if (l) k = !1, b = Ju;
				else if (F >= s) {
					var Z = a ? null : kv(i);
					if (Z) return Vo(Z);
					k = !1, b = qs, M = new Ii();
				} else M = a ? [] : O;
				e: for (; ++D < F;) {
					var J = i[D], ee = a ? a(J) : J;
					if (J = l || J !== 0 ? J : 0, k && ee === ee) {
						for (var oe = M.length; oe--;) if (M[oe] === ee) continue e;
						a && M.push(ee), O.push(J);
					} else b(M, ee, l) || (M !== O && M.push(ee), O.push(J));
				}
				return O;
			}
			function vc(i, a) {
				a = ci(a, i);
				var l = -1, D = a.length;
				if (!D) return !0;
				for (var b = i == null || typeof i != "object" && typeof i != "function"; ++l < D;) {
					var F = a[l];
					if (typeof F == "string") {
						if (F === "__proto__" && !Ge.call(i, "__proto__")) return !1;
						if (F === "constructor" && l + 1 < D && typeof a[l + 1] == "string" && a[l + 1] === "prototype") {
							if (b && l === 0) continue;
							return !1;
						}
					}
				}
				var k = jp(i, a);
				return k == null || delete k[yr(Gn(a))];
			}
			function yp(i, a, l, D) {
				return Qs(i, a, l(Ri(i, a)), D);
			}
			function pa(i, a, l, D) {
				for (var b = i.length, F = D ? b : -1; (D ? F-- : ++F < b) && a(i[F], F, i););
				return l ? jn(i, D ? 0 : F, D ? F + 1 : b) : jn(i, D ? F + 1 : 0, D ? b : F);
			}
			function Dp(i, a) {
				var l = i;
				return l instanceof Oe && (l = l.value()), Xu(a, function(D, b) {
					return b.func.apply(b.thisArg, ii([D], b.args));
				}, l);
			}
			function Sc(i, a, l) {
				var D = i.length;
				if (D < 2) return D ? ui(i[0]) : [];
				for (var b = -1, F = q(D); ++b < D;) for (var k = i[b], O = -1; ++O < D;) O != b && (F[b] = Js(F[b] || k, i[O], a, l));
				return ui(qt(F, 1), a, l);
			}
			function wp(i, a, l) {
				for (var D = -1, b = i.length, F = a.length, k = {}; ++D < b;) {
					var O = D < F ? a[D] : n;
					l(k, i[D], O);
				}
				return k;
			}
			function Cc(i) {
				return dt(i) ? i : [];
			}
			function xc(i) {
				return typeof i == "function" ? i : wn;
			}
			function ci(i, a) {
				return Fe(i) ? i : Pc(i, a) ? [i] : Vp(We(i));
			}
			var Ev = Te;
			function li(i, a, l) {
				var D = i.length;
				return l = l === n ? D : l, !a && l >= D ? i : jn(i, a, l);
			}
			var bp = u1 || function(i) {
				return Ht.clearTimeout(i);
			};
			function Ep(i, a) {
				if (a) return i.slice();
				var l = i.length, D = Hh ? Hh(l) : new i.constructor(l);
				return i.copy(D), D;
			}
			function Fc(i) {
				var a = new i.constructor(i.byteLength);
				return new ea(a).set(new ea(i)), a;
			}
			function vv(i, a) {
				var l = a ? Fc(i.buffer) : i.buffer;
				return new i.constructor(l, i.byteOffset, i.byteLength);
			}
			function Sv(i) {
				var a = new i.constructor(i.source, ih.exec(i));
				return a.lastIndex = i.lastIndex, a;
			}
			function Cv(i) {
				return Vs ? Xe(Vs.call(i)) : {};
			}
			function vp(i, a) {
				var l = a ? Fc(i.buffer) : i.buffer;
				return new i.constructor(l, i.byteOffset, i.length);
			}
			function Sp(i, a) {
				if (i !== a) {
					var l = i !== n, D = i === null, b = i === i, F = kn(i), k = a !== n, O = a === null, M = a === a, Z = kn(a);
					if (!O && !Z && !F && i > a || F && k && M && !O && !Z || D && k && M || !l && M || !b) return 1;
					if (!D && !F && !Z && i < a || Z && l && b && !D && !F || O && l && b || !k && b || !M) return -1;
				}
				return 0;
			}
			function xv(i, a, l) {
				for (var D = -1, b = i.criteria, F = a.criteria, k = b.length, O = l.length; ++D < k;) {
					var M = Sp(b[D], F[D]);
					if (M) {
						if (D >= O) return M;
						return M * (l[D] == "desc" ? -1 : 1);
					}
				}
				return i.index - a.index;
			}
			function Cp(i, a, l, D) {
				for (var b = -1, F = i.length, k = l.length, O = -1, M = a.length, Z = Tt(F - k, 0), J = q(M + Z), ee = !D; ++O < M;) J[O] = a[O];
				for (; ++b < k;) (ee || b < F) && (J[l[b]] = i[b]);
				for (; Z--;) J[O++] = i[b++];
				return J;
			}
			function xp(i, a, l, D) {
				for (var b = -1, F = i.length, k = -1, O = l.length, M = -1, Z = a.length, J = Tt(F - O, 0), ee = q(J + Z), oe = !D; ++b < J;) ee[b] = i[b];
				for (var ye = b; ++M < Z;) ee[ye + M] = a[M];
				for (; ++k < O;) (oe || b < F) && (ee[ye + l[k]] = i[b++]);
				return ee;
			}
			function mn(i, a) {
				var l = -1, D = i.length;
				for (a || (a = q(D)); ++l < D;) a[l] = i[l];
				return a;
			}
			function mr(i, a, l, D) {
				var b = !l;
				l || (l = {});
				for (var F = -1, k = a.length; ++F < k;) {
					var O = a[F], M = D ? D(l[O], i[O], O, l, i) : n;
					M === n && (M = i[O]), b ? Or(l, O, M) : Zs(l, O, M);
				}
				return l;
			}
			function Fv(i, a) {
				return mr(i, Tc(i), a);
			}
			function Av(i, a) {
				return mr(i, Mp(i), a);
			}
			function ga(i, a) {
				return function(l, D) {
					var b = Fe(l) ? RE : Z1, F = a ? a() : {};
					return b(l, i, we(D, 2), F);
				};
			}
			function as(i) {
				return Te(function(a, l) {
					var D = -1, b = l.length, F = b > 1 ? l[b - 1] : n, k = b > 2 ? l[2] : n;
					for (F = i.length > 3 && typeof F == "function" ? (b--, F) : n, k && an(l[0], l[1], k) && (F = b < 3 ? n : F, b = 1), a = Xe(a); ++D < b;) {
						var O = l[D];
						O && i(a, O, D, F);
					}
					return a;
				});
			}
			function Fp(i, a) {
				return function(l, D) {
					if (l == null) return l;
					if (!yn(l)) return i(l, D);
					for (var b = l.length, F = a ? b : -1, k = Xe(l); (a ? F-- : ++F < b) && D(k[F], F, k) !== !1;);
					return l;
				};
			}
			function Ap(i) {
				return function(a, l, D) {
					for (var b = -1, F = Xe(a), k = D(a), O = k.length; O--;) {
						var M = k[i ? O : ++b];
						if (l(F[M], M, F) === !1) break;
					}
					return a;
				};
			}
			function _v(i, a, l) {
				var D = a & T, b = eo(i);
				function F() {
					return (this && this !== Ht && this instanceof F ? b : i).apply(D ? l : this, arguments);
				}
				return F;
			}
			function _p(i) {
				return function(a) {
					a = We(a);
					var l = es(a) ? nr(a) : n, D = l ? l[0] : a.charAt(0), b = l ? li(l, 1).join("") : a.slice(1);
					return D[i]() + b;
				};
			}
			function us(i) {
				return function(a) {
					return Xu(Fg(xg(a).replace(DE, "")), i, "");
				};
			}
			function eo(i) {
				return function() {
					var a = arguments;
					switch (a.length) {
						case 0: return new i();
						case 1: return new i(a[0]);
						case 2: return new i(a[0], a[1]);
						case 3: return new i(a[0], a[1], a[2]);
						case 4: return new i(a[0], a[1], a[2], a[3]);
						case 5: return new i(a[0], a[1], a[2], a[3], a[4]);
						case 6: return new i(a[0], a[1], a[2], a[3], a[4], a[5]);
						case 7: return new i(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
					}
					var l = os(i.prototype), D = i.apply(l, a);
					return st(D) ? D : l;
				};
			}
			function Bv(i, a, l) {
				var D = eo(i);
				function b() {
					for (var F = arguments.length, k = q(F), O = F, M = cs(b); O--;) k[O] = arguments[O];
					var Z = F < 3 && k[0] !== M && k[F - 1] !== M ? [] : si(k, M);
					if (F -= Z.length, F < l) return Tp(i, a, ma, b.placeholder, n, k, Z, n, n, l - F);
					return _n(this && this !== Ht && this instanceof b ? D : i, this, k);
				}
				return b;
			}
			function Bp(i) {
				return function(a, l, D) {
					var b = Xe(a);
					if (!yn(a)) {
						var F = we(l, 3);
						a = Nt(a), l = function(O) {
							return F(b[O], O, b);
						};
					}
					var k = i(a, l, D);
					return k > -1 ? b[F ? a[k] : k] : n;
				};
			}
			function Ip(i) {
				return Mr(function(a) {
					var l = a.length, D = l, b = Hn.prototype.thru;
					for (i && a.reverse(); D--;) {
						var F = a[D];
						if (typeof F != "function") throw new zn(u);
						if (b && !k && ba(F) == "wrapper") var k = new Hn([], !0);
					}
					for (D = k ? D : l; ++D < l;) {
						F = a[D];
						var O = ba(F), M = O == "wrapper" ? kc(F) : n;
						M && Nc(M[0]) && M[1] == (De | H | te | rt) && !M[4].length && M[9] == 1 ? k = k[ba(M[0])].apply(k, M[3]) : k = F.length == 1 && Nc(F) ? k[O]() : k.thru(F);
					}
					return function() {
						var Z = arguments, J = Z[0];
						if (k && Z.length == 1 && Fe(J)) return k.plant(J).value();
						for (var ee = 0, oe = l ? a[ee].apply(this, Z) : J; ++ee < l;) oe = a[ee].call(this, oe);
						return oe;
					};
				});
			}
			function ma(i, a, l, D, b, F, k, O, M, Z) {
				var J = a & De, ee = a & T, oe = a & $, ye = a & (H | Q), Ee = a & Je, ke = oe ? n : eo(i);
				function ve() {
					for (var Pe = arguments.length, Me = q(Pe), Rn = Pe; Rn--;) Me[Rn] = arguments[Rn];
					if (ye) var un = cs(ve), Tn = zE(Me, un);
					if (D && (Me = Cp(Me, D, b, ye)), F && (Me = xp(Me, F, k, ye)), Pe -= Tn, ye && Pe < Z) {
						var ht = si(Me, un);
						return Tp(i, a, ma, ve.placeholder, l, Me, ht, O, M, Z - Pe);
					}
					var sr = ee ? l : this, Hr = oe ? sr[i] : i;
					return Pe = Me.length, O ? Me = Zv(Me, O) : Ee && Pe > 1 && Me.reverse(), J && M < Pe && (Me.length = M), this && this !== Ht && this instanceof ve && (Hr = ke || eo(Hr)), Hr.apply(sr, Me);
				}
				return ve;
			}
			function kp(i, a) {
				return function(l, D) {
					return rv(l, i, a(D), {});
				};
			}
			function ya(i, a) {
				return function(l, D) {
					var b;
					if (l === n && D === n) return a;
					if (l !== n && (b = l), D !== n) {
						if (b === n) return D;
						typeof l == "string" || typeof D == "string" ? (l = In(l), D = In(D)) : (l = mp(l), D = mp(D)), b = i(l, D);
					}
					return b;
				};
			}
			function Ac(i) {
				return Mr(function(a) {
					return a = it(a, Bn(we())), Te(function(l) {
						var D = this;
						return i(a, function(b) {
							return _n(b, D, l);
						});
					});
				});
			}
			function Da(i, a) {
				a = a === n ? " " : In(a);
				var l = a.length;
				if (l < 2) return l ? bc(a, i) : a;
				var D = bc(a, ia(i / ts(a)));
				return es(a) ? li(nr(D), 0, i).join("") : D.slice(0, i);
			}
			function Iv(i, a, l, D) {
				var b = a & T, F = eo(i);
				function k() {
					for (var O = -1, M = arguments.length, Z = -1, J = D.length, ee = q(J + M), oe = this && this !== Ht && this instanceof k ? F : i; ++Z < J;) ee[Z] = D[Z];
					for (; M--;) ee[Z++] = arguments[++O];
					return _n(oe, b ? l : this, ee);
				}
				return k;
			}
			function Rp(i) {
				return function(a, l, D) {
					return D && typeof D != "number" && an(a, l, D) && (l = D = n), a = zr(a), l === n ? (l = a, a = 0) : l = zr(l), D = D === n ? a < l ? 1 : -1 : zr(D), gv(a, l, D, i);
				};
			}
			function wa(i) {
				return function(a, l) {
					return typeof a == "string" && typeof l == "string" || (a = Wn(a), l = Wn(l)), i(a, l);
				};
			}
			function Tp(i, a, l, D, b, F, k, O, M, Z) {
				var J = a & H, ee = J ? k : n, oe = J ? n : k, ye = J ? F : n, Ee = J ? n : F;
				a |= J ? te : ge, a &= ~(J ? ge : te), a & V || (a &= -4);
				var ke = [
					i,
					a,
					b,
					ye,
					ee,
					Ee,
					oe,
					O,
					M,
					Z
				], ve = l.apply(n, ke);
				return Nc(i) && Gp(ve, ke), ve.placeholder = D, Wp(ve, i, a);
			}
			function _c(i) {
				var a = Rt[i];
				return function(l, D) {
					if (l = Wn(l), D = D == null ? 0 : Zt(Ie(D), 292), D && Wh(l)) {
						var b = (We(l) + "e").split("e");
						return b = (We(a(b[0] + "e" + (+b[1] + D))) + "e").split("e"), +(b[0] + "e" + (+b[1] - D));
					}
					return a(l);
				};
			}
			var kv = is && 1 / Vo(new is([, -0]))[1] == Qn ? function(i) {
				return new is(i);
			} : Jc;
			function Pp(i) {
				return function(a) {
					var l = Jt(a);
					return l == Ct ? ic(a) : l == It ? VE(a) : LE(a, i(a));
				};
			}
			function Ur(i, a, l, D, b, F, k, O) {
				var M = a & $;
				if (!M && typeof i != "function") throw new zn(u);
				var Z = D ? D.length : 0;
				if (Z || (a &= -97, D = b = n), k = k === n ? k : Tt(Ie(k), 0), O = O === n ? O : Ie(O), Z -= b ? b.length : 0, a & ge) {
					var J = D, ee = b;
					D = b = n;
				}
				var oe = M ? n : kc(i), ye = [
					i,
					a,
					l,
					D,
					b,
					J,
					ee,
					F,
					k,
					O
				];
				if (oe && Wv(ye, oe), i = ye[0], a = ye[1], l = ye[2], D = ye[3], b = ye[4], O = ye[9] = ye[9] === n ? M ? 0 : i.length : Tt(ye[9] - Z, 0), !O && a & (H | Q) && (a &= -25), !a || a == T) var Ee = _v(i, a, l);
				else a == H || a == Q ? Ee = Bv(i, a, O) : (a == te || a == (T | te)) && !b.length ? Ee = Iv(i, a, l, D) : Ee = ma.apply(n, ye);
				return Wp((oe ? pp : Gp)(Ee, ye), i, a);
			}
			function Np(i, a, l, D) {
				return i === n || ir(i, rs[l]) && !Ge.call(D, l) ? a : i;
			}
			function Op(i, a, l, D, b, F) {
				return st(i) && st(a) && (F.set(a, i), da(i, a, n, Op, F), F.delete(a)), i;
			}
			function Rv(i) {
				return ro(i) ? n : i;
			}
			function Up(i, a, l, D, b, F) {
				var k = l & A, O = i.length, M = a.length;
				if (O != M && !(k && M > O)) return !1;
				var Z = F.get(i), J = F.get(a);
				if (Z && J) return Z == a && J == i;
				var ee = -1, oe = !0, ye = l & B ? new Ii() : n;
				for (F.set(i, a), F.set(a, i); ++ee < O;) {
					var Ee = i[ee], ke = a[ee];
					if (D) var ve = k ? D(ke, Ee, ee, a, i, F) : D(Ee, ke, ee, i, a, F);
					if (ve !== n) {
						if (ve) continue;
						oe = !1;
						break;
					}
					if (ye) {
						if (!Yu(a, function(Pe, Me) {
							if (!qs(ye, Me) && (Ee === Pe || b(Ee, Pe, l, D, F))) return ye.push(Me);
						})) {
							oe = !1;
							break;
						}
					} else if (!(Ee === ke || b(Ee, ke, l, D, F))) {
						oe = !1;
						break;
					}
				}
				return F.delete(i), F.delete(a), oe;
			}
			function Tv(i, a, l, D, b, F, k) {
				switch (l) {
					case h:
						if (i.byteLength != a.byteLength || i.byteOffset != a.byteOffset) return !1;
						i = i.buffer, a = a.buffer;
					case g: return !(i.byteLength != a.byteLength || !F(new ea(i), new ea(a)));
					case Kt:
					case tr:
					case Tr: return ir(+i, +a);
					case Rr: return i.name == a.name && i.message == a.message;
					case gn:
					case kt: return i == a + "";
					case Ct: var O = ic;
					case It:
						var M = D & A;
						if (O || (O = Vo), i.size != a.size && !M) return !1;
						var Z = k.get(i);
						if (Z) return Z == a;
						D |= B, k.set(i, a);
						var J = Up(O(i), O(a), D, b, F, k);
						return k.delete(i), J;
					case pr: if (Vs) return Vs.call(i) == Vs.call(a);
				}
				return !1;
			}
			function Pv(i, a, l, D, b, F) {
				var k = l & A, O = Bc(i), M = O.length;
				if (M != Bc(a).length && !k) return !1;
				for (var ee = M; ee--;) {
					var oe = O[ee];
					if (!(k ? oe in a : Ge.call(a, oe))) return !1;
				}
				var ye = F.get(i), Ee = F.get(a);
				if (ye && Ee) return ye == a && Ee == i;
				var ke = !0;
				F.set(i, a), F.set(a, i);
				for (var ve = k; ++ee < M;) {
					oe = O[ee];
					var Pe = i[oe], Me = a[oe];
					if (D) var Rn = k ? D(Me, Pe, oe, a, i, F) : D(Pe, Me, oe, i, a, F);
					if (!(Rn === n ? Pe === Me || b(Pe, Me, l, D, F) : Rn)) {
						ke = !1;
						break;
					}
					ve || (ve = oe == "constructor");
				}
				if (ke && !ve) {
					var un = i.constructor, Tn = a.constructor;
					un != Tn && "constructor" in i && "constructor" in a && !(typeof un == "function" && un instanceof un && typeof Tn == "function" && Tn instanceof Tn) && (ke = !1);
				}
				return F.delete(i), F.delete(a), ke;
			}
			function Mr(i) {
				return Uc(qp(i, n, Yp), i + "");
			}
			function Bc(i) {
				return rp(i, Nt, Tc);
			}
			function Ic(i) {
				return rp(i, Dn, Mp);
			}
			var kc = oa ? function(i) {
				return oa.get(i);
			} : Jc;
			function ba(i) {
				for (var a = i.name + "", l = ss[a], D = Ge.call(ss, a) ? l.length : 0; D--;) {
					var b = l[D], F = b.func;
					if (F == null || F == i) return b.name;
				}
				return a;
			}
			function cs(i) {
				return (Ge.call(x, "placeholder") ? x : i).placeholder;
			}
			function we() {
				var i = x.iteratee || Vc;
				return i = i === Vc ? op : i, arguments.length ? i(arguments[0], arguments[1]) : i;
			}
			function Ea(i, a) {
				var l = i.__data__;
				return Hv(a) ? l[typeof a == "string" ? "string" : "hash"] : l.map;
			}
			function Rc(i) {
				for (var a = Nt(i), l = a.length; l--;) {
					var D = a[l], b = i[D];
					a[l] = [
						D,
						b,
						zp(b)
					];
				}
				return a;
			}
			function Ti(i, a) {
				var l = GE(i, a);
				return sp(l) ? l : n;
			}
			function Nv(i) {
				var a = Ge.call(i, _i), l = i[_i];
				try {
					i[_i] = n;
					var D = !0;
				} catch {}
				var b = Yo.call(i);
				return D && (a ? i[_i] = l : delete i[_i]), b;
			}
			var Tc = oc ? function(i) {
				return i == null ? [] : (i = Xe(i), ri(oc(i), function(a) {
					return jh.call(i, a);
				}));
			} : Xc, Mp = oc ? function(i) {
				for (var a = []; i;) ii(a, Tc(i)), i = ta(i);
				return a;
			} : Xc, Jt = on;
			(ac && Jt(new ac(/* @__PURE__ */ new ArrayBuffer(1))) != h || Gs && Jt(new Gs()) != Ct || uc && Jt(uc.resolve()) != Fi || is && Jt(new is()) != It || Ws && Jt(new Ws()) != ut) && (Jt = function(i) {
				var a = on(i), l = a == rn ? i.constructor : n, D = l ? Pi(l) : "";
				if (D) switch (D) {
					case y1: return h;
					case D1: return Ct;
					case w1: return Fi;
					case b1: return It;
					case E1: return ut;
				}
				return a;
			});
			function Ov(i, a, l) {
				for (var D = -1, b = l.length; ++D < b;) {
					var F = l[D], k = F.size;
					switch (F.type) {
						case "drop":
							i += k;
							break;
						case "dropRight":
							a -= k;
							break;
						case "take":
							a = Zt(a, i + k);
							break;
						case "takeRight":
							i = Tt(i, a - k);
							break;
					}
				}
				return {
					start: i,
					end: a
				};
			}
			function Uv(i) {
				var a = i.match(qb);
				return a ? a[1].split(jb) : [];
			}
			function $p(i, a, l) {
				a = ci(a, i);
				for (var D = -1, b = a.length, F = !1; ++D < b;) {
					var k = yr(a[D]);
					if (!(F = i != null && l(i, k))) break;
					i = i[k];
				}
				return F || ++D != b ? F : (b = i == null ? 0 : i.length, !!b && _a(b) && $r(k, b) && (Fe(i) || Ni(i)));
			}
			function Mv(i) {
				var a = i.length, l = new i.constructor(a);
				return a && typeof i[0] == "string" && Ge.call(i, "index") && (l.index = i.index, l.input = i.input), l;
			}
			function Lp(i) {
				return typeof i.constructor == "function" && !to(i) ? os(ta(i)) : {};
			}
			function $v(i, a, l) {
				var D = i.constructor;
				switch (a) {
					case g: return Fc(i);
					case Kt:
					case tr: return new D(+i);
					case h: return vv(i, l);
					case p:
					case v:
					case C:
					case I:
					case R:
					case j:
					case ae:
					case de:
					case ce: return vp(i, l);
					case Ct: return new D();
					case Tr:
					case kt: return new D(i);
					case gn: return Sv(i);
					case It: return new D();
					case pr: return Cv(i);
				}
			}
			function Lv(i, a) {
				var l = a.length;
				if (!l) return i;
				var D = l - 1;
				return a[D] = (l > 1 ? "& " : "") + a[D], a = a.join(l > 2 ? ", " : " "), i.replace(Hb, `{
/* [wrapped with ` + a + `] */
`);
			}
			function zv(i) {
				return Fe(i) || Ni(i) || !!(Gh && i && i[Gh]);
			}
			function $r(i, a) {
				var l = typeof i;
				return a = a ?? Fn, !!a && (l == "number" || l != "symbol" && Qb.test(i)) && i > -1 && i % 1 == 0 && i < a;
			}
			function an(i, a, l) {
				if (!st(l)) return !1;
				var D = typeof a;
				return (D == "number" ? yn(l) && $r(a, l.length) : D == "string" && a in l) ? ir(l[a], i) : !1;
			}
			function Pc(i, a) {
				if (Fe(i)) return !1;
				var l = typeof i;
				return l == "number" || l == "symbol" || l == "boolean" || i == null || kn(i) ? !0 : Mb.test(i) || !Ub.test(i) || a != null && i in Xe(a);
			}
			function Hv(i) {
				var a = typeof i;
				return a == "string" || a == "number" || a == "symbol" || a == "boolean" ? i !== "__proto__" : i === null;
			}
			function Nc(i) {
				var a = ba(i), l = x[a];
				if (typeof l != "function" || !(a in Oe.prototype)) return !1;
				if (i === l) return !0;
				var D = kc(l);
				return !!D && i === D[0];
			}
			function qv(i) {
				return !!zh && zh in i;
			}
			var jv = Jo ? Lr : Yc;
			function to(i) {
				var a = i && i.constructor;
				return i === (typeof a == "function" && a.prototype || rs);
			}
			function zp(i) {
				return i === i && !st(i);
			}
			function Hp(i, a) {
				return function(l) {
					return l == null ? !1 : l[i] === a && (a !== n || i in Xe(l));
				};
			}
			function Gv(i) {
				var a = Fa(i, function(D) {
					return l.size === f && l.clear(), D;
				}), l = a.cache;
				return a;
			}
			function Wv(i, a) {
				var l = i[1], D = a[1], b = l | D, F = b < (T | $ | De), k = D == De && l == H || D == De && l == rt && i[7].length <= a[8] || D == (De | rt) && a[7].length <= a[8] && l == H;
				if (!(F || k)) return i;
				D & T && (i[2] = a[2], b |= l & T ? 0 : V);
				var O = a[3];
				if (O) {
					var M = i[3];
					i[3] = M ? Cp(M, O, a[4]) : O, i[4] = M ? si(i[3], m) : a[4];
				}
				return O = a[5], O && (M = i[5], i[5] = M ? xp(M, O, a[6]) : O, i[6] = M ? si(i[5], m) : a[6]), O = a[7], O && (i[7] = O), D & De && (i[8] = i[8] == null ? a[8] : Zt(i[8], a[8])), i[9] ??= a[9], i[0] = a[0], i[1] = b, i;
			}
			function Kv(i) {
				var a = [];
				if (i != null) for (var l in Xe(i)) a.push(l);
				return a;
			}
			function Vv(i) {
				return Yo.call(i);
			}
			function qp(i, a, l) {
				return a = Tt(a === n ? i.length - 1 : a, 0), function() {
					for (var D = arguments, b = -1, F = Tt(D.length - a, 0), k = q(F); ++b < F;) k[b] = D[a + b];
					b = -1;
					for (var O = q(a + 1); ++b < a;) O[b] = D[b];
					return O[a] = l(k), _n(i, this, O);
				};
			}
			function jp(i, a) {
				return a.length < 2 ? i : Ri(i, jn(a, 0, -1));
			}
			function Zv(i, a) {
				for (var l = i.length, D = Zt(a.length, l), b = mn(i); D--;) {
					var F = a[D];
					i[D] = $r(F, l) ? b[F] : n;
				}
				return i;
			}
			function Oc(i, a) {
				if (!(a === "constructor" && typeof i[a] == "function") && a != "__proto__") return i[a];
			}
			var Gp = Kp(pp), no = l1 || function(i, a) {
				return Ht.setTimeout(i, a);
			}, Uc = Kp(Dv);
			function Wp(i, a, l) {
				var D = a + "";
				return Uc(i, Lv(D, Jv(Uv(D), l)));
			}
			function Kp(i) {
				var a = 0, l = 0;
				return function() {
					var D = p1(), b = $s - (D - l);
					if (l = D, b > 0) {
						if (++a >= ei) return arguments[0];
					} else a = 0;
					return i.apply(n, arguments);
				};
			}
			function va(i, a) {
				var l = -1, D = i.length, b = D - 1;
				for (a = a === n ? D : a; ++l < a;) {
					var F = wc(l, b), k = i[F];
					i[F] = i[l], i[l] = k;
				}
				return i.length = a, i;
			}
			var Vp = Gv(function(i) {
				var a = [];
				return i.charCodeAt(0) === 46 && a.push(""), i.replace($b, function(l, D, b, F) {
					a.push(b ? F.replace(Kb, "$1") : D || l);
				}), a;
			});
			function yr(i) {
				if (typeof i == "string" || kn(i)) return i;
				var a = i + "";
				return a == "0" && 1 / i == -Qn ? "-0" : a;
			}
			function Pi(i) {
				if (i != null) {
					try {
						return Xo.call(i);
					} catch {}
					try {
						return i + "";
					} catch {}
				}
				return "";
			}
			function Jv(i, a) {
				return Ln(fr, function(l) {
					var D = "_." + l[0];
					a & l[1] && !Wo(i, D) && i.push(D);
				}), i.sort();
			}
			function Zp(i) {
				if (i instanceof Oe) return i.clone();
				var a = new Hn(i.__wrapped__, i.__chain__);
				return a.__actions__ = mn(i.__actions__), a.__index__ = i.__index__, a.__values__ = i.__values__, a;
			}
			function Xv(i, a, l) {
				(l ? an(i, a, l) : a === n) ? a = 1 : a = Tt(Ie(a), 0);
				var D = i == null ? 0 : i.length;
				if (!D || a < 1) return [];
				for (var b = 0, F = 0, k = q(ia(D / a)); b < D;) k[F++] = jn(i, b, b += a);
				return k;
			}
			function Yv(i) {
				for (var a = -1, l = i == null ? 0 : i.length, D = 0, b = []; ++a < l;) {
					var F = i[a];
					F && (b[D++] = F);
				}
				return b;
			}
			function Qv() {
				var i = arguments.length;
				if (!i) return [];
				for (var a = q(i - 1), l = arguments[0], D = i; D--;) a[D - 1] = arguments[D];
				return ii(Fe(l) ? mn(l) : [l], qt(a, 1));
			}
			var eS = Te(function(i, a) {
				return dt(i) ? Js(i, qt(a, 1, dt, !0)) : [];
			}), tS = Te(function(i, a) {
				var l = Gn(a);
				return dt(l) && (l = n), dt(i) ? Js(i, qt(a, 1, dt, !0), we(l, 2)) : [];
			}), nS = Te(function(i, a) {
				var l = Gn(a);
				return dt(l) && (l = n), dt(i) ? Js(i, qt(a, 1, dt, !0), n, l) : [];
			});
			function rS(i, a, l) {
				var D = i == null ? 0 : i.length;
				return D ? (a = l || a === n ? 1 : Ie(a), jn(i, a < 0 ? 0 : a, D)) : [];
			}
			function iS(i, a, l) {
				var D = i == null ? 0 : i.length;
				return D ? (a = l || a === n ? 1 : Ie(a), a = D - a, jn(i, 0, a < 0 ? 0 : a)) : [];
			}
			function sS(i, a) {
				return i && i.length ? pa(i, we(a, 3), !0, !0) : [];
			}
			function oS(i, a) {
				return i && i.length ? pa(i, we(a, 3), !0) : [];
			}
			function aS(i, a, l, D) {
				var b = i == null ? 0 : i.length;
				return b ? (l && typeof l != "number" && an(i, a, l) && (l = 0, D = b), Q1(i, a, l, D)) : [];
			}
			function Jp(i, a, l) {
				var D = i == null ? 0 : i.length;
				if (!D) return -1;
				var b = l == null ? 0 : Ie(l);
				return b < 0 && (b = Tt(D + b, 0)), Ko(i, we(a, 3), b);
			}
			function Xp(i, a, l) {
				var D = i == null ? 0 : i.length;
				if (!D) return -1;
				var b = D - 1;
				return l !== n && (b = Ie(l), b = l < 0 ? Tt(D + b, 0) : Zt(b, D - 1)), Ko(i, we(a, 3), b, !0);
			}
			function Yp(i) {
				return (i == null ? 0 : i.length) ? qt(i, 1) : [];
			}
			function uS(i) {
				return (i == null ? 0 : i.length) ? qt(i, Qn) : [];
			}
			function cS(i, a) {
				return (i == null ? 0 : i.length) ? (a = a === n ? 1 : Ie(a), qt(i, a)) : [];
			}
			function lS(i) {
				for (var a = -1, l = i == null ? 0 : i.length, D = {}; ++a < l;) {
					var b = i[a];
					D[b[0]] = b[1];
				}
				return D;
			}
			function Qp(i) {
				return i && i.length ? i[0] : n;
			}
			function fS(i, a, l) {
				var D = i == null ? 0 : i.length;
				if (!D) return -1;
				var b = l == null ? 0 : Ie(l);
				return b < 0 && (b = Tt(D + b, 0)), Qi(i, a, b);
			}
			function dS(i) {
				return (i == null ? 0 : i.length) ? jn(i, 0, -1) : [];
			}
			var hS = Te(function(i) {
				var a = it(i, Cc);
				return a.length && a[0] === i[0] ? pc(a) : [];
			}), pS = Te(function(i) {
				var a = Gn(i), l = it(i, Cc);
				return a === Gn(l) ? a = n : l.pop(), l.length && l[0] === i[0] ? pc(l, we(a, 2)) : [];
			}), gS = Te(function(i) {
				var a = Gn(i), l = it(i, Cc);
				return a = typeof a == "function" ? a : n, a && l.pop(), l.length && l[0] === i[0] ? pc(l, n, a) : [];
			});
			function mS(i, a) {
				return i == null ? "" : d1.call(i, a);
			}
			function Gn(i) {
				var a = i == null ? 0 : i.length;
				return a ? i[a - 1] : n;
			}
			function yS(i, a, l) {
				var D = i == null ? 0 : i.length;
				if (!D) return -1;
				var b = D;
				return l !== n && (b = Ie(l), b = b < 0 ? Tt(D + b, 0) : Zt(b, D - 1)), a === a ? JE(i, a, b) : Ko(i, Th, b, !0);
			}
			function DS(i, a) {
				return i && i.length ? lp(i, Ie(a)) : n;
			}
			var wS = Te(eg);
			function eg(i, a) {
				return i && i.length && a && a.length ? Dc(i, a) : i;
			}
			function bS(i, a, l) {
				return i && i.length && a && a.length ? Dc(i, a, we(l, 2)) : i;
			}
			function ES(i, a, l) {
				return i && i.length && a && a.length ? Dc(i, a, n, l) : i;
			}
			var vS = Mr(function(i, a) {
				var l = i == null ? 0 : i.length, D = lc(i, a);
				return hp(i, it(a, function(b) {
					return $r(b, l) ? +b : b;
				}).sort(Sp)), D;
			});
			function SS(i, a) {
				var l = [];
				if (!(i && i.length)) return l;
				var D = -1, b = [], F = i.length;
				for (a = we(a, 3); ++D < F;) {
					var k = i[D];
					a(k, D, i) && (l.push(k), b.push(D));
				}
				return hp(i, b), l;
			}
			function Mc(i) {
				return i == null ? i : m1.call(i);
			}
			function CS(i, a, l) {
				var D = i == null ? 0 : i.length;
				return D ? (l && typeof l != "number" && an(i, a, l) ? (a = 0, l = D) : (a = a == null ? 0 : Ie(a), l = l === n ? D : Ie(l)), jn(i, a, l)) : [];
			}
			function xS(i, a) {
				return ha(i, a);
			}
			function FS(i, a, l) {
				return Ec(i, a, we(l, 2));
			}
			function AS(i, a) {
				var l = i == null ? 0 : i.length;
				if (l) {
					var D = ha(i, a);
					if (D < l && ir(i[D], a)) return D;
				}
				return -1;
			}
			function _S(i, a) {
				return ha(i, a, !0);
			}
			function BS(i, a, l) {
				return Ec(i, a, we(l, 2), !0);
			}
			function IS(i, a) {
				if (i == null ? 0 : i.length) {
					var D = ha(i, a, !0) - 1;
					if (ir(i[D], a)) return D;
				}
				return -1;
			}
			function kS(i) {
				return i && i.length ? gp(i) : [];
			}
			function RS(i, a) {
				return i && i.length ? gp(i, we(a, 2)) : [];
			}
			function TS(i) {
				var a = i == null ? 0 : i.length;
				return a ? jn(i, 1, a) : [];
			}
			function PS(i, a, l) {
				return i && i.length ? (a = l || a === n ? 1 : Ie(a), jn(i, 0, a < 0 ? 0 : a)) : [];
			}
			function NS(i, a, l) {
				var D = i == null ? 0 : i.length;
				return D ? (a = l || a === n ? 1 : Ie(a), a = D - a, jn(i, a < 0 ? 0 : a, D)) : [];
			}
			function OS(i, a) {
				return i && i.length ? pa(i, we(a, 3), !1, !0) : [];
			}
			function US(i, a) {
				return i && i.length ? pa(i, we(a, 3)) : [];
			}
			var MS = Te(function(i) {
				return ui(qt(i, 1, dt, !0));
			}), $S = Te(function(i) {
				var a = Gn(i);
				return dt(a) && (a = n), ui(qt(i, 1, dt, !0), we(a, 2));
			}), LS = Te(function(i) {
				var a = Gn(i);
				return a = typeof a == "function" ? a : n, ui(qt(i, 1, dt, !0), n, a);
			});
			function zS(i) {
				return i && i.length ? ui(i) : [];
			}
			function HS(i, a) {
				return i && i.length ? ui(i, we(a, 2)) : [];
			}
			function qS(i, a) {
				return a = typeof a == "function" ? a : n, i && i.length ? ui(i, n, a) : [];
			}
			function $c(i) {
				if (!(i && i.length)) return [];
				var a = 0;
				return i = ri(i, function(l) {
					if (dt(l)) return a = Tt(l.length, a), !0;
				}), nc(a, function(l) {
					return it(i, Qu(l));
				});
			}
			function tg(i, a) {
				if (!(i && i.length)) return [];
				var l = $c(i);
				return a == null ? l : it(l, function(D) {
					return _n(a, n, D);
				});
			}
			var jS = Te(function(i, a) {
				return dt(i) ? Js(i, a) : [];
			}), GS = Te(function(i) {
				return Sc(ri(i, dt));
			}), WS = Te(function(i) {
				var a = Gn(i);
				return dt(a) && (a = n), Sc(ri(i, dt), we(a, 2));
			}), KS = Te(function(i) {
				var a = Gn(i);
				return a = typeof a == "function" ? a : n, Sc(ri(i, dt), n, a);
			}), VS = Te($c);
			function ZS(i, a) {
				return wp(i || [], a || [], Zs);
			}
			function JS(i, a) {
				return wp(i || [], a || [], Qs);
			}
			var XS = Te(function(i) {
				var a = i.length, l = a > 1 ? i[a - 1] : n;
				return l = typeof l == "function" ? (i.pop(), l) : n, tg(i, l);
			});
			function ng(i) {
				var a = x(i);
				return a.__chain__ = !0, a;
			}
			function YS(i, a) {
				return a(i), i;
			}
			function Sa(i, a) {
				return a(i);
			}
			var QS = Mr(function(i) {
				var a = i.length, l = a ? i[0] : 0, D = this.__wrapped__, b = function(F) {
					return lc(F, i);
				};
				return a > 1 || this.__actions__.length || !(D instanceof Oe) || !$r(l) ? this.thru(b) : (D = D.slice(l, +l + (a ? 1 : 0)), D.__actions__.push({
					func: Sa,
					args: [b],
					thisArg: n
				}), new Hn(D, this.__chain__).thru(function(F) {
					return a && !F.length && F.push(n), F;
				}));
			});
			function eC() {
				return ng(this);
			}
			function tC() {
				return new Hn(this.value(), this.__chain__);
			}
			function nC() {
				this.__values__ === n && (this.__values__ = mg(this.value()));
				var i = this.__index__ >= this.__values__.length;
				return {
					done: i,
					value: i ? n : this.__values__[this.__index__++]
				};
			}
			function rC() {
				return this;
			}
			function iC(i) {
				for (var a, l = this; l instanceof ua;) {
					var D = Zp(l);
					D.__index__ = 0, D.__values__ = n, a ? b.__wrapped__ = D : a = D;
					var b = D;
					l = l.__wrapped__;
				}
				return b.__wrapped__ = i, a;
			}
			function sC() {
				var i = this.__wrapped__;
				if (i instanceof Oe) {
					var a = i;
					return this.__actions__.length && (a = new Oe(this)), a = a.reverse(), a.__actions__.push({
						func: Sa,
						args: [Mc],
						thisArg: n
					}), new Hn(a, this.__chain__);
				}
				return this.thru(Mc);
			}
			function oC() {
				return Dp(this.__wrapped__, this.__actions__);
			}
			var aC = ga(function(i, a, l) {
				Ge.call(i, l) ? ++i[l] : Or(i, l, 1);
			});
			function uC(i, a, l) {
				var D = Fe(i) ? kh : Y1;
				return l && an(i, a, l) && (a = n), D(i, we(a, 3));
			}
			function cC(i, a) {
				return (Fe(i) ? ri : tp)(i, we(a, 3));
			}
			var lC = Bp(Jp), fC = Bp(Xp);
			function dC(i, a) {
				return qt(Ca(i, a), 1);
			}
			function hC(i, a) {
				return qt(Ca(i, a), Qn);
			}
			function pC(i, a, l) {
				return l = l === n ? 1 : Ie(l), qt(Ca(i, a), l);
			}
			function rg(i, a) {
				return (Fe(i) ? Ln : ai)(i, we(a, 3));
			}
			function ig(i, a) {
				return (Fe(i) ? TE : ep)(i, we(a, 3));
			}
			var gC = ga(function(i, a, l) {
				Ge.call(i, l) ? i[l].push(a) : Or(i, l, [a]);
			});
			function mC(i, a, l, D) {
				i = yn(i) ? i : fs(i), l = l && !D ? Ie(l) : 0;
				var b = i.length;
				return l < 0 && (l = Tt(b + l, 0)), Ba(i) ? l <= b && i.indexOf(a, l) > -1 : !!b && Qi(i, a, l) > -1;
			}
			var yC = Te(function(i, a, l) {
				var D = -1, b = typeof a == "function", F = yn(i) ? q(i.length) : [];
				return ai(i, function(k) {
					F[++D] = b ? _n(a, k, l) : Xs(k, a, l);
				}), F;
			}), DC = ga(function(i, a, l) {
				Or(i, l, a);
			});
			function Ca(i, a) {
				return (Fe(i) ? it : ap)(i, we(a, 3));
			}
			function wC(i, a, l, D) {
				return i == null ? [] : (Fe(a) || (a = a == null ? [] : [a]), l = D ? n : l, Fe(l) || (l = l == null ? [] : [l]), fp(i, a, l));
			}
			var bC = ga(function(i, a, l) {
				i[l ? 0 : 1].push(a);
			}, function() {
				return [[], []];
			});
			function EC(i, a, l) {
				var D = Fe(i) ? Xu : Nh, b = arguments.length < 3;
				return D(i, we(a, 4), l, b, ai);
			}
			function vC(i, a, l) {
				var D = Fe(i) ? PE : Nh, b = arguments.length < 3;
				return D(i, we(a, 4), l, b, ep);
			}
			function SC(i, a) {
				return (Fe(i) ? ri : tp)(i, Aa(we(a, 3)));
			}
			function CC(i) {
				return (Fe(i) ? Jh : mv)(i);
			}
			function xC(i, a, l) {
				(l ? an(i, a, l) : a === n) ? a = 1 : a = Ie(a);
				return (Fe(i) ? K1 : yv)(i, a);
			}
			function FC(i) {
				return (Fe(i) ? V1 : wv)(i);
			}
			function AC(i) {
				if (i == null) return 0;
				if (yn(i)) return Ba(i) ? ts(i) : i.length;
				var a = Jt(i);
				return a == Ct || a == It ? i.size : mc(i).length;
			}
			function _C(i, a, l) {
				var D = Fe(i) ? Yu : bv;
				return l && an(i, a, l) && (a = n), D(i, we(a, 3));
			}
			var BC = Te(function(i, a) {
				if (i == null) return [];
				var l = a.length;
				return l > 1 && an(i, a[0], a[1]) ? a = [] : l > 2 && an(a[0], a[1], a[2]) && (a = [a[0]]), fp(i, qt(a, 1), []);
			}), xa = c1 || function() {
				return Ht.Date.now();
			};
			function IC(i, a) {
				if (typeof a != "function") throw new zn(u);
				return i = Ie(i), function() {
					if (--i < 1) return a.apply(this, arguments);
				};
			}
			function sg(i, a, l) {
				return a = l ? n : a, a = i && a == null ? i.length : a, Ur(i, De, n, n, n, n, a);
			}
			function og(i, a) {
				var l;
				if (typeof a != "function") throw new zn(u);
				return i = Ie(i), function() {
					return --i > 0 && (l = a.apply(this, arguments)), i <= 1 && (a = n), l;
				};
			}
			var Lc = Te(function(i, a, l) {
				var D = T;
				if (l.length) {
					var b = si(l, cs(Lc));
					D |= te;
				}
				return Ur(i, D, a, l, b);
			}), ag = Te(function(i, a, l) {
				var D = T | $;
				if (l.length) {
					var b = si(l, cs(ag));
					D |= te;
				}
				return Ur(a, D, i, l, b);
			});
			function ug(i, a, l) {
				a = l ? n : a;
				var D = Ur(i, H, n, n, n, n, n, a);
				return D.placeholder = ug.placeholder, D;
			}
			function cg(i, a, l) {
				a = l ? n : a;
				var D = Ur(i, Q, n, n, n, n, n, a);
				return D.placeholder = cg.placeholder, D;
			}
			function lg(i, a, l) {
				var D, b, F, k, O, M, Z = 0, J = !1, ee = !1, oe = !0;
				if (typeof i != "function") throw new zn(u);
				a = Wn(a) || 0, st(l) && (J = !!l.leading, ee = "maxWait" in l, F = ee ? Tt(Wn(l.maxWait) || 0, a) : F, oe = "trailing" in l ? !!l.trailing : oe);
				function ye(ht) {
					var sr = D, Hr = b;
					return D = b = n, Z = ht, k = i.apply(Hr, sr), k;
				}
				function Ee(ht) {
					return Z = ht, O = no(Pe, a), J ? ye(ht) : k;
				}
				function ke(ht) {
					var sr = ht - M, Hr = ht - Z, Bg = a - sr;
					return ee ? Zt(Bg, F - Hr) : Bg;
				}
				function ve(ht) {
					var sr = ht - M, Hr = ht - Z;
					return M === n || sr >= a || sr < 0 || ee && Hr >= F;
				}
				function Pe() {
					var ht = xa();
					if (ve(ht)) return Me(ht);
					O = no(Pe, ke(ht));
				}
				function Me(ht) {
					return O = n, oe && D ? ye(ht) : (D = b = n, k);
				}
				function Rn() {
					O !== n && bp(O), Z = 0, D = M = b = O = n;
				}
				function un() {
					return O === n ? k : Me(xa());
				}
				function Tn() {
					var ht = xa(), sr = ve(ht);
					if (D = arguments, b = this, M = ht, sr) {
						if (O === n) return Ee(M);
						if (ee) return bp(O), O = no(Pe, a), ye(M);
					}
					return O === n && (O = no(Pe, a)), k;
				}
				return Tn.cancel = Rn, Tn.flush = un, Tn;
			}
			var kC = Te(function(i, a) {
				return Qh(i, 1, a);
			}), RC = Te(function(i, a, l) {
				return Qh(i, Wn(a) || 0, l);
			});
			function TC(i) {
				return Ur(i, Je);
			}
			function Fa(i, a) {
				if (typeof i != "function" || a != null && typeof a != "function") throw new zn(u);
				var l = function() {
					var D = arguments, b = a ? a.apply(this, D) : D[0], F = l.cache;
					if (F.has(b)) return F.get(b);
					var k = i.apply(this, D);
					return l.cache = F.set(b, k) || F, k;
				};
				return l.cache = new (Fa.Cache || Nr)(), l;
			}
			Fa.Cache = Nr;
			function Aa(i) {
				if (typeof i != "function") throw new zn(u);
				return function() {
					var a = arguments;
					switch (a.length) {
						case 0: return !i.call(this);
						case 1: return !i.call(this, a[0]);
						case 2: return !i.call(this, a[0], a[1]);
						case 3: return !i.call(this, a[0], a[1], a[2]);
					}
					return !i.apply(this, a);
				};
			}
			function PC(i) {
				return og(2, i);
			}
			var NC = Ev(function(i, a) {
				a = a.length == 1 && Fe(a[0]) ? it(a[0], Bn(we())) : it(qt(a, 1), Bn(we()));
				var l = a.length;
				return Te(function(D) {
					for (var b = -1, F = Zt(D.length, l); ++b < F;) D[b] = a[b].call(this, D[b]);
					return _n(i, this, D);
				});
			}), zc = Te(function(i, a) {
				return Ur(i, te, n, a, si(a, cs(zc)));
			}), fg = Te(function(i, a) {
				return Ur(i, ge, n, a, si(a, cs(fg)));
			}), OC = Mr(function(i, a) {
				return Ur(i, rt, n, n, n, a);
			});
			function UC(i, a) {
				if (typeof i != "function") throw new zn(u);
				return a = a === n ? a : Ie(a), Te(i, a);
			}
			function MC(i, a) {
				if (typeof i != "function") throw new zn(u);
				return a = a == null ? 0 : Tt(Ie(a), 0), Te(function(l) {
					var D = l[a], b = li(l, 0, a);
					return D && ii(b, D), _n(i, this, b);
				});
			}
			function $C(i, a, l) {
				var D = !0, b = !0;
				if (typeof i != "function") throw new zn(u);
				return st(l) && (D = "leading" in l ? !!l.leading : D, b = "trailing" in l ? !!l.trailing : b), lg(i, a, {
					leading: D,
					maxWait: a,
					trailing: b
				});
			}
			function LC(i) {
				return sg(i, 1);
			}
			function zC(i, a) {
				return zc(xc(a), i);
			}
			function HC() {
				if (!arguments.length) return [];
				var i = arguments[0];
				return Fe(i) ? i : [i];
			}
			function qC(i) {
				return qn(i, E);
			}
			function jC(i, a) {
				return a = typeof a == "function" ? a : n, qn(i, E, a);
			}
			function GC(i) {
				return qn(i, y | E);
			}
			function WC(i, a) {
				return a = typeof a == "function" ? a : n, qn(i, y | E, a);
			}
			function KC(i, a) {
				return a == null || Yh(i, a, Nt(a));
			}
			function ir(i, a) {
				return i === a || i !== i && a !== a;
			}
			var VC = wa(hc), ZC = wa(function(i, a) {
				return i >= a;
			}), Ni = ip(/* @__PURE__ */ function() {
				return arguments;
			}()) ? ip : function(i) {
				return ct(i) && Ge.call(i, "callee") && !jh.call(i, "callee");
			}, Fe = q.isArray, JC = xh ? Bn(xh) : iv;
			function yn(i) {
				return i != null && _a(i.length) && !Lr(i);
			}
			function dt(i) {
				return ct(i) && yn(i);
			}
			function XC(i) {
				return i === !0 || i === !1 || ct(i) && on(i) == Kt;
			}
			var fi = f1 || Yc, YC = Fh ? Bn(Fh) : sv;
			function QC(i) {
				return ct(i) && i.nodeType === 1 && !ro(i);
			}
			function ex(i) {
				if (i == null) return !0;
				if (yn(i) && (Fe(i) || typeof i == "string" || typeof i.splice == "function" || fi(i) || ls(i) || Ni(i))) return !i.length;
				var a = Jt(i);
				if (a == Ct || a == It) return !i.size;
				if (to(i)) return !mc(i).length;
				for (var l in i) if (Ge.call(i, l)) return !1;
				return !0;
			}
			function tx(i, a) {
				return Ys(i, a);
			}
			function nx(i, a, l) {
				l = typeof l == "function" ? l : n;
				var D = l ? l(i, a) : n;
				return D === n ? Ys(i, a, n, l) : !!D;
			}
			function Hc(i) {
				if (!ct(i)) return !1;
				var a = on(i);
				return a == Rr || a == kr || typeof i.message == "string" && typeof i.name == "string" && !ro(i);
			}
			function rx(i) {
				return typeof i == "number" && Wh(i);
			}
			function Lr(i) {
				if (!st(i)) return !1;
				var a = on(i);
				return a == hr || a == An || a == ni || a == Hs;
			}
			function dg(i) {
				return typeof i == "number" && i == Ie(i);
			}
			function _a(i) {
				return typeof i == "number" && i > -1 && i % 1 == 0 && i <= Fn;
			}
			function st(i) {
				var a = typeof i;
				return i != null && (a == "object" || a == "function");
			}
			function ct(i) {
				return i != null && typeof i == "object";
			}
			var hg = Ah ? Bn(Ah) : av;
			function ix(i, a) {
				return i === a || gc(i, a, Rc(a));
			}
			function sx(i, a, l) {
				return l = typeof l == "function" ? l : n, gc(i, a, Rc(a), l);
			}
			function ox(i) {
				return pg(i) && i != +i;
			}
			function ax(i) {
				if (jv(i)) throw new Ce(o);
				return sp(i);
			}
			function ux(i) {
				return i === null;
			}
			function cx(i) {
				return i == null;
			}
			function pg(i) {
				return typeof i == "number" || ct(i) && on(i) == Tr;
			}
			function ro(i) {
				if (!ct(i) || on(i) != rn) return !1;
				var a = ta(i);
				if (a === null) return !0;
				var l = Ge.call(a, "constructor") && a.constructor;
				return typeof l == "function" && l instanceof l && Xo.call(l) == s1;
			}
			var qc = _h ? Bn(_h) : uv;
			function lx(i) {
				return dg(i) && i >= -Fn && i <= Fn;
			}
			var gg = Bh ? Bn(Bh) : cv;
			function Ba(i) {
				return typeof i == "string" || !Fe(i) && ct(i) && on(i) == kt;
			}
			function kn(i) {
				return typeof i == "symbol" || ct(i) && on(i) == pr;
			}
			var ls = Ih ? Bn(Ih) : lv;
			function fx(i) {
				return i === n;
			}
			function dx(i) {
				return ct(i) && Jt(i) == ut;
			}
			function hx(i) {
				return ct(i) && on(i) == S;
			}
			var px = wa(yc), gx = wa(function(i, a) {
				return i <= a;
			});
			function mg(i) {
				if (!i) return [];
				if (yn(i)) return Ba(i) ? nr(i) : mn(i);
				if (js && i[js]) return KE(i[js]());
				var a = Jt(i);
				return (a == Ct ? ic : a == It ? Vo : fs)(i);
			}
			function zr(i) {
				if (!i) return i === 0 ? i : 0;
				if (i = Wn(i), i === Qn || i === -Qn) return (i < 0 ? -1 : 1) * er;
				return i === i ? i : 0;
			}
			function Ie(i) {
				var a = zr(i), l = a % 1;
				return a === a ? l ? a - l : a : 0;
			}
			function yg(i) {
				return i ? ki(Ie(i), 0, He) : 0;
			}
			function Wn(i) {
				if (typeof i == "number") return i;
				if (kn(i)) return hn;
				if (st(i)) {
					var a = typeof i.valueOf == "function" ? i.valueOf() : i;
					i = st(a) ? a + "" : a;
				}
				if (typeof i != "string") return i === 0 ? i : +i;
				i = Oh(i);
				var l = Jb.test(i);
				return l || Yb.test(i) ? IE(i.slice(2), l ? 2 : 8) : Zb.test(i) ? hn : +i;
			}
			function Dg(i) {
				return mr(i, Dn(i));
			}
			function mx(i) {
				return i ? ki(Ie(i), -Fn, Fn) : i === 0 ? i : 0;
			}
			function We(i) {
				return i == null ? "" : In(i);
			}
			var yx = as(function(i, a) {
				if (to(a) || yn(a)) {
					mr(a, Nt(a), i);
					return;
				}
				for (var l in a) Ge.call(a, l) && Zs(i, l, a[l]);
			}), wg = as(function(i, a) {
				mr(a, Dn(a), i);
			}), Ia = as(function(i, a, l, D) {
				mr(a, Dn(a), i, D);
			}), Dx = as(function(i, a, l, D) {
				mr(a, Nt(a), i, D);
			}), wx = Mr(lc);
			function bx(i, a) {
				var l = os(i);
				return a == null ? l : Xh(l, a);
			}
			var Ex = Te(function(i, a) {
				i = Xe(i);
				var l = -1, D = a.length, b = D > 2 ? a[2] : n;
				for (b && an(a[0], a[1], b) && (D = 1); ++l < D;) for (var F = a[l], k = Dn(F), O = -1, M = k.length; ++O < M;) {
					var Z = k[O], J = i[Z];
					(J === n || ir(J, rs[Z]) && !Ge.call(i, Z)) && (i[Z] = F[Z]);
				}
				return i;
			}), vx = Te(function(i) {
				return i.push(n, Op), _n(bg, n, i);
			});
			function Sx(i, a) {
				return Rh(i, we(a, 3), gr);
			}
			function Cx(i, a) {
				return Rh(i, we(a, 3), dc);
			}
			function xx(i, a) {
				return i == null ? i : fc(i, we(a, 3), Dn);
			}
			function Fx(i, a) {
				return i == null ? i : np(i, we(a, 3), Dn);
			}
			function Ax(i, a) {
				return i && gr(i, we(a, 3));
			}
			function _x(i, a) {
				return i && dc(i, we(a, 3));
			}
			function Bx(i) {
				return i == null ? [] : fa(i, Nt(i));
			}
			function Ix(i) {
				return i == null ? [] : fa(i, Dn(i));
			}
			function jc(i, a, l) {
				var D = i == null ? n : Ri(i, a);
				return D === n ? l : D;
			}
			function kx(i, a) {
				return i != null && $p(i, a, ev);
			}
			function Gc(i, a) {
				return i != null && $p(i, a, tv);
			}
			var Rx = kp(function(i, a, l) {
				a != null && typeof a.toString != "function" && (a = Yo.call(a)), i[a] = l;
			}, Kc(wn)), Tx = kp(function(i, a, l) {
				a != null && typeof a.toString != "function" && (a = Yo.call(a)), Ge.call(i, a) ? i[a].push(l) : i[a] = [l];
			}, we), Px = Te(Xs);
			function Nt(i) {
				return yn(i) ? Zh(i) : mc(i);
			}
			function Dn(i) {
				return yn(i) ? Zh(i, !0) : fv(i);
			}
			function Nx(i, a) {
				var l = {};
				return a = we(a, 3), gr(i, function(D, b, F) {
					Or(l, a(D, b, F), D);
				}), l;
			}
			function Ox(i, a) {
				var l = {};
				return a = we(a, 3), gr(i, function(D, b, F) {
					Or(l, b, a(D, b, F));
				}), l;
			}
			var Ux = as(function(i, a, l) {
				da(i, a, l);
			}), bg = as(function(i, a, l, D) {
				da(i, a, l, D);
			}), Mx = Mr(function(i, a) {
				var l = {};
				if (i == null) return l;
				var D = !1;
				a = it(a, function(F) {
					return F = ci(F, i), D || (D = F.length > 1), F;
				}), mr(i, Ic(i), l), D && (l = qn(l, y | w | E, Rv));
				for (var b = a.length; b--;) vc(l, a[b]);
				return l;
			});
			function $x(i, a) {
				return Eg(i, Aa(we(a)));
			}
			var Lx = Mr(function(i, a) {
				return i == null ? {} : hv(i, a);
			});
			function Eg(i, a) {
				if (i == null) return {};
				var l = it(Ic(i), function(D) {
					return [D];
				});
				return a = we(a), dp(i, l, function(D, b) {
					return a(D, b[0]);
				});
			}
			function zx(i, a, l) {
				a = ci(a, i);
				var D = -1, b = a.length;
				for (b || (b = 1, i = n); ++D < b;) {
					var F = i == null ? n : i[yr(a[D])];
					F === n && (D = b, F = l), i = Lr(F) ? F.call(i) : F;
				}
				return i;
			}
			function Hx(i, a, l) {
				return i == null ? i : Qs(i, a, l);
			}
			function qx(i, a, l, D) {
				return D = typeof D == "function" ? D : n, i == null ? i : Qs(i, a, l, D);
			}
			var vg = Pp(Nt), Sg = Pp(Dn);
			function jx(i, a, l) {
				var D = Fe(i), b = D || fi(i) || ls(i);
				if (a = we(a, 4), l == null) {
					var F = i && i.constructor;
					b ? l = D ? new F() : [] : st(i) ? l = Lr(F) ? os(ta(i)) : {} : l = {};
				}
				return (b ? Ln : gr)(i, function(k, O, M) {
					return a(l, k, O, M);
				}), l;
			}
			function Gx(i, a) {
				return i == null ? !0 : vc(i, a);
			}
			function Wx(i, a, l) {
				return i == null ? i : yp(i, a, xc(l));
			}
			function Kx(i, a, l, D) {
				return D = typeof D == "function" ? D : n, i == null ? i : yp(i, a, xc(l), D);
			}
			function fs(i) {
				return i == null ? [] : rc(i, Nt(i));
			}
			function Vx(i) {
				return i == null ? [] : rc(i, Dn(i));
			}
			function Zx(i, a, l) {
				return l === n && (l = a, a = n), l !== n && (l = Wn(l), l = l === l ? l : 0), a !== n && (a = Wn(a), a = a === a ? a : 0), ki(Wn(i), a, l);
			}
			function Jx(i, a, l) {
				return a = zr(a), l === n ? (l = a, a = 0) : l = zr(l), i = Wn(i), nv(i, a, l);
			}
			function Xx(i, a, l) {
				if (l && typeof l != "boolean" && an(i, a, l) && (a = l = n), l === n && (typeof a == "boolean" ? (l = a, a = n) : typeof i == "boolean" && (l = i, i = n)), i === n && a === n ? (i = 0, a = 1) : (i = zr(i), a === n ? (a = i, i = 0) : a = zr(a)), i > a) {
					var D = i;
					i = a, a = D;
				}
				if (l || i % 1 || a % 1) {
					var b = Kh();
					return Zt(i + b * (a - i + BE("1e-" + ((b + "").length - 1))), a);
				}
				return wc(i, a);
			}
			var Yx = us(function(i, a, l) {
				return a = a.toLowerCase(), i + (l ? Cg(a) : a);
			});
			function Cg(i) {
				return Wc(We(i).toLowerCase());
			}
			function xg(i) {
				return i = We(i), i && i.replace(eE, HE).replace(wE, "");
			}
			function Qx(i, a, l) {
				i = We(i), a = In(a);
				var D = i.length;
				l = l === n ? D : ki(Ie(l), 0, D);
				var b = l;
				return l -= a.length, l >= 0 && i.slice(l, b) == a;
			}
			function eF(i) {
				return i = We(i), i && Pb.test(i) ? i.replace(Xi, qE) : i;
			}
			function tF(i) {
				return i = We(i), i && Lb.test(i) ? i.replace(zu, "\\$&") : i;
			}
			var nF = us(function(i, a, l) {
				return i + (l ? "-" : "") + a.toLowerCase();
			}), rF = us(function(i, a, l) {
				return i + (l ? " " : "") + a.toLowerCase();
			}), iF = _p("toLowerCase");
			function sF(i, a, l) {
				i = We(i), a = Ie(a);
				var D = a ? ts(i) : 0;
				if (!a || D >= a) return i;
				var b = (a - D) / 2;
				return Da(sa(b), l) + i + Da(ia(b), l);
			}
			function oF(i, a, l) {
				i = We(i), a = Ie(a);
				var D = a ? ts(i) : 0;
				return a && D < a ? i + Da(a - D, l) : i;
			}
			function aF(i, a, l) {
				i = We(i), a = Ie(a);
				var D = a ? ts(i) : 0;
				return a && D < a ? Da(a - D, l) + i : i;
			}
			function uF(i, a, l) {
				return l || a == null ? a = 0 : a && (a = +a), g1(We(i).replace(Hu, ""), a || 0);
			}
			function cF(i, a, l) {
				return (l ? an(i, a, l) : a === n) ? a = 1 : a = Ie(a), bc(We(i), a);
			}
			function lF() {
				var i = arguments, a = We(i[0]);
				return i.length < 3 ? a : a.replace(i[1], i[2]);
			}
			var fF = us(function(i, a, l) {
				return i + (l ? "_" : "") + a.toLowerCase();
			});
			function dF(i, a, l) {
				return l && typeof l != "number" && an(i, a, l) && (a = l = n), l = l === n ? He : l >>> 0, l ? (i = We(i), i && (typeof a == "string" || a != null && !qc(a)) && (a = In(a), !a && es(i)) ? li(nr(i), 0, l) : i.split(a, l)) : [];
			}
			var hF = us(function(i, a, l) {
				return i + (l ? " " : "") + Wc(a);
			});
			function pF(i, a, l) {
				return i = We(i), l = l == null ? 0 : ki(Ie(l), 0, i.length), a = In(a), i.slice(l, l + a.length) == a;
			}
			function gF(i, a, l) {
				var D = x.templateSettings;
				l && an(i, a, l) && (a = n), i = We(i), a = Ia({}, a, D, Np);
				var b = Ia({}, a.imports, D.imports, Np), F = Nt(b), k = rc(b, F), O, M, Z = 0, J = a.interpolate || qo, ee = "__p += '", oe = sc((a.escape || qo).source + "|" + J.source + "|" + (J === rh ? Vb : qo).source + "|" + (a.evaluate || qo).source + "|$", "g"), ye = "//# sourceURL=" + (Ge.call(a, "sourceURL") ? (a.sourceURL + "").replace(/\s/g, " ") : "lodash.templateSources[" + ++CE + "]") + `
`;
				i.replace(oe, function(ve, Pe, Me, Rn, un, Tn) {
					return Me || (Me = Rn), ee += i.slice(Z, Tn).replace(tE, jE), Pe && (O = !0, ee += `' +
__e(` + Pe + `) +
'`), un && (M = !0, ee += `';
` + un + `;
__p += '`), Me && (ee += `' +
((__t = (` + Me + `)) == null ? '' : __t) +
'`), Z = Tn + ve.length, ve;
				}), ee += `';
`;
				var Ee = Ge.call(a, "variable") && a.variable;
				if (!Ee) ee = `with (obj) {
` + ee + `
}
`;
				else if (Wb.test(Ee)) throw new Ce(c);
				ee = (M ? ee.replace(me, "") : ee).replace(sn, "$1").replace(Vt, "$1;"), ee = "function(" + (Ee || "obj") + `) {
` + (Ee ? "" : `obj || (obj = {});
`) + "var __t, __p = ''" + (O ? ", __e = _.escape" : "") + (M ? `, __j = Array.prototype.join;
function print() { __p += __j.call(arguments, '') }
` : `;
`) + ee + `return __p
}`;
				var ke = Ag(function() {
					return qe(F, ye + "return " + ee).apply(n, k);
				});
				if (ke.source = ee, Hc(ke)) throw ke;
				return ke;
			}
			function mF(i) {
				return We(i).toLowerCase();
			}
			function yF(i) {
				return We(i).toUpperCase();
			}
			function DF(i, a, l) {
				if (i = We(i), i && (l || a === n)) return Oh(i);
				if (!i || !(a = In(a))) return i;
				var D = nr(i), b = nr(a);
				return li(D, Uh(D, b), Mh(D, b) + 1).join("");
			}
			function wF(i, a, l) {
				if (i = We(i), i && (l || a === n)) return i.slice(0, Lh(i) + 1);
				if (!i || !(a = In(a))) return i;
				var D = nr(i);
				return li(D, 0, Mh(D, nr(a)) + 1).join("");
			}
			function bF(i, a, l) {
				if (i = We(i), i && (l || a === n)) return i.replace(Hu, "");
				if (!i || !(a = In(a))) return i;
				var D = nr(i);
				return li(D, Uh(D, nr(a))).join("");
			}
			function EF(i, a) {
				var l = lr, D = Zi;
				if (st(a)) {
					var b = "separator" in a ? a.separator : b;
					l = "length" in a ? Ie(a.length) : l, D = "omission" in a ? In(a.omission) : D;
				}
				i = We(i);
				var F = i.length;
				if (es(i)) {
					var k = nr(i);
					F = k.length;
				}
				if (l >= F) return i;
				var O = l - ts(D);
				if (O < 1) return D;
				var M = k ? li(k, 0, O).join("") : i.slice(0, O);
				if (b === n) return M + D;
				if (k && (O += M.length - O), qc(b)) {
					if (i.slice(O).search(b)) {
						var Z, J = M;
						for (b.global || (b = sc(b.source, We(ih.exec(b)) + "g")), b.lastIndex = 0; Z = b.exec(J);) var ee = Z.index;
						M = M.slice(0, ee === n ? O : ee);
					}
				} else if (i.indexOf(In(b), O) != O) {
					var oe = M.lastIndexOf(b);
					oe > -1 && (M = M.slice(0, oe));
				}
				return M + D;
			}
			function vF(i) {
				return i = We(i), i && Tb.test(i) ? i.replace(Ji, XE) : i;
			}
			var SF = us(function(i, a, l) {
				return i + (l ? " " : "") + a.toUpperCase();
			}), Wc = _p("toUpperCase");
			function Fg(i, a, l) {
				return i = We(i), a = l ? n : a, a === n ? WE(i) ? e1(i) : UE(i) : i.match(a) || [];
			}
			var Ag = Te(function(i, a) {
				try {
					return _n(i, n, a);
				} catch (l) {
					return Hc(l) ? l : new Ce(l);
				}
			}), CF = Mr(function(i, a) {
				return Ln(a, function(l) {
					l = yr(l), Or(i, l, Lc(i[l], i));
				}), i;
			});
			function xF(i) {
				var a = i == null ? 0 : i.length, l = we();
				return i = a ? it(i, function(D) {
					if (typeof D[1] != "function") throw new zn(u);
					return [l(D[0]), D[1]];
				}) : [], Te(function(D) {
					for (var b = -1; ++b < a;) {
						var F = i[b];
						if (_n(F[0], this, D)) return _n(F[1], this, D);
					}
				});
			}
			function FF(i) {
				return X1(qn(i, y));
			}
			function Kc(i) {
				return function() {
					return i;
				};
			}
			function AF(i, a) {
				return i == null || i !== i ? a : i;
			}
			var _F = Ip(), BF = Ip(!0);
			function wn(i) {
				return i;
			}
			function Vc(i) {
				return op(typeof i == "function" ? i : qn(i, y));
			}
			function IF(i) {
				return up(qn(i, y));
			}
			function kF(i, a) {
				return cp(i, qn(a, y));
			}
			var RF = Te(function(i, a) {
				return function(l) {
					return Xs(l, i, a);
				};
			}), TF = Te(function(i, a) {
				return function(l) {
					return Xs(i, l, a);
				};
			});
			function Zc(i, a, l) {
				var D = Nt(a), b = fa(a, D);
				l == null && !(st(a) && (b.length || !D.length)) && (l = a, a = i, i = this, b = fa(a, Nt(a)));
				var F = !(st(l) && "chain" in l) || !!l.chain, k = Lr(i);
				return Ln(b, function(O) {
					var M = a[O];
					i[O] = M, k && (i.prototype[O] = function() {
						var Z = this.__chain__;
						if (F || Z) {
							var J = i(this.__wrapped__);
							return (J.__actions__ = mn(this.__actions__)).push({
								func: M,
								args: arguments,
								thisArg: i
							}), J.__chain__ = Z, J;
						}
						return M.apply(i, ii([this.value()], arguments));
					});
				}), i;
			}
			function PF() {
				return Ht._ === this && (Ht._ = o1), this;
			}
			function Jc() {}
			function NF(i) {
				return i = Ie(i), Te(function(a) {
					return lp(a, i);
				});
			}
			var OF = Ac(it), UF = Ac(kh), MF = Ac(Yu);
			function _g(i) {
				return Pc(i) ? Qu(yr(i)) : pv(i);
			}
			function $F(i) {
				return function(a) {
					return i == null ? n : Ri(i, a);
				};
			}
			var LF = Rp(), zF = Rp(!0);
			function Xc() {
				return [];
			}
			function Yc() {
				return !1;
			}
			function HF() {
				return {};
			}
			function qF() {
				return "";
			}
			function jF() {
				return !0;
			}
			function GF(i, a) {
				if (i = Ie(i), i < 1 || i > Fn) return [];
				var l = He, D = Zt(i, He);
				a = we(a), i -= He;
				for (var b = nc(D, a); ++l < i;) a(l);
				return b;
			}
			function WF(i) {
				return Fe(i) ? it(i, yr) : kn(i) ? [i] : mn(Vp(We(i)));
			}
			function KF(i) {
				var a = ++i1;
				return We(i) + a;
			}
			var VF = ya(function(i, a) {
				return i + a;
			}, 0), ZF = _c("ceil"), JF = ya(function(i, a) {
				return i / a;
			}, 1), XF = _c("floor");
			function YF(i) {
				return i && i.length ? la(i, wn, hc) : n;
			}
			function QF(i, a) {
				return i && i.length ? la(i, we(a, 2), hc) : n;
			}
			function eA(i) {
				return Ph(i, wn);
			}
			function tA(i, a) {
				return Ph(i, we(a, 2));
			}
			function nA(i) {
				return i && i.length ? la(i, wn, yc) : n;
			}
			function rA(i, a) {
				return i && i.length ? la(i, we(a, 2), yc) : n;
			}
			var iA = ya(function(i, a) {
				return i * a;
			}, 1), sA = _c("round"), oA = ya(function(i, a) {
				return i - a;
			}, 0);
			function aA(i) {
				return i && i.length ? tc(i, wn) : 0;
			}
			function uA(i, a) {
				return i && i.length ? tc(i, we(a, 2)) : 0;
			}
			return x.after = IC, x.ary = sg, x.assign = yx, x.assignIn = wg, x.assignInWith = Ia, x.assignWith = Dx, x.at = wx, x.before = og, x.bind = Lc, x.bindAll = CF, x.bindKey = ag, x.castArray = HC, x.chain = ng, x.chunk = Xv, x.compact = Yv, x.concat = Qv, x.cond = xF, x.conforms = FF, x.constant = Kc, x.countBy = aC, x.create = bx, x.curry = ug, x.curryRight = cg, x.debounce = lg, x.defaults = Ex, x.defaultsDeep = vx, x.defer = kC, x.delay = RC, x.difference = eS, x.differenceBy = tS, x.differenceWith = nS, x.drop = rS, x.dropRight = iS, x.dropRightWhile = sS, x.dropWhile = oS, x.fill = aS, x.filter = cC, x.flatMap = dC, x.flatMapDeep = hC, x.flatMapDepth = pC, x.flatten = Yp, x.flattenDeep = uS, x.flattenDepth = cS, x.flip = TC, x.flow = _F, x.flowRight = BF, x.fromPairs = lS, x.functions = Bx, x.functionsIn = Ix, x.groupBy = gC, x.initial = dS, x.intersection = hS, x.intersectionBy = pS, x.intersectionWith = gS, x.invert = Rx, x.invertBy = Tx, x.invokeMap = yC, x.iteratee = Vc, x.keyBy = DC, x.keys = Nt, x.keysIn = Dn, x.map = Ca, x.mapKeys = Nx, x.mapValues = Ox, x.matches = IF, x.matchesProperty = kF, x.memoize = Fa, x.merge = Ux, x.mergeWith = bg, x.method = RF, x.methodOf = TF, x.mixin = Zc, x.negate = Aa, x.nthArg = NF, x.omit = Mx, x.omitBy = $x, x.once = PC, x.orderBy = wC, x.over = OF, x.overArgs = NC, x.overEvery = UF, x.overSome = MF, x.partial = zc, x.partialRight = fg, x.partition = bC, x.pick = Lx, x.pickBy = Eg, x.property = _g, x.propertyOf = $F, x.pull = wS, x.pullAll = eg, x.pullAllBy = bS, x.pullAllWith = ES, x.pullAt = vS, x.range = LF, x.rangeRight = zF, x.rearg = OC, x.reject = SC, x.remove = SS, x.rest = UC, x.reverse = Mc, x.sampleSize = xC, x.set = Hx, x.setWith = qx, x.shuffle = FC, x.slice = CS, x.sortBy = BC, x.sortedUniq = kS, x.sortedUniqBy = RS, x.split = dF, x.spread = MC, x.tail = TS, x.take = PS, x.takeRight = NS, x.takeRightWhile = OS, x.takeWhile = US, x.tap = YS, x.throttle = $C, x.thru = Sa, x.toArray = mg, x.toPairs = vg, x.toPairsIn = Sg, x.toPath = WF, x.toPlainObject = Dg, x.transform = jx, x.unary = LC, x.union = MS, x.unionBy = $S, x.unionWith = LS, x.uniq = zS, x.uniqBy = HS, x.uniqWith = qS, x.unset = Gx, x.unzip = $c, x.unzipWith = tg, x.update = Wx, x.updateWith = Kx, x.values = fs, x.valuesIn = Vx, x.without = jS, x.words = Fg, x.wrap = zC, x.xor = GS, x.xorBy = WS, x.xorWith = KS, x.zip = VS, x.zipObject = ZS, x.zipObjectDeep = JS, x.zipWith = XS, x.entries = vg, x.entriesIn = Sg, x.extend = wg, x.extendWith = Ia, Zc(x, x), x.add = VF, x.attempt = Ag, x.camelCase = Yx, x.capitalize = Cg, x.ceil = ZF, x.clamp = Zx, x.clone = qC, x.cloneDeep = GC, x.cloneDeepWith = WC, x.cloneWith = jC, x.conformsTo = KC, x.deburr = xg, x.defaultTo = AF, x.divide = JF, x.endsWith = Qx, x.eq = ir, x.escape = eF, x.escapeRegExp = tF, x.every = uC, x.find = lC, x.findIndex = Jp, x.findKey = Sx, x.findLast = fC, x.findLastIndex = Xp, x.findLastKey = Cx, x.floor = XF, x.forEach = rg, x.forEachRight = ig, x.forIn = xx, x.forInRight = Fx, x.forOwn = Ax, x.forOwnRight = _x, x.get = jc, x.gt = VC, x.gte = ZC, x.has = kx, x.hasIn = Gc, x.head = Qp, x.identity = wn, x.includes = mC, x.indexOf = fS, x.inRange = Jx, x.invoke = Px, x.isArguments = Ni, x.isArray = Fe, x.isArrayBuffer = JC, x.isArrayLike = yn, x.isArrayLikeObject = dt, x.isBoolean = XC, x.isBuffer = fi, x.isDate = YC, x.isElement = QC, x.isEmpty = ex, x.isEqual = tx, x.isEqualWith = nx, x.isError = Hc, x.isFinite = rx, x.isFunction = Lr, x.isInteger = dg, x.isLength = _a, x.isMap = hg, x.isMatch = ix, x.isMatchWith = sx, x.isNaN = ox, x.isNative = ax, x.isNil = cx, x.isNull = ux, x.isNumber = pg, x.isObject = st, x.isObjectLike = ct, x.isPlainObject = ro, x.isRegExp = qc, x.isSafeInteger = lx, x.isSet = gg, x.isString = Ba, x.isSymbol = kn, x.isTypedArray = ls, x.isUndefined = fx, x.isWeakMap = dx, x.isWeakSet = hx, x.join = mS, x.kebabCase = nF, x.last = Gn, x.lastIndexOf = yS, x.lowerCase = rF, x.lowerFirst = iF, x.lt = px, x.lte = gx, x.max = YF, x.maxBy = QF, x.mean = eA, x.meanBy = tA, x.min = nA, x.minBy = rA, x.stubArray = Xc, x.stubFalse = Yc, x.stubObject = HF, x.stubString = qF, x.stubTrue = jF, x.multiply = iA, x.nth = DS, x.noConflict = PF, x.noop = Jc, x.now = xa, x.pad = sF, x.padEnd = oF, x.padStart = aF, x.parseInt = uF, x.random = Xx, x.reduce = EC, x.reduceRight = vC, x.repeat = cF, x.replace = lF, x.result = zx, x.round = sA, x.runInContext = U, x.sample = CC, x.size = AC, x.snakeCase = fF, x.some = _C, x.sortedIndex = xS, x.sortedIndexBy = FS, x.sortedIndexOf = AS, x.sortedLastIndex = _S, x.sortedLastIndexBy = BS, x.sortedLastIndexOf = IS, x.startCase = hF, x.startsWith = pF, x.subtract = oA, x.sum = aA, x.sumBy = uA, x.template = gF, x.times = GF, x.toFinite = zr, x.toInteger = Ie, x.toLength = yg, x.toLower = mF, x.toNumber = Wn, x.toSafeInteger = mx, x.toString = We, x.toUpper = yF, x.trim = DF, x.trimEnd = wF, x.trimStart = bF, x.truncate = EF, x.unescape = vF, x.uniqueId = KF, x.upperCase = SF, x.upperFirst = Wc, x.each = rg, x.eachRight = ig, x.first = Qp, Zc(x, function() {
				var i = {};
				return gr(x, function(a, l) {
					Ge.call(x.prototype, l) || (i[l] = a);
				}), i;
			}(), { chain: !1 }), x.VERSION = r, Ln([
				"bind",
				"bindKey",
				"curry",
				"curryRight",
				"partial",
				"partialRight"
			], function(i) {
				x[i].placeholder = x;
			}), Ln(["drop", "take"], function(i, a) {
				Oe.prototype[i] = function(l) {
					l = l === n ? 1 : Tt(Ie(l), 0);
					var D = this.__filtered__ && !a ? new Oe(this) : this.clone();
					return D.__filtered__ ? D.__takeCount__ = Zt(l, D.__takeCount__) : D.__views__.push({
						size: Zt(l, He),
						type: i + (D.__dir__ < 0 ? "Right" : "")
					}), D;
				}, Oe.prototype[i + "Right"] = function(l) {
					return this.reverse()[i](l).reverse();
				};
			}), Ln([
				"filter",
				"map",
				"takeWhile"
			], function(i, a) {
				var l = a + 1, D = l == ti || l == Ls;
				Oe.prototype[i] = function(b) {
					var F = this.clone();
					return F.__iteratees__.push({
						iteratee: we(b, 3),
						type: l
					}), F.__filtered__ = F.__filtered__ || D, F;
				};
			}), Ln(["head", "last"], function(i, a) {
				var l = "take" + (a ? "Right" : "");
				Oe.prototype[i] = function() {
					return this[l](1).value()[0];
				};
			}), Ln(["initial", "tail"], function(i, a) {
				var l = "drop" + (a ? "" : "Right");
				Oe.prototype[i] = function() {
					return this.__filtered__ ? new Oe(this) : this[l](1);
				};
			}), Oe.prototype.compact = function() {
				return this.filter(wn);
			}, Oe.prototype.find = function(i) {
				return this.filter(i).head();
			}, Oe.prototype.findLast = function(i) {
				return this.reverse().find(i);
			}, Oe.prototype.invokeMap = Te(function(i, a) {
				return typeof i == "function" ? new Oe(this) : this.map(function(l) {
					return Xs(l, i, a);
				});
			}), Oe.prototype.reject = function(i) {
				return this.filter(Aa(we(i)));
			}, Oe.prototype.slice = function(i, a) {
				i = Ie(i);
				var l = this;
				return l.__filtered__ && (i > 0 || a < 0) ? new Oe(l) : (i < 0 ? l = l.takeRight(-i) : i && (l = l.drop(i)), a !== n && (a = Ie(a), l = a < 0 ? l.dropRight(-a) : l.take(a - i)), l);
			}, Oe.prototype.takeRightWhile = function(i) {
				return this.reverse().takeWhile(i).reverse();
			}, Oe.prototype.toArray = function() {
				return this.take(He);
			}, gr(Oe.prototype, function(i, a) {
				var l = /^(?:filter|find|map|reject)|While$/.test(a), D = /^(?:head|last)$/.test(a), b = x[D ? "take" + (a == "last" ? "Right" : "") : a], F = D || /^find/.test(a);
				b && (x.prototype[a] = function() {
					var k = this.__wrapped__, O = D ? [1] : arguments, M = k instanceof Oe, Z = O[0], J = M || Fe(k), ee = function(Pe) {
						var Me = b.apply(x, ii([Pe], O));
						return D && oe ? Me[0] : Me;
					};
					J && l && typeof Z == "function" && Z.length != 1 && (M = J = !1);
					var oe = this.__chain__, ye = !!this.__actions__.length, Ee = F && !oe, ke = M && !ye;
					if (!F && J) {
						k = ke ? k : new Oe(this);
						var ve = i.apply(k, O);
						return ve.__actions__.push({
							func: Sa,
							args: [ee],
							thisArg: n
						}), new Hn(ve, oe);
					}
					return Ee && ke ? i.apply(this, O) : (ve = this.thru(ee), Ee ? D ? ve.value()[0] : ve.value() : ve);
				});
			}), Ln([
				"pop",
				"push",
				"shift",
				"sort",
				"splice",
				"unshift"
			], function(i) {
				var a = Zo[i], l = /^(?:push|sort|unshift)$/.test(i) ? "tap" : "thru", D = /^(?:pop|shift)$/.test(i);
				x.prototype[i] = function() {
					var b = arguments;
					if (D && !this.__chain__) {
						var F = this.value();
						return a.apply(Fe(F) ? F : [], b);
					}
					return this[l](function(k) {
						return a.apply(Fe(k) ? k : [], b);
					});
				};
			}), gr(Oe.prototype, function(i, a) {
				var l = x[a];
				if (l) {
					var D = l.name + "";
					Ge.call(ss, D) || (ss[D] = []), ss[D].push({
						name: a,
						func: l
					});
				}
			}), ss[ma(n, $).name] = [{
				name: "wrapper",
				func: n
			}], Oe.prototype.clone = v1, Oe.prototype.reverse = S1, Oe.prototype.value = C1, x.prototype.at = QS, x.prototype.chain = eC, x.prototype.commit = tC, x.prototype.next = nC, x.prototype.plant = iC, x.prototype.reverse = sC, x.prototype.toJSON = x.prototype.valueOf = x.prototype.value = oC, x.prototype.first = x.prototype.head, js && (x.prototype[js] = rC), x;
		}();
		Ai ? ((Ai.exports = ns)._ = ns, Vu._ = ns) : Ht._ = ns;
	}).call(yt);
})(Ja, Ja.exports);
var Jl = Ja.exports;
function fy() {
	return typeof __DEV__ < "u" ? __DEV__ : typeof process < "u" && process.env ? false : !1;
}
function Cn(e, t = !0) {
	const n = `[${e}]`;
	return {
		log: (...r) => t && console.log(n, ...r),
		warn: (...r) => t && console.warn(n, ...r),
		error: (...r) => console.error(n, ...r),
		debug: (...r) => t && console.debug(n, ...r),
		crumb: (...r) => t && console.log(n, "[crumb]", ...r),
		trackError: (r, s) => console.error(n, "[error]", r, s),
		trackEvent: (r, s) => t && console.log(n, "[event]", r, s),
		sensorsLog: (...r) => t && console.log(n, "[sensors]", ...r)
	};
}
function dA(e) {
	return e.replace(/\n/g, "\\n");
}
function dy(e) {}
var Ke = /* @__PURE__ */ ((e) => (e.InviteShared = "Invite Link Shared", e.OnboardingSessionRevived = "Onboarding Session Revived", e.AppInstalled = "App Installed", e.AppUpdated = "App Updated", e.AppActive = "App Active", e.LoggedInBeforeSignup = "Logged In Without Signing Up", e.FailedSignupOTP = "Failed to send Signup OTP", e.FailedLoginOTP = "Failed to send Login OTP", e.InvitedUserFailedInventoryCheck = "Invited User Failed Inventory Check", e.PersonalInvitePressed = "Personal Invite Shown", e.ChannelTemplateSetup = "Channel Created from Template", e.ChannelLoadComplete = "Channel Load Complete", e.SessionInitialized = "Session Initialized", e.NodeNotRunning = "Node Not Running", e.NodeUnderMaintenance = "Node Under Maintenance", e.LoginDebug = "Login Debug", e.LoginAnomaly = "Login Anomaly", e.ExpectedHostingError = "Expected Hosting API Error", e.UnexpectedHostingError = "Unexpected Hosting API Response", e.NodeWaitReport = "Node Wait Report", e.InviteError = "Invite Error", e.InviteDebug = "Invite Debug", e.InviteButtonShown = "Invite Button Shown", e.InitializedNewInvite = "Initialized New Invite", e.DebugLogs = "Debug Logs", e.DebugGroupCreate = "Create Group Debug", e.DebugAttestation = "Attestation Debug", e.DebugContactMatching = "Contact Matching Debug", e.ErrorContactMatching = "Contact Matching Error", e.AppError = "App Error", e.AuthenticatedNodeStopped = "Node Stopped While Logged In", e.Scry = "Scry", e.ScryNoun = "Scry Noun", e.Poke = "Poke", e.NativeDbDebug = "Native DB Debug", e.Thread = "Thread", e.TrackedPoke = "TrackedPoke", e.ErrorDatabaseQuery = "Database Query Error", e.ErrorTrackedPokeTimeout = "Error Tracked Poke Timeout", e.ErrorThread = "Thread Error", e.ErrorSubscribeOnceTimeout = "Error Subscribe Once Timeout", e.ErrorNativeDb = "Native DB Error", e.InitDataFetched = "Init Data Fetched", e.InitDataWritten = "Init Data Written", e.LatestPostsFetched = "Latest Posts Fetched", e.LatestPostsWritten = "Latest Posts Written", e.SubscriptionsEstablished = "Subscriptions Established", e.AuthFailedToGetCode = "Failed to get access code", e.AuthForcedLogout = "Auth Forced Logout", e.NodeConnectionDebug = "Node Connection Debug", e.NodeConnectionError = "Node Connection Error", e.SyncDiscontinuity = "Sync Discontinuity", e.OnNetworkInvite = "Sent On Network Group Invite", e.UserLoggedIn = "User Logged In", e.NodeAuthSaved = "Node Auth Saved", e.ErrorNodeResumePush = "Node Resume Push Error", e.AnalyticsDigest = "Usage Digest Report", e.WebAppOpened = "Web App Opened", e.WebConsoleError = "Web Console Error", e.WayfindingDebug = "Wayfinding Debug", e.AttachmentUploadSuccess = "Attachment Upload Success", e.ActionContactAdded = "Contact Added", e.ActionContactRemoved = "Contact Removed", e.ActionRemoveContactSuggestion = "Removed Contact Suggestion", e.ActionContactEdited = "Contact Edited", e.ActionUpdatedProfile = "Updated Profile", e.ActionSendPost = "Sent Post", e.ActionForwardPost = "Forwarded Post", e.ActionForwardGroup = "Forwarded Group", e.ActionStartedDM = "Started DM", e.ActionSendPostRetry = "Retried Post Send", e.ActionHidePost = "Hid Post", e.ActionSendReply = "Sent Thread Reply", e.ActionDeletePost = "Deleted Post", e.ActionReact = "Reacted to Post", e.ActionUnreact = "Removed Reaction from Post ", e.ActionRespondToDMInvite = "Responded to DM Invite", e.ActionBlockUser = "Blocked User", e.ActionUnblockUser = "Unblocked User", e.ActionCustomizeDM = "Customized DM", e.ActionJoinGroup = "Joined Group", e.ActionCancelGroupJoin = "Cancelled Group Join", e.ActionCustomizedGroup = "Customized Group", e.ActionDeleteGroup = "Deleted Group", e.ActionKickUser = "Kicked User", e.ActionBanUser = "Banned User", e.ActionUnbanUser = "Unbanned User", e.ActionCreateGroup = "Created Group", e.ActionAcceptJoinRequest = "Accepted Request to Join Group", e.ActionRejectJoinRequest = "Rejected Request to Join Group", e.ActionAcceptGroupInvite = "Accepted Group Invite", e.ActionRejectGroupInvite = "Rejected Group Invite", e.ActionUpdatedGroupPrivacy = "Updated Group Privacy", e.ActionLeaveGroup = "Left Group", e.ActionAddedRole = "Added Group Role", e.ActionRemovedRole = "Removed Group Role", e.ActionUpdatedRole = "Updated Group Role", e.ActionAddMemberRole = "Added Members to Group Role", e.ActionRemoveMemberRole = "Removed Members from Group Role", e.ActionVisitedGroup = "Viewed Group", e.ActionRequestGroupInvite = "Requested Group Invite", e.ActionCreateChannel = "Created Channel", e.ActionDeleteChannel = "Deleted Channel", e.ActionUpdatedChannel = "Updated Channel", e.ActionPinChat = "Pinned Chat", e.ActionUnpinChat = "Unpinned Chat", e.ActionVisitedChannel = "Viewed Channel", e.ActionTappedChat = "Tapped Chatlist Item", e.ActionJoinChannel = "Joined Channel", e.ActionMoveChannel = "Moved Channel", e.ActionUpdateChannelWriters = "Updated Channel Writers", e.ActionAddedNavSection = "Added Navigation Section", e.ActionUpdatedNavSection = "Updated Navigation Section", e.ActionDeletedNavSection = "Deleted Navigation Section", e.ActionUpdatedGroupNavigation = "Updated Group Navigation", e.ActionViewProfileGroup = "Viewed Pinned Profile Group", e.ActionSelectActivityEvent = "Tapped Activity Event", e.ActionsNotifPermsChecked = "Checked Notification Permissions", e.ActionNotifPermsSettingsOpened = "Opened Notification Settings from Nag", e.ActionNotifPermsGrantedFromNag = "Granted Notification Permission from Nag", e.ActionInitiateTwitterAttest = "Initiated Twitter Attestation", e.ActionConfirmTwitterAttest = "Confirmed Twitter Attestation", e.ActionInitiatePhoneAttest = "Initiated Phone Attestation", e.ActionCheckAttestSig = "Checked Attestation Signature", e.ActionRevokeAttestation = "Revoked Attestation", e.ActionUpdateAttestDiscoverability = "Updated Attestation Discoverability", e.ActionConfirmPhoneAttest = "Confirmed Phone Attestation", e.ActionGroupChannelSelected = "Tapped group channel", e.ActionTappedPushNotif = "Tapped Push Notification", e.ActionDeferredDeepLink = "Installed with Deferred Deeplink Invite", e.ActionContactBookSkipped = "Skipped Syncing Contact Book", e.ActionContactBookPermRequested = "Contact Book Requesting Permission", e.ActionContactBookPermGranted = "Contact Book Permission Granted", e.ActionContactBookPermDenied = "Contact Book Permission Denied", e.ActionContactBookInviteShown = "Contact Book Invite Shown", e.ActionContactBookInviteSent = "Contact Book Invite Sent", e.FetchLinkMetadata = "Fetched Link Metadata", e.ActionCalmSettingsUpdate = "Calm Settings Updated", e.ActionThemeUpdate = "Theme Setting Updated", e.DebugSystemContacts = "System Contacts Debug", e.GroupJoinComplete = "Group Join Complete", e.PersonalInviteLinkReady = "Personal Invite Link Ready", e.ErrorSendPost = "Error Sending Post", e.ErrorSendReply = "Error Sending Thread Reply", e.ErrorReact = "Error Reacting to Post", e.ErrorUnreact = "Error Removing Reaction from Post", e.ErrorPushNotifNavigate = "Error Navigating to Push Channel", e.ErrorDigestFailed = "Error Preparing Usage Digest", e.ErrorSyncStartHighPriority = "Error Start Sync: High Priority", e.ErrorSyncStartLowPriority = "Error Start Sync: Low Priority", e.ErrorVerifyingPersonalInvite = "Error Verifying DM Invite Link", e.ErrorAttestation = "Attestation Error", e.ErrorNounParse = "Error Parsing Noun", e.ErrorNotificationService = "Notification Service Error", e.ErrorCreateGroup = "Error Creating Group", e.ErrorWayfinding = "Wayfinding Error", e.ErrorSystemContacts = "System Contacts Error", e.ErrorCalmSettingsUpdate = "Error Updating Calm Settings", e.ErrorThemeUpdate = "Error Updating Theme Setting", e.ErrorApi = "API Error", e.ErrorFetchLinkMetadata = "Error Fetching Link Metadata", e))(Ke || {}), Yl = /* @__PURE__ */ ((e) => (e.Critical = "Critical", e.High = "High", e.Medium = "Medium", e.Low = "Low", e))(Yl || {}), Ig;
((e) => {
	function t(n) {
		switch (n.uploadState.status) {
			case "success": return n.uploadState.remoteUri;
			case "uploading": return n.uploadState.localUri;
		}
	}
	e.uri = t;
})(Ig || (Ig = {}));
var kg;
((e) => {
	function t(n) {
		return hA(n.uploadState);
	}
	e.uri = t;
})(kg || (kg = {}));
var Ql;
((e) => {
	((o) => {
		function u(B) {
			return {
				type: "image",
				asset: B
			};
		}
		o.fromImagePickerAsset = u;
		function c(B) {
			return {
				type: "file",
				file: B
			};
		}
		o.fromFile = c;
		function d(B) {
			switch (B.type) {
				case "image": return B.asset.uri;
				case "file": return URL.createObjectURL(B.file);
				case "fileUri": return B.localUri;
			}
		}
		o.createLocalUri = d;
		function f(B) {
			return B.filter((T) => T.type === "image").map((T) => T.asset);
		}
		o.extractImagePickerAssets = f;
		const m = Jl.memoize((B) => Jl.uniqueId("File"));
		function y(B) {
			return (() => {
				switch (B.type) {
					case "image": return B.asset.uri;
					case "file": return m(B.file);
					case "fileUri": return B.localUri;
				}
			})();
		}
		o.extractKey = y;
		function w(B, T) {
			if (B.type !== T.type) return !1;
			switch (B.type) {
				case "image": return B.asset.uri === T.asset.uri;
				case "file": return B.file === T.file;
				case "fileUri": return B.localUri === T.localUri;
			}
		}
		o.equivalent = w;
		function E(B, T) {
			if (T.status === "error") return null;
			switch (B.type) {
				case "image": return {
					type: "image",
					file: B.asset,
					uploadState: T
				};
				case "file": return {
					type: "file",
					localFile: B.file,
					size: B.file.size,
					mimeType: B.file.type,
					name: B.file.name,
					uploadState: T
				};
				case "fileUri": return {
					type: "file",
					localFile: B.localUri,
					name: B.name,
					size: B.size,
					mimeType: B.type,
					uploadState: T
				};
			}
		}
		o.toFinalizedAttachment = E;
		function A(B) {
			switch (B.type) {
				case "image": return {
					type: "image",
					file: B.asset,
					uploadState: {
						status: "uploading",
						localUri: B.asset.uri
					}
				};
				case "file": return {
					type: "file",
					localFile: B.file,
					size: B.file.size,
					mimeType: B.file.type,
					name: B.file.name,
					uploadState: {
						status: "uploading",
						localUri: d(B)
					}
				};
				case "fileUri": return {
					type: "file",
					localFile: B.localUri,
					size: B.size,
					mimeType: B.mimeType,
					name: B.name,
					uploadState: {
						status: "uploading",
						localUri: B.localUri
					}
				};
			}
		}
		o.toLocalFinalizedAttachment = A;
	})(e.UploadIntent || (e.UploadIntent = {}));
	function t(o) {
		switch (o.type) {
			case "image": return {
				needsUpload: !0,
				type: "image",
				asset: o.file
			};
			case "file": return o.localFile instanceof File ? {
				needsUpload: !0,
				type: "file",
				file: o.localFile
			} : {
				needsUpload: !0,
				type: "fileUri",
				localUri: o.localFile,
				name: o.name,
				size: o.size,
				mimeType: o.mimeType
			};
			case "text":
			case "link":
			case "reference": return {
				needsUpload: !1,
				finalized: o
			};
		}
	}
	e.toUploadIntent = t;
	function n(o) {
		switch (o.type) {
			case "image": return {
				type: "image",
				file: o.asset
			};
			case "file": return {
				type: "file",
				localFile: o.file,
				size: o.file.size,
				mimeType: o.file.type
			};
			case "fileUri": return {
				type: "file",
				localFile: o.localUri,
				name: o.name,
				size: o.size,
				mimeType: o.mimeType
			};
		}
	}
	e.fromUploadIntent = n;
	function r(o, u) {
		const c = t(o);
		if (c.needsUpload) {
			if (u == null || u.status !== "success") return null;
			switch (c.type) {
				case "image": return {
					type: "image",
					file: c.asset,
					uploadState: u
				};
				case "file": return {
					type: "file",
					localFile: c.file,
					size: c.file.size,
					name: c.file.name,
					mimeType: c.file.type,
					uploadState: u
				};
				case "fileUri": return {
					type: "file",
					localFile: c.localUri,
					size: c.size,
					name: c.name,
					mimeType: c.mimeType,
					uploadState: u
				};
			}
		} else return c.finalized;
	}
	e.toSuccessfulFinalizedAttachment = r;
	function s(o) {
		return o.type === "file" && o.localFile instanceof File && typeof URL.createObjectURL == "function" ? {
			...o,
			localFile: URL.createObjectURL(o.localFile),
			name: o.localFile.name,
			size: o.localFile.size,
			mimeType: o.localFile.type
		} : o;
	}
	e.makeSerializable = s;
})(Ql || (Ql = {}));
function hA(e) {
	switch (e.status) {
		case "success": return e.remoteUri;
		case "uploading": return e.localUri;
	}
}
const ys = "tlonEnv", Qc = {
	DEV_SHIP_URL: "",
	INVITE_PROVIDER: "~wannec-dansen",
	NOTIFY_PROVIDER: "~wannec-dansen",
	NOTIFY_SERVICE: "notify",
	POST_HOG_API_KEY: "",
	API_URL: "https://api.tlon.io",
	API_AUTH_USERNAME: void 0,
	API_AUTH_PASSWORD: void 0,
	RECAPTCHA_SITE_KEY: "",
	SHIP_URL_PATTERN: "https://{shipId}.tlon.network",
	DEFAULT_LURE: "",
	DEFAULT_PRIORITY_TOKEN: "",
	DEFAULT_TLON_LOGIN_EMAIL: "",
	DEFAULT_TLON_LOGIN_PASSWORD: "",
	DEFAULT_INVITE_LINK_URL: "",
	DEFAULT_SHIP_LOGIN_URL: "",
	DEFAULT_SHIP_LOGIN_ACCESS_CODE: "",
	DEFAULT_ONBOARDING_PASSWORD: "",
	DEFAULT_ONBOARDING_TLON_EMAIL: "",
	DEFAULT_ONBOARDING_NICKNAME: "",
	DEFAULT_ONBOARDING_PHONE_NUMBER: void 0,
	ENABLED_LOGGERS: [],
	IGNORE_COSMOS: !1,
	TLON_EMPLOYEE_GROUP: "~natnex-ronret/tlon",
	BRANCH_KEY: "",
	BRANCH_DOMAIN: "tlon.network",
	INVITE_SERVICE_ENDPOINT: "https://invite.tlon.io",
	INVITE_SERVICE_IS_DEV: !1,
	GIT_HASH: "",
	DISABLE_SPLASH_MODAL: !1,
	AUTOMATED_TEST: !1,
	OPENROUTER_API_KEY: ""
};
function Li() {
	return typeof window < "u" && window[ys] ? {
		...Qc,
		...window[ys]
	} : typeof global < "u" && global[ys] ? {
		...Qc,
		...global[ys]
	} : Qc;
}
const pA = [
	{
		id: "book-club",
		title: "Book Club",
		subtitle: "Discuss your latest reads",
		description: "A group for discussing books and literature",
		icon: "📚",
		channels: [
			{
				type: "chat",
				title: "Book chat",
				description: "Discuss books and literature"
			},
			{
				type: "gallery",
				title: "Now reading",
				description: "Share what you're currently reading"
			},
			{
				type: "notebook",
				title: "Reviews",
				description: "Write and share book reviews"
			}
		]
	},
	{
		id: "cooking-club",
		title: "Cooking Club",
		subtitle: "Share recipes and cooking tips",
		description: "A group for food lovers and home cooks",
		icon: "🍳",
		channels: [
			{
				type: "chat",
				title: "Food talk",
				description: "Chat about cooking and food"
			},
			{
				type: "gallery",
				title: "Meal pics",
				description: "Share photos of your culinary creations"
			},
			{
				type: "notebook",
				title: "Recipes",
				description: "Collect and share your favorite recipes"
			}
		]
	},
	{
		id: "music",
		title: "Music",
		subtitle: "Share and discover new tunes",
		description: "A group for music lovers and audiophiles",
		icon: "🎵",
		channels: [
			{
				type: "chat",
				title: "Tune talk",
				description: "Discuss music and artists"
			},
			{
				type: "gallery",
				title: "Now listening",
				description: "Share what you're listening to"
			},
			{
				type: "notebook",
				title: "Playlists",
				description: "Curate and share playlists"
			}
		]
	},
	{
		id: "running-club",
		title: "Running Club",
		subtitle: "Track your runs and stay motivated",
		description: "A group for runners of all levels",
		icon: "🏃",
		channels: [
			{
				type: "chat",
				title: "Run chat",
				description: "Chat about running and training"
			},
			{
				type: "gallery",
				title: "Run pics",
				description: "Share photos from your runs"
			},
			{
				type: "notebook",
				title: "Goals",
				description: "Track your running goals and progress"
			}
		]
	},
	{
		id: "cinema-club",
		title: "Cinema Club",
		subtitle: "Discuss and review films",
		description: "A group for movie enthusiasts and film buffs",
		icon: "🎬",
		channels: [
			{
				type: "chat",
				title: "Film chat",
				description: "Discuss movies and cinema"
			},
			{
				type: "gallery",
				title: "Now watching",
				description: "Share what you're currently watching"
			},
			{
				type: "notebook",
				title: "Reviews",
				description: "Write and share film reviews"
			}
		]
	},
	{
		id: "garden-club",
		title: "Garden Club",
		subtitle: "Grow together",
		description: "A group for gardeners and plant enthusiasts",
		icon: "🌱",
		channels: [
			{
				type: "chat",
				title: "Garden talk",
				description: "Chat about gardening and plants"
			},
			{
				type: "gallery",
				title: "Plant pics",
				description: "Share photos of your garden and plants"
			},
			{
				type: "notebook",
				title: "Tips, plans and schedules",
				description: "Share gardening tips and track your plans"
			}
		]
	}
], gA = {
	id: "basic-group",
	title: "Basic Group",
	subtitle: "A basic group with essential channels",
	description: "A basic group with essential channels",
	icon: "✨",
	channels: [
		{
			type: "chat",
			title: "Chat",
			description: "General chat"
		},
		{
			type: "gallery",
			title: "Gallery",
			description: "Share images"
		},
		{
			type: "notebook",
			title: "Notebook",
			description: "Share notes"
		}
	]
};
[...pA, gA].reduce((e, t) => (e[t.id] = t, e), {});
function Rg(e) {
	return e.endsWith("tlon.network") || e.endsWith(".test.tlon.systems");
}
var Tg;
((e) => {
	function t(s) {
		return {
			...s,
			attachments: s.attachments.map(Ql.makeSerializable)
		};
	}
	e.serialize = t;
	function n(s) {
		if (typeof s != "object" || s === null) return !1;
		const o = s;
		return !(!(typeof o.channelId == "string" && Array.isArray(o.content) && Array.isArray(o.attachments) && typeof o.channelType == "string") || o.replyToPostId !== null && typeof o.replyToPostId != "string");
	}
	e.isValid = n;
	function r(s) {
		for (const o of s.attachments) if (o.type === "file" && typeof o.localFile == "string" && o.localFile.startsWith("blob:")) try {
			URL.revokeObjectURL(o.localFile);
		} catch {}
	}
	e.revokeBlobUrls = r;
})(Tg || (Tg = {}));
function DA(e) {
	let t = !0, [n, r, s] = e.split("..");
	r = r || "0.0.0", s = s || "0000";
	let [o, u, c] = n.slice(1).split(".");
	o.at(-1) === "-" && (o = o.slice(0, -1), t = !1);
	const [d, f, m] = r.split("."), y = s.split(".").map((w) => BigInt("0x" + w));
	return CA({
		pos: t,
		year: BigInt(o),
		month: BigInt(u),
		time: {
			day: BigInt(c),
			hour: BigInt(d),
			minute: BigInt(f),
			second: BigInt(m),
			ms: y
		}
	});
}
function wA(e) {
	const t = {
		day: 0n,
		hour: 0n,
		minute: 0n,
		second: 0n,
		ms: []
	};
	e = e.slice(1);
	let [n, r] = e.split("..");
	return r = r || "0000", t.ms = r.split(".").map((s) => BigInt("0x" + s)), n.split(".").forEach((s) => {
		switch (s[0]) {
			case "d":
				t.day += BigInt(s.slice(1));
				break;
			case "h":
				t.hour += BigInt(s.slice(1));
				break;
			case "m":
				t.minute += BigInt(s.slice(1));
				break;
			case "s":
				t.second += BigInt(s.slice(1));
				break;
			default: throw new Error("bad dr: " + e);
		}
	}), r = r || "0000", my(t);
}
function bA(e) {
	const { pos: t, year: n, month: r, time: s } = FA(e);
	let o = `~${n}${t ? "" : "-"}.${r}.${s.day}`;
	return (s.hour !== 0n || s.minute !== 0n || s.second !== 0n || s.ms.length !== 0) && (o = o + `..${s.hour.toString().padStart(2, "0")}.${s.minute.toString().padStart(2, "0")}.${s.second.toString().padStart(2, "0")}`, s.ms.length !== 0 && (o = o + `..${s.ms.map((u) => u.toString(16).padStart(4, "0")).join(".")}`)), o;
}
function EA(e) {
	if (e === 0n) return "~s0";
	const { day: t, hour: n, minute: r, second: s, ms: o } = yy(e);
	let u = [];
	return t !== 0n && u.push("d" + t.toString()), n !== 0n && u.push("h" + n.toString()), r !== 0n && u.push("m" + r.toString()), s !== 0n && u.push("s" + s.toString()), o.length !== 0 && (u.length === 0 && u.push("s0"), u.push("." + o.map((c) => c.toString(16).padStart(4, "0")).join("."))), "~" + u.join(".");
}
function vA(e) {
	const n = ef / 2000n + (e - hy);
	return Math.round(Number(n * 1000n / ef));
}
function SA(e) {
	return hy + BigInt(e) * ef / 1000n;
}
const hy = /* @__PURE__ */ BigInt("170141184475152167957503069145530368000"), ef = /* @__PURE__ */ BigInt("18446744073709551616"), go = /* @__PURE__ */ BigInt("292277024400");
function ka(e) {
	return e % 4n === 0n && e % 100n !== 0n || e % 400n === 0n;
}
const py = [
	31,
	28,
	31,
	30,
	31,
	30,
	31,
	31,
	30,
	31,
	30,
	31
], gy = [
	31,
	29,
	31,
	30,
	31,
	30,
	31,
	31,
	30,
	31,
	30,
	31
], tf = 86400n, nf = 3600n, rf = 60n, Pg = 146097n, Ra = 36524n;
function CA(e) {
	const t = e.pos ? go + BigInt(e.year) : go - (BigInt(e.year) - 1n), n = (() => {
		let r = ka(t) ? gy : py, s = e.time.day - 1n, o = e.month - 1n;
		for (; o !== 0n;) {
			const [d, ...f] = r;
			s = s + BigInt(d), o = o - 1n, r = f;
		}
		let u = !0, c = t;
		for (; u == !0;) if (c % 4n !== 0n) c = c - 1n, s = s + (ka(c) ? 366n : 365n);
		else if (c % 100n !== 0n) c = c - 4n, s = s + (ka(c) ? 1461n : 1460n);
		else if (c % 400n !== 0n) c = c - 100n, s = s + (ka(c) ? 36525n : 36524n);
		else {
			let d = c / 400n;
			s = s + d * (4n * 36524n + 1n), u = !1;
		}
		return s;
	})();
	return e.time.day = n, my(e.time);
}
function my(e) {
	let t = e.second + tf * e.day + nf * e.hour + rf * e.minute, n = e.ms, r = 0n, s = 3n;
	for (; n.length !== 0;) {
		const [o, ...u] = n;
		r = r + (o << 16n * s), n = u, s -= 1n;
	}
	return r | t << 64n;
}
function yy(e) {
	let t = e >> 64n;
	const s = (BigInt("0xffffffffffffffff") & e).toString(16).padStart(16, "0").match(/.{4}/g).map((d) => BigInt("0x" + d));
	for (; s.at(-1) === 0n;) s.pop();
	let o = t / tf;
	t = t % tf;
	let u = t / nf;
	t = t % nf;
	let c = t / rf;
	return t = t % rf, {
		ms: s,
		day: o,
		minute: c,
		hour: u,
		second: t
	};
}
function xA(e) {
	let t = 0n, n = 0n, r = !1;
	t = e / Pg, e = e % Pg, e < Ra + 1n ? r = !0 : (r = !1, n = 1n, e = e - (Ra + 1n), n = n + e / Ra, e = e % Ra);
	let s = t * 400n + n * 100n, o = !0;
	for (; o == !0;) {
		let u = r ? 366n : 365n;
		if (!(e < u)) s = s + 1n, e = e - u, r = s % 4n === 0n;
		else {
			o = !1;
			let d = 0n;
			for (;;) {
				let m = BigInt((r ? gy : py)[Number(d)]);
				if (e < m) return [
					s,
					d + 1n,
					e + 1n
				];
				d = d + 1n, e = e - m;
			}
		}
	}
	return [
		0n,
		0n,
		0n
	];
}
function FA(e) {
	const t = yy(e), [n, r, s] = xA(t.day);
	t.day = s;
	const o = n > go;
	return {
		pos: o,
		year: o ? n - go : go + 1n - n,
		month: r,
		time: t
	};
}
const AA = (e, t) => {
	const n = Number(t & 255n), r = Number((t & 65280n) / 256n), s = String.fromCharCode(n) + String.fromCharCode(r);
	return BigInt(_A(s, e));
}, _A = (e, t) => {
	let n, r, s, o, u, c, d, f;
	for (n = e.length & 3, r = e.length - n, s = t, u = 3432918353, c = 461845907, f = 0; f < r;) d = e.charCodeAt(f) & 255 | (e.charCodeAt(++f) & 255) << 8 | (e.charCodeAt(++f) & 255) << 16 | (e.charCodeAt(++f) & 255) << 24, ++f, d = (d & 65535) * u + (((d >>> 16) * u & 65535) << 16) & 4294967295, d = d << 15 | d >>> 17, d = (d & 65535) * c + (((d >>> 16) * c & 65535) << 16) & 4294967295, s ^= d, s = s << 13 | s >>> 19, o = (s & 65535) * 5 + (((s >>> 16) * 5 & 65535) << 16) & 4294967295, s = (o & 65535) + 27492 + (((o >>> 16) + 58964 & 65535) << 16);
	switch (d = 0, n) {
		case 3: d ^= (e.charCodeAt(f + 2) & 255) << 16;
		case 2: d ^= (e.charCodeAt(f + 1) & 255) << 8;
		case 1: d ^= e.charCodeAt(f) & 255, d = (d & 65535) * u + (((d >>> 16) * u & 65535) << 16) & 4294967295, d = d << 15 | d >>> 17, d = (d & 65535) * c + (((d >>> 16) * c & 65535) << 16) & 4294967295, s ^= d;
	}
	return s ^= e.length, s ^= s >>> 16, s = (s & 65535) * 2246822507 + (((s >>> 16) * 2246822507 & 65535) << 16) & 4294967295, s ^= s >>> 13, s = (s & 65535) * 3266489909 + (((s >>> 16) * 3266489909 & 65535) << 16) & 4294967295, s ^= s >>> 16, s >>> 0;
}, Vf = (e, t) => AA([
	3077398253,
	3995603712,
	2243735041,
	1261992695
][e], t), BA = (e) => {
	const t = (n) => {
		const r = n & 4294967295n, s = n & 18446744069414584320n;
		return n >= 65536n && n <= 4294967295n ? 65536n + Dy(n - 65536n) : n >= 4294967296n && n <= 18446744073709551615n ? s | t(r) : n;
	};
	return t(e);
}, IA = (e) => {
	const t = (n) => {
		const r = n & 4294967295n, s = n & 18446744069414584320n;
		return n >= 65536n && n <= 4294967295n ? 65536n + by(n - 65536n) : n >= 4294967296n && n <= 18446744073709551615n ? s | t(r) : n;
	};
	return t(BigInt(e));
}, Dy = (e) => wy(4, 65535n, 65536n, 4294967295n, Vf, e), wy = (e, t, n, r, s, o) => {
	const u = sf(e, t, n, s, o);
	return u < r ? u : sf(e, t, n, s, u);
}, sf = (e, t, n, r, s) => {
	const o = (d, f, m) => {
		if (d > e) return e % 2 !== 0 || m === t ? t * m + f : t * f + m;
		{
			const y = BigInt(r(d - 1, m).toString()), w = d % 2 !== 0 ? (f + y) % t : (f + y) % n;
			return o(d + 1, m, w);
		}
	};
	return o(1, s % t, s / t);
}, by = (e) => Ey(4, 65535n, 65536n, 4294967295n, Vf, e), Ey = (e, t, n, r, s, o) => {
	const u = of(e, t, n, s, o);
	return u < r ? u : of(e, t, n, s, u);
}, of = (e, t, n, r, s) => {
	const o = (m, y, w) => {
		if (m < 1) return t * w + y;
		{
			const E = r(m - 1, y), A = m % 2 !== 0 ? (w + t - E % t) % t : (w + n - E % n) % n;
			return o(m - 1, A, y);
		}
	}, u = e % 2 !== 0 ? s / t : s % t, c = e % 2 !== 0 ? s % t : s / t;
	return o(e, c === t ? u : c, c === t ? c : u);
};
var vy = {
	F: Vf,
	fe: sf,
	Fe: wy,
	feis: Dy,
	fein: BA,
	fen: of,
	Fen: Ey,
	tail: by,
	fynd: IA
};
const Sy = /^~([a-z]{3}|([a-z]{6}(\-[a-z]{6}){0,3}(\-(\-[a-z]{6}){4})*))$/;
function kA(e) {
	const t = xy(e), n = (o) => o.toString(2).padStart(8, "0"), r = t.reduce((o, u, c) => c % 2 !== 0 || t.length === 1 ? o + n(Sr.indexOf(u)) : o + n(_s.indexOf(u)), ""), s = BigInt("0b" + r);
	return vy.fynd(s);
}
function RA(e) {
	if (!Sy.test(e) || !NA(e)) return null;
	const t = kA(e);
	return e === Cy(t) ? t : null;
}
function Cy(e) {
	const t = vy.fein(e), n = Math.ceil(t.toString(16).length / 2), r = Math.ceil(t.toString(16).length / 4);
	function s(o, u, c) {
		const d = o & 65535n, f = _s[Number(d >> 8n)], m = Sr[Number(d & 255n)], y = u & 3 ? "-" : u === 0 ? "" : "--", w = f + m + y + c;
		return u === r ? c : s(o >> 16n, u + 1, w);
	}
	return "~" + (n <= 1 ? Sr[Number(t)] : s(t, 0, ""));
}
const TA = `
dozmarbinwansamlitsighidfidlissogdirwacsabwissibrigsoldopmodfoglidhopdardorlorhodfolrintogsilmirholpaslacrovlivdalsatlibtabhanticpidtorbolfosdotlosdilforpilramtirwintadbicdifrocwidbisdasmidloprilnardapmolsanlocnovsitnidtipsicropwitnatpanminritpodmottamtolsavposnapnopsomfinfonbanmorworsipronnorbotwicsocwatdolmagpicdavbidbaltimtasmalligsivtagpadsaldivdactansidfabtarmonranniswolmispallasdismaprabtobrollatlonnodnavfignomnibpagsopralbilhaddocridmocpacravripfaltodtiltinhapmicfanpattaclabmogsimsonpinlomrictapfirhasbosbatpochactidhavsaplindibhosdabbitbarracparloddosbortochilmactomdigfilfasmithobharmighinradmashalraglagfadtopmophabnilnosmilfopfamdatnoldinhatnacrisfotribhocnimlarfitwalrapsarnalmoslandondanladdovrivbacpollaptalpitnambonrostonfodponsovnocsorlavmatmipfip`, PA = `
zodnecbudwessevpersutletfulpensytdurwepserwylsunrypsyxdyrnuphebpeglupdepdysputlughecryttyvsydnexlunmeplutseppesdelsulpedtemledtulmetwenbynhexfebpyldulhetmevruttylwydtepbesdexsefwycburderneppurrysrebdennutsubpetrulsynregtydsupsemwynrecmegnetsecmulnymtevwebsummutnyxrextebfushepbenmuswyxsymselrucdecwexsyrwetdylmynmesdetbetbeltuxtugmyrpelsyptermebsetdutdegtexsurfeltudnuxruxrenwytnubmedlytdusnebrumtynseglyxpunresredfunrevrefmectedrusbexlebduxrynnumpyxrygryxfeptyrtustyclegnemfermertenlusnussyltecmexpubrymtucfyllepdebbermughuttunbylsudpemdevlurdefbusbeprunmelpexdytbyttyplevmylwedducfurfexnulluclennerlexrupnedlecrydlydfenwelnydhusrelrudneshesfetdesretdunlernyrsebhulrylludremlysfynwerrycsugnysnyllyndyndemluxfedsedbecmunlyrtesmudnytbyrsenwegfyrmurtelreptegpecnelnevfes`, _s = /* @__PURE__ */ TA.match(/.{1,3}/g), Sr = /* @__PURE__ */ PA.match(/.{1,3}/g);
function xy(e) {
	return e.replace(/[\^~-]/g, "").match(/.{1,3}/g) || [];
}
function NA(e) {
	const t = xy(e);
	return !(t.length % 2 !== 0 && t.length !== 1) && t.every((n, r) => r % 2 !== 0 || t.length === 1 ? Sr.includes(n) : _s.includes(n));
}
function OA(e) {
	const t = e.toString(16), n = t.length, r = Buffer.from(t.padStart(n + n % 2, "0"), "hex"), s = r.length % 2 !== 0 && r.length > 1 ? [[r[0]]].concat(Ng(Array.from(r.slice(1)), 2)) : Ng(Array.from(r), 2), o = (d) => d[1] === void 0 ? Sr[d[0]] : _s[d[0]] + Sr[d[1]], u = (d) => d[1] === void 0 ? Sr[d[0]] : _s[d[0]] + Sr[d[1]], c = (d) => d.length % 2 !== 0 && s.length > 1 ? o(d) : u(d);
	return s.reduce((d, f) => d + (d === ".~" ? "" : "-") + c(f), ".~");
}
function UA(e) {
	const t = e.slice(2).split("-"), n = (s) => {
		if (s < 0) throw new Error("malformed @q");
		return s.toString(16).padStart(2, "0");
	}, r = t.map((s, o) => {
		let u = $A(3, s);
		return u[1] === "" && o === 0 ? n(Sr.indexOf(u[0])) : n(_s.indexOf(u[0])) + n(Sr.indexOf(u[1]));
	});
	return BigInt("0x" + (e.length === 0 ? "00" : r.join("")));
}
function MA(e) {
	try {
		return UA(e);
	} catch {
		return null;
	}
}
function Ng(e, t) {
	let n = [], r = [n];
	for (let s = 0; s < e.length; s++) n.length < t ? n.push(e[s]) : (n = [e[s]], r.push(n));
	return r;
}
function $A(e, t) {
	return [t.slice(0, e), t.slice(e)];
}
function LA(e, t) {
	return e = Fy(e), zA(t.slice(e.l.length), e.w, e.p);
}
function Ta(e, t) {
	return e = Fy(e), e.l + GA(KA(t, BigInt(e.w), BigInt(e.p)));
}
function Fy(e) {
	return e === "h" ? {
		w: 5,
		p: 10,
		l: ".~~"
	} : e === "s" ? {
		w: 8,
		p: 23,
		l: "."
	} : e === "d" ? {
		w: 11,
		p: 52,
		l: ".~"
	} : e === "q" ? {
		w: 15,
		p: 112,
		l: ".~~~"
	} : e;
}
function Xa(e) {
	return 2n ** e - 1n;
}
function zA(e, t, n) {
	if (e === "nan") return HA(t, n);
	if (e === "inf") return Og(!0, t, n);
	if (e === "-inf") return Og(!1, t, n);
	let r = 0, s = !0;
	e[r] === "-" && (s = !1, r++);
	let o = "";
	for (; e[r] !== "." && e[r] !== "e" && e[r] !== void 0;) o += e[r++];
	e[r] === "." && r++;
	let u = "";
	for (; e[r] !== "e" && e[r] !== void 0;) u += e[r++];
	e[r] === "e" && r++;
	let c = !0;
	e[r] === "-" && (c = !1, r++);
	let d = "";
	for (; e[r] !== void 0;) d += e[r++];
	return BigInt("0b" + qA(t, n, s, o, u, c, Number(d)));
}
function HA(e, t) {
	return Xa(BigInt(e + 1)) << BigInt(t - 1);
}
function Og(e, t, n) {
	return Xa(BigInt(e ? t : t + 1)) << BigInt(n);
}
function qA(e, t, n, r, s, o, u) {
	return u !== 0 && (o ? (r = r + s.padEnd(u, "0").slice(0, u), s = s.slice(u)) : (s = r.padStart(u, "0").slice(-u) + s, r = r.slice(0, -u))), jA(t, e, n, BigInt(r), BigInt(s.length), BigInt(s));
}
function jA(e, t, n, r, s, o) {
	function u(ge) {
		return console.warn(ge), 1;
	}
	const c = 2 ** (t - 1) - 1, d = -c + 1, f = c, m = d - e, y = 2 * c + 1 + e + 3, w = new Array(y), E = 10n ** s;
	var A = 0, B = !n, T, $, V, H, Q, te;
	for (T = y; T; w[--T] = 0);
	for (T = c + 2; r && T; w[--T] = r & 1n, r = r >> 1n);
	for (T = c + 1; o > 0n && T < y; (w[++T] = (o *= 2n) >= E ? 1 : 0) && (o = o - E));
	for (T = -1; ++T < y && !w[T];);
	if (w[($ = e - 1 + (T = (A = c + 1 - T) >= d && A <= f ? T + 1 : c + 1 - (A = d - 1))) + 1]) {
		if (!(V = w[$])) for (H = $ + 2; !V && H < y; V = w[H++]);
		for (H = $ + 1; V && --H >= 0; (w[H] = (w[H] ? 0 : 1) - 0) && (V = 0));
	}
	for (T = T - 2 < 0 ? -1 : T - 3; ++T < y && !w[T];);
	for ((A = c + 1 - T) >= d && A <= f ? ++T : A < d && (A != c + 1 - y && A < m && u("r.construct underflow"), T = c + 1 - (A = d - 1)), r && (u(r ? "r.construct overflow" : "r.construct"), A = f + 1, T = c + 2), te = Math.abs(A + c), H = t + 1, Q = ""; --H; Q = (te & 1) + Q, te = te >>= 1);
	return (B ? "1" : "0") + Q + w.slice(T, T + e).join("");
}
function GA(e) {
	if (e.t === "n") return "nan";
	if (e.t === "i") return e.s ? "inf" : "-inf";
	let t;
	return e.e - 4 > 0 || e.e + 2 < 0 ? t = 1 : (t = e.e + 1, e.e = 0), (e.s ? "" : "-") + WA(t, e.a) + (e.e === 0 ? "" : "e" + e.e.toString());
}
function WA(e, t) {
	const n = Math.abs(e);
	if (e <= 0) return "0." + "".padEnd(n, "0") + t;
	{
		const r = t.length;
		return n >= r ? t + "".padEnd(n - r, "0") : t.slice(0, n) + "." + t.slice(n);
	}
}
function KA(e, t, n) {
	const r = Xa(n), s = Xa(t), o = e & r, u = e >> BigInt(n) & s, c = (e >> BigInt(t + n) & 1n) === 0n;
	let d, f, m, y;
	if (u === s) return o === 0n ? {
		t: "i",
		s: c
	} : { t: "n" };
	u !== 0n ? (d = 1n << BigInt(n) | o, f = u - (2n ** (t - 1n) - 1n) - n, m = Number(n), y = u !== 1n && o === 0n) : (d = o, f = 1n - (2n ** (t - 1n) - 1n) - n, m = d.toString(2).length - 1, y = !1);
	const w = (2n ** n).toString(10).length + 1, E = VA(d, Number(f), m, y, "unique", 0, w);
	return {
		t: "d",
		s: c,
		e: E.outExponent,
		a: E.digits
	};
}
function VA(e, t, n, r, s, o, u) {
	const c = BigInt(t);
	let d = 0, f = new Array(u).fill("0"), m = 0;
	if (e === 0n) return f[0] = "0", m = 0, {
		digits: f.slice(0, 1).join(""),
		outExponent: m
	};
	let y, w, E, A;
	r ? t > 0 ? (w = 4n * e, w <<= c, y = 4n, E = 1n << c, A = 1n << c + 1n) : (w = 4n * e, y = 1n << -c + 2n, E = 1n, A = 2n) : t > 0 ? (w = 2n * e, w <<= c, y = 2n, E = 1n << c, A = E) : (w = 2n * e, y = 1n << BigInt(-t + 1), E = 1n, A = E);
	let T = Math.ceil((n + t) * .3010299956639812 - .69);
	if (T > 0) y *= BigInt(10) ** BigInt(T);
	else if (T < 0) {
		const De = BigInt(10) ** BigInt(-T);
		w *= De, E *= De, A !== E && (A *= E);
	}
	w >= y ? T += 1 : (w *= 10n, E *= 10n, A !== E && (A *= 10n));
	let $ = T - u;
	m = T - 1;
	let V = !1, H = !1, Q = 0;
	for (;;) {
		T -= 1, Q = Number(w / y), w = w % y;
		let De = w + A;
		if (V = w < E, H = De > y, V || H || T === $) break;
		f[d] = String.fromCharCode(48 + Q), d += 1, w *= 10n, E *= 10n, A !== E && (A *= 10n);
	}
	let te = V;
	if (V === H) {
		w *= 2n;
		let De = w < y ? -1 : w > y ? 1 : 0;
		te = De < 0, De === 0 && (te = (Q & 1) === 0);
	}
	if (te) f[d] = String.fromCharCode(48 + Q), d += 1;
	else if (Q === 9) for (;;) {
		if (d === 0) {
			f[d] = "1", d += 1, m += 1;
			break;
		}
		if (d -= 1, f[d] !== "9") {
			f[d] = String.fromCharCode(f[d].charCodeAt(0) + 1), d += 1;
			break;
		}
	}
	else f[d] = String.fromCharCode(48 + Q + 1), d += 1;
	return {
		digits: f.slice(0, d).join(""),
		outExponent: m
	};
}
function Kn(e, t, n, r, s) {
	s === void 0 && (s = !1);
	const o = r === 0 ? t : `${t}${n}{0,${r - 1}}`, u = r === 0 ? `${n}*` : `(\\.${n}{${r}})*`;
	return new RegExp(`^${s ? "\\-\\-?" : ""}${e}(0|${o}${u})$`);
}
function Pa(e) {
	return new RegExp(`^\\.~{${e}}(nan|\\-?(inf|(0|[1-9][0-9]*)(\\.[0-9]+)?(e\\-?(0|[1-9][0-9]*))?))$`);
}
const lt = {
	c: /^~\-((~[0-9a-fA-F]+\.)|(~[~\.])|[0-9a-z\-\._])*$/,
	da: /^~(0|[1-9][0-9]*)\-?\.0*([1-9]|1[0-2])\.0*[1-9][0-9]*(\.\.([0-9]+)\.([0-9]+)\.([0-9]+)(\.(\.[0-9a-f]{4})+)?)?$/,
	dr: /^~((d|h|m|s)(0|[1-9][0-9]*))(\.(d|h|m|s)(0|[1-9][0-9]*))*(\.(\.[0-9a-f]{4})+)?$/,
	f: /^\.(y|n)$/,
	if: /^(\.(0|[1-9][0-9]{0,2})){4}$/,
	is: /^(\.(0|[1-9a-fA-F][0-9a-fA-F]{0,3})){8}$/,
	n: /^~$/,
	p: Sy,
	q: /^\.~(([a-z]{3}|[a-z]{6})(\-[a-z]{6})*)$/,
	rd: /* @__PURE__ */ Pa(1),
	rh: /* @__PURE__ */ Pa(2),
	rq: /* @__PURE__ */ Pa(3),
	rs: /* @__PURE__ */ Pa(0),
	sb: /* @__PURE__ */ Kn("0b", "1", "[01]", 4, !0),
	sd: /* @__PURE__ */ Kn("", "[1-9]", "[0-9]", 3, !0),
	si: /* @__PURE__ */ Kn("0i", "[1-9]", "[0-9]", 0, !0),
	sv: /* @__PURE__ */ Kn("0v", "[1-9a-v]", "[0-9a-v]", 5, !0),
	sw: /* @__PURE__ */ Kn("0w", "[1-9a-zA-Z~-]", "[0-9a-zA-Z~-]", 5, !0),
	sx: /* @__PURE__ */ Kn("0x", "[1-9a-f]", "[0-9a-f]", 4, !0),
	t: /^~~((~[0-9a-fA-F]+\.)|(~[~\.])|[0-9a-z\-\._])*$/,
	ta: /^~\.[0-9a-z\-\.~_]*$/,
	tas: /^[a-z][a-z0-9\-]*$/,
	ub: /* @__PURE__ */ Kn("0b", "1", "[01]", 4),
	ud: /* @__PURE__ */ Kn("", "[1-9]", "[0-9]", 3),
	ui: /* @__PURE__ */ Kn("0i", "[1-9]", "[0-9]", 0),
	uv: /* @__PURE__ */ Kn("0v", "[1-9a-v]", "[0-9a-v]", 5),
	uw: /* @__PURE__ */ Kn("0w", "[1-9a-zA-Z~-]", "[0-9a-zA-Z~-]", 5),
	ux: /* @__PURE__ */ Kn("0x", "[1-9a-f]", "[0-9a-f]", 4)
}, Zf = ZA;
function ZA(e, t) {
	const n = Ay(e, t);
	if (!n) throw new Error("slav: failed to parse @" + e + " from string: " + t);
	return n;
}
function Ay(e, t) {
	if (e in lt && !lt[e].test(t)) return null;
	const n = _y(t);
	return n && n.type === "dime" && n.aura === e ? n.atom : null;
}
function _y(e) {
	if (e === "") return null;
	const t = e[0];
	if (t >= "a" && t <= "z") return lt.tas.test(e) ? {
		type: "dime",
		aura: "tas",
		atom: Na(e)
	} : null;
	if (t >= "0" && t <= "9") {
		const n = Ug(e);
		return n ? {
			type: "dime",
			...n
		} : null;
	} else if (t === "-") {
		let n = !0;
		e[1] == "-" ? e = e.slice(2) : (e = e.slice(1), n = !1);
		const r = Ug(e);
		return r ? (n ? r.atom = 2n * r.atom : r.atom !== 0n && (r.atom = 1n + 2n * (r.atom - 1n)), {
			type: "dime",
			aura: r.aura.replace("u", "s"),
			atom: r.atom
		}) : null;
	} else if (t === ".") {
		if (e === ".y") return {
			type: "dime",
			aura: "f",
			atom: 0n
		};
		if (e === ".n") return {
			type: "dime",
			aura: "f",
			atom: 1n
		};
		if (lt.is.test(e)) {
			const n = e.slice(1).split(".").reduce((r, s) => r + s.padStart(4, "0"), "");
			return {
				type: "dime",
				aura: "is",
				atom: BigInt("0x" + n)
			};
		} else {
			if (lt.if.test(e)) return {
				type: "dime",
				aura: "if",
				atom: e.slice(1).split(".").reduce((r, s, o) => r + (BigInt(s) << BigInt(8 * (3 - o))), 0n)
			};
			if (e[1] === "~" && (lt.rd.test(e) || lt.rh.test(e) || lt.rq.test(e)) || lt.rs.test(e)) {
				let n = 0;
				for (; e[n + 1] === "~";) n++;
				let r;
				switch (n) {
					case 0:
						r = "rs";
						break;
					case 1:
						r = "rd";
						break;
					case 2:
						r = "rh";
						break;
					case 3:
						r = "rq";
						break;
					default: throw new Error("parsing invalid @r*");
				}
				return {
					type: "dime",
					aura: r,
					atom: LA(r[1], e)
				};
			} else if (e[1] === "~" && lt.q.test(e)) {
				const n = MA(e);
				return n === null ? null : {
					type: "dime",
					aura: "q",
					atom: n
				};
			} else if (e[1] === "_" && /^\.(_([0-9a-zA-Z\-\.]|~\-|~~)+)*__$/.test(e)) {
				const n = e.slice(1, -2).split("_").slice(1).map((r) => (r = r.replaceAll("~-", "_").replaceAll("~~", "~"), _y(r)));
				return n.some((r) => r === null) ? null : {
					type: "many",
					list: n
				};
			}
		}
		return null;
	} else if (t === "~") {
		if (e === "~") return {
			type: "dime",
			aura: "n",
			atom: 0n
		};
		if (lt.da.test(e)) return {
			type: "dime",
			aura: "da",
			atom: DA(e)
		};
		if (lt.dr.test(e)) return {
			type: "dime",
			aura: "dr",
			atom: wA(e)
		};
		if (lt.p.test(e)) {
			const n = RA(e);
			return n === null ? null : {
				type: "dime",
				aura: "p",
				atom: n
			};
		} else {
			if (e[1] === "." && lt.ta.test(e)) return {
				type: "dime",
				aura: "ta",
				atom: Na(e.slice(2))
			};
			if (e[1] === "~" && lt.t.test(e)) return {
				type: "dime",
				aura: "t",
				atom: Na(Mg(e.slice(2)))
			};
			if (e[1] === "-" && lt.c.test(e)) return /^~\-~[0-9a-f]+\.$/.test(e) ? {
				type: "dime",
				aura: "c",
				atom: BigInt("0x" + e.slice(3, -1))
			} : {
				type: "dime",
				aura: "c",
				atom: Na(Mg(e.slice(2)))
			};
		}
		return e[1] === "0" && /^~0[0-9a-v]+$/.test(e) ? {
			type: "blob",
			jam: af(5, By, e.slice(2))
		} : null;
	}
	return null;
}
function Ug(e) {
	switch (e.slice(0, 2)) {
		case "0b": return lt.ub.test(e) ? {
			aura: "ub",
			atom: BigInt(e.replaceAll(".", ""))
		} : null;
		case "0c": return console.log("aura-js: @uc parsing unsupported (bisk)"), null;
		case "0i": return lt.ui.test(e) ? {
			aura: "ui",
			atom: BigInt(e.slice(2))
		} : null;
		case "0x": return lt.ux.test(e) ? {
			aura: "ux",
			atom: BigInt(e.replaceAll(".", ""))
		} : null;
		case "0v": return lt.uv.test(e) ? {
			aura: "uv",
			atom: af(5, By, e.slice(2))
		} : null;
		case "0w": return lt.uw.test(e) ? {
			aura: "uw",
			atom: af(6, XA, e.slice(2))
		} : null;
		default: return lt.ud.test(e) ? {
			aura: "ud",
			atom: BigInt(e.replaceAll(".", ""))
		} : null;
	}
}
function Mg(e) {
	let t = "", n = 0;
	for (; n < e.length;) switch (e[n]) {
		case ".":
			t = t + " ", n++;
			continue;
		case "~": switch (e[++n]) {
			case "~":
				t = t + "~", n++;
				continue;
			case ".":
				t = t + ".", n++;
				continue;
			default:
				let r = 0;
				do
					r = r << 4 | Number.parseInt(e[n++], 16);
				while (e[n] !== ".");
				t = t + String.fromCodePoint(r), n++;
				continue;
		}
		default:
			t = t + e[n++];
			continue;
	}
	return t;
}
function Na(e) {
	return YA(new TextEncoder().encode(e));
}
const XA = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-~", By = "0123456789abcdefghijklmnopqrstuv";
function af(e, t, n) {
	let r = 0n;
	const s = BigInt(e);
	for (; n !== "";) n[0] !== "." && (r = (r << s) + BigInt(t.indexOf(n[0]))), n = n.slice(1);
	return r;
}
function YA(e) {
	if (e.length === 0) return 0n;
	if (typeof Buffer < "u") return BigInt("0x" + Buffer.from(e.reverse()).toString("hex"));
	let t, n = [];
	for (var r = e.length - 1; r >= 0; --r) t = e[r], n.push(t < 16 ? "0" + t.toString(16) : t.toString(16));
	return BigInt("0x" + n.join(""));
}
const Wt = QA;
function QA(e, t) {
	return uf({
		type: "dime",
		aura: e,
		atom: t
	});
}
function uf(e) {
	switch (e.type) {
		case "blob": return "~0" + e.jam.toString(32);
		case "many": return "." + e.list.reduce((t, n) => t + "_" + n2(uf(n)), "") + "__";
		case "dime": switch (e.aura[0]) {
			case "c": return e.atom < 127n ? "~-" + $g(String.fromCharCode(Number(e.atom))) : "~-~" + e.atom.toString(16) + ".";
			case "d": switch (e.aura[1]) {
				case "a": return bA(e.atom);
				case "r": return EA(e.atom);
				default: return io(e.atom);
			}
			case "f": switch (e.atom) {
				case 0n: return ".y";
				case 1n: return ".n";
				default: return io(e.atom);
			}
			case "n": return "~";
			case "i": switch (e.aura[1]) {
				case "f": return "." + Lg(e.atom, 1, 4, 10);
				case "s": return "." + Lg(e.atom, 2, 8, 16);
				default: return io(e.atom);
			}
			case "p": return Cy(e.atom);
			case "q": return OA(e.atom);
			case "r": switch (e.aura[1]) {
				case "d": return Ta("d", e.atom);
				case "h": return Ta("h", e.atom);
				case "q": return Ta("q", e.atom);
				case "s": return Ta("s", e.atom);
				default: return io(e.atom);
			}
			case "u": switch (e.aura[1]) {
				case "c": throw new Error("aura-js: @uc rendering unsupported");
				case "b": return "0b" + so(e.atom.toString(2), 4);
				case "i": return "0i" + e2(1, e.atom);
				case "x": return "0x" + so(e.atom.toString(16), 4);
				case "v": return "0v" + so(e.atom.toString(32), 5);
				case "w": return "0w" + so(i2(6, r2, e.atom), 5);
				default: return so(e.atom.toString(10), 3);
			}
			case "s":
				const t = e.atom & 1n;
				return e.atom = t + (e.atom >> 1n), e.aura = e.aura.replace("s", "u"), (t === 0n ? "--" : "-") + uf(e);
			case "t": return e.aura[1] === "a" ? e.aura[2] === "s" ? el(e.atom) : "~." + el(e.atom) : "~~" + $g(el(e.atom));
			default: return io(e.atom);
		}
	}
}
function e2(e, t) {
	return t.toString(10).padStart(e, "0");
}
function t2(e, t) {
	return t.toString(16).padStart(e, "0");
}
function io(e) {
	return "0x" + t2(1, e);
}
function n2(e) {
	return e.replaceAll("~", "~~").replaceAll("_", "~-");
}
function $g(e) {
	let t = "";
	for (let n = 0; n < e.length; n += 1) {
		const r = e[n];
		let s = "";
		switch (r) {
			case " ":
				s = ".";
				break;
			case ".":
				s = "~.";
				break;
			case "~":
				s = "~~";
				break;
			default: {
				const o = e.codePointAt(n);
				if (!o) break;
				o > 65535 && (n += 1), o >= 97 && o <= 122 || o >= 48 && o <= 57 || r === "-" ? s = r : s = `~${o.toString(16)}.`;
			}
		}
		t += s;
	}
	return t;
}
const r2 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-~";
function i2(e, t, n) {
	if (n === 0n) return t[0];
	let r = "";
	const s = BigInt(e);
	for (; n !== 0n;) r = t[Number(BigInt.asUintN(e, n))] + r, n = n >> s;
	return r;
}
function so(e, t) {
	return e.replace(new RegExp(`(?=(?:.{${t}})+$)(?!^)`, "g"), ".");
}
function Lg(e, t, n, r) {
	r === void 0 && (r = 10);
	let s = "";
	const o = 8n * BigInt(t), u = (1n << o) - 1n;
	for (; n-- > 0;) s !== "" && (s = "." + s), s = (e & u).toString(r) + s, e = e >> o;
	return s;
}
function el(e) {
	return new TextDecoder("utf-8").decode(s2(e).reverse());
}
function s2(e) {
	if (e === 0n) return new Uint8Array(0);
	const t = e.toString(16), n = t.length % 2 === 0 ? t : "0" + t, r = n.length / 2, s = new Uint8Array(r);
	for (let o = 0; o < n.length; o += 2) {
		const u = n.slice(o, o + 2), c = parseInt(u, 16) << 24 >> 24;
		s[o / 2] = c;
	}
	return s;
}
const ur = {
	toUnix: vA,
	fromUnix: SA
};
function Ya(e) {
	const t = e.toString(16), n = t.length % 2 === 0 ? t : "0" + t, r = n.length / 2, s = new Uint8Array(r);
	for (let o = 0; o < n.length; o += 2) {
		const u = n.slice(o, o + 2), c = parseInt(u, 16) << 24 >> 24;
		s[o / 2] = c;
	}
	return s;
}
const Oa = [], Ua = [], zg = [];
let oo = 0;
function Co(e) {
	if (e === 0n) return 0;
	let t = 0;
	for (; oo === t && (Oa.push(32 << oo), Ua.push(BigInt(Oa[oo])), zg.push(1n << Ua[oo]), oo++), !(e < zg[t]);) t++;
	if (!t) return 32 - Math.clz32(Number(e));
	t--;
	let n = Oa[t], r = e >> Ua[t];
	for (; t--;) {
		let s = r >> Ua[t];
		s && (n += Oa[t], r = s);
	}
	return n + 32 - Math.clz32(Number(r));
}
function o2(e, t) {
	return (e & BigInt(1) << BigInt(t)) !== BigInt(0);
}
function Jf(e, t) {
	if (t === 16) return BigInt("0x" + (e || "0"));
	if (t === 10) return BigInt(e || "0");
	let n = BigInt(0);
	const r = BigInt(t), s = e.length;
	for (let o = 0; o < s; o++) {
		const u = parseInt(e.charAt(o), t);
		if (isNaN(u)) throw new Error(`Invalid character for radix ${t}: '${e.charAt(o)}'`);
		n = n * r + BigInt(u);
	}
	return n;
}
function a2(e, t, n) {
	let r, s, o, u, c, d, f, m, y;
	if (t === 0n ? (y = new Uint8Array(0), e = e || 0) : (y = Ya(t), e = e || y.length), y.length < e) {
		const w = new Uint8Array(e - y.length), E = new Uint8Array(y.length + w.length);
		E.set(w), E.set(y, w.length), y = E;
	} else if (y.length > e) throw new Error("murmur3 oversized key for length");
	for (y.reverse(), r = y.length & 3, s = y.length - r, o = n, c = 3432918353, d = 461845907, m = 0; m < s;) f = y[m] & 255 | (y[++m] & 255) << 8 | (y[++m] & 255) << 16 | (y[++m] & 255) << 24, ++m, f = (f & 65535) * c + (((f >>> 16) * c & 65535) << 16) & 4294967295, f = f << 15 | f >>> 17, f = (f & 65535) * d + (((f >>> 16) * d & 65535) << 16) & 4294967295, o ^= f, o = o << 13 | o >>> 19, u = (o & 65535) * 5 + (((o >>> 16) * 5 & 65535) << 16) & 4294967295, o = (u & 65535) + 27492 + (((u >>> 16) + 58964 & 65535) << 16);
	switch (f = 0, r) {
		case 3: f ^= (y[m + 2] & 255) << 16;
		case 2: f ^= (y[m + 1] & 255) << 8;
		case 1: f ^= y[m] & 255, f = (f & 65535) * c + (((f >>> 16) * c & 65535) << 16) & 4294967295, f = f << 15 | f >>> 17, f = (f & 65535) * d + (((f >>> 16) * d & 65535) << 16) & 4294967295, o ^= f;
	}
	return o ^= y.length, o ^= o >>> 16, o = (o & 65535) * 2246822507 + (((o >>> 16) * 2246822507 & 65535) << 16) & 4294967295, o ^= o >>> 13, o = (o & 65535) * 3266489909 + (((o >>> 16) * 3266489909 & 65535) << 16) & 4294967295, o ^= o >>> 16, o >>> 0;
}
function mt() {
	for (var e = arguments.length, t = new Array(e), n = 0; n < e; n++) t[n] = arguments[n];
	const r = t.length === 1 ? t[0] : t;
	if (h2(r)) return r;
	if (typeof r == "number") return Y.fromInt(r);
	if (typeof r == "bigint") return new Y(r);
	if (typeof r == "string") return Y.fromCord(r);
	if (Array.isArray(r)) {
		if (r.length < 2) return mt(r[0]);
		let c = new ze(mt(r[r.length - 2]), mt(r[r.length - 1]));
		for (var s = r.length - 3; s >= 0; --s) c = new ze(mt(r[s]), c);
		return c;
	} else if (r === null) return Y.zero;
	throw console.error("what do you mean??", typeof r, JSON.stringify(r)), /* @__PURE__ */ new Error("dwim, but meaning unclear");
}
function u2(e) {
	return e.length === 0 ? Y.zero : mt([...e, Y.zero]);
}
function c2(e) {
	if (e.length === 0) return Y.zero;
	let t = Y.zero;
	for (let n of e) t = cf(t, mt(n));
	return t;
}
function l2(e) {
	if (e.length === 0) return Y.zero;
	let t = Y.zero;
	for (let n of e) t = lf(t, mt(n.key), mt(n.val));
	return t;
}
const Xf = {
	nounify: mt,
	dwim: mt,
	list: u2,
	set: c2,
	map: l2
};
function Iy(e, t, n) {
	let r = 0;
	for (; r < 8;) {
		const s = a2(null, n, e), o = s >>> 31 ^ s & 2147483647;
		if (o !== 0) return o;
		r++, e++;
	}
	return t;
}
function Qa(e, t) {
	return e.equals(t) ? !0 : e.isCell() ? t.isAtom() ? !1 : e.head.equals(t.head) ? Qa(e.tail, t.tail) : Qa(e.head, t.head) : t.isCell() ? !0 : e < t;
}
function ky(e, t) {
	const n = e.mug(), r = t.mug();
	return n === r ? Qa(e, t) : n < r;
}
function eu(e, t) {
	const n = Y.fromInt(e.mug()).mug(), r = Y.fromInt(t.mug()).mug();
	return n === r ? Qa(e, t) : n < r;
}
function tl(e) {
	return e.isCell() && e.tail.isCell();
}
function cf(e, t) {
	if (e.equals(Y.zero)) return mt(t, null, null);
	if (!tl(e)) throw new Error("malformed set");
	if (t.equals(e.head)) return e;
	if (ky(t, e.head)) {
		const r = cf(e.tail.head, t);
		if (!tl(r)) throw new Error("implementation error");
		return eu(e.head, r.head) ? mt(e.head, r, e.tail.tail) : mt(r.head, r.tail.head, [
			e.head,
			r.tail.tail,
			e.tail.tail
		]);
	}
	const n = cf(e.tail.tail, t);
	if (!tl(n)) throw new Error("implementation error");
	return eu(e.head, n.head) ? mt(e.head, e.tail.head, n) : mt(n.head, [
		e.head,
		e.tail.head,
		n.tail.head
	], n.tail.tail);
}
function nl(e) {
	return e.isCell() && e.head.isCell() && e.tail.isCell();
}
function lf(e, t, n) {
	if (e.equals(Y.zero)) return mt([t, n], null, null);
	if (!nl(e)) throw new Error("malformed map");
	if (t.equals(e.head.head)) return n.equals(e.head.tail) ? e : mt([t, n], e.tail);
	if (ky(t, e.head.head)) {
		const s = lf(e.tail.head, t, n);
		if (!nl(s)) throw new Error("implementation error");
		return eu(e.head.head, s.head.head) ? mt(e.head, s, e.tail.tail) : mt(s.head, s.tail.head, [
			e.head,
			s.tail.tail,
			e.tail.tail
		]);
	}
	const r = lf(e.tail.tail, t, n);
	if (!nl(r)) throw new Error("implementation error");
	return eu(e.head.head, r.head.head) ? mt(e.head, e.tail.head, r) : mt(r.head, [
		e.head,
		e.tail.head,
		r.tail.head
	], r.tail.tail);
}
var Os;
const rl = {
	0: function(e) {
		throw new Error("Bail");
	},
	1: function(e) {
		return e;
	}
};
var Y = class Y {
	constructor(t) {
		this.number = void 0, this._mug = 0, this.deep = !1, this.number = t;
	}
	isAtom() {
		return !0;
	}
	isCell() {
		return !1;
	}
	pretty(t, n) {
		if (this.number < 65536n) t.push(this.number.toString(10));
		else {
			let r = [], s = !0, o = !0, u = Ya(this.number);
			for (let c = u.length - 1; c >= 0; --c) {
				const d = u[c];
				if (s && (d < 32 || d > 127)) {
					s = !1, o = !1;
					break;
				} else o && !(d > 47 && d < 58 || d > 96 && d < 123 || d === 45) && (o = !1);
				r.push(String.fromCharCode(d));
			}
			o ? (t.push("%"), t.push.apply(t, r)) : s ? (t.push("'"), t.push.apply(t, r), t.push("'")) : (t.push("0x"), t.push(this.number.toString(16)));
		}
	}
	toString() {
		const t = [];
		return this.pretty(t, !1), t.join("");
	}
	equals(t) {
		return t instanceof Y && t.number === this.number;
	}
	loob() {
		if (Number(this.number) === 0) return !0;
		if (Number(this.number) === 1) return !1;
		throw new Error("Bail");
	}
	mug() {
		return this._mug === 0 && (this._mug = this.calculateMug()), this._mug;
	}
	calculateMug() {
		return Iy(3405691582, 32767, this.number);
	}
	mugged() {
		return this._mug !== 0;
	}
	at(t) {
		return Y.fragmenter(t)(this);
	}
	bump() {
		return new Y(this.number + 1n);
	}
	bytes() {
		const t = Ya(this.number), n = [];
		for (var r = t.length - 1; r >= 0; --r) n.push(t[r] & 255);
		return n;
	}
	cap() {
		if (Number(this.number) === 0) throw new Error("Bail");
		if (Number(this.number) === 1) throw new Error("Bail");
		return o2(this.number, Co(this.number) - 2) ? new Y(3n) : new Y(2n);
	}
	mas() {
		if (Number(this.number) === 0) throw new Error("Bail");
		if (Number(this.number) === 1) throw new Error("Bail");
		if (Number(this.number) === 2) return new Y(1n);
		if (Number(this.number) === 3) return new Y(1n);
		{
			const t = this.number, n = Co(t) - 2, r = BigInt(1 << n);
			return new Y(t & BigInt((1 << n) - 1) ^ r);
		}
	}
	shortCode() {
		return this.number.toString(36);
	}
	static cordToString(t) {
		const n = t.bytes(), r = [];
		for (let s = 0; s < n.length; ++s) r.push(String.fromCharCode(n[s]));
		return r.join("");
	}
	static fragmenter(t) {
		const n = t.shortCode();
		if (rl.hasOwnProperty(n)) return rl[n];
		for (var r = ["a"]; !Y.one.equals(t); t = t.mas()) r.push(Y.two.equals(t.cap()) ? "head" : "tail");
		return rl[n] = new Function("a", "return " + r.join(".") + ";");
	}
	static fromString(t, n) {
		n === void 0 && (n = 10);
		return new Y(Jf(t, n));
	}
	static fromInt(t) {
		return t < 256 ? Y.small[t] : new Y(BigInt(t));
	}
	static fromCord(t) {
		if (t.length === 0) return Y.zero;
		let n, r, s = Array(t.length);
		for (n = 0, r = s.length - 1; n < s.length; ++n, --r) {
			const o = (t.charCodeAt(n) & 255).toString(16);
			s[r] = o.length === 1 ? "0" + o : o;
		}
		return t.length > 4 ? Y.fromString(s.join(""), 16) : new Y(BigInt(parseInt(s.join(""), 16)));
	}
};
Os = Y;
Y.small = /* @__PURE__ */ Array.from(Array(256)).map(function(e, t) {
	return new Os(BigInt(t));
});
Y.zero = Os.small[0];
Y.one = Os.small[1];
Y.two = Os.small[2];
Y.three = Os.small[3];
var ze = class ze {
	constructor(t, n, r) {
		r === void 0 && (r = !0), this.head = void 0, this.tail = void 0, this.deep = void 0, this._mug = 0, this.head = t, this.tail = n, this.deep = r;
	}
	isAtom() {
		return !1;
	}
	isCell() {
		return !0;
	}
	pretty(t, n) {
		n || t.push("["), this.head.pretty(t, !1), t.push(" "), this.tail.pretty(t, !0), n || t.push("]");
	}
	toString() {
		const t = [];
		return this.pretty(t, !1), t.join("");
	}
	mug() {
		return this._mug === 0 && (this._mug = this.calculateMug()), this._mug;
	}
	calculateMug() {
		return Iy(3735928559, 65534, BigInt(this.tail.mug()) << 32n | BigInt(this.head.mug()));
	}
	mugged() {
		return this._mug !== 0;
	}
	equals(t) {
		return t instanceof ze ? this.unify(t) : !1;
	}
	bump() {
		throw new Error("Bail");
	}
	loob() {
		throw new Error("Bail");
	}
	at(t) {
		return Y.fragmenter(t)(this);
	}
	unify(t) {
		if (this === t) return !0;
		if (t.mugged()) if (this.mugged()) {
			if (this.mug() != t.mug()) return !1;
		} else return t.unify(this);
		return this.head.equals(t.head) && (t.head = this.head, this.tail.equals(t.tail)) ? (t._mug = this._mug, t.tail = this.tail, !0) : !1;
	}
};
function f2(e) {
	return e instanceof Y;
}
function d2(e) {
	return e instanceof ze;
}
function h2(e) {
	return f2(e) || d2(e);
}
const ff = function(e) {
	return function(t) {
		if (t instanceof ze) {
			if (!(t.tail instanceof ze)) throw new Error("tree: malformed");
			return [
				...ff(e)(t.tail.tail),
				e(t.head),
				...ff(e)(t.tail.head)
			];
		}
		return [];
	};
};
function xo(e, t) {
	var n = Co(t.number), r = n >>> e;
	return r << e !== n ? r + 1 : r;
}
function Is(e, t) {
	return e.number > t.number;
}
function F2(e, t) {
	return e.number < t.number;
}
function A2(e, t) {
	return e.number >= t.number;
}
function _2(e, t) {
	return e.number <= t.number;
}
function B2(e, t) {
	return new Y(e.number + t.number);
}
function Py(e, t) {
	var n = e.number - t.number;
	if (n < 0) throw new Error("subtract underflow");
	return new Y(n);
}
function I2(e) {
	return Py(e, Y.one);
}
function k2(e) {
	return new Y(1n << e.number);
}
function R2(e, t, n) {
	var r = Number(t.number << e.number);
	return new Y(n.number << BigInt(r));
}
function T2(e, t, n) {
	var r = t.number << e.number;
	return new Y(n.number >> BigInt(r));
}
function Ny(e) {
	var t = e.length, n = t % 4;
	let r, s, o;
	if (n > 0) for (t += 4 - n, r = 0; r < n; ++r) e.push(0);
	const u = t >> 2, c = new Array(u);
	for (r = 0, s = 0; r < u; ++r) o = e[s++] << 0 & 255, o ^= e[s++] << 8 & 65280, o ^= e[s++] << 16 & 16711680, o ^= e[s++] << 24 & 4278190080, c[r] = o;
	return c;
}
function Oy(e) {
	const t = [];
	let n, r, s;
	for (r = 0, s = 0; r < e.length; ++r) n = e[r], t[s++] = 255 & (n & 255), t[s++] = 255 & (n & 65280) >>> 8, t[s++] = 255 & (n & 16711680) >>> 16, t[s++] = 255 & (n & 4278190080) >>> 24;
	for (; t[--s] === 0;) t.pop();
	return t;
}
function Uy(e) {
	let t, n = [];
	for (var r = e.length - 1; r >= 0; --r) t = e[r] & 255, n.push(t < 16 ? "0" + t.toString(16) : t.toString(16));
	return new Y(Jf(n.join(""), 16));
}
function My(e) {
	return e.bytes();
}
function $y(e) {
	return Ny(My(e));
}
function Ly(e) {
	return Uy(Oy(e));
}
var bu = Ly;
function Eu(e, t) {
	return new Array((t << e) + 31 >>> 5);
}
function Fo(e, t, n, r, s, o) {
	var u = $y(o), c = u.length, d, f, A, m, y, w, E, A, B, T, $, V, H, Q, te;
	if (e < 5) for (A = 1 << e, m = (1 << A) - 1, y = t << e, w = r << e, d = 0; d < n; ++d) $ = y >>> 5, V = y & 31, H = w >>> 5, Q = w & 31, te = $ >= c ? 0 : u[$], te = te >>> V & m, s[H] ^= te << Q, y += A, w += A;
	else for (E = e - 5, A = 1 << E, d = 0; d < n; ++d) for (B = t + d << E, T = r + d << E, f = 0; f < A; ++f) s[T + f] ^= B + f >= c ? 0 : u[B + f];
}
function P2(e, t, n, r) {
	if (e.number === 0n) return new Y(r.number >> t.number & (1n << n.number) - 1n);
	var s = Number(e.number), o = Number(t.number), u = Number(n.number), c = xo(s, r);
	if (Y.zero.equals(n) || o >= c) return Y.zero;
	if (o + u > c && (u = c - Number(t.number)), o === 0 && u === c) return r;
	var d = Eu(s, u);
	return Fo(s, o, u, 0, d, r), bu(d);
}
const zy = /* @__PURE__ */ Y.fromInt(4294967295), Qf = /* @__PURE__ */ Y.fromInt(32);
function N2(e, t, n) {
	if (Is(e, Qf)) throw new Error("Fail");
	if (Is(t, zy)) return n;
	var r = Number(e.number), s = Number(t.number), o = xo(r, n);
	if (s === 0) return Y.zero;
	if (s >= o) return n;
	var u = Eu(r, s);
	return Fo(r, 0, s, 0, u, n), bu(u);
}
function O2(e, t) {
	return new Y(e.number ^ t.number);
}
function U2(e, t, n) {
	if (Is(e, Qf)) throw new Error("Fail");
	var r = Number(e.number), s = xo(r, t), o = xo(r, n), u = s + o;
	if (u === 0) return Y.zero;
	{
		const c = Eu(r, u);
		return Fo(r, 0, s, 0, c, t), Fo(r, 0, o, s, c, n), bu(c);
	}
}
function M2(e, t) {
	if (Is(e, Qf)) throw new Error("Fail");
	{
		let r = Number(e.number), s = 0, o = t, u, c, d, f;
		for (; !Y.zero.equals(o);) {
			if (o instanceof Y) throw new Error("Fail");
			if (c = o.head, c instanceof Y) throw new Error("Fail");
			if (c instanceof ze && (d = c.head, f = c.tail), d instanceof Y && Is(d, zy)) throw new Error("Fail");
			if (f instanceof ze) throw new Error("Fail");
			d instanceof Y && (s += Number(d.number)), o instanceof ze && (o = o.tail);
		}
		if (s === 0) return Y.zero;
		var n = Eu(r, s);
		for (o = t, u = 0; !Y.zero.equals(o);) o instanceof ze && (c = o.head), c instanceof ze && (c.head instanceof Y && (d = Number(c.head.number)), f = c.tail, Fo(r, 0, d, u, n, f), u += d, o instanceof ze && (o = o.tail));
		return bu(n);
	}
}
var ft = {
	met: xo,
	cut: P2,
	add: B2,
	sub: Py,
	dec: I2,
	gth: Is,
	lth: F2,
	gte: A2,
	lte: _2,
	bex: k2,
	lsh: R2,
	rsh: T2,
	end: N2,
	mix: O2,
	cat: U2,
	can: M2,
	bytesToWords: Ny,
	wordsToBytes: Oy,
	bytesToAtom: Uy,
	atomToBytes: My,
	atomToWords: $y,
	wordsToAtom: Ly
};
const Cr = Xf.dwim;
function $2(e) {
	for (var t = Y.zero;;) {
		if (Y.zero.equals(e)) return t;
		if (e instanceof Y) throw new Error("Bail");
		t = new ze(e.head, t), e = e.tail;
	}
}
function L2(e, t) {
	for (;;) {
		if (Y.zero.equals(e)) return;
		if (e instanceof Y) throw new Error("Bail");
		t(e.head), e = e.tail;
	}
}
var z2 = {
	flop: $2,
	forEach: L2
};
var ed = class {};
let H2 = class extends ed {
	constructor() {
		super(), this.slots = void 0, this.slots = Array(32);
	}
	insert(t, n, r, s) {
		r -= 5;
		const o = s >>> r;
		return s &= (1 << r) - 1, this.slots[o] = this.slots[o] === void 0 ? new td(t, n) : this.slots[o].insert(t, n, r, s), this;
	}
	get(t, n, r) {
		n -= 5;
		const s = r >>> n;
		r &= (1 << n) - 1;
		const o = this.slots[s];
		return o === void 0 ? void 0 : o.get(t, n, r);
	}
};
var q2 = class extends ed {
	constructor() {
		super(), this.singles = void 0, this.singles = [];
	}
	insert(t, n, r, s) {
		const o = this.singles;
		for (var u = 0; u < o.length; ++u) {
			const c = o[u];
			if (c.key.equals(t)) return c.val = n, this;
		}
		return o.push(new td(t, n)), this;
	}
	get(t) {
		const n = this.singles;
		for (var r = 0; r < n.length; ++r) {
			const s = n[r];
			if (s.key.equals(t)) return s.val;
		}
	}
};
var td = class extends ed {
	constructor(t, n) {
		super(), this.key = void 0, this.val = void 0, this.key = t, this.val = n;
	}
	insert(t, n, r, s) {
		if (this.key.equals(t)) return this.val = n, this;
		{
			const o = this.key.mug() & (1 << r) - 1, u = r > 0 ? new H2() : new q2();
			return u.insert(this.key, this.val, r, o), u.insert(t, n, r, s), u;
		}
	}
	get(t) {
		if (this.key.equals(t)) return this.val;
	}
};
var j2 = class {
	constructor() {
		this.slots = void 0, this.slots = Array(64);
	}
	insert(t, n) {
		const r = t.mug(), s = r >>> 25, o = this.slots;
		if (o[s] === void 0) o[s] = new td(t, n);
		else {
			var u = r & 33554431;
			o[s] = o[s].insert(t, n, 25, u);
		}
	}
	get(t) {
		const n = t.mug(), r = n >>> 25, s = this.slots[r];
		if (s !== void 0) {
			var o = n & 33554431;
			return s.get(t, 25, o);
		}
	}
};
function Hy(e) {
	if (e.length === 1) return BigInt(e[0]);
	let t, n = [];
	for (var r = e.length - 1; r >= 0; --r) t = e[r] & 255, n.push(t.toString(16).padStart(2, "0"));
	return Jf(n.join(""), 16);
}
function G2(e) {
	return new DataView(new Uint8Array(Ya(e).reverse()).buffer);
}
function tu(e, t) {
	const n = Math.floor(e / 8);
	return t.getUint8(n) >> e % 8 & 1;
}
function W2(e) {
	const t = e.byteLength - 1;
	if (t > 2 ** 49) throw new Error("bail: oversized byte buffer");
	return t * 8 + e.getUint8(t).toString(2).length;
}
function Hg(e, t, n) {
	if (t === 1) return tu(e, n) ? 1n : 0n;
	const r = e % 8;
	if (r === 0) return K2(e, t, n);
	const s = [];
	let o = Math.floor(e / 8);
	const u = 8 - r, c = r, d = 255 >> 8 - c;
	for (; t >= 8;) {
		const f = n.getUint8(o), y = (n.getUint8(o + 1) & d) << u, w = f >> c;
		s.push(y | w), o++, t -= 8;
	}
	if (t > 0n) {
		const f = Math.min(t, 8 - r), m = t - f, y = 255 >> 8 - f << r, w = 255 >> 8 - m, E = n.getUint8(o), A = o + 1 >= n.byteLength ? 0 : n.getUint8(o + 1), B = m === 0 ? 0 : (A & w) << f, T = (E & y) >> r;
		s.push(B | T);
	}
	return Hy(s);
}
function K2(e, t, n) {
	if (e % 8 !== 0) throw new Error("non-byte-aligned read " + e);
	let r = Math.floor(e / 8);
	const s = [];
	for (; t >= 8;) s.push(n.getUint8(r)), r++, t -= 8;
	return t > 0n && s.push(n.getUint8(r) & 255 >> 8 - t), Hy(s);
}
function qg(e, t, n) {
	var r, s, o, u, c, d, f, m, y, w;
	for (w = e + n, c = e; tu(c, t) === 0;) {
		if (d = c + 1, c > w) throw new Error("bail: rubbing past end");
		c = d;
	}
	if (e === c) return {
		head: 1,
		tail: Y.zero
	};
	if (r = c - e, s = c + 1, c = r - 1, c > 52) throw new Error("bail: rubbing oversized pointer (>52 bits)");
	return d = 2 ** c, f = Number(Hg(s, c, t)), o = d + f, u = r + r, d = u + o, f = s + c, m = u + o, y = Hg(f, o, t), {
		head: m,
		tail: new Y(y)
	};
}
function jg(e, t, n) {
	return e[t] = n;
}
function V2(e, t) {
	return e[t];
}
function df(e, t, n, r) {
	let s, o;
	if (tu(r, t) === 0) {
		const c = qg(1 + r, t, n);
		s = c.head + 1, o = c.tail, jg(e, r, o);
	} else {
		let u = 2 + r;
		if (tu(1 + r, t) === 0) {
			const d = df(e, t, n, u), m = df(e, t, n, d.head + u);
			s = 2 + (d.head + m.head), o = new ze(d.tail, m.tail), jg(e, r, o);
		} else {
			const d = qg(u, t, n), f = V2(e, Number(d.tail.number));
			if (f === void 0) throw new Error("Bail");
			s = 2 + d.head, o = f;
		}
	}
	return {
		head: s,
		tail: o
	};
}
function qy(e) {
	return Z2(G2(e.number));
}
function Z2(e) {
	return df({}, e, W2(e), 0).tail;
}
function jy(e) {
	if (Y.zero.equals(e)) return Cr(1, 1);
	{
		const t = Cr(ft.met(0, e)), n = Cr(ft.met(0, t)), r = ft.dec(n), s = ft.add(n, n), o = ft.end(Y.zero, r, t), u = ft.bex(n), c = ft.lsh(Y.zero, r, e), d = ft.mix(o, c);
		return Cr(ft.add(s, t), ft.cat(Y.zero, u, d));
	}
}
function J2(e, t, n, r, s) {
	var o = Cr([2, 1], s), u = ft.add(Y.two, r), c = hf(e, t, u, o), f = hf(e, n, ft.add(u, c.head), c.tail.head), m = ft.add(c.head, f.head);
	return Cr(ft.add(Y.two, m), f.tail.head, Y.zero);
}
function X2(e, t) {
	var n = jy(e), r = ft.lsh(Y.zero, Y.two, n.tail), s = ft.add(Y.two, n.head);
	return Cr(s, [[s, ft.mix(Y.three, r)], t], Y.zero);
}
function Gg(e, t) {
	var n = jy(e), r = ft.add(Y.one, n.head);
	return Cr(r, [[r, ft.lsh(Y.zero, Y.one, n.tail)], t], Y.zero);
}
function hf(e, t, n, r) {
	const s = e.get(t);
	return s == null ? (e.insert(t, n), t instanceof ze ? J2(e, t.head, t.tail, n, r) : Gg(t, r)) : t instanceof Y && ft.met(0, t) <= ft.met(0, s) ? Gg(t, r) : X2(s, r);
}
function Y2(e) {
	const t = hf(new j2(), e, Y.zero, Y.zero), n = z2.flop(t.tail.head);
	return ft.can(Y.zero, n);
}
var qr = typeof window < "u" && typeof window.document < "u";
typeof process < "u" && process.versions != null && process.versions.node;
typeof window < "u" && window.name === "nodejs" || typeof navigator < "u" && "userAgent" in navigator && typeof navigator.userAgent == "string" && (navigator.userAgent.includes("Node.js") || navigator.userAgent.includes("jsdom"));
typeof Deno < "u" && typeof Deno.version < "u" && Deno.version.deno;
typeof process < "u" && process.versions != null && process.versions.bun;
(function(e) {
	var t = function(n) {
		var r = 1e7, s = 7, o = 9007199254740992, u = A(o), c = "0123456789abcdefghijklmnopqrstuvwxyz", d = typeof BigInt == "function";
		function f(S, g, h, p) {
			return typeof S > "u" ? f[0] : typeof g < "u" ? +g == 10 && !h ? be(S) : rn(S, g, h, p) : be(S);
		}
		function m(S, g) {
			this.value = S, this.sign = g, this.isSmall = !1;
		}
		m.prototype = Object.create(f.prototype);
		function y(S) {
			this.value = S, this.sign = S < 0, this.isSmall = !0;
		}
		y.prototype = Object.create(f.prototype);
		function w(S) {
			this.value = S;
		}
		w.prototype = Object.create(f.prototype);
		function E(S) {
			return -o < S && S < o;
		}
		function A(S) {
			return S < 1e7 ? [S] : S < 0x5af3107a4000 ? [S % 1e7, Math.floor(S / 1e7)] : [
				S % 1e7,
				Math.floor(S / 1e7) % 1e7,
				Math.floor(S / 0x5af3107a4000)
			];
		}
		function B(S) {
			T(S);
			var g = S.length;
			if (g < 4 && hn(S, u) < 0) switch (g) {
				case 0: return 0;
				case 1: return S[0];
				case 2: return S[0] + S[1] * r;
				default: return S[0] + (S[1] + S[2] * r) * r;
			}
			return S;
		}
		function T(S) {
			for (var g = S.length; S[--g] === 0;);
			S.length = g + 1;
		}
		function $(S) {
			for (var g = new Array(S), h = -1; ++h < S;) g[h] = 0;
			return g;
		}
		function V(S) {
			return S > 0 ? Math.floor(S) : Math.ceil(S);
		}
		function H(S, g) {
			var h = S.length, p = g.length, v = new Array(h), C = 0, I = r, R, j;
			for (j = 0; j < p; j++) R = S[j] + g[j] + C, C = R >= I ? 1 : 0, v[j] = R - C * I;
			for (; j < h;) R = S[j] + C, C = R === I ? 1 : 0, v[j++] = R - C * I;
			return C > 0 && v.push(C), v;
		}
		function Q(S, g) {
			return S.length >= g.length ? H(S, g) : H(g, S);
		}
		function te(S, g) {
			var h = S.length, p = new Array(h), v = r, C, I;
			for (I = 0; I < h; I++) C = S[I] - v + g, g = Math.floor(C / v), p[I] = C - g * v, g += 1;
			for (; g > 0;) p[I++] = g % v, g = Math.floor(g / v);
			return p;
		}
		m.prototype.add = function(S) {
			var g = be(S);
			if (this.sign !== g.sign) return this.subtract(g.negate());
			var h = this.value, p = g.value;
			return g.isSmall ? new m(te(h, Math.abs(p)), this.sign) : new m(Q(h, p), this.sign);
		}, m.prototype.plus = m.prototype.add, y.prototype.add = function(S) {
			var g = be(S), h = this.value;
			if (h < 0 !== g.sign) return this.subtract(g.negate());
			var p = g.value;
			if (g.isSmall) {
				if (E(h + p)) return new y(h + p);
				p = A(Math.abs(p));
			}
			return new m(te(p, Math.abs(h)), h < 0);
		}, y.prototype.plus = y.prototype.add, w.prototype.add = function(S) {
			return new w(this.value + be(S).value);
		}, w.prototype.plus = w.prototype.add;
		function ge(S, g) {
			var h = S.length, p = g.length, v = new Array(h), C = 0, I = r, R, j;
			for (R = 0; R < p; R++) j = S[R] - C - g[R], j < 0 ? (j += I, C = 1) : C = 0, v[R] = j;
			for (R = p; R < h; R++) {
				if (j = S[R] - C, j < 0) j += I;
				else {
					v[R++] = j;
					break;
				}
				v[R] = j;
			}
			for (; R < h; R++) v[R] = S[R];
			return T(v), v;
		}
		function De(S, g, h) {
			var p;
			return hn(S, g) >= 0 ? p = ge(S, g) : (p = ge(g, S), h = !h), p = B(p), typeof p == "number" ? (h && (p = -p), new y(p)) : new m(p, h);
		}
		function rt(S, g, h) {
			var p = S.length, v = new Array(p), C = -g, I = r, R, j;
			for (R = 0; R < p; R++) j = S[R] + C, C = Math.floor(j / I), j %= I, v[R] = j < 0 ? j + I : j;
			return v = B(v), typeof v == "number" ? (h && (v = -v), new y(v)) : new m(v, h);
		}
		m.prototype.subtract = function(S) {
			var g = be(S);
			if (this.sign !== g.sign) return this.add(g.negate());
			var h = this.value, p = g.value;
			return g.isSmall ? rt(h, Math.abs(p), this.sign) : De(h, p, this.sign);
		}, m.prototype.minus = m.prototype.subtract, y.prototype.subtract = function(S) {
			var g = be(S), h = this.value;
			if (h < 0 !== g.sign) return this.add(g.negate());
			var p = g.value;
			return g.isSmall ? new y(h - p) : rt(p, Math.abs(h), h >= 0);
		}, y.prototype.minus = y.prototype.subtract, w.prototype.subtract = function(S) {
			return new w(this.value - be(S).value);
		}, w.prototype.minus = w.prototype.subtract, m.prototype.negate = function() {
			return new m(this.value, !this.sign);
		}, y.prototype.negate = function() {
			var S = this.sign, g = new y(-this.value);
			return g.sign = !S, g;
		}, w.prototype.negate = function() {
			return new w(-this.value);
		}, m.prototype.abs = function() {
			return new m(this.value, !1);
		}, y.prototype.abs = function() {
			return new y(Math.abs(this.value));
		}, w.prototype.abs = function() {
			return new w(this.value >= 0 ? this.value : -this.value);
		};
		function Je(S, g) {
			var h = S.length, p = g.length, C = $(h + p), I = r, R, j, ae, de, ce;
			for (ae = 0; ae < h; ++ae) {
				de = S[ae];
				for (var me = 0; me < p; ++me) ce = g[me], R = de * ce + C[ae + me], j = Math.floor(R / I), C[ae + me] = R - j * I, C[ae + me + 1] += j;
			}
			return T(C), C;
		}
		function lr(S, g) {
			var h = S.length, p = new Array(h), v = r, C = 0, I, R;
			for (R = 0; R < h; R++) I = S[R] * g + C, C = Math.floor(I / v), p[R] = I - C * v;
			for (; C > 0;) p[R++] = C % v, C = Math.floor(C / v);
			return p;
		}
		function Zi(S, g) {
			for (var h = []; g-- > 0;) h.push(0);
			return h.concat(S);
		}
		function ei(S, g) {
			var h = Math.max(S.length, g.length);
			if (h <= 30) return Je(S, g);
			h = Math.ceil(h / 2);
			var p = S.slice(h), v = S.slice(0, h), C = g.slice(h), I = g.slice(0, h), R = ei(v, I), j = ei(p, C), de = Q(Q(R, Zi(ge(ge(ei(Q(v, p), Q(I, C)), R), j), h)), Zi(j, 2 * h));
			return T(de), de;
		}
		function $s(S, g) {
			return -.012 * S - .012 * g + 15e-6 * S * g > 0;
		}
		m.prototype.multiply = function(S) {
			var g = be(S), h = this.value, p = g.value, v = this.sign !== g.sign, C;
			if (g.isSmall) {
				if (p === 0) return f[0];
				if (p === 1) return this;
				if (p === -1) return this.negate();
				if (C = Math.abs(p), C < r) return new m(lr(h, C), v);
				p = A(C);
			}
			return $s(h.length, p.length) ? new m(ei(h, p), v) : new m(Je(h, p), v);
		}, m.prototype.times = m.prototype.multiply;
		function ti(S, g, h) {
			return S < r ? new m(lr(g, S), h) : new m(Je(g, A(S)), h);
		}
		y.prototype._multiplyBySmall = function(S) {
			return E(S.value * this.value) ? new y(S.value * this.value) : ti(Math.abs(S.value), A(Math.abs(this.value)), this.sign !== S.sign);
		}, m.prototype._multiplyBySmall = function(S) {
			return S.value === 0 ? f[0] : S.value === 1 ? this : S.value === -1 ? this.negate() : ti(Math.abs(S.value), this.value, this.sign !== S.sign);
		}, y.prototype.multiply = function(S) {
			return be(S)._multiplyBySmall(this);
		}, y.prototype.times = y.prototype.multiply, w.prototype.multiply = function(S) {
			return new w(this.value * be(S).value);
		}, w.prototype.times = w.prototype.multiply;
		function xi(S) {
			var g = S.length, h = $(g + g), p = r, v, C, I, R, j;
			for (I = 0; I < g; I++) {
				R = S[I], C = 0 - R * R;
				for (var ae = I; ae < g; ae++) j = S[ae], v = 2 * (R * j) + h[I + ae] + C, C = Math.floor(v / p), h[I + ae] = v - C * p;
				h[I + g] = C;
			}
			return T(h), h;
		}
		m.prototype.square = function() {
			return new m(xi(this.value), !1);
		}, y.prototype.square = function() {
			var S = this.value * this.value;
			return E(S) ? new y(S) : new m(xi(A(Math.abs(this.value))), !1);
		}, w.prototype.square = function(S) {
			return new w(this.value * this.value);
		};
		function Ls(S, g) {
			var h = S.length, p = g.length, v = r, C = $(g.length), I = g[p - 1], R = Math.ceil(v / (2 * I)), j = lr(S, R), ae = lr(g, R), de, ce, me, sn, Vt, Ji, Xi;
			for (j.length <= h && j.push(0), ae.push(0), I = ae[p - 1], ce = h - p; ce >= 0; ce--) {
				for (de = v - 1, j[ce + p] !== I && (de = Math.floor((j[ce + p] * v + j[ce + p - 1]) / I)), me = 0, sn = 0, Ji = ae.length, Vt = 0; Vt < Ji; Vt++) me += de * ae[Vt], Xi = Math.floor(me / v), sn += j[ce + Vt] - (me - Xi * v), me = Xi, sn < 0 ? (j[ce + Vt] = sn + v, sn = -1) : (j[ce + Vt] = sn, sn = 0);
				for (; sn !== 0;) {
					for (de -= 1, me = 0, Vt = 0; Vt < Ji; Vt++) me += j[ce + Vt] - v + ae[Vt], me < 0 ? (j[ce + Vt] = me + v, me = 0) : (j[ce + Vt] = me, me = 1);
					sn += me;
				}
				C[ce] = de;
			}
			return j = Fn(j, R)[0], [B(C), B(j)];
		}
		function Qn(S, g) {
			for (var h = S.length, p = g.length, v = [], C = [], I = r, R, j, ae, de, ce; h;) {
				if (C.unshift(S[--h]), T(C), hn(C, g) < 0) {
					v.push(0);
					continue;
				}
				j = C.length, ae = C[j - 1] * I + C[j - 2], de = g[p - 1] * I + g[p - 2], j > p && (ae = (ae + 1) * I), R = Math.ceil(ae / de);
				do {
					if (ce = lr(g, R), hn(ce, C) <= 0) break;
					R--;
				} while (R);
				v.push(R), C = ge(C, ce);
			}
			return v.reverse(), [B(v), B(C)];
		}
		function Fn(S, g) {
			var h = S.length, p = $(h), v = r, C, I, R, j;
			for (R = 0, C = h - 1; C >= 0; --C) j = R * v + S[C], I = V(j / g), R = j - I * g, p[C] = I | 0;
			return [p, R | 0];
		}
		function er(S, g) {
			var h, p = be(g);
			if (d) return [new w(S.value / p.value), new w(S.value % p.value)];
			var v = S.value, C = p.value, I;
			if (C === 0) throw new Error("Cannot divide by zero");
			if (S.isSmall) return p.isSmall ? [new y(V(v / C)), new y(v % C)] : [f[0], S];
			if (p.isSmall) {
				if (C === 1) return [S, f[0]];
				if (C == -1) return [S.negate(), f[0]];
				var R = Math.abs(C);
				if (R < r) {
					h = Fn(v, R), I = B(h[0]);
					var j = h[1];
					return S.sign && (j = -j), typeof I == "number" ? (S.sign !== p.sign && (I = -I), [new y(I), new y(j)]) : [new m(I, S.sign !== p.sign), new y(j)];
				}
				C = A(R);
			}
			var ae = hn(v, C);
			if (ae === -1) return [f[0], S];
			if (ae === 0) return [f[S.sign === p.sign ? 1 : -1], f[0]];
			v.length + C.length <= 200 ? h = Ls(v, C) : h = Qn(v, C), I = h[0];
			var de = S.sign !== p.sign, ce = h[1], me = S.sign;
			return typeof I == "number" ? (de && (I = -I), I = new y(I)) : I = new m(I, de), typeof ce == "number" ? (me && (ce = -ce), ce = new y(ce)) : ce = new m(ce, me), [I, ce];
		}
		m.prototype.divmod = function(S) {
			var g = er(this, S);
			return {
				quotient: g[0],
				remainder: g[1]
			};
		}, w.prototype.divmod = y.prototype.divmod = m.prototype.divmod, m.prototype.divide = function(S) {
			return er(this, S)[0];
		}, w.prototype.over = w.prototype.divide = function(S) {
			return new w(this.value / be(S).value);
		}, y.prototype.over = y.prototype.divide = m.prototype.over = m.prototype.divide, m.prototype.mod = function(S) {
			return er(this, S)[1];
		}, w.prototype.mod = w.prototype.remainder = function(S) {
			return new w(this.value % be(S).value);
		}, y.prototype.remainder = y.prototype.mod = m.prototype.remainder = m.prototype.mod, m.prototype.pow = function(S) {
			var g = be(S), h = this.value, p = g.value, v, C, I;
			if (p === 0) return f[1];
			if (h === 0) return f[0];
			if (h === 1) return f[1];
			if (h === -1) return g.isEven() ? f[1] : f[-1];
			if (g.sign) return f[0];
			if (!g.isSmall) throw new Error("The exponent " + g.toString() + " is too large.");
			if (this.isSmall && E(v = Math.pow(h, p))) return new y(V(v));
			for (C = this, I = f[1]; p & !0 && (I = I.times(C), --p), p !== 0;) p /= 2, C = C.square();
			return I;
		}, y.prototype.pow = m.prototype.pow, w.prototype.pow = function(S) {
			var g = be(S), h = this.value, p = g.value, v = BigInt(0), C = BigInt(1), I = BigInt(2);
			if (p === v) return f[1];
			if (h === v) return f[0];
			if (h === C) return f[1];
			if (h === BigInt(-1)) return g.isEven() ? f[1] : f[-1];
			if (g.isNegative()) return new w(v);
			for (var R = this, j = f[1]; (p & C) === C && (j = j.times(R), --p), p !== v;) p /= I, R = R.square();
			return j;
		}, m.prototype.modPow = function(S, g) {
			if (S = be(S), g = be(g), g.isZero()) throw new Error("Cannot take modPow with modulus 0");
			var h = f[1], p = this.mod(g);
			for (S.isNegative() && (S = S.multiply(f[-1]), p = p.modInv(g)); S.isPositive();) {
				if (p.isZero()) return f[0];
				S.isOdd() && (h = h.multiply(p).mod(g)), S = S.divide(2), p = p.square().mod(g);
			}
			return h;
		}, w.prototype.modPow = y.prototype.modPow = m.prototype.modPow;
		function hn(S, g) {
			if (S.length !== g.length) return S.length > g.length ? 1 : -1;
			for (var h = S.length - 1; h >= 0; h--) if (S[h] !== g[h]) return S[h] > g[h] ? 1 : -1;
			return 0;
		}
		m.prototype.compareAbs = function(S) {
			var g = be(S), h = this.value, p = g.value;
			return g.isSmall ? 1 : hn(h, p);
		}, y.prototype.compareAbs = function(S) {
			var g = be(S), h = Math.abs(this.value), p = g.value;
			return g.isSmall ? (p = Math.abs(p), h === p ? 0 : h > p ? 1 : -1) : -1;
		}, w.prototype.compareAbs = function(S) {
			var g = this.value, h = be(S).value;
			return g = g >= 0 ? g : -g, h = h >= 0 ? h : -h, g === h ? 0 : g > h ? 1 : -1;
		}, m.prototype.compare = function(S) {
			if (S === Infinity) return -1;
			if (S === -Infinity) return 1;
			var g = be(S), h = this.value, p = g.value;
			return this.sign !== g.sign ? g.sign ? 1 : -1 : g.isSmall ? this.sign ? -1 : 1 : hn(h, p) * (this.sign ? -1 : 1);
		}, m.prototype.compareTo = m.prototype.compare, y.prototype.compare = function(S) {
			if (S === Infinity) return -1;
			if (S === -Infinity) return 1;
			var g = be(S), h = this.value, p = g.value;
			return g.isSmall ? h == p ? 0 : h > p ? 1 : -1 : h < 0 !== g.sign ? h < 0 ? -1 : 1 : h < 0 ? 1 : -1;
		}, y.prototype.compareTo = y.prototype.compare, w.prototype.compare = function(S) {
			if (S === Infinity) return -1;
			if (S === -Infinity) return 1;
			var g = this.value, h = be(S).value;
			return g === h ? 0 : g > h ? 1 : -1;
		}, w.prototype.compareTo = w.prototype.compare, m.prototype.equals = function(S) {
			return this.compare(S) === 0;
		}, w.prototype.eq = w.prototype.equals = y.prototype.eq = y.prototype.equals = m.prototype.eq = m.prototype.equals, m.prototype.notEquals = function(S) {
			return this.compare(S) !== 0;
		}, w.prototype.neq = w.prototype.notEquals = y.prototype.neq = y.prototype.notEquals = m.prototype.neq = m.prototype.notEquals, m.prototype.greater = function(S) {
			return this.compare(S) > 0;
		}, w.prototype.gt = w.prototype.greater = y.prototype.gt = y.prototype.greater = m.prototype.gt = m.prototype.greater, m.prototype.lesser = function(S) {
			return this.compare(S) < 0;
		}, w.prototype.lt = w.prototype.lesser = y.prototype.lt = y.prototype.lesser = m.prototype.lt = m.prototype.lesser, m.prototype.greaterOrEquals = function(S) {
			return this.compare(S) >= 0;
		}, w.prototype.geq = w.prototype.greaterOrEquals = y.prototype.geq = y.prototype.greaterOrEquals = m.prototype.geq = m.prototype.greaterOrEquals, m.prototype.lesserOrEquals = function(S) {
			return this.compare(S) <= 0;
		}, w.prototype.leq = w.prototype.lesserOrEquals = y.prototype.leq = y.prototype.lesserOrEquals = m.prototype.leq = m.prototype.lesserOrEquals, m.prototype.isEven = function() {
			return (this.value[0] & 1) === 0;
		}, y.prototype.isEven = function() {
			return (this.value & 1) === 0;
		}, w.prototype.isEven = function() {
			return (this.value & BigInt(1)) === BigInt(0);
		}, m.prototype.isOdd = function() {
			return (this.value[0] & 1) === 1;
		}, y.prototype.isOdd = function() {
			return (this.value & 1) === 1;
		}, w.prototype.isOdd = function() {
			return (this.value & BigInt(1)) === BigInt(1);
		}, m.prototype.isPositive = function() {
			return !this.sign;
		}, y.prototype.isPositive = function() {
			return this.value > 0;
		}, w.prototype.isPositive = y.prototype.isPositive, m.prototype.isNegative = function() {
			return this.sign;
		}, y.prototype.isNegative = function() {
			return this.value < 0;
		}, w.prototype.isNegative = y.prototype.isNegative, m.prototype.isUnit = function() {
			return !1;
		}, y.prototype.isUnit = function() {
			return Math.abs(this.value) === 1;
		}, w.prototype.isUnit = function() {
			return this.abs().value === BigInt(1);
		}, m.prototype.isZero = function() {
			return !1;
		}, y.prototype.isZero = function() {
			return this.value === 0;
		}, w.prototype.isZero = function() {
			return this.value === BigInt(0);
		}, m.prototype.isDivisibleBy = function(S) {
			var g = be(S);
			return g.isZero() ? !1 : g.isUnit() ? !0 : g.compareAbs(2) === 0 ? this.isEven() : this.mod(g).isZero();
		}, w.prototype.isDivisibleBy = y.prototype.isDivisibleBy = m.prototype.isDivisibleBy;
		function He(S) {
			var g = S.abs();
			if (g.isUnit()) return !1;
			if (g.equals(2) || g.equals(3) || g.equals(5)) return !0;
			if (g.isEven() || g.isDivisibleBy(3) || g.isDivisibleBy(5)) return !1;
			if (g.lesser(49)) return !0;
		}
		function St(S, g) {
			for (var h = S.prev(), p = h, v = 0, C, I, R; p.isEven();) p = p.divide(2), v++;
			e: for (I = 0; I < g.length; I++) if (!S.lesser(g[I]) && (R = t(g[I]).modPow(p, S), !(R.isUnit() || R.equals(h)))) {
				for (C = v - 1; C != 0; C--) {
					if (R = R.square().mod(S), R.isUnit()) return !1;
					if (R.equals(h)) continue e;
				}
				return !1;
			}
			return !0;
		}
		m.prototype.isPrime = function(S) {
			var g = He(this);
			if (g !== n) return g;
			var h = this.abs(), p = h.bitLength();
			if (p <= 64) return St(h, [
				2,
				3,
				5,
				7,
				11,
				13,
				17,
				19,
				23,
				29,
				31,
				37
			]);
			for (var v = Math.log(2) * p.toJSNumber(), C = Math.ceil(S === !0 ? 2 * Math.pow(v, 2) : v), I = [], R = 0; R < C; R++) I.push(t(R + 2));
			return St(h, I);
		}, w.prototype.isPrime = y.prototype.isPrime = m.prototype.isPrime, m.prototype.isProbablePrime = function(S, g) {
			var h = He(this);
			if (h !== n) return h;
			for (var p = this.abs(), v = S === n ? 5 : S, C = [], I = 0; I < v; I++) C.push(t.randBetween(2, p.minus(2), g));
			return St(p, C);
		}, w.prototype.isProbablePrime = y.prototype.isProbablePrime = m.prototype.isProbablePrime, m.prototype.modInv = function(S) {
			for (var g = t.zero, h = t.one, p = be(S), v = this.abs(), C, I, R; !v.isZero();) C = p.divide(v), I = g, R = p, g = h, p = v, h = I.subtract(C.multiply(h)), v = R.subtract(C.multiply(v));
			if (!p.isUnit()) throw new Error(this.toString() + " and " + S.toString() + " are not co-prime");
			return g.compare(0) === -1 && (g = g.add(S)), this.isNegative() ? g.negate() : g;
		}, w.prototype.modInv = y.prototype.modInv = m.prototype.modInv, m.prototype.next = function() {
			var S = this.value;
			return this.sign ? rt(S, 1, this.sign) : new m(te(S, 1), this.sign);
		}, y.prototype.next = function() {
			var S = this.value;
			return S + 1 < o ? new y(S + 1) : new m(u, !1);
		}, w.prototype.next = function() {
			return new w(this.value + BigInt(1));
		}, m.prototype.prev = function() {
			var S = this.value;
			return this.sign ? new m(te(S, 1), !0) : rt(S, 1, this.sign);
		}, y.prototype.prev = function() {
			var S = this.value;
			return S - 1 > -o ? new y(S - 1) : new m(u, !0);
		}, w.prototype.prev = function() {
			return new w(this.value - BigInt(1));
		};
		for (var pn = [1]; 2 * pn[pn.length - 1] <= r;) pn.push(2 * pn[pn.length - 1]);
		var fr = pn.length, zt = pn[fr - 1];
		function dr(S) {
			return Math.abs(S) <= r;
		}
		m.prototype.shiftLeft = function(S) {
			var g = be(S).toJSNumber();
			if (!dr(g)) throw new Error(String(g) + " is too large for shifting.");
			if (g < 0) return this.shiftRight(-g);
			var h = this;
			if (h.isZero()) return h;
			for (; g >= fr;) h = h.multiply(zt), g -= fr - 1;
			return h.multiply(pn[g]);
		}, w.prototype.shiftLeft = y.prototype.shiftLeft = m.prototype.shiftLeft, m.prototype.shiftRight = function(S) {
			var g, h = be(S).toJSNumber();
			if (!dr(h)) throw new Error(String(h) + " is too large for shifting.");
			if (h < 0) return this.shiftLeft(-h);
			for (var p = this; h >= fr;) {
				if (p.isZero() || p.isNegative() && p.isUnit()) return p;
				g = er(p, zt), p = g[1].isNegative() ? g[0].prev() : g[0], h -= fr - 1;
			}
			return g = er(p, pn[h]), g[1].isNegative() ? g[0].prev() : g[0];
		}, w.prototype.shiftRight = y.prototype.shiftRight = m.prototype.shiftRight;
		function ni(S, g, h) {
			g = be(g);
			for (var p = S.isNegative(), v = g.isNegative(), C = p ? S.not() : S, I = v ? g.not() : g, R = 0, j = 0, ae = null, de = null, ce = []; !C.isZero() || !I.isZero();) ae = er(C, zt), R = ae[1].toJSNumber(), p && (R = zt - 1 - R), de = er(I, zt), j = de[1].toJSNumber(), v && (j = zt - 1 - j), C = ae[0], I = de[0], ce.push(h(R, j));
			for (var me = h(p ? 1 : 0, v ? 1 : 0) !== 0 ? t(-1) : t(0), sn = ce.length - 1; sn >= 0; sn -= 1) me = me.multiply(zt).add(t(ce[sn]));
			return me;
		}
		m.prototype.not = function() {
			return this.negate().prev();
		}, w.prototype.not = y.prototype.not = m.prototype.not, m.prototype.and = function(S) {
			return ni(this, S, function(g, h) {
				return g & h;
			});
		}, w.prototype.and = y.prototype.and = m.prototype.and, m.prototype.or = function(S) {
			return ni(this, S, function(g, h) {
				return g | h;
			});
		}, w.prototype.or = y.prototype.or = m.prototype.or, m.prototype.xor = function(S) {
			return ni(this, S, function(g, h) {
				return g ^ h;
			});
		}, w.prototype.xor = y.prototype.xor = m.prototype.xor;
		var Kt = 1 << 30, tr = (r & -r) * (r & -r) | Kt;
		function kr(S) {
			var g = S.value, h = typeof g == "number" ? g | Kt : typeof g == "bigint" ? g | BigInt(Kt) : g[0] + g[1] * r | tr;
			return h & -h;
		}
		function Rr(S, g) {
			if (g.compareTo(S) <= 0) {
				var h = Rr(S, g.square(g)), p = h.p, v = h.e, C = p.multiply(g);
				return C.compareTo(S) <= 0 ? {
					p: C,
					e: v * 2 + 1
				} : {
					p,
					e: v * 2
				};
			}
			return {
				p: t(1),
				e: 0
			};
		}
		m.prototype.bitLength = function() {
			var S = this;
			return S.compareTo(t(0)) < 0 && (S = S.negate().subtract(t(1))), S.compareTo(t(0)) === 0 ? t(0) : t(Rr(S, t(2)).e).add(t(1));
		}, w.prototype.bitLength = y.prototype.bitLength = m.prototype.bitLength;
		function hr(S, g) {
			return S = be(S), g = be(g), S.greater(g) ? S : g;
		}
		function An(S, g) {
			return S = be(S), g = be(g), S.lesser(g) ? S : g;
		}
		function Ct(S, g) {
			if (S = be(S).abs(), g = be(g).abs(), S.equals(g)) return S;
			if (S.isZero()) return g;
			if (g.isZero()) return S;
			for (var h = f[1], p, v; S.isEven() && g.isEven();) p = An(kr(S), kr(g)), S = S.divide(p), g = g.divide(p), h = h.multiply(p);
			for (; S.isEven();) S = S.divide(kr(S));
			do {
				for (; g.isEven();) g = g.divide(kr(g));
				S.greater(g) && (v = g, g = S, S = v), g = g.subtract(S);
			} while (!g.isZero());
			return h.isUnit() ? S : S.multiply(h);
		}
		function Tr(S, g) {
			return S = be(S).abs(), g = be(g).abs(), S.divide(Ct(S, g)).multiply(g);
		}
		function zs(S, g, h) {
			S = be(S), g = be(g);
			var p = h || Math.random, v = An(S, g), I = hr(S, g).subtract(v).add(1);
			if (I.isSmall) return v.add(Math.floor(p() * I));
			for (var R = gn(I, r).value, j = [], ae = !0, de = 0; de < R.length; de++) {
				var ce = ae ? R[de] + (de + 1 < R.length ? R[de + 1] / r : 0) : r, me = V(p() * ce);
				j.push(me), me < R[de] && (ae = !1);
			}
			return v.add(f.fromArray(j, r, !1));
		}
		var rn = function(S, g, h, p) {
			h = h || c, S = String(S), p || (S = S.toLowerCase(), h = h.toLowerCase());
			var v = S.length, C, I = Math.abs(g), R = {};
			for (C = 0; C < h.length; C++) R[h[C]] = C;
			for (C = 0; C < v; C++) {
				var j = S[C];
				if (j !== "-" && j in R && R[j] >= I) {
					if (j === "1" && I === 1) continue;
					throw new Error(j + " is not a valid digit in base " + g + ".");
				}
			}
			g = be(g);
			var ae = [], de = S[0] === "-";
			for (C = de ? 1 : 0; C < S.length; C++) {
				var j = S[C];
				if (j in R) ae.push(be(R[j]));
				else if (j === "<") {
					var ce = C;
					do
						C++;
					while (S[C] !== ">" && C < S.length);
					ae.push(be(S.slice(ce + 1, C)));
				} else throw new Error(j + " is not a valid character");
			}
			return Fi(ae, g, de);
		};
		function Fi(S, g, h) {
			var p = f[0], v = f[1], C;
			for (C = S.length - 1; C >= 0; C--) p = p.add(S[C].times(v)), v = v.times(g);
			return h ? p.negate() : p;
		}
		function Hs(S, g) {
			return g = g || c, S < g.length ? g[S] : "<" + S + ">";
		}
		function gn(S, g) {
			if (g = t(g), g.isZero()) {
				if (S.isZero()) return {
					value: [0],
					isNegative: !1
				};
				throw new Error("Cannot convert nonzero numbers to base 0.");
			}
			if (g.equals(-1)) {
				if (S.isZero()) return {
					value: [0],
					isNegative: !1
				};
				if (S.isNegative()) return {
					value: [].concat.apply([], Array.apply(null, Array(-S.toJSNumber())).map(Array.prototype.valueOf, [1, 0])),
					isNegative: !1
				};
				var h = Array.apply(null, Array(S.toJSNumber() - 1)).map(Array.prototype.valueOf, [0, 1]);
				return h.unshift([1]), {
					value: [].concat.apply([], h),
					isNegative: !1
				};
			}
			var p = !1;
			if (S.isNegative() && g.isPositive() && (p = !0, S = S.abs()), g.isUnit()) return S.isZero() ? {
				value: [0],
				isNegative: !1
			} : {
				value: Array.apply(null, Array(S.toJSNumber())).map(Number.prototype.valueOf, 1),
				isNegative: p
			};
			for (var v = [], C = S, I; C.isNegative() || C.compareAbs(g) >= 0;) {
				I = C.divmod(g), C = I.quotient;
				var R = I.remainder;
				R.isNegative() && (R = g.minus(R).abs(), C = C.next()), v.push(R.toJSNumber());
			}
			return v.push(C.toJSNumber()), {
				value: v.reverse(),
				isNegative: p
			};
		}
		function It(S, g, h) {
			var p = gn(S, g);
			return (p.isNegative ? "-" : "") + p.value.map(function(v) {
				return Hs(v, h);
			}).join("");
		}
		m.prototype.toArray = function(S) {
			return gn(this, S);
		}, y.prototype.toArray = function(S) {
			return gn(this, S);
		}, w.prototype.toArray = function(S) {
			return gn(this, S);
		}, m.prototype.toString = function(S, g) {
			if (S === n && (S = 10), S !== 10 || g) return It(this, S, g);
			for (var h = this.value, p = h.length, v = String(h[--p]), C = "0000000", I; --p >= 0;) I = String(h[p]), v += C.slice(I.length) + I;
			return (this.sign ? "-" : "") + v;
		}, y.prototype.toString = function(S, g) {
			return S === n && (S = 10), S != 10 || g ? It(this, S, g) : String(this.value);
		}, w.prototype.toString = y.prototype.toString, w.prototype.toJSON = m.prototype.toJSON = y.prototype.toJSON = function() {
			return this.toString();
		}, m.prototype.valueOf = function() {
			return parseInt(this.toString(), 10);
		}, m.prototype.toJSNumber = m.prototype.valueOf, y.prototype.valueOf = function() {
			return this.value;
		}, y.prototype.toJSNumber = y.prototype.valueOf, w.prototype.valueOf = w.prototype.toJSNumber = function() {
			return parseInt(this.toString(), 10);
		};
		function kt(S) {
			if (E(+S)) {
				var g = +S;
				if (g === V(g)) return d ? new w(BigInt(g)) : new y(g);
				throw new Error("Invalid integer: " + S);
			}
			var h = S[0] === "-";
			h && (S = S.slice(1));
			var p = S.split(/e/i);
			if (p.length > 2) throw new Error("Invalid integer: " + p.join("e"));
			if (p.length === 2) {
				var v = p[1];
				if (v[0] === "+" && (v = v.slice(1)), v = +v, v !== V(v) || !E(v)) throw new Error("Invalid integer: " + v + " is not a valid exponent.");
				var C = p[0], I = C.indexOf(".");
				if (I >= 0 && (v -= C.length - I - 1, C = C.slice(0, I) + C.slice(I + 1)), v < 0) throw new Error("Cannot include negative exponent part for integers");
				C += new Array(v + 1).join("0"), S = C;
			}
			if (!/^([0-9][0-9]*)$/.test(S)) throw new Error("Invalid integer: " + S);
			if (d) return new w(BigInt(h ? "-" + S : S));
			for (var j = [], ae = S.length, de = s, ce = ae - de; ae > 0;) j.push(+S.slice(ce, ae)), ce -= de, ce < 0 && (ce = 0), ae -= de;
			return T(j), new m(j, h);
		}
		function pr(S) {
			if (d) return new w(BigInt(S));
			if (E(S)) {
				if (S !== V(S)) throw new Error(S + " is not an integer.");
				return new y(S);
			}
			return kt(S.toString());
		}
		function be(S) {
			return typeof S == "number" ? pr(S) : typeof S == "string" ? kt(S) : typeof S == "bigint" ? new w(S) : S;
		}
		for (var ut = 0; ut < 1e3; ut++) f[ut] = be(ut), ut > 0 && (f[-ut] = be(-ut));
		return f.one = f[1], f.zero = f[0], f.minusOne = f[-1], f.max = hr, f.min = An, f.gcd = Ct, f.lcm = Tr, f.isInstance = function(S) {
			return S instanceof m || S instanceof y || S instanceof w;
		}, f.randBetween = zs, f.fromArray = function(S, g, h) {
			return Fi(S.map(be), be(g || 10), h);
		}, f;
	}();
	e.hasOwnProperty("exports") && (e.exports = t);
})({ exports: {} });
var xr = {}, e3 = yt && yt.__extends || /* @__PURE__ */ function() {
	var e = function(t, n) {
		return e = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(r, s) {
			r.__proto__ = s;
		} || function(r, s) {
			for (var o in s) Object.prototype.hasOwnProperty.call(s, o) && (r[o] = s[o]);
		}, e(t, n);
	};
	return function(t, n) {
		if (typeof n != "function" && n !== null) throw new TypeError("Class extends value " + String(n) + " is not a constructor or null");
		e(t, n);
		function r() {
			this.constructor = t;
		}
		t.prototype = n === null ? Object.create(n) : (r.prototype = n.prototype, new r());
	};
}();
Object.defineProperty(xr, "__esModule", { value: !0 });
xr.EmptyBTree = xr.asSet = xr.simpleComparator = xr.defaultComparator = void 0;
function Gy(e, t) {
	if (Number.isFinite(e) && Number.isFinite(t)) return e - t;
	var n = typeof e, r = typeof t;
	if (n !== r) return n < r ? -1 : 1;
	if (n === "object") {
		if (e === null) return t === null ? 0 : -1;
		if (t === null) return 1;
		if (e = e.valueOf(), t = t.valueOf(), n = typeof e, r = typeof t, n !== r) return n < r ? -1 : 1;
	}
	return e < t ? -1 : e > t ? 1 : e === t ? 0 : Number.isNaN(e) ? Number.isNaN(t) ? 0 : -1 : Number.isNaN(t) ? 1 : Array.isArray(e) ? 0 : NaN;
}
xr.defaultComparator = Gy;
function t3(e, t) {
	return e > t ? 1 : e < t ? -1 : 0;
}
xr.simpleComparator = t3;
var _r = function() {
	function e(t, n, r) {
		this._root = il, this._size = 0, this._maxNodeSize = r >= 4 ? Math.min(r, 256) : 32, this._compare = n || Gy, t && this.setPairs(t);
	}
	return Object.defineProperty(e.prototype, "size", {
		get: function() {
			return this._size;
		},
		enumerable: !1,
		configurable: !0
	}), Object.defineProperty(e.prototype, "length", {
		get: function() {
			return this._size;
		},
		enumerable: !1,
		configurable: !0
	}), Object.defineProperty(e.prototype, "isEmpty", {
		get: function() {
			return this._size === 0;
		},
		enumerable: !1,
		configurable: !0
	}), e.prototype.clear = function() {
		this._root = il, this._size = 0;
	}, e.prototype.forEach = function(t, n) {
		var r = this;
		return n !== void 0 && (t = t.bind(n)), this.forEachPair(function(s, o) {
			return t(o, s, r);
		});
	}, e.prototype.forEachPair = function(t, n) {
		var r = this.minKey(), s = this.maxKey();
		return this.forRange(r, s, !0, t, n);
	}, e.prototype.get = function(t, n) {
		return this._root.get(t, n, this);
	}, e.prototype.set = function(t, n, r) {
		this._root.isShared && (this._root = this._root.clone());
		var s = this._root.set(t, n, r, this);
		return s === !0 || s === !1 ? s : (this._root = new r3([this._root, s]), !0);
	}, e.prototype.has = function(t) {
		return this.forRange(t, t, !0, void 0) !== 0;
	}, e.prototype.delete = function(t) {
		return this.editRange(t, t, !0, Wg) !== 0;
	}, e.prototype.with = function(t, n, r) {
		var s = this.clone();
		return s.set(t, n, r) || r ? s : this;
	}, e.prototype.withPairs = function(t, n) {
		var r = this.clone();
		return r.setPairs(t, n) !== 0 || n ? r : this;
	}, e.prototype.withKeys = function(t, n) {
		for (var r = this.clone(), s = !1, o = 0; o < t.length; o++) s = r.set(t[o], void 0, !1) || s;
		return n && !s ? this : r;
	}, e.prototype.without = function(t, n) {
		return this.withoutRange(t, t, !0, n);
	}, e.prototype.withoutKeys = function(t, n) {
		var r = this.clone();
		return r.deleteKeys(t) || !n ? r : this;
	}, e.prototype.withoutRange = function(t, n, r, s) {
		var o = this.clone();
		return o.deleteRange(t, n, r) === 0 && s ? this : o;
	}, e.prototype.filter = function(t, n) {
		var r = this.greedyClone(), s;
		return r.editAll(function(o, u, c) {
			if (!t(o, u, c)) return s = Ky;
		}), !s && n ? this : r;
	}, e.prototype.mapValues = function(t) {
		var n = {}, r = this.greedyClone();
		return r.editAll(function(s, o, u) {
			return n.value = t(o, s, u), n;
		}), r;
	}, e.prototype.reduce = function(t, n) {
		for (var r = 0, s = n, o = this.entries(this.minKey(), ao), u; !(u = o.next()).done;) s = t(s, u.value, r++, this);
		return s;
	}, e.prototype.entries = function(t, n) {
		var r = this.findPath(t);
		if (r === void 0) return ds();
		var s = r.nodequeue, o = r.nodeindex, u = r.leaf, c = n !== void 0 ? 1 : 0, d = t === void 0 ? -1 : u.indexOf(t, 0, this._compare) - 1;
		return ds(function() {
			e: for (;;) switch (c) {
				case 0:
					if (++d < u.keys.length) return {
						done: !1,
						value: [u.keys[d], u.values[d]]
					};
					c = 2;
					continue;
				case 1:
					if (++d < u.keys.length) return n[0] = u.keys[d], n[1] = u.values[d], {
						done: !1,
						value: n
					};
					c = 2;
				case 2:
					for (var f = -1;;) {
						if (++f >= s.length) {
							c = 3;
							continue e;
						}
						if (++o[f] < s[f].length) break;
					}
					for (; f > 0; f--) s[f - 1] = s[f][o[f]].children, o[f - 1] = 0;
					u = s[0][o[0]], d = -1, c = n !== void 0 ? 1 : 0;
					continue;
				case 3: return {
					done: !0,
					value: void 0
				};
			}
		});
	}, e.prototype.entriesReversed = function(t, n, r) {
		if (t === void 0 && (t = this.maxKey(), r = void 0, t === void 0)) return ds();
		var s = this.findPath(t) || this.findPath(this.maxKey()), o = s.nodequeue, u = s.nodeindex, c = s.leaf;
		On(!o[0] || c === o[0][u[0]], "wat!");
		var d = c.indexOf(t, 0, this._compare);
		!r && d < c.keys.length && this._compare(c.keys[d], t) <= 0 && d++;
		var f = n !== void 0 ? 1 : 0;
		return ds(function() {
			e: for (;;) switch (f) {
				case 0:
					if (--d >= 0) return {
						done: !1,
						value: [c.keys[d], c.values[d]]
					};
					f = 2;
					continue;
				case 1:
					if (--d >= 0) return n[0] = c.keys[d], n[1] = c.values[d], {
						done: !1,
						value: n
					};
					f = 2;
				case 2:
					for (var m = -1;;) {
						if (++m >= o.length) {
							f = 3;
							continue e;
						}
						if (--u[m] >= 0) break;
					}
					for (; m > 0; m--) o[m - 1] = o[m][u[m]].children, u[m - 1] = o[m - 1].length - 1;
					c = o[0][u[0]], d = c.keys.length, f = n !== void 0 ? 1 : 0;
					continue;
				case 3: return {
					done: !0,
					value: void 0
				};
			}
		});
	}, e.prototype.findPath = function(t) {
		var n = this._root, r, s;
		if (n.isLeaf) r = Kg, s = Kg;
		else {
			r = [], s = [];
			for (var o = 0; !n.isLeaf; o++) {
				if (r[o] = n.children, s[o] = t === void 0 ? 0 : n.indexOf(t, 0, this._compare), s[o] >= r[o].length) return;
				n = r[o][s[o]];
			}
			r.reverse(), s.reverse();
		}
		return {
			nodequeue: r,
			nodeindex: s,
			leaf: n
		};
	}, e.prototype.diffAgainst = function(t, n, r, s) {
		if (t._compare !== this._compare) throw new Error("Tree comparators are not the same.");
		if (this.isEmpty || t.isEmpty) return this.isEmpty && t.isEmpty ? void 0 : this.isEmpty ? r === void 0 ? void 0 : e.stepToEnd(e.makeDiffCursor(t), r) : n === void 0 ? void 0 : e.stepToEnd(e.makeDiffCursor(this), n);
		for (var o = this._compare, u = e.makeDiffCursor(this), c = e.makeDiffCursor(t), d = !0, f = !0, m = e.compare(u, c, o); d && f;) {
			var y = e.compare(u, c, o), w = u.leaf, E = u.internalSpine, A = u.levelIndices, B = c.leaf, T = c.internalSpine, $ = c.levelIndices;
			if (w || B) {
				if (m !== 0) {
					if (y === 0) {
						if (w && B && s) {
							var V = w.values[A[A.length - 1]], H = B.values[$[$.length - 1]];
							if (!Object.is(V, H)) {
								var Q = s(u.currentKey, V, H);
								if (Q && Q.break) return Q.break;
							}
						}
					} else if (y > 0) {
						if (B && r) {
							var te = B.values[$[$.length - 1]], Q = r(c.currentKey, te);
							if (Q && Q.break) return Q.break;
						}
					} else if (n && w && m !== 0) {
						var V = w.values[A[A.length - 1]], Q = n(u.currentKey, V);
						if (Q && Q.break) return Q.break;
					}
				}
			} else if (!w && !B && y === 0) {
				var ge = E.length - 1, De = T.length - 1, rt = E[ge][A[ge]];
				if (T[De][$[De]] === rt) {
					m = 0, d = e.step(u, !0), f = e.step(c, !0);
					continue;
				}
			}
			m = y, y < 0 ? d = e.step(u) : f = e.step(c);
		}
		if (d && n) return e.finishCursorWalk(u, c, o, n);
		if (f && r) return e.finishCursorWalk(c, u, o, r);
	}, e.finishCursorWalk = function(t, n, r, s) {
		var o = e.compare(t, n, r);
		if (o === 0) {
			if (!e.step(t)) return;
		} else o < 0 && On(!1, "cursor walk terminated early");
		return e.stepToEnd(t, s);
	}, e.stepToEnd = function(t, n) {
		for (var r = !0; r;) {
			var s = t.leaf, o = t.levelIndices, u = t.currentKey;
			if (s) {
				var c = s.values[o[o.length - 1]], d = n(u, c);
				if (d && d.break) return d.break;
			}
			r = e.step(t);
		}
	}, e.makeDiffCursor = function(t) {
		var n = t._root;
		return {
			height: t.height,
			internalSpine: [[n]],
			levelIndices: [0],
			leaf: void 0,
			currentKey: n.maxKey()
		};
	}, e.step = function(t, n) {
		var r = t.internalSpine, s = t.levelIndices, o = t.leaf;
		if (n === !0 || o) {
			var u = s.length;
			if (n === !0 || s[u - 1] === 0) {
				var c = r.length;
				if (c === 0) return !1;
				for (var d = c - 1, f = d; f >= 0;) {
					if (s[f] > 0) return f < u - 1 && (t.leaf = void 0, s.pop()), f < d && (t.internalSpine = r.slice(0, f + 1)), t.currentKey = r[f][--s[f]].maxKey(), !0;
					f--;
				}
				return !1;
			} else {
				var m = --s[u - 1];
				return t.currentKey = o.keys[m], !0;
			}
		} else {
			var y = r.length, w = y - 1, E = r[w][s[w]];
			if (E.isLeaf) {
				t.leaf = E;
				var m = s[y] = E.values.length - 1;
				t.currentKey = E.keys[m];
			} else {
				var A = E.children;
				r[y] = A;
				var B = A.length - 1;
				s[y] = B, t.currentKey = A[B].maxKey();
			}
			return !0;
		}
	}, e.compare = function(t, n, r) {
		var s = t.height, o = t.currentKey, u = t.levelIndices, c = n.height, d = n.currentKey, f = n.levelIndices, m = r(d, o);
		if (m !== 0) return m;
		var y = s < c ? s : c;
		return u.length - (s - y) - (f.length - (c - y));
	}, e.prototype.keys = function(t) {
		var n = this.entries(t, ao);
		return ds(function() {
			var r = n.next();
			return r.value && (r.value = r.value[0]), r;
		});
	}, e.prototype.values = function(t) {
		var n = this.entries(t, ao);
		return ds(function() {
			var r = n.next();
			return r.value && (r.value = r.value[1]), r;
		});
	}, Object.defineProperty(e.prototype, "maxNodeSize", {
		get: function() {
			return this._maxNodeSize;
		},
		enumerable: !1,
		configurable: !0
	}), e.prototype.minKey = function() {
		return this._root.minKey();
	}, e.prototype.maxKey = function() {
		return this._root.maxKey();
	}, e.prototype.clone = function() {
		this._root.isShared = !0;
		var t = new e(void 0, this._compare, this._maxNodeSize);
		return t._root = this._root, t._size = this._size, t;
	}, e.prototype.greedyClone = function(t) {
		var n = new e(void 0, this._compare, this._maxNodeSize);
		return n._root = this._root.greedyClone(t), n._size = this._size, n;
	}, e.prototype.toArray = function(t) {
		t === void 0 && (t = 2147483647);
		var n = this.minKey(), r = this.maxKey();
		return n !== void 0 ? this.getRange(n, r, !0, t) : [];
	}, e.prototype.keysArray = function() {
		var t = [];
		return this._root.forRange(this.minKey(), this.maxKey(), !0, !1, this, 0, function(n, r) {
			t.push(n);
		}), t;
	}, e.prototype.valuesArray = function() {
		var t = [];
		return this._root.forRange(this.minKey(), this.maxKey(), !0, !1, this, 0, function(n, r) {
			t.push(r);
		}), t;
	}, e.prototype.toString = function() {
		return this.toArray().toString();
	}, e.prototype.setIfNotPresent = function(t, n) {
		return this.set(t, n, !1);
	}, e.prototype.nextHigherPair = function(t, n) {
		return n = n || [], t === void 0 ? this._root.minPair(n) : this._root.getPairOrNextHigher(t, this._compare, !1, n);
	}, e.prototype.nextHigherKey = function(t) {
		var n = this.nextHigherPair(t, ao);
		return n && n[0];
	}, e.prototype.nextLowerPair = function(t, n) {
		return n = n || [], t === void 0 ? this._root.maxPair(n) : this._root.getPairOrNextLower(t, this._compare, !1, n);
	}, e.prototype.nextLowerKey = function(t) {
		var n = this.nextLowerPair(t, ao);
		return n && n[0];
	}, e.prototype.getPairOrNextLower = function(t, n) {
		return this._root.getPairOrNextLower(t, this._compare, !0, n || []);
	}, e.prototype.getPairOrNextHigher = function(t, n) {
		return this._root.getPairOrNextHigher(t, this._compare, !0, n || []);
	}, e.prototype.changeIfPresent = function(t, n) {
		return this.editRange(t, t, !0, function(r, s) {
			return { value: n };
		}) !== 0;
	}, e.prototype.getRange = function(t, n, r, s) {
		s === void 0 && (s = 67108863);
		var o = [];
		return this._root.forRange(t, n, r, !1, this, 0, function(u, c) {
			return o.push([u, c]), o.length > s ? i3 : void 0;
		}), o;
	}, e.prototype.setPairs = function(t, n) {
		for (var r = 0, s = 0; s < t.length; s++) this.set(t[s][0], t[s][1], n) && r++;
		return r;
	}, e.prototype.forRange = function(t, n, r, s, o) {
		var u = this._root.forRange(t, n, r, !1, this, o || 0, s);
		return typeof u == "number" ? u : u.break;
	}, e.prototype.editRange = function(t, n, r, s, o) {
		var u = this._root;
		u.isShared && (this._root = u = u.clone());
		try {
			var c = u.forRange(t, n, r, !0, this, o || 0, s);
			return typeof c == "number" ? c : c.break;
		} finally {
			for (var d = void 0; u.keys.length <= 1 && !u.isLeaf;) d || (d = u.isShared), this._root = u = u.keys.length === 0 ? il : u.children[0];
			d && (u.isShared = !0);
		}
	}, e.prototype.editAll = function(t, n) {
		return this.editRange(this.minKey(), this.maxKey(), !0, t, n);
	}, e.prototype.deleteRange = function(t, n, r) {
		return this.editRange(t, n, r, Wg);
	}, e.prototype.deleteKeys = function(t) {
		for (var n = 0, r = 0; n < t.length; n++) this.delete(t[n]) && r++;
		return r;
	}, Object.defineProperty(e.prototype, "height", {
		get: function() {
			for (var t = this._root, n = -1; t;) n++, t = t.isLeaf ? void 0 : t.children[0];
			return n;
		},
		enumerable: !1,
		configurable: !0
	}), e.prototype.freeze = function() {
		var t = this;
		t.clear = t.set = t.editRange = function() {
			throw new Error("Attempted to modify a frozen BTree");
		};
	}, e.prototype.unfreeze = function() {
		delete this.clear, delete this.set, delete this.editRange;
	}, Object.defineProperty(e.prototype, "isFrozen", {
		get: function() {
			return this.hasOwnProperty("editRange");
		},
		enumerable: !1,
		configurable: !0
	}), e.prototype.checkValid = function() {
		var t = this._root.checkValid(0, this, 0);
		On(t === this.size, "size mismatch: counted ", t, "but stored", this.size);
	}, e;
}();
xr.default = _r;
function n3(e) {
	return e;
}
xr.asSet = n3;
Symbol && Symbol.iterator && (_r.prototype[Symbol.iterator] = _r.prototype.entries);
_r.prototype.where = _r.prototype.filter;
_r.prototype.setRange = _r.prototype.setPairs;
_r.prototype.add = _r.prototype.set;
function ds(e) {
	e === void 0 && (e = function() {
		return {
			done: !0,
			value: void 0
		};
	});
	var t = { next: e };
	return Symbol && Symbol.iterator && (t[Symbol.iterator] = function() {
		return this;
	}), t;
}
var Wy = function() {
	function e(t, n) {
		t === void 0 && (t = []), this.keys = t, this.values = n || jt, this.isShared = void 0;
	}
	return Object.defineProperty(e.prototype, "isLeaf", {
		get: function() {
			return this.children === void 0;
		},
		enumerable: !1,
		configurable: !0
	}), e.prototype.maxKey = function() {
		return this.keys[this.keys.length - 1];
	}, e.prototype.indexOf = function(t, n, r) {
		for (var s = this.keys, o = 0, u = s.length, c = u >> 1; o < u;) {
			var d = r(s[c], t);
			if (d < 0) o = c + 1;
			else if (d > 0) u = c;
			else {
				if (d === 0) return c;
				if (t === t) return s.length;
				throw new Error("BTree: NaN was used as a key");
			}
			c = o + u >> 1;
		}
		return c ^ n;
	}, e.prototype.minKey = function() {
		return this.keys[0];
	}, e.prototype.minPair = function(t) {
		if (this.keys.length !== 0) return t[0] = this.keys[0], t[1] = this.values[0], t;
	}, e.prototype.maxPair = function(t) {
		if (this.keys.length !== 0) {
			var n = this.keys.length - 1;
			return t[0] = this.keys[n], t[1] = this.values[n], t;
		}
	}, e.prototype.clone = function() {
		var t = this.values;
		return new e(this.keys.slice(0), t === jt ? t : t.slice(0));
	}, e.prototype.greedyClone = function(t) {
		return this.isShared && !t ? this : this.clone();
	}, e.prototype.get = function(t, n, r) {
		var s = this.indexOf(t, -1, r._compare);
		return s < 0 ? n : this.values[s];
	}, e.prototype.getPairOrNextLower = function(t, n, r, s) {
		var o = this.indexOf(t, -1, n), u = o < 0 ? ~o - 1 : r ? o : o - 1;
		if (u >= 0) return s[0] = this.keys[u], s[1] = this.values[u], s;
	}, e.prototype.getPairOrNextHigher = function(t, n, r, s) {
		var o = this.indexOf(t, -1, n), u = o < 0 ? ~o : r ? o : o + 1, c = this.keys;
		if (u < c.length) return s[0] = c[u], s[1] = this.values[u], s;
	}, e.prototype.checkValid = function(t, n, r) {
		var s = this.keys.length, o = this.values.length;
		return On(this.values === jt ? s <= o : s === o, "keys/values length mismatch: depth", t, "with lengths", s, o, "and baseIndex", r), On(t == 0 || s > 0, "empty leaf at depth", t, "and baseIndex", r), s;
	}, e.prototype.set = function(t, n, r, s) {
		var o = this.indexOf(t, -1, s._compare);
		if (o < 0) {
			if (o = ~o, s._size++, this.keys.length < s._maxNodeSize) return this.insertInLeaf(o, t, n, s);
			var u = this.splitOffRightSide(), c = this;
			return o > this.keys.length && (o -= this.keys.length, c = u), c.insertInLeaf(o, t, n, s), u;
		} else return r !== !1 && (n !== void 0 && this.reifyValues(), this.keys[o] = t, this.values[o] = n), !1;
	}, e.prototype.reifyValues = function() {
		return this.values === jt ? this.values = this.values.slice(0, this.keys.length) : this.values;
	}, e.prototype.insertInLeaf = function(t, n, r, s) {
		if (this.keys.splice(t, 0, n), this.values === jt) {
			for (; jt.length < s._maxNodeSize;) jt.push(void 0);
			if (r === void 0) return !0;
			this.values = jt.slice(0, this.keys.length - 1);
		}
		return this.values.splice(t, 0, r), !0;
	}, e.prototype.takeFromRight = function(t) {
		var n = this.values;
		t.values === jt ? n !== jt && n.push(void 0) : (n = this.reifyValues(), n.push(t.values.shift())), this.keys.push(t.keys.shift());
	}, e.prototype.takeFromLeft = function(t) {
		var n = this.values;
		t.values === jt ? n !== jt && n.unshift(void 0) : (n = this.reifyValues(), n.unshift(t.values.pop())), this.keys.unshift(t.keys.pop());
	}, e.prototype.splitOffRightSide = function() {
		var t = this.keys.length >> 1;
		return new e(this.keys.splice(t), this.values === jt ? jt : this.values.splice(t));
	}, e.prototype.forRange = function(t, n, r, s, o, u, c) {
		var d = o._compare, f, m;
		if (n === t) {
			if (!r || (m = (f = this.indexOf(t, -1, d)) + 1, f < 0)) return u;
		} else f = this.indexOf(t, 0, d), m = this.indexOf(n, -1, d), m < 0 ? m = ~m : r === !0 && m++;
		var y = this.keys, w = this.values;
		if (c !== void 0) for (var E = f; E < m; E++) {
			var A = y[E], B = c(A, w[E], u++);
			if (B !== void 0) {
				if (s === !0) {
					if (A !== y[E] || this.isShared === !0) throw new Error("BTree illegally changed or cloned in editRange");
					B.delete ? (this.keys.splice(E, 1), this.values !== jt && this.values.splice(E, 1), o._size--, E--, m--) : B.hasOwnProperty("value") && (w[E] = B.value);
				}
				if (B.break !== void 0) return B;
			}
		}
		else u += m - f;
		return u;
	}, e.prototype.mergeSibling = function(t, n) {
		if (this.keys.push.apply(this.keys, t.keys), this.values === jt) {
			if (t.values === jt) return;
			this.values = this.values.slice(0, this.keys.length);
		}
		this.values.push.apply(this.values, t.reifyValues());
	}, e;
}(), r3 = function(e) {
	e3(t, e);
	function t(n, r) {
		var s = this;
		if (!r) {
			r = [];
			for (var o = 0; o < n.length; o++) r[o] = n[o].maxKey();
		}
		return s = e.call(this, r) || this, s.children = n, s;
	}
	return t.prototype.clone = function() {
		for (var n = this.children.slice(0), r = 0; r < n.length; r++) n[r].isShared = !0;
		return new t(n, this.keys.slice(0));
	}, t.prototype.greedyClone = function(n) {
		if (this.isShared && !n) return this;
		for (var r = new t(this.children.slice(0), this.keys.slice(0)), s = 0; s < r.children.length; s++) r.children[s] = r.children[s].greedyClone(n);
		return r;
	}, t.prototype.minKey = function() {
		return this.children[0].minKey();
	}, t.prototype.minPair = function(n) {
		return this.children[0].minPair(n);
	}, t.prototype.maxPair = function(n) {
		return this.children[this.children.length - 1].maxPair(n);
	}, t.prototype.get = function(n, r, s) {
		var o = this.indexOf(n, 0, s._compare), u = this.children;
		return o < u.length ? u[o].get(n, r, s) : void 0;
	}, t.prototype.getPairOrNextLower = function(n, r, s, o) {
		var u = this.indexOf(n, 0, r), c = this.children;
		if (u >= c.length) return this.maxPair(o);
		var d = c[u].getPairOrNextLower(n, r, s, o);
		return d === void 0 && u > 0 ? c[u - 1].maxPair(o) : d;
	}, t.prototype.getPairOrNextHigher = function(n, r, s, o) {
		var u = this.indexOf(n, 0, r), c = this.children, d = c.length;
		if (!(u >= d)) {
			var f = c[u].getPairOrNextHigher(n, r, s, o);
			return f === void 0 && u < d - 1 ? c[u + 1].minPair(o) : f;
		}
	}, t.prototype.checkValid = function(n, r, s) {
		var o = this.keys.length, u = this.children.length;
		On(o === u, "keys/children length mismatch: depth", n, "lengths", o, u, "baseIndex", s), On(o > 1 || n > 0, "internal node has length", o, "at depth", n, "baseIndex", s);
		for (var c = 0, d = this.children, f = this.keys, m = 0, y = 0; y < u; y++) c += d[y].checkValid(n + 1, r, s + c), m += d[y].keys.length, On(c >= m, "wtf", s), On(y === 0 || d[y - 1].constructor === d[y].constructor, "type mismatch, baseIndex:", s), d[y].maxKey() != f[y] && On(!1, "keys[", y, "] =", f[y], "is wrong, should be ", d[y].maxKey(), "at depth", n, "baseIndex", s), y === 0 || r._compare(f[y - 1], f[y]) < 0 || On(!1, "sort violation at depth", n, "index", y, "keys", f[y - 1], f[y]);
		var w = m === 0;
		return (w || m > r.maxNodeSize * u) && On(!1, w ? "too few" : "too many", "children (", m, c, ") at depth", n, "maxNodeSize:", r.maxNodeSize, "children.length:", u, "baseIndex:", s), c;
	}, t.prototype.set = function(n, r, s, o) {
		var u = this.children, c = o._maxNodeSize, d = o._compare, f = Math.min(this.indexOf(n, 0, d), u.length - 1), m = u[f];
		if (m.isShared && (u[f] = m = m.clone()), m.keys.length >= c) {
			var y;
			f > 0 && (y = u[f - 1]).keys.length < c && d(m.keys[0], n) < 0 ? (y.isShared && (u[f - 1] = y = y.clone()), y.takeFromRight(m), this.keys[f - 1] = y.maxKey()) : (y = u[f + 1]) !== void 0 && y.keys.length < c && d(m.maxKey(), n) < 0 && (y.isShared && (u[f + 1] = y = y.clone()), y.takeFromLeft(m), this.keys[f] = u[f].maxKey());
		}
		var w = m.set(n, r, s, o);
		if (w === !1) return !1;
		if (this.keys[f] = m.maxKey(), w === !0) return !0;
		if (this.keys.length < c) return this.insert(f + 1, w), !0;
		var E = this.splitOffRightSide(), A = this;
		return d(w.maxKey(), this.maxKey()) > 0 && (A = E, f -= this.keys.length), A.insert(f + 1, w), E;
	}, t.prototype.insert = function(n, r) {
		this.children.splice(n, 0, r), this.keys.splice(n, 0, r.maxKey());
	}, t.prototype.splitOffRightSide = function() {
		var n = this.children.length >> 1;
		return new t(this.children.splice(n), this.keys.splice(n));
	}, t.prototype.takeFromRight = function(n) {
		this.keys.push(n.keys.shift()), this.children.push(n.children.shift());
	}, t.prototype.takeFromLeft = function(n) {
		this.keys.unshift(n.keys.pop()), this.children.unshift(n.children.pop());
	}, t.prototype.forRange = function(n, r, s, o, u, c, d) {
		var f = u._compare, m = this.keys, y = this.children, w = this.indexOf(n, 0, f), E = w, A = Math.min(r === n ? w : this.indexOf(r, 0, f), m.length - 1);
		if (o) {
			if (E <= A) try {
				for (; E <= A; E++) {
					y[E].isShared && (y[E] = y[E].clone());
					var B = y[E].forRange(n, r, s, o, u, c, d);
					if (m[E] = y[E].maxKey(), typeof B != "number") return B;
					c = B;
				}
			} finally {
				var T = u._maxNodeSize >> 1;
				for (w > 0 && w--, E = A; E >= w; E--) y[E].keys.length <= T && (y[E].keys.length !== 0 ? this.tryMerge(E, u._maxNodeSize) : (m.splice(E, 1), y.splice(E, 1)));
				y.length !== 0 && y[0].keys.length === 0 && On(!1, "emptiness bug");
			}
		} else for (; E <= A; E++) {
			var B = y[E].forRange(n, r, s, o, u, c, d);
			if (typeof B != "number") return B;
			c = B;
		}
		return c;
	}, t.prototype.tryMerge = function(n, r) {
		var s = this.children;
		return n >= 0 && n + 1 < s.length && s[n].keys.length + s[n + 1].keys.length <= r ? (s[n].isShared && (s[n] = s[n].clone()), s[n].mergeSibling(s[n + 1], r), s.splice(n + 1, 1), this.keys.splice(n + 1, 1), this.keys[n] = s[n].maxKey(), !0) : !1;
	}, t.prototype.mergeSibling = function(n, r) {
		var s = this.keys.length;
		this.keys.push.apply(this.keys, n.keys);
		var o = n.children;
		if (this.children.push.apply(this.children, o), n.isShared && !this.isShared) for (var u = 0; u < o.length; u++) o[u].isShared = !0;
		this.tryMerge(s - 1, r);
	}, t;
}(Wy), jt = [], Ky = { delete: !0 }, Wg = function() {
	return Ky;
}, i3 = { break: !0 }, il = function() {
	var e = new Wy();
	return e.isShared = !0, e;
}(), Kg = [], ao = [];
function On(e) {
	for (var t = [], n = 1; n < arguments.length; n++) t[n - 1] = arguments[n];
	if (!e) throw t.unshift("B+ tree"), new Error(t.join(" "));
}
xr.EmptyBTree = function() {
	var e = new _r();
	return e.freeze(), e;
}();
var pf;
((e) => {
	function t(n, r) {
		return r === "link" ? m3(n) : r in n;
	}
	e.is = t;
})(pf || (pf = {}));
function m3(e) {
	return typeof e == "object" && e !== null && "link" in e && "url" in e.link;
}
Cn("urbitUtils", !1);
function b3(e) {
	return e ? e.trim().startsWith("~") ? e.trim() : "~".concat(e.trim()) : "";
}
function _o(e) {
	return e ? e.trim().replace("~", "") : "";
}
var Xg;
((e) => {
	function t(n, r) {
		return r in n;
	}
	e.is = t;
})(Xg || (Xg = {}));
async function I3(e) {
	return await new Promise((t, n) => {
		const r = new FileReader();
		r.onload = () => t(r.result), r.onerror = n, r.readAsArrayBuffer(e);
	});
}
function sl(e) {
	const t = new AbortController(), n = t.signal, r = setTimeout(() => {
		t.abort();
	}, e);
	return n.addEventListener("abort", () => {
		clearTimeout(r);
	}, { once: !0 }), n.cleanup = () => {
		clearTimeout(r);
	}, n;
}
var k3 = class {
	constructor() {
		P(this, "listeners", {});
	}
	on(t, n) {
		return t in this.listeners || (this.listeners[t] = []), this.listeners[t].push(n), this;
	}
	off(t, n) {
		if (!(t in this.listeners)) return;
		const r = this.listeners[t].findIndex((s) => s === n);
		return r !== -1 && this.listeners[t].splice(r, 1), this;
	}
	emit(t, ...n) {
		if (t in this.listeners) for (let r = 0; r < this.listeners[t].length; r++) this.listeners[t][r].apply(this, n);
	}
};
var R3 = class extends Error {};
var hD = class extends Error {};
var Hi = class extends Error {};
var T3 = class extends Error {};
var gf = class extends Error {
	constructor(n, r, s) {
		super(n);
		P(this, "status");
		P(this, "text");
		this.status = r, this.text = s;
	}
};
async function P3(e, t, n) {
	const r = e.getReader();
	let s = {
		done: !1,
		value: new Uint8Array()
	};
	for (; s && !s.done;) {
		if (s = await Promise.race([r.read(), new Promise((o, u) => {
			setTimeout(() => u(/* @__PURE__ */ new Error("getBytes timed out")), n);
		})]), !s.value) {
			console.warn("Empty chunk received from server");
			continue;
		}
		try {
			t(s.value);
		} catch (o) {
			console.error("Error processing chunk:", o);
		}
	}
}
function N3(e) {
	let t, n, r, s = !1;
	return function(u) {
		t === void 0 ? (t = u, n = 0, r = -1) : t = U3(t, u);
		const c = t.length;
		let d = 0;
		for (; n < c;) {
			s && (t[n] === 10 && (d = ++n), s = !1);
			let f = -1;
			for (; n < c && f === -1; ++n) switch (t[n]) {
				case 58:
					r === -1 && (r = n - d);
					break;
				case 13: s = !0;
				case 10:
					f = n;
					break;
			}
			if (f === -1) break;
			e(t.subarray(d, f), r), d = n, r = -1;
		}
		d === c ? t = void 0 : d !== 0 && (t = t.subarray(d), n -= d);
	};
}
function O3(e, t, n) {
	let r = ol();
	const s = new TextDecoder();
	return function(u, c) {
		if (u.length === 0) e?.(r), r = ol();
		else if (c > 0) {
			const d = s.decode(u.subarray(0, c)), f = c + (u[c + 1] === 32 ? 2 : 1), m = s.decode(u.subarray(f));
			switch (d) {
				case "data":
					r.data = r.data ? r.data + `
` + m : m;
					break;
				case "event":
					r.event = m;
					break;
				case "id":
					r = ol(), t?.(r.id = m);
					break;
				case "retry":
					const y = parseInt(m, 10);
					isNaN(y) || n == null || n(r.retry = y);
					break;
			}
		}
	};
}
function U3(e, t) {
	const n = new Uint8Array(e.length + t.length);
	return n.set(e), n.set(t, e.length), n;
}
function ol() {
	return {
		data: "",
		event: "",
		id: "",
		retry: void 0
	};
}
const mf = "text/event-stream", M3 = 1e3, Yg = "last-event-id";
function Qg(e, { signal: t, headers: n, onopen: r, onmessage: s, onclose: o, onerror: u, openWhenHidden: c, fetch: d, responseTimeout: f, ...m }) {
	return new Promise((y, w) => {
		const E = { ...n };
		E.accept || (E.accept = mf);
		let A, B = M3, T;
		function $() {
			clearTimeout(T), A.abort();
		}
		t?.addEventListener("abort", () => {
			$(), y();
		});
		const V = d ?? fetch, H = r ?? $3;
		let Q = !1;
		async function te() {
			A = new AbortController();
			try {
				const ge = await Promise.race([V(e, {
					...m,
					headers: E,
					signal: A.signal
				}), new Promise((De, rt) => {
					setTimeout(() => rt(new T3("Request timed out")), f);
				})]);
				if (ge.status === 404) {
					$(), u?.(new hD("Channel reaped")), y();
					return;
				} else if (ge.status === 500) {
					$(), u?.(new gf("Server error", 500)), y();
					return;
				}
				if (ge.status < 200 || ge.status >= 300) throw new gf("Invalid server response", ge.status);
				await H(ge, Q), Q && (Q = !1), await P3(ge.body, N3(O3(s, (De) => {
					De ? E[Yg] = De : delete E[Yg];
				}, (De) => {
					B = De;
				})), f), o?.(), $(), y();
			} catch (ge) {
				if (!A.signal.aborted) try {
					Q = !0, A.abort();
					const De = (u == null ? void 0 : u(ge)) ?? B;
					clearTimeout(T), T = setTimeout(te, De);
				} catch (De) {
					$(), w(De);
				}
			}
		}
		te();
	});
}
function $3(e) {
	const t = e.headers.get("content-type");
	if (!(t != null && t.startsWith(mf))) throw new Error(`Expected content-type to be ${mf}, Actual: ${t}`);
}
async function L3(e) {
	const t = [...new Uint8Array(e)].reverse().map((n) => n.toString(16).padStart(2, "0")).join("");
	return qy(Y.fromString(t, 16));
}
function Wa(e) {
	const n = Math.pow(16, Math.min(e, 8) - 1), r = Math.pow(16, Math.min(e, 8)) - 1;
	let o = (Math.floor(Math.random() * (r - n + 1)) + n).toString(16);
	for (; o.length < e;) o = o + Wa(e - 8);
	return o;
}
const al = Cn("UrbitHttpApi", !1);
function z3(e) {
	return e instanceof Y || e instanceof ze;
}
var nu = class nu {
	/**
	* Constructs a new Urbit connection.
	*
	* @param url  The URL (with protocol and port) of the ship to be accessed. If
	* the airlock is running in a webpage served by the ship, this should just
	* be the empty string.
	* @param code The access code for the ship at that address
	*/
	constructor(t, n, r, s) {
		/**
		* Event emitter for debugging, see events.ts for full list of events
		*/
		P(this, "emitter", new k3());
		/**
		* UID will be used for the channel: The current unix time plus a random hex string
		*/
		P(this, "uid", `${Math.floor(Date.now() / 1e3)}-${Wa(6)}`);
		/**
		* lastEventId is an auto-updated index of which events have been *sent* over this channel.
		* lastHeardEventId is the latest event we have heard back about.
		* lastAcknowledgedEventId is the latest event we have sent an ack for.
		*/
		P(this, "lastEventId", 0);
		P(this, "lastHeardEventId", -1);
		P(this, "lastAcknowledgedEventId", -1);
		/**
		* SSE Client is null for now; we don't want to start polling until it the channel exists
		*/
		P(this, "sseClientInitialized", !1);
		/**
		* Cookie gets set when we log in.
		*/
		P(this, "cookie");
		/**
		* A registry of requestId to successFunc/failureFunc
		*
		* These functions are registered during a +poke and are executed
		* in the onServerEvent()/onServerError() callbacks. Only one of
		* the functions will be called, and the outstanding poke will be
		* removed after calling the success or failure function.
		*/
		P(this, "outstandingPokes", /* @__PURE__ */ new Map());
		/**
		* A registry of requestId to subscription functions.
		*
		* These functions are registered during a +subscribe and are
		* executed in the onServerEvent()/onServerError() callbacks. The
		* event function will be called whenever a new piece of data on this
		* subscription is available, which may be 0, 1, or many times. The
		* disconnect function may be called exactly once.
		*/
		P(this, "outstandingSubscriptions", /* @__PURE__ */ new Map());
		/**
		* Our abort controller, used to close the connection
		*/
		P(this, "channelAbort", new AbortController());
		/**
		* Identity of the ship we're connected to
		*/
		P(this, "nodeId");
		/**
		* Our identity, with which we are authenticated into the ship
		*/
		P(this, "our");
		/**
		* If verbose, logs output eagerly.
		*/
		P(this, "verbose");
		/**
		* number of consecutive errors in connecting to the eventsource
		*/
		P(this, "errorCount", 0);
		/**
		* Custom fetch implementation to use.
		*/
		P(this, "fetchFn", (t, n) => fetch(t, n));
		return this.url = t, this.code = n, this.desk = r, qr && window.addEventListener("beforeunload", this.delete), s && (this.fetchFn = s), this;
	}
	/** This is basic interpolation to get the channel URL of an instantiated Urbit connection. */
	get channelUrl() {
		return `${this.url}/~/channel/${this.uid}`;
	}
	get fetchOptions() {
		const t = { "Content-Type": "application/json" };
		return !qr && this.cookie && (t.Cookie = this.cookie), {
			credentials: qr ? "include" : void 0,
			accept: "*",
			headers: t
		};
	}
	fetchOptionsNoun(t = "PUT", n = "noun") {
		let r;
		switch (n) {
			case "noun":
				r = "application/x-urb-jam";
				break;
			case "json":
				r = "application/json";
				break;
		}
		const s = {};
		switch (t) {
			case "PUT":
				s["Content-Type"] = r, s.Accept = r;
				break;
			case "GET":
				s["X-Channel-Format"] = r;
				break;
		}
		return qr || (s.Cookie = this.cookie), {
			credentials: "include",
			accept: "*",
			headers: s
		};
	}
	/**
	* All-in-one hook-me-up.
	*
	* Given a ship, url, and code, this returns an airlock connection
	* that is ready to go. It `|hi`s itself to create the channel,
	* then opens the channel via EventSource.
	*
	*/
	static async authenticate({ ship: t, url: n, code: r, verbose: s = !1 }) {
		const o = new nu(n.startsWith("http") ? n : `http://${n}`, r);
		return o.verbose = s, o.nodeId = t, await o.connect(), await o.poke({
			app: "hood",
			mark: "helm-hi",
			json: "opening airlock"
		}), await o.eventSource(), o;
	}
	emit(t, ...n) {
		this.emitter.emit(t, ...n);
	}
	on(t, n) {
		this.emitter.on(t, n), this.verbose && console.log(t, "listening active"), t === "init" && this.emitter.emit("init", {
			uid: this.uid,
			subscriptions: [...this.outstandingSubscriptions.entries()].map(([r, s]) => ({
				id: r,
				app: s.app,
				path: s.path
			}))
		});
	}
	/**
	* Gets the name of the ship accessible at this.url and stores it to this.ship
	*
	*/
	async getShipName() {
		if (this.nodeId) return Promise.resolve();
		this.nodeId = await (await this.fetchFn(`${this.url}/~/host`, {
			method: "get",
			credentials: "include"
		})).text();
	}
	/**
	* Gets the name of the ship accessible at this.url and stores it to this.ship
	*
	*/
	async getOurName() {
		const t = {};
		!qr && this.cookie && (t.Cookie = this.cookie);
		this.our = await (await this.fetchFn(`${this.url}/~/name`, {
			method: "get",
			credentials: "include",
			headers: t
		})).text();
	}
	/**
	* Connects to the Urbit ship. Nothing can be done until this is called.
	* That's why we roll it into this.authenticate
	* TODO  as of urbit/urbit#6561, this is no longer true, and we are able
	*       to interact with the ship using a guest identity.
	*/
	async connect() {
		return this.verbose && console.log(`password=${this.code} `, qr ? `Connecting in browser context at ${this.url}/~/login` : "Connecting from node context"), this.fetchFn(`${this.url}/~/login`, {
			method: "post",
			body: `password=${this.code}`,
			credentials: "include"
		}).then(async (t) => {
			var r;
			if (this.verbose && console.log("Received authentication response", t), t.status < 200 || t.status >= 300) throw new Error("Login failed with status " + t.status);
			const n = t.headers.get("set-cookie");
			if (!this.nodeId && n) this.nodeId = (r = (/* @__PURE__ */ new RegExp(/urbauth-(~[\w-]+)/)).exec(n)) == null ? void 0 : r[1];
			qr || (this.cookie = (n == null ? void 0 : n.split(";")[0].trim()) || void 0), await this.getShipName(), await this.getOurName();
		});
	}
	/**
	* Initializes the SSE pipe for the appropriate channel.
	*/
	async eventSource() {
		if (this.sseClientInitialized) return Promise.resolve();
		if (this.lastEventId === 0) {
			this.emit("status-update", { status: "opening" }), await this.poke({
				app: "hood",
				mark: "helm-hi",
				json: "Opening API channel"
			});
			return;
		}
		return this.sseClientInitialized = !0, new Promise((t, n) => {
			Qg(this.channelUrl, {
				...this.fetchOptions,
				signal: this.channelAbort.signal,
				reactNative: { textStreaming: !0 },
				openWhenHidden: !0,
				responseTimeout: 25e3,
				fetch: this.fetchFn,
				onopen: async (r, s) => {
					if (this.verbose && console.log("Opened eventsource", r), r.ok) {
						this.errorCount = 0, this.emit("status-update", { status: s ? "reconnected" : "active" }), t();
						return;
					} else n(/* @__PURE__ */ new Error("failed to open eventsource"));
				},
				onmessage: (r) => {
					var o, u, c, d, f;
					if (this.verbose && console.log("Received SSE: ", r), !r.id) return;
					const s = parseInt(r.id, 10);
					if (this.emit("fact", {
						id: s,
						data: r.data,
						time: Date.now()
					}), s <= this.lastHeardEventId) {
						this.verbose && console.log("dropping old or out-of-order event", {
							eventId: s,
							lastHeard: this.lastHeardEventId
						});
						return;
					}
					if (this.lastHeardEventId = s, this.emit("id-update", { lastHeard: this.lastHeardEventId }), s - this.lastAcknowledgedEventId > 20 && this.ack(s), r.data && JSON.parse(r.data)) {
						const m = JSON.parse(r.data);
						if (this.verbose && console.log("received data", m), m.response === "poke" && this.outstandingPokes.has(m.id)) {
							const y = this.outstandingPokes.get(m.id);
							"ok" in m && y ? (o = y.onSuccess) == null || o.call(y) : "err" in m && y ? (console.error(m.err), (u = y.onError) == null || u.call(y, m.err)) : console.error("Invalid poke response", m), this.outstandingPokes.delete(m.id);
						} else if (m.response === "subscribe" && this.outstandingSubscriptions.has(m.id)) {
							const y = this.outstandingSubscriptions.get(m.id);
							"err" in m && y && (console.error(m.err), (c = y.err) == null || c.call(y, m.err, m.id), this.outstandingSubscriptions.delete(m.id));
						} else if (m.response === "diff" && this.outstandingSubscriptions.has(m.id)) {
							const y = this.outstandingSubscriptions.get(m.id);
							try {
								(d = y == null ? void 0 : y.event) == null || d.call(y, m.json, m.mark ?? "json", m.id);
							} catch (w) {
								console.error("Failed to call subscription event callback", w);
							}
						} else if (m.response === "quit" && this.outstandingSubscriptions.has(m.id)) {
							const y = this.outstandingSubscriptions.get(m.id);
							(f = y == null ? void 0 : y.quit) == null || f.call(y, m), this.outstandingSubscriptions.delete(m.id), this.emit("subscription", {
								id: m.id,
								status: "close"
							}), y != null && y.resubOnQuit && this.subscribe(y);
						} else this.verbose && (console.log([...this.outstandingSubscriptions.keys()]), console.log("Unrecognized response", m));
					}
				},
				onerror: (r) => {
					if (this.errorCount++, this.emit("error", {
						time: Date.now(),
						msg: JSON.stringify(r),
						error: r
					}), r instanceof hD) {
						this.emit("channel-reaped", { time: Date.now() }), this.seamlessReset();
						return;
					}
					if (!(r instanceof R3)) {
						const s = {};
						if (r instanceof gf) {
							if (r.status === 500) {
								this.seamlessReset();
								return;
							}
							s.message = r.message, s.requestStatus = r.status;
						}
						return s.message = r.message, this.emit("status-update", {
							status: "reconnecting",
							context: s
						}), Math.min(5e3, Math.pow(2, this.errorCount - 1) * 750);
					}
					throw this.emit("status-update", { status: "errored" }), r;
				},
				onclose: () => {
					throw console.log("e"), /* @__PURE__ */ new Error("Ship unexpectedly closed the connection");
				}
			});
		});
	}
	/**
	* Reset airlock, abandoning current subscriptions and wiping state
	*
	*/
	reset() {
		this.verbose && console.log("resetting"), this.delete(), this.uid = `${Math.floor(Date.now() / 1e3)}-${Wa(6)}`, this.emit("reset", { uid: this.uid }), this.lastEventId = 0, this.lastHeardEventId = -1, this.lastAcknowledgedEventId = -1, this.outstandingSubscriptions = /* @__PURE__ */ new Map(), this.outstandingPokes = /* @__PURE__ */ new Map(), this.sseClientInitialized = !1;
	}
	seamlessReset() {
		this.uid = `${Math.floor(Date.now() / 1e3)}-${Wa(6)}`, this.emit("seamless-reset", { uid: this.uid }), this.emit("status-update", { status: "initial" }), this.sseClientInitialized = !1, this.lastEventId = 0, this.lastHeardEventId = -1, this.lastAcknowledgedEventId = -1;
		const t = [...this.outstandingSubscriptions.entries()];
		this.outstandingSubscriptions = /* @__PURE__ */ new Map(), t.forEach(([n, r]) => {
			var s;
			(s = r.quit) == null || s.call(r, {
				id: n,
				response: "quit"
			}), this.emit("subscription", {
				id: n,
				status: "close"
			}), r.resubOnQuit && this.subscribe(r);
		}), this.outstandingPokes.forEach((n, r) => {
			var s;
			(s = n.onError) == null || s.call(n, "Channel was reaped");
		}), this.outstandingPokes = /* @__PURE__ */ new Map();
	}
	/**
	* Autoincrements the next event ID for the appropriate channel.
	*/
	getEventId() {
		return this.lastEventId += 1, this.emit("id-update", { current: this.lastEventId }), this.lastEventId;
	}
	/**
	* Acknowledges an event.
	*
	* @param eventId The event to acknowledge.
	*/
	async ack(t) {
		this.lastAcknowledgedEventId = t, this.emit("id-update", { lastAcknowledged: t });
		const n = {
			action: "ack",
			"event-id": t
		};
		return await this.sendJSONtoChannel(n), t;
	}
	async sendNounsToChannel(...t) {
		const n = this.fetchOptionsNoun("PUT", "noun"), r = Wt("uw", Y2(Xf.list(t)).number);
		this.validatePokeBodySize(r);
		const s = await this.fetchFn(this.channelUrl, {
			...n,
			signal: this.channelAbort.signal,
			method: "PUT",
			body: r
		});
		if (!s.ok) throw console.log(s.status, s.statusText, await s.text()), /* @__PURE__ */ new Error("Failed to PUT channel command(s)");
		if (!this.sseClientInitialized) {
			if (this.verbose && console.log("initializing event source"), await Promise.all([this.getOurName(), this.getShipName()]), this.our !== this.nodeId) throw new Hi("invalid session");
			await this.eventSource();
		}
	}
	async sendJSONtoChannel(...t) {
		const n = JSON.stringify(t);
		if (this.validatePokeBodySize(n), !(await this.fetchFn(this.channelUrl, {
			...this.fetchOptions,
			signal: this.channelAbort.signal,
			method: "PUT",
			body: n
		})).ok) throw new Error("Failed to PUT channel");
		if (!this.sseClientInitialized) {
			if (this.verbose && console.log("initializing event source"), await Promise.all([this.getOurName(), this.getShipName()]), this.our !== this.nodeId) throw console.log("our name does not match ship name"), console.log("our:", this.our), console.log("ship:", this.nodeId), console.log("messages:", t), new Hi("invalid session");
			await this.eventSource();
		}
	}
	/**
	* Validates the size of the poke body.
	* This prevents us from accidentally sending large payloads (eg base64 images)
	* @param body The body to validate.
	*/
	validatePokeBodySize(t) {
		if (t.length / 1024 > 512) throw al.trackError("Body too large to send to channel"), /* @__PURE__ */ new Error("Body too large to send to channel");
	}
	/**
	* Creates a subscription, waits for a fact and then unsubscribes
	*
	* @param app Name of gall agent to subscribe to
	* @param path Path to subscribe to
	* @param timeout Optional timeout before ending subscription
	*
	* @returns The first fact on the subcription
	*/
	async subscribeOnce(t, n, r, s) {
		return new Promise((o, u) => {
			let c = !1;
			const m = {
				app: t,
				path: n,
				ship: r,
				resubOnQuit: !1,
				event: (y, w, E) => {
					c || (o(y), this.unsubscribe(E));
				},
				err: u,
				quit: () => {
					c || u("quit");
				}
			};
			this.subscribe(m).then((y) => {
				s && setTimeout(() => {
					c || (c = !0, u("timeout"), this.unsubscribe(y));
				}, s);
			});
		});
	}
	async pokeNoun(t) {
		var c;
		t.onSuccess = t.onSuccess || (() => {}), t.onError = t.onError || (() => {});
		const { app: n, mark: r, noun: s, ship: o } = {
			ship: ((c = this.nodeId) == null ? void 0 : c.replace("~", "")) || "",
			...t
		};
		this.lastEventId === 0 && this.emit("status-update", { status: "opening" });
		const u = this.getEventId();
		if (this.outstandingPokes.set(u, t), z3(s)) {
			const f = [
				"poke",
				u,
				new Y(Zf("p", `~${o}`)),
				n,
				r,
				s
			];
			await this.sendNounsToChannel(f);
		} else throw new Error("pokeNoun requires a noun");
		return u;
	}
	/**
	* Pokes a ship with data.
	*
	* @param app The app to poke
	* @param mark The mark of the data being sent
	* @param json The data to send
	*/
	async poke(t) {
		const { app: n, mark: r, json: s, ship: o, onSuccess: u, onError: c } = {
			onSuccess: () => {},
			onError: () => {},
			ship: _o(this.nodeId ?? ""),
			...t
		};
		this.lastEventId === 0 && this.emit("status-update", { status: "opening" });
		const d = {
			id: this.getEventId(),
			action: "poke",
			ship: o,
			app: n,
			mark: r,
			json: s
		};
		return new Promise((f, m) => {
			this.outstandingPokes.set(d.id, {
				onSuccess: () => {
					u(), f(d.id);
				},
				onError: (y) => {
					c(y), m(y);
				}
			}), this.sendJSONtoChannel(d).catch(m);
		});
	}
	/**
	* Subscribes to a path on an app on a ship.
	*
	*
	* @param app The app to subsribe to
	* @param path The path to which to subscribe
	* @param handlers Handlers to deal with various events of the subscription
	*/
	async subscribe(t) {
		const { app: n, path: r, ship: s, resubOnQuit: o, err: u, event: c, quit: d } = {
			err: () => {},
			event: () => {},
			quit: () => {},
			resubOnQuit: !0,
			...t,
			ship: _o(t.ship ?? this.nodeId ?? "")
		};
		this.lastEventId === 0 && this.emit("status-update", { status: "opening" });
		const f = {
			id: this.getEventId(),
			action: "subscribe",
			ship: s,
			app: n,
			path: r
		};
		return this.outstandingSubscriptions.set(f.id, {
			app: n,
			path: r,
			resubOnQuit: o,
			err: u,
			event: c,
			quit: d
		}), this.emit("subscription", {
			id: f.id,
			app: n,
			path: r,
			status: "open"
		}), await this.sendJSONtoChannel(f), f.id;
	}
	/**
	* Unsubscribes to a given subscription.
	*
	* @param subscription
	*/
	async unsubscribe(t) {
		return this.sendJSONtoChannel({
			id: this.getEventId(),
			action: "unsubscribe",
			subscription: t
		}).then(() => {
			this.emit("subscription", {
				id: t,
				status: "close"
			}), this.outstandingSubscriptions.delete(t);
		});
	}
	/**
	* Deletes the connection to a channel.
	*/
	async delete() {
		this.channelAbort.abort(), this.channelAbort = new AbortController();
		const t = JSON.stringify([{
			id: this.getEventId(),
			action: "delete"
		}]);
		if (qr) navigator.sendBeacon(this.channelUrl, t);
		else if (!(await this.fetchFn(this.channelUrl, {
			...this.fetchOptions,
			signal: this.channelAbort.signal,
			method: "POST",
			body: t
		})).ok) throw new Error("Failed to DELETE channel in node context");
	}
	async checkIsNodeBusy() {
		try {
			const t = await this.fetchFn(`${this.url}/~_~/healthz`, { method: "GET" });
			return t.status === 204 ? "available" : t.status === 429 ? "busy" : (al.trackEvent("Unexpected node busy response", { status: t.status }), "unknown");
		} catch (t) {
			return al.trackEvent("Failed to check if node is busy", { error: t }), "unknown";
		}
	}
	/**
	* Scry into an gall agent at a path
	*
	* @typeParam T - Type of the scry result
	*
	* @remarks
	*
	* Equivalent to
	* ```hoon
	* .^(T %gx /(scot %p our)/[app]/(scot %da now)/[path]/json)
	* ```
	* The returned cage must have a conversion to JSON for the scry to succeed
	*
	* @param params The scry request
	* @returns The scry result
	*/
	async scry(t) {
		const { result: n } = await this.scryWithInfo(t);
		return n;
	}
	async scryWithInfo(t) {
		const { app: n, path: r, timeout: s } = t, o = s ? sl(s) : void 0, u = await this.fetchFn(`${this.url}/~/scry/${n}${r}.json`, {
			...this.fetchOptions,
			signal: o
		});
		if (o?.cleanup(), !u.ok) return Promise.reject(u);
		const c = await u.json(), d = u.headers.get("content-length");
		return {
			responseStatus: u.status,
			responseSizeInBytes: Number(d),
			result: c
		};
	}
	async scryNoun(t) {
		const { result: n } = await this.scryNounWithInfo(t);
		return n;
	}
	async scryNounWithInfo(t) {
		const { app: n, path: r } = t;
		try {
			const s = await this.fetchFn(`${this.url}/~/scry/${n}${r}.noun`, { ...this.fetchOptionsNoun("GET", "noun") });
			if (!s.ok) return Promise.reject(s);
			const u = await I3(await s.blob());
			try {
				const c = await L3(u), d = s.headers.get("content-length");
				return {
					responseStatus: s.status,
					responseSizeInBytes: Number(d),
					result: c
				};
			} catch (c) {
				throw console.error("Unpack failed", c), c;
			}
		} catch (s) {
			throw console.error(s), s;
		}
	}
	/**
	* Run a thread
	*
	*
	* @param inputMark   The mark of the data being sent
	* @param outputMark  The mark of the data being returned
	* @param threadName  The thread to run
	* @param body        The data to send to the thread
	* @returns  The return value of the thread
	*/
	async thread(t) {
		const { inputMark: n, outputMark: r, threadName: s, body: o, timeout: u, desk: c = this.desk } = t;
		if (!c) throw new Error("Must supply desk to run thread from");
		const d = u ? sl(u) : void 0, f = await this.fetchFn(`${this.url}/spider/${c}/${n}/${s}/${r}.json`, {
			...this.fetchOptions,
			signal: d,
			method: "POST",
			body: JSON.stringify(o)
		});
		return d?.cleanup(), f;
	}
	async getSpinHints() {
		return new Promise((t, n) => {
			const r = new AbortController();
			let s = !1;
			Qg(`${this.url}/~_~/spin`, {
				signal: r.signal,
				reactNative: { textStreaming: !0 },
				openWhenHidden: !0,
				responseTimeout: 25e3,
				fetch: this.fetchFn,
				onmessage(o) {
					s || (s = !0, r.abort(), t(o.data));
				},
				onerror(o) {
					r.abort(), n(o);
				}
			});
		});
	}
	/**
	* Perform a standard HTTP request using the channel's authentication
	*
	* @param path The path to request (relative to the ship's URL)
	* @param options Request options (method, headers, body, etc.)
	* @returns The response from the request
	*/
	async request(t, n = {}, r) {
		t.startsWith("/") || (t = "/" + t);
		const s = r ? sl(r) : void 0, o = {
			...this.fetchOptions,
			...n,
			headers: {
				...this.fetchOptions.headers,
				...n.headers || {}
			},
			signal: s
		};
		!qr && this.cookie && (o.headers = {
			...o.headers,
			Cookie: this.cookie
		});
		const u = await this.fetchFn(`${this.url}${t}`, o);
		if (s?.cleanup(), !u.ok) return Promise.reject(u);
		const c = u.headers.get("content-type");
		return c != null && c.includes("application/json") ? u.json() : c != null && c.includes("text/") ? u.text() : u.blob();
	}
	/**
	* Utility function to connect to a ship that has its *.arvo.network domain configured.
	*
	* @param name Name of the ship e.g. zod
	* @param code Code to log in
	*/
	static async onArvoNetwork(t, n) {
		const r = `https://${t}.arvo.network`;
		return await nu.authenticate({
			ship: t,
			url: r,
			code: n
		});
	}
};
const H3 = async (e, t) => {
	var r;
	const n = await fetch(`${e}/~/login`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
		body: `password=${t}`,
		credentials: "include"
	});
	if (n.status < 200 || n.status > 299) throw new Error("Failed to authenticate. Is your access code correct?");
	return (r = n.headers.get("set-cookie")) == null ? void 0 : r.split(";")[0];
}, _e = Cn("urbit", !1), ru = 60 * 1e3;
var Mo = class extends Error {
	constructor(t, n) {
		super(), this.status = t, this.body = n;
	}
};
Error;
const ne = {
	client: null,
	lastStatus: "",
	shipUrl: "",
	subWatchers: {},
	pendingAuth: null,
	onQuitOrReset: void 0,
	getCode: void 0,
	handleAuthFailure: void 0
}, Es = new Proxy({}, { get: function(e, t, n) {
	if (!ne.client) throw new Error("Urbit client not set.");
	return Reflect.get(ne.client, t, n);
} }), Ir = () => {
	if (!Es.nodeId) throw new Error("Client not initialized");
	return Es.nodeId;
}, q3 = () => {
	if (!Es.nodeId) throw new Error("Client not initialized");
	if (Es.url) return Rg(Es.url);
	const e = Li();
	return Rg(fy() ? e.DEV_SHIP_URL : window.location.hostname);
};
async function AO({ shipName: e, shipUrl: t, verbose: n, fetchFn: r, getCode: s, handleAuthFailure: o, onQuitOrReset: u, onChannelStatusChange: c, client: d }) {
	const f = !d && s ? await s() : "";
	ne.client = d || ne.client || new nu(t, f, "", r), ne.client.verbose = n, ne.client.nodeId = b3(e), ne.shipUrl = t, ne.onQuitOrReset = u, ne.getCode = s, ne.handleAuthFailure = o, ne.subWatchers = {}, f && (await ne.client.connect(), await ne.client.eventSource()), ne.client.on("status-update", (m) => {
		_e.trackEvent(Ke.NodeConnectionDebug, {
			context: "status update",
			connectionStatus: m.status,
			statusUpdateContext: m.context ? m.context : null
		}), ne.lastStatus = m.status, c?.(m.status);
	}), ne.client.on("fact", (m) => {
		_e.log("received message", dy(() => dA(JSON.stringify(m))));
	}), ne.client.on("seamless-reset", () => {
		var m;
		_e.log("client seamless-reset"), _e.trackEvent(Ke.NodeConnectionDebug, { context: "seamless-reset" }), (m = ne.onQuitOrReset) == null || m.call(ne, "reset");
	}), ne.client.on("error", (m) => {
		_e.log("client error", m);
	}), ne.client.on("channel-reaped", () => {
		_e.trackEvent(Ke.NodeConnectionDebug, { context: "client channel reaped" }), _e.log("client channel-reaped");
	});
}
async function Ve({ app: e, path: t, timeout: n }) {
	if (!ne.client) throw new Error("Client not initialized");
	ne.pendingAuth && await ne.pendingAuth, _e.log("scry", e, t);
	const r = $o(Ke.Scry, {
		app: e,
		path: yD(t),
		shouldTimeoutAfter: n ?? ru
	});
	try {
		const { result: s, responseSizeInBytes: o, responseStatus: u } = await ne.client.scryWithInfo({
			app: e,
			path: t,
			timeout: n ?? ru
		});
		return r("success", {
			responseSizeInBytes: o,
			responseStatus: u
		}), s;
	} catch (s) {
		if (_e.log("bad scry", e, t, s.status), s.status === 403) {
			_e.log("scry failed with 403, authing to try again"), await Wi();
			const { result: o, responseSizeInBytes: u, responseStatus: c } = await ne.client.scryWithInfo({
				app: e,
				path: t
			});
			return r("success", {
				responseSizeInBytes: u,
				responseStatus: c
			}), o;
		}
		throw r("error", {
			errorMessage: s.message,
			responseStatus: s.status
		}), new Mo(s.status, s.toString());
	}
}
function yD(e) {
	return e.replace(/~.+?(?:\/.+?)(\/|$)/g, "[id]/");
}
async function Wi() {
	if (!ne.getCode) {
		if (_e.log("No getCode function provided for auth"), ne.handleAuthFailure) return _e.log("calling auth failure handler"), ne.handleAuthFailure();
		throw new Error("Unable to authenticate with urbit");
	}
	if (ne.pendingAuth) return ne.pendingAuth;
	try {
		let e = 0;
		_e.log("getting urbit code");
		const t = await ne.getCode();
		return ne.pendingAuth = new Promise((n, r) => {
			const s = async () => {
				try {
					_e.log("trying to auth with code", t);
					const o = await H3(ne.shipUrl, t);
					if (!o && e < 3) {
						_e.log("auth failed, trying again", e), e++, setTimeout(s, 1e3 + 2 ** e * 1e3);
						return;
					}
					if (!o) {
						ne.pendingAuth = null, ne.handleAuthFailure && (_e.log("auth failed, calling auth failure handler"), ne.handleAuthFailure()), r(/* @__PURE__ */ new Error("Couldn't authenticate with urbit"));
						return;
					}
					ne.client && (ne.client.cookie = o), ne.pendingAuth = null, n(o);
					return;
				} catch (o) {
					r(/* @__PURE__ */ new Error(`Error during reauth: ${o}`));
				}
			};
			s();
		}), await ne.pendingAuth;
	} catch (e) {
		if (_e.error("error getting urbit code", e), ne.pendingAuth = null, ne.handleAuthFailure) return ne.handleAuthFailure();
		throw e;
	}
}
function $o(e, t) {
	const n = Date.now();
	return (r, s) => {
		_e.trackEvent(e, {
			...t,
			...s,
			status: r,
			scryStatus: r,
			duration: Date.now() - n
		});
	};
}
var DD = {}, sd = {}, iu = yt && yt.__assign || function() {
	return iu = Object.assign || function(e) {
		for (var t, n = 1, r = arguments.length; n < r; n++) {
			t = arguments[n];
			for (var s in t) Object.prototype.hasOwnProperty.call(t, s) && (e[s] = t[s]);
		}
		return e;
	}, iu.apply(this, arguments);
};
Object.defineProperty(sd, "__esModule", { value: !0 });
var V3 = {
	delayFirstAttempt: !1,
	jitter: "none",
	maxDelay: Infinity,
	numOfAttempts: 10,
	retry: function() {
		return !0;
	},
	startingDelay: 100,
	timeMultiple: 2
};
function Z3(e) {
	var t = iu(iu({}, V3), e);
	return t.numOfAttempts < 1 && (t.numOfAttempts = 1), t;
}
sd.getSanitizedOptions = Z3;
var od = {}, ad = {}, Cu = {}, ud = {}, cd = {};
Object.defineProperty(cd, "__esModule", { value: !0 });
function J3(e) {
	var t = Math.random() * e;
	return Math.round(t);
}
cd.fullJitter = J3;
var ld = {};
Object.defineProperty(ld, "__esModule", { value: !0 });
function X3(e) {
	return e;
}
ld.noJitter = X3;
Object.defineProperty(ud, "__esModule", { value: !0 });
var Y3 = cd, Q3 = ld;
function e_(e) {
	switch (e.jitter) {
		case "full": return Y3.fullJitter;
		default: return Q3.noJitter;
	}
}
ud.JitterFactory = e_;
Object.defineProperty(Cu, "__esModule", { value: !0 });
var t_ = ud;
Cu.Delay = function() {
	function e(t) {
		this.options = t, this.attempt = 0;
	}
	return e.prototype.apply = function() {
		var t = this;
		return new Promise(function(n) {
			return setTimeout(n, t.jitteredDelay);
		});
	}, e.prototype.setAttemptNumber = function(t) {
		this.attempt = t;
	}, Object.defineProperty(e.prototype, "jitteredDelay", {
		get: function() {
			return t_.JitterFactory(this.options)(this.delay);
		},
		enumerable: !0,
		configurable: !0
	}), Object.defineProperty(e.prototype, "delay", {
		get: function() {
			var t = this.options.startingDelay, n = this.options.timeMultiple, r = this.numOfDelayedAttempts, s = t * Math.pow(n, r);
			return Math.min(s, this.options.maxDelay);
		},
		enumerable: !0,
		configurable: !0
	}), Object.defineProperty(e.prototype, "numOfDelayedAttempts", {
		get: function() {
			return this.attempt;
		},
		enumerable: !0,
		configurable: !0
	}), e;
}();
var r_ = yt && yt.__extends || /* @__PURE__ */ function() {
	var e = function(t, n) {
		return e = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(r, s) {
			r.__proto__ = s;
		} || function(r, s) {
			for (var o in s) s.hasOwnProperty(o) && (r[o] = s[o]);
		}, e(t, n);
	};
	return function(t, n) {
		e(t, n);
		function r() {
			this.constructor = t;
		}
		t.prototype = n === null ? Object.create(n) : (r.prototype = n.prototype, new r());
	};
}(), i_ = yt && yt.__awaiter || function(e, t, n, r) {
	function s(o) {
		return o instanceof n ? o : new n(function(u) {
			u(o);
		});
	}
	return new (n || (n = Promise))(function(o, u) {
		function c(m) {
			try {
				f(r.next(m));
			} catch (y) {
				u(y);
			}
		}
		function d(m) {
			try {
				f(r.throw(m));
			} catch (y) {
				u(y);
			}
		}
		function f(m) {
			m.done ? o(m.value) : s(m.value).then(c, d);
		}
		f((r = r.apply(e, t || [])).next());
	});
}, s_ = yt && yt.__generator || function(e, t) {
	var n = {
		label: 0,
		sent: function() {
			if (o[0] & 1) throw o[1];
			return o[1];
		},
		trys: [],
		ops: []
	}, r, s, o, u;
	return u = {
		next: c(0),
		throw: c(1),
		return: c(2)
	}, typeof Symbol == "function" && (u[Symbol.iterator] = function() {
		return this;
	}), u;
	function c(f) {
		return function(m) {
			return d([f, m]);
		};
	}
	function d(f) {
		if (r) throw new TypeError("Generator is already executing.");
		for (; n;) try {
			if (r = 1, s && (o = f[0] & 2 ? s.return : f[0] ? s.throw || ((o = s.return) && o.call(s), 0) : s.next) && !(o = o.call(s, f[1])).done) return o;
			switch (s = 0, o && (f = [f[0] & 2, o.value]), f[0]) {
				case 0:
				case 1:
					o = f;
					break;
				case 4: return n.label++, {
					value: f[1],
					done: !1
				};
				case 5:
					n.label++, s = f[1], f = [0];
					continue;
				case 7:
					f = n.ops.pop(), n.trys.pop();
					continue;
				default:
					if (o = n.trys, !(o = o.length > 0 && o[o.length - 1]) && (f[0] === 6 || f[0] === 2)) {
						n = 0;
						continue;
					}
					if (f[0] === 3 && (!o || f[1] > o[0] && f[1] < o[3])) {
						n.label = f[1];
						break;
					}
					if (f[0] === 6 && n.label < o[1]) {
						n.label = o[1], o = f;
						break;
					}
					if (o && n.label < o[2]) {
						n.label = o[2], n.ops.push(f);
						break;
					}
					o[2] && n.ops.pop(), n.trys.pop();
					continue;
			}
			f = t.call(e, n);
		} catch (m) {
			f = [6, m], s = 0;
		} finally {
			r = o = 0;
		}
		if (f[0] & 5) throw f[1];
		return {
			value: f[0] ? f[1] : void 0,
			done: !0
		};
	}
};
Object.defineProperty(ad, "__esModule", { value: !0 });
ad.SkipFirstDelay = function(e) {
	r_(t, e);
	function t() {
		return e !== null && e.apply(this, arguments) || this;
	}
	return t.prototype.apply = function() {
		return i_(this, void 0, void 0, function() {
			return s_(this, function(n) {
				return [2, this.isFirstAttempt ? !0 : e.prototype.apply.call(this)];
			});
		});
	}, Object.defineProperty(t.prototype, "isFirstAttempt", {
		get: function() {
			return this.attempt === 0;
		},
		enumerable: !0,
		configurable: !0
	}), Object.defineProperty(t.prototype, "numOfDelayedAttempts", {
		get: function() {
			return this.attempt - 1;
		},
		enumerable: !0,
		configurable: !0
	}), t;
}(Cu.Delay);
var fd = {}, u_ = yt && yt.__extends || /* @__PURE__ */ function() {
	var e = function(t, n) {
		return e = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(r, s) {
			r.__proto__ = s;
		} || function(r, s) {
			for (var o in s) s.hasOwnProperty(o) && (r[o] = s[o]);
		}, e(t, n);
	};
	return function(t, n) {
		e(t, n);
		function r() {
			this.constructor = t;
		}
		t.prototype = n === null ? Object.create(n) : (r.prototype = n.prototype, new r());
	};
}();
Object.defineProperty(fd, "__esModule", { value: !0 });
fd.AlwaysDelay = function(e) {
	u_(t, e);
	function t() {
		return e !== null && e.apply(this, arguments) || this;
	}
	return t;
}(Cu.Delay);
Object.defineProperty(od, "__esModule", { value: !0 });
var f_ = ad, d_ = fd;
function h_(e, t) {
	var n = p_(e);
	return n.setAttemptNumber(t), n;
}
od.DelayFactory = h_;
function p_(e) {
	return e.delayFirstAttempt ? new d_.AlwaysDelay(e) : new f_.SkipFirstDelay(e);
}
var yf = yt && yt.__awaiter || function(e, t, n, r) {
	function s(o) {
		return o instanceof n ? o : new n(function(u) {
			u(o);
		});
	}
	return new (n || (n = Promise))(function(o, u) {
		function c(m) {
			try {
				f(r.next(m));
			} catch (y) {
				u(y);
			}
		}
		function d(m) {
			try {
				f(r.throw(m));
			} catch (y) {
				u(y);
			}
		}
		function f(m) {
			m.done ? o(m.value) : s(m.value).then(c, d);
		}
		f((r = r.apply(e, t || [])).next());
	});
}, Df = yt && yt.__generator || function(e, t) {
	var n = {
		label: 0,
		sent: function() {
			if (o[0] & 1) throw o[1];
			return o[1];
		},
		trys: [],
		ops: []
	}, r, s, o, u;
	return u = {
		next: c(0),
		throw: c(1),
		return: c(2)
	}, typeof Symbol == "function" && (u[Symbol.iterator] = function() {
		return this;
	}), u;
	function c(f) {
		return function(m) {
			return d([f, m]);
		};
	}
	function d(f) {
		if (r) throw new TypeError("Generator is already executing.");
		for (; n;) try {
			if (r = 1, s && (o = f[0] & 2 ? s.return : f[0] ? s.throw || ((o = s.return) && o.call(s), 0) : s.next) && !(o = o.call(s, f[1])).done) return o;
			switch (s = 0, o && (f = [f[0] & 2, o.value]), f[0]) {
				case 0:
				case 1:
					o = f;
					break;
				case 4: return n.label++, {
					value: f[1],
					done: !1
				};
				case 5:
					n.label++, s = f[1], f = [0];
					continue;
				case 7:
					f = n.ops.pop(), n.trys.pop();
					continue;
				default:
					if (o = n.trys, !(o = o.length > 0 && o[o.length - 1]) && (f[0] === 6 || f[0] === 2)) {
						n = 0;
						continue;
					}
					if (f[0] === 3 && (!o || f[1] > o[0] && f[1] < o[3])) {
						n.label = f[1];
						break;
					}
					if (f[0] === 6 && n.label < o[1]) {
						n.label = o[1], o = f;
						break;
					}
					if (o && n.label < o[2]) {
						n.label = o[2], n.ops.push(f);
						break;
					}
					o[2] && n.ops.pop(), n.trys.pop();
					continue;
			}
			f = t.call(e, n);
		} catch (m) {
			f = [6, m], s = 0;
		} finally {
			r = o = 0;
		}
		if (f[0] & 5) throw f[1];
		return {
			value: f[0] ? f[1] : void 0,
			done: !0
		};
	}
};
Object.defineProperty(DD, "__esModule", { value: !0 });
var g_ = sd, m_ = od;
function y_(e, t) {
	return t === void 0 && (t = {}), yf(this, void 0, void 0, function() {
		var n, r;
		return Df(this, function(s) {
			switch (s.label) {
				case 0: return n = g_.getSanitizedOptions(t), r = new D_(e, n), [4, r.execute()];
				case 1: return [2, s.sent()];
			}
		});
	});
}
DD.backOff = y_;
var D_ = function() {
	function e(t, n) {
		this.request = t, this.options = n, this.attemptNumber = 0;
	}
	return e.prototype.execute = function() {
		return yf(this, void 0, void 0, function() {
			var t, n;
			return Df(this, function(r) {
				switch (r.label) {
					case 0:
						if (this.attemptLimitReached) return [3, 7];
						r.label = 1;
					case 1: return r.trys.push([
						1,
						4,
						,
						6
					]), [4, this.applyDelay()];
					case 2: return r.sent(), [4, this.request()];
					case 3: return [2, r.sent()];
					case 4: return t = r.sent(), this.attemptNumber++, [4, this.options.retry(t, this.attemptNumber)];
					case 5:
						if (n = r.sent(), !n || this.attemptLimitReached) throw t;
						return [3, 6];
					case 6: return [3, 0];
					case 7: throw new Error("Something went wrong.");
				}
			});
		});
	}, Object.defineProperty(e.prototype, "attemptLimitReached", {
		get: function() {
			return this.attemptNumber >= this.options.numOfAttempts;
		},
		enumerable: !0,
		configurable: !0
	}), e.prototype.applyDelay = function() {
		return yf(this, void 0, void 0, function() {
			var t;
			return Df(this, function(n) {
				switch (n.label) {
					case 0: return t = m_.DelayFactory(this.options, this.attemptNumber), [4, t.apply()];
					case 1: return n.sent(), [2];
				}
			});
		});
	}, e;
}();
const v_ = () => /[#*0-9]\uFE0F?\u20E3|[\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23ED-\u23EF\u23F1\u23F2\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB\u25FC\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692\u2694-\u2697\u2699\u269B\u269C\u26A0\u26A7\u26AA\u26B0\u26B1\u26BD\u26BE\u26C4\u26C8\u26CF\u26D1\u26E9\u26F0-\u26F5\u26F7\u26F8\u26FA\u2702\u2708\u2709\u270F\u2712\u2714\u2716\u271D\u2721\u2733\u2734\u2744\u2747\u2757\u2763\u27A1\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B55\u3030\u303D\u3297\u3299]\uFE0F?|[\u261D\u270C\u270D](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?|[\u270A\u270B](?:\uD83C[\uDFFB-\uDFFF])?|[\u23E9-\u23EC\u23F0\u23F3\u25FD\u2693\u26A1\u26AB\u26C5\u26CE\u26D4\u26EA\u26FD\u2705\u2728\u274C\u274E\u2753-\u2755\u2795-\u2797\u27B0\u27BF\u2B50]|\u26D3\uFE0F?(?:\u200D\uD83D\uDCA5)?|\u26F9(?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|\u2764\uFE0F?(?:\u200D(?:\uD83D\uDD25|\uD83E\uDE79))?|\uD83C(?:[\uDC04\uDD70\uDD71\uDD7E\uDD7F\uDE02\uDE37\uDF21\uDF24-\uDF2C\uDF36\uDF7D\uDF96\uDF97\uDF99-\uDF9B\uDF9E\uDF9F\uDFCD\uDFCE\uDFD4-\uDFDF\uDFF5\uDFF7]\uFE0F?|[\uDF85\uDFC2\uDFC7](?:\uD83C[\uDFFB-\uDFFF])?|[\uDFC4\uDFCA](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDFCB\uDFCC](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDCCF\uDD8E\uDD91-\uDD9A\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF43\uDF45-\uDF4A\uDF4C-\uDF7C\uDF7E-\uDF84\uDF86-\uDF93\uDFA0-\uDFC1\uDFC5\uDFC6\uDFC8\uDFC9\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF8-\uDFFF]|\uDDE6\uD83C[\uDDE8-\uDDEC\uDDEE\uDDF1\uDDF2\uDDF4\uDDF6-\uDDFA\uDDFC\uDDFD\uDDFF]|\uDDE7\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEF\uDDF1-\uDDF4\uDDF6-\uDDF9\uDDFB\uDDFC\uDDFE\uDDFF]|\uDDE8\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDEE\uDDF0-\uDDF7\uDDFA-\uDDFF]|\uDDE9\uD83C[\uDDEA\uDDEC\uDDEF\uDDF0\uDDF2\uDDF4\uDDFF]|\uDDEA\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDED\uDDF7-\uDDFA]|\uDDEB\uD83C[\uDDEE-\uDDF0\uDDF2\uDDF4\uDDF7]|\uDDEC\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEE\uDDF1-\uDDF3\uDDF5-\uDDFA\uDDFC\uDDFE]|\uDDED\uD83C[\uDDF0\uDDF2\uDDF3\uDDF7\uDDF9\uDDFA]|\uDDEE\uD83C[\uDDE8-\uDDEA\uDDF1-\uDDF4\uDDF6-\uDDF9]|\uDDEF\uD83C[\uDDEA\uDDF2\uDDF4\uDDF5]|\uDDF0\uD83C[\uDDEA\uDDEC-\uDDEE\uDDF2\uDDF3\uDDF5\uDDF7\uDDFC\uDDFE\uDDFF]|\uDDF1\uD83C[\uDDE6-\uDDE8\uDDEE\uDDF0\uDDF7-\uDDFB\uDDFE]|\uDDF2\uD83C[\uDDE6\uDDE8-\uDDED\uDDF0-\uDDFF]|\uDDF3\uD83C[\uDDE6\uDDE8\uDDEA-\uDDEC\uDDEE\uDDF1\uDDF4\uDDF5\uDDF7\uDDFA\uDDFF]|\uDDF4\uD83C\uDDF2|\uDDF5\uD83C[\uDDE6\uDDEA-\uDDED\uDDF0-\uDDF3\uDDF7-\uDDF9\uDDFC\uDDFE]|\uDDF6\uD83C\uDDE6|\uDDF7\uD83C[\uDDEA\uDDF4\uDDF8\uDDFA\uDDFC]|\uDDF8\uD83C[\uDDE6-\uDDEA\uDDEC-\uDDF4\uDDF7-\uDDF9\uDDFB\uDDFD-\uDDFF]|\uDDF9\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDED\uDDEF-\uDDF4\uDDF7\uDDF9\uDDFB\uDDFC\uDDFF]|\uDDFA\uD83C[\uDDE6\uDDEC\uDDF2\uDDF3\uDDF8\uDDFE\uDDFF]|\uDDFB\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDEE\uDDF3\uDDFA]|\uDDFC\uD83C[\uDDEB\uDDF8]|\uDDFD\uD83C\uDDF0|\uDDFE\uD83C[\uDDEA\uDDF9]|\uDDFF\uD83C[\uDDE6\uDDF2\uDDFC]|\uDF44(?:\u200D\uD83D\uDFEB)?|\uDF4B(?:\u200D\uD83D\uDFE9)?|\uDFC3(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?|\uDFF3\uFE0F?(?:\u200D(?:\u26A7\uFE0F?|\uD83C\uDF08))?|\uDFF4(?:\u200D\u2620\uFE0F?|\uDB40\uDC67\uDB40\uDC62\uDB40(?:\uDC65\uDB40\uDC6E\uDB40\uDC67|\uDC73\uDB40\uDC63\uDB40\uDC74|\uDC77\uDB40\uDC6C\uDB40\uDC73)\uDB40\uDC7F)?)|\uD83D(?:[\uDC3F\uDCFD\uDD49\uDD4A\uDD6F\uDD70\uDD73\uDD76-\uDD79\uDD87\uDD8A-\uDD8D\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA\uDECB\uDECD-\uDECF\uDEE0-\uDEE5\uDEE9\uDEF0\uDEF3]\uFE0F?|[\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDC8F\uDC91\uDCAA\uDD7A\uDD95\uDD96\uDE4C\uDE4F\uDEC0\uDECC](?:\uD83C[\uDFFB-\uDFFF])?|[\uDC6E-\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4\uDEB5](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDD74\uDD90](?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?|[\uDC00-\uDC07\uDC09-\uDC14\uDC16-\uDC25\uDC27-\uDC3A\uDC3C-\uDC3E\uDC40\uDC44\uDC45\uDC51-\uDC65\uDC6A\uDC79-\uDC7B\uDC7D-\uDC80\uDC84\uDC88-\uDC8E\uDC90\uDC92-\uDCA9\uDCAB-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDDA4\uDDFB-\uDE2D\uDE2F-\uDE34\uDE37-\uDE41\uDE43\uDE44\uDE48-\uDE4A\uDE80-\uDEA2\uDEA4-\uDEB3\uDEB7-\uDEBF\uDEC1-\uDEC5\uDED0-\uDED2\uDED5-\uDED8\uDEDC-\uDEDF\uDEEB\uDEEC\uDEF4-\uDEFC\uDFE0-\uDFEB\uDFF0]|\uDC08(?:\u200D\u2B1B)?|\uDC15(?:\u200D\uD83E\uDDBA)?|\uDC26(?:\u200D(?:\u2B1B|\uD83D\uDD25))?|\uDC3B(?:\u200D\u2744\uFE0F?)?|\uDC41\uFE0F?(?:\u200D\uD83D\uDDE8\uFE0F?)?|\uDC68(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDC68\uDC69]\u200D\uD83D(?:\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?)|[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?)|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC68\uD83C[\uDFFC-\uDFFF])|\uD83E(?:[\uDD1D\uDEEF]\u200D\uD83D\uDC68\uD83C[\uDFFC-\uDFFF]|[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83E(?:[\uDD1D\uDEEF]\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFD-\uDFFF]|[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83E(?:[\uDD1D\uDEEF]\u200D\uD83D\uDC68\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF]|[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83E(?:[\uDD1D\uDEEF]\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFD\uDFFF]|[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?\uDC68\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFE])|\uD83E(?:[\uDD1D\uDEEF]\u200D\uD83D\uDC68\uD83C[\uDFFB-\uDFFE]|[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3])))?))?|\uDC69(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:\uDC8B\u200D\uD83D)?[\uDC68\uDC69]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?|\uDC69\u200D\uD83D(?:\uDC66(?:\u200D\uD83D\uDC66)?|\uDC67(?:\u200D\uD83D[\uDC66\uDC67])?))|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC69\uD83C[\uDFFC-\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFC-\uDFFF]|\uDEEF\u200D\uD83D\uDC69\uD83C[\uDFFC-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC69\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB\uDFFD-\uDFFF]|\uDEEF\u200D\uD83D\uDC69\uD83C[\uDFFB\uDFFD-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC69\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF]|\uDEEF\u200D\uD83D\uDC69\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC69\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB-\uDFFD\uDFFF]|\uDEEF\u200D\uD83D\uDC69\uD83C[\uDFFB-\uDFFD\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D\uD83D(?:[\uDC68\uDC69]|\uDC8B\u200D\uD83D[\uDC68\uDC69])\uD83C[\uDFFB-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83D\uDC69\uD83C[\uDFFB-\uDFFE])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3]|\uDD1D\u200D\uD83D[\uDC68\uDC69]\uD83C[\uDFFB-\uDFFE]|\uDEEF\u200D\uD83D\uDC69\uD83C[\uDFFB-\uDFFE])))?))?|\uDD75(?:\uD83C[\uDFFB-\uDFFF]|\uFE0F)?(?:\u200D[\u2640\u2642]\uFE0F?)?|\uDE2E(?:\u200D\uD83D\uDCA8)?|\uDE35(?:\u200D\uD83D\uDCAB)?|\uDE36(?:\u200D\uD83C\uDF2B\uFE0F?)?|\uDE42(?:\u200D[\u2194\u2195]\uFE0F?)?|\uDEB6(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?)|\uD83E(?:[\uDD0C\uDD0F\uDD18-\uDD1F\uDD30-\uDD34\uDD36\uDD77\uDDB5\uDDB6\uDDBB\uDDD2\uDDD3\uDDD5\uDEC3-\uDEC5\uDEF0\uDEF2-\uDEF8](?:\uD83C[\uDFFB-\uDFFF])?|[\uDD26\uDD35\uDD37-\uDD39\uDD3C-\uDD3E\uDDB8\uDDB9\uDDCD\uDDCF\uDDD4\uDDD6-\uDDDD](?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDDDE\uDDDF](?:\u200D[\u2640\u2642]\uFE0F?)?|[\uDD0D\uDD0E\uDD10-\uDD17\uDD20-\uDD25\uDD27-\uDD2F\uDD3A\uDD3F-\uDD45\uDD47-\uDD76\uDD78-\uDDB4\uDDB7\uDDBA\uDDBC-\uDDCC\uDDD0\uDDE0-\uDDFF\uDE70-\uDE7C\uDE80-\uDE8A\uDE8E-\uDEC2\uDEC6\uDEC8\uDECD-\uDEDC\uDEDF-\uDEEA\uDEEF]|\uDDCE(?:\uD83C[\uDFFB-\uDFFF])?(?:\u200D(?:[\u2640\u2642]\uFE0F?(?:\u200D\u27A1\uFE0F?)?|\u27A1\uFE0F?))?|\uDDD1(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1|\uDDD1\u200D\uD83E\uDDD2(?:\u200D\uD83E\uDDD2)?|\uDDD2(?:\u200D\uD83E\uDDD2)?))|\uD83C(?:\uDFFB(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFC-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83E\uDDD1\uD83C[\uDFFC-\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF]|\uDEEF\u200D\uD83E\uDDD1\uD83C[\uDFFC-\uDFFF])))?|\uDFFC(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB\uDFFD-\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83E\uDDD1\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF]|\uDEEF\u200D\uD83E\uDDD1\uD83C[\uDFFB\uDFFD-\uDFFF])))?|\uDFFD(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83E\uDDD1\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF]|\uDEEF\u200D\uD83E\uDDD1\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])))?|\uDFFE(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB-\uDFFD\uDFFF]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF]|\uDEEF\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFD\uDFFF])))?|\uDFFF(?:\u200D(?:[\u2695\u2696\u2708]\uFE0F?|\u2764\uFE0F?\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1\uD83C[\uDFFB-\uDFFE]|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D(?:[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uDC30\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFE])|\uD83E(?:[\uDDAF\uDDBC\uDDBD](?:\u200D\u27A1\uFE0F?)?|[\uDDB0-\uDDB3\uDE70]|\uDD1D\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFF]|\uDEEF\u200D\uD83E\uDDD1\uD83C[\uDFFB-\uDFFE])))?))?|\uDEF1(?:\uD83C(?:\uDFFB(?:\u200D\uD83E\uDEF2\uD83C[\uDFFC-\uDFFF])?|\uDFFC(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB\uDFFD-\uDFFF])?|\uDFFD(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])?|\uDFFE(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB-\uDFFD\uDFFF])?|\uDFFF(?:\u200D\uD83E\uDEF2\uD83C[\uDFFB-\uDFFE])?))?)/g;
v_();
(/* @__PURE__ */ new Date()).getTimezoneOffset() * 60 * 1e3;
Cn("harkApi", !0);
var Bo;
((e) => {
	e.defaultConfig = Object.freeze({
		blockSeparator: `
`,
		includeLinebreaks: !0,
		includeRefTag: !0
	}), e.inlineConfig = Object.freeze({
		blockSeparator: " ",
		includeLinebreaks: !1,
		includeRefTag: !1
	});
})(Bo || (Bo = {}));
Cn("activityApi", !1);
function Gr() {
	return {
		showAuthors: {
			displayName: "Show authors",
			type: "boolean"
		},
		showReplies: {
			displayName: "Show replies",
			type: "boolean"
		}
	};
}
const q_ = {
	"tlon.r0.collection.chat": {
		displayName: "Chat",
		enumTag: "chat",
		parametersSchema: Gr()
	},
	"tlon.r0.collection.gallery": {
		displayName: "Gallery",
		enumTag: "gallery",
		parametersSchema: Gr()
	},
	"tlon.r0.collection.notebook": {
		displayName: "Notebook",
		enumTag: "notebook",
		parametersSchema: Gr()
	},
	"tlon.r0.collection.carousel": {
		displayName: "Carousel",
		enumTag: "carousel",
		parametersSchema: {
			...Gr(),
			scrollDirection: {
				displayName: "Scroll direction",
				type: "radio",
				options: [{
					displayName: "Horizontal",
					value: "horizontal"
				}, {
					displayName: "Vertical",
					value: "vertical"
				}]
			}
		}
	},
	"tlon.r0.collection.cards": {
		displayName: "Cards",
		enumTag: "cards",
		parametersSchema: Gr()
	},
	"tlon.r0.collection.sign": {
		displayName: "Sign",
		enumTag: "sign",
		parametersSchema: Gr()
	},
	"tlon.r0.collection.boardroom": {
		displayName: "Boardroom",
		enumTag: "boardroom",
		parametersSchema: Gr()
	},
	"tlon.r0.collection.strobe": {
		displayName: "Strobe",
		enumTag: "strobe",
		parametersSchema: {
			...Gr(),
			interval: {
				displayName: "Frame rate in milliseconds",
				type: "string"
			}
		}
	},
	"tlon.r0.collection.summaries": {
		displayName: "Summaries",
		enumTag: "summaries",
		parametersSchema: Gr()
	}
}, j_ = {
	"tlon.r0.input.chat": {
		displayName: "Chat",
		enumTag: "chat"
	},
	"tlon.r0.input.gallery": {
		displayName: "Gallery",
		enumTag: "gallery"
	},
	"tlon.r0.input.notebook": {
		displayName: "Notebook",
		enumTag: "notebook"
	},
	"tlon.r0.input.yo": {
		displayName: "Yo",
		enumTag: "yo",
		parametersSchema: { text: {
			displayName: "Message text",
			type: "string"
		} }
	},
	"tlon.r0.input.mic": {
		displayName: "Mic",
		enumTag: "mic"
	},
	"tlon.r0.input.color": {
		displayName: "Color",
		enumTag: "color"
	}
}, G_ = {
	"tlon.r0.content.chat": {
		displayName: "Chat",
		enumTag: "chat"
	},
	"tlon.r0.content.gallery": {
		displayName: "Gallery",
		enumTag: "gallery",
		parametersSchema: {
			embedded: {
				displayName: "Show frame",
				type: "boolean"
			},
			contentSize: {
				displayName: "Content size",
				type: "radio",
				options: [{
					displayName: "Large",
					value: "$l"
				}, {
					displayName: "Small",
					value: "$s"
				}]
			}
		}
	},
	"tlon.r0.content.notebook": {
		displayName: "Notebook",
		enumTag: "notebook"
	},
	"tlon.r0.content.audio": {
		displayName: "Audio",
		enumTag: "audio"
	},
	"tlon.r0.content.color": {
		displayName: "Color",
		enumTag: "color"
	},
	"tlon.r0.content.raw": {
		displayName: "Raw",
		enumTag: "raw",
		parametersSchema: { fontFamily: {
			displayName: "Font family",
			type: "string"
		} }
	},
	"tlon.r0.content.yell": {
		displayName: "Yell",
		enumTag: "yell"
	},
	"tlon.r0.content.scratchpad": {
		displayName: "Scratchpad",
		enumTag: "scratchpad"
	}
}, _D = hd(q_), BD = hd(j_), ID = hd(G_);
var Ss;
((e) => {
	function t(r) {
		return typeof r == "string" ? r : r.id;
	}
	e.id = t;
	function n(r) {
		return typeof r == "string" ? { id: r } : r;
	}
	e.coerce = n;
})(Ss || (Ss = {}));
var t0;
((e) => {
	function t() {
		return {
			draftInput: { id: BD.chat },
			defaultPostContentRenderer: { id: ID.chat },
			defaultPostCollectionRenderer: { id: _D.chat }
		};
	}
	e.defaultConfiguration = t;
	function n(o) {
		return Ss.coerce(o.draftInput);
	}
	e.draftInput = n;
	function r(o) {
		return Ss.coerce(o.defaultPostContentRenderer);
	}
	e.defaultPostContentRenderer = r;
	function s(o) {
		return Ss.coerce(o.defaultPostCollectionRenderer);
	}
	e.defaultPostCollectionRenderer = s;
})(t0 || (t0 = {}));
var Io;
((e) => {
	function t(r) {
		return JSON.stringify(r);
	}
	e.encode = t;
	function n(r) {
		if (r == null) return {};
		try {
			const s = JSON.parse(r);
			if (typeof s != "object" || !s) return {};
			if ("channelContentConfiguration" in s) {
				if (typeof s.channelContentConfiguration != "object") throw new Error("Invalid configuration");
				s.channelContentConfiguration = ((o) => {
					const u = {
						draftInput: BD.chat,
						defaultPostContentRenderer: ID.chat,
						defaultPostCollectionRenderer: _D.chat,
						...o
					}, c = Ss.coerce(u.defaultPostCollectionRenderer);
					return c.configuration = {
						showAuthors: !0,
						showReplies: !0,
						...c.configuration
					}, u;
				})(s.channelContentConfiguration);
			}
			return s;
		} catch {
			return { description: r.length === 0 ? void 0 : r };
		}
	}
	e.decode = n;
})(Io || (Io = {}));
function hd(e) {
	return Object.entries(e).reduce((t, [n, { enumTag: r }]) => (t[r] = n, t), {});
}
Cn("postsApi", !1);
Cn("channelsApi", !1);
Cn("groupsApi", !1);
Cn("initApi", !1);
Cn("lanyardApi", !1);
Cn("contactsApi", !1);
const PB = (e) => ({
	setHttpHandler(t) {
		e.httpHandler = t;
	},
	httpHandler() {
		return e.httpHandler;
	},
	updateHttpClientConfig(t, n) {
		var r;
		(r = e.httpHandler) == null || r.updateHttpClientConfig(t, n);
	},
	httpHandlerConfigs() {
		return e.httpHandler.httpHandlerConfigs();
	}
}), NB = (e) => ({ httpHandler: e.httpHandler() });
var Ro;
(function(e) {
	e.HTTP = "http", e.HTTPS = "https";
})(Ro || (Ro = {}));
var uu;
(function(e) {
	e.MD5 = "md5", e.CRC32 = "crc32", e.CRC32C = "crc32c", e.SHA1 = "sha1", e.SHA256 = "sha256";
})(uu || (uu = {}));
const Ef = "__smithy_context";
var bt = class bt {
	constructor(t) {
		P(this, "method");
		P(this, "protocol");
		P(this, "hostname");
		P(this, "port");
		P(this, "path");
		P(this, "query");
		P(this, "headers");
		P(this, "username");
		P(this, "password");
		P(this, "fragment");
		P(this, "body");
		this.method = t.method || "GET", this.hostname = t.hostname || "localhost", this.port = t.port, this.query = t.query || {}, this.headers = t.headers || {}, this.body = t.body, this.protocol = t.protocol ? t.protocol.slice(-1) !== ":" ? `${t.protocol}:` : t.protocol : "https:", this.path = t.path ? t.path.charAt(0) !== "/" ? `/${t.path}` : t.path : "/", this.username = t.username, this.password = t.password, this.fragment = t.fragment;
	}
	static clone(t) {
		const n = new bt({
			...t,
			headers: { ...t.headers }
		});
		return n.query && (n.query = OB(n.query)), n;
	}
	static isInstance(t) {
		if (!t) return !1;
		const n = t;
		return "method" in n && "protocol" in n && "hostname" in n && "path" in n && typeof n.query == "object" && typeof n.headers == "object";
	}
	clone() {
		return bt.clone(this);
	}
};
function OB(e) {
	return Object.keys(e).reduce((t, n) => {
		const r = e[n];
		return {
			...t,
			[n]: Array.isArray(r) ? [...r] : r
		};
	}, {});
}
var qi = class {
	constructor(t) {
		P(this, "statusCode");
		P(this, "reason");
		P(this, "headers");
		P(this, "body");
		this.statusCode = t.statusCode, this.reason = t.reason, this.headers = t.headers || {}, this.body = t.body;
	}
	static isInstance(t) {
		if (!t) return !1;
		const n = t;
		return typeof n.statusCode == "number" && typeof n.headers == "object";
	}
};
function UB(e) {
	return (t) => async (n) => {
		var s, o, u, c;
		const { request: r } = n;
		if (e.expectContinueHeader !== !1 && bt.isInstance(r) && r.body && e.runtime === "node" && ((o = (s = e.requestHandler) == null ? void 0 : s.constructor) == null ? void 0 : o.name) !== "FetchHttpHandler") {
			let d = !0;
			if (typeof e.expectContinueHeader == "number") try {
				d = (Number((u = r.headers) == null ? void 0 : u["content-length"]) ?? ((c = e.bodyLengthChecker) == null ? void 0 : c.call(e, r.body)) ?? Infinity) >= e.expectContinueHeader;
			} catch {}
			else d = !!e.expectContinueHeader;
			d && (r.headers.Expect = "100-continue");
		}
		return t({
			...n,
			request: r
		});
	};
}
const MB = {
	step: "build",
	tags: ["SET_EXPECT_HEADER", "EXPECT_HEADER"],
	name: "addExpectContinueMiddleware",
	override: !0
}, $B = (e) => ({ applyToStack: (t) => {
	t.add(UB(e), MB);
} }), ks = {
	WHEN_SUPPORTED: "WHEN_SUPPORTED",
	WHEN_REQUIRED: "WHEN_REQUIRED"
}, LB = ks.WHEN_SUPPORTED, ul = {
	WHEN_SUPPORTED: "WHEN_SUPPORTED",
	WHEN_REQUIRED: "WHEN_REQUIRED"
}, zB = ks.WHEN_SUPPORTED;
var Qe;
(function(e) {
	e.MD5 = "MD5", e.CRC32 = "CRC32", e.CRC32C = "CRC32C", e.CRC64NVME = "CRC64NVME", e.SHA1 = "SHA1", e.SHA256 = "SHA256";
})(Qe || (Qe = {}));
var o0;
(function(e) {
	e.HEADER = "header", e.TRAILER = "trailer";
})(o0 || (o0 = {}));
const vf = Qe.CRC32;
function HB(e, t, n) {
	return e.$source || (e.$source = {}), e.$source[t] = n, e;
}
function Ft(e, t, n) {
	e.__aws_sdk_context ? e.__aws_sdk_context.features || (e.__aws_sdk_context.features = {}) : e.__aws_sdk_context = { features: {} }, e.__aws_sdk_context.features[t] = n;
}
const a0 = (e) => {
	var t, n;
	return qi.isInstance(e) ? ((t = e.headers) == null ? void 0 : t.date) ?? ((n = e.headers) == null ? void 0 : n.Date) : void 0;
}, yd = (e) => new Date(Date.now() + e), qB = (e, t) => Math.abs(yd(t).getTime() - e) >= 3e5, u0 = (e, t) => {
	const n = Date.parse(e);
	return qB(n, t) ? n - Date.now() : t;
}, mo = (e, t) => {
	if (!t) throw new Error(`Property \`${e}\` is not resolved for AWS SDK SigV4Auth`);
	return t;
}, zD = async (e) => {
	var f, m, y;
	const t = mo("context", e.context), n = mo("config", e.config), r = (y = (m = (f = t.endpointV2) == null ? void 0 : f.properties) == null ? void 0 : m.authSchemes) == null ? void 0 : y[0];
	return {
		config: n,
		signer: await mo("signer", n.signer)(r),
		signingRegion: e == null ? void 0 : e.signingRegion,
		signingRegionSet: e == null ? void 0 : e.signingRegionSet,
		signingName: e == null ? void 0 : e.signingName
	};
};
var HD = class {
	async sign(t, n, r) {
		var y;
		if (!bt.isInstance(t)) throw new Error("The request is not an instance of `HttpRequest` and cannot be signed");
		const s = await zD(r), { config: o, signer: u } = s;
		let { signingRegion: c, signingName: d } = s;
		const f = r.context;
		if (((y = f == null ? void 0 : f.authSchemes) == null ? void 0 : y.length) ?? !1) {
			const [w, E] = f.authSchemes;
			(w == null ? void 0 : w.name) === "sigv4a" && (E == null ? void 0 : E.name) === "sigv4" && (c = (E == null ? void 0 : E.signingRegion) ?? c, d = (E == null ? void 0 : E.signingName) ?? d);
		}
		return await u.sign(t, {
			signingDate: yd(o.systemClockOffset),
			signingRegion: c,
			signingService: d
		});
	}
	errorHandler(t) {
		return (n) => {
			const r = n.ServerTime ?? a0(n.$response);
			if (r) {
				const s = mo("config", t.config), o = s.systemClockOffset;
				s.systemClockOffset = u0(r, s.systemClockOffset), s.systemClockOffset !== o && n.$metadata && (n.$metadata.clockSkewCorrected = !0);
			}
			throw n;
		};
	}
	successHandler(t, n) {
		const r = a0(t);
		if (r) {
			const s = mo("config", n.config);
			s.systemClockOffset = u0(r, s.systemClockOffset);
		}
	}
};
var jB = class extends HD {
	async sign(t, n, r) {
		var w;
		if (!bt.isInstance(t)) throw new Error("The request is not an instance of `HttpRequest` and cannot be signed");
		const { config: s, signer: o, signingRegion: u, signingRegionSet: c, signingName: d } = await zD(r), m = (await ((w = s.sigv4aSigningRegionSet) == null ? void 0 : w.call(s)) ?? c ?? [u]).join(",");
		return await o.sign(t, {
			signingDate: yd(s.systemClockOffset),
			signingRegion: m,
			signingService: d
		});
	}
};
const Ci = (e) => e[Ef] || (e[Ef] = {}), or = (e) => {
	if (typeof e == "function") return e;
	const t = Promise.resolve(e);
	return () => t;
}, GB = (e, t) => {
	if (!t || t.length === 0) return e;
	const n = [];
	for (const r of t) for (const s of e) s.schemeId.split("#")[1] === r && n.push(s);
	for (const r of e) n.find(({ schemeId: s }) => s === r.schemeId) || n.push(r);
	return n;
};
function WB(e) {
	const t = /* @__PURE__ */ new Map();
	for (const n of e) t.set(n.schemeId, n);
	return t;
}
const KB = (e, t) => (n, r) => async (s) => {
	var y;
	const c = GB(e.httpAuthSchemeProvider(await t.httpAuthSchemeParametersProvider(e, r, s.input)), e.authSchemePreference ? await e.authSchemePreference() : []), d = WB(e.httpAuthSchemes), f = Ci(r), m = [];
	for (const w of c) {
		const E = d.get(w.schemeId);
		if (!E) {
			m.push(`HttpAuthScheme \`${w.schemeId}\` was not enabled for this service.`);
			continue;
		}
		const A = E.identityProvider(await t.identityProviderConfigProvider(e));
		if (!A) {
			m.push(`HttpAuthScheme \`${w.schemeId}\` did not have an IdentityProvider configured.`);
			continue;
		}
		const { identityProperties: B = {}, signingProperties: T = {} } = ((y = w.propertiesExtractor) == null ? void 0 : y.call(w, e, r)) || {};
		w.identityProperties = Object.assign(w.identityProperties || {}, B), w.signingProperties = Object.assign(w.signingProperties || {}, T), f.selectedHttpAuthScheme = {
			httpAuthOption: w,
			identity: await A(w.identityProperties),
			signer: E.signer
		};
		break;
	}
	if (!f.selectedHttpAuthScheme) throw new Error(m.join(`
`));
	return n(s);
}, VB = {
	step: "serialize",
	tags: ["HTTP_AUTH_SCHEME"],
	name: "httpAuthSchemeMiddleware",
	override: !0,
	relation: "before",
	toMiddleware: "endpointV2Middleware"
}, ZB = (e, { httpAuthSchemeParametersProvider: t, identityProviderConfigProvider: n }) => ({ applyToStack: (r) => {
	r.addRelativeTo(KB(e, {
		httpAuthSchemeParametersProvider: t,
		identityProviderConfigProvider: n
	}), VB);
} }), JB = { name: "serializerMiddleware" }, XB = (e) => (t) => {
	throw t;
}, YB = (e, t) => {}, QB = (e) => (t, n) => async (r) => {
	if (!bt.isInstance(r.request)) return t(r);
	const o = Ci(n).selectedHttpAuthScheme;
	if (!o) throw new Error("No HttpAuthScheme was selected: unable to sign request");
	const { httpAuthOption: { signingProperties: u = {} }, identity: c, signer: d } = o, f = await t({
		...r,
		request: await d.sign(r.request, c, u)
	}).catch((d.errorHandler || XB)(u));
	return (d.successHandler || YB)(f.response, u), f;
}, qD = {
	step: "finalizeRequest",
	tags: ["HTTP_SIGNING"],
	name: "httpSigningMiddleware",
	aliases: [
		"apiKeyMiddleware",
		"tokenMiddleware",
		"awsAuthMiddleware"
	],
	override: !0,
	relation: "after",
	toMiddleware: "retryMiddleware"
}, eI = (e) => ({ applyToStack: (t) => {
	t.addRelativeTo(QB(), qD);
} }), Fs = (e) => {
	if (typeof e == "function") return e;
	const t = Promise.resolve(e);
	return () => t;
}, jD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", c0 = Object.entries(jD).reduce((e, [t, n]) => (e[n] = Number(t), e), {}), tI = jD.split(""), As = 6, yo = 8, nI = 63, Rs = (e) => {
	let t = e.length / 4 * 3;
	e.slice(-2) === "==" ? t -= 2 : e.slice(-1) === "=" && t--;
	const n = new ArrayBuffer(t), r = new DataView(n);
	for (let s = 0; s < e.length; s += 4) {
		let o = 0, u = 0;
		for (let f = s, m = s + 3; f <= m; f++) if (e[f] !== "=") {
			if (!(e[f] in c0)) throw new TypeError(`Invalid character ${e[f]} in base64 string.`);
			o |= c0[e[f]] << (m - f) * As, u += As;
		} else o >>= As;
		const c = s / 4 * 3;
		o >>= u % yo;
		const d = Math.floor(u / yo);
		for (let f = 0; f < d; f++) {
			const m = (d - f - 1) * yo;
			r.setUint8(c + f, (o & 255 << m) >> m);
		}
	}
	return new Uint8Array(n);
}, Yr = (e) => new TextEncoder().encode(e), Ts = (e) => typeof e == "string" ? Yr(e) : ArrayBuffer.isView(e) ? new Uint8Array(e.buffer, e.byteOffset, e.byteLength / Uint8Array.BYTES_PER_ELEMENT) : new Uint8Array(e), Ki = (e) => {
	if (typeof e == "string") return e;
	if (typeof e != "object" || typeof e.byteOffset != "number" || typeof e.byteLength != "number") throw new Error("@smithy/util-utf8: toUtf8 encoder function only accepts string | Uint8Array.");
	return new TextDecoder("utf-8").decode(e);
};
function ji(e) {
	let t;
	typeof e == "string" ? t = Yr(e) : t = e;
	const n = typeof t == "object" && typeof t.length == "number", r = typeof t == "object" && typeof t.byteOffset == "number" && typeof t.byteLength == "number";
	if (!n && !r) throw new Error("@smithy/util-base64: toBase64 encoder function only accepts string | Uint8Array.");
	let s = "";
	for (let o = 0; o < t.length; o += 3) {
		let u = 0, c = 0;
		for (let f = o, m = Math.min(o + 3, t.length); f < m; f++) u |= t[f] << (m - f - 1) * yo, c += yo;
		const d = Math.ceil(c / As);
		u <<= d * As - c;
		for (let f = 1; f <= d; f++) {
			const m = (d - f) * As;
			s += tI[(u & nI << m) >> m];
		}
		s += "==".slice(0, 4 - d);
	}
	return s;
}
var Mi = class Mi extends Uint8Array {
	static fromString(t, n = "utf-8") {
		if (typeof t == "string") return n === "base64" ? Mi.mutate(Rs(t)) : Mi.mutate(Yr(t));
		throw new Error(`Unsupported conversion from ${typeof t} to Uint8ArrayBlobAdapter.`);
	}
	static mutate(t) {
		return Object.setPrototypeOf(t, Mi.prototype), t;
	}
	transformToString(t = "utf-8") {
		return t === "base64" ? ji(this) : Ki(this);
	}
};
const rI = typeof ReadableStream == "function" ? ReadableStream : function() {};
var iI = class extends rI {};
const Sf = (e) => {
	var t;
	return typeof ReadableStream == "function" && (((t = e == null ? void 0 : e.constructor) == null ? void 0 : t.name) === ReadableStream.name || e instanceof ReadableStream);
}, sI = ({ expectedChecksum: e, checksum: t, source: n, checksumSourceLocation: r, base64Encoder: s }) => {
	var d;
	if (!Sf(n)) throw new Error(`@smithy/util-stream: unsupported source type ${((d = n == null ? void 0 : n.constructor) == null ? void 0 : d.name) ?? n} in ChecksumStream.`);
	const o = s ?? ji;
	if (typeof TransformStream != "function") throw new Error("@smithy/util-stream: unable to instantiate ChecksumStream because API unavailable: ReadableStream/TransformStream.");
	const u = new TransformStream({
		start() {},
		async transform(f, m) {
			t.update(f), m.enqueue(f);
		},
		async flush(f) {
			const y = o(await t.digest());
			if (e !== y) {
				const w = /* @__PURE__ */ new Error(`Checksum mismatch: expected "${e}" but received "${y}" in response header "${r}".`);
				f.error(w);
			} else f.terminate();
		}
	});
	n.pipeThrough(u);
	const c = u.readable;
	return Object.setPrototypeOf(c, iI.prototype), c;
};
var oI = class {
	constructor(t) {
		P(this, "allocByteArray");
		P(this, "byteLength", 0);
		P(this, "byteArrays", []);
		this.allocByteArray = t;
	}
	push(t) {
		this.byteArrays.push(t), this.byteLength += t.byteLength;
	}
	flush() {
		if (this.byteArrays.length === 1) {
			const r = this.byteArrays[0];
			return this.reset(), r;
		}
		const t = this.allocByteArray(this.byteLength);
		let n = 0;
		for (let r = 0; r < this.byteArrays.length; ++r) {
			const s = this.byteArrays[r];
			t.set(s, n), n += s.byteLength;
		}
		return this.reset(), t;
	}
	reset() {
		this.byteArrays = [], this.byteLength = 0;
	}
};
function aI(e, t, n) {
	const r = e.getReader();
	let s = !1, o = 0;
	const u = ["", new oI((f) => new Uint8Array(f))];
	let c = -1;
	const d = async (f) => {
		const { value: m, done: y } = await r.read(), w = m;
		if (y) {
			if (c !== -1) {
				const E = cl(u, c);
				Do(E) > 0 && f.enqueue(E);
			}
			f.close();
		} else {
			const E = lI(w, !1);
			if (c !== E && (c >= 0 && f.enqueue(cl(u, c)), c = E), c === -1) {
				f.enqueue(w);
				return;
			}
			const A = Do(w);
			o += A;
			const B = Do(u[c]);
			if (A >= t && B === 0) f.enqueue(w);
			else {
				const T = cI(u, c, w);
				!s && o > t * 2 && (s = !0, n?.warn(`@smithy/util-stream - stream chunk size ${A} is below threshold of ${t}, automatically buffering.`)), T >= t ? f.enqueue(cl(u, c)) : await d(f);
			}
		}
	};
	return new ReadableStream({ pull: d });
}
const uI = aI;
function cI(e, t, n) {
	switch (t) {
		case 0: return e[0] += n, Do(e[0]);
		case 1:
		case 2: return e[t].push(n), Do(e[t]);
	}
}
function cl(e, t) {
	switch (t) {
		case 0:
			const n = e[0];
			return e[0] = "", n;
		case 1:
		case 2: return e[t].flush();
	}
	throw new Error(`@smithy/util-stream - invalid index ${t} given to flush()`);
}
function Do(e) {
	return (e == null ? void 0 : e.byteLength) ?? (e == null ? void 0 : e.length) ?? 0;
}
function lI(e, t = !0) {
	return t && typeof Buffer < "u" && e instanceof Buffer ? 2 : e instanceof Uint8Array ? 1 : typeof e == "string" ? 0 : -1;
}
const fI = (e, t) => {
	const { base64Encoder: n, bodyLengthChecker: r, checksumAlgorithmFn: s, checksumLocationName: o, streamHasher: u } = t, c = n !== void 0 && r !== void 0 && s !== void 0 && o !== void 0 && u !== void 0, d = c ? u(s, e) : void 0, f = e.getReader();
	return new ReadableStream({ async pull(m) {
		const { value: y, done: w } = await f.read();
		if (w) {
			if (m.enqueue(`0\r
`), c) {
				const E = n(await d);
				m.enqueue(`${o}:${E}\r
`), m.enqueue(`\r
`);
			}
			m.close();
		} else m.enqueue(`${(r(y) || 0).toString(16)}\r
${y}\r
`);
	} });
};
async function dI(e, t) {
	let n = 0;
	const r = [], s = e.getReader();
	let o = !1;
	for (; !o;) {
		const { done: d, value: f } = await s.read();
		if (f && (r.push(f), n += (f == null ? void 0 : f.byteLength) ?? 0), n >= t) break;
		o = d;
	}
	s.releaseLock();
	const u = new Uint8Array(Math.min(t, n));
	let c = 0;
	for (const d of r) {
		if (d.byteLength > u.byteLength - c) {
			u.set(d.subarray(0, u.byteLength - c), c);
			break;
		} else u.set(d, c);
		c += d.length;
	}
	return u;
}
const $i = (e) => encodeURIComponent(e).replace(/[!'()*]/g, hI), hI = (e) => `%${e.charCodeAt(0).toString(16).toUpperCase()}`;
function GD(e) {
	const t = [];
	for (let n of Object.keys(e).sort()) {
		const r = e[n];
		if (n = $i(n), Array.isArray(r)) for (let s = 0, o = r.length; s < o; s++) t.push(`${n}=${$i(r[s])}`);
		else {
			let s = n;
			(r || typeof r == "string") && (s += `=${$i(r)}`), t.push(s);
		}
	}
	return t.join("&");
}
function l0(e, t) {
	return new Request(e, t);
}
function pI(e = 0) {
	return new Promise((t, n) => {
		e && setTimeout(() => {
			const r = /* @__PURE__ */ new Error(`Request did not complete within ${e} ms`);
			r.name = "TimeoutError", n(r);
		}, e);
	});
}
const ll = { supported: void 0 };
var Dd = class Dd {
	constructor(t) {
		P(this, "config");
		P(this, "configProvider");
		typeof t == "function" ? this.configProvider = t().then((n) => n || {}) : (this.config = t ?? {}, this.configProvider = Promise.resolve(this.config)), ll.supported === void 0 && (ll.supported = typeof Request < "u" && "keepalive" in l0("https://[::1]"));
	}
	static create(t) {
		return typeof (t == null ? void 0 : t.handle) == "function" ? t : new Dd(t);
	}
	destroy() {}
	async handle(t, { abortSignal: n, requestTimeout: r } = {}) {
		var V;
		this.config || (this.config = await this.configProvider);
		const s = r ?? this.config.requestTimeout, o = this.config.keepAlive === !0, u = this.config.credentials;
		if (n != null && n.aborted) {
			const H = /* @__PURE__ */ new Error("Request aborted");
			return H.name = "AbortError", Promise.reject(H);
		}
		let c = t.path;
		const d = GD(t.query || {});
		d && (c += `?${d}`), t.fragment && (c += `#${t.fragment}`);
		let f = "";
		if (t.username != null || t.password != null) f = `${t.username ?? ""}:${t.password ?? ""}@`;
		const { port: m, method: y } = t, w = `${t.protocol}//${f}${t.hostname}${m ? `:${m}` : ""}${c}`, E = y === "GET" || y === "HEAD" ? void 0 : t.body, A = {
			body: E,
			headers: new Headers(t.headers),
			method: y,
			credentials: u
		};
		(V = this.config) != null && V.cache && (A.cache = this.config.cache), E && (A.duplex = "half"), typeof AbortController < "u" && (A.signal = n), ll.supported && (A.keepalive = o), typeof this.config.requestInit == "function" && Object.assign(A, this.config.requestInit(t));
		let B = () => {};
		const T = l0(w, A), $ = [fetch(T).then((H) => {
			const Q = H.headers, te = {};
			for (const De of Q.entries()) te[De[0]] = De[1];
			return H.body != null ? { response: new qi({
				headers: te,
				reason: H.statusText,
				statusCode: H.status,
				body: H.body
			}) } : H.blob().then((De) => ({ response: new qi({
				headers: te,
				reason: H.statusText,
				statusCode: H.status,
				body: De
			}) }));
		}), pI(s)];
		return n && $.push(new Promise((H, Q) => {
			const te = () => {
				const ge = /* @__PURE__ */ new Error("Request aborted");
				ge.name = "AbortError", Q(ge);
			};
			if (typeof n.addEventListener == "function") {
				const ge = n;
				ge.addEventListener("abort", te, { once: !0 }), B = () => ge.removeEventListener("abort", te);
			} else n.onabort = te;
		})), Promise.race($).finally(B);
	}
	updateHttpClientConfig(t, n) {
		this.config = void 0, this.configProvider = this.configProvider.then((r) => (r[t] = n, r));
	}
	httpHandlerConfigs() {
		return this.config ?? {};
	}
};
const WD = async (e) => {
	var t;
	return typeof Blob == "function" && e instanceof Blob || ((t = e.constructor) == null ? void 0 : t.name) === "Blob" ? Blob.prototype.arrayBuffer !== void 0 ? new Uint8Array(await e.arrayBuffer()) : gI(e) : mI(e);
};
async function gI(e) {
	const n = Rs(await yI(e));
	return new Uint8Array(n);
}
async function mI(e) {
	const t = [], n = e.getReader();
	let r = !1, s = 0;
	for (; !r;) {
		const { done: c, value: d } = await n.read();
		d && (t.push(d), s += d.length), r = c;
	}
	const o = new Uint8Array(s);
	let u = 0;
	for (const c of t) o.set(c, u), u += c.length;
	return o;
}
function yI(e) {
	return new Promise((t, n) => {
		const r = new FileReader();
		r.onloadend = () => {
			if (r.readyState !== 2) return n(/* @__PURE__ */ new Error("Reader aborted too early"));
			const s = r.result ?? "", o = s.indexOf(","), u = o > -1 ? o + 1 : s.length;
			t(s.substring(u));
		}, r.onabort = () => n(/* @__PURE__ */ new Error("Read aborted")), r.onerror = () => n(r.error), r.readAsDataURL(e);
	});
}
const KD = {}, Cf = {};
for (let e = 0; e < 256; e++) {
	let t = e.toString(16).toLowerCase();
	t.length === 1 && (t = `0${t}`), KD[e] = t, Cf[t] = e;
}
function VD(e) {
	if (e.length % 2 !== 0) throw new Error("Hex encoded strings must have an even number length");
	const t = new Uint8Array(e.length / 2);
	for (let n = 0; n < e.length; n += 2) {
		const r = e.slice(n, n + 2).toLowerCase();
		if (r in Cf) t[n / 2] = Cf[r];
		else throw new Error(`Cannot decode unrecognized sequence ${r} as hexadecimal`);
	}
	return t;
}
function vn(e) {
	let t = "";
	for (let n = 0; n < e.byteLength; n++) t += KD[e[n]];
	return t;
}
const f0 = "The stream has already been transformed.", ZD = (e) => {
	var s, o;
	if (!d0(e) && !Sf(e)) {
		const u = ((o = (s = e == null ? void 0 : e.__proto__) == null ? void 0 : s.constructor) == null ? void 0 : o.name) || e;
		throw new Error(`Unexpected stream implementation, expect Blob or ReadableStream, got ${u}`);
	}
	let t = !1;
	const n = async () => {
		if (t) throw new Error(f0);
		return t = !0, await WD(e);
	}, r = (u) => {
		if (typeof u.stream != "function") throw new Error(`Cannot transform payload Blob to web stream. Please make sure the Blob.stream() is polyfilled.
If you are using React Native, this API is not yet supported, see: https://react-native.canny.io/feature-requests/p/fetch-streaming-body`);
		return u.stream();
	};
	return Object.assign(e, {
		transformToByteArray: n,
		transformToString: async (u) => {
			const c = await n();
			if (u === "base64") return ji(c);
			if (u === "hex") return vn(c);
			if (u === void 0 || u === "utf8" || u === "utf-8") return Ki(c);
			if (typeof TextDecoder == "function") return new TextDecoder(u).decode(c);
			throw new Error("TextDecoder is not available, please make sure polyfill is provided.");
		},
		transformToWebStream: () => {
			if (t) throw new Error(f0);
			if (t = !0, d0(e)) return r(e);
			if (Sf(e)) return e;
			throw new Error(`Cannot transform payload to web stream, got ${e}`);
		}
	});
}, d0 = (e) => typeof Blob == "function" && e instanceof Blob;
async function DI(e) {
	return typeof e.stream == "function" && (e = e.stream()), e.tee();
}
const $a = async (e = new Uint8Array(), t) => {
	if (e instanceof Uint8Array) return Mi.mutate(e);
	if (!e) return Mi.mutate(new Uint8Array());
	const n = t.streamCollector(e);
	return Mi.mutate(await n);
};
function h0(e) {
	return encodeURIComponent(e).replace(/[!'()*]/g, function(t) {
		return "%" + t.charCodeAt(0).toString(16).toUpperCase();
	});
}
const fl = (e) => typeof e == "function" ? e() : e, JD = (e, t, n, r, s) => ({
	name: t,
	namespace: e,
	traits: n,
	input: r,
	output: s
}), wI = (e) => (t, n) => async (r) => {
	var y, w, E, A;
	const { response: s } = await t(r), { operationSchema: o } = Ci(n), [, u, c, d, f, m] = o ?? [];
	try {
		return {
			response: s,
			output: await e.protocol.deserializeResponse(JD(u, c, d, f, m), {
				...e,
				...n
			}, s)
		};
	} catch (B) {
		if (Object.defineProperty(B, "$response", {
			value: s,
			enumerable: !1,
			writable: !1,
			configurable: !1
		}), !("$metadata" in B)) {
			const T = "Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object.";
			try {
				B.message += `
  Deserialization error: to see the raw response, inspect the hidden field {error}.\$response on this object.`;
			} catch {
				!n.logger || ((w = (y = n.logger) == null ? void 0 : y.constructor) == null ? void 0 : w.name) === "NoOpLogger" ? console.warn(T) : (A = (E = n.logger) == null ? void 0 : E.warn) == null || A.call(E, T);
			}
			typeof B.$responseBodyText < "u" && B.$response && (B.$response.body = B.$responseBodyText);
			try {
				if (qi.isInstance(s)) {
					const { headers: $ = {} } = s, V = Object.entries($);
					B.$metadata = {
						httpStatusCode: s.statusCode,
						requestId: dl(/^x-[\w-]+-request-?id$/, V),
						extendedRequestId: dl(/^x-[\w-]+-id-2$/, V),
						cfId: dl(/^x-[\w-]+-cf-id$/, V)
					};
				}
			} catch {}
		}
		throw B;
	}
}, dl = (e, t) => (t.find(([n]) => n.match(e)) || [void 0, void 0])[1], bI = (e) => (t, n) => async (r) => {
	var w;
	const { operationSchema: s } = Ci(n), [, o, u, c, d, f] = s ?? [], m = (w = n.endpointV2) != null && w.url && e.urlParser ? async () => e.urlParser(n.endpointV2.url) : e.endpoint, y = await e.protocol.serializeRequest(JD(o, u, c, d, f), r.input, {
		...e,
		...n,
		endpoint: m
	});
	return t({
		...r,
		request: y
	});
}, EI = {
	name: "deserializerMiddleware",
	step: "deserialize",
	tags: ["DESERIALIZER"],
	override: !0
}, vI = {
	name: "serializerMiddleware",
	step: "serialize",
	tags: ["SERIALIZER"],
	override: !0
};
function SI(e) {
	return { applyToStack: (t) => {
		t.add(bI(e), vI), t.add(wI(e), EI), e.protocol.setSerdeContext(e);
	} };
}
function Ds(e) {
	if (typeof e == "object") return e;
	e = e | 0;
	const t = {};
	let n = 0;
	for (const r of [
		"httpLabel",
		"idempotent",
		"idempotencyToken",
		"sensitive",
		"httpPayload",
		"httpResponseCode",
		"httpQueryParams"
	]) (e >> n++ & 1) === 1 && (t[r] = 1);
	return t;
}
const p0 = { it: Symbol.for("@smithy/nor-struct-it") }, mi = class mi {
	constructor(t, n) {
		P(this, "ref");
		P(this, "memberName");
		P(this, "symbol", mi.symbol);
		P(this, "name");
		P(this, "schema");
		P(this, "_isMemberSchema");
		P(this, "traits");
		P(this, "memberTraits");
		P(this, "normalizedTraits");
		this.ref = t, this.memberName = n;
		const r = [];
		let s = t, o = t;
		for (this._isMemberSchema = !1; hl(s);) r.push(s[1]), s = s[0], o = fl(s), this._isMemberSchema = !0;
		if (r.length > 0) {
			this.memberTraits = {};
			for (let u = r.length - 1; u >= 0; --u) {
				const c = r[u];
				Object.assign(this.memberTraits, Ds(c));
			}
		} else this.memberTraits = 0;
		if (o instanceof mi) {
			const u = this.memberTraits;
			Object.assign(this, o), this.memberTraits = Object.assign({}, u, o.getMemberTraits(), this.getMemberTraits()), this.normalizedTraits = void 0, this.memberName = n ?? o.memberName;
			return;
		}
		if (this.schema = fl(o), CI(this.schema) ? (this.name = `${this.schema[1]}#${this.schema[2]}`, this.traits = this.schema[3]) : (this.name = this.memberName ?? String(o), this.traits = 0), this._isMemberSchema && !n) throw new Error(`@smithy/core/schema - NormalizedSchema member init ${this.getName(!0)} missing member name.`);
	}
	static [Symbol.hasInstance](t) {
		const n = this.prototype.isPrototypeOf(t);
		return !n && typeof t == "object" && t !== null ? t.symbol === this.symbol : n;
	}
	static of(t) {
		const n = fl(t);
		if (n instanceof mi) return n;
		if (hl(n)) {
			const [r, s] = n;
			if (r instanceof mi) return Object.assign(r.getMergedTraits(), Ds(s)), r;
			throw new Error(`@smithy/core/schema - may not init unwrapped member schema=${JSON.stringify(t, null, 2)}.`);
		}
		return new mi(n);
	}
	getSchema() {
		const t = this.schema;
		return Array.isArray(t) && t[0] === 0 ? t[4] : t;
	}
	getName(t = !1) {
		const { name: n } = this;
		return !t && n && n.includes("#") ? n.split("#")[1] : n || void 0;
	}
	getMemberName() {
		return this.memberName;
	}
	isMemberSchema() {
		return this._isMemberSchema;
	}
	isListSchema() {
		const t = this.getSchema();
		return typeof t == "number" ? t >= 64 && t < 128 : t[0] === 1;
	}
	isMapSchema() {
		const t = this.getSchema();
		return typeof t == "number" ? t >= 128 && t <= 255 : t[0] === 2;
	}
	isStructSchema() {
		const t = this.getSchema();
		if (typeof t != "object") return !1;
		const n = t[0];
		return n === 3 || n === -3 || n === 4;
	}
	isUnionSchema() {
		const t = this.getSchema();
		return typeof t != "object" ? !1 : t[0] === 4;
	}
	isBlobSchema() {
		const t = this.getSchema();
		return t === 21 || t === 42;
	}
	isTimestampSchema() {
		const t = this.getSchema();
		return typeof t == "number" && t >= 4 && t <= 7;
	}
	isUnitSchema() {
		return this.getSchema() === "unit";
	}
	isDocumentSchema() {
		return this.getSchema() === 15;
	}
	isStringSchema() {
		return this.getSchema() === 0;
	}
	isBooleanSchema() {
		return this.getSchema() === 2;
	}
	isNumericSchema() {
		return this.getSchema() === 1;
	}
	isBigIntegerSchema() {
		return this.getSchema() === 17;
	}
	isBigDecimalSchema() {
		return this.getSchema() === 19;
	}
	isStreaming() {
		const { streaming: t } = this.getMergedTraits();
		return !!t || this.getSchema() === 42;
	}
	isIdempotencyToken() {
		return !!this.getMergedTraits().idempotencyToken;
	}
	getMergedTraits() {
		return this.normalizedTraits ?? (this.normalizedTraits = {
			...this.getOwnTraits(),
			...this.getMemberTraits()
		});
	}
	getMemberTraits() {
		return Ds(this.memberTraits);
	}
	getOwnTraits() {
		return Ds(this.traits);
	}
	getKeySchema() {
		const [t, n] = [this.isDocumentSchema(), this.isMapSchema()];
		if (!t && !n) throw new Error(`@smithy/core/schema - cannot get key for non-map: ${this.getName(!0)}`);
		const r = this.getSchema();
		return co([t ? 15 : r[4] ?? 0, 0], "key");
	}
	getValueSchema() {
		const t = this.getSchema(), [n, r, s] = [
			this.isDocumentSchema(),
			this.isMapSchema(),
			this.isListSchema()
		], o = typeof t == "number" ? 63 & t : t && typeof t == "object" && (r || s) ? t[3 + t[0]] : n ? 15 : void 0;
		if (o != null) return co([o, 0], r ? "value" : "member");
		throw new Error(`@smithy/core/schema - ${this.getName(!0)} has no value member.`);
	}
	getMemberSchema(t) {
		const n = this.getSchema();
		if (this.isStructSchema() && n[4].includes(t)) {
			const r = n[4].indexOf(t), s = n[5][r];
			return co(hl(s) ? s : [s, 0], t);
		}
		if (this.isDocumentSchema()) return co([15, 0], t);
		throw new Error(`@smithy/core/schema - ${this.getName(!0)} has no no member=${t}.`);
	}
	getMemberSchemas() {
		const t = {};
		try {
			for (const [n, r] of this.structIterator()) t[n] = r;
		} catch {}
		return t;
	}
	getEventStreamMember() {
		if (this.isStructSchema()) {
			for (const [t, n] of this.structIterator()) if (n.isStreaming() && n.isStructSchema()) return t;
		}
		return "";
	}
	*structIterator() {
		if (this.isUnitSchema()) return;
		if (!this.isStructSchema()) throw new Error("@smithy/core/schema - cannot iterate non-struct schema.");
		const t = this.getSchema(), n = t[4].length;
		let r = t[p0.it];
		if (r && n === r.length) {
			yield* r;
			return;
		}
		r = Array(n);
		for (let s = 0; s < n; ++s) {
			const o = t[4][s], u = co([t[5][s], 0], o);
			yield r[s] = [o, u];
		}
		t[p0.it] = r;
	}
};
P(mi, "symbol", Symbol.for("@smithy/nor"));
let Dt = mi;
function co(e, t) {
	if (e instanceof Dt) return Object.assign(e, {
		memberName: t,
		_isMemberSchema: !0
	});
	return new Dt(e, t);
}
const hl = (e) => Array.isArray(e) && e.length === 2, CI = (e) => Array.isArray(e) && e.length >= 5, Er = class Er {
	constructor(t, n = /* @__PURE__ */ new Map(), r = /* @__PURE__ */ new Map()) {
		P(this, "namespace");
		P(this, "schemas");
		P(this, "exceptions");
		this.namespace = t, this.schemas = n, this.exceptions = r;
	}
	static for(t) {
		return Er.registries.has(t) || Er.registries.set(t, new Er(t)), Er.registries.get(t);
	}
	register(t, n) {
		const r = this.normalizeShapeId(t);
		Er.for(r.split("#")[0]).schemas.set(r, n);
	}
	getSchema(t) {
		const n = this.normalizeShapeId(t);
		if (!this.schemas.has(n)) throw new Error(`@smithy/core/schema - schema not found for ${n}`);
		return this.schemas.get(n);
	}
	registerError(t, n) {
		const r = t, s = Er.for(r[1]);
		s.schemas.set(r[1] + "#" + r[2], r), s.exceptions.set(r, n);
	}
	getErrorCtor(t) {
		const n = t;
		return Er.for(n[1]).exceptions.get(n);
	}
	getBaseException() {
		for (const t of this.exceptions.keys()) if (Array.isArray(t)) {
			const [, n, r] = t, s = n + "#" + r;
			if (s.startsWith("smithy.ts.sdk.synthetic.") && s.endsWith("ServiceException")) return t;
		}
	}
	find(t) {
		return [...this.schemas.values()].find(t);
	}
	clear() {
		this.schemas.clear(), this.exceptions.clear();
	}
	normalizeShapeId(t) {
		return t.includes("#") ? t : this.namespace + "#" + t;
	}
};
P(Er, "registries", /* @__PURE__ */ new Map());
let Et = Er;
const xI = [
	"Sun",
	"Mon",
	"Tue",
	"Wed",
	"Thu",
	"Fri",
	"Sat"
], FI = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec"
];
function xf(e) {
	const t = e.getUTCFullYear(), n = e.getUTCMonth(), r = e.getUTCDay(), s = e.getUTCDate(), o = e.getUTCHours(), u = e.getUTCMinutes(), c = e.getUTCSeconds(), d = s < 10 ? `0${s}` : `${s}`, f = o < 10 ? `0${o}` : `${o}`, m = u < 10 ? `0${u}` : `${u}`, y = c < 10 ? `0${c}` : `${c}`;
	return `${xI[r]}, ${d} ${FI[n]} ${t} ${f}:${m}:${y} GMT`;
}
const g0 = typeof crypto < "u" && crypto.randomUUID && crypto.randomUUID.bind(crypto), Xt = Array.from({ length: 256 }, (e, t) => t.toString(16).padStart(2, "0")), wd = () => {
	if (g0) return g0();
	const e = new Uint8Array(16);
	return crypto.getRandomValues(e), e[6] = e[6] & 15 | 64, e[8] = e[8] & 63 | 128, Xt[e[0]] + Xt[e[1]] + Xt[e[2]] + Xt[e[3]] + "-" + Xt[e[4]] + Xt[e[5]] + "-" + Xt[e[6]] + Xt[e[7]] + "-" + Xt[e[8]] + Xt[e[9]] + "-" + Xt[e[10]] + Xt[e[11]] + Xt[e[12]] + Xt[e[13]] + Xt[e[14]] + Xt[e[15]];
}, Di = function(t) {
	return Object.assign(new String(t), {
		deserializeJSON() {
			return JSON.parse(String(t));
		},
		toString() {
			return String(t);
		},
		toJSON() {
			return String(t);
		}
	});
};
Di.from = (e) => e && typeof e == "object" && (e instanceof Di || "deserializeJSON" in e) ? e : typeof e == "string" || Object.getPrototypeOf(e) === String.prototype ? Di(String(e)) : Di(JSON.stringify(e));
Di.fromObject = Di.from;
function AI(e) {
	return (e.includes(",") || e.includes("\"")) && (e = `"${e.replace(/"/g, "\\\"")}"`), e;
}
const bd = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:[ne|u?r]?s?day)?", Ed = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)", vd = "(\\d?\\d):(\\d{2}):(\\d{2})(?:\\.(\\d+))?", XD = "(\\d?\\d)", YD = "(\\d{4})", _I = /* @__PURE__ */ new RegExp(/^(\d{4})-(\d\d)-(\d\d)[tT](\d\d):(\d\d):(\d\d)(\.(\d+))?(([-+]\d\d:\d\d)|[zZ])$/), BI = new RegExp(`^${bd}, ${XD} ${Ed} ${YD} ${vd} GMT$`), II = new RegExp(`^${bd}, ${XD}-${Ed}-(\\d\\d) ${vd} GMT$`), kI = new RegExp(`^${bd} ${Ed} ( [1-9]|\\d\\d) ${vd} ${YD}$`), RI = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec"
], TI = (e) => {
	if (e == null) return;
	let t = NaN;
	if (typeof e == "number") t = e;
	else if (typeof e == "string") {
		if (!/^-?\d*\.?\d+$/.test(e)) throw new TypeError("parseEpochTimestamp - numeric string invalid.");
		t = Number.parseFloat(e);
	} else typeof e == "object" && e.tag === 1 && (t = e.value);
	if (isNaN(t) || Math.abs(t) === Infinity) throw new TypeError("Epoch timestamps must be valid finite numbers.");
	return new Date(Math.round(t * 1e3));
}, PI = (e) => {
	if (e == null) return;
	if (typeof e != "string") throw new TypeError("RFC3339 timestamps must be strings");
	const t = _I.exec(e);
	if (!t) throw new TypeError(`Invalid RFC3339 timestamp format ${e}`);
	const [, n, r, s, o, u, c, , d, f] = t;
	Vr(r, 1, 12), Vr(s, 1, 31), Vr(o, 0, 23), Vr(u, 0, 59), Vr(c, 0, 60);
	const m = new Date(Date.UTC(Number(n), Number(r) - 1, Number(s), Number(o), Number(u), Number(c), Number(d) ? Math.round(parseFloat(`0.${d}`) * 1e3) : 0));
	if (m.setUTCFullYear(Number(n)), f.toUpperCase() != "Z") {
		const [, y, w, E] = /([+-])(\d\d):(\d\d)/.exec(f) || [
			void 0,
			"+",
			0,
			0
		], A = y === "-" ? 1 : -1;
		m.setTime(m.getTime() + A * (Number(w) * 60 * 60 * 1e3 + Number(E) * 60 * 1e3));
	}
	return m;
}, NI = (e) => {
	if (e == null) return;
	if (typeof e != "string") throw new TypeError("RFC7231 timestamps must be strings.");
	let t, n, r, s, o, u, c, d;
	if ((d = BI.exec(e)) ? [, t, n, r, s, o, u, c] = d : (d = II.exec(e)) ? ([, t, n, r, s, o, u, c] = d, r = (Number(r) + 1900).toString()) : (d = kI.exec(e)) && ([, n, t, s, o, u, c, r] = d), r && u) {
		const f = Date.UTC(Number(r), RI.indexOf(n), Number(t), Number(s), Number(o), Number(u), c ? Math.round(parseFloat(`0.${c}`) * 1e3) : 0);
		Vr(t, 1, 31), Vr(s, 0, 23), Vr(o, 0, 59), Vr(u, 0, 60);
		const m = new Date(f);
		return m.setUTCFullYear(Number(r)), m;
	}
	throw new TypeError(`Invalid RFC7231 date-time value ${e}.`);
};
function Vr(e, t, n) {
	const r = Number(e);
	if (r < t || r > n) throw new Error(`Value ${r} out of range [${t}, ${n}]`);
}
function OI(e, t, n) {
	if (!Number.isInteger(n)) throw new Error("Invalid number of delimiters (" + n + ") for splitEvery.");
	const r = e.split(t), s = [];
	let o = "";
	for (let u = 0; u < r.length; u++) o === "" ? o = r[u] : o += t + r[u], (u + 1) % n === 0 && (s.push(o), o = "");
	return o !== "" && s.push(o), s;
}
const QD = (e) => {
	const t = e.length, n = [];
	let r = !1, s, o = 0;
	for (let u = 0; u < t; ++u) {
		const c = e[u];
		switch (c) {
			case "\"":
				s !== "\\" && (r = !r);
				break;
			case ",":
				r || (n.push(e.slice(o, u)), o = u + 1);
				break;
		}
		s = c;
	}
	return n.push(e.slice(o)), n.map((u) => {
		u = u.trim();
		const c = u.length;
		return c < 2 ? u : (u[0] === "\"" && u[c - 1] === "\"" && (u = u.slice(1, c - 1)), u.replace(/\\"/g, "\""));
	});
}, m0 = /^-?\d*(\.\d+)?$/;
var _u = class _u {
	constructor(t, n) {
		P(this, "string");
		P(this, "type");
		if (this.string = t, this.type = n, !m0.test(t)) throw new Error("@smithy/core/serde - NumericValue must only contain [0-9], at most one decimal point \".\", and an optional negation prefix \"-\".");
	}
	toString() {
		return this.string;
	}
	static [Symbol.hasInstance](t) {
		if (!t || typeof t != "object") return !1;
		const n = t;
		return _u.prototype.isPrototypeOf(t) || n.type === "bigDecimal" && m0.test(n.string);
	}
};
var Bu = class {
	constructor() {
		P(this, "serdeContext");
	}
	setSerdeContext(t) {
		this.serdeContext = t;
	}
};
var UI = class extends Bu {
	constructor(n) {
		super();
		P(this, "options");
		this.options = n;
	}
	getRequestType() {
		return bt;
	}
	getResponseType() {
		return qi;
	}
	setSerdeContext(n) {
		this.serdeContext = n, this.serializer.setSerdeContext(n), this.deserializer.setSerdeContext(n), this.getPayloadCodec() && this.getPayloadCodec().setSerdeContext(n);
	}
	updateServiceEndpoint(n, r) {
		if ("url" in r) {
			n.protocol = r.url.protocol, n.hostname = r.url.hostname, n.port = r.url.port ? Number(r.url.port) : void 0, n.path = r.url.pathname, n.fragment = r.url.hash || void 0, n.username = r.url.username || void 0, n.password = r.url.password || void 0, n.query || (n.query = {});
			for (const [s, o] of r.url.searchParams.entries()) n.query[s] = o;
			return n;
		} else return n.protocol = r.protocol, n.hostname = r.hostname, n.port = r.port ? Number(r.port) : void 0, n.path = r.path, n.query = { ...r.query }, n;
	}
	setHostPrefix(n, r, s) {
		var c, d;
		if ((c = this.serdeContext) != null && c.disableHostPrefix) return;
		const o = Dt.of(r.input), u = Ds(r.traits ?? {});
		if (u.endpoint) {
			let f = (d = u.endpoint) == null ? void 0 : d[0];
			if (typeof f == "string") {
				const m = [...o.structIterator()].filter(([, y]) => y.getMergedTraits().hostLabel);
				for (const [y] of m) {
					const w = s[y];
					if (typeof w != "string") throw new Error(`@smithy/core/schema - ${y} in input must be a string as hostLabel.`);
					f = f.replace(`{${y}}`, w);
				}
				n.hostname = f + n.hostname;
			}
		}
	}
	deserializeMetadata(n) {
		return {
			httpStatusCode: n.statusCode,
			requestId: n.headers["x-amzn-requestid"] ?? n.headers["x-amzn-request-id"] ?? n.headers["x-amz-request-id"],
			extendedRequestId: n.headers["x-amz-id-2"],
			cfId: n.headers["x-amz-cf-id"]
		};
	}
	async serializeEventStream({ eventStream: n, requestSchema: r, initialRequest: s }) {
		return (await this.loadEventStreamCapability()).serializeEventStream({
			eventStream: n,
			requestSchema: r,
			initialRequest: s
		});
	}
	async deserializeEventStream({ response: n, responseSchema: r, initialResponseContainer: s }) {
		return (await this.loadEventStreamCapability()).deserializeEventStream({
			response: n,
			responseSchema: r,
			initialResponseContainer: s
		});
	}
	async loadEventStreamCapability() {
		const { EventStreamSerde: n } = await Promise.resolve().then(() => bO);
		return new n({
			marshaller: this.getEventStreamMarshaller(),
			serializer: this.serializer,
			deserializer: this.deserializer,
			serdeContext: this.serdeContext,
			defaultContentType: this.getDefaultContentType()
		});
	}
	getDefaultContentType() {
		throw new Error(`@smithy/core/protocols - ${this.constructor.name} getDefaultContentType() implementation missing.`);
	}
	async deserializeHttpMessage(n, r, s, o, u) {
		return [];
	}
	getEventStreamMarshaller() {
		const n = this.serdeContext;
		if (!n.eventStreamMarshaller) throw new Error("@smithy/core - HttpProtocol: eventStreamMarshaller missing in serdeContext.");
		return n.eventStreamMarshaller;
	}
};
var MI = class extends UI {
	async serializeRequest(t, n, r) {
		const s = { ...n ?? {} }, o = this.serializer, u = {}, c = {}, d = await r.endpoint(), f = Dt.of(t == null ? void 0 : t.input), m = f.getSchema();
		let y = !1, w;
		const E = new bt({
			protocol: "",
			hostname: "",
			port: void 0,
			path: "",
			fragment: void 0,
			query: u,
			headers: c,
			body: void 0
		});
		if (d) {
			this.updateServiceEndpoint(E, d), this.setHostPrefix(E, t, s);
			const A = Ds(t.traits);
			if (A.http) {
				E.method = A.http[0];
				const [B, T] = A.http[1].split("?");
				E.path == "/" ? E.path = B : E.path += B;
				const $ = new URLSearchParams(T ?? "");
				Object.assign(u, Object.fromEntries($));
			}
		}
		for (const [A, B] of f.structIterator()) {
			const T = B.getMergedTraits() ?? {}, $ = s[A];
			if ($ == null && !B.isIdempotencyToken()) {
				if (T.httpLabel && (E.path.includes(`{${A}+}`) || E.path.includes(`{${A}}`))) throw new Error(`No value provided for input HTTP label: ${A}.`);
				continue;
			}
			if (T.httpPayload) B.isStreaming() ? B.isStructSchema() ? s[A] && (w = await this.serializeEventStream({
				eventStream: s[A],
				requestSchema: f
			})) : w = $ : (o.write(B, $), w = o.flush()), delete s[A];
			else if (T.httpLabel) {
				o.write(B, $);
				const V = o.flush();
				E.path.includes(`{${A}+}`) ? E.path = E.path.replace(`{${A}+}`, V.split("/").map(h0).join("/")) : E.path.includes(`{${A}}`) && (E.path = E.path.replace(`{${A}}`, h0(V))), delete s[A];
			} else if (T.httpHeader) o.write(B, $), c[T.httpHeader.toLowerCase()] = String(o.flush()), delete s[A];
			else if (typeof T.httpPrefixHeaders == "string") {
				for (const [V, H] of Object.entries($)) {
					const Q = T.httpPrefixHeaders + V;
					o.write([B.getValueSchema(), { httpHeader: Q }], H), c[Q.toLowerCase()] = o.flush();
				}
				delete s[A];
			} else T.httpQuery || T.httpQueryParams ? (this.serializeQuery(B, $, u), delete s[A]) : y = !0;
		}
		return y && s && (o.write(m, s), w = o.flush()), E.headers = c, E.query = u, E.body = w, E;
	}
	serializeQuery(t, n, r) {
		const s = this.serializer, o = t.getMergedTraits();
		if (o.httpQueryParams) {
			for (const [u, c] of Object.entries(n)) if (!(u in r)) {
				const d = t.getValueSchema();
				Object.assign(d.getMergedTraits(), {
					...o,
					httpQuery: u,
					httpQueryParams: void 0
				}), this.serializeQuery(d, c, r);
			}
			return;
		}
		if (t.isListSchema()) {
			const u = !!t.getMergedTraits().sparse, c = [];
			for (const d of n) {
				s.write([t.getValueSchema(), o], d);
				const f = s.flush();
				(u || f !== void 0) && c.push(f);
			}
			r[o.httpQuery] = c;
		} else s.write([t, o], n), r[o.httpQuery] = s.flush();
	}
	async deserializeResponse(t, n, r) {
		const s = this.deserializer, o = Dt.of(t.output), u = {};
		if (r.statusCode >= 300) {
			const d = await $a(r.body, n);
			throw d.byteLength > 0 && Object.assign(u, await s.read(15, d)), await this.handleError(t, n, r, u, this.deserializeMetadata(r)), /* @__PURE__ */ new Error("@smithy/core/protocols - HTTP Protocol error handler failed to throw.");
		}
		for (const d in r.headers) {
			const f = r.headers[d];
			delete r.headers[d], r.headers[d.toLowerCase()] = f;
		}
		const c = await this.deserializeHttpMessage(o, n, r, u);
		if (c.length) {
			const d = await $a(r.body, n);
			if (d.byteLength > 0) {
				const f = await s.read(o, d);
				for (const m of c) u[m] = f[m];
			}
		} else c.discardResponseBody && await $a(r.body, n);
		return u.$metadata = this.deserializeMetadata(r), u;
	}
	async deserializeHttpMessage(t, n, r, s, o) {
		let u;
		s instanceof Set ? u = o : u = s;
		let c = !0;
		const d = this.deserializer, f = Dt.of(t), m = [];
		for (const [y, w] of f.structIterator()) {
			const E = w.getMemberTraits();
			if (E.httpPayload) {
				if (c = !1, w.isStreaming()) w.isStructSchema() ? u[y] = await this.deserializeEventStream({
					response: r,
					responseSchema: f
				}) : u[y] = ZD(r.body);
				else if (r.body) {
					const B = await $a(r.body, n);
					B.byteLength > 0 && (u[y] = await d.read(w, B));
				}
			} else if (E.httpHeader) {
				const A = String(E.httpHeader).toLowerCase(), B = r.headers[A];
				if (B != null) if (w.isListSchema()) {
					const T = w.getValueSchema();
					T.getMergedTraits().httpHeader = A;
					let $;
					T.isTimestampSchema() && T.getSchema() === 4 ? $ = OI(B, ",", 2) : $ = QD(B);
					const V = [];
					for (const H of $) V.push(await d.read(T, H.trim()));
					u[y] = V;
				} else u[y] = await d.read(w, B);
			} else if (E.httpPrefixHeaders !== void 0) {
				u[y] = {};
				for (const [A, B] of Object.entries(r.headers)) if (A.startsWith(E.httpPrefixHeaders)) {
					const T = w.getValueSchema();
					T.getMergedTraits().httpHeader = A, u[y][A.slice(E.httpPrefixHeaders.length)] = await d.read(T, B);
				}
			} else E.httpResponseCode ? u[y] = r.statusCode : m.push(y);
		}
		return m.discardResponseBody = c, m;
	}
};
function Sd(e, t) {
	if (t.timestampFormat.useTrait && e.isTimestampSchema() && (e.getSchema() === 5 || e.getSchema() === 6 || e.getSchema() === 7)) return e.getSchema();
	const { httpLabel: n, httpPrefixHeaders: r, httpHeader: s, httpQuery: o } = e.getMergedTraits();
	return (t.httpBindings ? typeof r == "string" || s ? 6 : o || n ? 5 : void 0 : void 0) ?? t.timestampFormat.default;
}
var ew = class extends Bu {
	constructor(n) {
		super();
		P(this, "settings");
		this.settings = n;
	}
	read(n, r) {
		var o;
		const s = Dt.of(n);
		if (s.isListSchema()) return QD(r).map((u) => this.read(s.getValueSchema(), u));
		if (s.isBlobSchema()) return (((o = this.serdeContext) == null ? void 0 : o.base64Decoder) ?? Rs)(r);
		if (s.isTimestampSchema()) switch (Sd(s, this.settings)) {
			case 5: return PI(r);
			case 6: return NI(r);
			case 7: return TI(r);
			default: return console.warn("Missing timestamp format, parsing value with Date constructor:", r), new Date(r);
		}
		if (s.isStringSchema()) {
			const u = s.getMergedTraits().mediaType;
			let c = r;
			if (u) return s.getMergedTraits().httpHeader && (c = this.base64ToUtf8(c)), (u === "application/json" || u.endsWith("+json")) && (c = Di.from(c)), c;
		}
		return s.isNumericSchema() ? Number(r) : s.isBigIntegerSchema() ? BigInt(r) : s.isBigDecimalSchema() ? new _u(r, "bigDecimal") : s.isBooleanSchema() ? String(r).toLowerCase() === "true" : r;
	}
	base64ToUtf8(n) {
		var r, s;
		return (((r = this.serdeContext) == null ? void 0 : r.utf8Encoder) ?? Ki)((((s = this.serdeContext) == null ? void 0 : s.base64Decoder) ?? Rs)(n));
	}
};
var $I = class extends Bu {
	constructor(n, r) {
		super();
		P(this, "codecDeserializer");
		P(this, "stringDeserializer");
		this.codecDeserializer = n, this.stringDeserializer = new ew(r);
	}
	setSerdeContext(n) {
		this.stringDeserializer.setSerdeContext(n), this.codecDeserializer.setSerdeContext(n), this.serdeContext = n;
	}
	read(n, r) {
		var c, d;
		const s = Dt.of(n), o = s.getMergedTraits(), u = ((c = this.serdeContext) == null ? void 0 : c.utf8Encoder) ?? Ki;
		if (o.httpHeader || o.httpResponseCode) return this.stringDeserializer.read(s, u(r));
		if (o.httpPayload) {
			if (s.isBlobSchema()) {
				const f = ((d = this.serdeContext) == null ? void 0 : d.utf8Decoder) ?? Yr;
				return typeof r == "string" ? f(r) : r;
			} else if (s.isStringSchema()) return "byteLength" in r ? u(r) : r;
		}
		return this.codecDeserializer.read(s, r);
	}
};
var LI = class extends Bu {
	constructor(n) {
		super();
		P(this, "settings");
		P(this, "stringBuffer", "");
		this.settings = n;
	}
	write(n, r) {
		var o, u;
		const s = Dt.of(n);
		switch (typeof r) {
			case "object":
				if (r === null) {
					this.stringBuffer = "null";
					return;
				}
				if (s.isTimestampSchema()) {
					if (!(r instanceof Date)) throw new Error(`@smithy/core/protocols - received non-Date value ${r} when schema expected Date in ${s.getName(!0)}`);
					switch (Sd(s, this.settings)) {
						case 5:
							this.stringBuffer = r.toISOString().replace(".000Z", "Z");
							break;
						case 6:
							this.stringBuffer = xf(r);
							break;
						case 7:
							this.stringBuffer = String(r.getTime() / 1e3);
							break;
						default: console.warn("Missing timestamp format, using epoch seconds", r), this.stringBuffer = String(r.getTime() / 1e3);
					}
					return;
				}
				if (s.isBlobSchema() && "byteLength" in r) {
					this.stringBuffer = (((o = this.serdeContext) == null ? void 0 : o.base64Encoder) ?? ji)(r);
					return;
				}
				if (s.isListSchema() && Array.isArray(r)) {
					let f = "";
					for (const m of r) {
						this.write([s.getValueSchema(), s.getMergedTraits()], m);
						const y = this.flush(), w = s.getValueSchema().isTimestampSchema() ? y : AI(y);
						f !== "" && (f += ", "), f += w;
					}
					this.stringBuffer = f;
					return;
				}
				this.stringBuffer = JSON.stringify(r, null, 2);
				break;
			case "string":
				const c = s.getMergedTraits().mediaType;
				let d = r;
				if (c && ((c === "application/json" || c.endsWith("+json")) && (d = Di.from(d)), s.getMergedTraits().httpHeader)) {
					this.stringBuffer = (((u = this.serdeContext) == null ? void 0 : u.base64Encoder) ?? ji)(d.toString());
					return;
				}
				this.stringBuffer = r;
				break;
			default: s.isIdempotencyToken() ? this.stringBuffer = wd() : this.stringBuffer = String(r);
		}
	}
	flush() {
		const n = this.stringBuffer;
		return this.stringBuffer = "", n;
	}
};
var zI = class {
	constructor(t, n, r = new LI(n)) {
		P(this, "codecSerializer");
		P(this, "stringSerializer");
		P(this, "buffer");
		this.codecSerializer = t, this.stringSerializer = r;
	}
	setSerdeContext(t) {
		this.codecSerializer.setSerdeContext(t), this.stringSerializer.setSerdeContext(t);
	}
	write(t, n) {
		const r = Dt.of(t), s = r.getMergedTraits();
		if (s.httpHeader || s.httpLabel || s.httpQuery) {
			this.stringSerializer.write(r, n), this.buffer = this.stringSerializer.flush();
			return;
		}
		return this.codecSerializer.write(r, n);
	}
	flush() {
		if (this.buffer !== void 0) {
			const t = this.buffer;
			return this.buffer = void 0, t;
		}
		return this.codecSerializer.flush();
	}
};
function HI(e, t, n) {
	e.__smithy_context ? e.__smithy_context.features || (e.__smithy_context.features = {}) : e.__smithy_context = { features: {} }, e.__smithy_context.features[t] = n;
}
var qI = class {
	constructor(t) {
		P(this, "authSchemes", /* @__PURE__ */ new Map());
		for (const [n, r] of Object.entries(t)) r !== void 0 && this.authSchemes.set(n, r);
	}
	getIdentityProvider(t) {
		return this.authSchemes.get(t);
	}
};
const jI = (e) => function(n) {
	return tw(n) && n.expiration.getTime() - Date.now() < e;
}, WI = jI(3e5), tw = (e) => e.expiration !== void 0, KI = (e, t, n) => {
	if (e === void 0) return;
	const r = typeof e != "function" ? async () => Promise.resolve(e) : e;
	let s, o, u, c = !1;
	const d = async (f) => {
		o || (o = r(f));
		try {
			s = await o, u = !0, c = !1;
		} finally {
			o = void 0;
		}
		return s;
	};
	return t === void 0 ? async (f) => ((!u || f != null && f.forceRefresh) && (s = await d(f)), s) : async (f) => ((!u || f != null && f.forceRefresh) && (s = await d(f)), c ? s : n(s) ? (t(s) && await d(f), s) : (c = !0, s));
}, VI = (e, t, n) => {
	let r, s, o;
	const c = async () => {
		s || (s = e());
		try {
			r = await s, o = !0;
		} finally {
			s = void 0;
		}
		return r;
	};
	return async (d) => ((!o || d != null && d.forceRefresh) && (r = await c()), r);
}, ZI = (e) => (e.sigv4aSigningRegionSet = Fs(e.sigv4aSigningRegionSet), e), JI = "X-Amz-Algorithm", XI = "X-Amz-Credential", nw = "X-Amz-Date", YI = "X-Amz-SignedHeaders", QI = "X-Amz-Expires", rw = "X-Amz-Signature", iw = "X-Amz-Security-Token", sw = "authorization", ow = nw.toLowerCase(), tk = [
	sw,
	ow,
	"date"
], nk = rw.toLowerCase(), Ff = "x-amz-content-sha256", rk = iw.toLowerCase(), ik = {
	authorization: !0,
	"cache-control": !0,
	connection: !0,
	expect: !0,
	from: !0,
	"keep-alive": !0,
	"max-forwards": !0,
	pragma: !0,
	referer: !0,
	te: !0,
	trailer: !0,
	"transfer-encoding": !0,
	upgrade: !0,
	"user-agent": !0,
	"x-amzn-trace-id": !0
}, sk = /^proxy-/, ok = /^sec-/, pl = "AWS4-HMAC-SHA256", ak = "AWS4-HMAC-SHA256-PAYLOAD", uk = "UNSIGNED-PAYLOAD", ck = 50, aw = "aws4_request", lk = 3600 * 24 * 7, La = {}, gl = [], ml = (e, t, n) => `${e}/${t}/${n}/${aw}`, fk = async (e, t, n, r, s) => {
	const u = `${n}:${r}:${s}:${vn(await y0(e, t.secretAccessKey, t.accessKeyId))}:${t.sessionToken}`;
	if (u in La) return La[u];
	for (gl.push(u); gl.length > ck;) delete La[gl.shift()];
	let c = `AWS4${t.secretAccessKey}`;
	for (const d of [
		n,
		r,
		s,
		aw
	]) c = await y0(e, c, d);
	return La[u] = c;
}, y0 = (e, t, n) => {
	const r = new e(t);
	return r.update(Ts(n)), r.digest();
}, D0 = ({ headers: e }, t, n) => {
	const r = {};
	for (const s of Object.keys(e).sort()) {
		if (e[s] == null) continue;
		const o = s.toLowerCase();
		(o in ik || t != null && t.has(o) || sk.test(o) || ok.test(o)) && (!n || n && !n.has(o)) || (r[o] = e[s].trim().replace(/\s+/g, " "));
	}
	return r;
}, uw = (e) => typeof ArrayBuffer == "function" && e instanceof ArrayBuffer || Object.prototype.toString.call(e) === "[object ArrayBuffer]", yl = async ({ headers: e, body: t }, n) => {
	for (const r of Object.keys(e)) if (r.toLowerCase() === Ff) return e[r];
	if (t == null) return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
	if (typeof t == "string" || ArrayBuffer.isView(t) || uw(t)) {
		const r = new n();
		return r.update(Ts(t)), vn(await r.digest());
	}
	return uk;
};
var dk = class {
	format(t) {
		const n = [];
		for (const o of Object.keys(t)) {
			const u = Yr(o);
			n.push(Uint8Array.from([u.byteLength]), u, this.formatHeaderValue(t[o]));
		}
		const r = new Uint8Array(n.reduce((o, u) => o + u.byteLength, 0));
		let s = 0;
		for (const o of n) r.set(o, s), s += o.byteLength;
		return r;
	}
	formatHeaderValue(t) {
		switch (t.type) {
			case "boolean": return Uint8Array.from([t.value ? 0 : 1]);
			case "byte": return Uint8Array.from([2, t.value]);
			case "short":
				const n = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(3));
				return n.setUint8(0, 3), n.setInt16(1, t.value, !1), new Uint8Array(n.buffer);
			case "integer":
				const r = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(5));
				return r.setUint8(0, 4), r.setInt32(1, t.value, !1), new Uint8Array(r.buffer);
			case "long":
				const s = new Uint8Array(9);
				return s[0] = 5, s.set(t.value.bytes, 1), s;
			case "binary":
				const o = new DataView(new ArrayBuffer(3 + t.value.byteLength));
				o.setUint8(0, 6), o.setUint16(1, t.value.byteLength, !1);
				const u = new Uint8Array(o.buffer);
				return u.set(t.value, 3), u;
			case "string":
				const c = Yr(t.value), d = new DataView(new ArrayBuffer(3 + c.byteLength));
				d.setUint8(0, 7), d.setUint16(1, c.byteLength, !1);
				const f = new Uint8Array(d.buffer);
				return f.set(c, 3), f;
			case "timestamp":
				const m = new Uint8Array(9);
				return m[0] = 8, m.set(pk.fromNumber(t.value.valueOf()).bytes, 1), m;
			case "uuid":
				if (!hk.test(t.value)) throw new Error(`Invalid UUID received: ${t.value}`);
				const y = new Uint8Array(17);
				return y[0] = 9, y.set(VD(t.value.replace(/\-/g, "")), 1), y;
		}
	}
};
var w0;
(function(e) {
	e[e.boolTrue = 0] = "boolTrue", e[e.boolFalse = 1] = "boolFalse", e[e.byte = 2] = "byte", e[e.short = 3] = "short", e[e.integer = 4] = "integer", e[e.long = 5] = "long", e[e.byteArray = 6] = "byteArray", e[e.string = 7] = "string", e[e.timestamp = 8] = "timestamp", e[e.uuid = 9] = "uuid";
})(w0 || (w0 = {}));
const hk = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
let pk = class cw {
	constructor(t) {
		P(this, "bytes");
		if (this.bytes = t, t.byteLength !== 8) throw new Error("Int64 buffers must be exactly 8 bytes");
	}
	static fromNumber(t) {
		if (t > 0x8000000000000000 || t < -0x8000000000000000) throw new Error(`${t} is too large (or, if negative, too small) to represent as an Int64`);
		const n = new Uint8Array(8);
		for (let r = 7, s = Math.abs(Math.round(t)); r > -1 && s > 0; r--, s /= 256) n[r] = s;
		return t < 0 && b0(n), new cw(n);
	}
	valueOf() {
		const t = this.bytes.slice(0), n = t[0] & 128;
		return n && b0(t), parseInt(vn(t), 16) * (n ? -1 : 1);
	}
	toString() {
		return String(this.valueOf());
	}
};
function b0(e) {
	for (let t = 0; t < 8; t++) e[t] ^= 255;
	for (let t = 7; t > -1 && (e[t]++, e[t] === 0); t--);
}
const gk = (e, t) => {
	e = e.toLowerCase();
	for (const n of Object.keys(t)) if (e === n.toLowerCase()) return !0;
	return !1;
}, mk = (e, t = {}) => {
	var s, o;
	const { headers: n, query: r = {} } = bt.clone(e);
	for (const u of Object.keys(n)) {
		const c = u.toLowerCase();
		(c.slice(0, 6) === "x-amz-" && !((s = t.unhoistableHeaders) != null && s.has(c)) || (o = t.hoistableHeaders) != null && o.has(c)) && (r[u] = n[u], delete n[u]);
	}
	return {
		...e,
		headers: n,
		query: r
	};
}, E0 = (e) => {
	e = bt.clone(e);
	for (const t of Object.keys(e.headers)) tk.indexOf(t.toLowerCase()) > -1 && delete e.headers[t];
	return e;
}, yk = ({ query: e = {} }) => {
	const t = [], n = {};
	for (const r of Object.keys(e)) {
		if (r.toLowerCase() === nk) continue;
		const s = $i(r);
		t.push(s);
		const o = e[r];
		typeof o == "string" ? n[s] = `${s}=${$i(o)}` : Array.isArray(o) && (n[s] = o.slice(0).reduce((u, c) => u.concat([`${s}=${$i(c)}`]), []).sort().join("&"));
	}
	return t.sort().map((r) => n[r]).filter((r) => r).join("&");
}, Dk = (e) => wk(e).toISOString().replace(/\.\d{3}Z$/, "Z"), wk = (e) => typeof e == "number" ? /* @__PURE__ */ new Date(e * 1e3) : typeof e == "string" ? Number(e) ? /* @__PURE__ */ new Date(Number(e) * 1e3) : new Date(e) : e;
var bk = class {
	constructor({ applyChecksum: t, credentials: n, region: r, service: s, sha256: o, uriEscapePath: u = !0 }) {
		P(this, "service");
		P(this, "regionProvider");
		P(this, "credentialProvider");
		P(this, "sha256");
		P(this, "uriEscapePath");
		P(this, "applyChecksum");
		this.service = s, this.sha256 = o, this.uriEscapePath = u, this.applyChecksum = typeof t == "boolean" ? t : !0, this.regionProvider = or(r), this.credentialProvider = or(n);
	}
	createCanonicalRequest(t, n, r) {
		const s = Object.keys(n).sort();
		return `${t.method}
${this.getCanonicalPath(t)}
${yk(t)}
${s.map((o) => `${o}:${n[o]}`).join(`
`)}

${s.join(";")}
${r}`;
	}
	async createStringToSign(t, n, r, s) {
		const o = new this.sha256();
		o.update(Ts(r));
		return `${s}
${t}
${n}
${vn(await o.digest())}`;
	}
	getCanonicalPath({ path: t }) {
		if (this.uriEscapePath) {
			const n = [];
			for (const o of t.split("/")) (o == null ? void 0 : o.length) !== 0 && o !== "." && (o === ".." ? n.pop() : n.push(o));
			return $i(`${t != null && t.startsWith("/") ? "/" : ""}${n.join("/")}${n.length > 0 && t != null && t.endsWith("/") ? "/" : ""}`).replace(/%2F/g, "/");
		}
		return t;
	}
	validateResolvedCredentials(t) {
		if (typeof t != "object" || typeof t.accessKeyId != "string" || typeof t.secretAccessKey != "string") throw new Error("Resolved credential object is not valid");
	}
	formatDate(t) {
		const n = Dk(t).replace(/[\-:]/g, "");
		return {
			longDate: n,
			shortDate: n.slice(0, 8)
		};
	}
	getCanonicalHeaderList(t) {
		return Object.keys(t).sort().join(";");
	}
};
var Af = class extends bk {
	constructor({ applyChecksum: n, credentials: r, region: s, service: o, sha256: u, uriEscapePath: c = !0 }) {
		super({
			applyChecksum: n,
			credentials: r,
			region: s,
			service: o,
			sha256: u,
			uriEscapePath: c
		});
		P(this, "headerFormatter", new dk());
	}
	async presign(n, r = {}) {
		const { signingDate: s = /* @__PURE__ */ new Date(), expiresIn: o = 3600, unsignableHeaders: u, unhoistableHeaders: c, signableHeaders: d, hoistableHeaders: f, signingRegion: m, signingService: y } = r, w = await this.credentialProvider();
		this.validateResolvedCredentials(w);
		const E = m ?? await this.regionProvider(), { longDate: A, shortDate: B } = this.formatDate(s);
		if (o > lk) return Promise.reject("Signature version 4 presigned URLs must have an expiration date less than one week in the future");
		const T = ml(B, E, y ?? this.service), $ = mk(E0(n), {
			unhoistableHeaders: c,
			hoistableHeaders: f
		});
		w.sessionToken && ($.query[iw] = w.sessionToken), $.query[JI] = pl, $.query[XI] = `${w.accessKeyId}/${T}`, $.query[nw] = A, $.query[QI] = o.toString(10);
		const V = D0($, u, d);
		return $.query[YI] = this.getCanonicalHeaderList(V), $.query[rw] = await this.getSignature(A, T, this.getSigningKey(w, E, B, y), this.createCanonicalRequest($, V, await yl(n, this.sha256))), $;
	}
	async sign(n, r) {
		return typeof n == "string" ? this.signString(n, r) : n.headers && n.payload ? this.signEvent(n, r) : n.message ? this.signMessage(n, r) : this.signRequest(n, r);
	}
	async signEvent({ headers: n, payload: r }, { signingDate: s = /* @__PURE__ */ new Date(), priorSignature: o, signingRegion: u, signingService: c }) {
		const d = u ?? await this.regionProvider(), { shortDate: f, longDate: m } = this.formatDate(s), y = ml(f, d, c ?? this.service), w = await yl({
			headers: {},
			body: r
		}, this.sha256), E = new this.sha256();
		E.update(n);
		const B = [
			ak,
			m,
			y,
			o,
			vn(await E.digest()),
			w
		].join(`
`);
		return this.signString(B, {
			signingDate: s,
			signingRegion: d,
			signingService: c
		});
	}
	async signMessage(n, { signingDate: r = /* @__PURE__ */ new Date(), signingRegion: s, signingService: o }) {
		return this.signEvent({
			headers: this.headerFormatter.format(n.message.headers),
			payload: n.message.body
		}, {
			signingDate: r,
			signingRegion: s,
			signingService: o,
			priorSignature: n.priorSignature
		}).then((c) => ({
			message: n.message,
			signature: c
		}));
	}
	async signString(n, { signingDate: r = /* @__PURE__ */ new Date(), signingRegion: s, signingService: o } = {}) {
		const u = await this.credentialProvider();
		this.validateResolvedCredentials(u);
		const c = s ?? await this.regionProvider(), { shortDate: d } = this.formatDate(r), f = new this.sha256(await this.getSigningKey(u, c, d, o));
		return f.update(Ts(n)), vn(await f.digest());
	}
	async signRequest(n, { signingDate: r = /* @__PURE__ */ new Date(), signableHeaders: s, unsignableHeaders: o, signingRegion: u, signingService: c } = {}) {
		const d = await this.credentialProvider();
		this.validateResolvedCredentials(d);
		const f = u ?? await this.regionProvider(), m = E0(n), { longDate: y, shortDate: w } = this.formatDate(r), E = ml(w, f, c ?? this.service);
		m.headers[ow] = y, d.sessionToken && (m.headers[rk] = d.sessionToken);
		const A = await yl(m, this.sha256);
		!gk(Ff, m.headers) && this.applyChecksum && (m.headers[Ff] = A);
		const B = D0(m, o, s), T = await this.getSignature(y, E, this.getSigningKey(d, f, w, c), this.createCanonicalRequest(m, B, A));
		return m.headers[sw] = `${pl} Credential=${d.accessKeyId}/${E}, SignedHeaders=${this.getCanonicalHeaderList(B)}, Signature=${T}`, m;
	}
	async getSignature(n, r, s, o) {
		const u = await this.createStringToSign(n, r, o, pl), c = new this.sha256(await s);
		return c.update(Ts(u)), vn(await c.digest());
	}
	getSigningKey(n, r, s, o) {
		return fk(this.sha256, n, s, r, o || this.service);
	}
};
const Ek = (e) => {
	let t = e.credentials, n = !!e.credentials, r;
	Object.defineProperty(e, "credentials", {
		set(f) {
			f && f !== t && f !== r && (n = !0), t = f;
			const y = Sk(e, vk(e, {
				credentials: t,
				credentialDefaultProvider: e.credentialDefaultProvider
			}));
			if (n && !y.attributed) {
				const w = typeof t == "object" && t !== null;
				r = async (E) => {
					const B = await y(E);
					return w && (!B.$source || Object.keys(B.$source).length === 0) ? HB(B, "CREDENTIALS_CODE", "e") : B;
				}, r.memoized = y.memoized, r.configBound = y.configBound, r.attributed = !0;
			} else r = y;
		},
		get() {
			return r;
		},
		enumerable: !0,
		configurable: !0
	}), e.credentials = t;
	const { signingEscapePath: s = !0, systemClockOffset: o = e.systemClockOffset || 0, sha256: u } = e;
	let c;
	return e.signer ? c = Fs(e.signer) : e.regionInfoProvider ? c = () => Fs(e.region)().then(async (f) => [await e.regionInfoProvider(f, {
		useFipsEndpoint: await e.useFipsEndpoint(),
		useDualstackEndpoint: await e.useDualstackEndpoint()
	}) || {}, f]).then(([f, m]) => {
		const { signingRegion: y, signingService: w } = f;
		e.signingRegion = e.signingRegion || y || m, e.signingName = e.signingName || w || e.serviceId;
		const E = {
			...e,
			credentials: e.credentials,
			region: e.signingRegion,
			service: e.signingName,
			sha256: u,
			uriEscapePath: s
		};
		return new (e.signerConstructor || Af)(E);
	}) : c = async (f) => {
		f = Object.assign({}, {
			name: "sigv4",
			signingName: e.signingName || e.defaultSigningName,
			signingRegion: await Fs(e.region)(),
			properties: {}
		}, f);
		const m = f.signingRegion, y = f.signingName;
		e.signingRegion = e.signingRegion || m, e.signingName = e.signingName || y || e.serviceId;
		const w = {
			...e,
			credentials: e.credentials,
			region: e.signingRegion,
			service: e.signingName,
			sha256: u,
			uriEscapePath: s
		};
		return new (e.signerConstructor || Af)(w);
	}, Object.assign(e, {
		systemClockOffset: o,
		signingEscapePath: s,
		signer: c
	});
};
function vk(e, { credentials: t, credentialDefaultProvider: n }) {
	let r;
	return t ? t != null && t.memoized ? r = t : r = KI(t, WI, tw) : n ? r = Fs(n(Object.assign({}, e, { parentClientConfig: e }))) : r = async () => {
		throw new Error("@aws-sdk/core::resolveAwsSdkSigV4Config - `credentials` not provided and no credentialDefaultProvider was configured.");
	}, r.memoized = !0, r;
}
function Sk(e, t) {
	if (t.configBound) return t;
	const n = async (r) => t({
		...r,
		callerClientConfig: e
	});
	return n.memoized = t.memoized, n.configBound = !0, n;
}
const v0 = typeof TextEncoder == "function" ? new TextEncoder() : null, Ck = (e) => {
	if (typeof e == "string") {
		if (v0) return v0.encode(e).byteLength;
		let t = e.length;
		for (let n = t - 1; n >= 0; n--) {
			const r = e.charCodeAt(n);
			r > 127 && r <= 2047 ? t++ : r > 2047 && r <= 65535 && (t += 2), r >= 56320 && r <= 57343 && n--;
		}
		return t;
	} else {
		if (typeof e.byteLength == "number") return e.byteLength;
		if (typeof e.size == "number") return e.size;
	}
	throw new Error(`Body Length computation failed for ${e}`);
}, Oi = (e, t) => {
	const n = [];
	if (e && n.push(e), t) for (const r of t) n.push(r);
	return n;
}, di = (e, t) => `${e || "anonymous"}${t && t.length > 0 ? ` (a.k.a. ${t.join(",")})` : ""}`, cu = () => {
	let e = [], t = [], n = !1;
	const r = /* @__PURE__ */ new Set(), s = (y) => y.sort((w, E) => S0[E.step] - S0[w.step] || C0[E.priority || "normal"] - C0[w.priority || "normal"]), o = (y) => {
		let w = !1;
		const E = (A) => {
			const B = Oi(A.name, A.aliases);
			if (B.includes(y)) {
				w = !0;
				for (const T of B) r.delete(T);
				return !1;
			}
			return !0;
		};
		return e = e.filter(E), t = t.filter(E), w;
	}, u = (y) => {
		let w = !1;
		const E = (A) => {
			if (A.middleware === y) {
				w = !0;
				for (const B of Oi(A.name, A.aliases)) r.delete(B);
				return !1;
			}
			return !0;
		};
		return e = e.filter(E), t = t.filter(E), w;
	}, c = (y) => {
		var w;
		return e.forEach((E) => {
			y.add(E.middleware, { ...E });
		}), t.forEach((E) => {
			y.addRelativeTo(E.middleware, { ...E });
		}), (w = y.identifyOnResolve) == null || w.call(y, m.identifyOnResolve()), y;
	}, d = (y) => {
		const w = [];
		return y.before.forEach((E) => {
			E.before.length === 0 && E.after.length === 0 ? w.push(E) : w.push(...d(E));
		}), w.push(y), y.after.reverse().forEach((E) => {
			E.before.length === 0 && E.after.length === 0 ? w.push(E) : w.push(...d(E));
		}), w;
	}, f = (y = !1) => {
		const w = [], E = [], A = {};
		return e.forEach((T) => {
			const $ = {
				...T,
				before: [],
				after: []
			};
			for (const V of Oi($.name, $.aliases)) A[V] = $;
			w.push($);
		}), t.forEach((T) => {
			const $ = {
				...T,
				before: [],
				after: []
			};
			for (const V of Oi($.name, $.aliases)) A[V] = $;
			E.push($);
		}), E.forEach((T) => {
			if (T.toMiddleware) {
				const $ = A[T.toMiddleware];
				if ($ === void 0) {
					if (y) return;
					throw new Error(`${T.toMiddleware} is not found when adding ${di(T.name, T.aliases)} middleware ${T.relation} ${T.toMiddleware}`);
				}
				T.relation === "after" && $.after.push(T), T.relation === "before" && $.before.push(T);
			}
		}), s(w).map(d).reduce((T, $) => (T.push(...$), T), []);
	}, m = {
		add: (y, w = {}) => {
			const { name: E, override: A, aliases: B } = w, T = {
				step: "initialize",
				priority: "normal",
				middleware: y,
				...w
			}, $ = Oi(E, B);
			if ($.length > 0) {
				if ($.some((V) => r.has(V))) {
					if (!A) throw new Error(`Duplicate middleware name '${di(E, B)}'`);
					for (const V of $) {
						const H = e.findIndex((te) => {
							var ge;
							return te.name === V || ((ge = te.aliases) == null ? void 0 : ge.some((De) => De === V));
						});
						if (H === -1) continue;
						const Q = e[H];
						if (Q.step !== T.step || T.priority !== Q.priority) throw new Error(`"${di(Q.name, Q.aliases)}" middleware with ${Q.priority} priority in ${Q.step} step cannot be overridden by "${di(E, B)}" middleware with ${T.priority} priority in ${T.step} step.`);
						e.splice(H, 1);
					}
				}
				for (const V of $) r.add(V);
			}
			e.push(T);
		},
		addRelativeTo: (y, w) => {
			const { name: E, override: A, aliases: B } = w, T = {
				middleware: y,
				...w
			}, $ = Oi(E, B);
			if ($.length > 0) {
				if ($.some((V) => r.has(V))) {
					if (!A) throw new Error(`Duplicate middleware name '${di(E, B)}'`);
					for (const V of $) {
						const H = t.findIndex((te) => {
							var ge;
							return te.name === V || ((ge = te.aliases) == null ? void 0 : ge.some((De) => De === V));
						});
						if (H === -1) continue;
						const Q = t[H];
						if (Q.toMiddleware !== T.toMiddleware || Q.relation !== T.relation) throw new Error(`"${di(Q.name, Q.aliases)}" middleware ${Q.relation} "${Q.toMiddleware}" middleware cannot be overridden by "${di(E, B)}" middleware ${T.relation} "${T.toMiddleware}" middleware.`);
						t.splice(H, 1);
					}
				}
				for (const V of $) r.add(V);
			}
			t.push(T);
		},
		clone: () => c(cu()),
		use: (y) => {
			y.applyToStack(m);
		},
		remove: (y) => typeof y == "string" ? o(y) : u(y),
		removeByTag: (y) => {
			let w = !1;
			const E = (A) => {
				const { tags: B, name: T, aliases: $ } = A;
				if (B && B.includes(y)) {
					const V = Oi(T, $);
					for (const H of V) r.delete(H);
					return w = !0, !1;
				}
				return !0;
			};
			return e = e.filter(E), t = t.filter(E), w;
		},
		concat: (y) => {
			var E;
			const w = c(cu());
			return w.use(y), w.identifyOnResolve(n || w.identifyOnResolve() || (((E = y.identifyOnResolve) == null ? void 0 : E.call(y)) ?? !1)), w;
		},
		applyToStack: c,
		identify: () => f(!0).map((y) => {
			const w = y.step ?? y.relation + " " + y.toMiddleware;
			return di(y.name, y.aliases) + " - " + w;
		}),
		identifyOnResolve(y) {
			return typeof y == "boolean" && (n = y), n;
		},
		resolve: (y, w) => {
			for (const E of f().map((A) => A.middleware).reverse()) y = E(y, w);
			return n && console.log(m.identify()), y;
		}
	};
	return m;
}, S0 = {
	initialize: 5,
	serialize: 4,
	build: 3,
	finalizeRequest: 2,
	deserialize: 1
}, C0 = {
	high: 3,
	normal: 2,
	low: 1
};
var xk = class {
	constructor(t) {
		P(this, "config");
		P(this, "middlewareStack", cu());
		P(this, "initConfig");
		P(this, "handlers");
		this.config = t;
		const { protocol: n, protocolSettings: r } = t;
		r && typeof n == "function" && (t.protocol = new n(r));
	}
	send(t, n, r) {
		const s = typeof n != "function" ? n : void 0, o = typeof n == "function" ? n : r, u = s === void 0 && this.config.cacheMiddleware === !0;
		let c;
		if (u) {
			this.handlers || (this.handlers = /* @__PURE__ */ new WeakMap());
			const d = this.handlers;
			d.has(t.constructor) ? c = d.get(t.constructor) : (c = t.resolveMiddleware(this.middlewareStack, this.config, s), d.set(t.constructor, c));
		} else delete this.handlers, c = t.resolveMiddleware(this.middlewareStack, this.config, s);
		if (o) c(t).then((d) => o(null, d.output), (d) => o(d)).catch(() => {});
		else return c(t).then((d) => d.output);
	}
	destroy() {
		var t, n, r;
		(r = (n = (t = this.config) == null ? void 0 : t.requestHandler) == null ? void 0 : n.destroy) == null || r.call(n), delete this.handlers;
	}
};
const Dl = "***SensitiveInformation***";
function _f(e, t) {
	if (t == null) return t;
	const n = Dt.of(e);
	if (n.getMergedTraits().sensitive) return Dl;
	if (n.isListSchema()) {
		if (!!n.getValueSchema().getMergedTraits().sensitive) return Dl;
	} else if (n.isMapSchema()) {
		if (!!n.getKeySchema().getMergedTraits().sensitive || !!n.getValueSchema().getMergedTraits().sensitive) return Dl;
	} else if (n.isStructSchema() && typeof t == "object") {
		const r = t, s = {};
		for (const [o, u] of n.structIterator()) r[o] != null && (s[o] = _f(u, r[o]));
		return s;
	}
	return t;
}
var Cd = class {
	constructor() {
		P(this, "middlewareStack", cu());
		P(this, "schema");
	}
	static classBuilder() {
		return new Fk();
	}
	resolveMiddlewareWithContext(t, n, r, { middlewareFn: s, clientName: o, commandName: u, inputFilterSensitiveLog: c, outputFilterSensitiveLog: d, smithyContext: f, additionalContext: m, CommandCtor: y }) {
		for (const T of s.bind(this)(y, t, n, r)) this.middlewareStack.use(T);
		const w = t.concat(this.middlewareStack), { logger: E } = n, A = {
			logger: E,
			clientName: o,
			commandName: u,
			inputFilterSensitiveLog: c,
			outputFilterSensitiveLog: d,
			[Ef]: {
				commandInstance: this,
				...f
			},
			...m
		}, { requestHandler: B } = n;
		return w.resolve((T) => B.handle(T.request, r || {}), A);
	}
};
var Fk = class {
	constructor() {
		P(this, "_init", () => {});
		P(this, "_ep", {});
		P(this, "_middlewareFn", () => []);
		P(this, "_commandName", "");
		P(this, "_clientName", "");
		P(this, "_additionalContext", {});
		P(this, "_smithyContext", {});
		P(this, "_inputFilterSensitiveLog");
		P(this, "_outputFilterSensitiveLog");
		P(this, "_serializer", null);
		P(this, "_deserializer", null);
		P(this, "_operationSchema");
	}
	init(t) {
		this._init = t;
	}
	ep(t) {
		return this._ep = t, this;
	}
	m(t) {
		return this._middlewareFn = t, this;
	}
	s(t, n, r = {}) {
		return this._smithyContext = {
			service: t,
			operation: n,
			...r
		}, this;
	}
	c(t = {}) {
		return this._additionalContext = t, this;
	}
	n(t, n) {
		return this._clientName = t, this._commandName = n, this;
	}
	f(t = (r) => r, n = (r) => r) {
		return this._inputFilterSensitiveLog = t, this._outputFilterSensitiveLog = n, this;
	}
	ser(t) {
		return this._serializer = t, this;
	}
	de(t) {
		return this._deserializer = t, this;
	}
	sc(t) {
		return this._operationSchema = t, this._smithyContext.operationSchema = t, this;
	}
	build() {
		const t = this;
		let n;
		return n = class extends Cd {
			constructor(...[s]) {
				super();
				P(this, "input");
				P(this, "serialize", t._serializer);
				P(this, "deserialize", t._deserializer);
				this.input = s ?? {}, t._init(this), this.schema = t._operationSchema;
			}
			static getEndpointParameterInstructions() {
				return t._ep;
			}
			resolveMiddleware(s, o, u) {
				const c = t._operationSchema, d = (c == null ? void 0 : c[4]) ?? (c == null ? void 0 : c.input), f = (c == null ? void 0 : c[5]) ?? (c == null ? void 0 : c.output);
				return this.resolveMiddlewareWithContext(s, o, u, {
					CommandCtor: n,
					middlewareFn: t._middlewareFn,
					clientName: t._clientName,
					commandName: t._commandName,
					inputFilterSensitiveLog: t._inputFilterSensitiveLog ?? (c ? _f.bind(null, d) : (m) => m),
					outputFilterSensitiveLog: t._outputFilterSensitiveLog ?? (c ? _f.bind(null, f) : (m) => m),
					smithyContext: t._smithyContext,
					additionalContext: t._additionalContext
				});
			}
		};
	}
};
var ws = class ws extends Error {
	constructor(n) {
		super(n.message);
		P(this, "$fault");
		P(this, "$response");
		P(this, "$retryable");
		P(this, "$metadata");
		Object.setPrototypeOf(this, Object.getPrototypeOf(this).constructor.prototype), this.name = n.name, this.$fault = n.$fault, this.$metadata = n.$metadata;
	}
	static isInstance(n) {
		if (!n) return !1;
		const r = n;
		return ws.prototype.isPrototypeOf(r) || !!r.$fault && !!r.$metadata && (r.$fault === "client" || r.$fault === "server");
	}
	static [Symbol.hasInstance](n) {
		if (!n) return !1;
		const r = n;
		return this === ws ? ws.isInstance(n) : ws.isInstance(n) ? r.name && this.name ? this.prototype.isPrototypeOf(n) || r.name === this.name : this.prototype.isPrototypeOf(n) : !1;
	}
};
const x0 = (e, t = {}) => {
	Object.entries(t).filter(([, r]) => r !== void 0).forEach(([r, s]) => {
		(e[r] == null || e[r] === "") && (e[r] = s);
	});
	return e.message = e.message || e.Message || "UnknownError", delete e.Message, e;
}, Ak = (e) => {
	switch (e) {
		case "standard": return {
			retryMode: "standard",
			connectionTimeout: 3100
		};
		case "in-region": return {
			retryMode: "standard",
			connectionTimeout: 1100
		};
		case "cross-region": return {
			retryMode: "standard",
			connectionTimeout: 3100
		};
		case "mobile": return {
			retryMode: "standard",
			connectionTimeout: 3e4
		};
		default: return {};
	}
}, _k = (e) => {
	const t = [];
	for (const n in uu) {
		const r = uu[n];
		e[r] !== void 0 && t.push({
			algorithmId: () => r,
			checksumConstructor: () => e[r]
		});
	}
	return {
		addChecksumAlgorithm(n) {
			t.push(n);
		},
		checksumAlgorithms() {
			return t;
		}
	};
}, Bk = (e) => {
	const t = {};
	return e.checksumAlgorithms().forEach((n) => {
		t[n.algorithmId()] = n.checksumConstructor();
	}), t;
}, Ik = (e) => ({
	setRetryStrategy(t) {
		e.retryStrategy = t;
	},
	retryStrategy() {
		return e.retryStrategy;
	}
}), kk = (e) => {
	const t = {};
	return t.retryStrategy = e.retryStrategy(), t;
}, Rk = (e) => Object.assign(_k(e), Ik(e)), Tk = (e) => Object.assign(Bk(e), kk(e)), lw = (e) => {
	const t = "#text";
	for (const n in e) e.hasOwnProperty(n) && e[n][t] !== void 0 ? e[n] = e[n][t] : typeof e[n] == "object" && e[n] !== null && (e[n] = lw(e[n]));
	return e;
};
var xd = class {
	trace() {}
	debug() {}
	info() {}
	warn() {}
	error() {}
};
var Pk = class {
	constructor(t = !1) {
		P(this, "queryCompat");
		this.queryCompat = t;
	}
	resolveRestContentType(t, n) {
		const r = n.getMemberSchemas(), s = Object.values(r).find((o) => !!o.getMergedTraits().httpPayload);
		if (s) return s.getMergedTraits().mediaType || (s.isStringSchema() ? "text/plain" : s.isBlobSchema() ? "application/octet-stream" : t);
		else if (!n.isUnitSchema() && Object.values(r).find((u) => {
			const { httpQuery: c, httpQueryParams: d, httpHeader: f, httpLabel: m, httpPrefixHeaders: y } = u.getMergedTraits();
			return !c && !d && !f && !m && y === void 0;
		})) return t;
	}
	async getErrorSchemaOrThrowBaseException(t, n, r, s, o, u) {
		let c = n, d = t;
		t.includes("#") && ([c, d] = t.split("#"));
		const f = {
			$metadata: o,
			$fault: r.statusCode < 500 ? "client" : "server"
		}, m = Et.for(c);
		try {
			return {
				errorSchema: (u == null ? void 0 : u(m, d)) ?? m.getSchema(t),
				errorMetadata: f
			};
		} catch {
			s.message = s.message ?? s.Message ?? "UnknownError";
			const w = Et.for("smithy.ts.sdk.synthetic." + c), E = w.getBaseException();
			if (E) {
				const A = w.getErrorCtor(E) ?? Error;
				throw this.decorateServiceException(Object.assign(new A({ name: d }), f), s);
			}
			throw this.decorateServiceException(Object.assign(new Error(d), f), s);
		}
	}
	decorateServiceException(t, n = {}) {
		if (this.queryCompat) {
			const r = t.Message ?? n.Message, s = x0(t, n);
			r && (s.message = r), s.Error = {
				...s.Error,
				Type: s.Error.Type,
				Code: s.Error.Code,
				Message: s.Error.message ?? s.Error.Message ?? r
			};
			const o = s.$metadata.requestId;
			return o && (s.RequestId = o), s;
		}
		return x0(t, n);
	}
	setQueryCompatError(t, n) {
		var s;
		const r = (s = n.headers) == null ? void 0 : s["x-amzn-query-error"];
		if (t !== void 0 && r != null) {
			const [o, u] = r.split(";"), c = Object.entries(t), d = {
				Code: o,
				Type: u
			};
			Object.assign(t, d);
			for (const [f, m] of c) d[f === "message" ? "Message" : f] = m;
			delete d.__type, t.Error = d;
		}
	}
	queryCompatOutput(t, n) {
		t.Error && (n.Error = t.Error), t.Type && (n.Type = t.Type), t.Code && (n.Code = t.Code);
	}
	findQueryCompatibleError(t, n) {
		try {
			return t.getSchema(n);
		} catch {
			return t.find((s) => {
				var o;
				return ((o = Dt.of(s).getMergedTraits().awsQueryError) == null ? void 0 : o[0]) === n;
			});
		}
	}
};
var Fd = class {
	constructor() {
		P(this, "serdeContext");
	}
	setSerdeContext(t) {
		this.serdeContext = t;
	}
};
var Nk = class {
	constructor(t, n) {
		P(this, "from");
		P(this, "to");
		P(this, "keys");
		this.from = t, this.to = n, this.keys = new Set(Object.keys(this.from).filter((r) => r !== "__type"));
	}
	mark(t) {
		this.keys.delete(t);
	}
	hasUnknown() {
		return this.keys.size === 1 && Object.keys(this.to).length === 0;
	}
	writeUnknown() {
		if (this.hasUnknown()) {
			const t = this.keys.values().next().value, n = this.from[t];
			this.to.$unknown = [t, n];
		}
	}
};
function Ok(e) {
	return e.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function Uk(e) {
	return e.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#x0D;").replace(/\n/g, "&#x0A;").replace(/\u0085/g, "&#x85;").replace(/\u2028/, "&#x2028;");
}
var Bf = class {
	constructor(t) {
		P(this, "value");
		this.value = t;
	}
	toString() {
		return Uk("" + this.value);
	}
};
var ln = class ln {
	constructor(t, n = []) {
		P(this, "name");
		P(this, "children");
		P(this, "attributes", {});
		this.name = t, this.children = n;
	}
	static of(t, n, r) {
		const s = new ln(t);
		return n !== void 0 && s.addChildNode(new Bf(n)), r !== void 0 && s.withName(r), s;
	}
	withName(t) {
		return this.name = t, this;
	}
	addAttribute(t, n) {
		return this.attributes[t] = n, this;
	}
	addChildNode(t) {
		return this.children.push(t), this;
	}
	removeAttribute(t) {
		return delete this.attributes[t], this;
	}
	n(t) {
		return this.name = t, this;
	}
	c(t) {
		return this.children.push(t), this;
	}
	a(t, n) {
		return n != null && (this.attributes[t] = n), this;
	}
	cc(t, n, r = n) {
		if (t[n] != null) {
			const s = ln.of(n, t[n]).withName(r);
			this.c(s);
		}
	}
	l(t, n, r, s) {
		t[n] != null && s().map((u) => {
			u.withName(r), this.c(u);
		});
	}
	lc(t, n, r, s) {
		if (t[n] != null) {
			const o = s(), u = new ln(r);
			o.map((c) => {
				u.c(c);
			}), this.c(u);
		}
	}
	toString() {
		const t = !!this.children.length;
		let n = `<${this.name}`;
		const r = this.attributes;
		for (const s of Object.keys(r)) {
			const o = r[s];
			o != null && (n += ` ${s}="${Ok("" + o)}"`);
		}
		return n += t ? `>${this.children.map((s) => s.toString()).join("")}</${this.name}>` : "/>";
	}
};
let wl;
function Mk(e) {
	wl || (wl = new DOMParser());
	const t = wl.parseFromString(e, "application/xml");
	if (t.getElementsByTagName("parsererror").length > 0) throw new Error("DOMParser XML parsing error.");
	const n = (r) => {
		var s;
		if (r.nodeType === Node.TEXT_NODE && (s = r.textContent) != null && s.trim()) return r.textContent;
		if (r.nodeType === Node.ELEMENT_NODE) {
			const o = r;
			if (o.attributes.length === 0 && o.childNodes.length === 0) return "";
			const u = {}, c = Array.from(o.attributes);
			for (const f of c) u[`${f.name}`] = f.value;
			const d = Array.from(o.childNodes);
			for (const f of d) {
				const m = n(f);
				if (m != null) {
					const y = f.nodeName;
					if (d.length === 1 && c.length === 0 && y === "#text") return m;
					u[y] ? Array.isArray(u[y]) ? u[y].push(m) : u[y] = [u[y], m] : u[y] = m;
				} else if (d.length === 1 && c.length === 0) return o.textContent;
			}
			return u;
		}
		return null;
	};
	return { [t.documentElement.nodeName]: n(t.documentElement) };
}
var $k = class extends Fd {
	constructor(n) {
		super();
		P(this, "settings");
		P(this, "stringDeserializer");
		this.settings = n, this.stringDeserializer = new ew(n);
	}
	setSerdeContext(n) {
		this.serdeContext = n, this.stringDeserializer.setSerdeContext(n);
	}
	read(n, r, s) {
		var m;
		const o = Dt.of(n), u = o.getMemberSchemas();
		if (o.isStructSchema() && o.isMemberSchema() && !!Object.values(u).find((y) => !!y.getMemberTraits().eventPayload)) {
			const y = {}, w = Object.keys(u)[0];
			return u[w].isBlobSchema() ? y[w] = r : y[w] = this.read(u[w], r), y;
		}
		const d = (((m = this.serdeContext) == null ? void 0 : m.utf8Encoder) ?? Ki)(r), f = this.parseXml(d);
		return this.readSchema(n, s ? f[s] : f);
	}
	readSchema(n, r) {
		const s = Dt.of(n);
		if (s.isUnitSchema()) return;
		const o = s.getMergedTraits();
		if (s.isListSchema() && !Array.isArray(r)) return this.readSchema(s, [r]);
		if (r == null) return r;
		if (typeof r == "object") {
			const u = !!o.sparse, c = !!o.xmlFlattened;
			if (s.isListSchema()) {
				const f = s.getValueSchema(), m = [], y = f.getMergedTraits().xmlName ?? "member", w = c ? r : (r[0] ?? r)[y], E = Array.isArray(w) ? w : [w];
				for (const A of E) (A != null || u) && m.push(this.readSchema(f, A));
				return m;
			}
			const d = {};
			if (s.isMapSchema()) {
				const f = s.getKeySchema(), m = s.getValueSchema();
				let y;
				c ? y = Array.isArray(r) ? r : [r] : y = Array.isArray(r.entry) ? r.entry : [r.entry];
				const w = f.getMergedTraits().xmlName ?? "key", E = m.getMergedTraits().xmlName ?? "value";
				for (const A of y) {
					const B = A[w], T = A[E];
					(T != null || u) && (d[B] = this.readSchema(m, T));
				}
				return d;
			}
			if (s.isStructSchema()) {
				const f = s.isUnionSchema();
				let m;
				f && (m = new Nk(r, d));
				for (const [y, w] of s.structIterator()) {
					const E = w.getMergedTraits(), A = E.httpPayload ? E.xmlName ?? w.getName() : w.getMemberTraits().xmlName ?? y;
					f && m.mark(A), r[A] != null && (d[y] = this.readSchema(w, r[A]));
				}
				return f && m.writeUnknown(), d;
			}
			if (s.isDocumentSchema()) return r;
			throw new Error(`@aws-sdk/core/protocols - xml deserializer unhandled schema type for ${s.getName(!0)}`);
		}
		return s.isListSchema() ? [] : s.isMapSchema() || s.isStructSchema() ? {} : this.stringDeserializer.read(s, r);
	}
	parseXml(n) {
		if (n.length) {
			let r;
			try {
				r = Mk(n);
			} catch (c) {
				throw c && typeof c == "object" && Object.defineProperty(c, "$responseBodyText", { value: n }), c;
			}
			const s = "#text", o = Object.keys(r)[0], u = r[o];
			return u[s] && (u[o] = u[s], delete u[s]), lw(u);
		}
		return {};
	}
};
const Lk = (e, t) => {
	var n;
	if (((n = t == null ? void 0 : t.Error) == null ? void 0 : n.Code) !== void 0) return t.Error.Code;
	if ((t == null ? void 0 : t.Code) !== void 0) return t.Code;
	if (e.statusCode == 404) return "NotFound";
};
var zk = class extends Fd {
	constructor(n) {
		super();
		P(this, "settings");
		P(this, "stringBuffer");
		P(this, "byteBuffer");
		P(this, "buffer");
		this.settings = n;
	}
	write(n, r) {
		var o;
		const s = Dt.of(n);
		if (s.isStringSchema() && typeof r == "string") this.stringBuffer = r;
		else if (s.isBlobSchema()) this.byteBuffer = "byteLength" in r ? r : (((o = this.serdeContext) == null ? void 0 : o.base64Decoder) ?? Rs)(r);
		else {
			this.buffer = this.writeStruct(s, r, void 0);
			const u = s.getMergedTraits();
			u.httpPayload && !u.xmlName && this.buffer.withName(s.getName());
		}
	}
	flush() {
		var r;
		if (this.byteBuffer !== void 0) {
			const s = this.byteBuffer;
			return delete this.byteBuffer, s;
		}
		if (this.stringBuffer !== void 0) {
			const s = this.stringBuffer;
			return delete this.stringBuffer, s;
		}
		const n = this.buffer;
		return this.settings.xmlNamespace && ((r = n == null ? void 0 : n.attributes) != null && r.xmlns || n.addAttribute("xmlns", this.settings.xmlNamespace)), delete this.buffer, n.toString();
	}
	writeStruct(n, r, s) {
		const o = n.getMergedTraits(), u = n.isMemberSchema() && !o.httpPayload ? n.getMemberTraits().xmlName ?? n.getMemberName() : o.xmlName ?? n.getName();
		if (!u || !n.isStructSchema()) throw new Error(`@aws-sdk/core/protocols - xml serializer, cannot write struct with empty name or non-struct, schema=${n.getName(!0)}.`);
		const c = ln.of(u), [d, f] = this.getXmlnsAttribute(n, s);
		for (const [y, w] of n.structIterator()) {
			const E = r[y];
			if (E != null || w.isIdempotencyToken()) {
				if (w.getMergedTraits().xmlAttribute) {
					c.addAttribute(w.getMergedTraits().xmlName ?? y, this.writeSimple(w, E));
					continue;
				}
				if (w.isListSchema()) this.writeList(w, E, c, f);
				else if (w.isMapSchema()) this.writeMap(w, E, c, f);
				else if (w.isStructSchema()) c.addChildNode(this.writeStruct(w, E, f));
				else {
					const A = ln.of(w.getMergedTraits().xmlName ?? w.getMemberName());
					this.writeSimpleInto(w, E, A, f), c.addChildNode(A);
				}
			}
		}
		const { $unknown: m } = r;
		if (m && n.isUnionSchema() && Array.isArray(m) && Object.keys(r).length === 1) {
			const [y, w] = m, E = ln.of(y);
			if (typeof w != "string") if (r instanceof ln || r instanceof Bf) c.addChildNode(r);
			else throw new Error("@aws-sdk - $unknown union member in XML requires value of type string, @aws-sdk/xml-builder::XmlNode or XmlText.");
			this.writeSimpleInto(0, w, E, f), c.addChildNode(E);
		}
		return f && c.addAttribute(d, f), c;
	}
	writeList(n, r, s, o) {
		if (!n.isMemberSchema()) throw new Error(`@aws-sdk/core/protocols - xml serializer, cannot write non-member list: ${n.getName(!0)}`);
		const u = n.getMergedTraits(), c = n.getValueSchema(), d = c.getMergedTraits(), f = !!d.sparse, m = !!u.xmlFlattened, [y, w] = this.getXmlnsAttribute(n, o), E = (A, B) => {
			if (c.isListSchema()) this.writeList(c, Array.isArray(B) ? B : [B], A, w);
			else if (c.isMapSchema()) this.writeMap(c, B, A, w);
			else if (c.isStructSchema()) {
				const T = this.writeStruct(c, B, w);
				A.addChildNode(T.withName(m ? u.xmlName ?? n.getMemberName() : d.xmlName ?? "member"));
			} else {
				const T = ln.of(m ? u.xmlName ?? n.getMemberName() : d.xmlName ?? "member");
				this.writeSimpleInto(c, B, T, w), A.addChildNode(T);
			}
		};
		if (m) for (const A of r) (f || A != null) && E(s, A);
		else {
			const A = ln.of(u.xmlName ?? n.getMemberName());
			w && A.addAttribute(y, w);
			for (const B of r) (f || B != null) && E(A, B);
			s.addChildNode(A);
		}
	}
	writeMap(n, r, s, o, u = !1) {
		if (!n.isMemberSchema()) throw new Error(`@aws-sdk/core/protocols - xml serializer, cannot write non-member map: ${n.getName(!0)}`);
		const c = n.getMergedTraits(), d = n.getKeySchema(), m = d.getMergedTraits().xmlName ?? "key", y = n.getValueSchema(), w = y.getMergedTraits(), E = w.xmlName ?? "value", A = !!w.sparse, B = !!c.xmlFlattened, [T, $] = this.getXmlnsAttribute(n, o), V = (H, Q, te) => {
			const ge = ln.of(m, Q), [De, rt] = this.getXmlnsAttribute(d, $);
			rt && ge.addAttribute(De, rt), H.addChildNode(ge);
			let Je = ln.of(E);
			y.isListSchema() ? this.writeList(y, te, Je, $) : y.isMapSchema() ? this.writeMap(y, te, Je, $, !0) : y.isStructSchema() ? Je = this.writeStruct(y, te, $) : this.writeSimpleInto(y, te, Je, $), H.addChildNode(Je);
		};
		if (B) {
			for (const [H, Q] of Object.entries(r)) if (A || Q != null) {
				const te = ln.of(c.xmlName ?? n.getMemberName());
				V(te, H, Q), s.addChildNode(te);
			}
		} else {
			let H;
			u || (H = ln.of(c.xmlName ?? n.getMemberName()), $ && H.addAttribute(T, $), s.addChildNode(H));
			for (const [Q, te] of Object.entries(r)) if (A || te != null) {
				const ge = ln.of("entry");
				V(ge, Q, te), (u ? s : H).addChildNode(ge);
			}
		}
	}
	writeSimple(n, r) {
		var u;
		if (r === null) throw new Error("@aws-sdk/core/protocols - (XML serializer) cannot write null value.");
		const s = Dt.of(n);
		let o = null;
		if (r && typeof r == "object") if (s.isBlobSchema()) o = (((u = this.serdeContext) == null ? void 0 : u.base64Encoder) ?? ji)(r);
		else if (s.isTimestampSchema() && r instanceof Date) switch (Sd(s, this.settings)) {
			case 5:
				o = r.toISOString().replace(".000Z", "Z");
				break;
			case 6:
				o = xf(r);
				break;
			case 7:
				o = String(r.getTime() / 1e3);
				break;
			default:
				console.warn("Missing timestamp format, using http date", r), o = xf(r);
				break;
		}
		else {
			if (s.isBigDecimalSchema() && r) return r instanceof _u ? r.string : String(r);
			throw s.isMapSchema() || s.isListSchema() ? /* @__PURE__ */ new Error("@aws-sdk/core/protocols - xml serializer, cannot call _write() on List/Map schema, call writeList or writeMap() instead.") : /* @__PURE__ */ new Error(`@aws-sdk/core/protocols - xml serializer, unhandled schema type for object value and schema: ${s.getName(!0)}`);
		}
		if ((s.isBooleanSchema() || s.isNumericSchema() || s.isBigIntegerSchema() || s.isBigDecimalSchema()) && (o = String(r)), s.isStringSchema() && (r === void 0 && s.isIdempotencyToken() ? o = wd() : o = String(r)), o === null) throw new Error(`Unhandled schema-value pair ${s.getName(!0)}=${r}`);
		return o;
	}
	writeSimpleInto(n, r, s, o) {
		const u = this.writeSimple(n, r), c = Dt.of(n), d = new Bf(u), [f, m] = this.getXmlnsAttribute(c, o);
		m && s.addAttribute(f, m), s.addChildNode(d);
	}
	getXmlnsAttribute(n, r) {
		const [o, u] = n.getMergedTraits().xmlNamespace ?? [];
		return u && u !== r ? [o ? `xmlns:${o}` : "xmlns", u] : [void 0, void 0];
	}
};
var Hk = class extends Fd {
	constructor(n) {
		super();
		P(this, "settings");
		this.settings = n;
	}
	createSerializer() {
		const n = new zk(this.settings);
		return n.setSerdeContext(this.serdeContext), n;
	}
	createDeserializer() {
		const n = new $k(this.settings);
		return n.setSerdeContext(this.serdeContext), n;
	}
};
var qk = class extends MI {
	constructor(n) {
		super(n);
		P(this, "codec");
		P(this, "serializer");
		P(this, "deserializer");
		P(this, "mixin", new Pk());
		const r = {
			timestampFormat: {
				useTrait: !0,
				default: 5
			},
			httpBindings: !0,
			xmlNamespace: n.xmlNamespace,
			serviceNamespace: n.defaultNamespace
		};
		this.codec = new Hk(r), this.serializer = new zI(this.codec.createSerializer(), r), this.deserializer = new $I(this.codec.createDeserializer(), r);
	}
	getPayloadCodec() {
		return this.codec;
	}
	getShapeId() {
		return "aws.protocols#restXml";
	}
	async serializeRequest(n, r, s) {
		const o = await super.serializeRequest(n, r, s), u = Dt.of(n.input);
		if (!o.headers["content-type"]) {
			const c = this.mixin.resolveRestContentType(this.getDefaultContentType(), u);
			c && (o.headers["content-type"] = c);
		}
		return typeof o.body == "string" && o.headers["content-type"] === this.getDefaultContentType() && !o.body.startsWith("<?xml ") && !this.hasUnstructuredPayloadBinding(u) && (o.body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" + o.body), o;
	}
	async deserializeResponse(n, r, s) {
		return super.deserializeResponse(n, r, s);
	}
	async handleError(n, r, s, o, u) {
		var B, T, $;
		const c = Lk(s, o) ?? "Unknown", { errorSchema: d, errorMetadata: f } = await this.mixin.getErrorSchemaOrThrowBaseException(c, this.options.defaultNamespace, s, o, u), m = Dt.of(d), y = ((B = o.Error) == null ? void 0 : B.message) ?? ((T = o.Error) == null ? void 0 : T.Message) ?? o.message ?? o.Message ?? "Unknown", E = new ((Et.for(d[1]).getErrorCtor(d)) ?? Error)(y);
		await this.deserializeHttpMessage(d, r, s, o);
		const A = {};
		for (const [V, H] of m.structIterator()) {
			const Q = H.getMergedTraits().xmlName ?? V, te = (($ = o.Error) == null ? void 0 : $[Q]) ?? o[Q];
			A[V] = this.codec.createDeserializer().readSchema(H, te);
		}
		throw this.mixin.decorateServiceException(Object.assign(E, f, {
			$fault: m.getMergedTraits().error,
			message: y
		}, A), o);
	}
	getDefaultContentType() {
		return "application/xml";
	}
	hasUnstructuredPayloadBinding(n) {
		for (const [, r] of n.structIterator()) if (r.getMergedTraits().httpPayload) return !(r.isStructSchema() || r.isMapSchema() || r.isListSchema());
		return !1;
	}
};
const If = [
	Qe.CRC32,
	Qe.CRC32C,
	Qe.CRC64NVME,
	Qe.SHA1,
	Qe.SHA256
], jk = [
	Qe.SHA256,
	Qe.SHA1,
	Qe.CRC32,
	Qe.CRC32C,
	Qe.CRC64NVME
], Gk = (e, { requestChecksumRequired: t, requestAlgorithmMember: n, requestChecksumCalculation: r }) => {
	if (!n) return r === ks.WHEN_SUPPORTED || t ? vf : void 0;
	if (!e[n]) return;
	const s = e[n];
	if (!If.includes(s)) throw new Error(`The checksum algorithm "${s}" is not supported by the client. Select one of ${If}.`);
	return s;
}, Ad = (e) => e === Qe.MD5 ? "content-md5" : `x-amz-checksum-${e.toLowerCase()}`, Wk = (e, t) => {
	const n = e.toLowerCase();
	for (const r of Object.keys(t)) if (n === r.toLowerCase()) return !0;
	return !1;
}, Kk = (e, t) => {
	const n = e.toLowerCase();
	for (const r of Object.keys(t)) if (r.toLowerCase().startsWith(n)) return !0;
	return !1;
}, fw = (e) => e !== void 0 && typeof e != "string" && !ArrayBuffer.isView(e) && !uw(e);
function _d(e, t, n, r) {
	function s(o) {
		return o instanceof n ? o : new n(function(u) {
			u(o);
		});
	}
	return new (n || (n = Promise))(function(o, u) {
		function c(m) {
			try {
				f(r.next(m));
			} catch (y) {
				u(y);
			}
		}
		function d(m) {
			try {
				f(r.throw(m));
			} catch (y) {
				u(y);
			}
		}
		function f(m) {
			m.done ? o(m.value) : s(m.value).then(c, d);
		}
		f((r = r.apply(e, t || [])).next());
	});
}
function Bd(e, t) {
	var n = {
		label: 0,
		sent: function() {
			if (o[0] & 1) throw o[1];
			return o[1];
		},
		trys: [],
		ops: []
	}, r, s, o, u = Object.create((typeof Iterator == "function" ? Iterator : Object).prototype);
	return u.next = c(0), u.throw = c(1), u.return = c(2), typeof Symbol == "function" && (u[Symbol.iterator] = function() {
		return this;
	}), u;
	function c(f) {
		return function(m) {
			return d([f, m]);
		};
	}
	function d(f) {
		if (r) throw new TypeError("Generator is already executing.");
		for (; u && (u = 0, f[0] && (n = 0)), n;) try {
			if (r = 1, s && (o = f[0] & 2 ? s.return : f[0] ? s.throw || ((o = s.return) && o.call(s), 0) : s.next) && !(o = o.call(s, f[1])).done) return o;
			switch (s = 0, o && (f = [f[0] & 2, o.value]), f[0]) {
				case 0:
				case 1:
					o = f;
					break;
				case 4: return n.label++, {
					value: f[1],
					done: !1
				};
				case 5:
					n.label++, s = f[1], f = [0];
					continue;
				case 7:
					f = n.ops.pop(), n.trys.pop();
					continue;
				default:
					if (o = n.trys, !(o = o.length > 0 && o[o.length - 1]) && (f[0] === 6 || f[0] === 2)) {
						n = 0;
						continue;
					}
					if (f[0] === 3 && (!o || f[1] > o[0] && f[1] < o[3])) {
						n.label = f[1];
						break;
					}
					if (f[0] === 6 && n.label < o[1]) {
						n.label = o[1], o = f;
						break;
					}
					if (o && n.label < o[2]) {
						n.label = o[2], n.ops.push(f);
						break;
					}
					o[2] && n.ops.pop(), n.trys.pop();
					continue;
			}
			f = t.call(e, n);
		} catch (m) {
			f = [6, m], s = 0;
		} finally {
			r = o = 0;
		}
		if (f[0] & 5) throw f[1];
		return {
			value: f[0] ? f[1] : void 0,
			done: !0
		};
	}
}
function dw(e) {
	var t = typeof Symbol == "function" && Symbol.iterator, n = t && e[t], r = 0;
	if (n) return n.call(e);
	if (e && typeof e.length == "number") return { next: function() {
		return e && r >= e.length && (e = void 0), {
			value: e && e[r++],
			done: !e
		};
	} };
	throw new TypeError(t ? "Object is not iterable." : "Symbol.iterator is not defined.");
}
const Vk = (e) => new TextEncoder().encode(e);
var Zk = typeof Buffer < "u" && Buffer.from ? function(e) {
	return Buffer.from(e, "utf8");
} : Vk;
function Ei(e) {
	return e instanceof Uint8Array ? e : typeof e == "string" ? Zk(e) : ArrayBuffer.isView(e) ? new Uint8Array(e.buffer, e.byteOffset, e.byteLength / Uint8Array.BYTES_PER_ELEMENT) : new Uint8Array(e);
}
function To(e) {
	return typeof e == "string" ? e.length === 0 : e.byteLength === 0;
}
function hw(e) {
	return new Uint8Array([
		(e & 4278190080) >> 24,
		(e & 16711680) >> 16,
		(e & 65280) >> 8,
		e & 255
	]);
}
function pw(e) {
	if (!Uint32Array.from) {
		for (var t = new Uint32Array(e.length), n = 0; n < e.length;) t[n] = e[n], n += 1;
		return t;
	}
	return Uint32Array.from(e);
}
var Jk = function() {
	function e() {
		this.crc32c = new F0();
	}
	return e.prototype.update = function(t) {
		To(t) || this.crc32c.update(Ei(t));
	}, e.prototype.digest = function() {
		return _d(this, void 0, void 0, function() {
			return Bd(this, function(t) {
				return [2, hw(this.crc32c.digest())];
			});
		});
	}, e.prototype.reset = function() {
		this.crc32c = new F0();
	}, e;
}(), F0 = function() {
	function e() {
		this.checksum = 4294967295;
	}
	return e.prototype.update = function(t) {
		var n, r;
		try {
			for (var s = dw(t), o = s.next(); !o.done; o = s.next()) {
				var u = o.value;
				this.checksum = this.checksum >>> 8 ^ Yk[(this.checksum ^ u) & 255];
			}
		} catch (c) {
			n = { error: c };
		} finally {
			try {
				o && !o.done && (r = s.return) && r.call(s);
			} finally {
				if (n) throw n.error;
			}
		}
		return this;
	}, e.prototype.digest = function() {
		return (this.checksum ^ 4294967295) >>> 0;
	}, e;
}(), Yk = pw([
	0,
	4067132163,
	3778769143,
	324072436,
	3348797215,
	904991772,
	648144872,
	3570033899,
	2329499855,
	2024987596,
	1809983544,
	2575936315,
	1296289744,
	3207089363,
	2893594407,
	1578318884,
	274646895,
	3795141740,
	4049975192,
	51262619,
	3619967088,
	632279923,
	922689671,
	3298075524,
	2592579488,
	1760304291,
	2075979607,
	2312596564,
	1562183871,
	2943781820,
	3156637768,
	1313733451,
	549293790,
	3537243613,
	3246849577,
	871202090,
	3878099393,
	357341890,
	102525238,
	4101499445,
	2858735121,
	1477399826,
	1264559846,
	3107202533,
	1845379342,
	2677391885,
	2361733625,
	2125378298,
	820201905,
	3263744690,
	3520608582,
	598981189,
	4151959214,
	85089709,
	373468761,
	3827903834,
	3124367742,
	1213305469,
	1526817161,
	2842354314,
	2107672161,
	2412447074,
	2627466902,
	1861252501,
	1098587580,
	3004210879,
	2688576843,
	1378610760,
	2262928035,
	1955203488,
	1742404180,
	2511436119,
	3416409459,
	969524848,
	714683780,
	3639785095,
	205050476,
	4266873199,
	3976438427,
	526918040,
	1361435347,
	2739821008,
	2954799652,
	1114974503,
	2529119692,
	1691668175,
	2005155131,
	2247081528,
	3690758684,
	697762079,
	986182379,
	3366744552,
	476452099,
	3993867776,
	4250756596,
	255256311,
	1640403810,
	2477592673,
	2164122517,
	1922457750,
	2791048317,
	1412925310,
	1197962378,
	3037525897,
	3944729517,
	427051182,
	170179418,
	4165941337,
	746937522,
	3740196785,
	3451792453,
	1070968646,
	1905808397,
	2213795598,
	2426610938,
	1657317369,
	3053634322,
	1147748369,
	1463399397,
	2773627110,
	4215344322,
	153784257,
	444234805,
	3893493558,
	1021025245,
	3467647198,
	3722505002,
	797665321,
	2197175160,
	1889384571,
	1674398607,
	2443626636,
	1164749927,
	3070701412,
	2757221520,
	1446797203,
	137323447,
	4198817972,
	3910406976,
	461344835,
	3484808360,
	1037989803,
	781091935,
	3705997148,
	2460548119,
	1623424788,
	1939049696,
	2180517859,
	1429367560,
	2807687179,
	3020495871,
	1180866812,
	410100952,
	3927582683,
	4182430767,
	186734380,
	3756733383,
	763408580,
	1053836080,
	3434856499,
	2722870694,
	1344288421,
	1131464017,
	2971354706,
	1708204729,
	2545590714,
	2229949006,
	1988219213,
	680717673,
	3673779818,
	3383336350,
	1002577565,
	4010310262,
	493091189,
	238226049,
	4233660802,
	2987750089,
	1082061258,
	1395524158,
	2705686845,
	1972364758,
	2279892693,
	2494862625,
	1725896226,
	952904198,
	3399985413,
	3656866545,
	731699698,
	4283874585,
	222117402,
	510512622,
	3959836397,
	3280807620,
	837199303,
	582374963,
	3504198960,
	68661723,
	4135334616,
	3844915500,
	390545967,
	1230274059,
	3141532936,
	2825850620,
	1510247935,
	2395924756,
	2091215383,
	1878366691,
	2644384480,
	3553878443,
	565732008,
	854102364,
	3229815391,
	340358836,
	3861050807,
	4117890627,
	119113024,
	1493875044,
	2875275879,
	3090270611,
	1247431312,
	2660249211,
	1828433272,
	2141937292,
	2378227087,
	3811616794,
	291187481,
	34330861,
	4032846830,
	615137029,
	3603020806,
	3314634738,
	939183345,
	1776939221,
	2609017814,
	2295496738,
	2058945313,
	2926798794,
	1545135305,
	1330124605,
	3173225534,
	4084100981,
	17165430,
	307568514,
	3762199681,
	888469610,
	3332340585,
	3587147933,
	665062302,
	2042050490,
	2346497209,
	2559330125,
	1793573966,
	3190661285,
	1279665062,
	1595330642,
	2910671697
]);
const Qk = () => {
	const t = new Array(8);
	for (let n = 0; n < 8; n++) {
		const r = new Array(512);
		for (let s = 0; s < 256; s++) {
			let o = BigInt(s);
			for (let u = 0; u < 8 * (n + 1); u++) o & 1n ? o = o >> 1n ^ 11127430586519243189n : o = o >> 1n;
			r[s * 2] = Number(o >> 32n & 4294967295n), r[s * 2 + 1] = Number(o & 4294967295n);
		}
		t[n] = new Uint32Array(r);
	}
	return t;
};
let bl, po, kf, Rf, Tf, Pf, Nf, Of, Uf;
const eR = () => {
	bl || (bl = Qk(), [po, kf, Rf, Tf, Pf, Nf, Of, Uf] = bl);
};
var tR = class {
	constructor() {
		P(this, "c1", 0);
		P(this, "c2", 0);
		eR(), this.reset();
	}
	update(t) {
		const n = t.length;
		let r = 0, s = this.c1, o = this.c2;
		for (; r + 8 <= n;) {
			const u = ((o ^ t[r++]) & 255) << 1, c = ((o >>> 8 ^ t[r++]) & 255) << 1, d = ((o >>> 16 ^ t[r++]) & 255) << 1, f = ((o >>> 24 ^ t[r++]) & 255) << 1, m = ((s ^ t[r++]) & 255) << 1, y = ((s >>> 8 ^ t[r++]) & 255) << 1, w = ((s >>> 16 ^ t[r++]) & 255) << 1, E = ((s >>> 24 ^ t[r++]) & 255) << 1;
			s = Uf[u] ^ Of[c] ^ Nf[d] ^ Pf[f] ^ Tf[m] ^ Rf[y] ^ kf[w] ^ po[E], o = Uf[u + 1] ^ Of[c + 1] ^ Nf[d + 1] ^ Pf[f + 1] ^ Tf[m + 1] ^ Rf[y + 1] ^ kf[w + 1] ^ po[E + 1];
		}
		for (; r < n;) {
			const u = ((o ^ t[r]) & 255) << 1;
			o = (o >>> 8 | (s & 255) << 24) >>> 0, s = s >>> 8 ^ po[u], o ^= po[u + 1], r++;
		}
		this.c1 = s, this.c2 = o;
	}
	async digest() {
		const t = this.c1 ^ 4294967295, n = this.c2 ^ 4294967295;
		return new Uint8Array([
			t >>> 24,
			t >>> 16 & 255,
			t >>> 8 & 255,
			t & 255,
			n >>> 24,
			n >>> 16 & 255,
			n >>> 8 & 255,
			n & 255
		]);
	}
	reset() {
		this.c1 = 4294967295, this.c2 = 4294967295;
	}
};
var nR = function() {
	function e() {
		this.crc32 = new lu();
	}
	return e.prototype.update = function(t) {
		To(t) || this.crc32.update(Ei(t));
	}, e.prototype.digest = function() {
		return _d(this, void 0, void 0, function() {
			return Bd(this, function(t) {
				return [2, hw(this.crc32.digest())];
			});
		});
	}, e.prototype.reset = function() {
		this.crc32 = new lu();
	}, e;
}(), lu = function() {
	function e() {
		this.checksum = 4294967295;
	}
	return e.prototype.update = function(t) {
		var n, r;
		try {
			for (var s = dw(t), o = s.next(); !o.done; o = s.next()) {
				var u = o.value;
				this.checksum = this.checksum >>> 8 ^ iR[(this.checksum ^ u) & 255];
			}
		} catch (c) {
			n = { error: c };
		} finally {
			try {
				o && !o.done && (r = s.return) && r.call(s);
			} finally {
				if (n) throw n.error;
			}
		}
		return this;
	}, e.prototype.digest = function() {
		return (this.checksum ^ 4294967295) >>> 0;
	}, e;
}(), iR = pw([
	0,
	1996959894,
	3993919788,
	2567524794,
	124634137,
	1886057615,
	3915621685,
	2657392035,
	249268274,
	2044508324,
	3772115230,
	2547177864,
	162941995,
	2125561021,
	3887607047,
	2428444049,
	498536548,
	1789927666,
	4089016648,
	2227061214,
	450548861,
	1843258603,
	4107580753,
	2211677639,
	325883990,
	1684777152,
	4251122042,
	2321926636,
	335633487,
	1661365465,
	4195302755,
	2366115317,
	997073096,
	1281953886,
	3579855332,
	2724688242,
	1006888145,
	1258607687,
	3524101629,
	2768942443,
	901097722,
	1119000684,
	3686517206,
	2898065728,
	853044451,
	1172266101,
	3705015759,
	2882616665,
	651767980,
	1373503546,
	3369554304,
	3218104598,
	565507253,
	1454621731,
	3485111705,
	3099436303,
	671266974,
	1594198024,
	3322730930,
	2970347812,
	795835527,
	1483230225,
	3244367275,
	3060149565,
	1994146192,
	31158534,
	2563907772,
	4023717930,
	1907459465,
	112637215,
	2680153253,
	3904427059,
	2013776290,
	251722036,
	2517215374,
	3775830040,
	2137656763,
	141376813,
	2439277719,
	3865271297,
	1802195444,
	476864866,
	2238001368,
	4066508878,
	1812370925,
	453092731,
	2181625025,
	4111451223,
	1706088902,
	314042704,
	2344532202,
	4240017532,
	1658658271,
	366619977,
	2362670323,
	4224994405,
	1303535960,
	984961486,
	2747007092,
	3569037538,
	1256170817,
	1037604311,
	2765210733,
	3554079995,
	1131014506,
	879679996,
	2909243462,
	3663771856,
	1141124467,
	855842277,
	2852801631,
	3708648649,
	1342533948,
	654459306,
	3188396048,
	3373015174,
	1466479909,
	544179635,
	3110523913,
	3462522015,
	1591671054,
	702138776,
	2966460450,
	3352799412,
	1504918807,
	783551873,
	3082640443,
	3233442989,
	3988292384,
	2596254646,
	62317068,
	1957810842,
	3939845945,
	2647816111,
	81470997,
	1943803523,
	3814918930,
	2489596804,
	225274430,
	2053790376,
	3826175755,
	2466906013,
	167816743,
	2097651377,
	4027552580,
	2265490386,
	503444072,
	1762050814,
	4150417245,
	2154129355,
	426522225,
	1852507879,
	4275313526,
	2312317920,
	282753626,
	1742555852,
	4189708143,
	2394877945,
	397917763,
	1622183637,
	3604390888,
	2714866558,
	953729732,
	1340076626,
	3518719985,
	2797360999,
	1068828381,
	1219638859,
	3624741850,
	2936675148,
	906185462,
	1090812512,
	3747672003,
	2825379669,
	829329135,
	1181335161,
	3412177804,
	3160834842,
	628085408,
	1382605366,
	3423369109,
	3138078467,
	570562233,
	1426400815,
	3317316542,
	2998733608,
	733239954,
	1555261956,
	3268935591,
	3050360625,
	752459403,
	1541320221,
	2607071920,
	3965973030,
	1969922972,
	40735498,
	2617837225,
	3943577151,
	1913087877,
	83908371,
	2512341634,
	3803740692,
	2075208622,
	213261112,
	2463272603,
	3855990285,
	2094854071,
	198958881,
	2262029012,
	4057260610,
	1759359992,
	534414190,
	2176718541,
	4139329115,
	1873836001,
	414664567,
	2282248934,
	4279200368,
	1711684554,
	285281116,
	2405801727,
	4167216745,
	1634467795,
	376229701,
	2685067896,
	3608007406,
	1308918612,
	956543938,
	2808555105,
	3495958263,
	1231636301,
	1047427035,
	2932959818,
	3654703836,
	1088359270,
	936918e3,
	2847714899,
	3736837829,
	1202900863,
	817233897,
	3183342108,
	3401237130,
	1404277552,
	615818150,
	3134207493,
	3453421203,
	1423857449,
	601450431,
	3009837614,
	3294710456,
	1567103746,
	711928724,
	3020668471,
	3272380065,
	1510334235,
	755167117
]);
const sR = () => nR, gw = (e, t) => {
	switch (e) {
		case Qe.MD5: return t.md5;
		case Qe.CRC32: return sR();
		case Qe.CRC32C: return Jk;
		case Qe.CRC64NVME: return tR;
		case Qe.SHA1: return t.sha1;
		case Qe.SHA256: return t.sha256;
		default: throw new Error(`Unsupported checksum algorithm: ${e}`);
	}
}, mw = (e, t) => {
	const n = new e();
	return n.update(Ts(t || "")), n.digest();
}, oR = {
	name: "flexibleChecksumsMiddleware",
	step: "build",
	tags: ["BODY_CHECKSUM"],
	override: !0
}, aR = (e, t) => (n, r) => async (s) => {
	if (!bt.isInstance(s.request) || Kk("x-amz-checksum-", s.request.headers)) return n(s);
	const { request: o, input: u } = s, { body: c, headers: d } = o, { base64Encoder: f, streamHasher: m } = e, { requestChecksumRequired: y, requestAlgorithmMember: w } = t, E = await e.requestChecksumCalculation(), A = w == null ? void 0 : w.name, B = w == null ? void 0 : w.httpHeader;
	A && !u[A] && (E === ks.WHEN_SUPPORTED || y) && (u[A] = vf, B && (d[B] = vf));
	const T = Gk(u, {
		requestChecksumRequired: y,
		requestAlgorithmMember: w == null ? void 0 : w.name,
		requestChecksumCalculation: E
	});
	let $ = c, V = d;
	if (T) {
		switch (T) {
			case Qe.CRC32:
				Ft(r, "FLEXIBLE_CHECKSUMS_REQ_CRC32", "U");
				break;
			case Qe.CRC32C:
				Ft(r, "FLEXIBLE_CHECKSUMS_REQ_CRC32C", "V");
				break;
			case Qe.CRC64NVME:
				Ft(r, "FLEXIBLE_CHECKSUMS_REQ_CRC64", "W");
				break;
			case Qe.SHA1:
				Ft(r, "FLEXIBLE_CHECKSUMS_REQ_SHA1", "X");
				break;
			case Qe.SHA256:
				Ft(r, "FLEXIBLE_CHECKSUMS_REQ_SHA256", "Y");
				break;
		}
		const H = Ad(T), Q = gw(T, e);
		if (fw(c)) {
			const { getAwsChunkedEncodingStream: te, bodyLengthChecker: ge } = e;
			$ = te(typeof e.requestStreamBufferSize == "number" && e.requestStreamBufferSize >= 8 * 1024 ? uI(c, e.requestStreamBufferSize, r.logger) : c, {
				base64Encoder: f,
				bodyLengthChecker: ge,
				checksumLocationName: H,
				checksumAlgorithmFn: Q,
				streamHasher: m
			}), V = {
				...d,
				"content-encoding": d["content-encoding"] ? `${d["content-encoding"]},aws-chunked` : "aws-chunked",
				"transfer-encoding": "chunked",
				"x-amz-decoded-content-length": d["content-length"],
				"x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
				"x-amz-trailer": H
			}, delete V["content-length"];
		} else if (!Wk(H, d)) {
			const te = await mw(Q, c);
			V = {
				...d,
				[H]: f(te)
			};
		}
	}
	try {
		return await n({
			...s,
			request: {
				...o,
				headers: V,
				body: $
			}
		});
	} catch (H) {
		if (H instanceof Error && H.name === "InvalidChunkSizeError") try {
			H.message.endsWith(".") || (H.message += "."), H.message += " Set [requestStreamBufferSize=number e.g. 65_536] in client constructor to instruct AWS SDK to buffer your input stream.";
		} catch {}
		throw H;
	}
}, uR = {
	name: "flexibleChecksumsInputMiddleware",
	toMiddleware: "serializerMiddleware",
	relation: "before",
	tags: ["BODY_CHECKSUM"],
	override: !0
}, cR = (e, t) => (n, r) => async (s) => {
	const o = s.input, { requestValidationModeMember: u } = t, c = await e.requestChecksumCalculation(), d = await e.responseChecksumValidation();
	switch (c) {
		case ks.WHEN_REQUIRED:
			Ft(r, "FLEXIBLE_CHECKSUMS_REQ_WHEN_REQUIRED", "a");
			break;
		case ks.WHEN_SUPPORTED:
			Ft(r, "FLEXIBLE_CHECKSUMS_REQ_WHEN_SUPPORTED", "Z");
			break;
	}
	switch (d) {
		case ul.WHEN_REQUIRED:
			Ft(r, "FLEXIBLE_CHECKSUMS_RES_WHEN_REQUIRED", "c");
			break;
		case ul.WHEN_SUPPORTED:
			Ft(r, "FLEXIBLE_CHECKSUMS_RES_WHEN_SUPPORTED", "b");
			break;
	}
	return u && !o[u] && d === ul.WHEN_SUPPORTED && (o[u] = "ENABLED"), n(s);
}, yw = (e = []) => {
	const t = [];
	for (const n of jk) !e.includes(n) || !If.includes(n) || t.push(n);
	return t;
}, lR = (e) => {
	const t = e.lastIndexOf("-");
	if (t !== -1) {
		const n = e.slice(t + 1);
		if (!n.startsWith("0")) {
			const r = parseInt(n, 10);
			if (!isNaN(r) && r >= 1 && r <= 1e4) return !0;
		}
	}
	return !1;
}, fR = async (e, { checksumAlgorithmFn: t, base64Encoder: n }) => n(await mw(t, e)), dR = async (e, { config: t, responseAlgorithms: n, logger: r }) => {
	const s = yw(n), { body: o, headers: u } = e;
	for (const c of s) {
		const d = Ad(c), f = u[d];
		if (f) {
			let m;
			try {
				m = gw(c, t);
			} catch (E) {
				if (c === Qe.CRC64NVME) {
					r?.warn(`Skipping ${Qe.CRC64NVME} checksum validation: ${E.message}`);
					continue;
				}
				throw E;
			}
			const { base64Encoder: y } = t;
			if (fw(o)) {
				e.body = sI({
					expectedChecksum: f,
					checksumSourceLocation: d,
					checksum: new m(),
					source: o,
					base64Encoder: y
				});
				return;
			}
			const w = await fR(o, {
				checksumAlgorithmFn: m,
				base64Encoder: y
			});
			if (w === f) break;
			throw new Error(`Checksum mismatch: expected "${w}" but received "${f}" in response header "${d}".`);
		}
	}
}, hR = {
	name: "flexibleChecksumsResponseMiddleware",
	toMiddleware: "deserializerMiddleware",
	relation: "after",
	tags: ["BODY_CHECKSUM"],
	override: !0
}, pR = (e, t) => (n, r) => async (s) => {
	if (!bt.isInstance(s.request)) return n(s);
	const o = s.input, u = await n(s), c = u.response, { requestValidationModeMember: d, responseAlgorithms: f } = t;
	if (d && o[d] === "ENABLED") {
		const { clientName: m, commandName: y } = r;
		if (m === "S3Client" && y === "GetObjectCommand" && yw(f).every((E) => {
			const A = Ad(E), B = c.headers[A];
			return !B || lR(B);
		})) return u;
		await dR(c, {
			config: e,
			responseAlgorithms: f,
			logger: r.logger
		});
	}
	return u;
}, gR = (e, t) => ({ applyToStack: (n) => {
	n.add(aR(e, t), oR), n.addRelativeTo(cR(e, t), uR), n.addRelativeTo(pR(e, t), hR);
} }), mR = (e) => {
	const { requestChecksumCalculation: t, responseChecksumValidation: n, requestStreamBufferSize: r } = e;
	return Object.assign(e, {
		requestChecksumCalculation: or(t ?? LB),
		responseChecksumValidation: or(n ?? zB),
		requestStreamBufferSize: Number(r ?? 0)
	});
};
const yR = (e) => (t) => async (n) => {
	if (!bt.isInstance(n.request)) return t(n);
	const { request: r } = n, { handlerProtocol: s = "" } = e.requestHandler.metadata || {};
	if (s.indexOf("h2") >= 0 && !r.headers[":authority"]) delete r.headers.host, r.headers[":authority"] = r.hostname + (r.port ? ":" + r.port : "");
	else if (!r.headers.host) {
		let o = r.hostname;
		r.port != null && (o += `:${r.port}`), r.headers.host = o;
	}
	return t(n);
}, DR = {
	name: "hostHeaderMiddleware",
	step: "build",
	priority: "low",
	tags: ["HOST"],
	override: !0
}, wR = (e) => ({ applyToStack: (t) => {
	t.add(yR(e), DR);
} }), bR = () => (e, t) => async (n) => {
	var r, s;
	try {
		const o = await e(n), { clientName: u, commandName: c, logger: d, dynamoDbDocumentClientOptions: f = {} } = t, { overrideInputFilterSensitiveLog: m, overrideOutputFilterSensitiveLog: y } = f, w = m ?? t.inputFilterSensitiveLog, E = y ?? t.outputFilterSensitiveLog, { $metadata: A, ...B } = o.output;
		return (r = d == null ? void 0 : d.info) == null || r.call(d, {
			clientName: u,
			commandName: c,
			input: w(n.input),
			output: E(B),
			metadata: A
		}), o;
	} catch (o) {
		const { clientName: u, commandName: c, logger: d, dynamoDbDocumentClientOptions: f = {} } = t, { overrideInputFilterSensitiveLog: m } = f, y = m ?? t.inputFilterSensitiveLog;
		throw (s = d == null ? void 0 : d.error) == null || s.call(d, {
			clientName: u,
			commandName: c,
			input: y(n.input),
			error: o,
			metadata: o.$metadata
		}), o;
	}
}, ER = {
	name: "loggerMiddleware",
	tags: ["LOGGER"],
	step: "initialize",
	override: !0
}, vR = (e) => ({ applyToStack: (t) => {
	t.add(bR(), ER);
} }), SR = {
	step: "build",
	tags: ["RECURSION_DETECTION"],
	name: "recursionDetectionMiddleware",
	override: !0,
	priority: "low"
}, CR = () => (e) => async (t) => e(t), xR = (e) => ({ applyToStack: (t) => {
	t.add(CR(), SR);
} }), FR = "content-length", AR = "x-amz-decoded-content-length";
function _R() {
	return (e, t) => async (n) => {
		var s;
		const { request: r } = n;
		if (bt.isInstance(r) && !(FR in r.headers) && !(AR in r.headers)) {
			const o = "Are you using a Stream of unknown length as the Body of a PutObject request? Consider using Upload instead from @aws-sdk/lib-storage.";
			typeof ((s = t == null ? void 0 : t.logger) == null ? void 0 : s.warn) == "function" && !(t.logger instanceof xd) ? t.logger.warn(o) : console.warn(o);
		}
		return e({ ...n });
	};
}
const BR = {
	step: "finalizeRequest",
	tags: ["CHECK_CONTENT_LENGTH_HEADER"],
	name: "getCheckContentLengthHeaderPlugin",
	override: !0
}, IR = (e) => ({ applyToStack: (t) => {
	t.add(_R(), BR);
} }), kR = (e) => (t, n) => async (r) => {
	const s = await e.region(), o = e.region;
	let u = () => {};
	n.__s3RegionRedirect && (Object.defineProperty(e, "region", {
		writable: !1,
		value: async () => n.__s3RegionRedirect
	}), u = () => Object.defineProperty(e, "region", {
		writable: !0,
		value: o
	}));
	try {
		const c = await t(r);
		if (n.__s3RegionRedirect) {
			u();
			if (s !== await e.region()) throw new Error("Region was not restored following S3 region redirect.");
		}
		return c;
	} catch (c) {
		throw u(), c;
	}
}, RR = {
	tags: ["REGION_REDIRECT", "S3"],
	name: "regionRedirectEndpointMiddleware",
	override: !0,
	relation: "before",
	toMiddleware: "endpointV2Middleware"
};
function TR(e) {
	return (t, n) => async (r) => {
		var s, o, u, c;
		try {
			return await t(r);
		} catch (d) {
			if (e.followRegionRedirects) {
				const f = (s = d == null ? void 0 : d.$metadata) == null ? void 0 : s.httpStatusCode, m = n.commandName === "HeadBucketCommand", y = (u = (o = d == null ? void 0 : d.$response) == null ? void 0 : o.headers) == null ? void 0 : u["x-amz-bucket-region"];
				if (y && (f === 301 || f === 400 && ((d == null ? void 0 : d.name) === "IllegalLocationConstraintException" || m))) {
					try {
						const w = y;
						(c = n.logger) == null || c.debug(`Redirecting from ${await e.region()} to ${w}`), n.__s3RegionRedirect = w;
					} catch (w) {
						throw new Error("Region redirect failed: " + w);
					}
					return t(r);
				}
			}
			throw d;
		}
	};
}
const PR = {
	step: "initialize",
	tags: ["REGION_REDIRECT", "S3"],
	name: "regionRedirectMiddleware",
	override: !0
}, NR = (e) => ({ applyToStack: (t) => {
	t.add(TR(e), PR), t.addRelativeTo(kR(e), RR);
} }), yu = class yu {
	constructor(t = {}) {
		P(this, "data");
		P(this, "lastPurgeTime", Date.now());
		this.data = t;
	}
	get(t) {
		const n = this.data[t];
		if (n) return n;
	}
	set(t, n) {
		return this.data[t] = n, n;
	}
	delete(t) {
		delete this.data[t];
	}
	async purgeExpired() {
		const t = Date.now();
		if (!(this.lastPurgeTime + yu.EXPIRED_CREDENTIAL_PURGE_INTERVAL_MS > t)) for (const n in this.data) {
			const r = this.data[n];
			if (!r.isRefreshing) {
				const s = await r.identity;
				s.expiration && s.expiration.getTime() < t && delete this.data[n];
			}
		}
	}
};
P(yu, "EXPIRED_CREDENTIAL_PURGE_INTERVAL_MS", 3e4);
let Mf = yu;
var El = class {
	constructor(t, n = !1, r = Date.now()) {
		P(this, "_identity");
		P(this, "isRefreshing");
		P(this, "accessed");
		this._identity = t, this.isRefreshing = n, this.accessed = r;
	}
	get identity() {
		return this.accessed = Date.now(), this._identity;
	}
};
const Du = class Du {
	constructor(t, n = new Mf()) {
		P(this, "createSessionFn");
		P(this, "cache");
		this.createSessionFn = t, this.cache = n;
	}
	async getS3ExpressIdentity(t, n) {
		const r = n.Bucket, { cache: s } = this, o = s.get(r);
		return o ? o.identity.then((u) => {
			var f, m;
			return (((f = u.expiration) == null ? void 0 : f.getTime()) ?? 0) < Date.now() ? s.set(r, new El(this.getIdentity(r))).identity : ((((m = u.expiration) == null ? void 0 : m.getTime()) ?? 0) < Date.now() + Du.REFRESH_WINDOW_MS && !o.isRefreshing && (o.isRefreshing = !0, this.getIdentity(r).then((y) => {
				s.set(r, new El(Promise.resolve(y)));
			})), u);
		}) : s.set(r, new El(this.getIdentity(r))).identity;
	}
	async getIdentity(t) {
		var s, o;
		await this.cache.purgeExpired().catch((u) => {
			console.warn(`Error while clearing expired entries in S3ExpressIdentityCache: 
` + u);
		});
		const n = await this.createSessionFn(t);
		if (!((s = n.Credentials) != null && s.AccessKeyId) || !((o = n.Credentials) != null && o.SecretAccessKey)) throw new Error("s3#createSession response credential missing AccessKeyId or SecretAccessKey.");
		return {
			accessKeyId: n.Credentials.AccessKeyId,
			secretAccessKey: n.Credentials.SecretAccessKey,
			sessionToken: n.Credentials.SessionToken,
			expiration: n.Credentials.Expiration ? new Date(n.Credentials.Expiration) : void 0
		};
	}
};
P(Du, "REFRESH_WINDOW_MS", 6e4);
let $f = Du;
const OR = "Directory", UR = "S3Express", MR = "sigv4-s3express", Lf = "X-Amz-S3session-Token", zf = Lf.toLowerCase();
var $R = class extends Af {
	async signWithCredentials(t, n, r) {
		const s = A0(n);
		t.headers[zf] = n.sessionToken;
		const o = this;
		return _0(o, s), o.signRequest(t, r ?? {});
	}
	async presignWithCredentials(t, n, r) {
		const s = A0(n);
		return delete t.headers[zf], t.headers[Lf] = n.sessionToken, t.query = t.query ?? {}, t.query[Lf] = n.sessionToken, _0(this, s), this.presign(t, r);
	}
};
function A0(e) {
	return {
		accessKeyId: e.accessKeyId,
		secretAccessKey: e.secretAccessKey,
		expiration: e.expiration
	};
}
function _0(e, t) {
	const n = setTimeout(() => {
		throw new Error("SignatureV4S3Express credential override was created but not called.");
	}, 10), r = e.credentialProvider, s = () => (clearTimeout(n), e.credentialProvider = r, Promise.resolve(t));
	e.credentialProvider = s;
}
const LR = (e) => (t, n) => async (r) => {
	var s, o, u, c, d;
	if (n.endpointV2) {
		const f = n.endpointV2, m = ((u = (o = (s = f.properties) == null ? void 0 : s.authSchemes) == null ? void 0 : o[0]) == null ? void 0 : u.name) === MR;
		if ((((c = f.properties) == null ? void 0 : c.backend) === UR || ((d = f.properties) == null ? void 0 : d.bucketType) === OR) && (Ft(n, "S3_EXPRESS_BUCKET", "J"), n.isS3ExpressBucket = !0), m) {
			const w = r.input.Bucket;
			if (w) {
				const E = await e.s3ExpressIdentityProvider.getS3ExpressIdentity(await e.credentials(), { Bucket: w });
				n.s3ExpressIdentity = E, bt.isInstance(r.request) && E.sessionToken && (r.request.headers[zf] = E.sessionToken);
			}
		}
	}
	return t(r);
}, zR = {
	name: "s3ExpressMiddleware",
	step: "build",
	tags: ["S3", "S3_EXPRESS"],
	override: !0
}, HR = (e) => ({ applyToStack: (t) => {
	t.add(LR(e), zR);
} }), qR = async (e, t, n, r) => {
	const s = await r.signWithCredentials(n, e, {});
	if (s.headers["X-Amz-Security-Token"] || s.headers["x-amz-security-token"]) throw new Error("X-Amz-Security-Token must not be set for s3-express requests.");
	return s;
}, jR = (e) => (t) => {
	throw t;
}, GR = (e, t) => {}, WR = (e) => (t, n) => async (r) => {
	if (!bt.isInstance(r.request)) return t(r);
	const o = Ci(n).selectedHttpAuthScheme;
	if (!o) throw new Error("No HttpAuthScheme was selected: unable to sign request");
	const { httpAuthOption: { signingProperties: u = {} }, identity: c, signer: d } = o;
	let f;
	n.s3ExpressIdentity ? f = await qR(n.s3ExpressIdentity, u, r.request, await e.signer()) : f = await d.sign(r.request, c, u);
	const m = await t({
		...r,
		request: f
	}).catch((d.errorHandler || jR)(u));
	return (d.successHandler || GR)(m.response, u), m;
}, KR = (e) => ({ applyToStack: (t) => {
	t.addRelativeTo(WR(e), qD);
} }), VR = (e, { session: t }) => {
	const [n, r] = t, { forcePathStyle: s, useAccelerateEndpoint: o, disableMultiregionAccessPoints: u, followRegionRedirects: c, s3ExpressIdentityProvider: d, bucketEndpoint: f, expectContinueHeader: m } = e;
	return Object.assign(e, {
		forcePathStyle: s ?? !1,
		useAccelerateEndpoint: o ?? !1,
		disableMultiregionAccessPoints: u ?? !1,
		followRegionRedirects: c ?? !1,
		s3ExpressIdentityProvider: d ?? new $f(async (y) => n().send(new r({ Bucket: y }))),
		bucketEndpoint: f ?? !1,
		expectContinueHeader: m ?? 2097152
	});
}, ZR = {
	CopyObjectCommand: !0,
	UploadPartCopyCommand: !0,
	CompleteMultipartUploadCommand: !0
}, JR = 3e3, XR = (e) => (t, n) => async (r) => {
	const s = await t(r), { response: o } = s;
	if (!qi.isInstance(o)) return s;
	const { statusCode: u, body: c } = o;
	if (u < 200 || u >= 300 || !(typeof (c == null ? void 0 : c.stream) == "function" || typeof (c == null ? void 0 : c.pipe) == "function" || typeof (c == null ? void 0 : c.tee) == "function")) return s;
	let f = c, m = c;
	c && typeof c == "object" && !(c instanceof Uint8Array) && ([f, m] = await DI(c)), o.body = m;
	const y = await YR(f, { streamCollector: async (E) => dI(E, JR) });
	typeof (f == null ? void 0 : f.destroy) == "function" && f.destroy();
	const w = e.utf8Encoder(y.subarray(y.length - 16));
	if (y.length === 0 && ZR[n.commandName]) {
		const E = /* @__PURE__ */ new Error("S3 aborted request");
		throw E.name = "InternalError", E;
	}
	return w && w.endsWith("</Error>") && (o.statusCode = 400), s;
}, YR = (e = new Uint8Array(), t) => e instanceof Uint8Array ? Promise.resolve(e) : t.streamCollector(e) || Promise.resolve(new Uint8Array()), QR = {
	relation: "after",
	toMiddleware: "deserializerMiddleware",
	tags: ["THROW_200_EXCEPTIONS", "S3"],
	name: "throw200ExceptionsMiddleware",
	override: !0
}, Dw = (e) => ({ applyToStack: (t) => {
	t.addRelativeTo(XR(e), QR);
} }), eT = (e) => typeof e == "string" && e.indexOf("arn:") === 0 && e.split(":").length >= 6;
function tT(e) {
	return (t, n) => async (r) => {
		var s, o, u, c;
		if (e.bucketEndpoint) {
			const d = n.endpointV2;
			if (d) {
				const f = r.input.Bucket;
				if (typeof f == "string") try {
					const m = new URL(f);
					n.endpointV2 = {
						...d,
						url: m
					};
				} catch (m) {
					const y = `@aws-sdk/middleware-sdk-s3: bucketEndpoint=true was set but Bucket=${f} could not be parsed as URL.`;
					throw ((o = (s = n.logger) == null ? void 0 : s.constructor) == null ? void 0 : o.name) === "NoOpLogger" ? console.warn(y) : (c = (u = n.logger) == null ? void 0 : u.warn) == null || c.call(u, y), m;
				}
			}
		}
		return t(r);
	};
}
const nT = {
	name: "bucketEndpointMiddleware",
	override: !0,
	relation: "after",
	toMiddleware: "endpointV2Middleware"
};
function rT({ bucketEndpoint: e }) {
	return (t) => async (n) => {
		const { input: { Bucket: r } } = n;
		if (!e && typeof r == "string" && !eT(r) && r.indexOf("/") >= 0) {
			const s = /* @__PURE__ */ new Error(`Bucket name shouldn't contain '/', received '${r}'`);
			throw s.name = "InvalidBucketName", s;
		}
		return t({ ...n });
	};
}
const iT = {
	step: "initialize",
	tags: ["VALIDATE_BUCKET_NAME"],
	name: "validateBucketNameMiddleware",
	override: !0
}, sT = (e) => ({ applyToStack: (t) => {
	t.add(rT(e), iT), t.addRelativeTo(tT(e), nT);
} }), oT = void 0;
function aT(e) {
	return e === void 0 ? !0 : typeof e == "string" && e.length <= 50;
}
function uT(e) {
	const t = Fs(e.userAgentAppId ?? oT), { customUserAgent: n } = e;
	return Object.assign(e, {
		customUserAgent: typeof n == "string" ? [[n]] : n,
		userAgentAppId: async () => {
			var s, o;
			const r = await t();
			if (!aT(r)) {
				const u = ((o = (s = e.logger) == null ? void 0 : s.constructor) == null ? void 0 : o.name) === "NoOpLogger" || !e.logger ? console : e.logger;
				typeof r != "string" ? u?.warn("userAgentAppId must be a string or undefined.") : r.length > 50 && u?.warn("The provided userAgentAppId exceeds the maximum length of 50 characters.");
			}
			return r;
		}
	});
}
var cT = class {
	constructor({ size: t, params: n }) {
		P(this, "capacity");
		P(this, "data", /* @__PURE__ */ new Map());
		P(this, "parameters", []);
		this.capacity = t ?? 50, n && (this.parameters = n);
	}
	get(t, n) {
		const r = this.hash(t);
		if (r === !1) return n();
		if (!this.data.has(r)) {
			if (this.data.size > this.capacity + 10) {
				const s = this.data.keys();
				let o = 0;
				for (;;) {
					const { value: u, done: c } = s.next();
					if (this.data.delete(u), c || ++o > 10) break;
				}
			}
			this.data.set(r, n());
		}
		return this.data.get(r);
	}
	size() {
		return this.data.size;
	}
	hash(t) {
		let n = "";
		const { parameters: r } = this;
		if (r.length === 0) return !1;
		for (const s of r) {
			const o = String(t[s] ?? "");
			if (o.includes("|;")) return !1;
			n += o + "|;";
		}
		return n;
	}
};
const lT = /* @__PURE__ */ new RegExp("^(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}$"), Id = (e) => lT.test(e) || e.startsWith("[") && e.endsWith("]"), fT = /* @__PURE__ */ new RegExp("^(?!.*-$)(?!-)[a-zA-Z0-9-]{1,63}$"), Lo = (e, t = !1) => {
	if (!t) return fT.test(e);
	const n = e.split(".");
	for (const r of n) if (!Lo(r)) return !1;
	return !0;
}, Po = {}, No = "endpoints";
function vi(e) {
	return typeof e != "object" || e == null ? e : "ref" in e ? `$${vi(e.ref)}` : "fn" in e ? `${e.fn}(${(e.argv || []).map(vi).join(", ")})` : JSON.stringify(e, null, 2);
}
var Mn = class extends Error {
	constructor(t) {
		super(t), this.name = "EndpointError";
	}
};
const dT = (e, t) => e === t, hT = (e) => {
	const t = e.split("."), n = [];
	for (const r of t) {
		const s = r.indexOf("[");
		if (s !== -1) {
			if (r.indexOf("]") !== r.length - 1) throw new Mn(`Path: '${e}' does not end with ']'`);
			const o = r.slice(s + 1, -1);
			if (Number.isNaN(parseInt(o))) throw new Mn(`Invalid array index: '${o}' in path: '${e}'`);
			s !== 0 && n.push(r.slice(0, s)), n.push(o);
		} else n.push(r);
	}
	return n;
}, ww = (e, t) => hT(t).reduce((n, r) => {
	if (typeof n != "object") throw new Mn(`Index '${r}' in '${t}' not found in '${JSON.stringify(e)}'`);
	return Array.isArray(n) ? n[parseInt(r)] : n[r];
}, e), pT = (e) => e != null, gT = (e) => !e, vl = {
	[Ro.HTTP]: 80,
	[Ro.HTTPS]: 443
}, mT = (e) => {
	const t = (() => {
		try {
			if (e instanceof URL) return e;
			if (typeof e == "object" && "hostname" in e) {
				const { hostname: w, port: E, protocol: A = "", path: B = "", query: T = {} } = e, $ = new URL(`${A}//${w}${E ? `:${E}` : ""}${B}`);
				return $.search = Object.entries(T).map(([V, H]) => `${V}=${H}`).join("&"), $;
			}
			return new URL(e);
		} catch {
			return null;
		}
	})();
	if (!t) return console.error(`Unable to parse ${JSON.stringify(e)} as a whatwg URL.`), null;
	const n = t.href, { host: r, hostname: s, pathname: o, protocol: u, search: c } = t;
	if (c) return null;
	const d = u.slice(0, -1);
	if (!Object.values(Ro).includes(d)) return null;
	const f = Id(s);
	return {
		scheme: d,
		authority: `${r}${n.includes(`${r}:${vl[d]}`) || typeof e == "string" && e.includes(`${r}:${vl[d]}`) ? `:${vl[d]}` : ""}`,
		path: o,
		normalizedPath: o.endsWith("/") ? o : `${o}/`,
		isIp: f
	};
}, yT = (e, t) => e === t, DT = (e, t, n, r) => t >= n || e.length < n ? null : r ? e.substring(e.length - n, e.length - t) : e.substring(t, n), wT = (e) => encodeURIComponent(e).replace(/[!*'()]/g, (t) => `%${t.charCodeAt(0).toString(16).toUpperCase()}`), bT = {
	booleanEquals: dT,
	getAttr: ww,
	isSet: pT,
	isValidHostLabel: Lo,
	not: gT,
	parseURL: mT,
	stringEquals: yT,
	substring: DT,
	uriEncode: wT
}, bw = (e, t) => {
	const n = [], r = {
		...t.endpointParams,
		...t.referenceRecord
	};
	let s = 0;
	for (; s < e.length;) {
		const o = e.indexOf("{", s);
		if (o === -1) {
			n.push(e.slice(s));
			break;
		}
		n.push(e.slice(s, o));
		const u = e.indexOf("}", o);
		if (u === -1) {
			n.push(e.slice(o));
			break;
		}
		e[o + 1] === "{" && e[u + 1] === "}" && (n.push(e.slice(o + 1, u)), s = u + 2);
		const c = e.substring(o + 1, u);
		if (c.includes("#")) {
			const [d, f] = c.split("#");
			n.push(ww(r[d], f));
		} else n.push(r[c]);
		s = u + 1;
	}
	return n.join("");
}, ET = ({ ref: e }, t) => ({
	...t.endpointParams,
	...t.referenceRecord
})[e], Iu = (e, t, n) => {
	if (typeof e == "string") return bw(e, n);
	if (e.fn) return vw.callFunction(e, n);
	if (e.ref) return ET(e, n);
	throw new Mn(`'${t}': ${String(e)} is not a string, function or reference.`);
}, Ew = ({ fn: e, argv: t }, n) => {
	const r = t.map((o) => ["boolean", "number"].includes(typeof o) ? o : vw.evaluateExpression(o, "arg", n)), s = e.split(".");
	return s[0] in Po && s[1] != null ? Po[s[0]][s[1]](...r) : bT[e](...r);
}, vw = {
	evaluateExpression: Iu,
	callFunction: Ew
}, vT = ({ assign: e, ...t }, n) => {
	var s, o;
	if (e && e in n.referenceRecord) throw new Mn(`'${e}' is already defined in Reference Record.`);
	const r = Ew(t, n);
	return (o = (s = n.logger) == null ? void 0 : s.debug) == null || o.call(s, `${No} evaluateCondition: ${vi(t)} = ${vi(r)}`), {
		result: r === "" ? !0 : !!r,
		...e != null && { toAssign: {
			name: e,
			value: r
		} }
	};
}, kd = (e = [], t) => {
	var r, s;
	const n = {};
	for (const o of e) {
		const { result: u, toAssign: c } = vT(o, {
			...t,
			referenceRecord: {
				...t.referenceRecord,
				...n
			}
		});
		if (!u) return { result: u };
		c && (n[c.name] = c.value, (s = (r = t.logger) == null ? void 0 : r.debug) == null || s.call(r, `${No} assign: ${c.name} := ${vi(c.value)}`));
	}
	return {
		result: !0,
		referenceRecord: n
	};
}, ST = (e, t) => Object.entries(e).reduce((n, [r, s]) => ({
	...n,
	[r]: s.map((o) => {
		const u = Iu(o, "Header value entry", t);
		if (typeof u != "string") throw new Mn(`Header '${r}' value '${u}' is not a string`);
		return u;
	})
}), {}), Sw = (e, t) => Object.entries(e).reduce((n, [r, s]) => ({
	...n,
	[r]: xw.getEndpointProperty(s, t)
}), {}), Cw = (e, t) => {
	if (Array.isArray(e)) return e.map((n) => Cw(n, t));
	switch (typeof e) {
		case "string": return bw(e, t);
		case "object":
			if (e === null) throw new Mn(`Unexpected endpoint property: ${e}`);
			return xw.getEndpointProperties(e, t);
		case "boolean": return e;
		default: throw new Mn(`Unexpected endpoint property type: ${typeof e}`);
	}
}, xw = {
	getEndpointProperty: Cw,
	getEndpointProperties: Sw
}, CT = (e, t) => {
	const n = Iu(e, "Endpoint URL", t);
	if (typeof n == "string") try {
		return new URL(n);
	} catch (r) {
		throw console.error(`Failed to construct URL with ${n}`, r), r;
	}
	throw new Mn(`Endpoint URL must be a string, got ${typeof n}`);
}, xT = (e, t) => {
	var m, y;
	const { conditions: n, endpoint: r } = e, { result: s, referenceRecord: o } = kd(n, t);
	if (!s) return;
	const u = {
		...t,
		referenceRecord: {
			...t.referenceRecord,
			...o
		}
	}, { url: c, properties: d, headers: f } = r;
	return (y = (m = t.logger) == null ? void 0 : m.debug) == null || y.call(m, `${No} Resolving endpoint from template: ${vi(r)}`), {
		...f != null && { headers: ST(f, u) },
		...d != null && { properties: Sw(d, u) },
		url: CT(c, u)
	};
}, FT = (e, t) => {
	const { conditions: n, error: r } = e, { result: s, referenceRecord: o } = kd(n, t);
	if (s) throw new Mn(Iu(r, "Error", {
		...t,
		referenceRecord: {
			...t.referenceRecord,
			...o
		}
	}));
}, Fw = (e, t) => {
	for (const n of e) if (n.type === "endpoint") {
		const r = xT(n, t);
		if (r) return r;
	} else if (n.type === "error") FT(n, t);
	else if (n.type === "tree") {
		const r = Aw.evaluateTreeRule(n, t);
		if (r) return r;
	} else throw new Mn(`Unknown endpoint rule: ${n}`);
	throw new Mn("Rules evaluation failed");
}, AT = (e, t) => {
	const { conditions: n, rules: r } = e, { result: s, referenceRecord: o } = kd(n, t);
	if (s) return Aw.evaluateRules(r, {
		...t,
		referenceRecord: {
			...t.referenceRecord,
			...o
		}
	});
}, Aw = {
	evaluateRules: Fw,
	evaluateTreeRule: AT
}, _T = (e, t) => {
	var f, m, y, w;
	const { endpointParams: n, logger: r } = t, { parameters: s, rules: o } = e;
	(m = (f = t.logger) == null ? void 0 : f.debug) == null || m.call(f, `${No} Initial EndpointParams: ${vi(n)}`);
	const u = Object.entries(s).filter(([, E]) => E.default != null).map(([E, A]) => [E, A.default]);
	if (u.length > 0) for (const [E, A] of u) n[E] = n[E] ?? A;
	const c = Object.entries(s).filter(([, E]) => E.required).map(([E]) => E);
	for (const E of c) if (n[E] == null) throw new Mn(`Missing required parameter: '${E}'`);
	const d = Fw(o, {
		endpointParams: n,
		logger: r,
		referenceRecord: {}
	});
	return (w = (y = t.logger) == null ? void 0 : y.debug) == null || w.call(y, `${No} Resolved endpoint: ${vi(d)}`), d;
}, _w = (e, t = !1) => {
	if (t) {
		for (const n of e.split(".")) if (!_w(n)) return !1;
		return !0;
	}
	return !(!Lo(e) || e.length < 3 || e.length > 63 || e !== e.toLowerCase() || Id(e));
}, B0 = ":", BT = "/", IT = (e) => {
	const t = e.split(B0);
	if (t.length < 6) return null;
	const [n, r, s, o, u, ...c] = t;
	if (n !== "arn" || r === "" || s === "" || c.join(B0) === "") return null;
	return {
		partition: r,
		service: s,
		region: o,
		accountId: u,
		resourceId: c.map((f) => f.split(BT)).flat()
	};
};
let TT = { partitions: [
	{
		id: "aws",
		outputs: {
			dnsSuffix: "amazonaws.com",
			dualStackDnsSuffix: "api.aws",
			implicitGlobalRegion: "us-east-1",
			name: "aws",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^(us|eu|ap|sa|ca|me|af|il|mx)\\-\\w+\\-\\d+$",
		regions: {
			"af-south-1": { description: "Africa (Cape Town)" },
			"ap-east-1": { description: "Asia Pacific (Hong Kong)" },
			"ap-east-2": { description: "Asia Pacific (Taipei)" },
			"ap-northeast-1": { description: "Asia Pacific (Tokyo)" },
			"ap-northeast-2": { description: "Asia Pacific (Seoul)" },
			"ap-northeast-3": { description: "Asia Pacific (Osaka)" },
			"ap-south-1": { description: "Asia Pacific (Mumbai)" },
			"ap-south-2": { description: "Asia Pacific (Hyderabad)" },
			"ap-southeast-1": { description: "Asia Pacific (Singapore)" },
			"ap-southeast-2": { description: "Asia Pacific (Sydney)" },
			"ap-southeast-3": { description: "Asia Pacific (Jakarta)" },
			"ap-southeast-4": { description: "Asia Pacific (Melbourne)" },
			"ap-southeast-5": { description: "Asia Pacific (Malaysia)" },
			"ap-southeast-6": { description: "Asia Pacific (New Zealand)" },
			"ap-southeast-7": { description: "Asia Pacific (Thailand)" },
			"aws-global": { description: "aws global region" },
			"ca-central-1": { description: "Canada (Central)" },
			"ca-west-1": { description: "Canada West (Calgary)" },
			"eu-central-1": { description: "Europe (Frankfurt)" },
			"eu-central-2": { description: "Europe (Zurich)" },
			"eu-north-1": { description: "Europe (Stockholm)" },
			"eu-south-1": { description: "Europe (Milan)" },
			"eu-south-2": { description: "Europe (Spain)" },
			"eu-west-1": { description: "Europe (Ireland)" },
			"eu-west-2": { description: "Europe (London)" },
			"eu-west-3": { description: "Europe (Paris)" },
			"il-central-1": { description: "Israel (Tel Aviv)" },
			"me-central-1": { description: "Middle East (UAE)" },
			"me-south-1": { description: "Middle East (Bahrain)" },
			"mx-central-1": { description: "Mexico (Central)" },
			"sa-east-1": { description: "South America (Sao Paulo)" },
			"us-east-1": { description: "US East (N. Virginia)" },
			"us-east-2": { description: "US East (Ohio)" },
			"us-west-1": { description: "US West (N. California)" },
			"us-west-2": { description: "US West (Oregon)" }
		}
	},
	{
		id: "aws-cn",
		outputs: {
			dnsSuffix: "amazonaws.com.cn",
			dualStackDnsSuffix: "api.amazonwebservices.com.cn",
			implicitGlobalRegion: "cn-northwest-1",
			name: "aws-cn",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^cn\\-\\w+\\-\\d+$",
		regions: {
			"aws-cn-global": { description: "aws-cn global region" },
			"cn-north-1": { description: "China (Beijing)" },
			"cn-northwest-1": { description: "China (Ningxia)" }
		}
	},
	{
		id: "aws-eusc",
		outputs: {
			dnsSuffix: "amazonaws.eu",
			dualStackDnsSuffix: "api.amazonwebservices.eu",
			implicitGlobalRegion: "eusc-de-east-1",
			name: "aws-eusc",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^eusc\\-(de)\\-\\w+\\-\\d+$",
		regions: { "eusc-de-east-1": { description: "AWS European Sovereign Cloud (Germany)" } }
	},
	{
		id: "aws-iso",
		outputs: {
			dnsSuffix: "c2s.ic.gov",
			dualStackDnsSuffix: "api.aws.ic.gov",
			implicitGlobalRegion: "us-iso-east-1",
			name: "aws-iso",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^us\\-iso\\-\\w+\\-\\d+$",
		regions: {
			"aws-iso-global": { description: "aws-iso global region" },
			"us-iso-east-1": { description: "US ISO East" },
			"us-iso-west-1": { description: "US ISO WEST" }
		}
	},
	{
		id: "aws-iso-b",
		outputs: {
			dnsSuffix: "sc2s.sgov.gov",
			dualStackDnsSuffix: "api.aws.scloud",
			implicitGlobalRegion: "us-isob-east-1",
			name: "aws-iso-b",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^us\\-isob\\-\\w+\\-\\d+$",
		regions: {
			"aws-iso-b-global": { description: "aws-iso-b global region" },
			"us-isob-east-1": { description: "US ISOB East (Ohio)" },
			"us-isob-west-1": { description: "US ISOB West" }
		}
	},
	{
		id: "aws-iso-e",
		outputs: {
			dnsSuffix: "cloud.adc-e.uk",
			dualStackDnsSuffix: "api.cloud-aws.adc-e.uk",
			implicitGlobalRegion: "eu-isoe-west-1",
			name: "aws-iso-e",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^eu\\-isoe\\-\\w+\\-\\d+$",
		regions: {
			"aws-iso-e-global": { description: "aws-iso-e global region" },
			"eu-isoe-west-1": { description: "EU ISOE West" }
		}
	},
	{
		id: "aws-iso-f",
		outputs: {
			dnsSuffix: "csp.hci.ic.gov",
			dualStackDnsSuffix: "api.aws.hci.ic.gov",
			implicitGlobalRegion: "us-isof-south-1",
			name: "aws-iso-f",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^us\\-isof\\-\\w+\\-\\d+$",
		regions: {
			"aws-iso-f-global": { description: "aws-iso-f global region" },
			"us-isof-east-1": { description: "US ISOF EAST" },
			"us-isof-south-1": { description: "US ISOF SOUTH" }
		}
	},
	{
		id: "aws-us-gov",
		outputs: {
			dnsSuffix: "amazonaws.com",
			dualStackDnsSuffix: "api.aws",
			implicitGlobalRegion: "us-gov-west-1",
			name: "aws-us-gov",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^us\\-gov\\-\\w+\\-\\d+$",
		regions: {
			"aws-us-gov-global": { description: "aws-us-gov global region" },
			"us-gov-east-1": { description: "AWS GovCloud (US-East)" },
			"us-gov-west-1": { description: "AWS GovCloud (US-West)" }
		}
	}
] };
const PT = (e) => {
	const { partitions: t } = TT;
	for (const r of t) {
		const { regions: s, outputs: o } = r;
		for (const [u, c] of Object.entries(s)) if (u === e) return {
			...o,
			...c
		};
	}
	for (const r of t) {
		const { regionRegex: s, outputs: o } = r;
		if (new RegExp(s).test(e)) return { ...o };
	}
	const n = t.find((r) => r.id === "aws");
	if (!n) throw new Error("Provided region was not found in the partition array or regex, and default partition with id 'aws' doesn't exist.");
	return { ...n.outputs };
};
Po.aws = {
	isVirtualHostableS3Bucket: _w,
	parseArn: IT,
	partition: PT
};
function OT(e) {
	const t = {};
	if (e = e.replace(/^\?/, ""), e) for (const n of e.split("&")) {
		let [r, s = null] = n.split("=");
		r = decodeURIComponent(r), s && (s = decodeURIComponent(s)), r in t ? Array.isArray(t[r]) ? t[r].push(s) : t[r] = [t[r], s] : t[r] = s;
	}
	return t;
}
const fu = (e) => {
	if (typeof e == "string") return fu(new URL(e));
	const { hostname: t, pathname: n, port: r, protocol: s, search: o } = e;
	let u;
	return o && (u = OT(o)), {
		hostname: t,
		port: r ? parseInt(r) : void 0,
		protocol: s,
		path: n,
		query: u
	};
}, UT = /\d{12}\.ddb/;
async function MT(e, t, n) {
	var o, u, c, d, f, m, y;
	const r = n.request;
	if (((o = r == null ? void 0 : r.headers) == null ? void 0 : o["smithy-protocol"]) === "rpc-v2-cbor" && Ft(e, "PROTOCOL_RPC_V2_CBOR", "M"), typeof t.retryStrategy == "function") {
		const w = await t.retryStrategy();
		typeof w.acquireInitialRetryToken == "function" ? (c = (u = w.constructor) == null ? void 0 : u.name) != null && c.includes("Adaptive") ? Ft(e, "RETRY_MODE_ADAPTIVE", "F") : Ft(e, "RETRY_MODE_STANDARD", "E") : Ft(e, "RETRY_MODE_LEGACY", "D");
	}
	if (typeof t.accountIdEndpointMode == "function") {
		const w = e.endpointV2;
		switch (String((d = w == null ? void 0 : w.url) == null ? void 0 : d.hostname).match(UT) && Ft(e, "ACCOUNT_ID_ENDPOINT", "O"), await ((f = t.accountIdEndpointMode) == null ? void 0 : f.call(t))) {
			case "disabled":
				Ft(e, "ACCOUNT_ID_MODE_DISABLED", "Q");
				break;
			case "preferred":
				Ft(e, "ACCOUNT_ID_MODE_PREFERRED", "P");
				break;
			case "required":
				Ft(e, "ACCOUNT_ID_MODE_REQUIRED", "R");
				break;
		}
	}
	const s = (y = (m = e.__smithy_context) == null ? void 0 : m.selectedHttpAuthScheme) == null ? void 0 : y.identity;
	if (s != null && s.$source) {
		const w = s;
		w.accountId && Ft(e, "RESOLVED_ACCOUNT_ID", "T");
		for (const [E, A] of Object.entries(w.$source ?? {})) Ft(e, E, A);
	}
}
const I0 = "user-agent", Sl = "x-amz-user-agent", k0 = " ", Cl = "/", $T = /[^!$%&'*+\-.^_`|~\w]/g, LT = /[^!$%&'*+\-.^_`|~\w#]/g, R0 = "-", zT = 1024;
function HT(e) {
	let t = "";
	for (const n in e) {
		const r = e[n];
		if (t.length + r.length + 1 <= zT) {
			t.length ? t += "," + r : t += r;
			continue;
		}
		break;
	}
	return t;
}
const qT = (e) => (t, n) => async (r) => {
	var E, A, B, T;
	const { request: s } = r;
	if (!bt.isInstance(s)) return t(r);
	const { headers: o } = s, u = ((E = n == null ? void 0 : n.userAgent) == null ? void 0 : E.map(za)) || [], c = (await e.defaultUserAgentProvider()).map(za);
	await MT(n, e, r);
	const d = n;
	c.push(`m/${HT(Object.assign({}, (A = n.__smithy_context) == null ? void 0 : A.features, (B = d.__aws_sdk_context) == null ? void 0 : B.features))}`);
	const f = ((T = e == null ? void 0 : e.customUserAgent) == null ? void 0 : T.map(za)) || [], m = await e.userAgentAppId();
	m && c.push(za(["app", `${m}`]));
	const y = [].concat([
		...c,
		...u,
		...f
	]).join(k0), w = [...c.filter(($) => $.startsWith("aws-sdk-")), ...f].join(k0);
	return e.runtime !== "browser" ? (w && (o[Sl] = o[Sl] ? `${o[I0]} ${w}` : w), o[I0] = y) : o[Sl] = y, t({
		...r,
		request: s
	});
}, za = (e) => {
	var u;
	const t = e[0].split(Cl).map((c) => c.replace($T, R0)).join(Cl), n = (u = e[1]) == null ? void 0 : u.replace(LT, R0), r = t.indexOf(Cl), s = t.substring(0, r);
	let o = t.substring(r + 1);
	return s === "api" && (o = o.toLowerCase()), [
		s,
		o,
		n
	].filter((c) => c && c.length > 0).reduce((c, d, f) => {
		switch (f) {
			case 0: return d;
			case 1: return `${c}/${d}`;
			default: return `${c}#${d}`;
		}
	}, "");
}, jT = {
	name: "getUserAgentMiddleware",
	step: "build",
	priority: "low",
	tags: ["SET_USER_AGENT", "USER_AGENT"],
	override: !0
}, GT = (e) => ({ applyToStack: (t) => {
	t.add(qT(e), jT);
} }), WT = !1, KT = !1, T0 = /* @__PURE__ */ new Set(), VT = (e, t = Lo) => {
	if (!T0.has(e) && !t(e)) if (e === "*") console.warn("@smithy/config-resolver WARN - Please use the caller region instead of \"*\". See \"sigv4a\" in https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/CLIENTS.md.");
	else throw new Error(`Region not accepted: region="${e}" is not a valid hostname component.`);
	else T0.add(e);
}, Bw = (e) => typeof e == "string" && (e.startsWith("fips-") || e.endsWith("-fips")), ZT = (e) => Bw(e) ? ["fips-aws-global", "aws-fips"].includes(e) ? "us-east-1" : e.replace(/fips-(dkr-|prod-)?|-fips/, "") : e, JT = (e) => {
	const { region: t, useFipsEndpoint: n } = e;
	if (!t) throw new Error("Region is missing");
	return Object.assign(e, {
		region: async () => {
			const s = ZT(typeof t == "function" ? await t() : t);
			return VT(s), s;
		},
		useFipsEndpoint: async () => {
			return Bw(typeof t == "string" ? t : await t()) ? !0 : typeof n != "function" ? Promise.resolve(!!n) : n();
		}
	});
}, XT = (e) => Object.assign(e, { eventStreamMarshaller: e.eventStreamSerdeProvider(e) }), P0 = "content-length";
function YT(e) {
	return (t) => async (n) => {
		const r = n.request;
		if (bt.isInstance(r)) {
			const { body: s, headers: o } = r;
			if (s && Object.keys(o).map((u) => u.toLowerCase()).indexOf(P0) === -1) try {
				const u = e(s);
				r.headers = {
					...r.headers,
					[P0]: String(u)
				};
			} catch {}
		}
		return t({
			...n,
			request: r
		});
	};
}
const QT = {
	step: "build",
	tags: ["SET_CONTENT_LENGTH", "CONTENT_LENGTH"],
	name: "contentLengthMiddleware",
	override: !0
}, e8 = (e) => ({ applyToStack: (t) => {
	t.add(YT(e.bodyLengthChecker), QT);
} }), t8 = async (e) => {
	const t = (e == null ? void 0 : e.Bucket) || "";
	if (typeof e.Bucket == "string" && (e.Bucket = t.replace(/#/g, encodeURIComponent("#")).replace(/\?/g, encodeURIComponent("?"))), o8(t)) {
		if (e.ForcePathStyle === !0) throw new Error("Path-style addressing cannot be used with ARN buckets");
	} else (!s8(t) || t.indexOf(".") !== -1 && !String(e.Endpoint).startsWith("http:") || t.toLowerCase() !== t || t.length < 3) && (e.ForcePathStyle = !0);
	return e.DisableMultiRegionAccessPoints && (e.disableMultiRegionAccessPoints = !0, e.DisableMRAP = !0), e;
}, n8 = /^[a-z0-9][a-z0-9\.\-]{1,61}[a-z0-9]$/, r8 = /(\d+\.){3}\d+/, i8 = /\.\./, s8 = (e) => n8.test(e) && !r8.test(e) && !i8.test(e), o8 = (e) => {
	const [t, n, r, , , s] = e.split(":"), o = t === "arn" && e.split(":").length >= 6, u = !!(o && n && r && s);
	if (o && !u) throw new Error(`Invalid ARN: ${e} was an invalid ARN.`);
	return u;
}, a8 = (e, t, n, r = !1) => {
	const s = async () => {
		let o;
		if (r) {
			const u = n.clientContextParams;
			o = (u == null ? void 0 : u[e]) ?? n[e] ?? n[t];
		} else o = n[e] ?? n[t];
		return typeof o == "function" ? o() : o;
	};
	return e === "credentialScope" || t === "CredentialScope" ? async () => {
		const o = typeof n.credentials == "function" ? await n.credentials() : n.credentials;
		return (o == null ? void 0 : o.credentialScope) ?? (o == null ? void 0 : o.CredentialScope);
	} : e === "accountId" || t === "AccountId" ? async () => {
		const o = typeof n.credentials == "function" ? await n.credentials() : n.credentials;
		return (o == null ? void 0 : o.accountId) ?? (o == null ? void 0 : o.AccountId);
	} : e === "endpoint" || t === "endpoint" ? async () => {
		if (n.isCustomEndpoint === !1) return;
		const o = await s();
		if (o && typeof o == "object") {
			if ("url" in o) return o.url.href;
			if ("hostname" in o) {
				const { protocol: u, hostname: c, port: d, path: f } = o;
				return `${u}//${c}${d ? ":" + d : ""}${f}`;
			}
		}
		return o;
	} : s;
}, Iw = async (e) => {}, kw = (e) => typeof e == "object" ? "url" in e ? fu(e.url) : e : fu(e), Rw = async (e, t, n, r) => {
	if (!n.isCustomEndpoint) {
		let u;
		n.serviceConfiguredEndpoint ? u = await n.serviceConfiguredEndpoint() : u = await Iw(n.serviceId), u && (n.endpoint = () => Promise.resolve(kw(u)), n.isCustomEndpoint = !0);
	}
	const s = await Tw(e, t, n);
	if (typeof n.endpointProvider != "function") throw new Error("config.endpointProvider is not set.");
	return n.endpointProvider(s, r);
}, Tw = async (e, t, n) => {
	var o;
	const r = {}, s = ((o = t == null ? void 0 : t.getEndpointParameterInstructions) == null ? void 0 : o.call(t)) || {};
	for (const [u, c] of Object.entries(s)) switch (c.type) {
		case "staticContextParams":
			r[u] = c.value;
			break;
		case "contextParams":
			r[u] = e[c.name];
			break;
		case "clientContextParams":
		case "builtInParams":
			r[u] = await a8(c.name, u, n, c.type !== "builtInParams")();
			break;
		case "operationContextParams":
			r[u] = c.get(e);
			break;
		default: throw new Error("Unrecognized endpoint parameter instruction: " + JSON.stringify(c));
	}
	return Object.keys(s).length === 0 && Object.assign(r, n), String(n.serviceId).toLowerCase() === "s3" && await t8(r), r;
}, u8 = ({ config: e, instructions: t }) => (n, r) => async (s) => {
	var c, d, f;
	e.isCustomEndpoint && HI(r, "ENDPOINT_OVERRIDE", "N");
	const o = await Rw(s.input, { getEndpointParameterInstructions() {
		return t;
	} }, { ...e }, r);
	r.endpointV2 = o, r.authSchemes = (c = o.properties) == null ? void 0 : c.authSchemes;
	const u = (d = r.authSchemes) == null ? void 0 : d[0];
	if (u) {
		r.signing_region = u.signingRegion, r.signing_service = u.signingName;
		const m = Ci(r), y = (f = m == null ? void 0 : m.selectedHttpAuthScheme) == null ? void 0 : f.httpAuthOption;
		y && (y.signingProperties = Object.assign(y.signingProperties || {}, {
			signing_region: u.signingRegion,
			signingRegion: u.signingRegion,
			signing_service: u.signingName,
			signingName: u.signingName,
			signingRegionSet: u.signingRegionSet
		}, u.properties));
	}
	return n({ ...s });
}, c8 = {
	step: "serialize",
	tags: [
		"ENDPOINT_PARAMETERS",
		"ENDPOINT_V2",
		"ENDPOINT"
	],
	name: "endpointV2Middleware",
	override: !0,
	relation: "before",
	toMiddleware: JB.name
}, Pw = (e, t) => ({ applyToStack: (n) => {
	n.addRelativeTo(u8({
		config: e,
		instructions: t
	}), c8);
} }), l8 = (e) => {
	const t = e.tls ?? !0, { endpoint: n, useDualstackEndpoint: r, useFipsEndpoint: s } = e, o = n != null ? async () => kw(await or(n)()) : void 0, c = Object.assign(e, {
		endpoint: o,
		tls: t,
		isCustomEndpoint: !!n,
		useDualstackEndpoint: or(r ?? !1),
		useFipsEndpoint: or(s ?? !1)
	});
	let d;
	return c.serviceConfiguredEndpoint = async () => (e.serviceId && !d && (d = Iw(e.serviceId)), d), c;
};
var Ps;
(function(e) {
	e.STANDARD = "standard", e.ADAPTIVE = "adaptive";
})(Ps || (Ps = {}));
const du = 3, f8 = Ps.STANDARD, d8 = [
	"BandwidthLimitExceeded",
	"EC2ThrottledException",
	"LimitExceededException",
	"PriorRequestNotComplete",
	"ProvisionedThroughputExceededException",
	"RequestLimitExceeded",
	"RequestThrottled",
	"RequestThrottledException",
	"SlowDown",
	"ThrottledException",
	"Throttling",
	"ThrottlingException",
	"TooManyRequestsException",
	"TransactionInProgressException"
], h8 = [
	"TimeoutError",
	"RequestTimeout",
	"RequestTimeoutException"
], p8 = [
	500,
	502,
	503,
	504
], g8 = [
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"ETIMEDOUT"
], m8 = [
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND"
], y8 = (e) => (e == null ? void 0 : e.$retryable) !== void 0, D8 = (e) => {
	var t;
	return (t = e.$metadata) == null ? void 0 : t.clockSkewCorrected;
}, w8 = (e) => {
	const t = /* @__PURE__ */ new Set([
		"Failed to fetch",
		"NetworkError when attempting to fetch resource",
		"The Internet connection appears to be offline",
		"Load failed",
		"Network request failed"
	]);
	return e && e instanceof TypeError ? t.has(e.message) : !1;
}, Nw = (e) => {
	var t, n;
	return ((t = e.$metadata) == null ? void 0 : t.httpStatusCode) === 429 || d8.includes(e.name) || ((n = e.$retryable) == null ? void 0 : n.throttling) == !0;
}, Rd = (e, t = 0) => {
	var n;
	return y8(e) || D8(e) || h8.includes(e.name) || g8.includes((e == null ? void 0 : e.code) || "") || m8.includes((e == null ? void 0 : e.code) || "") || p8.includes(((n = e.$metadata) == null ? void 0 : n.httpStatusCode) || 0) || w8(e) || e.cause !== void 0 && t <= 10 && Rd(e.cause, t + 1);
}, b8 = (e) => {
	var t;
	if (((t = e.$metadata) == null ? void 0 : t.httpStatusCode) !== void 0) {
		const n = e.$metadata.httpStatusCode;
		return 500 <= n && n <= 599 && !Rd(e);
	}
	return !1;
}, wu = class wu {
	constructor(t) {
		P(this, "beta");
		P(this, "minCapacity");
		P(this, "minFillRate");
		P(this, "scaleConstant");
		P(this, "smooth");
		P(this, "currentCapacity", 0);
		P(this, "enabled", !1);
		P(this, "lastMaxRate", 0);
		P(this, "measuredTxRate", 0);
		P(this, "requestCount", 0);
		P(this, "fillRate");
		P(this, "lastThrottleTime");
		P(this, "lastTimestamp", 0);
		P(this, "lastTxRateBucket");
		P(this, "maxCapacity");
		P(this, "timeWindow", 0);
		this.beta = (t == null ? void 0 : t.beta) ?? .7, this.minCapacity = (t == null ? void 0 : t.minCapacity) ?? 1, this.minFillRate = (t == null ? void 0 : t.minFillRate) ?? .5, this.scaleConstant = (t == null ? void 0 : t.scaleConstant) ?? .4, this.smooth = (t == null ? void 0 : t.smooth) ?? .8;
		this.lastThrottleTime = this.getCurrentTimeInSeconds(), this.lastTxRateBucket = Math.floor(this.getCurrentTimeInSeconds()), this.fillRate = this.minFillRate, this.maxCapacity = this.minCapacity;
	}
	getCurrentTimeInSeconds() {
		return Date.now() / 1e3;
	}
	async getSendToken() {
		return this.acquireTokenBucket(1);
	}
	async acquireTokenBucket(t) {
		if (this.enabled) {
			if (this.refillTokenBucket(), t > this.currentCapacity) {
				const n = (t - this.currentCapacity) / this.fillRate * 1e3;
				await new Promise((r) => wu.setTimeoutFn(r, n));
			}
			this.currentCapacity = this.currentCapacity - t;
		}
	}
	refillTokenBucket() {
		const t = this.getCurrentTimeInSeconds();
		if (!this.lastTimestamp) {
			this.lastTimestamp = t;
			return;
		}
		const n = (t - this.lastTimestamp) * this.fillRate;
		this.currentCapacity = Math.min(this.maxCapacity, this.currentCapacity + n), this.lastTimestamp = t;
	}
	updateClientSendingRate(t) {
		let n;
		if (this.updateMeasuredRate(), Nw(t)) {
			const s = this.enabled ? Math.min(this.measuredTxRate, this.fillRate) : this.measuredTxRate;
			this.lastMaxRate = s, this.calculateTimeWindow(), this.lastThrottleTime = this.getCurrentTimeInSeconds(), n = this.cubicThrottle(s), this.enableTokenBucket();
		} else this.calculateTimeWindow(), n = this.cubicSuccess(this.getCurrentTimeInSeconds());
		const r = Math.min(n, 2 * this.measuredTxRate);
		this.updateTokenBucketRate(r);
	}
	calculateTimeWindow() {
		this.timeWindow = this.getPrecise(Math.pow(this.lastMaxRate * (1 - this.beta) / this.scaleConstant, 1 / 3));
	}
	cubicThrottle(t) {
		return this.getPrecise(t * this.beta);
	}
	cubicSuccess(t) {
		return this.getPrecise(this.scaleConstant * Math.pow(t - this.lastThrottleTime - this.timeWindow, 3) + this.lastMaxRate);
	}
	enableTokenBucket() {
		this.enabled = !0;
	}
	updateTokenBucketRate(t) {
		this.refillTokenBucket(), this.fillRate = Math.max(t, this.minFillRate), this.maxCapacity = Math.max(t, this.minCapacity), this.currentCapacity = Math.min(this.currentCapacity, this.maxCapacity);
	}
	updateMeasuredRate() {
		const t = this.getCurrentTimeInSeconds(), n = Math.floor(t * 2) / 2;
		if (this.requestCount++, n > this.lastTxRateBucket) {
			const r = this.requestCount / (n - this.lastTxRateBucket);
			this.measuredTxRate = this.getPrecise(r * this.smooth + this.measuredTxRate * (1 - this.smooth)), this.requestCount = 0, this.lastTxRateBucket = n;
		}
	}
	getPrecise(t) {
		return parseFloat(t.toFixed(8));
	}
};
P(wu, "setTimeoutFn", setTimeout);
let Hf = wu;
const qf = 100, Ow = 20 * 1e3, E8 = 500, N0 = 500, v8 = 5, S8 = 10, C8 = 1, x8 = "amz-sdk-invocation-id", F8 = "amz-sdk-request", A8 = () => {
	let e = qf;
	return {
		computeNextBackoffDelay: (r) => Math.floor(Math.min(Ow, Math.random() * 2 ** r * e)),
		setDelayBase: (r) => {
			e = r;
		}
	};
}, O0 = ({ retryDelay: e, retryCount: t, retryCost: n }) => ({
	getRetryCount: () => t,
	getRetryDelay: () => Math.min(Ow, e),
	getRetryCost: () => n
});
var Uw = class {
	constructor(t) {
		P(this, "maxAttempts");
		P(this, "mode", Ps.STANDARD);
		P(this, "capacity", N0);
		P(this, "retryBackoffStrategy", A8());
		P(this, "maxAttemptsProvider");
		this.maxAttempts = t, this.maxAttemptsProvider = typeof t == "function" ? t : async () => t;
	}
	async acquireInitialRetryToken(t) {
		return O0({
			retryDelay: qf,
			retryCount: 0
		});
	}
	async refreshRetryTokenForRetry(t, n) {
		const r = await this.getMaxAttempts();
		if (this.shouldRetry(t, n, r)) {
			const s = n.errorType;
			this.retryBackoffStrategy.setDelayBase(s === "THROTTLING" ? E8 : qf);
			const o = this.retryBackoffStrategy.computeNextBackoffDelay(t.getRetryCount()), u = n.retryAfterHint ? Math.max(n.retryAfterHint.getTime() - Date.now() || 0, o) : o, c = this.getCapacityCost(s);
			return this.capacity -= c, O0({
				retryDelay: u,
				retryCount: t.getRetryCount() + 1,
				retryCost: c
			});
		}
		throw new Error("No retry token available");
	}
	recordSuccess(t) {
		this.capacity = Math.max(N0, this.capacity + (t.getRetryCost() ?? C8));
	}
	getCapacity() {
		return this.capacity;
	}
	async getMaxAttempts() {
		try {
			return await this.maxAttemptsProvider();
		} catch {
			return console.warn(`Max attempts provider could not resolve. Using default of ${du}`), du;
		}
	}
	shouldRetry(t, n, r) {
		return t.getRetryCount() + 1 < r && this.capacity >= this.getCapacityCost(n.errorType) && this.isRetryableError(n.errorType);
	}
	getCapacityCost(t) {
		return t === "TRANSIENT" ? S8 : v8;
	}
	isRetryableError(t) {
		return t === "THROTTLING" || t === "TRANSIENT";
	}
};
var _8 = class {
	constructor(t, n) {
		P(this, "maxAttemptsProvider");
		P(this, "rateLimiter");
		P(this, "standardRetryStrategy");
		P(this, "mode", Ps.ADAPTIVE);
		this.maxAttemptsProvider = t;
		const { rateLimiter: r } = n ?? {};
		this.rateLimiter = r ?? new Hf(), this.standardRetryStrategy = new Uw(t);
	}
	async acquireInitialRetryToken(t) {
		return await this.rateLimiter.getSendToken(), this.standardRetryStrategy.acquireInitialRetryToken(t);
	}
	async refreshRetryTokenForRetry(t, n) {
		return this.rateLimiter.updateClientSendingRate(n), this.standardRetryStrategy.refreshRetryTokenForRetry(t, n);
	}
	recordSuccess(t) {
		this.rateLimiter.updateClientSendingRate({}), this.standardRetryStrategy.recordSuccess(t);
	}
};
const B8 = (e) => e instanceof Error ? e : e instanceof Object ? Object.assign(/* @__PURE__ */ new Error(), e) : typeof e == "string" ? new Error(e) : /* @__PURE__ */ new Error(`AWS SDK error wrapper for ${e}`), I8 = (e) => {
	const { retryStrategy: t, retryMode: n, maxAttempts: r } = e, s = or(r ?? du);
	return Object.assign(e, {
		maxAttempts: s,
		retryStrategy: async () => t || (await or(n)() === Ps.ADAPTIVE ? new _8(s) : new Uw(s))
	});
}, k8 = (e) => (e == null ? void 0 : e.body) instanceof ReadableStream, R8 = (e) => (t, n) => async (r) => {
	var u;
	let s = await e.retryStrategy();
	const o = await e.maxAttempts();
	if (T8(s)) {
		s = s;
		let c = await s.acquireInitialRetryToken(n.partition_id), d = /* @__PURE__ */ new Error(), f = 0, m = 0;
		const { request: y } = r, w = bt.isInstance(y);
		for (w && (y.headers[x8] = wd());;) try {
			w && (y.headers[F8] = `attempt=${f + 1}; max=${o}`);
			const { response: E, output: A } = await t(r);
			return s.recordSuccess(c), A.$metadata.attempts = f + 1, A.$metadata.totalRetryDelay = m, {
				response: E,
				output: A
			};
		} catch (E) {
			const A = P8(E);
			if (d = B8(E), w && k8(y)) throw (u = n.logger instanceof xd ? console : n.logger) == null || u.warn("An error was encountered in a non-retryable streaming request."), d;
			try {
				c = await s.refreshRetryTokenForRetry(c, A);
			} catch {
				throw d.$metadata || (d.$metadata = {}), d.$metadata.attempts = f + 1, d.$metadata.totalRetryDelay = m, d;
			}
			f = c.getRetryCount();
			const B = c.getRetryDelay();
			m += B, await new Promise((T) => setTimeout(T, B));
		}
	} else return s = s, s != null && s.mode && (n.userAgent = [...n.userAgent || [], ["cfg/retry-mode", s.mode]]), s.retry(t, r);
}, T8 = (e) => typeof e.acquireInitialRetryToken < "u" && typeof e.refreshRetryTokenForRetry < "u" && typeof e.recordSuccess < "u", P8 = (e) => {
	const t = {
		error: e,
		errorType: N8(e)
	}, n = M8(e.$response);
	return n && (t.retryAfterHint = n), t;
}, N8 = (e) => Nw(e) ? "THROTTLING" : Rd(e) ? "TRANSIENT" : b8(e) ? "SERVER_ERROR" : "CLIENT_ERROR", O8 = {
	name: "retryMiddleware",
	tags: ["RETRY"],
	step: "finalizeRequest",
	priority: "high",
	override: !0
}, U8 = (e) => ({ applyToStack: (t) => {
	t.add(R8(e), O8);
} }), M8 = (e) => {
	if (!qi.isInstance(e)) return;
	const t = Object.keys(e.headers).find((o) => o.toLowerCase() === "retry-after");
	if (!t) return;
	const n = e.headers[t], r = Number(n);
	return Number.isNaN(r) ? new Date(n) : /* @__PURE__ */ new Date(r * 1e3);
};
var Td = class {
	constructor(t) {
		P(this, "sigv4aSigner");
		P(this, "sigv4Signer");
		P(this, "signerOptions");
		this.sigv4Signer = new $R(t), this.signerOptions = t;
	}
	static sigv4aDependency() {
		return "none";
	}
	async sign(t, n = {}) {
		return n.signingRegion === "*" ? this.getSigv4aSigner().sign(t, n) : this.sigv4Signer.sign(t, n);
	}
	async signWithCredentials(t, n, r = {}) {
		if (r.signingRegion === "*") throw this.getSigv4aSigner(), /* @__PURE__ */ new Error(`signWithCredentials with signingRegion '*' is only supported when using the CRT dependency @aws-sdk/signature-v4-crt. Please check whether you have installed the "@aws-sdk/signature-v4-crt" package explicitly. You must also register the package by calling [require("@aws-sdk/signature-v4-crt");] or an ESM equivalent such as [import "@aws-sdk/signature-v4-crt";]. For more information please go to https://github.com/aws/aws-sdk-js-v3#functionality-requiring-aws-common-runtime-crt`);
		return this.sigv4Signer.signWithCredentials(t, n, r);
	}
	async presign(t, n = {}) {
		if (n.signingRegion === "*") throw this.getSigv4aSigner(), /* @__PURE__ */ new Error(`presign with signingRegion '*' is only supported when using the CRT dependency @aws-sdk/signature-v4-crt. Please check whether you have installed the "@aws-sdk/signature-v4-crt" package explicitly. You must also register the package by calling [require("@aws-sdk/signature-v4-crt");] or an ESM equivalent such as [import "@aws-sdk/signature-v4-crt";]. For more information please go to https://github.com/aws/aws-sdk-js-v3#functionality-requiring-aws-common-runtime-crt`);
		return this.sigv4Signer.presign(t, n);
	}
	async presignWithCredentials(t, n, r = {}) {
		if (r.signingRegion === "*") throw new Error("Method presignWithCredentials is not supported for [signingRegion=*].");
		return this.sigv4Signer.presignWithCredentials(t, n, r);
	}
	getSigv4aSigner() {
		if (!this.sigv4aSigner) throw this.signerOptions.runtime === "node" ? /* @__PURE__ */ new Error("Neither CRT nor JS SigV4a implementation is available. Please load either @aws-sdk/signature-v4-crt or @aws-sdk/signature-v4a. For more information please go to https://github.com/aws/aws-sdk-js-v3#functionality-requiring-aws-common-runtime-crt") : /* @__PURE__ */ new Error("JS SigV4a implementation is not available or not a valid constructor. Please check whether you have installed the @aws-sdk/signature-v4a package explicitly. The CRT implementation is not available for browsers. You must also register the package by calling [require('@aws-sdk/signature-v4a');] or an ESM equivalent such as [import '@aws-sdk/signature-v4a';]. For more information please go to https://github.com/aws/aws-sdk-js-v3#using-javascript-non-crt-implementation-of-sigv4a");
		return this.sigv4aSigner;
	}
};
const Mw = (e, t = !1) => {
	if (t) {
		for (const n of e.split(".")) if (!Mw(n)) return !1;
		return !0;
	}
	return !(!Lo(e) || e.length < 3 || e.length > 63 || e !== e.toLowerCase() || Id(e));
}, U0 = ":", $8 = "/", L8 = (e) => {
	const t = e.split(U0);
	if (t.length < 6) return null;
	const [n, r, s, o, u, ...c] = t;
	if (n !== "arn" || r === "" || s === "" || c.join(U0) === "") return null;
	return {
		partition: r,
		service: s,
		region: o,
		accountId: u,
		resourceId: c.map((f) => f.split($8)).flat()
	};
};
let q8 = { partitions: [
	{
		id: "aws",
		outputs: {
			dnsSuffix: "amazonaws.com",
			dualStackDnsSuffix: "api.aws",
			implicitGlobalRegion: "us-east-1",
			name: "aws",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^(us|eu|ap|sa|ca|me|af|il|mx)\\-\\w+\\-\\d+$",
		regions: {
			"af-south-1": { description: "Africa (Cape Town)" },
			"ap-east-1": { description: "Asia Pacific (Hong Kong)" },
			"ap-east-2": { description: "Asia Pacific (Taipei)" },
			"ap-northeast-1": { description: "Asia Pacific (Tokyo)" },
			"ap-northeast-2": { description: "Asia Pacific (Seoul)" },
			"ap-northeast-3": { description: "Asia Pacific (Osaka)" },
			"ap-south-1": { description: "Asia Pacific (Mumbai)" },
			"ap-south-2": { description: "Asia Pacific (Hyderabad)" },
			"ap-southeast-1": { description: "Asia Pacific (Singapore)" },
			"ap-southeast-2": { description: "Asia Pacific (Sydney)" },
			"ap-southeast-3": { description: "Asia Pacific (Jakarta)" },
			"ap-southeast-4": { description: "Asia Pacific (Melbourne)" },
			"ap-southeast-5": { description: "Asia Pacific (Malaysia)" },
			"ap-southeast-6": { description: "Asia Pacific (New Zealand)" },
			"ap-southeast-7": { description: "Asia Pacific (Thailand)" },
			"aws-global": { description: "aws global region" },
			"ca-central-1": { description: "Canada (Central)" },
			"ca-west-1": { description: "Canada West (Calgary)" },
			"eu-central-1": { description: "Europe (Frankfurt)" },
			"eu-central-2": { description: "Europe (Zurich)" },
			"eu-north-1": { description: "Europe (Stockholm)" },
			"eu-south-1": { description: "Europe (Milan)" },
			"eu-south-2": { description: "Europe (Spain)" },
			"eu-west-1": { description: "Europe (Ireland)" },
			"eu-west-2": { description: "Europe (London)" },
			"eu-west-3": { description: "Europe (Paris)" },
			"il-central-1": { description: "Israel (Tel Aviv)" },
			"me-central-1": { description: "Middle East (UAE)" },
			"me-south-1": { description: "Middle East (Bahrain)" },
			"mx-central-1": { description: "Mexico (Central)" },
			"sa-east-1": { description: "South America (Sao Paulo)" },
			"us-east-1": { description: "US East (N. Virginia)" },
			"us-east-2": { description: "US East (Ohio)" },
			"us-west-1": { description: "US West (N. California)" },
			"us-west-2": { description: "US West (Oregon)" }
		}
	},
	{
		id: "aws-cn",
		outputs: {
			dnsSuffix: "amazonaws.com.cn",
			dualStackDnsSuffix: "api.amazonwebservices.com.cn",
			implicitGlobalRegion: "cn-northwest-1",
			name: "aws-cn",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^cn\\-\\w+\\-\\d+$",
		regions: {
			"aws-cn-global": { description: "aws-cn global region" },
			"cn-north-1": { description: "China (Beijing)" },
			"cn-northwest-1": { description: "China (Ningxia)" }
		}
	},
	{
		id: "aws-eusc",
		outputs: {
			dnsSuffix: "amazonaws.eu",
			dualStackDnsSuffix: "api.amazonwebservices.eu",
			implicitGlobalRegion: "eusc-de-east-1",
			name: "aws-eusc",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^eusc\\-(de)\\-\\w+\\-\\d+$",
		regions: { "eusc-de-east-1": { description: "AWS European Sovereign Cloud (Germany)" } }
	},
	{
		id: "aws-iso",
		outputs: {
			dnsSuffix: "c2s.ic.gov",
			dualStackDnsSuffix: "api.aws.ic.gov",
			implicitGlobalRegion: "us-iso-east-1",
			name: "aws-iso",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^us\\-iso\\-\\w+\\-\\d+$",
		regions: {
			"aws-iso-global": { description: "aws-iso global region" },
			"us-iso-east-1": { description: "US ISO East" },
			"us-iso-west-1": { description: "US ISO WEST" }
		}
	},
	{
		id: "aws-iso-b",
		outputs: {
			dnsSuffix: "sc2s.sgov.gov",
			dualStackDnsSuffix: "api.aws.scloud",
			implicitGlobalRegion: "us-isob-east-1",
			name: "aws-iso-b",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^us\\-isob\\-\\w+\\-\\d+$",
		regions: {
			"aws-iso-b-global": { description: "aws-iso-b global region" },
			"us-isob-east-1": { description: "US ISOB East (Ohio)" },
			"us-isob-west-1": { description: "US ISOB West" }
		}
	},
	{
		id: "aws-iso-e",
		outputs: {
			dnsSuffix: "cloud.adc-e.uk",
			dualStackDnsSuffix: "api.cloud-aws.adc-e.uk",
			implicitGlobalRegion: "eu-isoe-west-1",
			name: "aws-iso-e",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^eu\\-isoe\\-\\w+\\-\\d+$",
		regions: {
			"aws-iso-e-global": { description: "aws-iso-e global region" },
			"eu-isoe-west-1": { description: "EU ISOE West" }
		}
	},
	{
		id: "aws-iso-f",
		outputs: {
			dnsSuffix: "csp.hci.ic.gov",
			dualStackDnsSuffix: "api.aws.hci.ic.gov",
			implicitGlobalRegion: "us-isof-south-1",
			name: "aws-iso-f",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^us\\-isof\\-\\w+\\-\\d+$",
		regions: {
			"aws-iso-f-global": { description: "aws-iso-f global region" },
			"us-isof-east-1": { description: "US ISOF EAST" },
			"us-isof-south-1": { description: "US ISOF SOUTH" }
		}
	},
	{
		id: "aws-us-gov",
		outputs: {
			dnsSuffix: "amazonaws.com",
			dualStackDnsSuffix: "api.aws",
			implicitGlobalRegion: "us-gov-west-1",
			name: "aws-us-gov",
			supportsDualStack: !0,
			supportsFIPS: !0
		},
		regionRegex: "^us\\-gov\\-\\w+\\-\\d+$",
		regions: {
			"aws-us-gov-global": { description: "aws-us-gov global region" },
			"us-gov-east-1": { description: "AWS GovCloud (US-East)" },
			"us-gov-west-1": { description: "AWS GovCloud (US-West)" }
		}
	}
] };
const j8 = (e) => {
	const { partitions: t } = q8;
	for (const r of t) {
		const { regions: s, outputs: o } = r;
		for (const [u, c] of Object.entries(s)) if (u === e) return {
			...o,
			...c
		};
	}
	for (const r of t) {
		const { regionRegex: s, outputs: o } = r;
		if (new RegExp(s).test(e)) return { ...o };
	}
	const n = t.find((r) => r.id === "aws");
	if (!n) throw new Error("Provided region was not found in the partition array or regex, and default partition with id 'aws' doesn't exist.");
	return { ...n.outputs };
}, $w = {
	isVirtualHostableS3Bucket: Mw,
	parseArn: L8,
	partition: j8
};
Po.aws = $w;
const Pd = "required", _ = "type", W = "rules", N = "conditions", L = "fn", z$1 = "argv", pe = "ref", Ae = "assign", re = "url", ie = "properties", Jr = "backend", $t = "authSchemes", At = "disableDoubleEncoding", _t = "signingName", Gt = "signingRegion", se = "headers", Nd = "signingRegionSet", G8 = 6, W8 = !1, Dr = !0, Un = "isSet", wt = "booleanEquals", ue = "error", hu = "aws.partition", Le = "stringEquals", ot = "getAttr", at = "name", Ye = "substring", M0 = "bucketSuffix", Od = "parseURL", X = "endpoint", K = "tree", pu = "aws.isVirtualHostableS3Bucket", gu = "{url#scheme}://{Bucket}.{url#authority}{url#path}", Ar = "not", $0 = "accessPointSuffix", Va = "{url#scheme}://{url#authority}{url#path}", Lw = "hardwareType", zw = "regionPrefix", L0 = "bucketAliasSuffix", jf = "outpostId", Vi = "isValidHostLabel", Ud = "sigv4a", Oo = "s3-outposts", Ns = "s3", Hw = "{url#scheme}://{url#authority}{url#normalizedPath}{Bucket}", qw = "https://{Bucket}.s3-accelerate.{partitionResult#dnsSuffix}", z0 = "https://{Bucket}.s3.{partitionResult#dnsSuffix}", jw = "aws.parseArn", Gw = "bucketArn", Ww = "arnType", mu = "", Md = "s3-object-lambda", Kw = "accesspoint", $d = "accessPointName", H0 = "{url#scheme}://{accessPointName}-{bucketArn#accountId}.{url#authority}{url#path}", q0 = "mrapPartition", j0 = "outpostType", G0 = "arnPrefix", Vw = "{url#scheme}://{url#authority}{url#normalizedPath}{uri_encoded_bucket}", W0 = "https://s3.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", K0 = "https://s3.{partitionResult#dnsSuffix}", hs = {
	[Pd]: !1,
	[_]: "string"
}, ps = {
	[Pd]: !0,
	default: !1,
	[_]: "boolean"
}, lo = {
	[Pd]: !1,
	[_]: "boolean"
}, Zn = {
	[L]: wt,
	[z$1]: [{ [pe]: "Accelerate" }, !0]
}, tt = {
	[L]: wt,
	[z$1]: [{ [pe]: "UseFIPS" }, !0]
}, Ze = {
	[L]: wt,
	[z$1]: [{ [pe]: "UseDualStack" }, !0]
}, pt = {
	[L]: Un,
	[z$1]: [{ [pe]: "Endpoint" }]
}, Zw = {
	[L]: hu,
	[z$1]: [{ [pe]: "Region" }],
	[Ae]: "partitionResult"
}, V0 = {
	[L]: Le,
	[z$1]: [{
		[L]: ot,
		[z$1]: [{ [pe]: "partitionResult" }, at]
	}, "aws-cn"]
}, wo = {
	[L]: Un,
	[z$1]: [{ [pe]: "Bucket" }]
}, $e = { [pe]: "Bucket" }, Z0 = {
	[N]: [Zn],
	[ue]: "S3Express does not support S3 Accelerate.",
	[_]: ue
}, J0 = {
	[N]: [pt, {
		[L]: Od,
		[z$1]: [{ [pe]: "Endpoint" }],
		[Ae]: "url"
	}],
	[W]: [
		{
			[N]: [{
				[L]: Un,
				[z$1]: [{ [pe]: "DisableS3ExpressSessionAuth" }]
			}, {
				[L]: wt,
				[z$1]: [{ [pe]: "DisableS3ExpressSessionAuth" }, !0]
			}],
			[W]: [
				{
					[N]: [{
						[L]: wt,
						[z$1]: [{
							[L]: ot,
							[z$1]: [{ [pe]: "url" }, "isIp"]
						}, !0]
					}],
					[W]: [{
						[N]: [{
							[L]: "uriEncode",
							[z$1]: [$e],
							[Ae]: "uri_encoded_bucket"
						}],
						[W]: [{
							[X]: {
								[re]: "{url#scheme}://{url#authority}/{uri_encoded_bucket}{url#path}",
								[ie]: {
									[Jr]: "S3Express",
									[$t]: [{
										[At]: !0,
										[at]: "sigv4",
										[_t]: "s3express",
										[Gt]: "{Region}"
									}]
								},
								[se]: {}
							},
							[_]: X
						}],
						[_]: K
					}],
					[_]: K
				},
				{
					[N]: [{
						[L]: pu,
						[z$1]: [$e, !1]
					}],
					[W]: [{
						[X]: {
							[re]: gu,
							[ie]: {
								[Jr]: "S3Express",
								[$t]: [{
									[At]: !0,
									[at]: "sigv4",
									[_t]: "s3express",
									[Gt]: "{Region}"
								}]
							},
							[se]: {}
						},
						[_]: X
					}],
					[_]: K
				},
				{
					[ue]: "S3Express bucket name is not a valid virtual hostable name.",
					[_]: ue
				}
			],
			[_]: K
		},
		{
			[N]: [{
				[L]: wt,
				[z$1]: [{
					[L]: ot,
					[z$1]: [{ [pe]: "url" }, "isIp"]
				}, !0]
			}],
			[W]: [{
				[N]: [{
					[L]: "uriEncode",
					[z$1]: [$e],
					[Ae]: "uri_encoded_bucket"
				}],
				[W]: [{
					[X]: {
						[re]: "{url#scheme}://{url#authority}/{uri_encoded_bucket}{url#path}",
						[ie]: {
							[Jr]: "S3Express",
							[$t]: [{
								[At]: !0,
								[at]: "sigv4-s3express",
								[_t]: "s3express",
								[Gt]: "{Region}"
							}]
						},
						[se]: {}
					},
					[_]: X
				}],
				[_]: K
			}],
			[_]: K
		},
		{
			[N]: [{
				[L]: pu,
				[z$1]: [$e, !1]
			}],
			[W]: [{
				[X]: {
					[re]: gu,
					[ie]: {
						[Jr]: "S3Express",
						[$t]: [{
							[At]: !0,
							[at]: "sigv4-s3express",
							[_t]: "s3express",
							[Gt]: "{Region}"
						}]
					},
					[se]: {}
				},
				[_]: X
			}],
			[_]: K
		},
		{
			[ue]: "S3Express bucket name is not a valid virtual hostable name.",
			[_]: ue
		}
	],
	[_]: K
}, cn = {
	[L]: Od,
	[z$1]: [{ [pe]: "Endpoint" }],
	[Ae]: "url"
}, xl = {
	[L]: wt,
	[z$1]: [{
		[L]: ot,
		[z$1]: [{ [pe]: "url" }, "isIp"]
	}, !0]
}, Jw = { [pe]: "url" }, Xw = {
	[L]: "uriEncode",
	[z$1]: [$e],
	[Ae]: "uri_encoded_bucket"
}, Nn = {
	[Jr]: "S3Express",
	[$t]: [{
		[At]: !0,
		[at]: "sigv4",
		[_t]: "s3express",
		[Gt]: "{Region}"
	}]
}, Se = {}, Yw = {
	[L]: pu,
	[z$1]: [$e, !1]
}, X0 = {
	[ue]: "S3Express bucket name is not a valid virtual hostable name.",
	[_]: ue
}, Y0 = {
	[L]: Un,
	[z$1]: [{ [pe]: "UseS3ExpressControlEndpoint" }]
}, Q0 = {
	[L]: wt,
	[z$1]: [{ [pe]: "UseS3ExpressControlEndpoint" }, !0]
}, xe = {
	[L]: Ar,
	[z$1]: [pt]
}, Ne = {
	[L]: wt,
	[z$1]: [{ [pe]: "UseDualStack" }, !1]
}, Re = {
	[L]: wt,
	[z$1]: [{ [pe]: "UseFIPS" }, !1]
}, Ha = {
	[ue]: "Unrecognized S3Express bucket name format.",
	[_]: ue
}, em = {
	[L]: Ar,
	[z$1]: [wo]
}, tm = { [pe]: Lw }, nm = {
	[N]: [xe],
	[ue]: "Expected a endpoint to be specified but no endpoint was found",
	[_]: ue
}, qa = { [$t]: [{
	[At]: !0,
	[at]: Ud,
	[_t]: Oo,
	[Nd]: ["*"]
}, {
	[At]: !0,
	[at]: "sigv4",
	[_t]: Oo,
	[Gt]: "{Region}"
}] }, Fl = {
	[L]: wt,
	[z$1]: [{ [pe]: "ForcePathStyle" }, !1]
}, K8 = { [pe]: "ForcePathStyle" }, xt = {
	[L]: wt,
	[z$1]: [{ [pe]: "Accelerate" }, !1]
}, Pt = {
	[L]: Le,
	[z$1]: [{ [pe]: "Region" }, "aws-global"]
}, Ot = { [$t]: [{
	[At]: !0,
	[at]: "sigv4",
	[_t]: Ns,
	[Gt]: "us-east-1"
}] }, Ue = {
	[L]: Ar,
	[z$1]: [Pt]
}, Ut = {
	[L]: wt,
	[z$1]: [{ [pe]: "UseGlobalEndpoint" }, !0]
}, rm$1 = {
	[re]: "https://{Bucket}.s3-fips.dualstack.{Region}.{partitionResult#dnsSuffix}",
	[ie]: { [$t]: [{
		[At]: !0,
		[at]: "sigv4",
		[_t]: Ns,
		[Gt]: "{Region}"
	}] },
	[se]: {}
}, Bt = { [$t]: [{
	[At]: !0,
	[at]: "sigv4",
	[_t]: Ns,
	[Gt]: "{Region}"
}] }, Mt = {
	[L]: wt,
	[z$1]: [{ [pe]: "UseGlobalEndpoint" }, !1]
}, im = {
	[re]: "https://{Bucket}.s3-fips.{Region}.{partitionResult#dnsSuffix}",
	[ie]: Bt,
	[se]: {}
}, sm = {
	[re]: "https://{Bucket}.s3-accelerate.dualstack.{partitionResult#dnsSuffix}",
	[ie]: Bt,
	[se]: {}
}, om = {
	[re]: "https://{Bucket}.s3.dualstack.{Region}.{partitionResult#dnsSuffix}",
	[ie]: Bt,
	[se]: {}
}, Al = {
	[L]: wt,
	[z$1]: [{
		[L]: ot,
		[z$1]: [Jw, "isIp"]
	}, !1]
}, _l = {
	[re]: Hw,
	[ie]: Bt,
	[se]: {}
}, Gf = {
	[re]: gu,
	[ie]: Bt,
	[se]: {}
}, am = {
	[X]: Gf,
	[_]: X
}, Bl = {
	[re]: qw,
	[ie]: Bt,
	[se]: {}
}, um = {
	[re]: "https://{Bucket}.s3.{Region}.{partitionResult#dnsSuffix}",
	[ie]: Bt,
	[se]: {}
}, ja = {
	[ue]: "Invalid region: region was not a valid DNS name.",
	[_]: ue
}, Sn = { [pe]: Gw }, Qw = { [pe]: Ww }, Il = {
	[L]: ot,
	[z$1]: [Sn, "service"]
}, Ld = { [pe]: $d }, cm = {
	[N]: [Ze],
	[ue]: "S3 Object Lambda does not support Dual-stack",
	[_]: ue
}, lm = {
	[N]: [Zn],
	[ue]: "S3 Object Lambda does not support S3 Accelerate",
	[_]: ue
}, fm = {
	[N]: [{
		[L]: Un,
		[z$1]: [{ [pe]: "DisableAccessPoints" }]
	}, {
		[L]: wt,
		[z$1]: [{ [pe]: "DisableAccessPoints" }, !0]
	}],
	[ue]: "Access points are not supported for this operation",
	[_]: ue
}, kl = {
	[N]: [
		{
			[L]: Un,
			[z$1]: [{ [pe]: "UseArnRegion" }]
		},
		{
			[L]: wt,
			[z$1]: [{ [pe]: "UseArnRegion" }, !1]
		},
		{
			[L]: Ar,
			[z$1]: [{
				[L]: Le,
				[z$1]: [{
					[L]: ot,
					[z$1]: [Sn, "region"]
				}, "{Region}"]
			}]
		}
	],
	[ue]: "Invalid configuration: region from ARN `{bucketArn#region}` does not match client region `{Region}` and UseArnRegion is `false`",
	[_]: ue
}, eb = {
	[L]: ot,
	[z$1]: [{ [pe]: "bucketPartition" }, at]
}, tb = {
	[L]: ot,
	[z$1]: [Sn, "accountId"]
}, Rl = { [$t]: [{
	[At]: !0,
	[at]: "sigv4",
	[_t]: Md,
	[Gt]: "{bucketArn#region}"
}] }, dm = {
	[ue]: "Invalid ARN: The access point name may only contain a-z, A-Z, 0-9 and `-`. Found: `{accessPointName}`",
	[_]: ue
}, Tl = {
	[ue]: "Invalid ARN: The account id may only contain a-z, A-Z, 0-9 and `-`. Found: `{bucketArn#accountId}`",
	[_]: ue
}, Pl = {
	[ue]: "Invalid region in ARN: `{bucketArn#region}` (invalid DNS name)",
	[_]: ue
}, Nl = {
	[ue]: "Client was configured for partition `{partitionResult#name}` but ARN (`{Bucket}`) has `{bucketPartition#name}`",
	[_]: ue
}, hm = {
	[ue]: "Invalid ARN: The ARN may only contain a single resource component after `accesspoint`.",
	[_]: ue
}, pm = {
	[ue]: "Invalid ARN: Expected a resource of the format `accesspoint:<accesspoint name>` but no name was provided",
	[_]: ue
}, fo = { [$t]: [{
	[At]: !0,
	[at]: "sigv4",
	[_t]: Ns,
	[Gt]: "{bucketArn#region}"
}] }, gm = { [$t]: [{
	[At]: !0,
	[at]: Ud,
	[_t]: Oo,
	[Nd]: ["*"]
}, {
	[At]: !0,
	[at]: "sigv4",
	[_t]: Oo,
	[Gt]: "{bucketArn#region}"
}] }, mm = {
	[L]: jw,
	[z$1]: [$e]
}, ym = {
	[re]: "https://s3-fips.dualstack.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}",
	[ie]: Bt,
	[se]: {}
}, Dm = {
	[re]: "https://s3-fips.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}",
	[ie]: Bt,
	[se]: {}
}, wm = {
	[re]: "https://s3.dualstack.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}",
	[ie]: Bt,
	[se]: {}
}, Ol = {
	[re]: Vw,
	[ie]: Bt,
	[se]: {}
}, bm = {
	[re]: "https://s3.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}",
	[ie]: Bt,
	[se]: {}
}, Em = { [pe]: "UseObjectLambdaEndpoint" }, Ul = { [$t]: [{
	[At]: !0,
	[at]: "sigv4",
	[_t]: Md,
	[Gt]: "{Region}"
}] }, vm = {
	[re]: "https://s3-fips.dualstack.{Region}.{partitionResult#dnsSuffix}",
	[ie]: Bt,
	[se]: {}
}, Sm = {
	[re]: "https://s3-fips.{Region}.{partitionResult#dnsSuffix}",
	[ie]: Bt,
	[se]: {}
}, Cm = {
	[re]: "https://s3.dualstack.{Region}.{partitionResult#dnsSuffix}",
	[ie]: Bt,
	[se]: {}
}, Ml = {
	[re]: Va,
	[ie]: Bt,
	[se]: {}
}, xm = {
	[re]: "https://s3.{Region}.{partitionResult#dnsSuffix}",
	[ie]: Bt,
	[se]: {}
}, $l = [{ [pe]: "Region" }], V8 = [{ [pe]: "Endpoint" }], Z8 = [$e], Ll = [Zn], gs = [pt, cn], Fm = [{
	[L]: Un,
	[z$1]: [{ [pe]: "DisableS3ExpressSessionAuth" }]
}, {
	[L]: wt,
	[z$1]: [{ [pe]: "DisableS3ExpressSessionAuth" }, !0]
}], J8 = [Xw], zl = [Yw], Vn = [Zw], Hl = [tt, Ze], bo = [tt, Ne], Eo = [Re, Ze], vo = [Re, Ne], Am = [
	{
		[L]: Ye,
		[z$1]: [
			$e,
			6,
			14,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneId"
	},
	{
		[L]: Ye,
		[z$1]: [
			$e,
			14,
			16,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneDelim"
	},
	{
		[L]: Le,
		[z$1]: [{ [pe]: "s3expressAvailabilityZoneDelim" }, "--"]
	}
], wr = [
	{
		[N]: [tt, Ze],
		[X]: {
			[re]: "https://{Bucket}.s3express-fips-{s3expressAvailabilityZoneId}.dualstack.{Region}.{partitionResult#dnsSuffix}",
			[ie]: Nn,
			[se]: {}
		},
		[_]: X
	},
	{
		[N]: bo,
		[X]: {
			[re]: "https://{Bucket}.s3express-fips-{s3expressAvailabilityZoneId}.{Region}.{partitionResult#dnsSuffix}",
			[ie]: Nn,
			[se]: {}
		},
		[_]: X
	},
	{
		[N]: Eo,
		[X]: {
			[re]: "https://{Bucket}.s3express-{s3expressAvailabilityZoneId}.dualstack.{Region}.{partitionResult#dnsSuffix}",
			[ie]: Nn,
			[se]: {}
		},
		[_]: X
	},
	{
		[N]: vo,
		[X]: {
			[re]: "https://{Bucket}.s3express-{s3expressAvailabilityZoneId}.{Region}.{partitionResult#dnsSuffix}",
			[ie]: Nn,
			[se]: {}
		},
		[_]: X
	}
], _m = [
	{
		[L]: Ye,
		[z$1]: [
			$e,
			6,
			15,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneId"
	},
	{
		[L]: Ye,
		[z$1]: [
			$e,
			15,
			17,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneDelim"
	},
	{
		[L]: Le,
		[z$1]: [{ [pe]: "s3expressAvailabilityZoneDelim" }, "--"]
	}
], Bm = [
	{
		[L]: Ye,
		[z$1]: [
			$e,
			6,
			19,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneId"
	},
	{
		[L]: Ye,
		[z$1]: [
			$e,
			19,
			21,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneDelim"
	},
	{
		[L]: Le,
		[z$1]: [{ [pe]: "s3expressAvailabilityZoneDelim" }, "--"]
	}
], Im = [
	{
		[L]: Ye,
		[z$1]: [
			$e,
			6,
			20,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneId"
	},
	{
		[L]: Ye,
		[z$1]: [
			$e,
			20,
			22,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneDelim"
	},
	{
		[L]: Le,
		[z$1]: [{ [pe]: "s3expressAvailabilityZoneDelim" }, "--"]
	}
], km = [
	{
		[L]: Ye,
		[z$1]: [
			$e,
			6,
			26,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneId"
	},
	{
		[L]: Ye,
		[z$1]: [
			$e,
			26,
			28,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneDelim"
	},
	{
		[L]: Le,
		[z$1]: [{ [pe]: "s3expressAvailabilityZoneDelim" }, "--"]
	}
], br = [
	{
		[N]: [tt, Ze],
		[X]: {
			[re]: "https://{Bucket}.s3express-fips-{s3expressAvailabilityZoneId}.dualstack.{Region}.{partitionResult#dnsSuffix}",
			[ie]: {
				[Jr]: "S3Express",
				[$t]: [{
					[At]: !0,
					[at]: "sigv4-s3express",
					[_t]: "s3express",
					[Gt]: "{Region}"
				}]
			},
			[se]: {}
		},
		[_]: X
	},
	{
		[N]: bo,
		[X]: {
			[re]: "https://{Bucket}.s3express-fips-{s3expressAvailabilityZoneId}.{Region}.{partitionResult#dnsSuffix}",
			[ie]: {
				[Jr]: "S3Express",
				[$t]: [{
					[At]: !0,
					[at]: "sigv4-s3express",
					[_t]: "s3express",
					[Gt]: "{Region}"
				}]
			},
			[se]: {}
		},
		[_]: X
	},
	{
		[N]: Eo,
		[X]: {
			[re]: "https://{Bucket}.s3express-{s3expressAvailabilityZoneId}.dualstack.{Region}.{partitionResult#dnsSuffix}",
			[ie]: {
				[Jr]: "S3Express",
				[$t]: [{
					[At]: !0,
					[at]: "sigv4-s3express",
					[_t]: "s3express",
					[Gt]: "{Region}"
				}]
			},
			[se]: {}
		},
		[_]: X
	},
	{
		[N]: vo,
		[X]: {
			[re]: "https://{Bucket}.s3express-{s3expressAvailabilityZoneId}.{Region}.{partitionResult#dnsSuffix}",
			[ie]: {
				[Jr]: "S3Express",
				[$t]: [{
					[At]: !0,
					[at]: "sigv4-s3express",
					[_t]: "s3express",
					[Gt]: "{Region}"
				}]
			},
			[se]: {}
		},
		[_]: X
	}
], Rm = [
	$e,
	0,
	7,
	!0
], Tm = [
	{
		[L]: Ye,
		[z$1]: [
			$e,
			7,
			15,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneId"
	},
	{
		[L]: Ye,
		[z$1]: [
			$e,
			15,
			17,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneDelim"
	},
	{
		[L]: Le,
		[z$1]: [{ [pe]: "s3expressAvailabilityZoneDelim" }, "--"]
	}
], Pm = [
	{
		[L]: Ye,
		[z$1]: [
			$e,
			7,
			16,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneId"
	},
	{
		[L]: Ye,
		[z$1]: [
			$e,
			16,
			18,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneDelim"
	},
	{
		[L]: Le,
		[z$1]: [{ [pe]: "s3expressAvailabilityZoneDelim" }, "--"]
	}
], Nm = [
	{
		[L]: Ye,
		[z$1]: [
			$e,
			7,
			20,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneId"
	},
	{
		[L]: Ye,
		[z$1]: [
			$e,
			20,
			22,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneDelim"
	},
	{
		[L]: Le,
		[z$1]: [{ [pe]: "s3expressAvailabilityZoneDelim" }, "--"]
	}
], Om = [
	{
		[L]: Ye,
		[z$1]: [
			$e,
			7,
			21,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneId"
	},
	{
		[L]: Ye,
		[z$1]: [
			$e,
			21,
			23,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneDelim"
	},
	{
		[L]: Le,
		[z$1]: [{ [pe]: "s3expressAvailabilityZoneDelim" }, "--"]
	}
], Um = [
	{
		[L]: Ye,
		[z$1]: [
			$e,
			7,
			27,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneId"
	},
	{
		[L]: Ye,
		[z$1]: [
			$e,
			27,
			29,
			!0
		],
		[Ae]: "s3expressAvailabilityZoneDelim"
	},
	{
		[L]: Le,
		[z$1]: [{ [pe]: "s3expressAvailabilityZoneDelim" }, "--"]
	}
], X8 = [wo], Mm = [{
	[L]: Vi,
	[z$1]: [{ [pe]: jf }, !1]
}], $m = [{
	[L]: Le,
	[z$1]: [{ [pe]: zw }, "beta"]
}], Y8 = ["*"], Lm = [{
	[L]: Vi,
	[z$1]: [{ [pe]: "Region" }, !1]
}], hi = [{
	[L]: Le,
	[z$1]: [{ [pe]: "Region" }, "us-east-1"]
}], ql = [{
	[L]: Le,
	[z$1]: [Qw, Kw]
}], zm = [{
	[L]: ot,
	[z$1]: [Sn, "resourceId[1]"],
	[Ae]: $d
}, {
	[L]: Ar,
	[z$1]: [{
		[L]: Le,
		[z$1]: [Ld, mu]
	}]
}], Q8 = [Sn, "resourceId[1]"], Hm = [Ze], jl = [{
	[L]: Ar,
	[z$1]: [{
		[L]: Le,
		[z$1]: [{
			[L]: ot,
			[z$1]: [Sn, "region"]
		}, mu]
	}]
}], qm = [{
	[L]: Ar,
	[z$1]: [{
		[L]: Un,
		[z$1]: [{
			[L]: ot,
			[z$1]: [Sn, "resourceId[2]"]
		}]
	}]
}], e6 = [Sn, "resourceId[2]"], Gl = [{
	[L]: hu,
	[z$1]: [{
		[L]: ot,
		[z$1]: [Sn, "region"]
	}],
	[Ae]: "bucketPartition"
}], jm = [{
	[L]: Le,
	[z$1]: [eb, {
		[L]: ot,
		[z$1]: [{ [pe]: "partitionResult" }, at]
	}]
}], Wl = [{
	[L]: Vi,
	[z$1]: [{
		[L]: ot,
		[z$1]: [Sn, "region"]
	}, !0]
}], Kl = [{
	[L]: Vi,
	[z$1]: [tb, !1]
}], Gm = [{
	[L]: Vi,
	[z$1]: [Ld, !1]
}], Ga = [tt], Wm = [{
	[L]: Vi,
	[z$1]: [{ [pe]: "Region" }, !0]
}], n6 = {
	parameters: {
		Bucket: hs,
		Region: hs,
		UseFIPS: ps,
		UseDualStack: ps,
		Endpoint: hs,
		ForcePathStyle: ps,
		Accelerate: ps,
		UseGlobalEndpoint: ps,
		UseObjectLambdaEndpoint: lo,
		Key: hs,
		Prefix: hs,
		CopySource: hs,
		DisableAccessPoints: lo,
		DisableMultiRegionAccessPoints: ps,
		UseArnRegion: lo,
		UseS3ExpressControlEndpoint: lo,
		DisableS3ExpressSessionAuth: lo
	},
	[W]: [{
		[N]: [{
			[L]: Un,
			[z$1]: $l
		}],
		[W]: [
			{
				[N]: [Zn, tt],
				error: "Accelerate cannot be used with FIPS",
				[_]: ue
			},
			{
				[N]: [Ze, pt],
				error: "Cannot set dual-stack in combination with a custom endpoint.",
				[_]: ue
			},
			{
				[N]: [pt, tt],
				error: "A custom endpoint cannot be combined with FIPS",
				[_]: ue
			},
			{
				[N]: [pt, Zn],
				error: "A custom endpoint cannot be combined with S3 Accelerate",
				[_]: ue
			},
			{
				[N]: [
					tt,
					Zw,
					V0
				],
				error: "Partition does not support FIPS",
				[_]: ue
			},
			{
				[N]: [
					wo,
					{
						[L]: Ye,
						[z$1]: [
							$e,
							0,
							G8,
							Dr
						],
						[Ae]: M0
					},
					{
						[L]: Le,
						[z$1]: [{ [pe]: M0 }, "--x-s3"]
					}
				],
				[W]: [
					Z0,
					J0,
					{
						[N]: [Y0, Q0],
						[W]: [{
							[N]: Vn,
							[W]: [{
								[N]: [Xw, xe],
								[W]: [
									{
										[N]: Hl,
										endpoint: {
											[re]: "https://s3express-control-fips.dualstack.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}",
											[ie]: Nn,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: bo,
										endpoint: {
											[re]: "https://s3express-control-fips.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}",
											[ie]: Nn,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: Eo,
										endpoint: {
											[re]: "https://s3express-control.dualstack.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}",
											[ie]: Nn,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: vo,
										endpoint: {
											[re]: "https://s3express-control.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}",
											[ie]: Nn,
											[se]: Se
										},
										[_]: X
									}
								],
								[_]: K
							}],
							[_]: K
						}],
						[_]: K
					},
					{
						[N]: zl,
						[W]: [{
							[N]: Vn,
							[W]: [
								{
									[N]: Fm,
									[W]: [
										{
											[N]: Am,
											[W]: wr,
											[_]: K
										},
										{
											[N]: _m,
											[W]: wr,
											[_]: K
										},
										{
											[N]: Bm,
											[W]: wr,
											[_]: K
										},
										{
											[N]: Im,
											[W]: wr,
											[_]: K
										},
										{
											[N]: km,
											[W]: wr,
											[_]: K
										},
										Ha
									],
									[_]: K
								},
								{
									[N]: Am,
									[W]: br,
									[_]: K
								},
								{
									[N]: _m,
									[W]: br,
									[_]: K
								},
								{
									[N]: Bm,
									[W]: br,
									[_]: K
								},
								{
									[N]: Im,
									[W]: br,
									[_]: K
								},
								{
									[N]: km,
									[W]: br,
									[_]: K
								},
								Ha
							],
							[_]: K
						}],
						[_]: K
					},
					X0
				],
				[_]: K
			},
			{
				[N]: [
					wo,
					{
						[L]: Ye,
						[z$1]: Rm,
						[Ae]: $0
					},
					{
						[L]: Le,
						[z$1]: [{ [pe]: $0 }, "--xa-s3"]
					}
				],
				[W]: [
					Z0,
					J0,
					{
						[N]: zl,
						[W]: [{
							[N]: Vn,
							[W]: [
								{
									[N]: Fm,
									[W]: [
										{
											[N]: Tm,
											[W]: wr,
											[_]: K
										},
										{
											[N]: Pm,
											[W]: wr,
											[_]: K
										},
										{
											[N]: Nm,
											[W]: wr,
											[_]: K
										},
										{
											[N]: Om,
											[W]: wr,
											[_]: K
										},
										{
											[N]: Um,
											[W]: wr,
											[_]: K
										},
										Ha
									],
									[_]: K
								},
								{
									[N]: Tm,
									[W]: br,
									[_]: K
								},
								{
									[N]: Pm,
									[W]: br,
									[_]: K
								},
								{
									[N]: Nm,
									[W]: br,
									[_]: K
								},
								{
									[N]: Om,
									[W]: br,
									[_]: K
								},
								{
									[N]: Um,
									[W]: br,
									[_]: K
								},
								Ha
							],
							[_]: K
						}],
						[_]: K
					},
					X0
				],
				[_]: K
			},
			{
				[N]: [
					em,
					Y0,
					Q0
				],
				[W]: [{
					[N]: Vn,
					[W]: [
						{
							[N]: gs,
							endpoint: {
								[re]: Va,
								[ie]: Nn,
								[se]: Se
							},
							[_]: X
						},
						{
							[N]: Hl,
							endpoint: {
								[re]: "https://s3express-control-fips.dualstack.{Region}.{partitionResult#dnsSuffix}",
								[ie]: Nn,
								[se]: Se
							},
							[_]: X
						},
						{
							[N]: bo,
							endpoint: {
								[re]: "https://s3express-control-fips.{Region}.{partitionResult#dnsSuffix}",
								[ie]: Nn,
								[se]: Se
							},
							[_]: X
						},
						{
							[N]: Eo,
							endpoint: {
								[re]: "https://s3express-control.dualstack.{Region}.{partitionResult#dnsSuffix}",
								[ie]: Nn,
								[se]: Se
							},
							[_]: X
						},
						{
							[N]: vo,
							endpoint: {
								[re]: "https://s3express-control.{Region}.{partitionResult#dnsSuffix}",
								[ie]: Nn,
								[se]: Se
							},
							[_]: X
						}
					],
					[_]: K
				}],
				[_]: K
			},
			{
				[N]: [
					wo,
					{
						[L]: Ye,
						[z$1]: [
							$e,
							49,
							50,
							Dr
						],
						[Ae]: Lw
					},
					{
						[L]: Ye,
						[z$1]: [
							$e,
							8,
							12,
							Dr
						],
						[Ae]: zw
					},
					{
						[L]: Ye,
						[z$1]: Rm,
						[Ae]: L0
					},
					{
						[L]: Ye,
						[z$1]: [
							$e,
							32,
							49,
							Dr
						],
						[Ae]: jf
					},
					{
						[L]: hu,
						[z$1]: $l,
						[Ae]: "regionPartition"
					},
					{
						[L]: Le,
						[z$1]: [{ [pe]: L0 }, "--op-s3"]
					}
				],
				[W]: [{
					[N]: Mm,
					[W]: [{
						[N]: zl,
						[W]: [
							{
								[N]: [{
									[L]: Le,
									[z$1]: [tm, "e"]
								}],
								[W]: [{
									[N]: $m,
									[W]: [nm, {
										[N]: gs,
										endpoint: {
											[re]: "https://{Bucket}.ec2.{url#authority}",
											[ie]: qa,
											[se]: Se
										},
										[_]: X
									}],
									[_]: K
								}, {
									endpoint: {
										[re]: "https://{Bucket}.ec2.s3-outposts.{Region}.{regionPartition#dnsSuffix}",
										[ie]: qa,
										[se]: Se
									},
									[_]: X
								}],
								[_]: K
							},
							{
								[N]: [{
									[L]: Le,
									[z$1]: [tm, "o"]
								}],
								[W]: [{
									[N]: $m,
									[W]: [nm, {
										[N]: gs,
										endpoint: {
											[re]: "https://{Bucket}.op-{outpostId}.{url#authority}",
											[ie]: qa,
											[se]: Se
										},
										[_]: X
									}],
									[_]: K
								}, {
									endpoint: {
										[re]: "https://{Bucket}.op-{outpostId}.s3-outposts.{Region}.{regionPartition#dnsSuffix}",
										[ie]: qa,
										[se]: Se
									},
									[_]: X
								}],
								[_]: K
							},
							{
								error: "Unrecognized hardware type: \"Expected hardware type o or e but got {hardwareType}\"",
								[_]: ue
							}
						],
						[_]: K
					}, {
						error: "Invalid Outposts Bucket alias - it must be a valid bucket name.",
						[_]: ue
					}],
					[_]: K
				}, {
					error: "Invalid ARN: The outpost Id must only contain a-z, A-Z, 0-9 and `-`.",
					[_]: ue
				}],
				[_]: K
			},
			{
				[N]: X8,
				[W]: [
					{
						[N]: [pt, {
							[L]: Ar,
							[z$1]: [{
								[L]: Un,
								[z$1]: [{
									[L]: Od,
									[z$1]: V8
								}]
							}]
						}],
						error: "Custom endpoint `{Endpoint}` was not a valid URI",
						[_]: ue
					},
					{
						[N]: [Fl, Yw],
						[W]: [{
							[N]: Vn,
							[W]: [{
								[N]: Lm,
								[W]: [
									{
										[N]: [Zn, V0],
										error: "S3 Accelerate cannot be used in this region",
										[_]: ue
									},
									{
										[N]: [
											Ze,
											tt,
											xt,
											xe,
											Pt
										],
										endpoint: {
											[re]: "https://{Bucket}.s3-fips.dualstack.us-east-1.{partitionResult#dnsSuffix}",
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ze,
											tt,
											xt,
											xe,
											Ue,
											Ut
										],
										[W]: [{
											endpoint: rm$1,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ze,
											tt,
											xt,
											xe,
											Ue,
											Mt
										],
										endpoint: rm$1,
										[_]: X
									},
									{
										[N]: [
											Ne,
											tt,
											xt,
											xe,
											Pt
										],
										endpoint: {
											[re]: "https://{Bucket}.s3-fips.us-east-1.{partitionResult#dnsSuffix}",
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ne,
											tt,
											xt,
											xe,
											Ue,
											Ut
										],
										[W]: [{
											endpoint: im,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ne,
											tt,
											xt,
											xe,
											Ue,
											Mt
										],
										endpoint: im,
										[_]: X
									},
									{
										[N]: [
											Ze,
											Re,
											Zn,
											xe,
											Pt
										],
										endpoint: {
											[re]: "https://{Bucket}.s3-accelerate.dualstack.us-east-1.{partitionResult#dnsSuffix}",
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ze,
											Re,
											Zn,
											xe,
											Ue,
											Ut
										],
										[W]: [{
											endpoint: sm,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ze,
											Re,
											Zn,
											xe,
											Ue,
											Mt
										],
										endpoint: sm,
										[_]: X
									},
									{
										[N]: [
											Ze,
											Re,
											xt,
											xe,
											Pt
										],
										endpoint: {
											[re]: "https://{Bucket}.s3.dualstack.us-east-1.{partitionResult#dnsSuffix}",
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ze,
											Re,
											xt,
											xe,
											Ue,
											Ut
										],
										[W]: [{
											endpoint: om,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ze,
											Re,
											xt,
											xe,
											Ue,
											Mt
										],
										endpoint: om,
										[_]: X
									},
									{
										[N]: [
											Ne,
											Re,
											xt,
											pt,
											cn,
											xl,
											Pt
										],
										endpoint: {
											[re]: Hw,
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ne,
											Re,
											xt,
											pt,
											cn,
											Al,
											Pt
										],
										endpoint: {
											[re]: gu,
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ne,
											Re,
											xt,
											pt,
											cn,
											xl,
											Ue,
											Ut
										],
										[W]: [{
											[N]: hi,
											endpoint: _l,
											[_]: X
										}, {
											endpoint: _l,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ne,
											Re,
											xt,
											pt,
											cn,
											Al,
											Ue,
											Ut
										],
										[W]: [{
											[N]: hi,
											endpoint: Gf,
											[_]: X
										}, am],
										[_]: K
									},
									{
										[N]: [
											Ne,
											Re,
											xt,
											pt,
											cn,
											xl,
											Ue,
											Mt
										],
										endpoint: _l,
										[_]: X
									},
									{
										[N]: [
											Ne,
											Re,
											xt,
											pt,
											cn,
											Al,
											Ue,
											Mt
										],
										endpoint: Gf,
										[_]: X
									},
									{
										[N]: [
											Ne,
											Re,
											Zn,
											xe,
											Pt
										],
										endpoint: {
											[re]: qw,
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ne,
											Re,
											Zn,
											xe,
											Ue,
											Ut
										],
										[W]: [{
											[N]: hi,
											endpoint: Bl,
											[_]: X
										}, {
											endpoint: Bl,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ne,
											Re,
											Zn,
											xe,
											Ue,
											Mt
										],
										endpoint: Bl,
										[_]: X
									},
									{
										[N]: [
											Ne,
											Re,
											xt,
											xe,
											Pt
										],
										endpoint: {
											[re]: z0,
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ne,
											Re,
											xt,
											xe,
											Ue,
											Ut
										],
										[W]: [{
											[N]: hi,
											endpoint: {
												[re]: z0,
												[ie]: Bt,
												[se]: Se
											},
											[_]: X
										}, {
											endpoint: um,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ne,
											Re,
											xt,
											xe,
											Ue,
											Mt
										],
										endpoint: um,
										[_]: X
									}
								],
								[_]: K
							}, ja],
							[_]: K
						}],
						[_]: K
					},
					{
						[N]: [
							pt,
							cn,
							{
								[L]: Le,
								[z$1]: [{
									[L]: ot,
									[z$1]: [Jw, "scheme"]
								}, "http"]
							},
							{
								[L]: pu,
								[z$1]: [$e, Dr]
							},
							Fl,
							Re,
							Ne,
							xt
						],
						[W]: [{
							[N]: Vn,
							[W]: [{
								[N]: Lm,
								[W]: [am],
								[_]: K
							}, ja],
							[_]: K
						}],
						[_]: K
					},
					{
						[N]: [Fl, {
							[L]: jw,
							[z$1]: Z8,
							[Ae]: Gw
						}],
						[W]: [{
							[N]: [{
								[L]: ot,
								[z$1]: [Sn, "resourceId[0]"],
								[Ae]: Ww
							}, {
								[L]: Ar,
								[z$1]: [{
									[L]: Le,
									[z$1]: [Qw, mu]
								}]
							}],
							[W]: [
								{
									[N]: [{
										[L]: Le,
										[z$1]: [Il, Md]
									}],
									[W]: [{
										[N]: ql,
										[W]: [{
											[N]: zm,
											[W]: [
												cm,
												lm,
												{
													[N]: jl,
													[W]: [
														fm,
														{
															[N]: qm,
															[W]: [kl, {
																[N]: Gl,
																[W]: [{
																	[N]: Vn,
																	[W]: [{
																		[N]: jm,
																		[W]: [{
																			[N]: Wl,
																			[W]: [
																				{
																					[N]: [{
																						[L]: Le,
																						[z$1]: [tb, mu]
																					}],
																					error: "Invalid ARN: Missing account id",
																					[_]: ue
																				},
																				{
																					[N]: Kl,
																					[W]: [{
																						[N]: Gm,
																						[W]: [
																							{
																								[N]: gs,
																								endpoint: {
																									[re]: H0,
																									[ie]: Rl,
																									[se]: Se
																								},
																								[_]: X
																							},
																							{
																								[N]: Ga,
																								endpoint: {
																									[re]: "https://{accessPointName}-{bucketArn#accountId}.s3-object-lambda-fips.{bucketArn#region}.{bucketPartition#dnsSuffix}",
																									[ie]: Rl,
																									[se]: Se
																								},
																								[_]: X
																							},
																							{
																								endpoint: {
																									[re]: "https://{accessPointName}-{bucketArn#accountId}.s3-object-lambda.{bucketArn#region}.{bucketPartition#dnsSuffix}",
																									[ie]: Rl,
																									[se]: Se
																								},
																								[_]: X
																							}
																						],
																						[_]: K
																					}, dm],
																					[_]: K
																				},
																				Tl
																			],
																			[_]: K
																		}, Pl],
																		[_]: K
																	}, Nl],
																	[_]: K
																}],
																[_]: K
															}],
															[_]: K
														},
														hm
													],
													[_]: K
												},
												{
													error: "Invalid ARN: bucket ARN is missing a region",
													[_]: ue
												}
											],
											[_]: K
										}, pm],
										[_]: K
									}, {
										error: "Invalid ARN: Object Lambda ARNs only support `accesspoint` arn types, but found: `{arnType}`",
										[_]: ue
									}],
									[_]: K
								},
								{
									[N]: ql,
									[W]: [{
										[N]: zm,
										[W]: [
											{
												[N]: jl,
												[W]: [{
													[N]: ql,
													[W]: [{
														[N]: jl,
														[W]: [
															fm,
															{
																[N]: qm,
																[W]: [kl, {
																	[N]: Gl,
																	[W]: [{
																		[N]: Vn,
																		[W]: [{
																			[N]: [{
																				[L]: Le,
																				[z$1]: [eb, "{partitionResult#name}"]
																			}],
																			[W]: [{
																				[N]: Wl,
																				[W]: [{
																					[N]: [{
																						[L]: Le,
																						[z$1]: [Il, Ns]
																					}],
																					[W]: [{
																						[N]: Kl,
																						[W]: [{
																							[N]: Gm,
																							[W]: [
																								{
																									[N]: Ll,
																									error: "Access Points do not support S3 Accelerate",
																									[_]: ue
																								},
																								{
																									[N]: Hl,
																									endpoint: {
																										[re]: "https://{accessPointName}-{bucketArn#accountId}.s3-accesspoint-fips.dualstack.{bucketArn#region}.{bucketPartition#dnsSuffix}",
																										[ie]: fo,
																										[se]: Se
																									},
																									[_]: X
																								},
																								{
																									[N]: bo,
																									endpoint: {
																										[re]: "https://{accessPointName}-{bucketArn#accountId}.s3-accesspoint-fips.{bucketArn#region}.{bucketPartition#dnsSuffix}",
																										[ie]: fo,
																										[se]: Se
																									},
																									[_]: X
																								},
																								{
																									[N]: Eo,
																									endpoint: {
																										[re]: "https://{accessPointName}-{bucketArn#accountId}.s3-accesspoint.dualstack.{bucketArn#region}.{bucketPartition#dnsSuffix}",
																										[ie]: fo,
																										[se]: Se
																									},
																									[_]: X
																								},
																								{
																									[N]: [
																										Re,
																										Ne,
																										pt,
																										cn
																									],
																									endpoint: {
																										[re]: H0,
																										[ie]: fo,
																										[se]: Se
																									},
																									[_]: X
																								},
																								{
																									[N]: vo,
																									endpoint: {
																										[re]: "https://{accessPointName}-{bucketArn#accountId}.s3-accesspoint.{bucketArn#region}.{bucketPartition#dnsSuffix}",
																										[ie]: fo,
																										[se]: Se
																									},
																									[_]: X
																								}
																							],
																							[_]: K
																						}, dm],
																						[_]: K
																					}, Tl],
																					[_]: K
																				}, {
																					error: "Invalid ARN: The ARN was not for the S3 service, found: {bucketArn#service}",
																					[_]: ue
																				}],
																				[_]: K
																			}, Pl],
																			[_]: K
																		}, Nl],
																		[_]: K
																	}],
																	[_]: K
																}],
																[_]: K
															},
															hm
														],
														[_]: K
													}],
													[_]: K
												}],
												[_]: K
											},
											{
												[N]: [{
													[L]: Vi,
													[z$1]: [Ld, Dr]
												}],
												[W]: [
													{
														[N]: Hm,
														error: "S3 MRAP does not support dual-stack",
														[_]: ue
													},
													{
														[N]: Ga,
														error: "S3 MRAP does not support FIPS",
														[_]: ue
													},
													{
														[N]: Ll,
														error: "S3 MRAP does not support S3 Accelerate",
														[_]: ue
													},
													{
														[N]: [{
															[L]: wt,
															[z$1]: [{ [pe]: "DisableMultiRegionAccessPoints" }, Dr]
														}],
														error: "Invalid configuration: Multi-Region Access Point ARNs are disabled.",
														[_]: ue
													},
													{
														[N]: [{
															[L]: hu,
															[z$1]: $l,
															[Ae]: q0
														}],
														[W]: [{
															[N]: [{
																[L]: Le,
																[z$1]: [{
																	[L]: ot,
																	[z$1]: [{ [pe]: q0 }, at]
																}, {
																	[L]: ot,
																	[z$1]: [Sn, "partition"]
																}]
															}],
															[W]: [{
																endpoint: {
																	[re]: "https://{accessPointName}.accesspoint.s3-global.{mrapPartition#dnsSuffix}",
																	[ie]: { [$t]: [{
																		[At]: Dr,
																		name: Ud,
																		[_t]: Ns,
																		[Nd]: Y8
																	}] },
																	[se]: Se
																},
																[_]: X
															}],
															[_]: K
														}, {
															error: "Client was configured for partition `{mrapPartition#name}` but bucket referred to partition `{bucketArn#partition}`",
															[_]: ue
														}],
														[_]: K
													}
												],
												[_]: K
											},
											{
												error: "Invalid Access Point Name",
												[_]: ue
											}
										],
										[_]: K
									}, pm],
									[_]: K
								},
								{
									[N]: [{
										[L]: Le,
										[z$1]: [Il, Oo]
									}],
									[W]: [
										{
											[N]: Hm,
											error: "S3 Outposts does not support Dual-stack",
											[_]: ue
										},
										{
											[N]: Ga,
											error: "S3 Outposts does not support FIPS",
											[_]: ue
										},
										{
											[N]: Ll,
											error: "S3 Outposts does not support S3 Accelerate",
											[_]: ue
										},
										{
											[N]: [{
												[L]: Un,
												[z$1]: [{
													[L]: ot,
													[z$1]: [Sn, "resourceId[4]"]
												}]
											}],
											error: "Invalid Arn: Outpost Access Point ARN contains sub resources",
											[_]: ue
										},
										{
											[N]: [{
												[L]: ot,
												[z$1]: Q8,
												[Ae]: jf
											}],
											[W]: [{
												[N]: Mm,
												[W]: [kl, {
													[N]: Gl,
													[W]: [{
														[N]: Vn,
														[W]: [{
															[N]: jm,
															[W]: [{
																[N]: Wl,
																[W]: [{
																	[N]: Kl,
																	[W]: [{
																		[N]: [{
																			[L]: ot,
																			[z$1]: e6,
																			[Ae]: j0
																		}],
																		[W]: [{
																			[N]: [{
																				[L]: ot,
																				[z$1]: [Sn, "resourceId[3]"],
																				[Ae]: $d
																			}],
																			[W]: [{
																				[N]: [{
																					[L]: Le,
																					[z$1]: [{ [pe]: j0 }, Kw]
																				}],
																				[W]: [{
																					[N]: gs,
																					endpoint: {
																						[re]: "https://{accessPointName}-{bucketArn#accountId}.{outpostId}.{url#authority}",
																						[ie]: gm,
																						[se]: Se
																					},
																					[_]: X
																				}, {
																					endpoint: {
																						[re]: "https://{accessPointName}-{bucketArn#accountId}.{outpostId}.s3-outposts.{bucketArn#region}.{bucketPartition#dnsSuffix}",
																						[ie]: gm,
																						[se]: Se
																					},
																					[_]: X
																				}],
																				[_]: K
																			}, {
																				error: "Expected an outpost type `accesspoint`, found {outpostType}",
																				[_]: ue
																			}],
																			[_]: K
																		}, {
																			error: "Invalid ARN: expected an access point name",
																			[_]: ue
																		}],
																		[_]: K
																	}, {
																		error: "Invalid ARN: Expected a 4-component resource",
																		[_]: ue
																	}],
																	[_]: K
																}, Tl],
																[_]: K
															}, Pl],
															[_]: K
														}, Nl],
														[_]: K
													}],
													[_]: K
												}],
												[_]: K
											}, {
												error: "Invalid ARN: The outpost Id may only contain a-z, A-Z, 0-9 and `-`. Found: `{outpostId}`",
												[_]: ue
											}],
											[_]: K
										},
										{
											error: "Invalid ARN: The Outpost Id was not set",
											[_]: ue
										}
									],
									[_]: K
								},
								{
									error: "Invalid ARN: Unrecognized format: {Bucket} (type: {arnType})",
									[_]: ue
								}
							],
							[_]: K
						}, {
							error: "Invalid ARN: No ARN type specified",
							[_]: ue
						}],
						[_]: K
					},
					{
						[N]: [
							{
								[L]: Ye,
								[z$1]: [
									$e,
									0,
									4,
									W8
								],
								[Ae]: G0
							},
							{
								[L]: Le,
								[z$1]: [{ [pe]: G0 }, "arn:"]
							},
							{
								[L]: Ar,
								[z$1]: [{
									[L]: Un,
									[z$1]: [mm]
								}]
							}
						],
						error: "Invalid ARN: `{Bucket}` was not a valid ARN",
						[_]: ue
					},
					{
						[N]: [{
							[L]: wt,
							[z$1]: [K8, Dr]
						}, mm],
						error: "Path-style addressing cannot be used with ARN buckets",
						[_]: ue
					},
					{
						[N]: J8,
						[W]: [{
							[N]: Vn,
							[W]: [{
								[N]: [xt],
								[W]: [
									{
										[N]: [
											Ze,
											xe,
											tt,
											Pt
										],
										endpoint: {
											[re]: "https://s3-fips.dualstack.us-east-1.{partitionResult#dnsSuffix}/{uri_encoded_bucket}",
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ze,
											xe,
											tt,
											Ue,
											Ut
										],
										[W]: [{
											endpoint: ym,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ze,
											xe,
											tt,
											Ue,
											Mt
										],
										endpoint: ym,
										[_]: X
									},
									{
										[N]: [
											Ne,
											xe,
											tt,
											Pt
										],
										endpoint: {
											[re]: "https://s3-fips.us-east-1.{partitionResult#dnsSuffix}/{uri_encoded_bucket}",
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ne,
											xe,
											tt,
											Ue,
											Ut
										],
										[W]: [{
											endpoint: Dm,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ne,
											xe,
											tt,
											Ue,
											Mt
										],
										endpoint: Dm,
										[_]: X
									},
									{
										[N]: [
											Ze,
											xe,
											Re,
											Pt
										],
										endpoint: {
											[re]: "https://s3.dualstack.us-east-1.{partitionResult#dnsSuffix}/{uri_encoded_bucket}",
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ze,
											xe,
											Re,
											Ue,
											Ut
										],
										[W]: [{
											endpoint: wm,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ze,
											xe,
											Re,
											Ue,
											Mt
										],
										endpoint: wm,
										[_]: X
									},
									{
										[N]: [
											Ne,
											pt,
											cn,
											Re,
											Pt
										],
										endpoint: {
											[re]: Vw,
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ne,
											pt,
											cn,
											Re,
											Ue,
											Ut
										],
										[W]: [{
											[N]: hi,
											endpoint: Ol,
											[_]: X
										}, {
											endpoint: Ol,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ne,
											pt,
											cn,
											Re,
											Ue,
											Mt
										],
										endpoint: Ol,
										[_]: X
									},
									{
										[N]: [
											Ne,
											xe,
											Re,
											Pt
										],
										endpoint: {
											[re]: W0,
											[ie]: Ot,
											[se]: Se
										},
										[_]: X
									},
									{
										[N]: [
											Ne,
											xe,
											Re,
											Ue,
											Ut
										],
										[W]: [{
											[N]: hi,
											endpoint: {
												[re]: W0,
												[ie]: Bt,
												[se]: Se
											},
											[_]: X
										}, {
											endpoint: bm,
											[_]: X
										}],
										[_]: K
									},
									{
										[N]: [
											Ne,
											xe,
											Re,
											Ue,
											Mt
										],
										endpoint: bm,
										[_]: X
									}
								],
								[_]: K
							}, {
								error: "Path-style addressing cannot be used with S3 Accelerate",
								[_]: ue
							}],
							[_]: K
						}],
						[_]: K
					}
				],
				[_]: K
			},
			{
				[N]: [{
					[L]: Un,
					[z$1]: [Em]
				}, {
					[L]: wt,
					[z$1]: [Em, Dr]
				}],
				[W]: [{
					[N]: Vn,
					[W]: [{
						[N]: Wm,
						[W]: [
							cm,
							lm,
							{
								[N]: gs,
								endpoint: {
									[re]: Va,
									[ie]: Ul,
									[se]: Se
								},
								[_]: X
							},
							{
								[N]: Ga,
								endpoint: {
									[re]: "https://s3-object-lambda-fips.{Region}.{partitionResult#dnsSuffix}",
									[ie]: Ul,
									[se]: Se
								},
								[_]: X
							},
							{
								endpoint: {
									[re]: "https://s3-object-lambda.{Region}.{partitionResult#dnsSuffix}",
									[ie]: Ul,
									[se]: Se
								},
								[_]: X
							}
						],
						[_]: K
					}, ja],
					[_]: K
				}],
				[_]: K
			},
			{
				[N]: [em],
				[W]: [{
					[N]: Vn,
					[W]: [{
						[N]: Wm,
						[W]: [
							{
								[N]: [
									tt,
									Ze,
									xe,
									Pt
								],
								endpoint: {
									[re]: "https://s3-fips.dualstack.us-east-1.{partitionResult#dnsSuffix}",
									[ie]: Ot,
									[se]: Se
								},
								[_]: X
							},
							{
								[N]: [
									tt,
									Ze,
									xe,
									Ue,
									Ut
								],
								[W]: [{
									endpoint: vm,
									[_]: X
								}],
								[_]: K
							},
							{
								[N]: [
									tt,
									Ze,
									xe,
									Ue,
									Mt
								],
								endpoint: vm,
								[_]: X
							},
							{
								[N]: [
									tt,
									Ne,
									xe,
									Pt
								],
								endpoint: {
									[re]: "https://s3-fips.us-east-1.{partitionResult#dnsSuffix}",
									[ie]: Ot,
									[se]: Se
								},
								[_]: X
							},
							{
								[N]: [
									tt,
									Ne,
									xe,
									Ue,
									Ut
								],
								[W]: [{
									endpoint: Sm,
									[_]: X
								}],
								[_]: K
							},
							{
								[N]: [
									tt,
									Ne,
									xe,
									Ue,
									Mt
								],
								endpoint: Sm,
								[_]: X
							},
							{
								[N]: [
									Re,
									Ze,
									xe,
									Pt
								],
								endpoint: {
									[re]: "https://s3.dualstack.us-east-1.{partitionResult#dnsSuffix}",
									[ie]: Ot,
									[se]: Se
								},
								[_]: X
							},
							{
								[N]: [
									Re,
									Ze,
									xe,
									Ue,
									Ut
								],
								[W]: [{
									endpoint: Cm,
									[_]: X
								}],
								[_]: K
							},
							{
								[N]: [
									Re,
									Ze,
									xe,
									Ue,
									Mt
								],
								endpoint: Cm,
								[_]: X
							},
							{
								[N]: [
									Re,
									Ne,
									pt,
									cn,
									Pt
								],
								endpoint: {
									[re]: Va,
									[ie]: Ot,
									[se]: Se
								},
								[_]: X
							},
							{
								[N]: [
									Re,
									Ne,
									pt,
									cn,
									Ue,
									Ut
								],
								[W]: [{
									[N]: hi,
									endpoint: Ml,
									[_]: X
								}, {
									endpoint: Ml,
									[_]: X
								}],
								[_]: K
							},
							{
								[N]: [
									Re,
									Ne,
									pt,
									cn,
									Ue,
									Mt
								],
								endpoint: Ml,
								[_]: X
							},
							{
								[N]: [
									Re,
									Ne,
									xe,
									Pt
								],
								endpoint: {
									[re]: K0,
									[ie]: Ot,
									[se]: Se
								},
								[_]: X
							},
							{
								[N]: [
									Re,
									Ne,
									xe,
									Ue,
									Ut
								],
								[W]: [{
									[N]: hi,
									endpoint: {
										[re]: K0,
										[ie]: Bt,
										[se]: Se
									},
									[_]: X
								}, {
									endpoint: xm,
									[_]: X
								}],
								[_]: K
							},
							{
								[N]: [
									Re,
									Ne,
									xe,
									Ue,
									Mt
								],
								endpoint: xm,
								[_]: X
							}
						],
						[_]: K
					}, ja],
					[_]: K
				}],
				[_]: K
			}
		],
		[_]: K
	}, {
		error: "A region must be set when sending requests to S3.",
		[_]: ue
	}]
}, r6 = new cT({
	size: 50,
	params: [
		"Accelerate",
		"Bucket",
		"DisableAccessPoints",
		"DisableMultiRegionAccessPoints",
		"DisableS3ExpressSessionAuth",
		"Endpoint",
		"ForcePathStyle",
		"Region",
		"UseArnRegion",
		"UseDualStack",
		"UseFIPS",
		"UseGlobalEndpoint",
		"UseObjectLambdaEndpoint",
		"UseS3ExpressControlEndpoint"
	]
}), nb = (e, t = {}) => r6.get(e, () => _T(n6, {
	endpointParams: e,
	logger: t.logger
}));
Po.aws = $w;
const i6 = (e) => async (t, n, r) => {
	var c, d, f;
	if (!r) throw new Error("Could not find `input` for `defaultEndpointRuleSetHttpAuthSchemeParametersProvider`");
	const s = await e(t, n, r), o = (f = (d = (c = Ci(n)) == null ? void 0 : c.commandInstance) == null ? void 0 : d.constructor) == null ? void 0 : f.getEndpointParameterInstructions;
	if (!o) throw new Error(`getEndpointParameterInstructions() is not defined on '${n.commandName}'`);
	const u = await Tw(r, { getEndpointParameterInstructions: o }, t);
	return Object.assign(s, u);
}, s6 = async (e, t, n) => ({
	operation: Ci(t).operation,
	region: await or(e.region)() || (() => {
		throw new Error("expected `region` to be configured for `aws.auth#sigv4`");
	})()
}), o6 = i6(s6);
function rb(e) {
	return {
		schemeId: "aws.auth#sigv4",
		signingProperties: {
			name: "s3",
			region: e.region
		},
		propertiesExtractor: (t, n) => ({ signingProperties: {
			config: t,
			context: n
		} })
	};
}
function ib(e) {
	return {
		schemeId: "aws.auth#sigv4a",
		signingProperties: {
			name: "s3",
			region: e.region
		},
		propertiesExtractor: (t, n) => ({ signingProperties: {
			config: t,
			context: n
		} })
	};
}
const a6 = (e, t, n) => (s) => {
	var d;
	const u = (d = e(s).properties) == null ? void 0 : d.authSchemes;
	if (!u) return t(s);
	const c = [];
	for (const f of u) {
		const { name: m, properties: y = {}, ...w } = f, E = m.toLowerCase();
		m !== E && console.warn(`HttpAuthScheme has been normalized with lowercasing: '${m}' to '${E}'`);
		let A;
		if (E === "sigv4a") {
			A = "aws.auth#sigv4a";
			const $ = u.find((V) => {
				const H = V.name.toLowerCase();
				return H !== "sigv4a" && H.startsWith("sigv4");
			});
			if (Td.sigv4aDependency() === "none" && $) continue;
		} else if (E.startsWith("sigv4")) A = "aws.auth#sigv4";
		else throw new Error(`Unknown HttpAuthScheme found in '@smithy.rules#endpointRuleSet': '${E}'`);
		const B = n[A];
		if (!B) throw new Error(`Could not find HttpAuthOption create function for '${A}'`);
		const T = B(s);
		T.schemeId = A, T.signingProperties = {
			...T.signingProperties || {},
			...w,
			...y
		}, c.push(T);
	}
	return c;
}, u6 = (e) => {
	const t = [];
	switch (e.operation) {
		default: t.push(rb(e)), t.push(ib(e));
	}
	return t;
}, c6 = a6(nb, u6, {
	"aws.auth#sigv4": rb,
	"aws.auth#sigv4a": ib
}), l6 = (e) => {
	const n = ZI(Ek(e));
	return Object.assign(n, { authSchemePreference: or(e.authSchemePreference ?? []) });
}, f6 = (e) => Object.assign(e, {
	useFipsEndpoint: e.useFipsEndpoint ?? !1,
	useDualstackEndpoint: e.useDualstackEndpoint ?? !1,
	forcePathStyle: e.forcePathStyle ?? !1,
	useAccelerateEndpoint: e.useAccelerateEndpoint ?? !1,
	useGlobalEndpoint: e.useGlobalEndpoint ?? !1,
	disableMultiregionAccessPoints: e.disableMultiregionAccessPoints ?? !1,
	defaultSigningName: "s3",
	clientContextParams: e.clientContextParams ?? {}
}), sb = {
	ForcePathStyle: {
		type: "clientContextParams",
		name: "forcePathStyle"
	},
	UseArnRegion: {
		type: "clientContextParams",
		name: "useArnRegion"
	},
	DisableMultiRegionAccessPoints: {
		type: "clientContextParams",
		name: "disableMultiregionAccessPoints"
	},
	Accelerate: {
		type: "clientContextParams",
		name: "useAccelerateEndpoint"
	},
	DisableS3ExpressSessionAuth: {
		type: "clientContextParams",
		name: "disableS3ExpressSessionAuth"
	},
	UseGlobalEndpoint: {
		type: "builtInParams",
		name: "useGlobalEndpoint"
	},
	UseFIPS: {
		type: "builtInParams",
		name: "useFipsEndpoint"
	},
	Endpoint: {
		type: "builtInParams",
		name: "endpoint"
	},
	Region: {
		type: "builtInParams",
		name: "region"
	},
	UseDualStack: {
		type: "builtInParams",
		name: "useDualstackEndpoint"
	}
};
var Lt = class Lt extends ws {
	constructor(t) {
		super(t), Object.setPrototypeOf(this, Lt.prototype);
	}
};
var zd = class zd extends Lt {
	constructor(n) {
		super({
			name: "NoSuchUpload",
			$fault: "client",
			...n
		});
		P(this, "name", "NoSuchUpload");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, zd.prototype);
	}
};
var Hd = class Hd extends Lt {
	constructor(n) {
		super({
			name: "AccessDenied",
			$fault: "client",
			...n
		});
		P(this, "name", "AccessDenied");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, Hd.prototype);
	}
};
var qd = class qd extends Lt {
	constructor(n) {
		super({
			name: "ObjectNotInActiveTierError",
			$fault: "client",
			...n
		});
		P(this, "name", "ObjectNotInActiveTierError");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, qd.prototype);
	}
};
var jd = class jd extends Lt {
	constructor(n) {
		super({
			name: "BucketAlreadyExists",
			$fault: "client",
			...n
		});
		P(this, "name", "BucketAlreadyExists");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, jd.prototype);
	}
};
var Gd = class Gd extends Lt {
	constructor(n) {
		super({
			name: "BucketAlreadyOwnedByYou",
			$fault: "client",
			...n
		});
		P(this, "name", "BucketAlreadyOwnedByYou");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, Gd.prototype);
	}
};
var Wd = class Wd extends Lt {
	constructor(n) {
		super({
			name: "NoSuchBucket",
			$fault: "client",
			...n
		});
		P(this, "name", "NoSuchBucket");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, Wd.prototype);
	}
};
var Kd = class Kd extends Lt {
	constructor(n) {
		super({
			name: "InvalidObjectState",
			$fault: "client",
			...n
		});
		P(this, "name", "InvalidObjectState");
		P(this, "$fault", "client");
		P(this, "StorageClass");
		P(this, "AccessTier");
		Object.setPrototypeOf(this, Kd.prototype), this.StorageClass = n.StorageClass, this.AccessTier = n.AccessTier;
	}
};
var Vd = class Vd extends Lt {
	constructor(n) {
		super({
			name: "NoSuchKey",
			$fault: "client",
			...n
		});
		P(this, "name", "NoSuchKey");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, Vd.prototype);
	}
};
var Zd = class Zd extends Lt {
	constructor(n) {
		super({
			name: "NotFound",
			$fault: "client",
			...n
		});
		P(this, "name", "NotFound");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, Zd.prototype);
	}
};
var Jd = class Jd extends Lt {
	constructor(n) {
		super({
			name: "EncryptionTypeMismatch",
			$fault: "client",
			...n
		});
		P(this, "name", "EncryptionTypeMismatch");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, Jd.prototype);
	}
};
var Xd = class Xd extends Lt {
	constructor(n) {
		super({
			name: "InvalidRequest",
			$fault: "client",
			...n
		});
		P(this, "name", "InvalidRequest");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, Xd.prototype);
	}
};
var Yd = class Yd extends Lt {
	constructor(n) {
		super({
			name: "InvalidWriteOffset",
			$fault: "client",
			...n
		});
		P(this, "name", "InvalidWriteOffset");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, Yd.prototype);
	}
};
var Qd = class Qd extends Lt {
	constructor(n) {
		super({
			name: "TooManyParts",
			$fault: "client",
			...n
		});
		P(this, "name", "TooManyParts");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, Qd.prototype);
	}
};
var eh = class eh extends Lt {
	constructor(n) {
		super({
			name: "IdempotencyParameterMismatch",
			$fault: "client",
			...n
		});
		P(this, "name", "IdempotencyParameterMismatch");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, eh.prototype);
	}
};
var th = class th extends Lt {
	constructor(n) {
		super({
			name: "ObjectAlreadyInActiveTierError",
			$fault: "client",
			...n
		});
		P(this, "name", "ObjectAlreadyInActiveTierError");
		P(this, "$fault", "client");
		Object.setPrototypeOf(this, th.prototype);
	}
};
const d6 = "ACL", h6 = "AccessDenied", Km = "AccessKeyId", p6 = "AccessTier", ob = "Bucket", g6 = "BucketAlreadyExists", m6 = "BucketAlreadyOwnedByYou", ku = "BucketKeyEnabled", y6 = "Body", D6 = "ChecksumAlgorithm", w6 = "CacheControl", ab = "ChecksumCRC32", ub = "ChecksumCRC32C", cb = "ChecksumCRC64NVME", b6 = "Cache-Control", E6 = "Content-Disposition", v6 = "ContentDisposition", S6 = "Content-Encoding", C6 = "ContentEncoding", x6 = "ContentLanguage", F6 = "Content-Language", A6 = "Content-Length", _6 = "ContentLength", B6 = "Content-MD5", I6 = "ContentMD5", lb = "ChecksumSHA1", fb = "ChecksumSHA256", k6 = "CreateSessionOutput", R6 = "CreateSessionResult", T6 = "CreateSessionRequest", P6 = "CreateSession", N6 = "ChecksumType", O6 = "Content-Type", U6 = "ContentType", Vm = "Credentials", Wf = "Expiration", M6 = "ExpectedBucketOwner", $6 = "EncryptionTypeMismatch", Zm = "ETag", Jm = "Expires", L6 = "GrantFullControl", z6 = "GrantRead", H6 = "GrantReadACP", q6 = "GrantWriteACP", j6 = "IfMatch", G6 = "If-Match", W6 = "IfNoneMatch", K6 = "If-None-Match", V6 = "InvalidObjectState", Z6 = "IdempotencyParameterMismatch", J6 = "InvalidRequest", X6 = "InvalidWriteOffset", Y6 = "Key", Q6 = "Metadata", eP = "NotFound", tP = "NoSuchBucket", nP = "NoSuchKey", rP = "NoSuchUpload", iP = "ObjectAlreadyInActiveTierError", sP = "ObjectLockLegalHoldStatus", oP = "ObjectLockMode", aP = "ObjectLockRetainUntilDate", uP = "ObjectNotInActiveTierError", cP = "PutObject", lP = "PutObjectOutput", fP = "PutObjectRequest", dP = "RequestCharged", hP = "RequestPayer", Xm = "SecretAccessKey", pP = "StreamingBlob", db = "StorageClass", gP = "SessionCredentialValue", mP = "SessionCredentials", yP = "SessionMode", Ru = "ServerSideEncryption", hb = "SSECustomerAlgorithm", pb = "SSECustomerKey", gb = "SSECustomerKeyMD5", zo = "SSEKMSEncryptionContext", Ho = "SSEKMSKeyId", Ym = "SessionToken", DP = "Size", wP = "TooManyParts", bP = "Tagging", EP = "VersionId", vP = "WriteOffsetBytes", SP = "WebsiteRedirectLocation", fn = "client", dn = "error", mb = "http", CP = "httpChecksum", xn = "httpError", he = "httpHeader", xP = "httpPrefixHeaders", FP = "streaming", yb = "smithy.ts.sdk.synthetic.com.amazonaws.s3", bs = "xmlName", AP = "x-amz-acl", Db = "x-amz-checksum-crc32", wb = "x-amz-checksum-crc32c", bb = "x-amz-checksum-crc64nvme", Eb = "x-amz-checksum-sha1", vb = "x-amz-checksum-sha256", _P = "x-amz-create-session-mode", BP = "x-amz-checksum-type", IP = "x-amz-expiration", kP = "x-amz-expected-bucket-owner", RP = "x-amz-grant-full-control", TP = "x-amz-grant-read", PP = "x-amz-grant-read-acp", NP = "x-amz-grant-write-acp", OP = "x-amz-meta-", UP = "x-amz-object-lock-legal-hold", MP = "x-amz-object-lock-mode", $P = "x-amz-object-lock-retain-until-date", LP = "x-amz-object-size", zP = "x-amz-request-charged", HP = "x-amz-request-payer", qP = "x-amz-storage-class", jP = "x-amz-sdk-checksum-algorithm", Tu = "x-amz-server-side-encryption", Pu = "x-amz-server-side-encryption-aws-kms-key-id", Nu = "x-amz-server-side-encryption-bucket-key-enabled", Ou = "x-amz-server-side-encryption-context", Sb = "x-amz-server-side-encryption-customer-algorithm", GP = "x-amz-server-side-encryption-customer-key", Cb = "x-amz-server-side-encryption-customer-key-MD5", WP = "x-amz-tagging", KP = "x-amz-version-id", VP = "x-amz-write-offset-bytes", ZP = "x-amz-website-redirect-location", Be = "com.amazonaws.s3";
var Qm = [
	0,
	Be,
	gP,
	8,
	0
], JP = [
	0,
	Be,
	pb,
	8,
	0
], Uu = [
	0,
	Be,
	zo,
	8,
	0
], Mu = [
	0,
	Be,
	Ho,
	8,
	0
], XP = [
	0,
	Be,
	pP,
	{ [FP]: 1 },
	42
], YP = [
	-3,
	Be,
	h6,
	{
		[dn]: fn,
		[xn]: 403
	},
	[],
	[]
];
Et.for(Be).registerError(YP, Hd);
var QP = [
	-3,
	Be,
	g6,
	{
		[dn]: fn,
		[xn]: 409
	},
	[],
	[]
];
Et.for(Be).registerError(QP, jd);
var eN = [
	-3,
	Be,
	m6,
	{
		[dn]: fn,
		[xn]: 409
	},
	[],
	[]
];
Et.for(Be).registerError(eN, Gd);
var tN = [
	3,
	Be,
	k6,
	{ [bs]: R6 },
	[
		Vm,
		Ru,
		Ho,
		zo,
		ku
	],
	[
		[() => mN, { [bs]: Vm }],
		[0, { [he]: Tu }],
		[() => Mu, { [he]: Pu }],
		[() => Uu, { [he]: Ou }],
		[2, { [he]: Nu }]
	],
	1
], nN = [
	3,
	Be,
	T6,
	0,
	[
		ob,
		yP,
		Ru,
		Ho,
		zo,
		ku
	],
	[
		[0, 1],
		[0, { [he]: _P }],
		[0, { [he]: Tu }],
		[() => Mu, { [he]: Pu }],
		[() => Uu, { [he]: Ou }],
		[2, { [he]: Nu }]
	],
	1
], rN = [
	-3,
	Be,
	$6,
	{
		[dn]: fn,
		[xn]: 400
	},
	[],
	[]
];
Et.for(Be).registerError(rN, Jd);
var iN = [
	-3,
	Be,
	Z6,
	{
		[dn]: fn,
		[xn]: 400
	},
	[],
	[]
];
Et.for(Be).registerError(iN, eh);
var sN = [
	-3,
	Be,
	V6,
	{
		[dn]: fn,
		[xn]: 403
	},
	[db, p6],
	[0, 0]
];
Et.for(Be).registerError(sN, Kd);
var oN = [
	-3,
	Be,
	J6,
	{
		[dn]: fn,
		[xn]: 400
	},
	[],
	[]
];
Et.for(Be).registerError(oN, Xd);
var aN = [
	-3,
	Be,
	X6,
	{
		[dn]: fn,
		[xn]: 400
	},
	[],
	[]
];
Et.for(Be).registerError(aN, Yd);
var uN = [
	-3,
	Be,
	tP,
	{
		[dn]: fn,
		[xn]: 404
	},
	[],
	[]
];
Et.for(Be).registerError(uN, Wd);
var cN = [
	-3,
	Be,
	nP,
	{
		[dn]: fn,
		[xn]: 404
	},
	[],
	[]
];
Et.for(Be).registerError(cN, Vd);
var lN = [
	-3,
	Be,
	rP,
	{
		[dn]: fn,
		[xn]: 404
	},
	[],
	[]
];
Et.for(Be).registerError(lN, zd);
var fN = [
	-3,
	Be,
	eP,
	{ [dn]: fn },
	[],
	[]
];
Et.for(Be).registerError(fN, Zd);
var dN = [
	-3,
	Be,
	iP,
	{
		[dn]: fn,
		[xn]: 403
	},
	[],
	[]
];
Et.for(Be).registerError(dN, th);
var hN = [
	-3,
	Be,
	uP,
	{
		[dn]: fn,
		[xn]: 403
	},
	[],
	[]
];
Et.for(Be).registerError(hN, qd);
var pN = [
	3,
	Be,
	lP,
	0,
	[
		Wf,
		Zm,
		ab,
		ub,
		cb,
		lb,
		fb,
		N6,
		Ru,
		EP,
		hb,
		gb,
		Ho,
		zo,
		ku,
		DP,
		dP
	],
	[
		[0, { [he]: IP }],
		[0, { [he]: Zm }],
		[0, { [he]: Db }],
		[0, { [he]: wb }],
		[0, { [he]: bb }],
		[0, { [he]: Eb }],
		[0, { [he]: vb }],
		[0, { [he]: BP }],
		[0, { [he]: Tu }],
		[0, { [he]: KP }],
		[0, { [he]: Sb }],
		[0, { [he]: Cb }],
		[() => Mu, { [he]: Pu }],
		[() => Uu, { [he]: Ou }],
		[2, { [he]: Nu }],
		[1, { [he]: LP }],
		[0, { [he]: zP }]
	]
], gN = [
	3,
	Be,
	fP,
	0,
	[
		ob,
		Y6,
		d6,
		y6,
		w6,
		v6,
		C6,
		x6,
		_6,
		I6,
		U6,
		D6,
		ab,
		ub,
		cb,
		lb,
		fb,
		Jm,
		j6,
		W6,
		L6,
		z6,
		H6,
		q6,
		vP,
		Q6,
		Ru,
		db,
		SP,
		hb,
		pb,
		gb,
		Ho,
		zo,
		ku,
		hP,
		bP,
		oP,
		aP,
		sP,
		M6
	],
	[
		[0, 1],
		[0, 1],
		[0, { [he]: AP }],
		[() => XP, 16],
		[0, { [he]: b6 }],
		[0, { [he]: E6 }],
		[0, { [he]: S6 }],
		[0, { [he]: F6 }],
		[1, { [he]: A6 }],
		[0, { [he]: B6 }],
		[0, { [he]: O6 }],
		[0, { [he]: jP }],
		[0, { [he]: Db }],
		[0, { [he]: wb }],
		[0, { [he]: bb }],
		[0, { [he]: Eb }],
		[0, { [he]: vb }],
		[4, { [he]: Jm }],
		[0, { [he]: G6 }],
		[0, { [he]: K6 }],
		[0, { [he]: RP }],
		[0, { [he]: TP }],
		[0, { [he]: PP }],
		[0, { [he]: NP }],
		[1, { [he]: VP }],
		[128, { [xP]: OP }],
		[0, { [he]: Tu }],
		[0, { [he]: qP }],
		[0, { [he]: ZP }],
		[0, { [he]: Sb }],
		[() => JP, { [he]: GP }],
		[0, { [he]: Cb }],
		[() => Mu, { [he]: Pu }],
		[() => Uu, { [he]: Ou }],
		[2, { [he]: Nu }],
		[0, { [he]: HP }],
		[0, { [he]: WP }],
		[0, { [he]: MP }],
		[5, { [he]: $P }],
		[0, { [he]: UP }],
		[0, { [he]: kP }]
	],
	2
], mN = [
	3,
	Be,
	mP,
	0,
	[
		Km,
		Xm,
		Ym,
		Wf
	],
	[
		[0, { [bs]: Km }],
		[() => Qm, { [bs]: Xm }],
		[() => Qm, { [bs]: Ym }],
		[4, { [bs]: Wf }]
	],
	4
], yN = [
	-3,
	Be,
	wP,
	{
		[dn]: fn,
		[xn]: 400
	},
	[],
	[]
];
Et.for(Be).registerError(yN, Qd);
var DN = [
	-3,
	yb,
	"S3ServiceException",
	0,
	[],
	[]
];
Et.for(yb).registerError(DN, Lt);
var wN = [
	9,
	Be,
	P6,
	{ [mb]: [
		"GET",
		"/?session",
		200
	] },
	() => nN,
	() => tN
], bN = [
	9,
	Be,
	cP,
	{
		[CP]: "-",
		[mb]: [
			"PUT",
			"/{Key+}?x-id=PutObject",
			200
		]
	},
	() => gN,
	() => pN
];
var EN = class extends Cd.classBuilder().ep({
	...sb,
	DisableS3ExpressSessionAuth: {
		type: "staticContextParams",
		value: !0
	},
	Bucket: {
		type: "contextParams",
		name: "Bucket"
	}
}).m(function(t, n, r, s) {
	return [Pw(r, t.getEndpointParameterInstructions()), Dw(r)];
}).s("AmazonS3", "CreateSession", {}).n("S3Client", "CreateSessionCommand").sc(wN).build() {};
const SN = { version: "3.983.0" }, CN = (e) => new TextEncoder().encode(e);
function ey(e) {
	return typeof e == "string" ? e.length === 0 : e.byteLength === 0;
}
var xb = { name: "SHA-1" }, ty = {
	name: "HMAC",
	hash: xb
}, xN = new Uint8Array([
	218,
	57,
	163,
	238,
	94,
	107,
	75,
	13,
	50,
	85,
	191,
	239,
	149,
	96,
	24,
	144,
	175,
	216,
	7,
	9
]);
const FN = {};
function wi() {
	return typeof window < "u" ? window : typeof self < "u" ? self : FN;
}
var AN = function() {
	function e(t) {
		this.toHash = new Uint8Array(0), t !== void 0 && (this.key = new Promise(function(n, r) {
			wi().crypto.subtle.importKey("raw", ny(t), ty, !1, ["sign"]).then(n, r);
		}), this.key.catch(function() {}));
	}
	return e.prototype.update = function(t) {
		if (!ey(t)) {
			var n = ny(t), r = new Uint8Array(this.toHash.byteLength + n.byteLength);
			r.set(this.toHash, 0), r.set(n, this.toHash.byteLength), this.toHash = r;
		}
	}, e.prototype.digest = function() {
		var t = this;
		return this.key ? this.key.then(function(n) {
			return wi().crypto.subtle.sign(ty, n, t.toHash).then(function(r) {
				return new Uint8Array(r);
			});
		}) : ey(this.toHash) ? Promise.resolve(xN) : Promise.resolve().then(function() {
			return wi().crypto.subtle.digest(xb, t.toHash);
		}).then(function(n) {
			return Promise.resolve(new Uint8Array(n));
		});
	}, e.prototype.reset = function() {
		this.toHash = new Uint8Array(0);
	}, e;
}();
function ny(e) {
	return typeof e == "string" ? CN(e) : ArrayBuffer.isView(e) ? new Uint8Array(e.buffer, e.byteOffset, e.byteLength / Uint8Array.BYTES_PER_ELEMENT) : new Uint8Array(e);
}
var _N = [
	"decrypt",
	"digest",
	"encrypt",
	"exportKey",
	"generateKey",
	"importKey",
	"sign",
	"verify"
];
function Fb(e) {
	if (BN(e) && typeof e.crypto.subtle == "object") {
		var t = e.crypto.subtle;
		return IN(t);
	}
	return !1;
}
function BN(e) {
	if (typeof e == "object" && typeof e.crypto == "object") return typeof e.crypto.getRandomValues == "function";
	return !1;
}
function IN(e) {
	return e && _N.every(function(t) {
		return typeof e[t] == "function";
	});
}
var kN = function() {
	function e(t) {
		if (Fb(wi())) this.hash = new AN(t);
		else throw new Error("SHA1 not supported");
	}
	return e.prototype.update = function(t, n) {
		this.hash.update(Ei(t));
	}, e.prototype.digest = function() {
		return this.hash.digest();
	}, e.prototype.reset = function() {
		this.hash.reset();
	}, e;
}(), Ab = { name: "SHA-256" }, ry = {
	name: "HMAC",
	hash: Ab
}, RN = new Uint8Array([
	227,
	176,
	196,
	66,
	152,
	252,
	28,
	20,
	154,
	251,
	244,
	200,
	153,
	111,
	185,
	36,
	39,
	174,
	65,
	228,
	100,
	155,
	147,
	76,
	164,
	149,
	153,
	27,
	120,
	82,
	184,
	85
]), TN = function() {
	function e(t) {
		this.toHash = new Uint8Array(0), this.secret = t, this.reset();
	}
	return e.prototype.update = function(t) {
		if (!To(t)) {
			var n = Ei(t), r = new Uint8Array(this.toHash.byteLength + n.byteLength);
			r.set(this.toHash, 0), r.set(n, this.toHash.byteLength), this.toHash = r;
		}
	}, e.prototype.digest = function() {
		var t = this;
		return this.key ? this.key.then(function(n) {
			return wi().crypto.subtle.sign(ry, n, t.toHash).then(function(r) {
				return new Uint8Array(r);
			});
		}) : To(this.toHash) ? Promise.resolve(RN) : Promise.resolve().then(function() {
			return wi().crypto.subtle.digest(Ab, t.toHash);
		}).then(function(n) {
			return Promise.resolve(new Uint8Array(n));
		});
	}, e.prototype.reset = function() {
		var t = this;
		this.toHash = new Uint8Array(0), this.secret && this.secret !== void 0 && (this.key = new Promise(function(n, r) {
			wi().crypto.subtle.importKey("raw", Ei(t.secret), ry, !1, ["sign"]).then(n, r);
		}), this.key.catch(function() {}));
	}, e;
}(), Xn = 64, PN = 32, NN = new Uint32Array([
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
]), ON = [
	1779033703,
	3144134277,
	1013904242,
	2773480762,
	1359893119,
	2600822924,
	528734635,
	1541459225
], UN = Math.pow(2, 53) - 1, Za = function() {
	function e() {
		this.state = Int32Array.from(ON), this.temp = new Int32Array(64), this.buffer = new Uint8Array(64), this.bufferLength = 0, this.bytesHashed = 0, this.finished = !1;
	}
	return e.prototype.update = function(t) {
		if (this.finished) throw new Error("Attempted to update an already finished hash.");
		var n = 0, r = t.byteLength;
		if (this.bytesHashed += r, this.bytesHashed * 8 > UN) throw new Error("Cannot hash more than 2^53 - 1 bits");
		for (; r > 0;) this.buffer[this.bufferLength++] = t[n++], r--, this.bufferLength === Xn && (this.hashBuffer(), this.bufferLength = 0);
	}, e.prototype.digest = function() {
		if (!this.finished) {
			var t = this.bytesHashed * 8, n = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength), r = this.bufferLength;
			if (n.setUint8(this.bufferLength++, 128), r % Xn >= Xn - 8) {
				for (var s = this.bufferLength; s < Xn; s++) n.setUint8(s, 0);
				this.hashBuffer(), this.bufferLength = 0;
			}
			for (var s = this.bufferLength; s < Xn - 8; s++) n.setUint8(s, 0);
			n.setUint32(Xn - 8, Math.floor(t / 4294967296), !0), n.setUint32(Xn - 4, t), this.hashBuffer(), this.finished = !0;
		}
		for (var o = new Uint8Array(PN), s = 0; s < 8; s++) o[s * 4] = this.state[s] >>> 24 & 255, o[s * 4 + 1] = this.state[s] >>> 16 & 255, o[s * 4 + 2] = this.state[s] >>> 8 & 255, o[s * 4 + 3] = this.state[s] >>> 0 & 255;
		return o;
	}, e.prototype.hashBuffer = function() {
		for (var t = this, n = t.buffer, r = t.state, s = r[0], o = r[1], u = r[2], c = r[3], d = r[4], f = r[5], m = r[6], y = r[7], w = 0; w < Xn; w++) {
			if (w < 16) this.temp[w] = (n[w * 4] & 255) << 24 | (n[w * 4 + 1] & 255) << 16 | (n[w * 4 + 2] & 255) << 8 | n[w * 4 + 3] & 255;
			else {
				var E = this.temp[w - 2], A = (E >>> 17 | E << 15) ^ (E >>> 19 | E << 13) ^ E >>> 10;
				E = this.temp[w - 15];
				var B = (E >>> 7 | E << 25) ^ (E >>> 18 | E << 14) ^ E >>> 3;
				this.temp[w] = (A + this.temp[w - 7] | 0) + (B + this.temp[w - 16] | 0);
			}
			var T = (((d >>> 6 | d << 26) ^ (d >>> 11 | d << 21) ^ (d >>> 25 | d << 7)) + (d & f ^ ~d & m) | 0) + (y + (NN[w] + this.temp[w] | 0) | 0) | 0, $ = ((s >>> 2 | s << 30) ^ (s >>> 13 | s << 19) ^ (s >>> 22 | s << 10)) + (s & o ^ s & u ^ o & u) | 0;
			y = m, m = f, f = d, d = c + T | 0, c = u, u = o, o = s, s = T + $ | 0;
		}
		r[0] += s, r[1] += o, r[2] += u, r[3] += c, r[4] += d, r[5] += f, r[6] += m, r[7] += y;
	}, e;
}(), MN = function() {
	function e(t) {
		this.secret = t, this.hash = new Za(), this.reset();
	}
	return e.prototype.update = function(t) {
		if (!(To(t) || this.error)) try {
			this.hash.update(Ei(t));
		} catch (n) {
			this.error = n;
		}
	}, e.prototype.digestSync = function() {
		if (this.error) throw this.error;
		return this.outer ? (this.outer.finished || this.outer.update(this.hash.digest()), this.outer.digest()) : this.hash.digest();
	}, e.prototype.digest = function() {
		return _d(this, void 0, void 0, function() {
			return Bd(this, function(t) {
				return [2, this.digestSync()];
			});
		});
	}, e.prototype.reset = function() {
		if (this.hash = new Za(), this.secret) {
			this.outer = new Za();
			var t = $N(this.secret), n = new Uint8Array(Xn);
			n.set(t);
			for (var r = 0; r < Xn; r++) t[r] ^= 54, n[r] ^= 92;
			this.hash.update(t), this.outer.update(n);
			for (var r = 0; r < t.byteLength; r++) t[r] = 0;
		}
	}, e;
}();
function $N(e) {
	var t = Ei(e);
	if (t.byteLength > Xn) {
		var n = new Za();
		n.update(t), t = n.digest();
	}
	var r = new Uint8Array(Xn);
	return r.set(t), r;
}
var LN = function() {
	function e(t) {
		Fb(wi()) ? this.hash = new TN(t) : this.hash = new MN(t);
	}
	return e.prototype.update = function(t, n) {
		this.hash.update(Ei(t));
	}, e.prototype.digest = function() {
		return this.hash.digest();
	}, e.prototype.reset = function() {
		this.hash.reset();
	}, e;
}();
const zN = ({ serviceId: e, clientVersion: t }) => async (n) => {
	var E, A, B;
	const r = typeof window < "u" ? window.navigator : void 0, s = (r == null ? void 0 : r.userAgent) ?? "", o = ((E = r == null ? void 0 : r.userAgentData) == null ? void 0 : E.platform) ?? iy.os(s) ?? "other", u = void 0, c = ((A = r == null ? void 0 : r.userAgentData) == null ? void 0 : A.brands) ?? [], d = c[c.length - 1], f = (d == null ? void 0 : d.brand) ?? iy.browser(s) ?? "unknown", m = (d == null ? void 0 : d.version) ?? "unknown", y = [
		["aws-sdk-js", t],
		["ua", "2.1"],
		[`os/${o}`, u],
		["lang/js"],
		["md/browser", `${f}_${m}`]
	];
	e && y.push([`api/${e}`, t]);
	const w = await ((B = n == null ? void 0 : n.userAgentAppId) == null ? void 0 : B.call(n));
	return w && y.push([`app/${w}`]), y;
}, iy = {
	os(e) {
		if (/iPhone|iPad|iPod/.test(e)) return "iOS";
		if (/Macintosh|Mac OS X/.test(e)) return "macOS";
		if (/Windows NT/.test(e)) return "Windows";
		if (/Android/.test(e)) return "Android";
		if (/Linux/.test(e)) return "Linux";
	},
	browser(e) {
		if (/EdgiOS|EdgA|Edg\//.test(e)) return "Microsoft Edge";
		if (/Firefox\//.test(e)) return "Firefox";
		if (/Chrome\//.test(e)) return "Chrome";
		if (/Safari\//.test(e)) return "Safari";
	}
};
var So = class So {
	constructor(t) {
		P(this, "bytes");
		if (this.bytes = t, t.byteLength !== 8) throw new Error("Int64 buffers must be exactly 8 bytes");
	}
	static fromNumber(t) {
		if (t > 0x8000000000000000 || t < -0x8000000000000000) throw new Error(`${t} is too large (or, if negative, too small) to represent as an Int64`);
		const n = new Uint8Array(8);
		for (let r = 7, s = Math.abs(Math.round(t)); r > -1 && s > 0; r--, s /= 256) n[r] = s;
		return t < 0 && sy(n), new So(n);
	}
	valueOf() {
		const t = this.bytes.slice(0), n = t[0] & 128;
		return n && sy(t), parseInt(vn(t), 16) * (n ? -1 : 1);
	}
	toString() {
		return String(this.valueOf());
	}
};
function sy(e) {
	for (let t = 0; t < 8; t++) e[t] ^= 255;
	for (let t = 7; t > -1 && (e[t]++, e[t] === 0); t--);
}
var HN = class {
	constructor(t, n) {
		P(this, "toUtf8");
		P(this, "fromUtf8");
		this.toUtf8 = t, this.fromUtf8 = n;
	}
	format(t) {
		const n = [];
		for (const o of Object.keys(t)) {
			const u = this.fromUtf8(o);
			n.push(Uint8Array.from([u.byteLength]), u, this.formatHeaderValue(t[o]));
		}
		const r = new Uint8Array(n.reduce((o, u) => o + u.byteLength, 0));
		let s = 0;
		for (const o of n) r.set(o, s), s += o.byteLength;
		return r;
	}
	formatHeaderValue(t) {
		switch (t.type) {
			case "boolean": return Uint8Array.from([t.value ? 0 : 1]);
			case "byte": return Uint8Array.from([2, t.value]);
			case "short":
				const n = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(3));
				return n.setUint8(0, 3), n.setInt16(1, t.value, !1), new Uint8Array(n.buffer);
			case "integer":
				const r = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(5));
				return r.setUint8(0, 4), r.setInt32(1, t.value, !1), new Uint8Array(r.buffer);
			case "long":
				const s = new Uint8Array(9);
				return s[0] = 5, s.set(t.value.bytes, 1), s;
			case "binary":
				const o = new DataView(new ArrayBuffer(3 + t.value.byteLength));
				o.setUint8(0, 6), o.setUint16(1, t.value.byteLength, !1);
				const u = new Uint8Array(o.buffer);
				return u.set(t.value, 3), u;
			case "string":
				const c = this.fromUtf8(t.value), d = new DataView(new ArrayBuffer(3 + c.byteLength));
				d.setUint8(0, 7), d.setUint16(1, c.byteLength, !1);
				const f = new Uint8Array(d.buffer);
				return f.set(c, 3), f;
			case "timestamp":
				const m = new Uint8Array(9);
				return m[0] = 8, m.set(So.fromNumber(t.value.valueOf()).bytes, 1), m;
			case "uuid":
				if (!XN.test(t.value)) throw new Error(`Invalid UUID received: ${t.value}`);
				const y = new Uint8Array(17);
				return y[0] = 9, y.set(VD(t.value.replace(/\-/g, "")), 1), y;
		}
	}
	parse(t) {
		const n = {};
		let r = 0;
		for (; r < t.byteLength;) {
			const s = t.getUint8(r++), o = this.toUtf8(new Uint8Array(t.buffer, t.byteOffset + r, s));
			switch (r += s, t.getUint8(r++)) {
				case 0:
					n[o] = {
						type: ay,
						value: !0
					};
					break;
				case 1:
					n[o] = {
						type: ay,
						value: !1
					};
					break;
				case 2:
					n[o] = {
						type: qN,
						value: t.getInt8(r++)
					};
					break;
				case 3:
					n[o] = {
						type: jN,
						value: t.getInt16(r, !1)
					}, r += 2;
					break;
				case 4:
					n[o] = {
						type: GN,
						value: t.getInt32(r, !1)
					}, r += 4;
					break;
				case 5:
					n[o] = {
						type: WN,
						value: new So(new Uint8Array(t.buffer, t.byteOffset + r, 8))
					}, r += 8;
					break;
				case 6:
					const u = t.getUint16(r, !1);
					r += 2, n[o] = {
						type: KN,
						value: new Uint8Array(t.buffer, t.byteOffset + r, u)
					}, r += u;
					break;
				case 7:
					const c = t.getUint16(r, !1);
					r += 2, n[o] = {
						type: VN,
						value: this.toUtf8(new Uint8Array(t.buffer, t.byteOffset + r, c))
					}, r += c;
					break;
				case 8:
					n[o] = {
						type: ZN,
						value: new Date(new So(new Uint8Array(t.buffer, t.byteOffset + r, 8)).valueOf())
					}, r += 8;
					break;
				case 9:
					const d = new Uint8Array(t.buffer, t.byteOffset + r, 16);
					r += 16, n[o] = {
						type: JN,
						value: `${vn(d.subarray(0, 4))}-${vn(d.subarray(4, 6))}-${vn(d.subarray(6, 8))}-${vn(d.subarray(8, 10))}-${vn(d.subarray(10))}`
					};
					break;
				default: throw new Error("Unrecognized header type tag");
			}
		}
		return n;
	}
};
var oy;
(function(e) {
	e[e.boolTrue = 0] = "boolTrue", e[e.boolFalse = 1] = "boolFalse", e[e.byte = 2] = "byte", e[e.short = 3] = "short", e[e.integer = 4] = "integer", e[e.long = 5] = "long", e[e.byteArray = 6] = "byteArray", e[e.string = 7] = "string", e[e.timestamp = 8] = "timestamp", e[e.uuid = 9] = "uuid";
})(oy || (oy = {}));
const ay = "boolean", qN = "byte", jN = "short", GN = "integer", WN = "long", KN = "binary", VN = "string", ZN = "timestamp", JN = "uuid", XN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, _b = 4, gi = _b * 2, Ui = 4, YN = gi + Ui * 2;
function QN({ byteLength: e, byteOffset: t, buffer: n }) {
	if (e < YN) throw new Error("Provided message too short to accommodate event stream message overhead");
	const r = new DataView(n, t, e), s = r.getUint32(0, !1);
	if (e !== s) throw new Error("Reported message length does not match received message length");
	const o = r.getUint32(_b, !1), u = r.getUint32(gi, !1), c = r.getUint32(e - Ui, !1), d = new lu().update(new Uint8Array(n, t, gi));
	if (u !== d.digest()) throw new Error(`The prelude checksum specified in the message (${u}) does not match the calculated CRC32 checksum (${d.digest()})`);
	if (d.update(new Uint8Array(n, t + gi, e - (gi + Ui))), c !== d.digest()) throw new Error(`The message checksum (${d.digest()}) did not match the expected value of ${c}`);
	return {
		headers: new DataView(n, t + gi + Ui, o),
		body: new Uint8Array(n, t + gi + Ui + o, s - o - (gi + Ui + Ui))
	};
}
var e4 = class {
	constructor(t, n) {
		P(this, "headerMarshaller");
		P(this, "messageBuffer");
		P(this, "isEndOfStream");
		this.headerMarshaller = new HN(t, n), this.messageBuffer = [], this.isEndOfStream = !1;
	}
	feed(t) {
		this.messageBuffer.push(this.decode(t));
	}
	endOfStream() {
		this.isEndOfStream = !0;
	}
	getMessage() {
		const t = this.messageBuffer.pop(), n = this.isEndOfStream;
		return {
			getMessage() {
				return t;
			},
			isEndOfStream() {
				return n;
			}
		};
	}
	getAvailableMessages() {
		const t = this.messageBuffer;
		this.messageBuffer = [];
		const n = this.isEndOfStream;
		return {
			getMessages() {
				return t;
			},
			isEndOfStream() {
				return n;
			}
		};
	}
	encode({ headers: t, body: n }) {
		const r = this.headerMarshaller.format(t), s = r.byteLength + n.byteLength + 16, o = new Uint8Array(s), u = new DataView(o.buffer, o.byteOffset, o.byteLength), c = new lu();
		return u.setUint32(0, s, !1), u.setUint32(4, r.byteLength, !1), u.setUint32(8, c.update(o.subarray(0, 8)).digest(), !1), o.set(r, 12), o.set(n, r.byteLength + 12), u.setUint32(s - 4, c.update(o.subarray(8, s - 4)).digest(), !1), o;
	}
	decode(t) {
		const { headers: n, body: r } = QN(t);
		return {
			headers: this.headerMarshaller.parse(n),
			body: r
		};
	}
	formatHeaders(t) {
		return this.headerMarshaller.format(t);
	}
};
var t4 = class {
	constructor(t) {
		P(this, "options");
		this.options = t;
	}
	[Symbol.asyncIterator]() {
		return this.asyncIterator();
	}
	async *asyncIterator() {
		for await (const t of this.options.inputStream) yield this.options.decoder.decode(t);
	}
};
var n4 = class {
	constructor(t) {
		P(this, "options");
		this.options = t;
	}
	[Symbol.asyncIterator]() {
		return this.asyncIterator();
	}
	async *asyncIterator() {
		for await (const t of this.options.messageStream) yield this.options.encoder.encode(t);
		this.options.includeEndFrame && (yield new Uint8Array(0));
	}
};
var r4 = class {
	constructor(t) {
		P(this, "options");
		this.options = t;
	}
	[Symbol.asyncIterator]() {
		return this.asyncIterator();
	}
	async *asyncIterator() {
		for await (const t of this.options.messageStream) {
			const n = await this.options.deserializer(t);
			n !== void 0 && (yield n);
		}
	}
};
var i4 = class {
	constructor(t) {
		P(this, "options");
		this.options = t;
	}
	[Symbol.asyncIterator]() {
		return this.asyncIterator();
	}
	async *asyncIterator() {
		for await (const t of this.options.inputStream) yield this.options.serializer(t);
	}
};
function s4(e) {
	let t = 0, n = 0, r = null, s = null;
	const o = (c) => {
		if (typeof c != "number") throw new Error("Attempted to allocate an event message where size was not a number: " + c);
		t = c, n = 4, r = new Uint8Array(c), new DataView(r.buffer).setUint32(0, c, !1);
	}, u = async function* () {
		const c = e[Symbol.asyncIterator]();
		for (;;) {
			const { value: d, done: f } = await c.next();
			if (f) {
				if (t) if (t === n) yield r;
				else throw new Error("Truncated event message received.");
				else return;
				return;
			}
			const m = d.length;
			let y = 0;
			for (; y < m;) {
				if (!r) {
					const E = m - y;
					s || (s = new Uint8Array(4));
					const A = Math.min(4 - n, E);
					if (s.set(d.slice(y, y + A), n), n += A, y += A, n < 4) break;
					o(new DataView(s.buffer).getUint32(0, !1)), s = null;
				}
				const w = Math.min(t - n, m - y);
				r.set(d.slice(y, y + w), n), n += w, y += w, t && t === n && (yield r, r = null, t = 0, n = 0);
			}
		}
	};
	return { [Symbol.asyncIterator]: u };
}
function o4(e, t) {
	return async function(n) {
		const { value: r } = n.headers[":message-type"];
		if (r === "error") {
			const s = new Error(n.headers[":error-message"].value || "UnknownError");
			throw s.name = n.headers[":error-code"].value, s;
		} else if (r === "exception") {
			const s = n.headers[":exception-type"].value, u = await e({ [s]: n });
			if (u.$unknown) {
				const c = new Error(t(n.body));
				throw c.name = s, c;
			}
			throw u[s];
		} else if (r === "event") {
			const o = await e({ [n.headers[":event-type"].value]: n });
			return o.$unknown ? void 0 : o;
		} else throw Error(`Unrecognizable event type: ${n.headers[":event-type"].value}`);
	};
}
let a4 = class {
	constructor({ utf8Encoder: t, utf8Decoder: n }) {
		P(this, "eventStreamCodec");
		P(this, "utfEncoder");
		this.eventStreamCodec = new e4(t, n), this.utfEncoder = t;
	}
	deserialize(t, n) {
		return new r4({
			messageStream: new t4({
				inputStream: s4(t),
				decoder: this.eventStreamCodec
			}),
			deserializer: o4(n, this.utfEncoder)
		});
	}
	serialize(t, n) {
		return new n4({
			messageStream: new i4({
				inputStream: t,
				serializer: n
			}),
			encoder: this.eventStreamCodec,
			includeEndFrame: !0
		});
	}
};
const u4 = (e) => ({ [Symbol.asyncIterator]: async function* () {
	const t = e.getReader();
	try {
		for (;;) {
			const { done: n, value: r } = await t.read();
			if (n) return;
			yield r;
		}
	} finally {
		t.releaseLock();
	}
} }), c4 = (e) => {
	const t = e[Symbol.asyncIterator]();
	return new ReadableStream({ async pull(n) {
		const { done: r, value: s } = await t.next();
		if (r) return n.close();
		n.enqueue(s);
	} });
};
var l4 = class {
	constructor({ utf8Encoder: t, utf8Decoder: n }) {
		P(this, "universalMarshaller");
		this.universalMarshaller = new a4({
			utf8Decoder: n,
			utf8Encoder: t
		});
	}
	deserialize(t, n) {
		const r = f4(t) ? u4(t) : t;
		return this.universalMarshaller.deserialize(r, n);
	}
	serialize(t, n) {
		const r = this.universalMarshaller.serialize(t, n);
		return typeof ReadableStream == "function" ? c4(r) : r;
	}
};
const f4 = (e) => typeof ReadableStream == "function" && e instanceof ReadableStream, d4 = (e) => new l4(e);
async function h4(e, t, n = 1024 * 1024) {
	const r = e.size;
	let s = 0;
	for (; s < r;) {
		const o = e.slice(s, Math.min(r, s + n));
		t(new Uint8Array(await o.arrayBuffer())), s += o.size;
	}
}
const p4 = async function(t, n) {
	const r = new t();
	return await h4(n, (s) => {
		r.update(s);
	}), r.digest();
}, g4 = (e) => () => Promise.reject(e), pi = 64, m4 = 16, y4 = [
	1732584193,
	4023233417,
	2562383102,
	271733878
];
var D4 = class {
	constructor() {
		P(this, "state");
		P(this, "buffer");
		P(this, "bufferLength");
		P(this, "bytesHashed");
		P(this, "finished");
		this.reset();
	}
	update(t) {
		if (w4(t)) return;
		if (this.finished) throw new Error("Attempted to update an already finished hash.");
		const n = b4(t);
		let r = 0, { byteLength: s } = n;
		for (this.bytesHashed += s; s > 0;) this.buffer.setUint8(this.bufferLength++, n[r++]), s--, this.bufferLength === pi && (this.hashBuffer(), this.bufferLength = 0);
	}
	async digest() {
		if (!this.finished) {
			const { buffer: n, bufferLength: r, bytesHashed: s } = this, o = s * 8;
			if (n.setUint8(this.bufferLength++, 128), r % pi >= pi - 8) {
				for (let u = this.bufferLength; u < pi; u++) n.setUint8(u, 0);
				this.hashBuffer(), this.bufferLength = 0;
			}
			for (let u = this.bufferLength; u < pi - 8; u++) n.setUint8(u, 0);
			n.setUint32(pi - 8, o >>> 0, !0), n.setUint32(pi - 4, Math.floor(o / 4294967296), !0), this.hashBuffer(), this.finished = !0;
		}
		const t = new DataView(new ArrayBuffer(m4));
		for (let n = 0; n < 4; n++) t.setUint32(n * 4, this.state[n], !0);
		return new Uint8Array(t.buffer, t.byteOffset, t.byteLength);
	}
	hashBuffer() {
		const { buffer: t, state: n } = this;
		let r = n[0], s = n[1], o = n[2], u = n[3];
		r = Yt(r, s, o, u, t.getUint32(0, !0), 7, 3614090360), u = Yt(u, r, s, o, t.getUint32(4, !0), 12, 3905402710), o = Yt(o, u, r, s, t.getUint32(8, !0), 17, 606105819), s = Yt(s, o, u, r, t.getUint32(12, !0), 22, 3250441966), r = Yt(r, s, o, u, t.getUint32(16, !0), 7, 4118548399), u = Yt(u, r, s, o, t.getUint32(20, !0), 12, 1200080426), o = Yt(o, u, r, s, t.getUint32(24, !0), 17, 2821735955), s = Yt(s, o, u, r, t.getUint32(28, !0), 22, 4249261313), r = Yt(r, s, o, u, t.getUint32(32, !0), 7, 1770035416), u = Yt(u, r, s, o, t.getUint32(36, !0), 12, 2336552879), o = Yt(o, u, r, s, t.getUint32(40, !0), 17, 4294925233), s = Yt(s, o, u, r, t.getUint32(44, !0), 22, 2304563134), r = Yt(r, s, o, u, t.getUint32(48, !0), 7, 1804603682), u = Yt(u, r, s, o, t.getUint32(52, !0), 12, 4254626195), o = Yt(o, u, r, s, t.getUint32(56, !0), 17, 2792965006), s = Yt(s, o, u, r, t.getUint32(60, !0), 22, 1236535329), r = Qt(r, s, o, u, t.getUint32(4, !0), 5, 4129170786), u = Qt(u, r, s, o, t.getUint32(24, !0), 9, 3225465664), o = Qt(o, u, r, s, t.getUint32(44, !0), 14, 643717713), s = Qt(s, o, u, r, t.getUint32(0, !0), 20, 3921069994), r = Qt(r, s, o, u, t.getUint32(20, !0), 5, 3593408605), u = Qt(u, r, s, o, t.getUint32(40, !0), 9, 38016083), o = Qt(o, u, r, s, t.getUint32(60, !0), 14, 3634488961), s = Qt(s, o, u, r, t.getUint32(16, !0), 20, 3889429448), r = Qt(r, s, o, u, t.getUint32(36, !0), 5, 568446438), u = Qt(u, r, s, o, t.getUint32(56, !0), 9, 3275163606), o = Qt(o, u, r, s, t.getUint32(12, !0), 14, 4107603335), s = Qt(s, o, u, r, t.getUint32(32, !0), 20, 1163531501), r = Qt(r, s, o, u, t.getUint32(52, !0), 5, 2850285829), u = Qt(u, r, s, o, t.getUint32(8, !0), 9, 4243563512), o = Qt(o, u, r, s, t.getUint32(28, !0), 14, 1735328473), s = Qt(s, o, u, r, t.getUint32(48, !0), 20, 2368359562), r = en(r, s, o, u, t.getUint32(20, !0), 4, 4294588738), u = en(u, r, s, o, t.getUint32(32, !0), 11, 2272392833), o = en(o, u, r, s, t.getUint32(44, !0), 16, 1839030562), s = en(s, o, u, r, t.getUint32(56, !0), 23, 4259657740), r = en(r, s, o, u, t.getUint32(4, !0), 4, 2763975236), u = en(u, r, s, o, t.getUint32(16, !0), 11, 1272893353), o = en(o, u, r, s, t.getUint32(28, !0), 16, 4139469664), s = en(s, o, u, r, t.getUint32(40, !0), 23, 3200236656), r = en(r, s, o, u, t.getUint32(52, !0), 4, 681279174), u = en(u, r, s, o, t.getUint32(0, !0), 11, 3936430074), o = en(o, u, r, s, t.getUint32(12, !0), 16, 3572445317), s = en(s, o, u, r, t.getUint32(24, !0), 23, 76029189), r = en(r, s, o, u, t.getUint32(36, !0), 4, 3654602809), u = en(u, r, s, o, t.getUint32(48, !0), 11, 3873151461), o = en(o, u, r, s, t.getUint32(60, !0), 16, 530742520), s = en(s, o, u, r, t.getUint32(8, !0), 23, 3299628645), r = tn(r, s, o, u, t.getUint32(0, !0), 6, 4096336452), u = tn(u, r, s, o, t.getUint32(28, !0), 10, 1126891415), o = tn(o, u, r, s, t.getUint32(56, !0), 15, 2878612391), s = tn(s, o, u, r, t.getUint32(20, !0), 21, 4237533241), r = tn(r, s, o, u, t.getUint32(48, !0), 6, 1700485571), u = tn(u, r, s, o, t.getUint32(12, !0), 10, 2399980690), o = tn(o, u, r, s, t.getUint32(40, !0), 15, 4293915773), s = tn(s, o, u, r, t.getUint32(4, !0), 21, 2240044497), r = tn(r, s, o, u, t.getUint32(32, !0), 6, 1873313359), u = tn(u, r, s, o, t.getUint32(60, !0), 10, 4264355552), o = tn(o, u, r, s, t.getUint32(24, !0), 15, 2734768916), s = tn(s, o, u, r, t.getUint32(52, !0), 21, 1309151649), r = tn(r, s, o, u, t.getUint32(16, !0), 6, 4149444226), u = tn(u, r, s, o, t.getUint32(44, !0), 10, 3174756917), o = tn(o, u, r, s, t.getUint32(8, !0), 15, 718787259), s = tn(s, o, u, r, t.getUint32(36, !0), 21, 3951481745), n[0] = r + n[0] & 4294967295, n[1] = s + n[1] & 4294967295, n[2] = o + n[2] & 4294967295, n[3] = u + n[3] & 4294967295;
	}
	reset() {
		this.state = Uint32Array.from(y4), this.buffer = new DataView(new ArrayBuffer(pi)), this.bufferLength = 0, this.bytesHashed = 0, this.finished = !1;
	}
};
function $u(e, t, n, r, s, o) {
	return t = (t + e & 4294967295) + (r + o & 4294967295) & 4294967295, (t << s | t >>> 32 - s) + n & 4294967295;
}
function Yt(e, t, n, r, s, o, u) {
	return $u(t & n | ~t & r, e, t, s, o, u);
}
function Qt(e, t, n, r, s, o, u) {
	return $u(t & r | n & ~r, e, t, s, o, u);
}
function en(e, t, n, r, s, o, u) {
	return $u(t ^ n ^ r, e, t, s, o, u);
}
function tn(e, t, n, r, s, o, u) {
	return $u(n ^ (t | ~r), e, t, s, o, u);
}
function w4(e) {
	return typeof e == "string" ? e.length === 0 : e.byteLength === 0;
}
function b4(e) {
	return typeof e == "string" ? Yr(e) : ArrayBuffer.isView(e) ? new Uint8Array(e.buffer, e.byteOffset, e.byteLength / Uint8Array.BYTES_PER_ELEMENT) : new Uint8Array(e);
}
const E4 = [
	"in-region",
	"cross-region",
	"mobile",
	"standard",
	"legacy"
], v4 = ({ defaultsMode: e } = {}) => VI(async () => {
	const t = typeof e == "function" ? await e() : e;
	switch (t == null ? void 0 : t.toLowerCase()) {
		case "auto": return Promise.resolve(S4() ? "mobile" : "standard");
		case "mobile":
		case "in-region":
		case "cross-region":
		case "standard":
		case "legacy": return Promise.resolve(t == null ? void 0 : t.toLocaleLowerCase());
		case void 0: return Promise.resolve("legacy");
		default: throw new Error(`Invalid parameter for "defaultsMode", expect ${E4.join(", ")}, got ${t}`);
	}
}), S4 = () => {
	var t;
	const e = window == null ? void 0 : window.navigator;
	if (e != null && e.connection) {
		const { effectiveType: n, rtt: r, downlink: s } = e == null ? void 0 : e.connection;
		if (typeof n == "string" && n !== "4g" || Number(r) > 100 || Number(s) < 10) return !0;
	}
	return ((t = e == null ? void 0 : e.userAgentData) == null ? void 0 : t.mobile) || typeof (e == null ? void 0 : e.maxTouchPoints) == "number" && (e == null ? void 0 : e.maxTouchPoints) > 1;
}, C4 = (e) => ({
	apiVersion: "2006-03-01",
	base64Decoder: (e == null ? void 0 : e.base64Decoder) ?? Rs,
	base64Encoder: (e == null ? void 0 : e.base64Encoder) ?? ji,
	disableHostPrefix: (e == null ? void 0 : e.disableHostPrefix) ?? !1,
	endpointProvider: (e == null ? void 0 : e.endpointProvider) ?? nb,
	extensions: (e == null ? void 0 : e.extensions) ?? [],
	getAwsChunkedEncodingStream: (e == null ? void 0 : e.getAwsChunkedEncodingStream) ?? fI,
	httpAuthSchemeProvider: (e == null ? void 0 : e.httpAuthSchemeProvider) ?? c6,
	httpAuthSchemes: (e == null ? void 0 : e.httpAuthSchemes) ?? [{
		schemeId: "aws.auth#sigv4",
		identityProvider: (t) => t.getIdentityProvider("aws.auth#sigv4"),
		signer: new HD()
	}, {
		schemeId: "aws.auth#sigv4a",
		identityProvider: (t) => t.getIdentityProvider("aws.auth#sigv4a"),
		signer: new jB()
	}],
	logger: (e == null ? void 0 : e.logger) ?? new xd(),
	protocol: (e == null ? void 0 : e.protocol) ?? qk,
	protocolSettings: (e == null ? void 0 : e.protocolSettings) ?? {
		defaultNamespace: "com.amazonaws.s3",
		xmlNamespace: "http://s3.amazonaws.com/doc/2006-03-01/",
		version: "2006-03-01",
		serviceTarget: "AmazonS3"
	},
	sdkStreamMixin: (e == null ? void 0 : e.sdkStreamMixin) ?? ZD,
	serviceId: (e == null ? void 0 : e.serviceId) ?? "S3",
	signerConstructor: (e == null ? void 0 : e.signerConstructor) ?? Td,
	signingEscapePath: (e == null ? void 0 : e.signingEscapePath) ?? !1,
	urlParser: (e == null ? void 0 : e.urlParser) ?? fu,
	useArnRegion: (e == null ? void 0 : e.useArnRegion) ?? void 0,
	utf8Decoder: (e == null ? void 0 : e.utf8Decoder) ?? Yr,
	utf8Encoder: (e == null ? void 0 : e.utf8Encoder) ?? Ki
}), x4 = (e) => {
	const t = v4(e), n = () => t().then(Ak), r = C4(e);
	return {
		...r,
		...e,
		runtime: "browser",
		defaultsMode: t,
		bodyLengthChecker: (e == null ? void 0 : e.bodyLengthChecker) ?? Ck,
		credentialDefaultProvider: (e == null ? void 0 : e.credentialDefaultProvider) ?? ((s) => () => Promise.reject(/* @__PURE__ */ new Error("Credential is missing"))),
		defaultUserAgentProvider: (e == null ? void 0 : e.defaultUserAgentProvider) ?? zN({
			serviceId: r.serviceId,
			clientVersion: SN.version
		}),
		eventStreamSerdeProvider: (e == null ? void 0 : e.eventStreamSerdeProvider) ?? d4,
		maxAttempts: (e == null ? void 0 : e.maxAttempts) ?? du,
		md5: (e == null ? void 0 : e.md5) ?? D4,
		region: (e == null ? void 0 : e.region) ?? g4("Region is missing"),
		requestHandler: Dd.create((e == null ? void 0 : e.requestHandler) ?? n),
		retryMode: (e == null ? void 0 : e.retryMode) ?? (async () => (await n()).retryMode || f8),
		sha1: (e == null ? void 0 : e.sha1) ?? kN,
		sha256: (e == null ? void 0 : e.sha256) ?? LN,
		streamCollector: (e == null ? void 0 : e.streamCollector) ?? WD,
		streamHasher: (e == null ? void 0 : e.streamHasher) ?? p4,
		useDualstackEndpoint: (e == null ? void 0 : e.useDualstackEndpoint) ?? (() => Promise.resolve(WT)),
		useFipsEndpoint: (e == null ? void 0 : e.useFipsEndpoint) ?? (() => Promise.resolve(KT))
	};
}, F4 = (e) => ({
	setRegion(t) {
		e.region = t;
	},
	region() {
		return e.region;
	}
}), A4 = (e) => ({ region: e.region() }), _4 = (e) => {
	const t = e.httpAuthSchemes;
	let n = e.httpAuthSchemeProvider, r = e.credentials;
	return {
		setHttpAuthScheme(s) {
			const o = t.findIndex((u) => u.schemeId === s.schemeId);
			o === -1 ? t.push(s) : t.splice(o, 1, s);
		},
		httpAuthSchemes() {
			return t;
		},
		setHttpAuthSchemeProvider(s) {
			n = s;
		},
		httpAuthSchemeProvider() {
			return n;
		},
		setCredentials(s) {
			r = s;
		},
		credentials() {
			return r;
		}
	};
}, B4 = (e) => ({
	httpAuthSchemes: e.httpAuthSchemes(),
	httpAuthSchemeProvider: e.httpAuthSchemeProvider(),
	credentials: e.credentials()
}), I4 = (e, t) => {
	const n = Object.assign(F4(e), Rk(e), PB(e), _4(e));
	return t.forEach((r) => r.configure(n)), Object.assign(e, A4(n), Tk(n), NB(n), B4(n));
};
var k4 = class extends xk {
	constructor(...[n]) {
		const r = x4(n || {});
		super(r);
		P(this, "config");
		this.initConfig = r;
		this.config = I4(VR(l6(XT(l8(JT(I8(mR(uT(f6(r)))))))), { session: [() => this, EN] }), (n == null ? void 0 : n.extensions) || []), this.middlewareStack.use(SI(this.config)), this.middlewareStack.use(GT(this.config)), this.middlewareStack.use(U8(this.config)), this.middlewareStack.use(e8(this.config)), this.middlewareStack.use(wR(this.config)), this.middlewareStack.use(vR(this.config)), this.middlewareStack.use(xR(this.config)), this.middlewareStack.use(ZB(this.config, {
			httpAuthSchemeParametersProvider: o6,
			identityProviderConfigProvider: async (B) => new qI({
				"aws.auth#sigv4": B.credentials,
				"aws.auth#sigv4a": B.credentials
			})
		})), this.middlewareStack.use(eI(this.config)), this.middlewareStack.use(sT(this.config)), this.middlewareStack.use($B(this.config)), this.middlewareStack.use(NR(this.config)), this.middlewareStack.use(HR(this.config)), this.middlewareStack.use(KR(this.config));
	}
	destroy() {
		super.destroy();
	}
};
function R4(e) {
	return (t) => async (n) => {
		const r = { ...n.input };
		for (const o of [{
			target: "SSECustomerKey",
			hash: "SSECustomerKeyMD5"
		}, {
			target: "CopySourceSSECustomerKey",
			hash: "CopySourceSSECustomerKeyMD5"
		}]) {
			const u = r[o.target];
			if (u) {
				let c;
				typeof u == "string" ? N4(u, e) ? c = e.base64Decoder(u) : (c = e.utf8Decoder(u), r[o.target] = e.base64Encoder(c)) : (c = ArrayBuffer.isView(u) ? new Uint8Array(u.buffer, u.byteOffset, u.byteLength) : new Uint8Array(u), r[o.target] = e.base64Encoder(c));
				const d = new e.md5();
				d.update(c), r[o.hash] = e.base64Encoder(await d.digest());
			}
		}
		return t({
			...n,
			input: r
		});
	};
}
const T4 = {
	name: "ssecMiddleware",
	step: "initialize",
	tags: ["SSE"],
	override: !0
}, P4 = (e) => ({ applyToStack: (t) => {
	t.add(R4(e), T4);
} });
function N4(e, t) {
	if (!/^(?:[A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e)) return !1;
	try {
		return t.base64Decoder(e).length === 32;
	} catch {
		return !1;
	}
}
var O4 = class extends Cd.classBuilder().ep({
	...sb,
	Bucket: {
		type: "contextParams",
		name: "Bucket"
	},
	Key: {
		type: "contextParams",
		name: "Key"
	}
}).m(function(t, n, r, s) {
	return [
		Pw(r, t.getEndpointParameterInstructions()),
		gR(r, {
			requestAlgorithmMember: {
				httpHeader: "x-amz-sdk-checksum-algorithm",
				name: "ChecksumAlgorithm"
			},
			requestChecksumRequired: !1
		}),
		IR(),
		Dw(r),
		P4(r)
	];
}).s("AmazonS3", "PutObject", {}).n("S3Client", "PutObjectCommand").sc(bN).build() {};
function U4(e) {
	const { port: t, query: n } = e;
	let { protocol: r, path: s, hostname: o } = e;
	r && r.slice(-1) !== ":" && (r += ":"), t && (o += `:${t}`), s && s.charAt(0) !== "/" && (s = `/${s}`);
	let u = n ? GD(n) : "";
	u && u[0] !== "?" && (u = `?${u}`);
	let c = "";
	if (e.username != null || e.password != null) c = `${e.username ?? ""}:${e.password ?? ""}@`;
	let d = "";
	return e.fragment && (d = `#${e.fragment}`), `${r}//${c}${o}${s}${u}${d}`;
}
const M4 = "UNSIGNED-PAYLOAD", $4 = "X-Amz-Content-Sha256";
var uy = class {
	constructor(t) {
		P(this, "signer");
		this.signer = new Td({
			service: t.signingName || t.service || "s3",
			uriEscapePath: t.uriEscapePath || !1,
			applyChecksum: t.applyChecksum || !1,
			...t
		});
	}
	presign(t, { unsignableHeaders: n = /* @__PURE__ */ new Set(), hoistableHeaders: r = /* @__PURE__ */ new Set(), unhoistableHeaders: s = /* @__PURE__ */ new Set(), ...o } = {}) {
		return this.prepareRequest(t, {
			unsignableHeaders: n,
			unhoistableHeaders: s,
			hoistableHeaders: r
		}), this.signer.presign(t, {
			expiresIn: 900,
			unsignableHeaders: n,
			unhoistableHeaders: s,
			...o
		});
	}
	presignWithCredentials(t, n, { unsignableHeaders: r = /* @__PURE__ */ new Set(), hoistableHeaders: s = /* @__PURE__ */ new Set(), unhoistableHeaders: o = /* @__PURE__ */ new Set(), ...u } = {}) {
		return this.prepareRequest(t, {
			unsignableHeaders: r,
			unhoistableHeaders: o,
			hoistableHeaders: s
		}), this.signer.presignWithCredentials(t, n, {
			expiresIn: 900,
			unsignableHeaders: r,
			unhoistableHeaders: o,
			...u
		});
	}
	prepareRequest(t, { unsignableHeaders: n = /* @__PURE__ */ new Set(), unhoistableHeaders: r = /* @__PURE__ */ new Set(), hoistableHeaders: s = /* @__PURE__ */ new Set() } = {}) {
		n.add("content-type"), Object.keys(t.headers).map((d) => d.toLowerCase()).filter((d) => d.startsWith("x-amz-server-side-encryption")).forEach((d) => {
			s.has(d) || r.add(d);
		}), t.headers[$4] = M4;
		const o = t.headers.host, u = t.port, c = `${t.hostname}${t.port != null ? ":" + u : ""}`;
		(!o || o === t.hostname && t.port != null) && (t.headers.host = c);
	}
};
const L4 = async (e, t, n = {}) => {
	var y, w, E;
	let r, s;
	if (typeof e.config.endpointProvider == "function") {
		const B = (w = (y = (await Rw(t.input, t.constructor, e.config)).properties) == null ? void 0 : y.authSchemes) == null ? void 0 : w[0];
		(B == null ? void 0 : B.name) === "sigv4a" ? s = (E = B == null ? void 0 : B.signingRegionSet) == null ? void 0 : E.join(",") : s = B == null ? void 0 : B.signingRegion, r = new uy({
			...e.config,
			signingName: B == null ? void 0 : B.signingName,
			region: async () => s
		});
	} else r = new uy(e.config);
	const o = (A, B) => async (T) => {
		const { request: $ } = T;
		if (!bt.isInstance($)) throw new Error("Request to be presigned is not an valid HTTP request.");
		delete $.headers["amz-sdk-invocation-id"], delete $.headers["amz-sdk-request"], delete $.headers["x-amz-user-agent"];
		let V;
		const H = {
			...n,
			signingRegion: n.signingRegion ?? B.signing_region ?? s,
			signingService: n.signingService ?? B.signing_service
		};
		return B.s3ExpressIdentity ? V = await r.presignWithCredentials($, B.s3ExpressIdentity, H) : V = await r.presign($, H), {
			response: {},
			output: {
				$metadata: { httpStatusCode: 200 },
				presigned: V
			}
		};
	}, u = "presignInterceptMiddleware", c = e.middlewareStack.clone();
	c.addRelativeTo(o, {
		name: u,
		relation: "before",
		toMiddleware: "awsAuthMiddleware",
		override: !0
	});
	const { output: f } = await t.resolveMiddleware(c, e.config, {})({ input: t.input }), { presigned: m } = f;
	return U4(m);
}, z4 = Cn("storageApi", !1);
const q4 = async () => (await Ve({
	app: "storage",
	path: "/configuration"
}))["storage-update"].configuration, j4 = async () => (await Ve({
	app: "storage",
	path: "/credentials"
}))["storage-update"].credentials, G4 = "https://memex.tlon.network", W4 = {
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/heic": ".heic",
	"image/heif": ".heif"
};
function K4(e) {
	return W4[e.toLowerCase()] || ".jpg";
}
function cy(e) {
	return !!(e != null && e.accessKeyId && e != null && e.endpoint && e != null && e.secretAccessKey);
}
async function dM(e) {
	const [t, n] = await Promise.all([q4(), j4()]), r = e.contentType || e.blob.type || "application/octet-stream", s = K4(r), o = e.fileName || `upload${s}`, c = `${_o(Ir())}/${_o(Wt("da", ur.fromUnix(Date.now())))}-${o}`;
	if (z4.log("uploading file", {
		fileKey: c,
		contentType: r,
		size: e.blob.size
	}), q3() && (t.service === "presigned-url" || !cy(n))) {
		const { hostedUrl: $, uploadUrl: V } = await Z4({
			contentLength: e.blob.size,
			contentType: r,
			fileName: c
		});
		return await fetch(V, {
			method: "PUT",
			body: e.blob,
			headers: {
				"Cache-Control": "public, max-age=3600",
				"Content-Type": r
			}
		}).then((H) => {
			if (!H.ok) throw new Error(`Upload failed: ${H.status}`);
		}), { url: $ };
	}
	if (!cy(n)) throw new Error("No storage credentials configured");
	const m = new URL(V4(n.endpoint)), y = new k4({
		endpoint: {
			protocol: m.protocol.slice(0, -1),
			hostname: m.host,
			path: m.pathname || "/"
		},
		region: t.region || "us-east-1",
		credentials: {
			accessKeyId: n.accessKeyId,
			secretAccessKey: n.secretAccessKey
		},
		forcePathStyle: !0
	}), w = {
		"Content-Type": r,
		"Cache-Control": "public, max-age=3600",
		"x-amz-acl": "public-read"
	}, A = await L4(y, new O4({
		Bucket: t.currentBucket,
		Key: c,
		ContentType: w["Content-Type"],
		CacheControl: w["Cache-Control"],
		ACL: "public-read"
	}), {
		expiresIn: 3600,
		signableHeaders: new Set(Object.keys(w))
	}), B = A.includes("digitaloceanspaces.com");
	return await fetch(A, {
		method: "PUT",
		body: e.blob,
		headers: B ? w : void 0
	}).then(($) => {
		if (!$.ok) throw new Error(`Upload failed: ${$.status}`);
	}), { url: t.publicUrlBase ? new URL(c, t.publicUrlBase).toString() : A.split("?")[0] };
}
function V4(e) {
	return e.match(/https?:\/\//) ? e : `https://${e}`;
}
async function Z4(e) {
	const t = Ir(), n = await Ve({
		app: "genuine",
		path: "/secret"
	}), r = `${G4}/v1/${_o(t)}/upload`, s = await fetch(r, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			token: n,
			...e
		})
	});
	if (!s.ok) throw new Error(`Memex upload request failed: ${s.status}`);
	const o = await s.json();
	if (!(o != null && o.url) || !(o != null && o.filePath)) throw new Error("Invalid response from Memex");
	return {
		hostedUrl: o.filePath,
		uploadUrl: o.url
	};
}
Cn("metagrabApi", !1);
var Ib = {}, Lu = {};
Lu.byteLength = oO;
Lu.toByteArray = uO;
Lu.fromByteArray = fO;
var vr = [], Jn = [], iO = typeof Uint8Array < "u" ? Uint8Array : Array, Vl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for (var ms = 0, sO = Vl.length; ms < sO; ++ms) vr[ms] = Vl[ms], Jn[Vl.charCodeAt(ms)] = ms;
Jn[45] = 62;
Jn[95] = 63;
function kb(e) {
	var t = e.length;
	if (t % 4 > 0) throw new Error("Invalid string. Length must be a multiple of 4");
	var n = e.indexOf("=");
	n === -1 && (n = t);
	var r = n === t ? 0 : 4 - n % 4;
	return [n, r];
}
function oO(e) {
	var t = kb(e), n = t[0], r = t[1];
	return (n + r) * 3 / 4 - r;
}
function aO(e, t, n) {
	return (t + n) * 3 / 4 - n;
}
function uO(e) {
	var t, n = kb(e), r = n[0], s = n[1], o = new iO(aO(e, r, s)), u = 0, c = s > 0 ? r - 4 : r, d;
	for (d = 0; d < c; d += 4) t = Jn[e.charCodeAt(d)] << 18 | Jn[e.charCodeAt(d + 1)] << 12 | Jn[e.charCodeAt(d + 2)] << 6 | Jn[e.charCodeAt(d + 3)], o[u++] = t >> 16 & 255, o[u++] = t >> 8 & 255, o[u++] = t & 255;
	return s === 2 && (t = Jn[e.charCodeAt(d)] << 2 | Jn[e.charCodeAt(d + 1)] >> 4, o[u++] = t & 255), s === 1 && (t = Jn[e.charCodeAt(d)] << 10 | Jn[e.charCodeAt(d + 1)] << 4 | Jn[e.charCodeAt(d + 2)] >> 2, o[u++] = t >> 8 & 255, o[u++] = t & 255), o;
}
function cO(e) {
	return vr[e >> 18 & 63] + vr[e >> 12 & 63] + vr[e >> 6 & 63] + vr[e & 63];
}
function lO(e, t, n) {
	for (var r, s = [], o = t; o < n; o += 3) r = (e[o] << 16 & 16711680) + (e[o + 1] << 8 & 65280) + (e[o + 2] & 255), s.push(cO(r));
	return s.join("");
}
function fO(e) {
	for (var t, n = e.length, r = n % 3, s = [], o = 16383, u = 0, c = n - r; u < c; u += o) s.push(lO(e, u, u + o > c ? c : u + o));
	return r === 1 ? (t = e[n - 1], s.push(vr[t >> 2] + vr[t << 4 & 63] + "==")) : r === 2 && (t = (e[n - 2] << 8) + e[n - 1], s.push(vr[t >> 10] + vr[t >> 4 & 63] + vr[t << 2 & 63] + "=")), s.join("");
}
var nh = {};
/*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> */
nh.read = function(e, t, n, r, s) {
	var o, u, c = s * 8 - r - 1, d = (1 << c) - 1, f = d >> 1, m = -7, y = n ? s - 1 : 0, w = n ? -1 : 1, E = e[t + y];
	for (y += w, o = E & (1 << -m) - 1, E >>= -m, m += c; m > 0; o = o * 256 + e[t + y], y += w, m -= 8);
	for (u = o & (1 << -m) - 1, o >>= -m, m += r; m > 0; u = u * 256 + e[t + y], y += w, m -= 8);
	if (o === 0) o = 1 - f;
	else {
		if (o === d) return u ? NaN : (E ? -1 : 1) * Infinity;
		u = u + Math.pow(2, r), o = o - f;
	}
	return (E ? -1 : 1) * u * Math.pow(2, o - r);
};
nh.write = function(e, t, n, r, s, o) {
	var u, c, d, f = o * 8 - s - 1, m = (1 << f) - 1, y = m >> 1, w = s === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0, E = r ? 0 : o - 1, A = r ? 1 : -1, B = t < 0 || t === 0 && 1 / t < 0 ? 1 : 0;
	for (t = Math.abs(t), isNaN(t) || t === Infinity ? (c = isNaN(t) ? 1 : 0, u = m) : (u = Math.floor(Math.log(t) / Math.LN2), t * (d = Math.pow(2, -u)) < 1 && (u--, d *= 2), u + y >= 1 ? t += w / d : t += w * Math.pow(2, 1 - y), t * d >= 2 && (u++, d /= 2), u + y >= m ? (c = 0, u = m) : u + y >= 1 ? (c = (t * d - 1) * Math.pow(2, s), u = u + y) : (c = t * Math.pow(2, y - 1) * Math.pow(2, s), u = 0)); s >= 8; e[n + E] = c & 255, E += A, c /= 256, s -= 8);
	for (u = u << s | c, f += s; f > 0; e[n + E] = u & 255, E += A, u /= 256, f -= 8);
	e[n + E - A] |= B * 128;
};
/*!
* The buffer module from node.js, for the browser.
*
* @author   Feross Aboukhadijeh <https://feross.org>
* @license  MIT
*/
(function(e) {
	const t = Lu, n = nh, r = typeof Symbol == "function" && typeof Symbol.for == "function" ? Symbol.for("nodejs.util.inspect.custom") : null;
	e.Buffer = c, e.SlowBuffer = V, e.INSPECT_MAX_BYTES = 50;
	const s = 2147483647;
	e.kMaxLength = s, c.TYPED_ARRAY_SUPPORT = o(), !c.TYPED_ARRAY_SUPPORT && typeof console < "u" && typeof console.error == "function" && console.error("This browser lacks typed array (Uint8Array) support which is required by `buffer` v5.x. Use `buffer` v4.x if you require old browser support.");
	function o() {
		try {
			const g = new Uint8Array(1), h = { foo: function() {
				return 42;
			} };
			return Object.setPrototypeOf(h, Uint8Array.prototype), Object.setPrototypeOf(g, h), g.foo() === 42;
		} catch {
			return !1;
		}
	}
	Object.defineProperty(c.prototype, "parent", {
		enumerable: !0,
		get: function() {
			if (c.isBuffer(this)) return this.buffer;
		}
	}), Object.defineProperty(c.prototype, "offset", {
		enumerable: !0,
		get: function() {
			if (c.isBuffer(this)) return this.byteOffset;
		}
	});
	function u(g) {
		if (g > s) throw new RangeError("The value \"" + g + "\" is invalid for option \"size\"");
		const h = new Uint8Array(g);
		return Object.setPrototypeOf(h, c.prototype), h;
	}
	function c(g, h, p) {
		if (typeof g == "number") {
			if (typeof h == "string") throw new TypeError("The \"string\" argument must be of type string. Received type number");
			return y(g);
		}
		return d(g, h, p);
	}
	c.poolSize = 8192;
	function d(g, h, p) {
		if (typeof g == "string") return w(g, h);
		if (ArrayBuffer.isView(g)) return A(g);
		if (g == null) throw new TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof g);
		if (kt(g, ArrayBuffer) || g && kt(g.buffer, ArrayBuffer) || typeof SharedArrayBuffer < "u" && (kt(g, SharedArrayBuffer) || g && kt(g.buffer, SharedArrayBuffer))) return B(g, h, p);
		if (typeof g == "number") throw new TypeError("The \"value\" argument must not be of type number. Received type number");
		const v = g.valueOf && g.valueOf();
		if (v != null && v !== g) return c.from(v, h, p);
		const C = T(g);
		if (C) return C;
		if (typeof Symbol < "u" && Symbol.toPrimitive != null && typeof g[Symbol.toPrimitive] == "function") return c.from(g[Symbol.toPrimitive]("string"), h, p);
		throw new TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof g);
	}
	c.from = function(g, h, p) {
		return d(g, h, p);
	}, Object.setPrototypeOf(c.prototype, Uint8Array.prototype), Object.setPrototypeOf(c, Uint8Array);
	function f(g) {
		if (typeof g != "number") throw new TypeError("\"size\" argument must be of type number");
		if (g < 0) throw new RangeError("The value \"" + g + "\" is invalid for option \"size\"");
	}
	function m(g, h, p) {
		return f(g), g <= 0 ? u(g) : h !== void 0 ? typeof p == "string" ? u(g).fill(h, p) : u(g).fill(h) : u(g);
	}
	c.alloc = function(g, h, p) {
		return m(g, h, p);
	};
	function y(g) {
		return f(g), u(g < 0 ? 0 : $(g) | 0);
	}
	c.allocUnsafe = function(g) {
		return y(g);
	}, c.allocUnsafeSlow = function(g) {
		return y(g);
	};
	function w(g, h) {
		if ((typeof h != "string" || h === "") && (h = "utf8"), !c.isEncoding(h)) throw new TypeError("Unknown encoding: " + h);
		const p = H(g, h) | 0;
		let v = u(p);
		const C = v.write(g, h);
		return C !== p && (v = v.slice(0, C)), v;
	}
	function E(g) {
		const h = g.length < 0 ? 0 : $(g.length) | 0, p = u(h);
		for (let v = 0; v < h; v += 1) p[v] = g[v] & 255;
		return p;
	}
	function A(g) {
		if (kt(g, Uint8Array)) {
			const h = new Uint8Array(g);
			return B(h.buffer, h.byteOffset, h.byteLength);
		}
		return E(g);
	}
	function B(g, h, p) {
		if (h < 0 || g.byteLength < h) throw new RangeError("\"offset\" is outside of buffer bounds");
		if (g.byteLength < h + (p || 0)) throw new RangeError("\"length\" is outside of buffer bounds");
		let v;
		return h === void 0 && p === void 0 ? v = new Uint8Array(g) : p === void 0 ? v = new Uint8Array(g, h) : v = new Uint8Array(g, h, p), Object.setPrototypeOf(v, c.prototype), v;
	}
	function T(g) {
		if (c.isBuffer(g)) {
			const h = $(g.length) | 0, p = u(h);
			return p.length === 0 || g.copy(p, 0, 0, h), p;
		}
		if (g.length !== void 0) return typeof g.length != "number" || pr(g.length) ? u(0) : E(g);
		if (g.type === "Buffer" && Array.isArray(g.data)) return E(g.data);
	}
	function $(g) {
		if (g >= s) throw new RangeError("Attempt to allocate Buffer larger than maximum size: 0x" + s.toString(16) + " bytes");
		return g | 0;
	}
	function V(g) {
		return +g != g && (g = 0), c.alloc(+g);
	}
	c.isBuffer = function(h) {
		return h != null && h._isBuffer === !0 && h !== c.prototype;
	}, c.compare = function(h, p) {
		if (kt(h, Uint8Array) && (h = c.from(h, h.offset, h.byteLength)), kt(p, Uint8Array) && (p = c.from(p, p.offset, p.byteLength)), !c.isBuffer(h) || !c.isBuffer(p)) throw new TypeError("The \"buf1\", \"buf2\" arguments must be one of type Buffer or Uint8Array");
		if (h === p) return 0;
		let v = h.length, C = p.length;
		for (let I = 0, R = Math.min(v, C); I < R; ++I) if (h[I] !== p[I]) {
			v = h[I], C = p[I];
			break;
		}
		return v < C ? -1 : C < v ? 1 : 0;
	}, c.isEncoding = function(h) {
		switch (String(h).toLowerCase()) {
			case "hex":
			case "utf8":
			case "utf-8":
			case "ascii":
			case "latin1":
			case "binary":
			case "base64":
			case "ucs2":
			case "ucs-2":
			case "utf16le":
			case "utf-16le": return !0;
			default: return !1;
		}
	}, c.concat = function(h, p) {
		if (!Array.isArray(h)) throw new TypeError("\"list\" argument must be an Array of Buffers");
		if (h.length === 0) return c.alloc(0);
		let v;
		if (p === void 0) for (p = 0, v = 0; v < h.length; ++v) p += h[v].length;
		const C = c.allocUnsafe(p);
		let I = 0;
		for (v = 0; v < h.length; ++v) {
			let R = h[v];
			if (kt(R, Uint8Array)) I + R.length > C.length ? (c.isBuffer(R) || (R = c.from(R)), R.copy(C, I)) : Uint8Array.prototype.set.call(C, R, I);
			else if (c.isBuffer(R)) R.copy(C, I);
			else throw new TypeError("\"list\" argument must be an Array of Buffers");
			I += R.length;
		}
		return C;
	};
	function H(g, h) {
		if (c.isBuffer(g)) return g.length;
		if (ArrayBuffer.isView(g) || kt(g, ArrayBuffer)) return g.byteLength;
		if (typeof g != "string") throw new TypeError("The \"string\" argument must be one of type string, Buffer, or ArrayBuffer. Received type " + typeof g);
		const p = g.length, v = arguments.length > 2 && arguments[2] === !0;
		if (!v && p === 0) return 0;
		let C = !1;
		for (;;) switch (h) {
			case "ascii":
			case "latin1":
			case "binary": return p;
			case "utf8":
			case "utf-8": return rn(g).length;
			case "ucs2":
			case "ucs-2":
			case "utf16le":
			case "utf-16le": return p * 2;
			case "hex": return p >>> 1;
			case "base64": return gn(g).length;
			default:
				if (C) return v ? -1 : rn(g).length;
				h = ("" + h).toLowerCase(), C = !0;
		}
	}
	c.byteLength = H;
	function Q(g, h, p) {
		let v = !1;
		if ((h === void 0 || h < 0) && (h = 0), h > this.length || ((p === void 0 || p > this.length) && (p = this.length), p <= 0) || (p >>>= 0, h >>>= 0, p <= h)) return "";
		for (g || (g = "utf8");;) switch (g) {
			case "hex": return er(this, h, p);
			case "utf8":
			case "utf-8": return ti(this, h, p);
			case "ascii": return Qn(this, h, p);
			case "latin1":
			case "binary": return Fn(this, h, p);
			case "base64": return $s(this, h, p);
			case "ucs2":
			case "ucs-2":
			case "utf16le":
			case "utf-16le": return hn(this, h, p);
			default:
				if (v) throw new TypeError("Unknown encoding: " + g);
				g = (g + "").toLowerCase(), v = !0;
		}
	}
	c.prototype._isBuffer = !0;
	function te(g, h, p) {
		const v = g[h];
		g[h] = g[p], g[p] = v;
	}
	c.prototype.swap16 = function() {
		const h = this.length;
		if (h % 2 !== 0) throw new RangeError("Buffer size must be a multiple of 16-bits");
		for (let p = 0; p < h; p += 2) te(this, p, p + 1);
		return this;
	}, c.prototype.swap32 = function() {
		const h = this.length;
		if (h % 4 !== 0) throw new RangeError("Buffer size must be a multiple of 32-bits");
		for (let p = 0; p < h; p += 4) te(this, p, p + 3), te(this, p + 1, p + 2);
		return this;
	}, c.prototype.swap64 = function() {
		const h = this.length;
		if (h % 8 !== 0) throw new RangeError("Buffer size must be a multiple of 64-bits");
		for (let p = 0; p < h; p += 8) te(this, p, p + 7), te(this, p + 1, p + 6), te(this, p + 2, p + 5), te(this, p + 3, p + 4);
		return this;
	}, c.prototype.toString = function() {
		const h = this.length;
		return h === 0 ? "" : arguments.length === 0 ? ti(this, 0, h) : Q.apply(this, arguments);
	}, c.prototype.toLocaleString = c.prototype.toString, c.prototype.equals = function(h) {
		if (!c.isBuffer(h)) throw new TypeError("Argument must be a Buffer");
		return this === h ? !0 : c.compare(this, h) === 0;
	}, c.prototype.inspect = function() {
		let h = "";
		const p = e.INSPECT_MAX_BYTES;
		return h = this.toString("hex", 0, p).replace(/(.{2})/g, "$1 ").trim(), this.length > p && (h += " ... "), "<Buffer " + h + ">";
	}, r && (c.prototype[r] = c.prototype.inspect), c.prototype.compare = function(h, p, v, C, I) {
		if (kt(h, Uint8Array) && (h = c.from(h, h.offset, h.byteLength)), !c.isBuffer(h)) throw new TypeError("The \"target\" argument must be one of type Buffer or Uint8Array. Received type " + typeof h);
		if (p === void 0 && (p = 0), v === void 0 && (v = h ? h.length : 0), C === void 0 && (C = 0), I === void 0 && (I = this.length), p < 0 || v > h.length || C < 0 || I > this.length) throw new RangeError("out of range index");
		if (C >= I && p >= v) return 0;
		if (C >= I) return -1;
		if (p >= v) return 1;
		if (p >>>= 0, v >>>= 0, C >>>= 0, I >>>= 0, this === h) return 0;
		let R = I - C, j = v - p;
		const ae = Math.min(R, j), de = this.slice(C, I), ce = h.slice(p, v);
		for (let me = 0; me < ae; ++me) if (de[me] !== ce[me]) {
			R = de[me], j = ce[me];
			break;
		}
		return R < j ? -1 : j < R ? 1 : 0;
	};
	function ge(g, h, p, v, C) {
		if (g.length === 0) return -1;
		if (typeof p == "string" ? (v = p, p = 0) : p > 2147483647 ? p = 2147483647 : p < -2147483648 && (p = -2147483648), p = +p, pr(p) && (p = C ? 0 : g.length - 1), p < 0 && (p = g.length + p), p >= g.length) {
			if (C) return -1;
			p = g.length - 1;
		} else if (p < 0) if (C) p = 0;
		else return -1;
		if (typeof h == "string" && (h = c.from(h, v)), c.isBuffer(h)) return h.length === 0 ? -1 : De(g, h, p, v, C);
		if (typeof h == "number") return h = h & 255, typeof Uint8Array.prototype.indexOf == "function" ? C ? Uint8Array.prototype.indexOf.call(g, h, p) : Uint8Array.prototype.lastIndexOf.call(g, h, p) : De(g, [h], p, v, C);
		throw new TypeError("val must be string, number or Buffer");
	}
	function De(g, h, p, v, C) {
		let I = 1, R = g.length, j = h.length;
		if (v !== void 0 && (v = String(v).toLowerCase(), v === "ucs2" || v === "ucs-2" || v === "utf16le" || v === "utf-16le")) {
			if (g.length < 2 || h.length < 2) return -1;
			I = 2, R /= 2, j /= 2, p /= 2;
		}
		function ae(ce, me) {
			return I === 1 ? ce[me] : ce.readUInt16BE(me * I);
		}
		let de;
		if (C) {
			let ce = -1;
			for (de = p; de < R; de++) if (ae(g, de) === ae(h, ce === -1 ? 0 : de - ce)) {
				if (ce === -1 && (ce = de), de - ce + 1 === j) return ce * I;
			} else ce !== -1 && (de -= de - ce), ce = -1;
		} else for (p + j > R && (p = R - j), de = p; de >= 0; de--) {
			let ce = !0;
			for (let me = 0; me < j; me++) if (ae(g, de + me) !== ae(h, me)) {
				ce = !1;
				break;
			}
			if (ce) return de;
		}
		return -1;
	}
	c.prototype.includes = function(h, p, v) {
		return this.indexOf(h, p, v) !== -1;
	}, c.prototype.indexOf = function(h, p, v) {
		return ge(this, h, p, v, !0);
	}, c.prototype.lastIndexOf = function(h, p, v) {
		return ge(this, h, p, v, !1);
	};
	function rt(g, h, p, v) {
		p = Number(p) || 0;
		const C = g.length - p;
		v ? (v = Number(v), v > C && (v = C)) : v = C;
		const I = h.length;
		v > I / 2 && (v = I / 2);
		let R;
		for (R = 0; R < v; ++R) {
			const j = parseInt(h.substr(R * 2, 2), 16);
			if (pr(j)) return R;
			g[p + R] = j;
		}
		return R;
	}
	function Je(g, h, p, v) {
		return It(rn(h, g.length - p), g, p, v);
	}
	function lr(g, h, p, v) {
		return It(Fi(h), g, p, v);
	}
	function Zi(g, h, p, v) {
		return It(gn(h), g, p, v);
	}
	function ei(g, h, p, v) {
		return It(Hs(h, g.length - p), g, p, v);
	}
	c.prototype.write = function(h, p, v, C) {
		if (p === void 0) C = "utf8", v = this.length, p = 0;
		else if (v === void 0 && typeof p == "string") C = p, v = this.length, p = 0;
		else if (isFinite(p)) p = p >>> 0, isFinite(v) ? (v = v >>> 0, C === void 0 && (C = "utf8")) : (C = v, v = void 0);
		else throw new Error("Buffer.write(string, encoding, offset[, length]) is no longer supported");
		const I = this.length - p;
		if ((v === void 0 || v > I) && (v = I), h.length > 0 && (v < 0 || p < 0) || p > this.length) throw new RangeError("Attempt to write outside buffer bounds");
		C || (C = "utf8");
		let R = !1;
		for (;;) switch (C) {
			case "hex": return rt(this, h, p, v);
			case "utf8":
			case "utf-8": return Je(this, h, p, v);
			case "ascii":
			case "latin1":
			case "binary": return lr(this, h, p, v);
			case "base64": return Zi(this, h, p, v);
			case "ucs2":
			case "ucs-2":
			case "utf16le":
			case "utf-16le": return ei(this, h, p, v);
			default:
				if (R) throw new TypeError("Unknown encoding: " + C);
				C = ("" + C).toLowerCase(), R = !0;
		}
	}, c.prototype.toJSON = function() {
		return {
			type: "Buffer",
			data: Array.prototype.slice.call(this._arr || this, 0)
		};
	};
	function $s(g, h, p) {
		return h === 0 && p === g.length ? t.fromByteArray(g) : t.fromByteArray(g.slice(h, p));
	}
	function ti(g, h, p) {
		p = Math.min(g.length, p);
		const v = [];
		let C = h;
		for (; C < p;) {
			const I = g[C];
			let R = null, j = I > 239 ? 4 : I > 223 ? 3 : I > 191 ? 2 : 1;
			if (C + j <= p) {
				let ae, de, ce, me;
				switch (j) {
					case 1:
						I < 128 && (R = I);
						break;
					case 2:
						ae = g[C + 1], (ae & 192) === 128 && (me = (I & 31) << 6 | ae & 63, me > 127 && (R = me));
						break;
					case 3:
						ae = g[C + 1], de = g[C + 2], (ae & 192) === 128 && (de & 192) === 128 && (me = (I & 15) << 12 | (ae & 63) << 6 | de & 63, me > 2047 && (me < 55296 || me > 57343) && (R = me));
						break;
					case 4: ae = g[C + 1], de = g[C + 2], ce = g[C + 3], (ae & 192) === 128 && (de & 192) === 128 && (ce & 192) === 128 && (me = (I & 15) << 18 | (ae & 63) << 12 | (de & 63) << 6 | ce & 63, me > 65535 && me < 1114112 && (R = me));
				}
			}
			R === null ? (R = 65533, j = 1) : R > 65535 && (R -= 65536, v.push(R >>> 10 & 1023 | 55296), R = 56320 | R & 1023), v.push(R), C += j;
		}
		return Ls(v);
	}
	const xi = 4096;
	function Ls(g) {
		const h = g.length;
		if (h <= xi) return String.fromCharCode.apply(String, g);
		let p = "", v = 0;
		for (; v < h;) p += String.fromCharCode.apply(String, g.slice(v, v += xi));
		return p;
	}
	function Qn(g, h, p) {
		let v = "";
		p = Math.min(g.length, p);
		for (let C = h; C < p; ++C) v += String.fromCharCode(g[C] & 127);
		return v;
	}
	function Fn(g, h, p) {
		let v = "";
		p = Math.min(g.length, p);
		for (let C = h; C < p; ++C) v += String.fromCharCode(g[C]);
		return v;
	}
	function er(g, h, p) {
		const v = g.length;
		(!h || h < 0) && (h = 0), (!p || p < 0 || p > v) && (p = v);
		let C = "";
		for (let I = h; I < p; ++I) C += be[g[I]];
		return C;
	}
	function hn(g, h, p) {
		const v = g.slice(h, p);
		let C = "";
		for (let I = 0; I < v.length - 1; I += 2) C += String.fromCharCode(v[I] + v[I + 1] * 256);
		return C;
	}
	c.prototype.slice = function(h, p) {
		const v = this.length;
		h = ~~h, p = p === void 0 ? v : ~~p, h < 0 ? (h += v, h < 0 && (h = 0)) : h > v && (h = v), p < 0 ? (p += v, p < 0 && (p = 0)) : p > v && (p = v), p < h && (p = h);
		const C = this.subarray(h, p);
		return Object.setPrototypeOf(C, c.prototype), C;
	};
	function He(g, h, p) {
		if (g % 1 !== 0 || g < 0) throw new RangeError("offset is not uint");
		if (g + h > p) throw new RangeError("Trying to access beyond buffer length");
	}
	c.prototype.readUintLE = c.prototype.readUIntLE = function(h, p, v) {
		h = h >>> 0, p = p >>> 0, v || He(h, p, this.length);
		let C = this[h], I = 1, R = 0;
		for (; ++R < p && (I *= 256);) C += this[h + R] * I;
		return C;
	}, c.prototype.readUintBE = c.prototype.readUIntBE = function(h, p, v) {
		h = h >>> 0, p = p >>> 0, v || He(h, p, this.length);
		let C = this[h + --p], I = 1;
		for (; p > 0 && (I *= 256);) C += this[h + --p] * I;
		return C;
	}, c.prototype.readUint8 = c.prototype.readUInt8 = function(h, p) {
		return h = h >>> 0, p || He(h, 1, this.length), this[h];
	}, c.prototype.readUint16LE = c.prototype.readUInt16LE = function(h, p) {
		return h = h >>> 0, p || He(h, 2, this.length), this[h] | this[h + 1] << 8;
	}, c.prototype.readUint16BE = c.prototype.readUInt16BE = function(h, p) {
		return h = h >>> 0, p || He(h, 2, this.length), this[h] << 8 | this[h + 1];
	}, c.prototype.readUint32LE = c.prototype.readUInt32LE = function(h, p) {
		return h = h >>> 0, p || He(h, 4, this.length), (this[h] | this[h + 1] << 8 | this[h + 2] << 16) + this[h + 3] * 16777216;
	}, c.prototype.readUint32BE = c.prototype.readUInt32BE = function(h, p) {
		return h = h >>> 0, p || He(h, 4, this.length), this[h] * 16777216 + (this[h + 1] << 16 | this[h + 2] << 8 | this[h + 3]);
	}, c.prototype.readBigUInt64LE = ut(function(h) {
		h = h >>> 0, An(h, "offset");
		const p = this[h], v = this[h + 7];
		(p === void 0 || v === void 0) && Ct(h, this.length - 8);
		const C = p + this[++h] * 2 ** 8 + this[++h] * 2 ** 16 + this[++h] * 2 ** 24, I = this[++h] + this[++h] * 2 ** 8 + this[++h] * 2 ** 16 + v * 2 ** 24;
		return BigInt(C) + (BigInt(I) << BigInt(32));
	}), c.prototype.readBigUInt64BE = ut(function(h) {
		h = h >>> 0, An(h, "offset");
		const p = this[h], v = this[h + 7];
		(p === void 0 || v === void 0) && Ct(h, this.length - 8);
		const C = p * 2 ** 24 + this[++h] * 2 ** 16 + this[++h] * 2 ** 8 + this[++h], I = this[++h] * 2 ** 24 + this[++h] * 2 ** 16 + this[++h] * 2 ** 8 + v;
		return (BigInt(C) << BigInt(32)) + BigInt(I);
	}), c.prototype.readIntLE = function(h, p, v) {
		h = h >>> 0, p = p >>> 0, v || He(h, p, this.length);
		let C = this[h], I = 1, R = 0;
		for (; ++R < p && (I *= 256);) C += this[h + R] * I;
		return I *= 128, C >= I && (C -= Math.pow(2, 8 * p)), C;
	}, c.prototype.readIntBE = function(h, p, v) {
		h = h >>> 0, p = p >>> 0, v || He(h, p, this.length);
		let C = p, I = 1, R = this[h + --C];
		for (; C > 0 && (I *= 256);) R += this[h + --C] * I;
		return I *= 128, R >= I && (R -= Math.pow(2, 8 * p)), R;
	}, c.prototype.readInt8 = function(h, p) {
		return h = h >>> 0, p || He(h, 1, this.length), this[h] & 128 ? (255 - this[h] + 1) * -1 : this[h];
	}, c.prototype.readInt16LE = function(h, p) {
		h = h >>> 0, p || He(h, 2, this.length);
		const v = this[h] | this[h + 1] << 8;
		return v & 32768 ? v | 4294901760 : v;
	}, c.prototype.readInt16BE = function(h, p) {
		h = h >>> 0, p || He(h, 2, this.length);
		const v = this[h + 1] | this[h] << 8;
		return v & 32768 ? v | 4294901760 : v;
	}, c.prototype.readInt32LE = function(h, p) {
		return h = h >>> 0, p || He(h, 4, this.length), this[h] | this[h + 1] << 8 | this[h + 2] << 16 | this[h + 3] << 24;
	}, c.prototype.readInt32BE = function(h, p) {
		return h = h >>> 0, p || He(h, 4, this.length), this[h] << 24 | this[h + 1] << 16 | this[h + 2] << 8 | this[h + 3];
	}, c.prototype.readBigInt64LE = ut(function(h) {
		h = h >>> 0, An(h, "offset");
		const p = this[h], v = this[h + 7];
		(p === void 0 || v === void 0) && Ct(h, this.length - 8);
		const C = this[h + 4] + this[h + 5] * 2 ** 8 + this[h + 6] * 2 ** 16 + (v << 24);
		return (BigInt(C) << BigInt(32)) + BigInt(p + this[++h] * 2 ** 8 + this[++h] * 2 ** 16 + this[++h] * 2 ** 24);
	}), c.prototype.readBigInt64BE = ut(function(h) {
		h = h >>> 0, An(h, "offset");
		const p = this[h], v = this[h + 7];
		(p === void 0 || v === void 0) && Ct(h, this.length - 8);
		const C = (p << 24) + this[++h] * 2 ** 16 + this[++h] * 2 ** 8 + this[++h];
		return (BigInt(C) << BigInt(32)) + BigInt(this[++h] * 2 ** 24 + this[++h] * 2 ** 16 + this[++h] * 2 ** 8 + v);
	}), c.prototype.readFloatLE = function(h, p) {
		return h = h >>> 0, p || He(h, 4, this.length), n.read(this, h, !0, 23, 4);
	}, c.prototype.readFloatBE = function(h, p) {
		return h = h >>> 0, p || He(h, 4, this.length), n.read(this, h, !1, 23, 4);
	}, c.prototype.readDoubleLE = function(h, p) {
		return h = h >>> 0, p || He(h, 8, this.length), n.read(this, h, !0, 52, 8);
	}, c.prototype.readDoubleBE = function(h, p) {
		return h = h >>> 0, p || He(h, 8, this.length), n.read(this, h, !1, 52, 8);
	};
	function St(g, h, p, v, C, I) {
		if (!c.isBuffer(g)) throw new TypeError("\"buffer\" argument must be a Buffer instance");
		if (h > C || h < I) throw new RangeError("\"value\" argument is out of bounds");
		if (p + v > g.length) throw new RangeError("Index out of range");
	}
	c.prototype.writeUintLE = c.prototype.writeUIntLE = function(h, p, v, C) {
		if (h = +h, p = p >>> 0, v = v >>> 0, !C) {
			const j = Math.pow(2, 8 * v) - 1;
			St(this, h, p, v, j, 0);
		}
		let I = 1, R = 0;
		for (this[p] = h & 255; ++R < v && (I *= 256);) this[p + R] = h / I & 255;
		return p + v;
	}, c.prototype.writeUintBE = c.prototype.writeUIntBE = function(h, p, v, C) {
		if (h = +h, p = p >>> 0, v = v >>> 0, !C) {
			const j = Math.pow(2, 8 * v) - 1;
			St(this, h, p, v, j, 0);
		}
		let I = v - 1, R = 1;
		for (this[p + I] = h & 255; --I >= 0 && (R *= 256);) this[p + I] = h / R & 255;
		return p + v;
	}, c.prototype.writeUint8 = c.prototype.writeUInt8 = function(h, p, v) {
		return h = +h, p = p >>> 0, v || St(this, h, p, 1, 255, 0), this[p] = h & 255, p + 1;
	}, c.prototype.writeUint16LE = c.prototype.writeUInt16LE = function(h, p, v) {
		return h = +h, p = p >>> 0, v || St(this, h, p, 2, 65535, 0), this[p] = h & 255, this[p + 1] = h >>> 8, p + 2;
	}, c.prototype.writeUint16BE = c.prototype.writeUInt16BE = function(h, p, v) {
		return h = +h, p = p >>> 0, v || St(this, h, p, 2, 65535, 0), this[p] = h >>> 8, this[p + 1] = h & 255, p + 2;
	}, c.prototype.writeUint32LE = c.prototype.writeUInt32LE = function(h, p, v) {
		return h = +h, p = p >>> 0, v || St(this, h, p, 4, 4294967295, 0), this[p + 3] = h >>> 24, this[p + 2] = h >>> 16, this[p + 1] = h >>> 8, this[p] = h & 255, p + 4;
	}, c.prototype.writeUint32BE = c.prototype.writeUInt32BE = function(h, p, v) {
		return h = +h, p = p >>> 0, v || St(this, h, p, 4, 4294967295, 0), this[p] = h >>> 24, this[p + 1] = h >>> 16, this[p + 2] = h >>> 8, this[p + 3] = h & 255, p + 4;
	};
	function pn(g, h, p, v, C) {
		hr(h, v, C, g, p, 7);
		let I = Number(h & BigInt(4294967295));
		g[p++] = I, I = I >> 8, g[p++] = I, I = I >> 8, g[p++] = I, I = I >> 8, g[p++] = I;
		let R = Number(h >> BigInt(32) & BigInt(4294967295));
		return g[p++] = R, R = R >> 8, g[p++] = R, R = R >> 8, g[p++] = R, R = R >> 8, g[p++] = R, p;
	}
	function fr(g, h, p, v, C) {
		hr(h, v, C, g, p, 7);
		let I = Number(h & BigInt(4294967295));
		g[p + 7] = I, I = I >> 8, g[p + 6] = I, I = I >> 8, g[p + 5] = I, I = I >> 8, g[p + 4] = I;
		let R = Number(h >> BigInt(32) & BigInt(4294967295));
		return g[p + 3] = R, R = R >> 8, g[p + 2] = R, R = R >> 8, g[p + 1] = R, R = R >> 8, g[p] = R, p + 8;
	}
	c.prototype.writeBigUInt64LE = ut(function(h, p = 0) {
		return pn(this, h, p, BigInt(0), BigInt("0xffffffffffffffff"));
	}), c.prototype.writeBigUInt64BE = ut(function(h, p = 0) {
		return fr(this, h, p, BigInt(0), BigInt("0xffffffffffffffff"));
	}), c.prototype.writeIntLE = function(h, p, v, C) {
		if (h = +h, p = p >>> 0, !C) {
			const ae = Math.pow(2, 8 * v - 1);
			St(this, h, p, v, ae - 1, -ae);
		}
		let I = 0, R = 1, j = 0;
		for (this[p] = h & 255; ++I < v && (R *= 256);) h < 0 && j === 0 && this[p + I - 1] !== 0 && (j = 1), this[p + I] = (h / R >> 0) - j & 255;
		return p + v;
	}, c.prototype.writeIntBE = function(h, p, v, C) {
		if (h = +h, p = p >>> 0, !C) {
			const ae = Math.pow(2, 8 * v - 1);
			St(this, h, p, v, ae - 1, -ae);
		}
		let I = v - 1, R = 1, j = 0;
		for (this[p + I] = h & 255; --I >= 0 && (R *= 256);) h < 0 && j === 0 && this[p + I + 1] !== 0 && (j = 1), this[p + I] = (h / R >> 0) - j & 255;
		return p + v;
	}, c.prototype.writeInt8 = function(h, p, v) {
		return h = +h, p = p >>> 0, v || St(this, h, p, 1, 127, -128), h < 0 && (h = 255 + h + 1), this[p] = h & 255, p + 1;
	}, c.prototype.writeInt16LE = function(h, p, v) {
		return h = +h, p = p >>> 0, v || St(this, h, p, 2, 32767, -32768), this[p] = h & 255, this[p + 1] = h >>> 8, p + 2;
	}, c.prototype.writeInt16BE = function(h, p, v) {
		return h = +h, p = p >>> 0, v || St(this, h, p, 2, 32767, -32768), this[p] = h >>> 8, this[p + 1] = h & 255, p + 2;
	}, c.prototype.writeInt32LE = function(h, p, v) {
		return h = +h, p = p >>> 0, v || St(this, h, p, 4, 2147483647, -2147483648), this[p] = h & 255, this[p + 1] = h >>> 8, this[p + 2] = h >>> 16, this[p + 3] = h >>> 24, p + 4;
	}, c.prototype.writeInt32BE = function(h, p, v) {
		return h = +h, p = p >>> 0, v || St(this, h, p, 4, 2147483647, -2147483648), h < 0 && (h = 4294967295 + h + 1), this[p] = h >>> 24, this[p + 1] = h >>> 16, this[p + 2] = h >>> 8, this[p + 3] = h & 255, p + 4;
	}, c.prototype.writeBigInt64LE = ut(function(h, p = 0) {
		return pn(this, h, p, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
	}), c.prototype.writeBigInt64BE = ut(function(h, p = 0) {
		return fr(this, h, p, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
	});
	function zt(g, h, p, v, C, I) {
		if (p + v > g.length) throw new RangeError("Index out of range");
		if (p < 0) throw new RangeError("Index out of range");
	}
	function dr(g, h, p, v, C) {
		return h = +h, p = p >>> 0, C || zt(g, h, p, 4), n.write(g, h, p, v, 23, 4), p + 4;
	}
	c.prototype.writeFloatLE = function(h, p, v) {
		return dr(this, h, p, !0, v);
	}, c.prototype.writeFloatBE = function(h, p, v) {
		return dr(this, h, p, !1, v);
	};
	function ni(g, h, p, v, C) {
		return h = +h, p = p >>> 0, C || zt(g, h, p, 8), n.write(g, h, p, v, 52, 8), p + 8;
	}
	c.prototype.writeDoubleLE = function(h, p, v) {
		return ni(this, h, p, !0, v);
	}, c.prototype.writeDoubleBE = function(h, p, v) {
		return ni(this, h, p, !1, v);
	}, c.prototype.copy = function(h, p, v, C) {
		if (!c.isBuffer(h)) throw new TypeError("argument should be a Buffer");
		if (v || (v = 0), !C && C !== 0 && (C = this.length), p >= h.length && (p = h.length), p || (p = 0), C > 0 && C < v && (C = v), C === v || h.length === 0 || this.length === 0) return 0;
		if (p < 0) throw new RangeError("targetStart out of bounds");
		if (v < 0 || v >= this.length) throw new RangeError("Index out of range");
		if (C < 0) throw new RangeError("sourceEnd out of bounds");
		C > this.length && (C = this.length), h.length - p < C - v && (C = h.length - p + v);
		const I = C - v;
		return this === h && typeof Uint8Array.prototype.copyWithin == "function" ? this.copyWithin(p, v, C) : Uint8Array.prototype.set.call(h, this.subarray(v, C), p), I;
	}, c.prototype.fill = function(h, p, v, C) {
		if (typeof h == "string") {
			if (typeof p == "string" ? (C = p, p = 0, v = this.length) : typeof v == "string" && (C = v, v = this.length), C !== void 0 && typeof C != "string") throw new TypeError("encoding must be a string");
			if (typeof C == "string" && !c.isEncoding(C)) throw new TypeError("Unknown encoding: " + C);
			if (h.length === 1) {
				const R = h.charCodeAt(0);
				(C === "utf8" && R < 128 || C === "latin1") && (h = R);
			}
		} else typeof h == "number" ? h = h & 255 : typeof h == "boolean" && (h = Number(h));
		if (p < 0 || this.length < p || this.length < v) throw new RangeError("Out of range index");
		if (v <= p) return this;
		p = p >>> 0, v = v === void 0 ? this.length : v >>> 0, h || (h = 0);
		let I;
		if (typeof h == "number") for (I = p; I < v; ++I) this[I] = h;
		else {
			const R = c.isBuffer(h) ? h : c.from(h, C), j = R.length;
			if (j === 0) throw new TypeError("The value \"" + h + "\" is invalid for argument \"value\"");
			for (I = 0; I < v - p; ++I) this[I + p] = R[I % j];
		}
		return this;
	};
	const Kt = {};
	function tr(g, h, p) {
		Kt[g] = class extends p {
			constructor() {
				super(), Object.defineProperty(this, "message", {
					value: h.apply(this, arguments),
					writable: !0,
					configurable: !0
				}), this.name = `${this.name} [${g}]`, this.stack, delete this.name;
			}
			get code() {
				return g;
			}
			set code(C) {
				Object.defineProperty(this, "code", {
					configurable: !0,
					enumerable: !0,
					value: C,
					writable: !0
				});
			}
			toString() {
				return `${this.name} [${g}]: ${this.message}`;
			}
		};
	}
	tr("ERR_BUFFER_OUT_OF_BOUNDS", function(g) {
		return g ? `${g} is outside of buffer bounds` : "Attempt to access memory outside buffer bounds";
	}, RangeError), tr("ERR_INVALID_ARG_TYPE", function(g, h) {
		return `The "${g}" argument must be of type number. Received type ${typeof h}`;
	}, TypeError), tr("ERR_OUT_OF_RANGE", function(g, h, p) {
		let v = `The value of "${g}" is out of range.`, C = p;
		return Number.isInteger(p) && Math.abs(p) > 2 ** 32 ? C = kr(String(p)) : typeof p == "bigint" && (C = String(p), (p > BigInt(2) ** BigInt(32) || p < -(BigInt(2) ** BigInt(32))) && (C = kr(C)), C += "n"), v += ` It must be ${h}. Received ${C}`, v;
	}, RangeError);
	function kr(g) {
		let h = "", p = g.length;
		const v = g[0] === "-" ? 1 : 0;
		for (; p >= v + 4; p -= 3) h = `_${g.slice(p - 3, p)}${h}`;
		return `${g.slice(0, p)}${h}`;
	}
	function Rr(g, h, p) {
		An(h, "offset"), (g[h] === void 0 || g[h + p] === void 0) && Ct(h, g.length - (p + 1));
	}
	function hr(g, h, p, v, C, I) {
		if (g > p || g < h) {
			const R = typeof h == "bigint" ? "n" : "";
			let j;
			throw h === 0 || h === BigInt(0) ? j = `>= 0${R} and < 2${R} ** ${(I + 1) * 8}${R}` : j = `>= -(2${R} ** ${(I + 1) * 8 - 1}${R}) and < 2 ** ${(I + 1) * 8 - 1}${R}`, new Kt.ERR_OUT_OF_RANGE("value", j, g);
		}
		Rr(v, C, I);
	}
	function An(g, h) {
		if (typeof g != "number") throw new Kt.ERR_INVALID_ARG_TYPE(h, "number", g);
	}
	function Ct(g, h, p) {
		throw Math.floor(g) !== g ? (An(g, p), new Kt.ERR_OUT_OF_RANGE("offset", "an integer", g)) : h < 0 ? new Kt.ERR_BUFFER_OUT_OF_BOUNDS() : new Kt.ERR_OUT_OF_RANGE("offset", `>= 0 and <= ${h}`, g);
	}
	const Tr = /[^+/0-9A-Za-z-_]/g;
	function zs(g) {
		if (g = g.split("=")[0], g = g.trim().replace(Tr, ""), g.length < 2) return "";
		for (; g.length % 4 !== 0;) g = g + "=";
		return g;
	}
	function rn(g, h) {
		h = h || Infinity;
		let p;
		const v = g.length;
		let C = null;
		const I = [];
		for (let R = 0; R < v; ++R) {
			if (p = g.charCodeAt(R), p > 55295 && p < 57344) {
				if (!C) {
					if (p > 56319) {
						(h -= 3) > -1 && I.push(239, 191, 189);
						continue;
					} else if (R + 1 === v) {
						(h -= 3) > -1 && I.push(239, 191, 189);
						continue;
					}
					C = p;
					continue;
				}
				if (p < 56320) {
					(h -= 3) > -1 && I.push(239, 191, 189), C = p;
					continue;
				}
				p = (C - 55296 << 10 | p - 56320) + 65536;
			} else C && (h -= 3) > -1 && I.push(239, 191, 189);
			if (C = null, p < 128) {
				if ((h -= 1) < 0) break;
				I.push(p);
			} else if (p < 2048) {
				if ((h -= 2) < 0) break;
				I.push(p >> 6 | 192, p & 63 | 128);
			} else if (p < 65536) {
				if ((h -= 3) < 0) break;
				I.push(p >> 12 | 224, p >> 6 & 63 | 128, p & 63 | 128);
			} else if (p < 1114112) {
				if ((h -= 4) < 0) break;
				I.push(p >> 18 | 240, p >> 12 & 63 | 128, p >> 6 & 63 | 128, p & 63 | 128);
			} else throw new Error("Invalid code point");
		}
		return I;
	}
	function Fi(g) {
		const h = [];
		for (let p = 0; p < g.length; ++p) h.push(g.charCodeAt(p) & 255);
		return h;
	}
	function Hs(g, h) {
		let p, v, C;
		const I = [];
		for (let R = 0; R < g.length && !((h -= 2) < 0); ++R) p = g.charCodeAt(R), v = p >> 8, C = p % 256, I.push(C), I.push(v);
		return I;
	}
	function gn(g) {
		return t.toByteArray(zs(g));
	}
	function It(g, h, p, v) {
		let C;
		for (C = 0; C < v && !(C + p >= h.length || C >= g.length); ++C) h[C + p] = g[C];
		return C;
	}
	function kt(g, h) {
		return g instanceof h || g != null && g.constructor != null && g.constructor.name != null && g.constructor.name === h.name;
	}
	function pr(g) {
		return g !== g;
	}
	const be = function() {
		const g = "0123456789abcdef", h = new Array(256);
		for (let p = 0; p < 16; ++p) {
			const v = p * 16;
			for (let C = 0; C < 16; ++C) h[v + C] = g[p] + g[C];
		}
		return h;
	}();
	function ut(g) {
		return typeof BigInt > "u" ? S : g;
	}
	function S() {
		throw new Error("BigInt not supported");
	}
})(Ib);
Cn("hostingApi", !1);
var wO = class {
	constructor({ marshaller: t, serializer: n, deserializer: r, serdeContext: s, defaultContentType: o }) {
		P(this, "marshaller");
		P(this, "serializer");
		P(this, "deserializer");
		P(this, "serdeContext");
		P(this, "defaultContentType");
		this.marshaller = t, this.serializer = n, this.deserializer = r, this.serdeContext = s, this.defaultContentType = o;
	}
	async serializeEventStream({ eventStream: t, requestSchema: n, initialRequest: r }) {
		const s = this.marshaller, o = n.getEventStreamMember(), u = n.getMemberSchema(o), c = this.serializer, d = this.defaultContentType, f = Symbol("initialRequestMarker"), m = { async *[Symbol.asyncIterator]() {
			if (r) {
				const y = {
					":event-type": {
						type: "string",
						value: "initial-request"
					},
					":message-type": {
						type: "string",
						value: "event"
					},
					":content-type": {
						type: "string",
						value: d
					}
				};
				c.write(n, r);
				const w = c.flush();
				yield {
					[f]: !0,
					headers: y,
					body: w
				};
			}
			for await (const y of t) yield y;
		} };
		return s.serialize(m, (y) => {
			if (y[f]) return {
				headers: y.headers,
				body: y.body
			};
			const w = Object.keys(y).find((V) => V !== "__type") ?? "", { additionalHeaders: E, body: A, eventType: B, explicitPayloadContentType: T } = this.writeEventBody(w, u, y);
			return {
				headers: {
					":event-type": {
						type: "string",
						value: B
					},
					":message-type": {
						type: "string",
						value: "event"
					},
					":content-type": {
						type: "string",
						value: T ?? d
					},
					...E
				},
				body: A
			};
		});
	}
	async deserializeEventStream({ response: t, responseSchema: n, initialResponseContainer: r }) {
		var w;
		const s = this.marshaller, o = n.getEventStreamMember(), c = n.getMemberSchema(o).getMemberSchemas(), d = Symbol("initialResponseMarker"), f = s.deserialize(t.body, async (E) => {
			var T, $;
			const A = Object.keys(E).find((V) => V !== "__type") ?? "", B = E[A].body;
			if (A === "initial-response") {
				const V = await this.deserializer.read(n, B);
				return delete V[o], {
					[d]: !0,
					...V
				};
			} else if (A in c) {
				const V = c[A];
				if (V.isStructSchema()) {
					const H = {};
					let Q = !1;
					for (const [te, ge] of V.structIterator()) {
						const { eventHeader: De, eventPayload: rt } = ge.getMergedTraits();
						if (Q = Q || !!(De || rt), rt) ge.isBlobSchema() ? H[te] = B : ge.isStringSchema() ? H[te] = (((T = this.serdeContext) == null ? void 0 : T.utf8Encoder) ?? Ki)(B) : ge.isStructSchema() && (H[te] = await this.deserializer.read(ge, B));
						else if (De) {
							const Je = ($ = E[A].headers[te]) == null ? void 0 : $.value;
							Je != null && (ge.isNumericSchema() ? Je && typeof Je == "object" && "bytes" in Je ? H[te] = BigInt(Je.toString()) : H[te] = Number(Je) : H[te] = Je);
						}
					}
					if (Q) return { [A]: H };
					if (B.byteLength === 0) return { [A]: {} };
				}
				return { [A]: await this.deserializer.read(V, B) };
			} else return { $unknown: E };
		}), m = f[Symbol.asyncIterator](), y = await m.next();
		if (y.done) return f;
		if ((w = y.value) != null && w[d]) {
			if (!n) throw new Error("@smithy::core/protocols - initial-response event encountered in event stream but no response schema given.");
			for (const [E, A] of Object.entries(y.value)) r[E] = A;
		}
		return { async *[Symbol.asyncIterator]() {
			var E;
			for ((E = y == null ? void 0 : y.value) != null && E[d] || (yield y.value);;) {
				const { done: A, value: B } = await m.next();
				if (A) break;
				yield B;
			}
		} };
	}
	writeEventBody(t, n, r) {
		var w;
		const s = this.serializer;
		let o = t, u = null, c;
		const d = n.getSchema()[4].includes(t), f = {};
		if (d) {
			const E = n.getMemberSchema(t);
			if (E.isStructSchema()) {
				for (const [A, B] of E.structIterator()) {
					const { eventHeader: T, eventPayload: $ } = B.getMergedTraits();
					if ($) u = A;
					else if (T) {
						const V = r[t][A];
						let H = "binary";
						B.isNumericSchema() ? (-2) ** 31 <= V && V <= 2 ** 31 - 1 ? H = "integer" : H = "long" : B.isTimestampSchema() ? H = "timestamp" : B.isStringSchema() ? H = "string" : B.isBooleanSchema() && (H = "boolean"), V != null && (f[A] = {
							type: H,
							value: V
						}, delete r[t][A]);
					}
				}
				if (u !== null) {
					const A = E.getMemberSchema(u);
					A.isBlobSchema() ? c = "application/octet-stream" : A.isStringSchema() && (c = "text/plain"), s.write(A, r[t][u]);
				} else s.write(E, r[t]);
			} else throw new Error("@smithy/core/event-streams - non-struct member not supported in event stream union.");
		} else {
			const [E, A] = r[t];
			o = E, s.write(15, A);
		}
		const m = s.flush();
		return {
			body: typeof m == "string" ? (((w = this.serdeContext) == null ? void 0 : w.utf8Decoder) ?? Yr)(m) : m,
			eventType: o,
			explicitPayloadContentType: c,
			additionalHeaders: f
		};
	}
};
const bO = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
	__proto__: null,
	EventStreamSerde: wO
}, Symbol.toStringTag, { value: "Module" }));
//#endregion
//#region extensions/tlon/src/config-schema.ts
const ShipSchema = z.string().min(1);
const ChannelNestSchema = z.string().min(1);
const TlonChannelRuleSchema = z.object({
	mode: z.enum(["restricted", "open"]).optional(),
	allowedShips: z.array(ShipSchema).optional()
});
const TlonAuthorizationSchema = z.object({ channelRules: z.record(z.string(), TlonChannelRuleSchema).optional() });
const tlonCommonConfigFields = {
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	ship: ShipSchema.optional(),
	url: z.string().optional(),
	code: z.string().optional(),
	allowPrivateNetwork: z.boolean().optional(),
	groupChannels: z.array(ChannelNestSchema).optional(),
	dmAllowlist: z.array(ShipSchema).optional(),
	autoDiscoverChannels: z.boolean().optional(),
	showModelSignature: z.boolean().optional(),
	responsePrefix: z.string().optional(),
	autoAcceptDmInvites: z.boolean().optional(),
	autoAcceptGroupInvites: z.boolean().optional(),
	ownerShip: ShipSchema.optional()
};
const TlonAccountSchema = z.object({ ...tlonCommonConfigFields });
const tlonChannelConfigSchema = buildChannelConfigSchema(z.object({
	...tlonCommonConfigFields,
	authorization: TlonAuthorizationSchema.optional(),
	defaultAuthorizedShips: z.array(ShipSchema).optional(),
	accounts: z.record(z.string(), TlonAccountSchema).optional()
}));
//#endregion
//#region extensions/tlon/src/runtime.ts
const { setRuntime: setTlonRuntime, getRuntime: getTlonRuntime } = createPluginRuntimeStore("Tlon runtime not initialized");
//#endregion
//#region extensions/tlon/src/settings.ts
const SETTINGS_DESK = "moltbot";
const SETTINGS_BUCKET = "tlon";
/**
* Parse channelRules - handles both JSON string and object formats.
* Settings-store doesn't support nested objects, so we store as JSON string.
*/
function parseChannelRules(value) {
	if (!value) return;
	if (typeof value === "string") try {
		const parsed = JSON.parse(value);
		if (isChannelRulesObject(parsed)) return parsed;
	} catch {
		return;
	}
	if (isChannelRulesObject(value)) return value;
}
/**
* Parse settings from the raw Urbit settings-store response.
* The response shape is: { [bucket]: { [key]: value } }
*/
function parseSettingsResponse(raw) {
	if (!raw || typeof raw !== "object") return {};
	const bucket = raw[SETTINGS_BUCKET];
	if (!bucket || typeof bucket !== "object") return {};
	const settings = bucket;
	return {
		groupChannels: Array.isArray(settings.groupChannels) ? settings.groupChannels.filter((x) => typeof x === "string") : void 0,
		dmAllowlist: Array.isArray(settings.dmAllowlist) ? settings.dmAllowlist.filter((x) => typeof x === "string") : void 0,
		autoDiscover: typeof settings.autoDiscover === "boolean" ? settings.autoDiscover : void 0,
		showModelSig: typeof settings.showModelSig === "boolean" ? settings.showModelSig : void 0,
		autoAcceptDmInvites: typeof settings.autoAcceptDmInvites === "boolean" ? settings.autoAcceptDmInvites : void 0,
		autoAcceptGroupInvites: typeof settings.autoAcceptGroupInvites === "boolean" ? settings.autoAcceptGroupInvites : void 0,
		groupInviteAllowlist: Array.isArray(settings.groupInviteAllowlist) ? settings.groupInviteAllowlist.filter((x) => typeof x === "string") : void 0,
		channelRules: parseChannelRules(settings.channelRules),
		defaultAuthorizedShips: Array.isArray(settings.defaultAuthorizedShips) ? settings.defaultAuthorizedShips.filter((x) => typeof x === "string") : void 0,
		ownerShip: typeof settings.ownerShip === "string" ? settings.ownerShip : void 0,
		pendingApprovals: parsePendingApprovals(settings.pendingApprovals)
	};
}
function isChannelRulesObject(val) {
	if (!val || typeof val !== "object" || Array.isArray(val)) return false;
	for (const [, rule] of Object.entries(val)) if (!rule || typeof rule !== "object") return false;
	return true;
}
/**
* Parse pendingApprovals - handles both JSON string and array formats.
* Settings-store stores complex objects as JSON strings.
*/
function parsePendingApprovals(value) {
	if (!value) return;
	let parsed = value;
	if (typeof value === "string") try {
		parsed = JSON.parse(value);
	} catch {
		return;
	}
	if (!Array.isArray(parsed)) return;
	return parsed.filter((item) => {
		if (!item || typeof item !== "object") return false;
		const obj = item;
		return typeof obj.id === "string" && (obj.type === "dm" || obj.type === "channel" || obj.type === "group") && typeof obj.requestingShip === "string" && typeof obj.timestamp === "number";
	});
}
/**
* Parse a single settings entry update event.
*/
function parseSettingsEvent(event) {
	if (!event || typeof event !== "object") return null;
	const evt = event;
	if (evt["put-entry"]) {
		const put = evt["put-entry"];
		if (put.desk !== SETTINGS_DESK || put["bucket-key"] !== SETTINGS_BUCKET) return null;
		return {
			key: String(put["entry-key"] ?? ""),
			value: put.value
		};
	}
	if (evt["del-entry"]) {
		const del = evt["del-entry"];
		if (del.desk !== SETTINGS_DESK || del["bucket-key"] !== SETTINGS_BUCKET) return null;
		return {
			key: String(del["entry-key"] ?? ""),
			value: void 0
		};
	}
	return null;
}
/**
* Apply a single settings update to the current state.
*/
function applySettingsUpdate(current, key, value) {
	const next = { ...current };
	switch (key) {
		case "groupChannels":
			next.groupChannels = Array.isArray(value) ? value.filter((x) => typeof x === "string") : void 0;
			break;
		case "dmAllowlist":
			next.dmAllowlist = Array.isArray(value) ? value.filter((x) => typeof x === "string") : void 0;
			break;
		case "autoDiscover":
			next.autoDiscover = typeof value === "boolean" ? value : void 0;
			break;
		case "showModelSig":
			next.showModelSig = typeof value === "boolean" ? value : void 0;
			break;
		case "autoAcceptDmInvites":
			next.autoAcceptDmInvites = typeof value === "boolean" ? value : void 0;
			break;
		case "autoAcceptGroupInvites":
			next.autoAcceptGroupInvites = typeof value === "boolean" ? value : void 0;
			break;
		case "groupInviteAllowlist":
			next.groupInviteAllowlist = Array.isArray(value) ? value.filter((x) => typeof x === "string") : void 0;
			break;
		case "channelRules":
			next.channelRules = parseChannelRules(value);
			break;
		case "defaultAuthorizedShips":
			next.defaultAuthorizedShips = Array.isArray(value) ? value.filter((x) => typeof x === "string") : void 0;
			break;
		case "ownerShip":
			next.ownerShip = typeof value === "string" ? value : void 0;
			break;
		case "pendingApprovals":
			next.pendingApprovals = parsePendingApprovals(value);
			break;
	}
	return next;
}
/**
* Create a settings store subscription manager.
*
* Usage:
*   const settings = createSettingsManager(api, logger);
*   await settings.load();
*   settings.subscribe((newSettings) => { ... });
*/
function createSettingsManager(api, logger) {
	let state = {
		current: {},
		loaded: false
	};
	const listeners = /* @__PURE__ */ new Set();
	const notify = () => {
		for (const listener of listeners) try {
			listener(state.current);
		} catch (err) {
			logger?.error?.(`[settings] Listener error: ${String(err)}`);
		}
	};
	return {
		get current() {
			return state.current;
		},
		get loaded() {
			return state.loaded;
		},
		async load() {
			try {
				const deskData = (await api.scry("/settings/all.json"))?.all?.[SETTINGS_DESK];
				state.current = parseSettingsResponse(deskData ?? {});
				state.loaded = true;
				logger?.log?.(`[settings] Loaded: ${JSON.stringify(state.current)}`);
				return state.current;
			} catch (err) {
				logger?.log?.(`[settings] No settings found (using defaults): ${String(err)}`);
				state.current = {};
				state.loaded = true;
				return state.current;
			}
		},
		async startSubscription() {
			await api.subscribe({
				app: "settings",
				path: "/desk/" + SETTINGS_DESK,
				event: (event) => {
					const update = parseSettingsEvent(event);
					if (!update) return;
					logger?.log?.(`[settings] Update: ${update.key} = ${JSON.stringify(update.value)}`);
					state.current = applySettingsUpdate(state.current, update.key, update.value);
					notify();
				},
				err: (error) => {
					logger?.error?.(`[settings] Subscription error: ${String(error)}`);
				},
				quit: () => {
					logger?.log?.("[settings] Subscription ended");
				}
			});
			logger?.log?.("[settings] Subscribed to settings updates");
		},
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}
//#endregion
//#region extensions/tlon/src/urbit/errors.ts
var UrbitError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.name = "UrbitError";
		this.code = code;
	}
};
var UrbitUrlError = class extends UrbitError {
	constructor(message, options) {
		super("invalid_url", message, options);
		this.name = "UrbitUrlError";
	}
};
var UrbitHttpError = class extends UrbitError {
	constructor(params) {
		const suffix = params.bodyText ? ` - ${params.bodyText}` : "";
		super("http_error", `${params.operation} failed: ${params.status}${suffix}`, { cause: params.cause });
		this.name = "UrbitHttpError";
		this.status = params.status;
		this.operation = params.operation;
		this.bodyText = params.bodyText;
	}
};
var UrbitAuthError = class extends UrbitError {
	constructor(code, message, options) {
		super(code, message, options);
		this.name = "UrbitAuthError";
	}
};
//#endregion
//#region extensions/tlon/src/urbit/fetch.ts
async function urbitFetch(params) {
	const validated = validateUrbitBaseUrl(params.baseUrl);
	if (!validated.ok) throw new UrbitUrlError(validated.error);
	return await fetchWithSsrFGuard({
		url: new URL(params.path, validated.baseUrl).toString(),
		fetchImpl: params.fetchImpl,
		init: params.init,
		timeoutMs: params.timeoutMs,
		maxRedirects: params.maxRedirects,
		signal: params.signal,
		policy: params.ssrfPolicy,
		lookupFn: params.lookupFn,
		auditContext: params.auditContext,
		pinDns: params.pinDns
	});
}
//#endregion
//#region extensions/tlon/src/urbit/auth.ts
async function authenticate(url, code, options = {}) {
	const { response, release } = await urbitFetch({
		baseUrl: url,
		path: "/~/login",
		init: {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ password: code }).toString()
		},
		ssrfPolicy: options.ssrfPolicy,
		lookupFn: options.lookupFn,
		fetchImpl: options.fetchImpl,
		timeoutMs: options.timeoutMs ?? 15e3,
		maxRedirects: 3,
		auditContext: "tlon-urbit-login"
	});
	try {
		if (!response.ok) throw new UrbitAuthError("auth_failed", `Login failed with status ${response.status}`);
		await response.text().catch(() => {});
		const cookie = response.headers.get("set-cookie");
		if (!cookie) throw new UrbitAuthError("missing_cookie", "No authentication cookie received");
		return cookie;
	} finally {
		await release();
	}
}
//#endregion
//#region extensions/tlon/src/urbit/context.ts
function resolveShipFromHostname(hostname) {
	const trimmed = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (!trimmed) return "";
	if (trimmed.includes(".")) return trimmed.split(".")[0] ?? trimmed;
	return trimmed;
}
function normalizeUrbitShip(ship, hostname) {
	return (ship?.replace(/^~/, "") ?? resolveShipFromHostname(hostname)).trim();
}
function normalizeUrbitCookie(cookie) {
	return cookie.split(";")[0] ?? cookie;
}
function getUrbitContext(url, ship) {
	const validated = validateUrbitBaseUrl(url);
	if (!validated.ok) throw new UrbitUrlError(validated.error);
	return {
		baseUrl: validated.baseUrl,
		hostname: validated.hostname,
		ship: normalizeUrbitShip(ship, validated.hostname)
	};
}
function ssrfPolicyFromAllowPrivateNetwork(allowPrivateNetwork) {
	return allowPrivateNetwork ? { allowPrivateNetwork: true } : void 0;
}
/**
* Get the default SSRF policy for image uploads.
* Uses a restrictive policy that blocks private networks by default.
*/
function getDefaultSsrFPolicy() {}
//#endregion
//#region node_modules/.pnpm/@urbit+aura@3.0.0/node_modules/@urbit/aura/dist/aura.cjs.production.min.js
var require_aura_cjs_production_min = /* @__PURE__ */ __commonJSMin(((exports) => {
	function n(n) {
		let t = !0, [e, r, u] = n.split("..");
		r = r || "0.0.0", u = u || "0000";
		let [s, c, l] = e.slice(1).split(".");
		"-" === s.at(-1) && (s = s.slice(0, -1), t = !1);
		const [d, p, g] = r.split("."), h = u.split(".").map(((n) => BigInt("0x" + n)));
		return function(n) {
			const t = n.pos ? a + BigInt(n.year) : a - (BigInt(n.year) - 1n), e = (() => {
				let e = i(t) ? f : o, r = n.time.day - 1n, a = n.month - 1n;
				for (; 0n !== a;) {
					const [n, ...t] = e;
					r += BigInt(n), a -= 1n, e = t;
				}
				let u = !0, s = t;
				for (; 1 == u;) s % 4n !== 0n ? (s -= 1n, r += i(s) ? 366n : 365n) : s % 100n !== 0n ? (s -= 4n, r += i(s) ? 1461n : 1460n) : s % 400n !== 0n ? (s -= 100n, r += i(s) ? 36525n : 36524n) : (r += s / 400n * (4n * 36524n + 1n), u = !1);
				return r;
			})();
			return n.time.day = e, m(n.time);
		}({
			pos: t,
			year: BigInt(s),
			month: BigInt(c),
			time: {
				day: BigInt(l),
				hour: BigInt(d),
				minute: BigInt(p),
				second: BigInt(g),
				ms: h
			}
		});
	}
	function t(n) {
		const t = {
			day: 0n,
			hour: 0n,
			minute: 0n,
			second: 0n,
			ms: []
		};
		n = n.slice(1);
		let [e, r] = n.split("..");
		return r = r || "0000", t.ms = r.split(".").map(((n) => BigInt("0x" + n))), e.split(".").forEach(((e) => {
			switch (e[0]) {
				case "d":
					t.day += BigInt(e.slice(1));
					break;
				case "h":
					t.hour += BigInt(e.slice(1));
					break;
				case "m":
					t.minute += BigInt(e.slice(1));
					break;
				case "s":
					t.second += BigInt(e.slice(1));
					break;
				default: throw new Error("bad dr: " + n);
			}
		})), r = r || "0000", m(t);
	}
	Object.defineProperty(exports, "__esModule", { value: !0 });
	const e = BigInt("170141184475152167957503069145530368000"), r = BigInt("18446744073709551616"), a = BigInt("292277024400");
	function i(n) {
		return n % 4n === 0n && n % 100n !== 0n || n % 400n === 0n;
	}
	const o = [
		31,
		28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31
	], f = [
		31,
		29,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31
	], u = 86400n, s = 3600n, c = 60n, l = 146097n, d = 36524n;
	function m(n) {
		let t = n.second + u * n.day + s * n.hour + c * n.minute, e = n.ms, r = 0n, a = 3n;
		for (; 0 !== e.length;) {
			const [n, ...t] = e;
			r += n << 16n * a, e = t, a -= 1n;
		}
		return r | t << 64n;
	}
	function p(n) {
		let t = n >> 64n;
		const e = (BigInt("0xffffffffffffffff") & n).toString(16).padStart(16, "0").match(/.{4}/g).map(((n) => BigInt("0x" + n)));
		for (; 0n === e.at(-1);) e.pop();
		let r = t / u;
		t %= u;
		let a = t / s;
		t %= s;
		let i = t / c;
		return t %= c, {
			ms: e,
			day: r,
			minute: i,
			hour: a,
			second: t
		};
	}
	const g = (n, t) => ((n, t) => {
		const e = Number(255n & t), r = Number((65280n & t) / 256n), a = String.fromCharCode(e) + String.fromCharCode(r);
		return BigInt(((n, t) => {
			let e, r, a, i, o, f, u, s;
			for (e = 3 & n.length, r = n.length - e, a = t, o = 3432918353, f = 461845907, s = 0; s < r;) u = 255 & n.charCodeAt(s) | (255 & n.charCodeAt(++s)) << 8 | (255 & n.charCodeAt(++s)) << 16 | (255 & n.charCodeAt(++s)) << 24, ++s, u = (65535 & u) * o + (((u >>> 16) * o & 65535) << 16) & 4294967295, u = u << 15 | u >>> 17, u = (65535 & u) * f + (((u >>> 16) * f & 65535) << 16) & 4294967295, a ^= u, a = a << 13 | a >>> 19, i = 5 * (65535 & a) + ((5 * (a >>> 16) & 65535) << 16) & 4294967295, a = 27492 + (65535 & i) + ((58964 + (i >>> 16) & 65535) << 16);
			switch (u = 0, e) {
				case 3: u ^= (255 & n.charCodeAt(s + 2)) << 16;
				case 2: u ^= (255 & n.charCodeAt(s + 1)) << 8;
				case 1: u ^= 255 & n.charCodeAt(s), u = (65535 & u) * o + (((u >>> 16) * o & 65535) << 16) & 4294967295, u = u << 15 | u >>> 17, u = (65535 & u) * f + (((u >>> 16) * f & 65535) << 16) & 4294967295, a ^= u;
			}
			return a ^= n.length, a ^= a >>> 16, a = 2246822507 * (65535 & a) + ((2246822507 * (a >>> 16) & 65535) << 16) & 4294967295, a ^= a >>> 13, a = 3266489909 * (65535 & a) + ((3266489909 * (a >>> 16) & 65535) << 16) & 4294967295, a ^= a >>> 16, a >>> 0;
		})(a, n));
	})([
		3077398253,
		3995603712,
		2243735041,
		1261992695
	][n], t), h = (n) => y(4, 65535n, 65536n, 4294967295n, g, n), y = (n, t, e, r, a, i) => {
		const o = b(n, t, e, a, i);
		return o < r ? o : b(n, t, e, a, o);
	}, b = (n, t, e, r, a) => {
		const i = (a, o, f) => {
			if (a > n) return n % 2 != 0 || f === t ? t * f + o : t * o + f;
			{
				const n = BigInt(r(a - 1, f).toString());
				return i(a + 1, f, a % 2 != 0 ? (o + n) % t : (o + n) % e);
			}
		};
		return i(1, a % t, a / t);
	}, x = (n) => w(4, 65535n, 65536n, 4294967295n, g, n), w = (n, t, e, r, a, i) => {
		const o = B(n, t, e, a, i);
		return o < r ? o : B(n, t, e, a, o);
	}, B = (n, t, e, r, a) => {
		const i = (n, a, o) => {
			if (n < 1) return t * o + a;
			{
				const f = r(n - 1, a);
				return i(n - 1, n % 2 != 0 ? (o + t - f % t) % t : (o + e - f % e) % e, a);
			}
		}, o = n % 2 != 0 ? a / t : a % t, f = n % 2 != 0 ? a % t : a / t;
		return i(n, f === t ? o : f, f === t ? f : o);
	};
	var I = {
		F: g,
		fe: b,
		Fe: y,
		feis: h,
		fein: (n) => {
			const t = (n) => {
				const e = 4294967295n & n, r = 18446744069414584320n & n;
				return n >= 65536n && n <= 4294967295n ? 65536n + h(n - 65536n) : n >= 4294967296n && n <= 18446744073709551615n ? r | t(e) : n;
			};
			return t(n);
		},
		fen: B,
		Fen: w,
		tail: x,
		fynd: (n) => {
			const t = (n) => {
				const e = 4294967295n & n, r = 18446744069414584320n & n;
				return n >= 65536n && n <= 4294967295n ? 65536n + x(n - 65536n) : n >= 4294967296n && n <= 18446744073709551615n ? r | t(e) : n;
			};
			return t(BigInt(n));
		}
	};
	const v = /^~([a-z]{3}|([a-z]{6}(\-[a-z]{6}){0,3}(\-(\-[a-z]{6}){4})*))$/;
	function S(n) {
		const t = N(n), e = (n) => n.toString(2).padStart(8, "0"), r = t.reduce(((n, r, a) => a % 2 != 0 || 1 === t.length ? n + e(E.indexOf(r)) : n + e(C.indexOf(r))), ""), a = BigInt("0b" + r);
		return I.fynd(a);
	}
	function $(n) {
		const t = I.fein(n), e = Math.ceil(t.toString(16).length / 2), r = Math.ceil(t.toString(16).length / 4);
		return "~" + (e <= 1 ? E[Number(t)] : function n(t, e, a) {
			const i = 65535n & t, o = C[Number(i >> 8n)], f = E[Number(255n & i)];
			return e === r ? a : n(t >> 16n, e + 1, o + f + (3 & e ? "-" : 0 === e ? "" : "--") + a);
		}(t, 0, ""));
	}
	function A(n) {
		let t;
		return t = "bigint" == typeof n ? n : z(n), t <= 255n ? "czar" : t <= 65535n ? "king" : t <= 4294967295n ? "duke" : t <= 18446744073709551615n ? "earl" : "pawn";
	}
	function k(n) {
		switch (n) {
			case "czar": return "galaxy";
			case "king": return "star";
			case "duke": return "planet";
			case "earl": return "moon";
			case "pawn": return "comet";
		}
	}
	function z(n) {
		if (!function(n) {
			return v.test(n) && j(n) && n === $(S(n));
		}(n)) throw new Error("invalid @p literal: " + n);
		return S(n);
	}
	const C = "\ndozmarbinwansamlitsighidfidlissogdirwacsabwissibrigsoldopmodfoglidhopdardorlorhodfolrintogsilmirholpaslacrovlivdalsatlibtabhanticpidtorbolfosdotlosdilforpilramtirwintadbicdifrocwidbisdasmidloprilnardapmolsanlocnovsitnidtipsicropwitnatpanminritpodmottamtolsavposnapnopsomfinfonbanmorworsipronnorbotwicsocwatdolmagpicdavbidbaltimtasmalligsivtagpadsaldivdactansidfabtarmonranniswolmispallasdismaprabtobrollatlonnodnavfignomnibpagsopralbilhaddocridmocpacravripfaltodtiltinhapmicfanpattaclabmogsimsonpinlomrictapfirhasbosbatpochactidhavsaplindibhosdabbitbarracparloddosbortochilmactomdigfilfasmithobharmighinradmashalraglagfadtopmophabnilnosmilfopfamdatnoldinhatnacrisfotribhocnimlarfitwalrapsarnalmoslandondanladdovrivbacpollaptalpitnambonrostonfodponsovnocsorlavmatmipfip".match(/.{1,3}/g), E = "\nzodnecbudwessevpersutletfulpensytdurwepserwylsunrypsyxdyrnuphebpeglupdepdysputlughecryttyvsydnexlunmeplutseppesdelsulpedtemledtulmetwenbynhexfebpyldulhetmevruttylwydtepbesdexsefwycburderneppurrysrebdennutsubpetrulsynregtydsupsemwynrecmegnetsecmulnymtevwebsummutnyxrextebfushepbenmuswyxsymselrucdecwexsyrwetdylmynmesdetbetbeltuxtugmyrpelsyptermebsetdutdegtexsurfeltudnuxruxrenwytnubmedlytdusnebrumtynseglyxpunresredfunrevrefmectedrusbexlebduxrynnumpyxrygryxfeptyrtustyclegnemfermertenlusnussyltecmexpubrymtucfyllepdebbermughuttunbylsudpemdevlurdefbusbeprunmelpexdytbyttyplevmylwedducfurfexnulluclennerlexrupnedlecrydlydfenwelnydhusrelrudneshesfetdesretdunlernyrsebhulrylludremlysfynwerrycsugnysnyllyndyndemluxfedsedbecmunlyrtesmudnytbyrsenwegfyrmurtelreptegpecnelnevfes".match(/.{1,3}/g);
	function N(n) {
		return n.replace(/[\^~-]/g, "").match(/.{1,3}/g) || [];
	}
	function j(n) {
		const t = N(n);
		return !(t.length % 2 != 0 && 1 !== t.length) && t.every(((n, e) => e % 2 != 0 || 1 === t.length ? E.includes(n) : C.includes(n)));
	}
	function _(n, t) {
		let e = [], r = [e];
		for (let a = 0; a < n.length; a++) e.length < t ? e.push(n[a]) : (e = [n[a]], r.push(e));
		return r;
	}
	function q(n, t) {
		return n = M(n), function(n, t, e) {
			if ("nan" === n) return function(n, t) {
				return O(BigInt(n + 1)) << BigInt(t - 1);
			}(t, e);
			if ("inf" === n) return U(!0, t, e);
			if ("-inf" === n) return U(!1, t, e);
			let r = 0, a = !0;
			"-" === n[r] && (a = !1, r++);
			let i = "";
			for (; "." !== n[r] && "e" !== n[r] && void 0 !== n[r];) i += n[r++];
			"." === n[r] && r++;
			let o = "";
			for (; "e" !== n[r] && void 0 !== n[r];) o += n[r++];
			"e" === n[r] && r++;
			let f = !0;
			"-" === n[r] && (f = !1, r++);
			let u = "";
			for (; void 0 !== n[r];) u += n[r++];
			return BigInt("0b" + function(n, t, e, r, a, i, o) {
				return 0 !== o && (i ? (r += a.padEnd(o, "0").slice(0, o), a = a.slice(o)) : (a = r.padStart(o, "0").slice(-o) + a, r = r.slice(0, -o))), function(n, t, e, r, a, i) {
					function o(n) {
						return console.warn(n), 1;
					}
					const f = 2 ** (t - 1) - 1, u = 1 - f, s = f, c = u - n, l = 2 * f + 1 + n + 3, d = new Array(l), m = 10n ** a;
					var p, g, h, y, b, x, w = 0, B = !e;
					for (p = l; p; d[--p] = 0);
					for (p = f + 2; r && p; d[--p] = 1n & r, r >>= 1n);
					for (p = f + 1; i > 0n && p < l; (d[++p] = (i *= 2n) >= m ? 1 : 0) && (i -= m));
					for (p = -1; ++p < l && !d[p];);
					if (d[(g = n - 1 + (p = (w = f + 1 - p) >= u && w <= s ? p + 1 : f + 1 - (w = u - 1))) + 1]) {
						if (!(h = d[g])) for (y = g + 2; !h && y < l; h = d[y++]);
						for (y = g + 1; h && --y >= 0; (d[y] = (d[y] ? 0 : 1) - 0) && (h = 0));
					}
					for (p = p - 2 < 0 ? -1 : p - 3; ++p < l && !d[p];);
					for ((w = f + 1 - p) >= u && w <= s ? ++p : w < u && (w != f + 1 - l && w < c && o("r.construct underflow"), p = f + 1 - (w = u - 1)), r && (o(r ? "r.construct overflow" : "r.construct"), w = s + 1, p = f + 2), x = Math.abs(w + f), y = t + 1, b = ""; --y; b = (1 & x) + b, x = x >>= 1);
					return (B ? "1" : "0") + b + d.slice(p, p + n).join("");
				}(t, n, e, BigInt(r), BigInt(a.length), BigInt(a));
			}(t, e, a, i, o, f, Number(u)));
		}(t.slice(n.l.length), n.w, n.p);
	}
	function F(n, t) {
		return (n = M(n)).l + function(n) {
			if ("n" === n.t) return "nan";
			if ("i" === n.t) return n.s ? "inf" : "-inf";
			let t;
			return n.e - 4 > 0 || n.e + 2 < 0 ? t = 1 : (t = n.e + 1, n.e = 0), (n.s ? "" : "-") + function(n, t) {
				const e = Math.abs(n);
				if (n <= 0) return "0." + "".padEnd(e, "0") + t;
				{
					const n = t.length;
					return e >= n ? t + "".padEnd(e - n, "0") : t.slice(0, e) + "." + t.slice(e);
				}
			}(t, n.a) + (0 === n.e ? "" : "e" + n.e.toString());
		}(function(n, t, e) {
			const r = O(e), a = O(t), i = n & r, o = n >> BigInt(e) & a, f = 0n === (n >> BigInt(t + e) & 1n);
			let u, s, c, l;
			if (o === a) return 0n === i ? {
				t: "i",
				s: f
			} : { t: "n" };
			0n !== o ? (u = 1n << BigInt(e) | i, s = o - (2n ** (t - 1n) - 1n) - e, c = Number(e), l = 1n !== o && 0n === i) : (u = i, s = 1n - (2n ** (t - 1n) - 1n) - e, c = u.toString(2).length - 1, l = !1);
			const d = (2n ** e).toString(10).length + 1, m = function(n, t, e, r, a, i, o) {
				const f = BigInt(t);
				let u, s, c, l, d = 0, m = new Array(o).fill("0"), p = 0;
				if (0n === n) return m[0] = "0", p = 0, {
					digits: m.slice(0, 1).join(""),
					outExponent: p
				};
				r ? t > 0 ? (s = 4n * n, s <<= f, u = 4n, c = 1n << f, l = 1n << f + 1n) : (s = 4n * n, u = 1n << -f + 2n, c = 1n, l = 2n) : t > 0 ? (s = 2n * n, s <<= f, u = 2n, c = 1n << f, l = c) : (s = 2n * n, u = 1n << BigInt(1 - t), c = 1n, l = c);
				let g = Math.ceil(.3010299956639812 * (e + t) - .69);
				if (g > 0) u *= BigInt(10) ** BigInt(g);
				else if (g < 0) {
					const n = BigInt(10) ** BigInt(-g);
					s *= n, c *= n, l !== c && (l *= c);
				}
				s >= u ? g += 1 : (s *= 10n, c *= 10n, l !== c && (l *= 10n));
				let h = g - o;
				p = g - 1;
				let y = !1, b = !1, x = 0;
				for (; g -= 1, x = Number(s / u), s %= u, y = s < c, b = s + l > u, !y && !b && g !== h;) m[d] = String.fromCharCode("0".charCodeAt(0) + x), d += 1, s *= 10n, c *= 10n, l !== c && (l *= 10n);
				let w = y;
				if (y === b) {
					s *= 2n;
					let n = s < u ? -1 : s > u ? 1 : 0;
					w = n < 0, 0 === n && (w = 0 == (1 & x));
				}
				if (w) m[d] = String.fromCharCode("0".charCodeAt(0) + x), d += 1;
				else if (9 === x) for (;;) {
					if (0 === d) {
						m[d] = "1", d += 1, p += 1;
						break;
					}
					if (d -= 1, "9" !== m[d]) {
						m[d] = String.fromCharCode(m[d].charCodeAt(0) + 1), d += 1;
						break;
					}
				}
				else m[d] = String.fromCharCode("0".charCodeAt(0) + x + 1), d += 1;
				return {
					digits: m.slice(0, d).join(""),
					outExponent: p
				};
			}(u, Number(s), c, l, 0, 0, d);
			return {
				t: "d",
				s: f,
				e: m.outExponent,
				a: m.digits
			};
		}(t, BigInt(n.w), BigInt(n.p)));
	}
	function M(n) {
		return "h" === n ? {
			w: 5,
			p: 10,
			l: ".~~"
		} : "s" === n ? {
			w: 8,
			p: 23,
			l: "."
		} : "d" === n ? {
			w: 11,
			p: 52,
			l: ".~"
		} : "q" === n ? {
			w: 15,
			p: 112,
			l: ".~~~"
		} : n;
	}
	function O(n) {
		return 2n ** n - 1n;
	}
	function U(n, t, e) {
		return O(BigInt(n ? t : t + 1)) << BigInt(e);
	}
	function Z(n, t, e, r, a) {
		return void 0 === a && (a = !1), new RegExp(`^${a ? "\\-\\-?" : ""}${n}(0|${0 === r ? t : `${t}${e}{0,${r - 1}}`}${0 === r ? `${e}*` : `(\\.${e}{${r}})*`})$`);
	}
	function P(n) {
		return new RegExp(`^\\.~{${n}}(nan|\\-?(inf|(0|[1-9][0-9]*)(\\.[0-9]+)?(e\\-?(0|[1-9][0-9]*))?))$`);
	}
	const R = {
		c: /^~\-((~[0-9a-fA-F]+\.)|(~[~\.])|[0-9a-z\-\._])*$/,
		da: /^~(0|[1-9][0-9]*)\-?\.0*([1-9]|1[0-2])\.0*[1-9][0-9]*(\.\.([0-9]+)\.([0-9]+)\.([0-9]+)(\.(\.[0-9a-f]{4})+)?)?$/,
		dr: /^~((d|h|m|s)(0|[1-9][0-9]*))(\.(d|h|m|s)(0|[1-9][0-9]*))*(\.(\.[0-9a-f]{4})+)?$/,
		f: /^\.(y|n)$/,
		if: /^(\.(0|[1-9][0-9]{0,2})){4}$/,
		is: /^(\.(0|[1-9a-fA-F][0-9a-fA-F]{0,3})){8}$/,
		n: /^~$/,
		p: v,
		q: /^\.~(([a-z]{3}|[a-z]{6})(\-[a-z]{6})*)$/,
		rd: P(1),
		rh: P(2),
		rq: P(3),
		rs: P(0),
		sb: Z("0b", "1", "[01]", 4, !0),
		sd: Z("", "[1-9]", "[0-9]", 3, !0),
		si: Z("0i", "[1-9]", "[0-9]", 0, !0),
		sv: Z("0v", "[1-9a-v]", "[0-9a-v]", 5, !0),
		sw: Z("0w", "[1-9a-zA-Z~-]", "[0-9a-zA-Z~-]", 5, !0),
		sx: Z("0x", "[1-9a-f]", "[0-9a-f]", 4, !0),
		t: /^~~((~[0-9a-fA-F]+\.)|(~[~\.])|[0-9a-z\-\._])*$/,
		ta: /^~\.[0-9a-z\-\.~_]*$/,
		tas: /^[a-z][a-z0-9\-]*$/,
		ub: Z("0b", "1", "[01]", 4),
		ud: Z("", "[1-9]", "[0-9]", 3),
		ui: Z("0i", "[1-9]", "[0-9]", 0),
		uv: Z("0v", "[1-9a-v]", "[0-9a-v]", 5),
		uw: Z("0w", "[1-9a-zA-Z~-]", "[0-9a-zA-Z~-]", 5),
		ux: Z("0x", "[1-9a-f]", "[0-9a-f]", 4)
	}, T = D;
	function D(n, t) {
		const e = H(n, t);
		if (!e) throw new Error("slav: failed to parse @" + n + " from string: " + t);
		return e;
	}
	const G = H;
	function H(n, t) {
		if (n in R && !R[n].test(t)) return null;
		const e = J(t);
		return e && "dime" === e.type && e.aura === n ? e.atom : null;
	}
	function J(e) {
		if ("" === e) return null;
		const r = e[0];
		if (r >= "a" && r <= "z") return R.tas.test(e) ? {
			type: "dime",
			aura: "tas",
			atom: Q(e)
		} : null;
		if (r >= "0" && r <= "9") {
			const n = K(e);
			return n ? {
				type: "dime",
				...n
			} : null;
		}
		if ("-" === r) {
			let n = !0;
			"-" == e[1] ? e = e.slice(2) : (e = e.slice(1), n = !1);
			const t = K(e);
			return t ? (n ? t.atom = 2n * t.atom : 0n !== t.atom && (t.atom = 1n + 2n * (t.atom - 1n)), {
				type: "dime",
				aura: t.aura.replace("u", "s"),
				atom: t.atom
			}) : null;
		}
		if ("." === r) {
			if (".y" === e) return {
				type: "dime",
				aura: "f",
				atom: 0n
			};
			if (".n" === e) return {
				type: "dime",
				aura: "f",
				atom: 1n
			};
			if (R.is.test(e)) {
				const n = e.slice(1).split(".").reduce(((n, t) => n + t.padStart(4, "0")), "");
				return {
					type: "dime",
					aura: "is",
					atom: BigInt("0x" + n)
				};
			}
			if (R.if.test(e)) return {
				type: "dime",
				aura: "if",
				atom: e.slice(1).split(".").reduce(((n, t, e) => n + (BigInt(t) << BigInt(8 * (3 - e)))), 0n)
			};
			if ("~" === e[1] && (R.rd.test(e) || R.rh.test(e) || R.rq.test(e)) || R.rs.test(e)) {
				let n, t = 0;
				for (; "~" === e[t + 1];) t++;
				switch (t) {
					case 0:
						n = "rs";
						break;
					case 1:
						n = "rd";
						break;
					case 2:
						n = "rh";
						break;
					case 3:
						n = "rq";
						break;
					default: throw new Error("parsing invalid @r*");
				}
				return {
					type: "dime",
					aura: n,
					atom: q(n[1], e)
				};
			}
			if ("~" === e[1] && R.q.test(e)) {
				const n = function(n) {
					try {
						return function(n) {
							const t = n.slice(2).split("-"), e = (n) => {
								if (n < 0) throw new Error("malformed @q");
								return n.toString(16).padStart(2, "0");
							}, r = t.map(((n, t) => {
								let r = function(n, t) {
									return [t.slice(0, 3), t.slice(3)];
								}(0, n);
								return "" === r[1] && 0 === t ? e(E.indexOf(r[0])) : e(C.indexOf(r[0])) + e(E.indexOf(r[1]));
							}));
							return BigInt("0x" + (0 === n.length ? "00" : r.join("")));
						}(n);
					} catch (n) {
						return null;
					}
				}(e);
				return null === n ? null : {
					type: "dime",
					aura: "q",
					atom: n
				};
			}
			if ("_" === e[1] && /^\.(_([0-9a-zA-Z\-\.]|~\-|~~)+)*__$/.test(e)) {
				const n = e.slice(1, -2).split("_").slice(1).map(((n) => J(n = n.replaceAll("~-", "_").replaceAll("~~", "~"))));
				return n.some(((n) => null === n)) ? null : {
					type: "many",
					list: n
				};
			}
			return null;
		}
		if ("~" === r) {
			if ("~" === e) return {
				type: "dime",
				aura: "n",
				atom: 0n
			};
			if (R.da.test(e)) return {
				type: "dime",
				aura: "da",
				atom: n(e)
			};
			if (R.dr.test(e)) return {
				type: "dime",
				aura: "dr",
				atom: t(e)
			};
			if (R.p.test(e)) {
				const n = function(n) {
					if (!v.test(n) || !j(n)) return null;
					const t = S(n);
					return n === $(t) ? t : null;
				}(e);
				return null === n ? null : {
					type: "dime",
					aura: "p",
					atom: n
				};
			}
			return "." === e[1] && R.ta.test(e) ? {
				type: "dime",
				aura: "ta",
				atom: Q(e.slice(2))
			} : "~" === e[1] && R.t.test(e) ? {
				type: "dime",
				aura: "t",
				atom: Q(L(e.slice(2)))
			} : "-" === e[1] && R.c.test(e) ? /^~\-~[0-9a-f]+\.$/.test(e) ? {
				type: "dime",
				aura: "c",
				atom: BigInt("0x" + e.slice(3, -1))
			} : {
				type: "dime",
				aura: "c",
				atom: Q(L(e.slice(2)))
			} : "0" === e[1] && /^~0[0-9a-v]+$/.test(e) ? {
				type: "blob",
				jam: X(5, W, e.slice(2))
			} : null;
		}
		return null;
	}
	function K(n) {
		switch (n.slice(0, 2)) {
			case "0b": return R.ub.test(n) ? {
				aura: "ub",
				atom: BigInt(n.replaceAll(".", ""))
			} : null;
			case "0c": return console.log("aura-js: @uc parsing unsupported (bisk)"), null;
			case "0i": return R.ui.test(n) ? {
				aura: "ui",
				atom: BigInt(n.slice(2))
			} : null;
			case "0x": return R.ux.test(n) ? {
				aura: "ux",
				atom: BigInt(n.replaceAll(".", ""))
			} : null;
			case "0v": return R.uv.test(n) ? {
				aura: "uv",
				atom: X(5, W, n.slice(2))
			} : null;
			case "0w": return R.uw.test(n) ? {
				aura: "uw",
				atom: X(6, V, n.slice(2))
			} : null;
			default: return R.ud.test(n) ? {
				aura: "ud",
				atom: BigInt(n.replaceAll(".", ""))
			} : null;
		}
	}
	function L(n) {
		let t = "", e = 0;
		for (; e < n.length;) switch (n[e]) {
			case ".":
				t += " ", e++;
				continue;
			case "~": switch (n[++e]) {
				case "~":
					t += "~", e++;
					continue;
				case ".":
					t += ".", e++;
					continue;
				default:
					let r = 0;
					do
						r = r << 4 | Number.parseInt(n[e++], 16);
					while ("." !== n[e]);
					t += String.fromCodePoint(r), e++;
					continue;
			}
			default:
				t += n[e++];
				continue;
		}
		return t;
	}
	function Q(n) {
		return function(n) {
			if (0 === n.length) return 0n;
			if ("undefined" != typeof Buffer) return BigInt("0x" + Buffer.from(n.reverse()).toString("hex"));
			let t, e = [];
			for (var r = n.length - 1; r >= 0; --r) t = n[r], e.push(t < 16 ? "0" + t.toString(16) : t.toString(16));
			return BigInt("0x" + e.join(""));
		}(new TextEncoder().encode(n));
	}
	const V = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-~", W = "0123456789abcdefghijklmnopqrstuv";
	function X(n, t, e) {
		let r = 0n;
		const a = BigInt(n);
		for (; "" !== e;) "." !== e[0] && (r = (r << a) + BigInt(t.indexOf(e[0]))), e = e.slice(1);
		return r;
	}
	const Y = nn;
	function nn(n, t) {
		return tn({
			type: "dime",
			aura: n,
			atom: t
		});
	}
	function tn(n) {
		switch (n.type) {
			case "blob": return "~0" + n.jam.toString(32);
			case "many": return "." + n.list.reduce(((n, t) => n + "_" + tn(t).replaceAll("~", "~~").replaceAll("_", "~-")), "") + "__";
			case "dime": switch (n.aura[0]) {
				case "c": return n.atom < 127n ? "~-" + rn(String.fromCharCode(Number(n.atom))) : "~-~" + n.atom.toString(16) + ".";
				case "d": switch (n.aura[1]) {
					case "a": return function(n) {
						const { pos: t, year: e, month: r, time: i } = function(n) {
							const t = p(n), [e, r, i] = function(n) {
								let t = 0n, e = 0n, r = !1;
								t = n / l, (n %= l) < d + 1n ? r = !0 : (r = !1, e = 1n, e += (n -= d + 1n) / d, n %= d);
								let a = 400n * t + 100n * e, i = !0;
								for (; 1 == i;) {
									let t = r ? 366n : 365n;
									if (n < t) {
										i = !1;
										let e = 0n;
										for (;;) {
											let t = BigInt((r ? f : o)[Number(e)]);
											if (n < t) return [
												a,
												e + 1n,
												n + 1n
											];
											e += 1n, n -= t;
										}
									} else a += 1n, n -= t, r = a % 4n === 0n;
								}
								return [
									0n,
									0n,
									0n
								];
							}(t.day);
							t.day = i;
							const u = e > a;
							return {
								pos: u,
								year: u ? e - a : a + 1n - e,
								month: r,
								time: t
							};
						}(n);
						let u = `~${e}${t ? "" : "-"}.${r}.${i.day}`;
						return 0n === i.hour && 0n === i.minute && 0n === i.second && 0 === i.ms.length || (u += `..${i.hour.toString().padStart(2, "0")}.${i.minute.toString().padStart(2, "0")}.${i.second.toString().padStart(2, "0")}`, 0 !== i.ms.length && (u += `..${i.ms.map(((n) => n.toString(16).padStart(4, "0"))).join(".")}`)), u;
					}(n.atom);
					case "r": return function(n) {
						if (0n === n) return "~s0";
						const { day: t, hour: e, minute: r, second: a, ms: i } = p(n);
						let o = [];
						return 0n !== t && o.push("d" + t.toString()), 0n !== e && o.push("h" + e.toString()), 0n !== r && o.push("m" + r.toString()), 0n !== a && o.push("s" + a.toString()), 0 !== i.length && (0 === o.length && o.push("s0"), o.push("." + i.map(((n) => n.toString(16).padStart(4, "0"))).join("."))), "~" + o.join(".");
					}(n.atom);
					default: return en(n.atom);
				}
				case "f": switch (n.atom) {
					case 0n: return ".y";
					case 1n: return ".n";
					default: return en(n.atom);
				}
				case "n": return "~";
				case "i": switch (n.aura[1]) {
					case "f": return "." + fn(n.atom, 1, 4, 10);
					case "s": return "." + fn(n.atom, 2, 8, 16);
					default: return en(n.atom);
				}
				case "p": return $(n.atom);
				case "q": return function(n) {
					const t = n.toString(16), e = t.length, r = Buffer.from(t.padStart(e + e % 2, "0"), "hex"), a = r.length % 2 != 0 && r.length > 1 ? [[r[0]]].concat(_(Array.from(r.slice(1)), 2)) : _(Array.from(r), 2);
					return a.reduce(((n, t) => {
						return n + (".~" === n ? "" : "-") + ((e = t).length % 2 != 0 && a.length > 1 ? void 0 === (r = e)[1] ? E[r[0]] : C[r[0]] + E[r[1]] : ((n) => void 0 === n[1] ? E[n[0]] : C[n[0]] + E[n[1]])(e));
						var e, r;
					}), ".~");
				}(n.atom);
				case "r": switch (n.aura[1]) {
					case "d": return F("d", n.atom);
					case "h": return F("h", n.atom);
					case "q": return F("q", n.atom);
					case "s": return F("s", n.atom);
					default: return en(n.atom);
				}
				case "u": switch (n.aura[1]) {
					case "c": throw new Error("aura-js: @uc rendering unsupported");
					case "b": return "0b" + on(n.atom.toString(2), 4);
					case "i": return "0i" + n.atom.toString(10).padStart(1, "0");
					case "x": return "0x" + on(n.atom.toString(16), 4);
					case "v": return "0v" + on(n.atom.toString(32), 5);
					case "w": return "0w" + on(function(n, t, e) {
						if (0n === e) return t[0];
						let r = "";
						const a = BigInt(6);
						for (; 0n !== e;) r = t[Number(BigInt.asUintN(6, e))] + r, e >>= a;
						return r;
					}(0, an, n.atom), 5);
					default: return on(n.atom.toString(10), 3);
				}
				case "s":
					const t = 1n & n.atom;
					return n.atom = t + (n.atom >> 1n), n.aura = n.aura.replace("s", "u"), (0n === t ? "--" : "-") + tn(n);
				case "t": return "a" === n.aura[1] ? "s" === n.aura[2] ? un(n.atom) : "~." + un(n.atom) : "~~" + rn(un(n.atom));
				default: return en(n.atom);
			}
		}
	}
	function en(n) {
		return "0x" + function(n, t) {
			return t.toString(16).padStart(1, "0");
		}(0, n);
	}
	function rn(n) {
		let t = "";
		for (let e = 0; e < n.length; e += 1) {
			const r = n[e];
			let a = "";
			switch (r) {
				case " ":
					a = ".";
					break;
				case ".":
					a = "~.";
					break;
				case "~":
					a = "~~";
					break;
				default: {
					const t = n.codePointAt(e);
					if (!t) break;
					t > 65535 && (e += 1), a = t >= 97 && t <= 122 || t >= 48 && t <= 57 || "-" === r ? r : `~${t.toString(16)}.`;
				}
			}
			t += a;
		}
		return t;
	}
	const an = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-~";
	function on(n, t) {
		return n.replace(new RegExp(`(?=(?:.{${t}})+$)(?!^)`, "g"), ".");
	}
	function fn(n, t, e, r) {
		void 0 === r && (r = 10);
		let a = "";
		const i = 8n * BigInt(t), o = (1n << i) - 1n;
		for (; e-- > 0;) "" !== a && (a = "." + a), a = (n & o).toString(r) + a, n >>= i;
		return a;
	}
	function un(n) {
		return new TextDecoder("utf-8").decode(function(n) {
			if (0n === n) return new Uint8Array(0);
			const t = n.toString(16), e = t.length % 2 == 0 ? t : "0" + t, r = new Uint8Array(e.length / 2);
			for (let n = 0; n < e.length; n += 2) {
				const t = e.slice(n, n + 2), a = parseInt(t, 16) << 24 >> 24;
				r[n / 2] = a;
			}
			return r;
		}(n).reverse());
	}
	const sn = {
		toSeconds: function(n) {
			const { day: t, hour: e, minute: r, second: a } = p(n);
			return 60n * (60n * (24n * t + e) + r) + a;
		},
		fromSeconds: function(n) {
			return m({
				day: 0n,
				hour: 0n,
				minute: 0n,
				second: n,
				ms: []
			});
		}
	}, cn = {
		cite: function(n) {
			let t;
			return t = "bigint" == typeof n ? n : z(n), t <= 4294967295n ? $(t) : t <= 18446744073709551615n ? $(4294967295n & t).replace("-", "^") : $(BigInt("0x" + t.toString(16).slice(0, 4))) + "_" + $(65535n & t).slice(1);
		},
		sein: function(n) {
			let t;
			t = "bigint" == typeof n ? n : z(n);
			let e = A(t);
			const r = "czar" === e ? t : "king" === e ? 255n & t : "duke" === e ? 65535n & t : "earl" === e ? 4294967295n & t : 65535n & t;
			return "bigint" == typeof n ? r : $(r);
		},
		clan: A,
		kind: function(n) {
			return k(A(n));
		},
		rankToSize: k,
		sizeToRank: function(n) {
			switch (n) {
				case "galaxy": return "czar";
				case "star": return "king";
				case "planet": return "duke";
				case "moon": return "earl";
				case "comet": return "pawn";
			}
		}
	};
	exports.da = {
		toUnix: function(n) {
			return Math.round(Number(1000n * (r / 2000n + (n - e)) / r));
		},
		fromUnix: function(n) {
			return e + BigInt(n) * r / 1000n;
		}
	}, exports.dr = sn, exports.nuck = J, exports.p = cn, exports.parse = T, exports.rend = tn, exports.render = Y, exports.scot = nn, exports.slav = D, exports.slaw = H, exports.tryParse = G, exports.valid = function(n, t) {
		return null !== H(n, t);
	};
}));
//#endregion
//#region node_modules/.pnpm/@urbit+aura@3.0.0/node_modules/@urbit/aura/dist/index.js
var require_dist = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_aura_cjs_production_min();
}));
//#endregion
//#region extensions/tlon/src/urbit/story.ts
/**
* Parse inline markdown formatting (bold, italic, code, links, mentions)
*/
function parseInlineMarkdown(text) {
	const result = [];
	let remaining = text;
	while (remaining.length > 0) {
		const shipMatch = remaining.match(/^(~[a-z][-a-z0-9]*)/);
		if (shipMatch) {
			result.push({ ship: shipMatch[1] });
			remaining = remaining.slice(shipMatch[0].length);
			continue;
		}
		const boldMatch = remaining.match(/^\*\*(.+?)\*\*|^__(.+?)__/);
		if (boldMatch) {
			const content = boldMatch[1] || boldMatch[2];
			result.push({ bold: parseInlineMarkdown(content) });
			remaining = remaining.slice(boldMatch[0].length);
			continue;
		}
		const italicsMatch = remaining.match(/^\*([^*]+?)\*|^_([^_]+?)_(?![a-zA-Z0-9])/);
		if (italicsMatch) {
			const content = italicsMatch[1] || italicsMatch[2];
			result.push({ italics: parseInlineMarkdown(content) });
			remaining = remaining.slice(italicsMatch[0].length);
			continue;
		}
		const strikeMatch = remaining.match(/^~~(.+?)~~/);
		if (strikeMatch) {
			result.push({ strike: parseInlineMarkdown(strikeMatch[1]) });
			remaining = remaining.slice(strikeMatch[0].length);
			continue;
		}
		const codeMatch = remaining.match(/^`([^`]+)`/);
		if (codeMatch) {
			result.push({ "inline-code": codeMatch[1] });
			remaining = remaining.slice(codeMatch[0].length);
			continue;
		}
		const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
		if (linkMatch) {
			result.push({ link: {
				href: linkMatch[2],
				content: linkMatch[1]
			} });
			remaining = remaining.slice(linkMatch[0].length);
			continue;
		}
		const imageMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
		if (imageMatch) {
			result.push({ __image: {
				src: imageMatch[2],
				alt: imageMatch[1]
			} });
			remaining = remaining.slice(imageMatch[0].length);
			continue;
		}
		const urlMatch = remaining.match(/^(https?:\/\/[^\s<>"\]]+)/);
		if (urlMatch) {
			result.push({ link: {
				href: urlMatch[1],
				content: urlMatch[1]
			} });
			remaining = remaining.slice(urlMatch[0].length);
			continue;
		}
		const plainMatch = remaining.match(/^[^*_`~[#~\n:/]+/);
		if (plainMatch) {
			result.push(plainMatch[0]);
			remaining = remaining.slice(plainMatch[0].length);
			continue;
		}
		result.push(remaining[0]);
		remaining = remaining.slice(1);
	}
	return mergeAdjacentStrings(result);
}
/**
* Merge adjacent string elements in an inline array
*/
function mergeAdjacentStrings(inlines) {
	const result = [];
	for (const item of inlines) if (typeof item === "string" && typeof result[result.length - 1] === "string") result[result.length - 1] = result[result.length - 1] + item;
	else result.push(item);
	return result;
}
/**
* Create an image block
*/
function createImageBlock(src, alt = "", height = 0, width = 0) {
	return { block: { image: {
		src,
		height,
		width,
		alt
	} } };
}
/**
* Check if URL looks like an image
*/
function isImageUrl(url) {
	return /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i.test(url);
}
/**
* Process inlines and extract any image markers into blocks
*/
function processInlinesForImages(inlines) {
	const cleanInlines = [];
	const imageBlocks = [];
	for (const inline of inlines) if (typeof inline === "object" && "__image" in inline) {
		const img = inline.__image;
		imageBlocks.push(createImageBlock(img.src, img.alt));
	} else cleanInlines.push(inline);
	return {
		inlines: cleanInlines,
		imageBlocks
	};
}
/**
* Convert markdown text to Tlon story format
*/
function markdownToStory(markdown) {
	const story = [];
	const lines = markdown.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.startsWith("```")) {
			const lang = line.slice(3).trim() || "plaintext";
			const codeLines = [];
			i++;
			while (i < lines.length && !lines[i].startsWith("```")) {
				codeLines.push(lines[i]);
				i++;
			}
			story.push({ block: { code: {
				code: codeLines.join("\n"),
				lang
			} } });
			i++;
			continue;
		}
		const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
		if (headerMatch) {
			const tag = `h${headerMatch[1].length}`;
			story.push({ block: { header: {
				tag,
				content: parseInlineMarkdown(headerMatch[2])
			} } });
			i++;
			continue;
		}
		if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
			story.push({ block: { rule: null } });
			i++;
			continue;
		}
		if (line.startsWith("> ")) {
			const quoteLines = [];
			while (i < lines.length && lines[i].startsWith("> ")) {
				quoteLines.push(lines[i].slice(2));
				i++;
			}
			const quoteText = quoteLines.join("\n");
			story.push({ inline: [{ blockquote: parseInlineMarkdown(quoteText) }] });
			continue;
		}
		if (line.trim() === "") {
			i++;
			continue;
		}
		const paragraphLines = [];
		while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#") && !lines[i].startsWith("```") && !lines[i].startsWith("> ") && !/^(-{3,}|\*{3,})$/.test(lines[i].trim())) {
			paragraphLines.push(lines[i]);
			i++;
		}
		if (paragraphLines.length > 0) {
			const inlines = parseInlineMarkdown(paragraphLines.join("\n"));
			const withBreaks = [];
			for (const inline of inlines) if (typeof inline === "string" && inline.includes("\n")) {
				const parts = inline.split("\n");
				for (let j = 0; j < parts.length; j++) {
					if (parts[j]) withBreaks.push(parts[j]);
					if (j < parts.length - 1) withBreaks.push({ break: null });
				}
			} else withBreaks.push(inline);
			const { inlines: cleanInlines, imageBlocks } = processInlinesForImages(withBreaks);
			if (cleanInlines.length > 0) story.push({ inline: cleanInlines });
			story.push(...imageBlocks);
		}
	}
	return story;
}
//#endregion
//#region extensions/tlon/src/urbit/send.ts
var import_dist = require_dist();
async function sendDm({ api, fromShip, toShip, text }) {
	return sendDmWithStory({
		api,
		fromShip,
		toShip,
		story: markdownToStory(text)
	});
}
async function sendDmWithStory({ api, fromShip, toShip, story }) {
	const sentAt = Date.now();
	const id = `${fromShip}/${(0, import_dist.scot)("ud", import_dist.da.fromUnix(sentAt))}`;
	const action = {
		ship: toShip,
		diff: {
			id,
			delta: { add: {
				memo: {
					content: story,
					author: fromShip,
					sent: sentAt
				},
				kind: null,
				time: null
			} }
		}
	};
	await api.poke({
		app: "chat",
		mark: "chat-dm-action",
		json: action
	});
	return {
		channel: "tlon",
		messageId: id
	};
}
async function sendGroupMessage({ api, fromShip, hostShip, channelName, text, replyToId }) {
	return sendGroupMessageWithStory({
		api,
		fromShip,
		hostShip,
		channelName,
		story: markdownToStory(text),
		replyToId
	});
}
async function sendGroupMessageWithStory({ api, fromShip, hostShip, channelName, story, replyToId }) {
	const sentAt = Date.now();
	let formattedReplyId = replyToId;
	if (replyToId && /^\d+$/.test(replyToId)) try {
		formattedReplyId = (0, import_dist.scot)("ud", BigInt(replyToId));
	} catch {}
	const action = { channel: {
		nest: `chat/${hostShip}/${channelName}`,
		action: formattedReplyId ? { post: { reply: {
			id: formattedReplyId,
			action: { add: {
				content: story,
				author: fromShip,
				sent: sentAt
			} }
		} } } : { post: { add: {
			content: story,
			author: fromShip,
			sent: sentAt,
			kind: "/chat",
			blob: null,
			meta: null
		} } }
	} };
	await api.poke({
		app: "channels",
		mark: "channel-action-1",
		json: action
	});
	return {
		channel: "tlon",
		messageId: `${fromShip}/${sentAt}`
	};
}
/**
* Build a story with text and optional media (image)
*/
function buildMediaStory(text, mediaUrl) {
	const story = [];
	const cleanText = text?.trim() ?? "";
	const cleanUrl = mediaUrl?.trim() ?? "";
	if (cleanText) story.push(...markdownToStory(cleanText));
	if (cleanUrl && isImageUrl(cleanUrl)) story.push(createImageBlock(cleanUrl, ""));
	else if (cleanUrl) story.push({ inline: [{ link: {
		href: cleanUrl,
		content: cleanUrl
	} }] });
	return story.length > 0 ? story : [{ inline: [""] }];
}
//#endregion
//#region extensions/tlon/src/urbit/channel-ops.ts
async function putUrbitChannel(deps, params) {
	return await urbitFetch({
		baseUrl: deps.baseUrl,
		path: `/~/channel/${deps.channelId}`,
		init: {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Cookie: deps.cookie
			},
			body: JSON.stringify(params.body)
		},
		ssrfPolicy: deps.ssrfPolicy,
		lookupFn: deps.lookupFn,
		fetchImpl: deps.fetchImpl,
		timeoutMs: 3e4,
		auditContext: params.auditContext
	});
}
async function pokeUrbitChannel(deps, params) {
	const pokeId = Date.now();
	const { response, release } = await putUrbitChannel(deps, {
		body: [{
			id: pokeId,
			action: "poke",
			ship: deps.ship,
			app: params.app,
			mark: params.mark,
			json: params.json
		}],
		auditContext: params.auditContext
	});
	try {
		if (!response.ok && response.status !== 204) {
			const errorText = await response.text().catch(() => "");
			throw new Error(`Poke failed: ${response.status}${errorText ? ` - ${errorText}` : ""}`);
		}
		return pokeId;
	} finally {
		await release();
	}
}
async function scryUrbitPath(deps, params) {
	const scryPath = `/~/scry${params.path}`;
	const { response, release } = await urbitFetch({
		baseUrl: deps.baseUrl,
		path: scryPath,
		init: {
			method: "GET",
			headers: { Cookie: deps.cookie }
		},
		ssrfPolicy: deps.ssrfPolicy,
		lookupFn: deps.lookupFn,
		fetchImpl: deps.fetchImpl,
		timeoutMs: 3e4,
		auditContext: params.auditContext
	});
	try {
		if (!response.ok) throw new Error(`Scry failed: ${response.status} for path ${params.path}`);
		return await response.json();
	} finally {
		await release();
	}
}
async function createUrbitChannel(deps, params) {
	const { response, release } = await putUrbitChannel(deps, params);
	try {
		if (!response.ok && response.status !== 204) throw new UrbitHttpError({
			operation: "Channel creation",
			status: response.status
		});
	} finally {
		await release();
	}
}
async function wakeUrbitChannel(deps) {
	const { response, release } = await putUrbitChannel(deps, {
		body: [{
			id: Date.now(),
			action: "poke",
			ship: deps.ship,
			app: "hood",
			mark: "helm-hi",
			json: "Opening API channel"
		}],
		auditContext: "tlon-urbit-channel-wake"
	});
	try {
		if (!response.ok && response.status !== 204) throw new UrbitHttpError({
			operation: "Channel activation",
			status: response.status
		});
	} finally {
		await release();
	}
}
async function ensureUrbitChannelOpen(deps, params) {
	await createUrbitChannel(deps, {
		body: params.createBody,
		auditContext: params.createAuditContext
	});
	await wakeUrbitChannel(deps);
}
//#endregion
//#region extensions/tlon/src/urbit/sse-client.ts
var UrbitSSEClient = class {
	constructor(url, cookie, options = {}) {
		this.subscriptions = [];
		this.eventHandlers = /* @__PURE__ */ new Map();
		this.aborted = false;
		this.streamController = null;
		this.reconnectAttempts = 0;
		this.isConnected = false;
		this.streamRelease = null;
		this.lastHeardEventId = -1;
		this.lastAcknowledgedEventId = -1;
		this.ackThreshold = 20;
		const ctx = getUrbitContext(url, options.ship);
		this.url = ctx.baseUrl;
		this.cookie = normalizeUrbitCookie(cookie);
		this.ship = ctx.ship;
		this.channelId = `${Math.floor(Date.now() / 1e3)}-${randomUUID()}`;
		this.channelUrl = new URL(`/~/channel/${this.channelId}`, this.url).toString();
		this.onReconnect = options.onReconnect ?? null;
		this.autoReconnect = options.autoReconnect !== false;
		this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
		this.reconnectDelay = options.reconnectDelay ?? 1e3;
		this.maxReconnectDelay = options.maxReconnectDelay ?? 3e4;
		this.logger = options.logger ?? {};
		this.ssrfPolicy = options.ssrfPolicy;
		this.lookupFn = options.lookupFn;
		this.fetchImpl = options.fetchImpl;
	}
	async subscribe(params) {
		const subId = this.subscriptions.length + 1;
		const subscription = {
			id: subId,
			action: "subscribe",
			ship: this.ship,
			app: params.app,
			path: params.path
		};
		this.subscriptions.push(subscription);
		this.eventHandlers.set(subId, {
			event: params.event,
			err: params.err,
			quit: params.quit
		});
		if (this.isConnected) try {
			await this.sendSubscription(subscription);
		} catch (error) {
			this.eventHandlers.get(subId)?.err?.(error);
		}
		return subId;
	}
	async sendSubscription(subscription) {
		const { response, release } = await this.putChannelPayload([subscription], {
			timeoutMs: 3e4,
			auditContext: "tlon-urbit-subscribe"
		});
		try {
			if (!response.ok && response.status !== 204) {
				const errorText = await response.text().catch(() => "");
				throw new Error(`Subscribe failed: ${response.status}${errorText ? ` - ${errorText}` : ""}`);
			}
		} finally {
			await release();
		}
	}
	async connect() {
		await ensureUrbitChannelOpen({
			baseUrl: this.url,
			cookie: this.cookie,
			ship: this.ship,
			channelId: this.channelId,
			ssrfPolicy: this.ssrfPolicy,
			lookupFn: this.lookupFn,
			fetchImpl: this.fetchImpl
		}, {
			createBody: this.subscriptions,
			createAuditContext: "tlon-urbit-channel-create"
		});
		await this.openStream();
		this.isConnected = true;
		this.reconnectAttempts = 0;
	}
	async openStream() {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 6e4);
		this.streamController = controller;
		const { response, release } = await urbitFetch({
			baseUrl: this.url,
			path: `/~/channel/${this.channelId}`,
			init: {
				method: "GET",
				headers: {
					Accept: "text/event-stream",
					Cookie: this.cookie
				}
			},
			ssrfPolicy: this.ssrfPolicy,
			lookupFn: this.lookupFn,
			fetchImpl: this.fetchImpl,
			signal: controller.signal,
			auditContext: "tlon-urbit-sse-stream"
		});
		this.streamRelease = release;
		clearTimeout(timeoutId);
		if (!response.ok) {
			await release();
			this.streamRelease = null;
			throw new Error(`Stream connection failed: ${response.status}`);
		}
		this.processStream(response.body).catch((error) => {
			if (!this.aborted) {
				this.logger.error?.(`Stream error: ${String(error)}`);
				for (const { err } of this.eventHandlers.values()) if (err) err(error);
			}
		});
	}
	async processStream(body) {
		if (!body) return;
		const stream = body instanceof ReadableStream ? Readable.fromWeb(body) : body;
		let buffer = "";
		try {
			for await (const chunk of stream) {
				if (this.aborted) break;
				buffer += chunk.toString();
				let eventEnd;
				while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
					const eventData = buffer.substring(0, eventEnd);
					buffer = buffer.substring(eventEnd + 2);
					this.processEvent(eventData);
				}
			}
		} finally {
			if (this.streamRelease) {
				const release = this.streamRelease;
				this.streamRelease = null;
				await release();
			}
			this.streamController = null;
			if (!this.aborted && this.autoReconnect) {
				this.isConnected = false;
				this.logger.log?.("[SSE] Stream ended, attempting reconnection...");
				await this.attemptReconnect();
			}
		}
	}
	processEvent(eventData) {
		const lines = eventData.split("\n");
		let data = null;
		let eventId = null;
		for (const line of lines) {
			if (line.startsWith("id: ")) eventId = parseInt(line.substring(4), 10);
			if (line.startsWith("data: ")) data = line.substring(6);
		}
		if (!data) return;
		if (eventId !== null && !isNaN(eventId)) {
			if (eventId > this.lastHeardEventId) {
				this.lastHeardEventId = eventId;
				if (eventId - this.lastAcknowledgedEventId > this.ackThreshold) {
					this.logger.log?.(`[SSE] Acking event ${eventId} (last acked: ${this.lastAcknowledgedEventId})`);
					this.ack(eventId).catch((err) => {
						this.logger.error?.(`Failed to ack event ${eventId}: ${String(err)}`);
					});
				}
			}
		}
		try {
			const parsed = JSON.parse(data);
			if (parsed.response === "quit") {
				if (parsed.id) {
					const handlers = this.eventHandlers.get(parsed.id);
					if (handlers?.quit) handlers.quit();
				}
				return;
			}
			if (parsed.id && this.eventHandlers.has(parsed.id)) {
				const { event } = this.eventHandlers.get(parsed.id) ?? {};
				if (event && parsed.json) event(parsed.json);
			} else if (parsed.json) {
				for (const { event } of this.eventHandlers.values()) if (event) event(parsed.json);
			}
		} catch (error) {
			this.logger.error?.(`Error parsing SSE event: ${String(error)}`);
		}
	}
	async poke(params) {
		return await pokeUrbitChannel({
			baseUrl: this.url,
			cookie: this.cookie,
			ship: this.ship,
			channelId: this.channelId,
			ssrfPolicy: this.ssrfPolicy,
			lookupFn: this.lookupFn,
			fetchImpl: this.fetchImpl
		}, {
			...params,
			auditContext: "tlon-urbit-poke"
		});
	}
	async scry(path) {
		return await scryUrbitPath({
			baseUrl: this.url,
			cookie: this.cookie,
			ssrfPolicy: this.ssrfPolicy,
			lookupFn: this.lookupFn,
			fetchImpl: this.fetchImpl
		}, {
			path,
			auditContext: "tlon-urbit-scry"
		});
	}
	/**
	* Update the cookie used for authentication.
	* Call this when re-authenticating after session expiry.
	*/
	updateCookie(newCookie) {
		this.cookie = normalizeUrbitCookie(newCookie);
	}
	async ack(eventId) {
		this.lastAcknowledgedEventId = eventId;
		const ackData = {
			id: Date.now(),
			action: "ack",
			"event-id": eventId
		};
		const { response, release } = await this.putChannelPayload([ackData], {
			timeoutMs: 1e4,
			auditContext: "tlon-urbit-ack"
		});
		try {
			if (!response.ok) throw new Error(`Ack failed with status ${response.status}`);
		} finally {
			await release();
		}
	}
	async attemptReconnect() {
		if (this.aborted || !this.autoReconnect) {
			this.logger.log?.("[SSE] Reconnection aborted or disabled");
			return;
		}
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			this.logger.log?.(`[SSE] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Waiting 10s before resetting...`);
			const extendedBackoff = 1e4;
			await new Promise((resolve) => setTimeout(resolve, extendedBackoff));
			this.reconnectAttempts = 0;
			this.logger.log?.("[SSE] Reconnection attempts reset, resuming reconnection...");
		}
		this.reconnectAttempts += 1;
		const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
		this.logger.log?.(`[SSE] Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);
		await new Promise((resolve) => setTimeout(resolve, delay));
		try {
			this.channelId = `${Math.floor(Date.now() / 1e3)}-${randomUUID()}`;
			this.channelUrl = new URL(`/~/channel/${this.channelId}`, this.url).toString();
			if (this.onReconnect) await this.onReconnect(this);
			await this.connect();
			this.logger.log?.("[SSE] Reconnection successful!");
		} catch (error) {
			this.logger.error?.(`[SSE] Reconnection failed: ${String(error)}`);
			await this.attemptReconnect();
		}
	}
	async close() {
		this.aborted = true;
		this.isConnected = false;
		this.streamController?.abort();
		try {
			const unsubscribes = this.subscriptions.map((sub) => ({
				id: sub.id,
				action: "unsubscribe",
				subscription: sub.id
			}));
			{
				const { response, release } = await this.putChannelPayload(unsubscribes, {
					timeoutMs: 3e4,
					auditContext: "tlon-urbit-unsubscribe"
				});
				try {
					response.body?.cancel();
				} finally {
					await release();
				}
			}
			{
				const { response, release } = await urbitFetch({
					baseUrl: this.url,
					path: `/~/channel/${this.channelId}`,
					init: {
						method: "DELETE",
						headers: { Cookie: this.cookie }
					},
					ssrfPolicy: this.ssrfPolicy,
					lookupFn: this.lookupFn,
					fetchImpl: this.fetchImpl,
					timeoutMs: 3e4,
					auditContext: "tlon-urbit-channel-close"
				});
				try {
					response.body?.cancel();
				} finally {
					await release();
				}
			}
		} catch (error) {
			this.logger.error?.(`Error closing channel: ${String(error)}`);
		}
		if (this.streamRelease) {
			const release = this.streamRelease;
			this.streamRelease = null;
			await release();
		}
	}
	async putChannelPayload(payload, params) {
		return await urbitFetch({
			baseUrl: this.url,
			path: `/~/channel/${this.channelId}`,
			init: {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Cookie: this.cookie
				},
				body: JSON.stringify(payload)
			},
			ssrfPolicy: this.ssrfPolicy,
			lookupFn: this.lookupFn,
			fetchImpl: this.fetchImpl,
			timeoutMs: params.timeoutMs,
			auditContext: params.auditContext
		});
	}
};
//#endregion
//#region extensions/tlon/src/monitor/approval.ts
/**
* Generate a unique approval ID in the format: {type}-{timestamp}-{shortHash}
*/
function generateApprovalId(type) {
	return `${type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
}
/**
* Create a pending approval object.
*/
function createPendingApproval(params) {
	return {
		id: generateApprovalId(params.type),
		type: params.type,
		requestingShip: params.requestingShip,
		channelNest: params.channelNest,
		groupFlag: params.groupFlag,
		messagePreview: params.messagePreview,
		originalMessage: params.originalMessage,
		timestamp: Date.now()
	};
}
/**
* Truncate text to a maximum length with ellipsis.
*/
function truncate(text, maxLength) {
	if (text.length <= maxLength) return text;
	return text.substring(0, maxLength - 3) + "...";
}
/**
* Format a notification message for the owner about a pending approval.
*/
function formatApprovalRequest(approval) {
	const preview = approval.messagePreview ? `\n"${truncate(approval.messagePreview, 100)}"` : "";
	switch (approval.type) {
		case "dm": return `New DM request from ${approval.requestingShip}:${preview}\n\nReply "approve", "deny", or "block" (ID: ${approval.id})`;
		case "channel": return `${approval.requestingShip} mentioned you in ${approval.channelNest}:${preview}\n\nReply "approve", "deny", or "block"\n(ID: ${approval.id})`;
		case "group": return `Group invite from ${approval.requestingShip} to join ${approval.groupFlag}\n\nReply "approve", "deny", or "block"\n(ID: ${approval.id})`;
	}
}
/**
* Parse an owner's response to an approval request.
* Supports formats:
*   - "approve" / "deny" / "block" (applies to most recent pending)
*   - "approve dm-1234567890-abc" / "deny dm-1234567890-abc" (specific ID)
*   - "block" permanently blocks the ship via Tlon's native blocking
*/
function parseApprovalResponse(text) {
	const match = text.trim().toLowerCase().match(/^(approve|deny|block)(?:\s+(.+))?$/);
	if (!match) return null;
	return {
		action: match[1],
		id: match[2]?.trim()
	};
}
/**
* Check if a message text looks like an approval response.
* Used to determine if we should intercept the message before normal processing.
*/
function isApprovalResponse(text) {
	const trimmed = text.trim().toLowerCase();
	return trimmed.startsWith("approve") || trimmed.startsWith("deny") || trimmed.startsWith("block");
}
/**
* Find a pending approval by ID, or return the most recent if no ID specified.
*/
function findPendingApproval(pendingApprovals, id) {
	if (id) return pendingApprovals.find((a) => a.id === id);
	return pendingApprovals[pendingApprovals.length - 1];
}
/**
* Remove a pending approval from the list by ID.
*/
function removePendingApproval(pendingApprovals, id) {
	return pendingApprovals.filter((a) => a.id !== id);
}
/**
* Format a confirmation message after an approval action.
*/
function formatApprovalConfirmation(approval, action) {
	if (action === "block") return `Blocked ${approval.requestingShip}. They will no longer be able to contact the bot.`;
	const actionText = action === "approve" ? "Approved" : "Denied";
	switch (approval.type) {
		case "dm":
			if (action === "approve") return `${actionText} DM access for ${approval.requestingShip}. They can now message the bot.`;
			return `${actionText} DM request from ${approval.requestingShip}.`;
		case "channel":
			if (action === "approve") return `${actionText} ${approval.requestingShip} for ${approval.channelNest}. They can now interact in this channel.`;
			return `${actionText} ${approval.requestingShip} for ${approval.channelNest}.`;
		case "group":
			if (action === "approve") return `${actionText} group invite from ${approval.requestingShip} to ${approval.groupFlag}. Joining group...`;
			return `${actionText} group invite from ${approval.requestingShip} to ${approval.groupFlag}.`;
	}
}
/**
* Parse an admin command from owner message.
* Supports:
*   - "unblock ~ship" - unblock a specific ship
*   - "blocked" - list all blocked ships
*   - "pending" - list all pending approvals
*/
function parseAdminCommand(text) {
	const trimmed = text.trim().toLowerCase();
	if (trimmed === "blocked") return { type: "blocked" };
	if (trimmed === "pending") return { type: "pending" };
	const unblockMatch = trimmed.match(/^unblock\s+(~[\w-]+)$/);
	if (unblockMatch) return {
		type: "unblock",
		ship: unblockMatch[1]
	};
	return null;
}
/**
* Check if a message text looks like an admin command.
*/
function isAdminCommand(text) {
	return parseAdminCommand(text) !== null;
}
/**
* Format the list of blocked ships for display to owner.
*/
function formatBlockedList(ships) {
	if (ships.length === 0) return "No ships are currently blocked.";
	return `Blocked ships (${ships.length}):\n${ships.map((s) => `• ${s}`).join("\n")}`;
}
/**
* Format the list of pending approvals for display to owner.
*/
function formatPendingList(approvals) {
	if (approvals.length === 0) return "No pending approval requests.";
	return `Pending approvals (${approvals.length}):\n${approvals.map((a) => `• ${a.id}: ${a.type} from ${a.requestingShip}`).join("\n")}`;
}
//#endregion
//#region extensions/tlon/src/monitor/utils.ts
function extractCites(content) {
	if (!content || !Array.isArray(content)) return [];
	const cites = [];
	for (const verse of content) if (verse?.block?.cite && typeof verse.block.cite === "object") {
		const cite = verse.block.cite;
		if (cite.chan && typeof cite.chan === "object") {
			const { nest, where } = cite.chan;
			const whereMatch = where?.match(/\/msg\/(~[a-z-]+)\/(.+)/);
			cites.push({
				type: "chan",
				nest,
				where,
				author: whereMatch?.[1],
				postId: whereMatch?.[2]
			});
		} else if (cite.group && typeof cite.group === "string") cites.push({
			type: "group",
			group: cite.group
		});
		else if (cite.desk && typeof cite.desk === "object") cites.push({
			type: "desk",
			flag: cite.desk.flag,
			where: cite.desk.where
		});
		else if (cite.bait && typeof cite.bait === "object") cites.push({
			type: "bait",
			group: cite.bait.group,
			nest: cite.bait.graph,
			where: cite.bait.where
		});
	}
	return cites;
}
function formatModelName(modelString) {
	if (!modelString) return "AI";
	const modelName = modelString.includes("/") ? modelString.split("/")[1] : modelString;
	const modelMappings = {
		"claude-opus-4-5": "Claude Opus 4.5",
		"claude-sonnet-4-5": "Claude Sonnet 4.5",
		"claude-sonnet-3-5": "Claude Sonnet 3.5",
		"gpt-4o": "GPT-4o",
		"gpt-4-turbo": "GPT-4 Turbo",
		"gpt-4": "GPT-4",
		"gemini-2.0-flash": "Gemini 2.0 Flash",
		"gemini-pro": "Gemini Pro"
	};
	if (modelMappings[modelName]) return modelMappings[modelName];
	return modelName.replace(/-/g, " ").split(" ").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
function isBotMentioned(messageText, botShipName, nickname) {
	if (!messageText || !botShipName) return false;
	if (/@all\b/i.test(messageText)) return true;
	const escapedShip = normalizeShip(botShipName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`(^|\\s)${escapedShip}(?=\\s|$)`, "i").test(messageText)) return true;
	if (nickname) {
		const escapedNickname = nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`(^|\\s)${escapedNickname}(?=\\s|$|[,!?.])`, "i").test(messageText)) return true;
	}
	return false;
}
/**
* Strip bot ship mention from message text for command detection.
* "~bot-ship /status" → "/status"
*/
function stripBotMention(messageText, botShipName) {
	if (!messageText || !botShipName) return messageText;
	return messageText.replace(normalizeShip(botShipName), "").trim();
}
function isDmAllowed(senderShip, allowlist) {
	if (!allowlist || allowlist.length === 0) return false;
	const normalizedSender = normalizeShip(senderShip);
	return allowlist.map((ship) => normalizeShip(ship)).some((ship) => ship === normalizedSender);
}
function renderInlineItem(item, options) {
	if (typeof item === "string") return item;
	if (!item || typeof item !== "object") return "";
	if (item.ship) return item.ship;
	if ("sect" in item) return `@${item.sect || "all"}`;
	if (options?.allowBreak && item.break !== void 0) return "\n";
	if (item["inline-code"]) return `\`${item["inline-code"]}\``;
	if (item.code) return `\`${item.code}\``;
	if (item.link && item.link.href) return options?.linkMode === "href" ? item.link.href : item.link.content || item.link.href;
	if (item.bold && Array.isArray(item.bold)) return `**${extractInlineText(item.bold)}**`;
	if (item.italics && Array.isArray(item.italics)) return `*${extractInlineText(item.italics)}*`;
	if (item.strike && Array.isArray(item.strike)) return `~~${extractInlineText(item.strike)}~~`;
	if (options?.allowBlockquote && item.blockquote && Array.isArray(item.blockquote)) return `> ${extractInlineText(item.blockquote)}`;
	return "";
}
function extractInlineText(items) {
	return items.map((item) => renderInlineItem(item)).join("");
}
function extractMessageText(content) {
	if (!content || !Array.isArray(content)) return "";
	return content.map((verse) => {
		if (verse.inline && Array.isArray(verse.inline)) return verse.inline.map((item) => renderInlineItem(item, {
			linkMode: "href",
			allowBreak: true,
			allowBlockquote: true
		})).join("");
		if (verse.block && typeof verse.block === "object") {
			const block = verse.block;
			if (block.image && block.image.src) {
				const alt = block.image.alt ? ` (${block.image.alt})` : "";
				return `\n${block.image.src}${alt}\n`;
			}
			if (block.code && typeof block.code === "object") return `\n\`\`\`${block.code.lang || ""}\n${block.code.code || ""}\n\`\`\`\n`;
			if (block.header && typeof block.header === "object") return `\n## ${block.header.content?.map((item) => typeof item === "string" ? item : "").join("") || ""}\n`;
			if (block.cite && typeof block.cite === "object") {
				const cite = block.cite;
				if (cite.chan && typeof cite.chan === "object") {
					const { nest, where } = cite.chan;
					const whereMatch = where?.match(/\/msg\/(~[a-z-]+)\/(.+)/);
					if (whereMatch) {
						const [, author, _postId] = whereMatch;
						return `\n> [quoted: ${author} in ${nest}]\n`;
					}
					return `\n> [quoted from ${nest}]\n`;
				}
				if (cite.group && typeof cite.group === "string") return `\n> [ref: group ${cite.group}]\n`;
				if (cite.desk && typeof cite.desk === "object") return `\n> [ref: ${cite.desk.flag}]\n`;
				if (cite.bait && typeof cite.bait === "object") return `\n> [ref: ${cite.bait.graph} in ${cite.bait.group}]\n`;
				return `\n> [quoted message]\n`;
			}
		}
		return "";
	}).join("\n").trim();
}
function isSummarizationRequest(messageText) {
	return [
		/summarize\s+(this\s+)?(channel|chat|conversation)/i,
		/what\s+did\s+i\s+miss/i,
		/catch\s+me\s+up/i,
		/channel\s+summary/i,
		/tldr/i
	].some((pattern) => pattern.test(messageText));
}
//#endregion
//#region extensions/tlon/src/monitor/discovery.ts
/**
* Fetch groups-ui init data, returning channels and foreigns.
* This is a single scry that provides both channel discovery and pending invites.
*/
async function fetchInitData(api, runtime) {
	try {
		runtime.log?.("[tlon] Fetching groups-ui init data...");
		const initData = await api.scry("/groups-ui/v6/init.json");
		const channels = [];
		if (initData?.groups) {
			for (const groupData of Object.values(initData.groups)) if (groupData && typeof groupData === "object" && groupData.channels) {
				for (const channelNest of Object.keys(groupData.channels)) if (channelNest.startsWith("chat/")) channels.push(channelNest);
			}
		}
		if (channels.length > 0) runtime.log?.(`[tlon] Auto-discovered ${channels.length} chat channel(s)`);
		else runtime.log?.("[tlon] No chat channels found via auto-discovery");
		const foreigns = initData?.foreigns || null;
		if (foreigns) {
			const pendingCount = Object.values(foreigns).filter((f) => f.invites?.some((i) => i.valid)).length;
			if (pendingCount > 0) runtime.log?.(`[tlon] Found ${pendingCount} pending group invite(s)`);
		}
		return {
			channels,
			foreigns
		};
	} catch (error) {
		runtime.log?.(`[tlon] Init data fetch failed: ${error?.message ?? String(error)}`);
		return {
			channels: [],
			foreigns: null
		};
	}
}
async function fetchAllChannels(api, runtime) {
	const { channels } = await fetchInitData(api, runtime);
	return channels;
}
//#endregion
//#region extensions/tlon/src/monitor/history.ts
/**
* Format a number as @ud (with dots every 3 digits from the right)
* e.g., 170141184507799509469114119040828178432 -> 170.141.184.507.799.509.469.114.119.040.828.178.432
*/
function formatUd(id) {
	const reversed = String(id).replace(/\./g, "").split("").toReversed();
	const chunks = [];
	for (let i = 0; i < reversed.length; i += 3) chunks.push(reversed.slice(i, i + 3).toReversed().join(""));
	return chunks.toReversed().join(".");
}
const messageCache = /* @__PURE__ */ new Map();
const MAX_CACHED_MESSAGES = 100;
function cacheMessage(channelNest, message) {
	if (!messageCache.has(channelNest)) messageCache.set(channelNest, []);
	const cache = messageCache.get(channelNest);
	if (!cache) return;
	cache.unshift(message);
	if (cache.length > MAX_CACHED_MESSAGES) cache.pop();
}
async function fetchChannelHistory(api, channelNest, count = 50, runtime) {
	try {
		const scryPath = `/channels/v4/${channelNest}/posts/newest/${count}/outline.json`;
		runtime?.log?.(`[tlon] Fetching history: ${scryPath}`);
		const data = await api.scry(scryPath);
		if (!data) return [];
		let posts = [];
		if (Array.isArray(data)) posts = data;
		else if (data.posts && typeof data.posts === "object") posts = Object.values(data.posts);
		else if (typeof data === "object") posts = Object.values(data);
		const messages = posts.map((item) => {
			const essay = item.essay || item["r-post"]?.set?.essay;
			const seal = item.seal || item["r-post"]?.set?.seal;
			return {
				author: essay?.author || "unknown",
				content: extractMessageText(essay?.content || []),
				timestamp: essay?.sent || Date.now(),
				id: seal?.id
			};
		}).filter((msg) => msg.content);
		runtime?.log?.(`[tlon] Extracted ${messages.length} messages from history`);
		return messages;
	} catch (error) {
		runtime?.log?.(`[tlon] Error fetching channel history: ${error?.message ?? String(error)}`);
		return [];
	}
}
async function getChannelHistory(api, channelNest, count = 50, runtime) {
	const cache = messageCache.get(channelNest) ?? [];
	if (cache.length >= count) {
		runtime?.log?.(`[tlon] Using cached messages (${cache.length} available)`);
		return cache.slice(0, count);
	}
	runtime?.log?.(`[tlon] Cache has ${cache.length} messages, need ${count}, fetching from scry...`);
	return await fetchChannelHistory(api, channelNest, count, runtime);
}
/**
* Fetch thread/reply history for a specific parent post.
* Used to get context when entering a thread conversation.
*/
async function fetchThreadHistory(api, channelNest, parentId, count = 50, runtime) {
	try {
		const formattedParentId = formatUd(parentId);
		runtime?.log?.(`[tlon] Thread history - parentId: ${parentId} -> formatted: ${formattedParentId}`);
		const scryPath = `/channels/v4/${channelNest}/posts/post/id/${formattedParentId}/replies/newest/${count}.json`;
		runtime?.log?.(`[tlon] Fetching thread history: ${scryPath}`);
		const data = await api.scry(scryPath);
		if (!data) {
			runtime?.log?.(`[tlon] No thread history data returned`);
			return [];
		}
		let replies = [];
		if (Array.isArray(data)) replies = data;
		else if (data.replies && Array.isArray(data.replies)) replies = data.replies;
		else if (typeof data === "object") replies = Object.values(data);
		const messages = replies.map((item) => {
			const memo = item.memo || item["r-reply"]?.set?.memo || item;
			const seal = item.seal || item["r-reply"]?.set?.seal;
			return {
				author: memo?.author || "unknown",
				content: extractMessageText(memo?.content || []),
				timestamp: memo?.sent || Date.now(),
				id: seal?.id || item.id
			};
		}).filter((msg) => msg.content);
		runtime?.log?.(`[tlon] Extracted ${messages.length} thread replies from history`);
		return messages;
	} catch (error) {
		runtime?.log?.(`[tlon] Error fetching thread history: ${error?.message ?? String(error)}`);
		try {
			const altPath = `/channels/v4/${channelNest}/posts/post/id/${formatUd(parentId)}.json`;
			runtime?.log?.(`[tlon] Trying alternate path: ${altPath}`);
			const data = await api.scry(altPath);
			if (data?.seal?.meta?.replyCount > 0 && data?.replies) {
				const messages = (Array.isArray(data.replies) ? data.replies : Object.values(data.replies)).map((reply) => ({
					author: reply.memo?.author || "unknown",
					content: extractMessageText(reply.memo?.content || []),
					timestamp: reply.memo?.sent || Date.now(),
					id: reply.seal?.id
				})).filter((msg) => msg.content);
				runtime?.log?.(`[tlon] Extracted ${messages.length} replies from post data`);
				return messages;
			}
		} catch (altError) {
			runtime?.log?.(`[tlon] Alternate path also failed: ${altError?.message ?? String(altError)}`);
		}
		return [];
	}
}
//#endregion
//#region extensions/tlon/src/monitor/media.ts
const DEFAULT_MEDIA_DIR = path$1.join(homedir(), ".openclaw", "workspace", "media", "inbound");
/**
* Extract image blocks from Tlon message content.
* Returns array of image URLs found in the message.
*/
function extractImageBlocks(content) {
	if (!content || !Array.isArray(content)) return [];
	const images = [];
	for (const verse of content) if (verse?.block?.image?.src) images.push({
		url: verse.block.image.src,
		alt: verse.block.image.alt
	});
	return images;
}
/**
* Download a media file from URL to local storage.
* Returns the local path where the file was saved.
*/
async function downloadMedia(url, mediaDir = DEFAULT_MEDIA_DIR) {
	try {
		const parsedUrl = new URL(url);
		if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
			console.warn(`[tlon-media] Rejected non-http(s) URL: ${url}`);
			return null;
		}
		await mkdir(mediaDir, { recursive: true });
		const { response, release } = await fetchWithSsrFGuard({
			url,
			init: { method: "GET" },
			policy: /* @__PURE__ */ getDefaultSsrFPolicy(),
			auditContext: "tlon-media-download"
		});
		try {
			if (!response.ok) {
				console.error(`[tlon-media] Failed to fetch ${url}: ${response.status}`);
				return null;
			}
			const contentType = response.headers.get("content-type") || "application/octet-stream";
			const ext = getExtensionFromContentType(contentType) || getExtensionFromUrl(url) || "bin";
			const filename = `${randomUUID()}.${ext}`;
			const localPath = path$1.join(mediaDir, filename);
			const body = response.body;
			if (!body) {
				console.error(`[tlon-media] No response body for ${url}`);
				return null;
			}
			const writeStream = createWriteStream(localPath);
			await pipeline(Readable.fromWeb(body), writeStream);
			return {
				localPath,
				contentType,
				originalUrl: url
			};
		} finally {
			await release();
		}
	} catch (error) {
		console.error(`[tlon-media] Error downloading ${url}: ${error?.message ?? String(error)}`);
		return null;
	}
}
function getExtensionFromContentType(contentType) {
	return {
		"image/jpeg": "jpg",
		"image/jpg": "jpg",
		"image/png": "png",
		"image/gif": "gif",
		"image/webp": "webp",
		"image/svg+xml": "svg",
		"video/mp4": "mp4",
		"video/webm": "webm",
		"audio/mpeg": "mp3",
		"audio/ogg": "ogg"
	}[contentType.split(";")[0].trim()] ?? null;
}
function getExtensionFromUrl(url) {
	try {
		const match = new URL(url).pathname.match(/\.([a-z0-9]+)$/i);
		return match ? match[1].toLowerCase() : null;
	} catch {
		return null;
	}
}
/**
* Download all images from a message and return attachment metadata.
* Format matches OpenClaw's expected attachment structure.
*/
async function downloadMessageImages(content, mediaDir) {
	const images = extractImageBlocks(content);
	if (images.length === 0) return [];
	const attachments = [];
	for (const image of images) {
		const downloaded = await downloadMedia(image.url, mediaDir);
		if (downloaded) attachments.push({
			path: downloaded.localPath,
			contentType: downloaded.contentType
		});
	}
	return attachments;
}
//#endregion
//#region extensions/tlon/src/monitor/processed-messages.ts
function createProcessedMessageTracker(limit = 2e3) {
	const dedupe = createDedupeCache({
		ttlMs: 0,
		maxSize: limit
	});
	const mark = (id) => {
		const trimmed = id?.trim();
		if (!trimmed) return true;
		return !dedupe.check(trimmed);
	};
	const has = (id) => {
		const trimmed = id?.trim();
		if (!trimmed) return false;
		return dedupe.peek(trimmed);
	};
	return {
		mark,
		has,
		size: () => dedupe.size()
	};
}
//#endregion
//#region extensions/tlon/src/monitor/index.ts
/**
* Resolve channel authorization by merging file config with settings store.
* Settings store takes precedence for fields it defines.
*/
function resolveChannelAuthorization(cfg, channelNest, settings) {
	const tlonConfig = cfg.channels?.tlon;
	const fileRules = tlonConfig?.authorization?.channelRules ?? {};
	const rule = (settings?.channelRules ?? {})[channelNest] ?? fileRules[channelNest];
	const defaultShips = settings?.defaultAuthorizedShips ?? tlonConfig?.defaultAuthorizedShips ?? [];
	const allowedShips = rule?.allowedShips ?? defaultShips;
	return {
		mode: rule?.mode ?? "restricted",
		allowedShips
	};
}
async function monitorTlonProvider(opts = {}) {
	const core = getTlonRuntime();
	const cfg = core.config.loadConfig();
	if (cfg.channels?.tlon?.enabled === false) return;
	const logger = core.logging.getChildLogger({ module: "tlon-auto-reply" });
	const runtime = opts.runtime ?? createLoggerBackedRuntime({ logger });
	const account = resolveTlonAccount(cfg, opts.accountId ?? void 0);
	if (!account.enabled) return;
	if (!account.configured || !account.ship || !account.url || !account.code) throw new Error("Tlon account not configured (ship/url/code required)");
	const botShipName = normalizeShip(account.ship);
	runtime.log?.(`[tlon] Starting monitor for ${botShipName}`);
	const ssrfPolicy = ssrfPolicyFromAllowPrivateNetwork(account.allowPrivateNetwork);
	const accountUrl = account.url;
	const accountCode = account.code;
	async function authenticateWithRetry(maxAttempts = 10) {
		for (let attempt = 1;; attempt++) {
			if (opts.abortSignal?.aborted) throw new Error("Aborted while waiting to authenticate");
			try {
				runtime.log?.(`[tlon] Attempting authentication to ${accountUrl}...`);
				return await authenticate(accountUrl, accountCode, { ssrfPolicy });
			} catch (error) {
				runtime.error?.(`[tlon] Failed to authenticate (attempt ${attempt}): ${error?.message ?? String(error)}`);
				if (attempt >= maxAttempts) throw error;
				const delay = Math.min(3e4, 1e3 * Math.pow(2, attempt - 1));
				runtime.log?.(`[tlon] Retrying authentication in ${delay}ms...`);
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, delay);
					if (opts.abortSignal) {
						const onAbort = () => {
							clearTimeout(timer);
							reject(/* @__PURE__ */ new Error("Aborted"));
						};
						opts.abortSignal.addEventListener("abort", onAbort, { once: true });
					}
				});
			}
		}
	}
	let api = null;
	const cookie = await authenticateWithRetry();
	api = new UrbitSSEClient(account.url, cookie, {
		ship: botShipName,
		ssrfPolicy,
		logger: {
			log: (message) => runtime.log?.(message),
			error: (message) => runtime.error?.(message)
		},
		onReconnect: async (client) => {
			runtime.log?.("[tlon] Re-authenticating on SSE reconnect...");
			const newCookie = await authenticateWithRetry(5);
			client.updateCookie(newCookie);
			runtime.log?.("[tlon] Re-authentication successful");
		}
	});
	const processedTracker = createProcessedMessageTracker(2e3);
	let groupChannels = [];
	let botNickname = null;
	const settingsManager = createSettingsManager(api, {
		log: (msg) => runtime.log?.(msg),
		error: (msg) => runtime.error?.(msg)
	});
	let effectiveDmAllowlist = account.dmAllowlist;
	let effectiveShowModelSig = account.showModelSignature ?? false;
	let effectiveAutoAcceptDmInvites = account.autoAcceptDmInvites ?? false;
	let effectiveAutoAcceptGroupInvites = account.autoAcceptGroupInvites ?? false;
	let effectiveGroupInviteAllowlist = account.groupInviteAllowlist;
	let effectiveAutoDiscoverChannels = account.autoDiscoverChannels ?? false;
	let effectiveOwnerShip = account.ownerShip ? normalizeShip(account.ownerShip) : null;
	let pendingApprovals = [];
	let currentSettings = {};
	const participatedThreads = /* @__PURE__ */ new Set();
	const dmSendersBySession = /* @__PURE__ */ new Map();
	let sharedSessionWarningSent = false;
	try {
		const selfProfile = await api.scry("/contacts/v1/self.json");
		if (selfProfile && typeof selfProfile === "object") {
			botNickname = selfProfile.nickname?.value || null;
			if (botNickname) runtime.log?.(`[tlon] Bot nickname: ${botNickname}`);
		}
	} catch (error) {
		runtime.log?.(`[tlon] Could not fetch nickname: ${error?.message ?? String(error)}`);
	}
	let initForeigns = null;
	async function migrateConfigToSettings() {
		const migrations = [
			{
				key: "dmAllowlist",
				fileValue: account.dmAllowlist,
				settingsValue: currentSettings.dmAllowlist
			},
			{
				key: "groupInviteAllowlist",
				fileValue: account.groupInviteAllowlist,
				settingsValue: currentSettings.groupInviteAllowlist
			},
			{
				key: "groupChannels",
				fileValue: account.groupChannels,
				settingsValue: currentSettings.groupChannels
			},
			{
				key: "defaultAuthorizedShips",
				fileValue: account.defaultAuthorizedShips,
				settingsValue: currentSettings.defaultAuthorizedShips
			},
			{
				key: "autoDiscoverChannels",
				fileValue: account.autoDiscoverChannels,
				settingsValue: currentSettings.autoDiscoverChannels
			},
			{
				key: "autoAcceptDmInvites",
				fileValue: account.autoAcceptDmInvites,
				settingsValue: currentSettings.autoAcceptDmInvites
			},
			{
				key: "autoAcceptGroupInvites",
				fileValue: account.autoAcceptGroupInvites,
				settingsValue: currentSettings.autoAcceptGroupInvites
			},
			{
				key: "showModelSig",
				fileValue: account.showModelSignature,
				settingsValue: currentSettings.showModelSig
			}
		];
		for (const { key, fileValue, settingsValue } of migrations) {
			const hasFileValue = Array.isArray(fileValue) ? fileValue.length > 0 : fileValue != null;
			const hasSettingsValue = Array.isArray(settingsValue) ? settingsValue.length > 0 : settingsValue != null;
			if (hasFileValue && !hasSettingsValue) try {
				await api.poke({
					app: "settings",
					mark: "settings-event",
					json: { "put-entry": {
						"bucket-key": "tlon",
						"entry-key": key,
						value: fileValue,
						desk: "moltbot"
					} }
				});
				runtime.log?.(`[tlon] Migrated ${key} from config to settings store`);
			} catch (err) {
				runtime.log?.(`[tlon] Failed to migrate ${key}: ${String(err)}`);
			}
		}
	}
	try {
		currentSettings = await settingsManager.load();
		await migrateConfigToSettings();
		if (currentSettings.defaultAuthorizedShips?.length) runtime.log?.(`[tlon] Using defaultAuthorizedShips from settings store: ${currentSettings.defaultAuthorizedShips.join(", ")}`);
		if (currentSettings.autoDiscoverChannels !== void 0) {
			effectiveAutoDiscoverChannels = currentSettings.autoDiscoverChannels;
			runtime.log?.(`[tlon] Using autoDiscoverChannels from settings store: ${effectiveAutoDiscoverChannels}`);
		}
		if (currentSettings.dmAllowlist !== void 0) {
			effectiveDmAllowlist = currentSettings.dmAllowlist;
			runtime.log?.(`[tlon] Using dmAllowlist from settings store: ${effectiveDmAllowlist.join(", ")}`);
		}
		if (currentSettings.showModelSig !== void 0) effectiveShowModelSig = currentSettings.showModelSig;
		if (currentSettings.autoAcceptDmInvites !== void 0) {
			effectiveAutoAcceptDmInvites = currentSettings.autoAcceptDmInvites;
			runtime.log?.(`[tlon] Using autoAcceptDmInvites from settings store: ${effectiveAutoAcceptDmInvites}`);
		}
		if (currentSettings.autoAcceptGroupInvites !== void 0) {
			effectiveAutoAcceptGroupInvites = currentSettings.autoAcceptGroupInvites;
			runtime.log?.(`[tlon] Using autoAcceptGroupInvites from settings store: ${effectiveAutoAcceptGroupInvites}`);
		}
		if (currentSettings.groupInviteAllowlist !== void 0) {
			effectiveGroupInviteAllowlist = currentSettings.groupInviteAllowlist;
			runtime.log?.(`[tlon] Using groupInviteAllowlist from settings store: ${effectiveGroupInviteAllowlist.join(", ")}`);
		}
		if (currentSettings.ownerShip) {
			effectiveOwnerShip = normalizeShip(currentSettings.ownerShip);
			runtime.log?.(`[tlon] Using ownerShip from settings store: ${effectiveOwnerShip}`);
		}
		if (currentSettings.pendingApprovals?.length) {
			pendingApprovals = currentSettings.pendingApprovals;
			runtime.log?.(`[tlon] Loaded ${pendingApprovals.length} pending approval(s) from settings`);
		}
	} catch (err) {
		runtime.log?.(`[tlon] Settings store not available, using file config: ${String(err)}`);
	}
	if (effectiveAutoDiscoverChannels) try {
		const initData = await fetchInitData(api, runtime);
		if (initData.channels.length > 0) groupChannels = initData.channels;
		initForeigns = initData.foreigns;
	} catch (error) {
		runtime.error?.(`[tlon] Auto-discovery failed: ${error?.message ?? String(error)}`);
	}
	if (account.groupChannels.length > 0) {
		for (const ch of account.groupChannels) if (!groupChannels.includes(ch)) groupChannels.push(ch);
		runtime.log?.(`[tlon] Added ${account.groupChannels.length} manual groupChannels to monitoring`);
	}
	if (currentSettings.groupChannels?.length) {
		for (const ch of currentSettings.groupChannels) if (!groupChannels.includes(ch)) groupChannels.push(ch);
	}
	if (groupChannels.length > 0) runtime.log?.(`[tlon] Monitoring ${groupChannels.length} group channel(s): ${groupChannels.join(", ")}`);
	else runtime.log?.("[tlon] No group channels to monitor (DMs only)");
	async function resolveCiteContent(cite) {
		if (cite.type !== "chan" || !cite.nest || !cite.postId) return null;
		try {
			const scryPath = `/channels/v4/${cite.nest}/posts/post/${cite.postId}.json`;
			runtime.log?.(`[tlon] Fetching cited post: ${scryPath}`);
			const data = await api.scry(scryPath);
			if (data?.essay?.content) return extractMessageText(data.essay.content) || null;
			return null;
		} catch (err) {
			runtime.log?.(`[tlon] Failed to fetch cited post: ${String(err)}`);
			return null;
		}
	}
	async function resolveAllCites(content) {
		const cites = extractCites(content);
		if (cites.length === 0) return "";
		const resolved = [];
		for (const cite of cites) {
			const text = await resolveCiteContent(cite);
			if (text) {
				const author = cite.author || "unknown";
				resolved.push(`> ${author} wrote: ${text}`);
			}
		}
		return resolved.length > 0 ? resolved.join("\n") + "\n\n" : "";
	}
	async function savePendingApprovals() {
		try {
			await api.poke({
				app: "settings",
				mark: "settings-event",
				json: { "put-entry": {
					desk: "moltbot",
					"bucket-key": "tlon",
					"entry-key": "pendingApprovals",
					value: JSON.stringify(pendingApprovals)
				} }
			});
		} catch (err) {
			runtime.error?.(`[tlon] Failed to save pending approvals: ${String(err)}`);
		}
	}
	async function addToDmAllowlist(ship) {
		const normalizedShip = normalizeShip(ship);
		if (!effectiveDmAllowlist.includes(normalizedShip)) effectiveDmAllowlist = [...effectiveDmAllowlist, normalizedShip];
		try {
			await api.poke({
				app: "settings",
				mark: "settings-event",
				json: { "put-entry": {
					desk: "moltbot",
					"bucket-key": "tlon",
					"entry-key": "dmAllowlist",
					value: effectiveDmAllowlist
				} }
			});
			runtime.log?.(`[tlon] Added ${normalizedShip} to dmAllowlist`);
		} catch (err) {
			runtime.error?.(`[tlon] Failed to update dmAllowlist: ${String(err)}`);
		}
	}
	async function addToChannelAllowlist(ship, channelNest) {
		const normalizedShip = normalizeShip(ship);
		const channelRules = currentSettings.channelRules ?? {};
		const rule = channelRules[channelNest] ?? {
			mode: "restricted",
			allowedShips: []
		};
		const allowedShips = [...rule.allowedShips ?? []];
		if (!allowedShips.includes(normalizedShip)) allowedShips.push(normalizedShip);
		const updatedRules = {
			...channelRules,
			[channelNest]: {
				...rule,
				allowedShips
			}
		};
		currentSettings = {
			...currentSettings,
			channelRules: updatedRules
		};
		try {
			await api.poke({
				app: "settings",
				mark: "settings-event",
				json: { "put-entry": {
					desk: "moltbot",
					"bucket-key": "tlon",
					"entry-key": "channelRules",
					value: JSON.stringify(updatedRules)
				} }
			});
			runtime.log?.(`[tlon] Added ${normalizedShip} to ${channelNest} allowlist`);
		} catch (err) {
			runtime.error?.(`[tlon] Failed to update channelRules: ${String(err)}`);
		}
	}
	async function blockShip(ship) {
		const normalizedShip = normalizeShip(ship);
		try {
			await api.poke({
				app: "chat",
				mark: "chat-block-ship",
				json: { ship: normalizedShip }
			});
			runtime.log?.(`[tlon] Blocked ship ${normalizedShip}`);
		} catch (err) {
			runtime.error?.(`[tlon] Failed to block ship ${normalizedShip}: ${String(err)}`);
		}
	}
	async function isShipBlocked(ship) {
		const normalizedShip = normalizeShip(ship);
		try {
			const blocked = await api.scry("/chat/blocked.json");
			return Array.isArray(blocked) && blocked.some((s) => normalizeShip(s) === normalizedShip);
		} catch (err) {
			runtime.log?.(`[tlon] Failed to check blocked list: ${String(err)}`);
			return false;
		}
	}
	async function getBlockedShips() {
		try {
			const blocked = await api.scry("/chat/blocked.json");
			return Array.isArray(blocked) ? blocked : [];
		} catch (err) {
			runtime.log?.(`[tlon] Failed to get blocked list: ${String(err)}`);
			return [];
		}
	}
	async function unblockShip(ship) {
		const normalizedShip = normalizeShip(ship);
		try {
			await api.poke({
				app: "chat",
				mark: "chat-unblock-ship",
				json: { ship: normalizedShip }
			});
			runtime.log?.(`[tlon] Unblocked ship ${normalizedShip}`);
			return true;
		} catch (err) {
			runtime.error?.(`[tlon] Failed to unblock ship ${normalizedShip}: ${String(err)}`);
			return false;
		}
	}
	async function sendOwnerNotification(message) {
		if (!effectiveOwnerShip) {
			runtime.log?.("[tlon] No ownerShip configured, cannot send notification");
			return;
		}
		try {
			await sendDm({
				api,
				fromShip: botShipName,
				toShip: effectiveOwnerShip,
				text: message
			});
			runtime.log?.(`[tlon] Sent notification to owner ${effectiveOwnerShip}`);
		} catch (err) {
			runtime.error?.(`[tlon] Failed to send notification to owner: ${String(err)}`);
		}
	}
	async function queueApprovalRequest(approval) {
		if (await isShipBlocked(approval.requestingShip)) {
			runtime.log?.(`[tlon] Ignoring request from blocked ship ${approval.requestingShip}`);
			return;
		}
		const existingIndex = pendingApprovals.findIndex((a) => a.type === approval.type && a.requestingShip === approval.requestingShip && (approval.type !== "channel" || a.channelNest === approval.channelNest) && (approval.type !== "group" || a.groupFlag === approval.groupFlag));
		if (existingIndex !== -1) {
			const existing = pendingApprovals[existingIndex];
			if (approval.originalMessage) {
				existing.originalMessage = approval.originalMessage;
				existing.messagePreview = approval.messagePreview;
			}
			runtime.log?.(`[tlon] Updated existing approval for ${approval.requestingShip} (${approval.type}) - re-sending notification`);
			await savePendingApprovals();
			await sendOwnerNotification(formatApprovalRequest(existing));
			return;
		}
		pendingApprovals.push(approval);
		await savePendingApprovals();
		await sendOwnerNotification(formatApprovalRequest(approval));
		runtime.log?.(`[tlon] Queued approval request: ${approval.id} (${approval.type} from ${approval.requestingShip})`);
	}
	async function handleApprovalResponse(text) {
		const parsed = parseApprovalResponse(text);
		if (!parsed) return false;
		const approval = findPendingApproval(pendingApprovals, parsed.id);
		if (!approval) {
			await sendOwnerNotification("No pending approval found" + (parsed.id ? ` for ID: ${parsed.id}` : ""));
			return true;
		}
		if (parsed.action === "approve") {
			switch (approval.type) {
				case "dm":
					await addToDmAllowlist(approval.requestingShip);
					if (approval.originalMessage) {
						runtime.log?.(`[tlon] Processing original message from ${approval.requestingShip} after approval`);
						await processMessage({
							messageId: approval.originalMessage.messageId,
							senderShip: approval.requestingShip,
							messageText: approval.originalMessage.messageText,
							messageContent: approval.originalMessage.messageContent,
							isGroup: false,
							timestamp: approval.originalMessage.timestamp
						});
					}
					break;
				case "channel":
					if (approval.channelNest) {
						await addToChannelAllowlist(approval.requestingShip, approval.channelNest);
						if (approval.originalMessage) {
							const parsed = parseChannelNest(approval.channelNest);
							runtime.log?.(`[tlon] Processing original message from ${approval.requestingShip} in ${approval.channelNest} after approval`);
							await processMessage({
								messageId: approval.originalMessage.messageId,
								senderShip: approval.requestingShip,
								messageText: approval.originalMessage.messageText,
								messageContent: approval.originalMessage.messageContent,
								isGroup: true,
								channelNest: approval.channelNest,
								hostShip: parsed?.hostShip,
								channelName: parsed?.channelName,
								timestamp: approval.originalMessage.timestamp,
								parentId: approval.originalMessage.parentId,
								isThreadReply: approval.originalMessage.isThreadReply
							});
						}
					}
					break;
				case "group":
					if (approval.groupFlag) try {
						await api.poke({
							app: "groups",
							mark: "group-join",
							json: {
								flag: approval.groupFlag,
								"join-all": true
							}
						});
						runtime.log?.(`[tlon] Joined group ${approval.groupFlag} after approval`);
						setTimeout(async () => {
							try {
								const discoveredChannels = await fetchAllChannels(api, runtime);
								let newCount = 0;
								for (const channelNest of discoveredChannels) if (!watchedChannels.has(channelNest)) {
									watchedChannels.add(channelNest);
									newCount++;
								}
								if (newCount > 0) runtime.log?.(`[tlon] Discovered ${newCount} new channel(s) after joining group`);
							} catch (err) {
								runtime.log?.(`[tlon] Channel discovery after group join failed: ${String(err)}`);
							}
						}, 2e3);
					} catch (err) {
						runtime.error?.(`[tlon] Failed to join group ${approval.groupFlag}: ${String(err)}`);
					}
					break;
			}
			await sendOwnerNotification(formatApprovalConfirmation(approval, "approve"));
		} else if (parsed.action === "block") {
			await blockShip(approval.requestingShip);
			await sendOwnerNotification(formatApprovalConfirmation(approval, "block"));
		} else await sendOwnerNotification(formatApprovalConfirmation(approval, "deny"));
		pendingApprovals = removePendingApproval(pendingApprovals, approval.id);
		await savePendingApprovals();
		return true;
	}
	async function handleAdminCommand(text) {
		const command = parseAdminCommand(text);
		if (!command) return false;
		switch (command.type) {
			case "blocked": {
				const blockedShips = await getBlockedShips();
				await sendOwnerNotification(formatBlockedList(blockedShips));
				runtime.log?.(`[tlon] Owner requested blocked ships list (${blockedShips.length} ships)`);
				return true;
			}
			case "pending":
				await sendOwnerNotification(formatPendingList(pendingApprovals));
				runtime.log?.(`[tlon] Owner requested pending approvals list (${pendingApprovals.length} pending)`);
				return true;
			case "unblock": {
				const shipToUnblock = command.ship;
				if (!await isShipBlocked(shipToUnblock)) {
					await sendOwnerNotification(`${shipToUnblock} is not blocked.`);
					return true;
				}
				if (await unblockShip(shipToUnblock)) await sendOwnerNotification(`Unblocked ${shipToUnblock}.`);
				else await sendOwnerNotification(`Failed to unblock ${shipToUnblock}.`);
				return true;
			}
		}
	}
	function isOwner(ship) {
		if (!effectiveOwnerShip) return false;
		return normalizeShip(ship) === effectiveOwnerShip;
	}
	/**
	* Extract the DM partner ship from the 'whom' field.
	* This is the canonical source for DM routing (more reliable than essay.author).
	* Returns empty string if whom doesn't contain a valid patp-like value.
	*/
	function extractDmPartnerShip(whom) {
		const normalized = normalizeShip(typeof whom === "string" ? whom : whom && typeof whom === "object" && "ship" in whom && typeof whom.ship === "string" ? whom.ship : "");
		return /^~?[a-z-]+$/i.test(normalized) ? normalized : "";
	}
	const processMessage = async (params) => {
		const { messageId, senderShip, isGroup, channelNest, hostShip, channelName, timestamp, parentId, isThreadReply, messageContent } = params;
		const groupChannel = channelNest;
		let messageText = params.messageText;
		let attachments = [];
		if (messageContent) try {
			attachments = await downloadMessageImages(messageContent);
			if (attachments.length > 0) runtime.log?.(`[tlon] Downloaded ${attachments.length} image(s) from message`);
		} catch (error) {
			runtime.log?.(`[tlon] Failed to download images: ${error?.message ?? String(error)}`);
		}
		if (isThreadReply && parentId && groupChannel) try {
			const threadHistory = await fetchThreadHistory(api, groupChannel, parentId, 20, runtime);
			if (threadHistory.length > 0) {
				const threadContext = threadHistory.slice(-10).map((msg) => `${msg.author}: ${msg.content}`).join("\n");
				messageText = `${`[Thread conversation - ${threadHistory.length} previous replies. You are participating in this thread. Only respond if relevant or helpful - you don't need to reply to every message.]`}\n\n[Previous messages]\n${threadContext}\n\n[Current message]\n${messageText}`;
				runtime?.log?.(`[tlon] Added thread context (${threadHistory.length} replies) to message`);
			}
		} catch (error) {
			runtime?.log?.(`[tlon] Could not fetch thread context: ${error?.message ?? String(error)}`);
		}
		if (isGroup && groupChannel && isSummarizationRequest(messageText)) try {
			const history = await getChannelHistory(api, groupChannel, 50, runtime);
			if (history.length === 0) {
				const noHistoryMsg = "I couldn't fetch any messages for this channel. It might be empty or there might be a permissions issue.";
				if (isGroup) {
					const parsed = parseChannelNest(groupChannel);
					if (parsed) await sendGroupMessage({
						api,
						fromShip: botShipName,
						hostShip: parsed.hostShip,
						channelName: parsed.channelName,
						text: noHistoryMsg
					});
				} else await sendDm({
					api,
					fromShip: botShipName,
					toShip: senderShip,
					text: noHistoryMsg
				});
				return;
			}
			const historyText = history.map((msg) => `[${new Date(msg.timestamp).toLocaleString()}] ${msg.author}: ${msg.content}`).join("\n");
			messageText = `Please summarize this channel conversation (${history.length} recent messages):\n\n${historyText}\n\nProvide a concise summary highlighting:
1. Main topics discussed
2. Key decisions or conclusions
3. Action items if any
4. Notable participants`;
		} catch (error) {
			const errorMsg = `Sorry, I encountered an error while fetching the channel history: ${error?.message ?? String(error)}`;
			if (isGroup && groupChannel) {
				const parsed = parseChannelNest(groupChannel);
				if (parsed) await sendGroupMessage({
					api,
					fromShip: botShipName,
					hostShip: parsed.hostShip,
					channelName: parsed.channelName,
					text: errorMsg
				});
			} else await sendDm({
				api,
				fromShip: botShipName,
				toShip: senderShip,
				text: errorMsg
			});
			return;
		}
		const route = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "tlon",
			accountId: opts.accountId ?? void 0,
			peer: {
				kind: isGroup ? "group" : "direct",
				id: isGroup ? groupChannel ?? senderShip : senderShip
			}
		});
		if (!isGroup) {
			const sessionKey = route.sessionKey;
			if (!dmSendersBySession.has(sessionKey)) dmSendersBySession.set(sessionKey, /* @__PURE__ */ new Set());
			const senders = dmSendersBySession.get(sessionKey);
			if (senders.size > 0 && !senders.has(senderShip)) {
				runtime.log?.("[tlon] ⚠️ SECURITY: Multiple users sharing DM session. Configure \"session.dmScope: per-channel-peer\" in OpenClaw config.");
				if (!sharedSessionWarningSent && effectiveOwnerShip) {
					sharedSessionWarningSent = true;
					sendDm({
						api,
						fromShip: botShipName,
						toShip: effectiveOwnerShip,
						text: "⚠️ Security Warning: Multiple users are sharing a DM session with this bot. This can leak conversation context between users.\n\nFix: Add to your OpenClaw config:\nsession:\n  dmScope: \"per-channel-peer\"\n\nDocs: https://docs.openclaw.ai/concepts/session#secure-dm-mode"
					}).catch((err) => runtime.error?.(`[tlon] Failed to send security warning to owner: ${err}`));
				}
			}
			senders.add(senderShip);
		}
		const senderRole = isOwner(senderShip) ? "owner" : "user";
		const fromLabel = isGroup ? `${senderShip} [${senderRole}] in ${channelNest}` : `${senderShip} [${senderRole}]`;
		const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(messageText, cfg);
		let commandAuthorized = false;
		if (shouldComputeAuth) {
			const useAccessGroups = cfg.commands?.useAccessGroups !== false;
			const senderIsOwner = isOwner(senderShip);
			commandAuthorized = core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
				useAccessGroups,
				authorizers: [{
					configured: Boolean(effectiveOwnerShip),
					allowed: senderIsOwner
				}]
			});
			if (!commandAuthorized) console.log(`[tlon] Command attempt denied: ${senderShip} is not owner (owner=${effectiveOwnerShip ?? "not configured"})`);
		}
		let bodyWithAttachments = messageText;
		if (attachments.length > 0) bodyWithAttachments = attachments.map((a) => `[media attached: ${a.path} (${a.contentType}) | ${a.path}]`).join("\n") + "\n" + messageText;
		const body = core.channel.reply.formatAgentEnvelope({
			channel: "Tlon",
			from: fromLabel,
			timestamp,
			body: bodyWithAttachments
		});
		const commandBody = isGroup ? stripBotMention(messageText, botShipName) : messageText;
		const ctxPayload = core.channel.reply.finalizeInboundContext({
			Body: body,
			RawBody: messageText,
			CommandBody: commandBody,
			From: isGroup ? `tlon:group:${groupChannel}` : `tlon:${senderShip}`,
			To: `tlon:${botShipName}`,
			SessionKey: route.sessionKey,
			AccountId: route.accountId,
			ChatType: isGroup ? "group" : "direct",
			ConversationLabel: fromLabel,
			SenderName: senderShip,
			SenderId: senderShip,
			SenderRole: senderRole,
			CommandAuthorized: commandAuthorized,
			CommandSource: "text",
			Provider: "tlon",
			Surface: "tlon",
			MessageSid: messageId,
			...attachments.length > 0 && { Attachments: attachments },
			OriginatingChannel: "tlon",
			OriginatingTo: `tlon:${isGroup ? groupChannel : botShipName}`,
			...parentId && {
				ThreadId: String(parentId),
				ReplyToId: String(parentId)
			}
		});
		const dispatchStartTime = Date.now();
		const responsePrefix = core.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix;
		const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);
		await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
			ctx: ctxPayload,
			cfg,
			dispatcherOptions: {
				responsePrefix,
				humanDelay,
				deliver: async (payload) => {
					let replyText = payload.text;
					if (!replyText) return;
					if (effectiveShowModelSig) {
						const extPayload = payload;
						const extRoute = route;
						const defaultModel = cfg.agents?.defaults?.model;
						const modelInfo = extPayload.metadata?.model || extPayload.model || extRoute.model || (typeof defaultModel === "string" ? defaultModel : defaultModel?.primary);
						extPayload.metadata?.model || extPayload.model || extRoute.model || typeof defaultModel === "string" || defaultModel?.primary;
						replyText = `${replyText}\n\n_[Generated by ${formatModelName(modelInfo)}]_`;
					}
					if (isGroup && groupChannel) {
						const parsed = parseChannelNest(groupChannel);
						if (!parsed) return;
						await sendGroupMessage({
							api,
							fromShip: botShipName,
							hostShip: parsed.hostShip,
							channelName: parsed.channelName,
							text: replyText,
							replyToId: parentId ?? void 0
						});
						if (parentId) {
							participatedThreads.add(String(parentId));
							runtime.log?.(`[tlon] Now tracking thread for future replies: ${parentId}`);
						}
					} else await sendDm({
						api,
						fromShip: botShipName,
						toShip: senderShip,
						text: replyText
					});
				},
				onError: (err, info) => {
					const dispatchDuration = Date.now() - dispatchStartTime;
					runtime.error?.(`[tlon] ${info.kind} reply failed after ${dispatchDuration}ms: ${String(err)}`);
				}
			}
		});
	};
	const watchedChannels = new Set(groupChannels);
	const handleChannelsFirehose = async (event) => {
		try {
			const nest = event?.nest;
			if (!nest) return;
			if (!watchedChannels.has(nest)) return;
			const response = event?.response;
			if (!response) return;
			const essay = response?.post?.["r-post"]?.set?.essay;
			const memo = response?.post?.["r-post"]?.reply?.["r-reply"]?.set?.memo;
			if (!essay && !memo) return;
			const content = memo || essay;
			const isThreadReply = Boolean(memo);
			const messageId = isThreadReply ? response?.post?.["r-post"]?.reply?.id : response?.post?.id;
			if (!processedTracker.mark(messageId)) return;
			const senderShip = normalizeShip(content.author ?? "");
			if (!senderShip || senderShip === botShipName) return;
			const rawText = extractMessageText(content.content);
			if (!rawText.trim()) return;
			cacheMessage(nest, {
				author: senderShip,
				content: rawText,
				timestamp: content.sent || Date.now(),
				id: messageId
			});
			const seal = isThreadReply ? response?.post?.["r-post"]?.reply?.["r-reply"]?.set?.seal : response?.post?.["r-post"]?.set?.seal;
			const parentId = seal?.["parent-id"] || seal?.parent || null;
			const mentioned = isBotMentioned(rawText, botShipName, botNickname ?? void 0);
			const inParticipatedThread = isThreadReply && parentId && participatedThreads.has(String(parentId));
			if (!mentioned && !inParticipatedThread) return;
			if (inParticipatedThread && !mentioned) runtime.log?.(`[tlon] Responding to thread we participated in (no mention): ${parentId}`);
			if (isOwner(senderShip)) runtime.log?.(`[tlon] Owner ${senderShip} is always allowed in channels`);
			else {
				const { mode, allowedShips } = resolveChannelAuthorization(cfg, nest, currentSettings);
				if (mode === "restricted") {
					if (!allowedShips.map(normalizeShip).includes(senderShip)) {
						if (effectiveOwnerShip) await queueApprovalRequest(createPendingApproval({
							type: "channel",
							requestingShip: senderShip,
							channelNest: nest,
							messagePreview: rawText.substring(0, 100),
							originalMessage: {
								messageId: messageId ?? "",
								messageText: rawText,
								messageContent: content.content,
								timestamp: content.sent || Date.now(),
								parentId: parentId ?? void 0,
								isThreadReply
							}
						}));
						else runtime.log?.(`[tlon] Access denied: ${senderShip} in ${nest} (allowed: ${allowedShips.join(", ")})`);
						return;
					}
				}
			}
			const messageText = await resolveAllCites(content.content) + rawText;
			const parsed = parseChannelNest(nest);
			await processMessage({
				messageId: messageId ?? "",
				senderShip,
				messageText,
				messageContent: content.content,
				isGroup: true,
				channelNest: nest,
				hostShip: parsed?.hostShip,
				channelName: parsed?.channelName,
				timestamp: content.sent || Date.now(),
				parentId,
				isThreadReply
			});
		} catch (error) {
			runtime.error?.(`[tlon] Error handling channel firehose event: ${error?.message ?? String(error)}`);
		}
	};
	const processedDmInvites = /* @__PURE__ */ new Set();
	const handleChatFirehose = async (event) => {
		try {
			if (Array.isArray(event)) {
				for (const invite of event) {
					const ship = normalizeShip(invite.ship || "");
					if (!ship || processedDmInvites.has(ship)) continue;
					if (isOwner(ship)) {
						try {
							await api.poke({
								app: "chat",
								mark: "chat-dm-rsvp",
								json: {
									ship,
									ok: true
								}
							});
							processedDmInvites.add(ship);
							runtime.log?.(`[tlon] Auto-accepted DM invite from owner ${ship}`);
						} catch (err) {
							runtime.error?.(`[tlon] Failed to auto-accept DM from owner: ${String(err)}`);
						}
						continue;
					}
					if (effectiveAutoAcceptDmInvites && isDmAllowed(ship, effectiveDmAllowlist)) {
						try {
							await api.poke({
								app: "chat",
								mark: "chat-dm-rsvp",
								json: {
									ship,
									ok: true
								}
							});
							processedDmInvites.add(ship);
							runtime.log?.(`[tlon] Auto-accepted DM invite from ${ship}`);
						} catch (err) {
							runtime.error?.(`[tlon] Failed to auto-accept DM from ${ship}: ${String(err)}`);
						}
						continue;
					}
					if (effectiveOwnerShip && !isDmAllowed(ship, effectiveDmAllowlist)) {
						await queueApprovalRequest(createPendingApproval({
							type: "dm",
							requestingShip: ship,
							messagePreview: "(DM invite - no message yet)"
						}));
						processedDmInvites.add(ship);
					}
				}
				return;
			}
			if (!("whom" in event) || !("response" in event)) return;
			const whom = event.whom;
			const messageId = event.id;
			const essay = event.response?.add?.essay;
			if (!essay) return;
			if (!processedTracker.mark(messageId)) return;
			const authorShip = normalizeShip(essay.author ?? "");
			const partnerShip = extractDmPartnerShip(whom);
			const senderShip = partnerShip || authorShip;
			if (authorShip === botShipName) return;
			if (!senderShip || senderShip === botShipName) return;
			if (authorShip && partnerShip && authorShip !== partnerShip) runtime.log?.(`[tlon] DM ship mismatch (author=${authorShip}, partner=${partnerShip}) - routing to partner`);
			const rawText = extractMessageText(essay.content);
			if (!rawText.trim()) return;
			const resolvedMessageText = await resolveAllCites(essay.content) + rawText;
			const messageText = rawText;
			if (isOwner(senderShip) && isApprovalResponse(messageText)) {
				if (await handleApprovalResponse(messageText)) {
					runtime.log?.(`[tlon] Processed approval response from owner: ${messageText}`);
					return;
				}
			}
			if (isOwner(senderShip) && isAdminCommand(messageText)) {
				if (await handleAdminCommand(messageText)) {
					runtime.log?.(`[tlon] Processed admin command from owner: ${messageText}`);
					return;
				}
			}
			if (isOwner(senderShip)) {
				runtime.log?.(`[tlon] Processing DM from owner ${senderShip}`);
				await processMessage({
					messageId: messageId ?? "",
					senderShip,
					messageText: resolvedMessageText,
					messageContent: essay.content,
					isGroup: false,
					timestamp: essay.sent || Date.now()
				});
				return;
			}
			if (!isDmAllowed(senderShip, effectiveDmAllowlist)) {
				if (effectiveOwnerShip) await queueApprovalRequest(createPendingApproval({
					type: "dm",
					requestingShip: senderShip,
					messagePreview: messageText.substring(0, 100),
					originalMessage: {
						messageId: messageId ?? "",
						messageText,
						messageContent: essay.content,
						timestamp: essay.sent || Date.now()
					}
				}));
				else runtime.log?.(`[tlon] Blocked DM from ${senderShip}: not in allowlist`);
				return;
			}
			await processMessage({
				messageId: messageId ?? "",
				senderShip,
				messageText: resolvedMessageText,
				messageContent: essay.content,
				isGroup: false,
				timestamp: essay.sent || Date.now()
			});
		} catch (error) {
			runtime.error?.(`[tlon] Error handling chat firehose event: ${error?.message ?? String(error)}`);
		}
	};
	try {
		runtime.log?.("[tlon] Subscribing to firehose updates...");
		await api.subscribe({
			app: "channels",
			path: "/v2",
			event: handleChannelsFirehose,
			err: (error) => {
				runtime.error?.(`[tlon] Channels firehose error: ${String(error)}`);
			},
			quit: () => {
				runtime.log?.("[tlon] Channels firehose subscription ended");
			}
		});
		runtime.log?.("[tlon] Subscribed to channels firehose (/v2)");
		await api.subscribe({
			app: "chat",
			path: "/v3",
			event: handleChatFirehose,
			err: (error) => {
				runtime.error?.(`[tlon] Chat firehose error: ${String(error)}`);
			},
			quit: () => {
				runtime.log?.("[tlon] Chat firehose subscription ended");
			}
		});
		runtime.log?.("[tlon] Subscribed to chat firehose (/v3)");
		await api.subscribe({
			app: "contacts",
			path: "/v1/news",
			event: (event) => {
				try {
					if (event?.self) {
						const selfUpdate = event.self;
						if (selfUpdate?.contact?.nickname?.value !== void 0) {
							const newNickname = selfUpdate.contact.nickname.value || null;
							if (newNickname !== botNickname) {
								botNickname = newNickname;
								runtime.log?.(`[tlon] Nickname updated: ${botNickname}`);
							}
						}
					}
				} catch (error) {
					runtime.error?.(`[tlon] Error handling contacts event: ${error?.message ?? String(error)}`);
				}
			},
			err: (error) => {
				runtime.error?.(`[tlon] Contacts subscription error: ${String(error)}`);
			},
			quit: () => {
				runtime.log?.("[tlon] Contacts subscription ended");
			}
		});
		runtime.log?.("[tlon] Subscribed to contacts updates (/v1/news)");
		settingsManager.onChange((newSettings) => {
			currentSettings = newSettings;
			if (newSettings.groupChannels?.length) {
				const newChannels = newSettings.groupChannels;
				for (const ch of newChannels) if (!watchedChannels.has(ch)) {
					watchedChannels.add(ch);
					runtime.log?.(`[tlon] Settings: now watching channel ${ch}`);
				}
			}
			if (newSettings.dmAllowlist !== void 0) {
				effectiveDmAllowlist = newSettings.dmAllowlist;
				runtime.log?.(`[tlon] Settings: dmAllowlist updated to ${effectiveDmAllowlist.join(", ")}`);
			}
			if (newSettings.showModelSig !== void 0) {
				effectiveShowModelSig = newSettings.showModelSig;
				runtime.log?.(`[tlon] Settings: showModelSig = ${effectiveShowModelSig}`);
			}
			if (newSettings.autoAcceptDmInvites !== void 0) {
				effectiveAutoAcceptDmInvites = newSettings.autoAcceptDmInvites;
				runtime.log?.(`[tlon] Settings: autoAcceptDmInvites = ${effectiveAutoAcceptDmInvites}`);
			}
			if (newSettings.autoAcceptGroupInvites !== void 0) {
				effectiveAutoAcceptGroupInvites = newSettings.autoAcceptGroupInvites;
				runtime.log?.(`[tlon] Settings: autoAcceptGroupInvites = ${effectiveAutoAcceptGroupInvites}`);
			}
			if (newSettings.groupInviteAllowlist !== void 0) {
				effectiveGroupInviteAllowlist = newSettings.groupInviteAllowlist;
				runtime.log?.(`[tlon] Settings: groupInviteAllowlist updated to ${effectiveGroupInviteAllowlist.join(", ")}`);
			}
			if (newSettings.defaultAuthorizedShips !== void 0) runtime.log?.(`[tlon] Settings: defaultAuthorizedShips updated to ${(newSettings.defaultAuthorizedShips || []).join(", ")}`);
			if (newSettings.autoDiscoverChannels !== void 0) {
				effectiveAutoDiscoverChannels = newSettings.autoDiscoverChannels;
				runtime.log?.(`[tlon] Settings: autoDiscoverChannels = ${effectiveAutoDiscoverChannels}`);
			}
			if (newSettings.ownerShip !== void 0) {
				effectiveOwnerShip = newSettings.ownerShip ? normalizeShip(newSettings.ownerShip) : account.ownerShip ? normalizeShip(account.ownerShip) : null;
				runtime.log?.(`[tlon] Settings: ownerShip = ${effectiveOwnerShip}`);
			}
			if (newSettings.pendingApprovals !== void 0) {
				pendingApprovals = newSettings.pendingApprovals;
				runtime.log?.(`[tlon] Settings: pendingApprovals updated (${pendingApprovals.length} items)`);
			}
		});
		try {
			await settingsManager.startSubscription();
		} catch (err) {
			runtime.log?.(`[tlon] Settings subscription not available: ${String(err)}`);
		}
		try {
			await api.subscribe({
				app: "groups",
				path: "/groups/ui",
				event: async (event) => {
					try {
						if (event && typeof event === "object") {
							if (event.channels && typeof event.channels === "object") {
								const channels = event.channels;
								for (const [channelNest, _channelData] of Object.entries(channels)) {
									if (!channelNest.startsWith("chat/")) continue;
									if (!watchedChannels.has(channelNest)) {
										watchedChannels.add(channelNest);
										runtime.log?.(`[tlon] Auto-detected new channel (invite accepted): ${channelNest}`);
										if (effectiveAutoAcceptGroupInvites) try {
											const currentChannels = currentSettings.groupChannels || [];
											if (!currentChannels.includes(channelNest)) {
												const updatedChannels = [...currentChannels, channelNest];
												await api.poke({
													app: "settings",
													mark: "settings-event",
													json: { "put-entry": {
														"bucket-key": "tlon",
														"entry-key": "groupChannels",
														value: updatedChannels,
														desk: "moltbot"
													} }
												});
												runtime.log?.(`[tlon] Persisted ${channelNest} to settings store`);
											}
										} catch (err) {
											runtime.error?.(`[tlon] Failed to persist channel to settings: ${String(err)}`);
										}
									}
								}
							}
							if (event.join && typeof event.join === "object") {
								const join = event.join;
								if (join.channels) for (const channelNest of join.channels) {
									if (!channelNest.startsWith("chat/")) continue;
									if (!watchedChannels.has(channelNest)) {
										watchedChannels.add(channelNest);
										runtime.log?.(`[tlon] Auto-detected joined channel: ${channelNest}`);
										if (effectiveAutoAcceptGroupInvites) try {
											const currentChannels = currentSettings.groupChannels || [];
											if (!currentChannels.includes(channelNest)) {
												const updatedChannels = [...currentChannels, channelNest];
												await api.poke({
													app: "settings",
													mark: "settings-event",
													json: { "put-entry": {
														"bucket-key": "tlon",
														"entry-key": "groupChannels",
														value: updatedChannels,
														desk: "moltbot"
													} }
												});
												runtime.log?.(`[tlon] Persisted ${channelNest} to settings store`);
											}
										} catch (err) {
											runtime.error?.(`[tlon] Failed to persist channel to settings: ${String(err)}`);
										}
									}
								}
							}
						}
					} catch (error) {
						runtime.error?.(`[tlon] Error handling groups-ui event: ${error?.message ?? String(error)}`);
					}
				},
				err: (error) => {
					runtime.error?.(`[tlon] Groups-ui subscription error: ${String(error)}`);
				},
				quit: () => {
					runtime.log?.("[tlon] Groups-ui subscription ended");
				}
			});
			runtime.log?.("[tlon] Subscribed to groups-ui for real-time channel detection");
		} catch (err) {
			runtime.log?.(`[tlon] Groups-ui subscription failed (will rely on polling): ${String(err)}`);
		}
		{
			const processedGroupInvites = /* @__PURE__ */ new Set();
			const processPendingInvites = async (foreigns) => {
				if (!foreigns || typeof foreigns !== "object") return;
				for (const [groupFlag, foreign] of Object.entries(foreigns)) {
					if (processedGroupInvites.has(groupFlag)) continue;
					if (!foreign.invites || foreign.invites.length === 0) continue;
					const validInvite = foreign.invites.find((inv) => inv.valid);
					if (!validInvite) continue;
					const inviterShip = validInvite.from;
					const normalizedInviter = normalizeShip(inviterShip);
					if (isOwner(inviterShip)) {
						try {
							await api.poke({
								app: "groups",
								mark: "group-join",
								json: {
									flag: groupFlag,
									"join-all": true
								}
							});
							processedGroupInvites.add(groupFlag);
							runtime.log?.(`[tlon] Auto-accepted group invite from owner: ${groupFlag}`);
						} catch (err) {
							runtime.error?.(`[tlon] Failed to accept group invite from owner: ${String(err)}`);
						}
						continue;
					}
					if (!effectiveAutoAcceptGroupInvites) {
						if (effectiveOwnerShip) {
							await queueApprovalRequest(createPendingApproval({
								type: "group",
								requestingShip: inviterShip,
								groupFlag
							}));
							processedGroupInvites.add(groupFlag);
						}
						continue;
					}
					if (!(effectiveGroupInviteAllowlist.length > 0 ? effectiveGroupInviteAllowlist.map((s) => normalizeShip(s)).some((s) => s === normalizedInviter) : false)) {
						if (effectiveOwnerShip) {
							await queueApprovalRequest(createPendingApproval({
								type: "group",
								requestingShip: inviterShip,
								groupFlag
							}));
							processedGroupInvites.add(groupFlag);
						} else {
							runtime.log?.(`[tlon] Rejected group invite from ${inviterShip} (not in groupInviteAllowlist): ${groupFlag}`);
							processedGroupInvites.add(groupFlag);
						}
						continue;
					}
					try {
						await api.poke({
							app: "groups",
							mark: "group-join",
							json: {
								flag: groupFlag,
								"join-all": true
							}
						});
						processedGroupInvites.add(groupFlag);
						runtime.log?.(`[tlon] Auto-accepted group invite: ${groupFlag} (from ${validInvite.from})`);
					} catch (err) {
						runtime.error?.(`[tlon] Failed to auto-accept group ${groupFlag}: ${String(err)}`);
					}
				}
			};
			if (initForeigns) await processPendingInvites(initForeigns);
			try {
				await api.subscribe({
					app: "groups",
					path: "/v1/foreigns",
					event: (data) => {
						(async () => {
							try {
								await processPendingInvites(data);
							} catch (error) {
								runtime.error?.(`[tlon] Error handling foreigns event: ${error?.message ?? String(error)}`);
							}
						})();
					},
					err: (error) => {
						runtime.error?.(`[tlon] Foreigns subscription error: ${String(error)}`);
					},
					quit: () => {
						runtime.log?.("[tlon] Foreigns subscription ended");
					}
				});
				runtime.log?.("[tlon] Subscribed to foreigns (/v1/foreigns) for auto-accepting group invites");
			} catch (err) {
				runtime.log?.(`[tlon] Foreigns subscription failed: ${String(err)}`);
			}
		}
		if (effectiveAutoDiscoverChannels) {
			const discoveredChannels = await fetchAllChannels(api, runtime);
			for (const channelNest of discoveredChannels) watchedChannels.add(channelNest);
			runtime.log?.(`[tlon] Watching ${watchedChannels.size} channel(s)`);
		}
		for (const channelNest of watchedChannels) runtime.log?.(`[tlon] Watching channel: ${channelNest}`);
		runtime.log?.("[tlon] All subscriptions registered, connecting to SSE stream...");
		await api.connect();
		runtime.log?.("[tlon] Connected! Firehose subscriptions active");
		const pollInterval = setInterval(async () => {
			if (!opts.abortSignal?.aborted) try {
				if (effectiveAutoDiscoverChannels) {
					const discoveredChannels = await fetchAllChannels(api, runtime);
					for (const channelNest of discoveredChannels) if (!watchedChannels.has(channelNest)) {
						watchedChannels.add(channelNest);
						runtime.log?.(`[tlon] Now watching new channel: ${channelNest}`);
					}
				}
			} catch (error) {
				runtime.error?.(`[tlon] Channel refresh error: ${error?.message ?? String(error)}`);
			}
		}, 120 * 1e3);
		if (opts.abortSignal) {
			const signal = opts.abortSignal;
			await new Promise((resolve) => {
				signal.addEventListener("abort", () => {
					clearInterval(pollInterval);
					resolve(null);
				}, { once: true });
			});
		} else await new Promise(() => {});
	} finally {
		try {
			await api?.close();
		} catch (error) {
			runtime.error?.(`[tlon] Cleanup error: ${error?.message ?? String(error)}`);
		}
	}
}
//#endregion
//#region extensions/tlon/src/urbit/upload.ts
/**
* Upload an image from a URL to Tlon storage.
*/
/**
* Fetch an image from a URL and upload it to Tlon storage.
* Returns the uploaded URL, or falls back to the original URL on error.
*
* Note: configureClient must be called before using this function.
*/
async function uploadImageFromUrl(imageUrl) {
	try {
		const url = new URL(imageUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			console.warn(`[tlon] Rejected non-http(s) URL: ${imageUrl}`);
			return imageUrl;
		}
		const { response, release } = await fetchWithSsrFGuard({
			url: imageUrl,
			init: { method: "GET" },
			policy: /* @__PURE__ */ getDefaultSsrFPolicy(),
			auditContext: "tlon-upload-image"
		});
		try {
			if (!response.ok) {
				console.warn(`[tlon] Failed to fetch image from ${imageUrl}: ${response.status}`);
				return imageUrl;
			}
			const contentType = response.headers.get("content-type") || "image/png";
			return (await dM({
				blob: await response.blob(),
				fileName: new URL(imageUrl).pathname.split("/").pop() || `upload-${Date.now()}.png`,
				contentType
			})).url;
		} finally {
			await release();
		}
	} catch (err) {
		console.warn(`[tlon] Failed to upload image, using original URL: ${err}`);
		return imageUrl;
	}
}
//#endregion
//#region extensions/tlon/src/channel.ts
async function createHttpPokeApi(params) {
	const ssrfPolicy = ssrfPolicyFromAllowPrivateNetwork(params.allowPrivateNetwork);
	const cookie = await authenticate(params.url, params.code, { ssrfPolicy });
	const channelPath = `/~/channel/${`${Math.floor(Date.now() / 1e3)}-${crypto$1.randomUUID()}`}`;
	const shipName = params.ship.replace(/^~/, "");
	return {
		poke: async (pokeParams) => {
			const pokeId = Date.now();
			const pokeData = {
				id: pokeId,
				action: "poke",
				ship: shipName,
				app: pokeParams.app,
				mark: pokeParams.mark,
				json: pokeParams.json
			};
			const { response, release } = await urbitFetch({
				baseUrl: params.url,
				path: channelPath,
				init: {
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						Cookie: cookie.split(";")[0]
					},
					body: JSON.stringify([pokeData])
				},
				ssrfPolicy,
				auditContext: "tlon-poke"
			});
			try {
				if (!response.ok && response.status !== 204) {
					const errorText = await response.text();
					throw new Error(`Poke failed: ${response.status} - ${errorText}`);
				}
				return pokeId;
			} finally {
				await release();
			}
		},
		delete: async () => {}
	};
}
const TLON_CHANNEL_ID = "tlon";
function resolveOutboundContext(params) {
	const account = resolveTlonAccount(params.cfg, params.accountId ?? void 0);
	if (!account.configured || !account.ship || !account.url || !account.code) throw new Error("Tlon account not configured");
	const parsed = parseTlonTarget(params.to);
	if (!parsed) throw new Error(`Invalid Tlon target. Use ${formatTargetHint()}`);
	return {
		account,
		parsed
	};
}
function resolveReplyId(replyToId, threadId) {
	return replyToId ?? threadId ? String(replyToId ?? threadId) : void 0;
}
async function withHttpPokeAccountApi(account, run) {
	const api = await createHttpPokeApi({
		url: account.url,
		ship: account.ship,
		code: account.code,
		allowPrivateNetwork: account.allowPrivateNetwork ?? void 0
	});
	try {
		return await run(api);
	} finally {
		try {
			await api.delete();
		} catch {}
	}
}
const tlonPlugin = {
	id: TLON_CHANNEL_ID,
	meta: {
		id: TLON_CHANNEL_ID,
		label: "Tlon",
		selectionLabel: "Tlon (Urbit)",
		docsPath: "/channels/tlon",
		docsLabel: "tlon",
		blurb: "Decentralized messaging on Urbit",
		aliases: ["urbit"],
		order: 90
	},
	capabilities: {
		chatTypes: [
			"direct",
			"group",
			"thread"
		],
		media: true,
		reply: true,
		threads: true
	},
	setup: tlonSetupAdapter,
	setupWizard: tlonSetupWizard,
	reload: { configPrefixes: ["channels.tlon"] },
	configSchema: tlonChannelConfigSchema,
	config: {
		listAccountIds: (cfg) => listTlonAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveTlonAccount(cfg, accountId ?? void 0),
		defaultAccountId: () => "default",
		setAccountEnabled: ({ cfg, accountId, enabled }) => {
			if (!accountId || accountId === "default") return {
				...cfg,
				channels: {
					...cfg.channels,
					tlon: {
						...cfg.channels?.tlon,
						enabled
					}
				}
			};
			return {
				...cfg,
				channels: {
					...cfg.channels,
					tlon: {
						...cfg.channels?.tlon,
						accounts: {
							...cfg.channels?.tlon?.accounts,
							[accountId]: {
								...cfg.channels?.tlon?.accounts?.[accountId],
								enabled
							}
						}
					}
				}
			};
		},
		deleteAccount: ({ cfg, accountId }) => {
			if (!accountId || accountId === "default") {
				const { ship: _ship, code: _code, url: _url, name: _name, ...rest } = cfg.channels?.tlon ?? {};
				return {
					...cfg,
					channels: {
						...cfg.channels,
						tlon: rest
					}
				};
			}
			const { [accountId]: _removed, ...remainingAccounts } = cfg.channels?.tlon?.accounts ?? {};
			return {
				...cfg,
				channels: {
					...cfg.channels,
					tlon: {
						...cfg.channels?.tlon,
						accounts: remainingAccounts
					}
				}
			};
		},
		isConfigured: (account) => account.configured,
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: account.configured,
			ship: account.ship,
			url: account.url
		})
	},
	messaging: {
		normalizeTarget: (target) => {
			const parsed = parseTlonTarget(target);
			if (!parsed) return target.trim();
			if (parsed.kind === "dm") return parsed.ship;
			return parsed.nest;
		},
		targetResolver: {
			looksLikeId: (target) => Boolean(parseTlonTarget(target)),
			hint: formatTargetHint()
		}
	},
	outbound: {
		deliveryMode: "direct",
		textChunkLimit: 1e4,
		resolveTarget: ({ to }) => {
			const parsed = parseTlonTarget(to ?? "");
			if (!parsed) return {
				ok: false,
				error: /* @__PURE__ */ new Error(`Invalid Tlon target. Use ${formatTargetHint()}`)
			};
			if (parsed.kind === "dm") return {
				ok: true,
				to: parsed.ship
			};
			return {
				ok: true,
				to: parsed.nest
			};
		},
		sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
			const { account, parsed } = resolveOutboundContext({
				cfg,
				accountId,
				to
			});
			return withHttpPokeAccountApi(account, async (api) => {
				const fromShip = normalizeShip(account.ship);
				if (parsed.kind === "dm") return await sendDm({
					api,
					fromShip,
					toShip: parsed.ship,
					text
				});
				return await sendGroupMessage({
					api,
					fromShip,
					hostShip: parsed.hostShip,
					channelName: parsed.channelName,
					text,
					replyToId: resolveReplyId(replyToId, threadId)
				});
			});
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId }) => {
			const { account, parsed } = resolveOutboundContext({
				cfg,
				accountId,
				to
			});
			AO({
				shipUrl: account.url,
				shipName: account.ship.replace(/^~/, ""),
				verbose: false,
				getCode: async () => account.code
			});
			const uploadedUrl = mediaUrl ? await uploadImageFromUrl(mediaUrl) : void 0;
			return withHttpPokeAccountApi(account, async (api) => {
				const fromShip = normalizeShip(account.ship);
				const story = buildMediaStory(text, uploadedUrl);
				if (parsed.kind === "dm") return await sendDmWithStory({
					api,
					fromShip,
					toShip: parsed.ship,
					story
				});
				return await sendGroupMessageWithStory({
					api,
					fromShip,
					hostShip: parsed.hostShip,
					channelName: parsed.channelName,
					story,
					replyToId: resolveReplyId(replyToId, threadId)
				});
			});
		}
	},
	status: {
		defaultRuntime: {
			accountId: "default",
			running: false,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null
		},
		collectStatusIssues: (accounts) => {
			return accounts.flatMap((account) => {
				if (!account.configured) return [{
					channel: TLON_CHANNEL_ID,
					accountId: account.accountId,
					kind: "config",
					message: "Account not configured (missing ship, code, or url)"
				}];
				return [];
			});
		},
		buildChannelSummary: ({ snapshot }) => {
			const s = snapshot;
			return {
				configured: s.configured ?? false,
				ship: s.ship ?? null,
				url: s.url ?? null
			};
		},
		probeAccount: async ({ account }) => {
			if (!account.configured || !account.ship || !account.url || !account.code) return {
				ok: false,
				error: "Not configured"
			};
			try {
				const ssrfPolicy = ssrfPolicyFromAllowPrivateNetwork(account.allowPrivateNetwork);
				const cookie = await authenticate(account.url, account.code, { ssrfPolicy });
				const { response, release } = await urbitFetch({
					baseUrl: account.url,
					path: "/~/name",
					init: {
						method: "GET",
						headers: { Cookie: cookie }
					},
					ssrfPolicy,
					timeoutMs: 3e4,
					auditContext: "tlon-probe-account"
				});
				try {
					if (!response.ok) return {
						ok: false,
						error: `Name request failed: ${response.status}`
					};
					return { ok: true };
				} finally {
					await release();
				}
			} catch (error) {
				return {
					ok: false,
					error: error?.message ?? String(error)
				};
			}
		},
		buildAccountSnapshot: ({ account, runtime, probe }) => {
			return {
				accountId: account.accountId,
				name: account.name,
				enabled: account.enabled,
				configured: account.configured,
				ship: account.ship,
				url: account.url,
				running: runtime?.running ?? false,
				lastStartAt: runtime?.lastStartAt ?? null,
				lastStopAt: runtime?.lastStopAt ?? null,
				lastError: runtime?.lastError ?? null,
				probe
			};
		}
	},
	gateway: { startAccount: async (ctx) => {
		const account = ctx.account;
		ctx.setStatus({
			accountId: account.accountId,
			ship: account.ship,
			url: account.url
		});
		ctx.log?.info(`[${account.accountId}] starting Tlon provider for ${account.ship ?? "tlon"}`);
		return monitorTlonProvider({
			runtime: ctx.runtime,
			abortSignal: ctx.abortSignal,
			accountId: account.accountId
		});
	} }
};
//#endregion
export { setTlonRuntime as n, tlonPlugin as t };
