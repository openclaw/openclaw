import { a as __toCommonJS, i as __require, n as __esmMin, o as __toESM, r as __exportAll, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage$1 } from "./errors-b3ZrCRlt.js";
import { t as createDedupeCache } from "./dedupe-BD30U36x.js";
import { m as MAX_IMAGE_BYTES, r as extensionForMime } from "./mime-DppuT-pZ.js";
import { o as resolveStableChannelMessageIngress } from "./runtime-BUVuto5K.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { a as saveRemoteMedia, i as readRemoteMediaBuffer } from "./fetch-C0wRQZuz.js";
import { t as createMessageReceiptFromOutboundResults } from "./receipt-vrVTwZtS.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as createLoggerBackedRuntime } from "./runtime-logger-CdfMCDWX.js";
import { u as ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./media-runtime-BheBFFxc.js";
import "./media-mime-j2Nhr7Df.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import "./channel-message-DMGbyII_.js";
import "./runtime-api-BbBDzUQK.js";
import { c as validateUrbitBaseUrl, d as formatTargetHint, f as normalizeShip, h as resolveTlonOutboundTarget, m as parseTlonTarget, p as parseChannelNest, s as normalizeUrbitHostname, u as resolveTlonAccount } from "./setup-core-DbWuyR2f.js";
import { t as getTlonRuntime } from "./runtime-B0ffOFfb.js";
import { t as tlonSetupWizard } from "./setup-surface-DUYXn7vE.js";
import { c as tslib_es6_exports, s as init_tslib_es6 } from "./tslib.es6-DJxJwErw.js";
import { H as init_retry, U as retry_exports, n as init_client, t as client_exports, v as dist_es_exports, y as init_dist_es } from "./client-Du4bZd9P.js";
import { A as protocols_exports, Mn as fromUtf8, N as buildQueryString, Rt as config_exports, S as schema_exports, cn as toUint8Array, dt as init_serde, ft as serde_exports, gt as endpoints_exports, k as init_protocols, n as init_client$1, t as client_exports$1, vt as init_endpoints, x as init_schema, zt as init_config } from "./client-hKay7jF9.js";
import { F as require_main$2, I as require_main$1, n as init_event_streams, t as event_streams_exports } from "./event-streams-j-n_zxDn.js";
import { g as protocols_exports$1, h as init_protocols$1, n as init_httpAuthSchemes, t as httpAuthSchemes_exports } from "./httpAuthSchemes-0G32ph_d.js";
import { t as require_dist_cjs$10 } from "./dist-cjs-BHFQz28I.js";
import { t as require_dist_cjs$11 } from "./dist-cjs-D7QErCJt.js";
import { t as require_dist_cjs$12 } from "./dist-cjs-CVaUaZ1m.js";
import { createReadStream } from "node:fs";
import * as path$1 from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import crypto, { randomBytes, randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
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
			key: typeof put["entry-key"] === "string" ? put["entry-key"] : "",
			value: put.value
		};
	}
	if (evt["del-entry"]) {
		const del = evt["del-entry"];
		if (del.desk !== SETTINGS_DESK || del["bucket-key"] !== SETTINGS_BUCKET) return null;
		return {
			key: typeof del["entry-key"] === "string" ? del["entry-key"] : "",
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
		/**
		* Get current settings (may be empty if not loaded yet).
		*/
		get current() {
			return state.current;
		},
		/**
		* Whether initial settings have been loaded.
		*/
		get loaded() {
			return state.loaded;
		},
		/**
		* Load initial settings via scry.
		*/
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
		/**
		* Subscribe to settings changes.
		*/
		async startSubscription() {
			await api.subscribe({
				app: "settings",
				path: "/desk/moltbot",
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
		/**
		* Register a listener for settings changes.
		*/
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
	const trimmed = normalizeUrbitHostname(hostname);
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
//#endregion
//#region node_modules/@urbit/aura/dist/aura.cjs.production.min.js
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
								t = n / l, (n %= l) < 36525n ? r = !0 : (r = !1, e = 1n, e += (n -= 36525n) / d, n %= d);
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
//#region extensions/tlon/src/urbit/story.ts
var import_dist = (/* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_aura_cjs_production_min();
})))();
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
		const img = inline["__image"];
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
function createTlonSendReceipt(params) {
	return createMessageReceiptFromOutboundResults({
		results: [{
			channel: "tlon",
			messageId: params.messageId,
			conversationId: params.conversationId
		}],
		threadId: params.conversationId,
		kind: params.kind
	});
}
async function sendDm({ api, fromShip, toShip, text }) {
	return sendDmWithStory({
		api,
		fromShip,
		toShip,
		story: markdownToStory(text),
		kind: "text"
	});
}
async function sendDmWithStory({ api, fromShip, toShip, story, kind = "unknown" }) {
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
		messageId: id,
		receipt: createTlonSendReceipt({
			messageId: id,
			conversationId: toShip,
			kind
		})
	};
}
async function sendGroupMessage({ api, fromShip, hostShip, channelName, text, replyToId }) {
	return sendGroupMessageWithStory({
		api,
		fromShip,
		hostShip,
		channelName,
		story: markdownToStory(text),
		replyToId,
		kind: "text"
	});
}
async function sendGroupMessageWithStory({ api, fromShip, hostShip, channelName, story, replyToId, kind = "unknown" }) {
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
	const messageId = `${fromShip}/${sentAt}`;
	return {
		channel: "tlon",
		messageId,
		receipt: createTlonSendReceipt({
			messageId,
			conversationId: `${hostShip}/${channelName}`,
			kind
		})
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
		try {
			return await response.json();
		} catch (cause) {
			throw new Error(`Urbit scry response was malformed JSON for path ${params.path}`, { cause });
		}
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
function parseUrbitSsePayload(data) {
	try {
		return JSON.parse(data);
	} catch (cause) {
		throw new Error("Tlon Urbit SSE event was malformed JSON", { cause });
	}
}
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
	channelRequestContext() {
		return {
			baseUrl: this.url,
			cookie: this.cookie,
			ship: this.ship,
			channelId: this.channelId,
			ssrfPolicy: this.ssrfPolicy,
			lookupFn: this.lookupFn,
			fetchImpl: this.fetchImpl
		};
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
		await ensureUrbitChannelOpen(this.channelRequestContext(), {
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
					const eventData = buffer.slice(0, eventEnd);
					buffer = buffer.slice(eventEnd + 2);
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
			if (line.startsWith("id: ")) eventId = Number.parseInt(line.slice(4), 10);
			if (line.startsWith("data: ")) data = line.slice(6);
		}
		if (!data) return;
		if (eventId !== null && !Number.isNaN(eventId)) {
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
			const parsed = parseUrbitSsePayload(data);
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
		return await pokeUrbitChannel(this.channelRequestContext(), {
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
		const delay = Math.min(this.reconnectDelay * 2 ** (this.reconnectAttempts - 1), this.maxReconnectDelay);
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
* Approval system for managing DM, channel mention, and group invite approvals.
*
* When an unknown ship tries to interact with the bot, the owner receives
* a notification and can approve or deny the request.
*/
/**
* Generate a unique approval ID in the format: {type}-{timestamp}-{shortHash}
*/
function generateApprovalId(type) {
	return `${type}-${Date.now()}-${randomBytes(3).toString("hex")}`;
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
	return text.slice(0, maxLength - 3) + "...";
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
	throw new Error("Unsupported approval type");
}
/**
* Parse an owner's response to an approval request.
* Supports formats:
*   - "approve" / "deny" / "block" (applies to most recent pending)
*   - "approve dm-1234567890-abc" / "deny dm-1234567890-abc" (specific ID)
*   - "block" permanently blocks the ship via Tlon's native blocking
*/
function parseApprovalResponse(text) {
	const match = normalizeLowercaseStringOrEmpty(text).match(/^(approve|deny|block)(?:\s+(.+))?$/);
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
	const trimmed = normalizeLowercaseStringOrEmpty(text);
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
	throw new Error("Unsupported approval type");
}
/**
* Parse an admin command from owner message.
* Supports:
*   - "unblock ~ship" - unblock a specific ship
*   - "blocked" - list all blocked ships
*   - "pending" - list all pending approvals
*/
function parseAdminCommand(text) {
	const trimmed = normalizeLowercaseStringOrEmpty(text);
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
//#region extensions/tlon/src/monitor/approval-runtime.ts
function createTlonApprovalRuntime(params) {
	const { api, runtime, botShipName, getPendingApprovals, setPendingApprovals, getCurrentSettings, setCurrentSettings, getEffectiveDmAllowlist, setEffectiveDmAllowlist, getEffectiveOwnerShip, processApprovedMessage, refreshWatchedChannels } = params;
	const savePendingApprovals = async () => {
		try {
			await api.poke({
				app: "settings",
				mark: "settings-event",
				json: { "put-entry": {
					desk: "moltbot",
					"bucket-key": "tlon",
					"entry-key": "pendingApprovals",
					value: JSON.stringify(getPendingApprovals())
				} }
			});
		} catch (err) {
			runtime.error?.(`[tlon] Failed to save pending approvals: ${String(err)}`);
		}
	};
	const addToDmAllowlist = async (ship) => {
		const normalizedShip = normalizeShip(ship);
		const nextAllowlist = getEffectiveDmAllowlist().includes(normalizedShip) ? getEffectiveDmAllowlist() : [...getEffectiveDmAllowlist(), normalizedShip];
		setEffectiveDmAllowlist(nextAllowlist);
		try {
			await api.poke({
				app: "settings",
				mark: "settings-event",
				json: { "put-entry": {
					desk: "moltbot",
					"bucket-key": "tlon",
					"entry-key": "dmAllowlist",
					value: nextAllowlist
				} }
			});
			runtime.log?.(`[tlon] Added ${normalizedShip} to dmAllowlist`);
		} catch (err) {
			runtime.error?.(`[tlon] Failed to update dmAllowlist: ${String(err)}`);
		}
	};
	const addToChannelAllowlist = async (ship, channelNest) => {
		const normalizedShip = normalizeShip(ship);
		const currentSettings = getCurrentSettings();
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
		setCurrentSettings({
			...currentSettings,
			channelRules: updatedRules
		});
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
	};
	const blockShip = async (ship) => {
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
	};
	const isShipBlocked = async (ship) => {
		const normalizedShip = normalizeShip(ship);
		try {
			const blocked = await api.scry("/chat/blocked.json");
			return Array.isArray(blocked) && blocked.some((item) => normalizeShip(item) === normalizedShip);
		} catch (err) {
			runtime.log?.(`[tlon] Failed to check blocked list: ${String(err)}`);
			return false;
		}
	};
	const getBlockedShips = async () => {
		try {
			const blocked = await api.scry("/chat/blocked.json");
			return Array.isArray(blocked) ? blocked : [];
		} catch (err) {
			runtime.log?.(`[tlon] Failed to get blocked list: ${String(err)}`);
			return [];
		}
	};
	const unblockShip = async (ship) => {
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
	};
	const sendOwnerNotification = async (message) => {
		const ownerShip = getEffectiveOwnerShip();
		if (!ownerShip) {
			runtime.log?.("[tlon] No ownerShip configured, cannot send notification");
			return;
		}
		try {
			await sendDm({
				api,
				fromShip: botShipName,
				toShip: ownerShip,
				text: message
			});
			runtime.log?.(`[tlon] Sent notification to owner ${ownerShip}`);
		} catch (err) {
			runtime.error?.(`[tlon] Failed to send notification to owner: ${String(err)}`);
		}
	};
	const queueApprovalRequest = async (approval) => {
		if (await isShipBlocked(approval.requestingShip)) {
			runtime.log?.(`[tlon] Ignoring request from blocked ship ${approval.requestingShip}`);
			return;
		}
		const approvals = getPendingApprovals();
		const existingIndex = approvals.findIndex((item) => item.type === approval.type && item.requestingShip === approval.requestingShip && (approval.type !== "channel" || item.channelNest === approval.channelNest) && (approval.type !== "group" || item.groupFlag === approval.groupFlag));
		if (existingIndex !== -1) {
			const existing = approvals[existingIndex];
			if (approval.originalMessage) {
				existing.originalMessage = approval.originalMessage;
				existing.messagePreview = approval.messagePreview;
			}
			runtime.log?.(`[tlon] Updated existing approval for ${approval.requestingShip} (${approval.type}) - re-sending notification`);
			await savePendingApprovals();
			await sendOwnerNotification(formatApprovalRequest(existing));
			return;
		}
		setPendingApprovals([...approvals, approval]);
		await savePendingApprovals();
		await sendOwnerNotification(formatApprovalRequest(approval));
		runtime.log?.(`[tlon] Queued approval request: ${approval.id} (${approval.type} from ${approval.requestingShip})`);
	};
	const handleApprovalResponse = async (text) => {
		const parsed = parseApprovalResponse(text);
		if (!parsed) return false;
		const approval = findPendingApproval(getPendingApprovals(), parsed.id);
		if (!approval) {
			await sendOwnerNotification(`No pending approval found${parsed.id ? ` for ID: ${parsed.id}` : ""}`);
			return true;
		}
		if (parsed.action === "approve") {
			switch (approval.type) {
				case "dm":
					await addToDmAllowlist(approval.requestingShip);
					if (approval.originalMessage) {
						runtime.log?.(`[tlon] Processing original message from ${approval.requestingShip} after approval`);
						await processApprovedMessage(approval);
					}
					break;
				case "channel":
					if (approval.channelNest) {
						await addToChannelAllowlist(approval.requestingShip, approval.channelNest);
						if (approval.originalMessage) {
							runtime.log?.(`[tlon] Processing original message from ${approval.requestingShip} in ${approval.channelNest} after approval`);
							await processApprovedMessage(approval);
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
						setTimeout(() => {
							(async () => {
								try {
									const newCount = await refreshWatchedChannels();
									if (newCount > 0) runtime.log?.(`[tlon] Discovered ${newCount} new channel(s) after joining group`);
								} catch (err) {
									runtime.log?.(`[tlon] Channel discovery after group join failed: ${String(err)}`);
								}
							})();
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
		setPendingApprovals(removePendingApproval(getPendingApprovals(), approval.id));
		await savePendingApprovals();
		return true;
	};
	const handleAdminCommand = async (text) => {
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
				await sendOwnerNotification(formatPendingList(getPendingApprovals()));
				runtime.log?.(`[tlon] Owner requested pending approvals list (${getPendingApprovals().length} pending)`);
				return true;
			case "unblock": {
				const shipToUnblock = command.ship;
				if (!await isShipBlocked(shipToUnblock)) {
					await sendOwnerNotification(`${shipToUnblock} is not blocked.`);
					return true;
				}
				await sendOwnerNotification(await unblockShip(shipToUnblock) ? `Unblocked ${shipToUnblock}.` : `Failed to unblock ${shipToUnblock}.`);
				return true;
			}
		}
		throw new Error("Unsupported Tlon admin command");
	};
	return {
		queueApprovalRequest,
		handleApprovalResponse,
		handleAdminCommand
	};
}
//#endregion
//#region extensions/tlon/src/monitor/authorization.ts
function resolveChannelAuthorization(cfg, channelNest, settings) {
	const tlonConfig = cfg.channels?.tlon;
	const fileRules = tlonConfig?.authorization?.channelRules ?? {};
	const rule = (settings?.channelRules ?? {})[channelNest] ?? fileRules[channelNest];
	const defaultShips = settings?.defaultAuthorizedShips ?? tlonConfig?.defaultAuthorizedShips ?? [];
	return {
		mode: rule?.mode ?? "restricted",
		allowedShips: rule?.allowedShips ?? defaultShips
	};
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
function stripBotMention(messageText, botShipName) {
	if (!messageText || !botShipName) return messageText;
	return messageText.replace(normalizeShip(botShipName), "").trim();
}
const tlonIngressIdentity = {
	key: "sender-ship",
	normalize: normalizeShip,
	sensitivity: "pii",
	isWildcardEntry: () => false,
	entryIdPrefix: "tlon-entry"
};
async function isDmAllowedWithIngress(senderShip, allowlist) {
	return (await resolveStableChannelMessageIngress({
		channelId: "tlon",
		accountId: "default",
		identity: tlonIngressIdentity,
		subject: { stableId: senderShip },
		conversation: {
			kind: "direct",
			id: "direct"
		},
		dmPolicy: "allowlist",
		allowFrom: allowlist ?? []
	})).senderAccess.allowed;
}
async function resolveTlonCommandAuthorizationWithIngress(params) {
	const normalizedOwner = params.ownerShip ? normalizeShip(params.ownerShip) : null;
	return await resolveStableChannelMessageIngress({
		channelId: "tlon",
		accountId: "default",
		identity: tlonIngressIdentity,
		useAccessGroups: params.useAccessGroups,
		subject: { stableId: params.senderShip },
		conversation: {
			kind: "direct",
			id: "command"
		},
		event: {
			authMode: "none",
			mayPair: false
		},
		dmPolicy: "allowlist",
		groupPolicy: "open",
		allowFrom: normalizedOwner ? [normalizedOwner] : [],
		command: {}
	});
}
function isGroupInviteAllowed(inviterShip, allowlist) {
	if (!allowlist || allowlist.length === 0) return false;
	const normalizedInviter = normalizeShip(inviterShip);
	return allowlist.map((ship) => normalizeShip(ship)).some((ship) => ship === normalizedInviter);
}
async function resolveAuthorizedMessageText(params) {
	const { rawText, content, authorizedForCites, resolveAllCites } = params;
	if (!authorizedForCites) return rawText;
	return await resolveAllCites(content) + rawText;
}
const asRecord = asNullableObjectRecord;
const formatErrorMessage = formatErrorMessage$1;
const readString = readStringField;
function asNullableObjectRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function readStringField(record, field) {
	const value = record?.[field];
	return typeof value === "string" ? value : void 0;
}
function renderInlineItem(item, options) {
	if (typeof item === "string") return item;
	const record = asRecord(item);
	if (!record) return "";
	const ship = readString(record, "ship");
	if (ship) return ship;
	if ("sect" in record) {
		const sect = record.sect;
		if (typeof sect === "string") return `@${sect || "all"}`;
		if (sect === null) return "@all";
	}
	if (options?.allowBreak && "break" in record) return "\n";
	const inlineCode = readString(record, "inline-code");
	if (inlineCode) return `\`${inlineCode}\``;
	const code = readString(record, "code");
	if (code) return `\`${code}\``;
	const link = asRecord(record.link);
	const linkHref = link ? readString(link, "href") : void 0;
	if (link && linkHref) {
		const linkContent = readString(link, "content");
		return options?.linkMode === "href" ? linkHref : linkContent || linkHref;
	}
	if (Array.isArray(record.bold)) return `**${extractInlineText(record.bold)}**`;
	if (Array.isArray(record.italics)) return `*${extractInlineText(record.italics)}*`;
	if (Array.isArray(record.strike)) return `~~${extractInlineText(record.strike)}~~`;
	if (options?.allowBlockquote && Array.isArray(record.blockquote)) return `> ${extractInlineText(record.blockquote)}`;
	return "";
}
function extractInlineText(items) {
	return items.map((item) => renderInlineItem(item)).join("");
}
function extractMessageText(content) {
	if (!content || !Array.isArray(content)) return "";
	return content.map((verse) => {
		const verseRecord = asRecord(verse);
		if (!verseRecord) return "";
		if (Array.isArray(verseRecord.inline)) return verseRecord.inline.map((item) => renderInlineItem(item, {
			linkMode: "href",
			allowBreak: true,
			allowBlockquote: true
		})).join("");
		const block = asRecord(verseRecord.block);
		if (block) {
			const image = asRecord(block.image);
			if (image) {
				const imageSrc = readString(image, "src");
				if (imageSrc) {
					const altText = readString(image, "alt");
					return `\n${imageSrc}${altText ? ` (${altText})` : ""}\n`;
				}
			}
			const codeBlock = asRecord(block.code);
			if (codeBlock) return `\n\`\`\`${readString(codeBlock, "lang") ?? ""}\n${readString(codeBlock, "code") ?? ""}\n\`\`\`\n`;
			const header = asRecord(block.header);
			if (header) return `\n## ${(Array.isArray(header.content) ? header.content : []).map((item) => typeof item === "string" ? item : "").join("") || ""}\n`;
			const cite = asRecord(block.cite);
			if (cite) {
				const chanCite = asRecord(cite.chan);
				if (chanCite) {
					const nest = readString(chanCite, "nest");
					const whereMatch = readString(chanCite, "where")?.match(/\/msg\/(~[a-z-]+)\/(.+)/);
					if (whereMatch) {
						const [, author, _postId] = whereMatch;
						return `\n> [quoted: ${author} in ${nest}]\n`;
					}
					return `\n> [quoted from ${nest}]\n`;
				}
				const group = readString(cite, "group");
				if (group) return `\n> [ref: group ${group}]\n`;
				const desk = asRecord(cite.desk);
				if (desk) {
					const flag = readString(desk, "flag");
					if (flag) return `\n> [ref: ${flag}]\n`;
				}
				const bait = asRecord(cite.bait);
				if (bait) {
					const graph = readString(bait, "graph");
					const groupName = readString(bait, "group");
					if (graph && groupName) return `\n> [ref: ${graph} in ${groupName}]\n`;
				}
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
//#region extensions/tlon/src/monitor/cites.ts
function createTlonCitationResolver(params) {
	const { api, runtime } = params;
	const resolveCiteContent = async (cite) => {
		if (cite.type !== "chan" || !cite.nest || !cite.postId) return null;
		try {
			const scryPath = `/channels/v4/${cite.nest}/posts/post/${cite.postId}.json`;
			runtime.log?.(`[tlon] Fetching cited post: ${scryPath}`);
			const essay = asRecord(asRecord(await api.scry(scryPath))?.essay);
			if (essay?.content) return extractMessageText(essay.content) || null;
			return null;
		} catch (err) {
			runtime.log?.(`[tlon] Failed to fetch cited post: ${String(err)}`);
			return null;
		}
	};
	const resolveAllCites = async (content) => {
		const cites = extractCites(content);
		if (cites.length === 0) return "";
		const resolved = [];
		for (const cite of cites) {
			const text = await resolveCiteContent(cite);
			if (text) resolved.push(`> ${cite.author || "unknown"} wrote: ${text}`);
		}
		return resolved.length > 0 ? `${resolved.join("\n")}\n\n` : "";
	};
	return {
		resolveCiteContent,
		resolveAllCites
	};
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
		const initData = asRecord(await api.scry("/groups-ui/v6/init.json"));
		const channels = [];
		const groups = asRecord(initData?.groups);
		if (groups) for (const groupData of Object.values(groups)) {
			const groupChannels = asRecord(asRecord(groupData)?.channels);
			if (groupChannels) {
				for (const channelNest of Object.keys(groupChannels)) if (channelNest.startsWith("chat/")) channels.push(channelNest);
			}
		}
		if (channels.length > 0) runtime.log?.(`[tlon] Auto-discovered ${channels.length} chat channel(s)`);
		else runtime.log?.("[tlon] No chat channels found via auto-discovery");
		const foreignsValue = asRecord(initData?.foreigns);
		const foreigns = foreignsValue ? foreignsValue : null;
		if (foreigns) {
			const pendingCount = Object.values(foreigns).filter((f) => f.invites?.some((i) => i.valid)).length;
			if (pendingCount > 0) runtime.log?.(`[tlon] Found ${pendingCount} pending group invite(s)`);
		}
		return {
			channels,
			foreigns
		};
	} catch (error) {
		runtime.log?.(`[tlon] Init data fetch failed: ${formatErrorMessage(error)}`);
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
function createHistoryEntryFromMemo(params) {
	const { memo, seal, fallbackId } = params;
	return {
		author: typeof memo?.author === "string" ? memo.author : "unknown",
		content: extractMessageText(memo?.content || []),
		timestamp: typeof memo?.sent === "number" ? memo.sent : Date.now(),
		id: typeof seal?.id === "string" ? seal.id : typeof fallbackId === "string" ? fallbackId : void 0
	};
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
		else {
			const dataRecord = asRecord(data);
			const postMap = asRecord(dataRecord?.posts);
			if (postMap) posts = Object.values(postMap);
			else if (dataRecord) posts = Object.values(dataRecord);
		}
		const messages = posts.map((item) => {
			const itemRecord = asRecord(item);
			const replyPostSet = asRecord(asRecord(itemRecord?.["r-post"])?.set);
			const essay = asRecord(itemRecord?.essay) ?? asRecord(replyPostSet?.essay);
			const seal = asRecord(itemRecord?.seal) ?? asRecord(replyPostSet?.seal);
			return {
				author: typeof essay?.author === "string" ? essay.author : "unknown",
				content: extractMessageText(essay?.content || []),
				timestamp: typeof essay?.sent === "number" ? essay.sent : Date.now(),
				id: typeof seal?.id === "string" ? seal.id : void 0
			};
		}).filter((msg) => msg.content);
		runtime?.log?.(`[tlon] Extracted ${messages.length} messages from history`);
		return messages;
	} catch (error) {
		runtime?.log?.(`[tlon] Error fetching channel history: ${formatErrorMessage(error)}`);
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
		else {
			const dataRecord = asRecord(data);
			const replyValue = dataRecord?.replies;
			if (Array.isArray(replyValue)) replies = replyValue;
			else if (typeof replyValue === "object" && replyValue) replies = Object.values(replyValue);
			else if (dataRecord) replies = Object.values(dataRecord);
		}
		const messages = replies.map((item) => {
			const itemRecord = asRecord(item);
			const replySet = asRecord(asRecord(itemRecord?.["r-reply"])?.set);
			return createHistoryEntryFromMemo({
				memo: asRecord(itemRecord?.memo) ?? asRecord(replySet?.memo) ?? itemRecord,
				seal: asRecord(itemRecord?.seal) ?? asRecord(replySet?.seal),
				fallbackId: itemRecord?.id
			});
		}).filter((msg) => msg.content);
		runtime?.log?.(`[tlon] Extracted ${messages.length} thread replies from history`);
		return messages;
	} catch (error) {
		runtime?.log?.(`[tlon] Error fetching thread history: ${formatErrorMessage(error)}`);
		try {
			const altPath = `/channels/v4/${channelNest}/posts/post/id/${formatUd(parentId)}.json`;
			runtime?.log?.(`[tlon] Trying alternate path: ${altPath}`);
			const data = asRecord(await api.scry(altPath));
			const dataMeta = asRecord(asRecord(data?.seal)?.meta);
			const repliesValue = data?.replies;
			if (typeof dataMeta?.replyCount === "number" && dataMeta.replyCount > 0 && repliesValue) {
				const messages = (Array.isArray(repliesValue) ? repliesValue : Object.values(repliesValue)).map((reply) => {
					const replyRecord = asRecord(reply);
					return createHistoryEntryFromMemo({
						memo: asRecord(replyRecord?.memo),
						seal: asRecord(replyRecord?.seal)
					});
				}).filter((msg) => msg.content);
				runtime?.log?.(`[tlon] Extracted ${messages.length} replies from post data`);
				return messages;
			}
		} catch (altError) {
			runtime?.log?.(`[tlon] Alternate path also failed: ${formatErrorMessage(altError)}`);
		}
		return [];
	}
}
//#endregion
//#region extensions/tlon/src/monitor/media.ts
const MAX_IMAGES_PER_MESSAGE = 8;
const TLON_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS = 3e4;
/**
* Extract image blocks from Tlon message content.
* Returns array of image URLs found in the message.
*/
function extractImageBlocks(content) {
	if (!content || !Array.isArray(content)) return [];
	const images = [];
	for (const verse of content) if (verse?.block?.image?.src) {
		images.push({
			url: verse.block.image.src,
			alt: verse.block.image.alt
		});
		if (images.length >= MAX_IMAGES_PER_MESSAGE) break;
	}
	return images;
}
/**
* Download a media file from URL to local storage.
* Returns the local path where the file was saved.
*/
async function downloadMedia(url, mediaDir) {
	try {
		const parsedUrl = new URL(url);
		if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
			console.warn(`[tlon-media] Rejected non-http(s) URL: ${url}`);
			return null;
		}
		const fetchOptions = {
			url,
			maxBytes: MAX_IMAGE_BYTES,
			readIdleTimeoutMs: TLON_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS,
			ssrfPolicy: void 0,
			requestInit: { method: "GET" }
		};
		if (!mediaDir) {
			const saved = await saveRemoteMedia(fetchOptions);
			return {
				localPath: saved.path,
				contentType: saved.contentType ?? "application/octet-stream",
				originalUrl: url
			};
		}
		const fetched = await readRemoteMediaBuffer(fetchOptions);
		await mkdir(mediaDir, { recursive: true });
		const ext = getExtensionFromFileName(fetched.fileName) || getExtensionFromContentType(fetched.contentType ?? "") || getExtensionFromUrl(url) || "bin";
		const localPath = path$1.join(mediaDir, `${randomUUID()}.${ext}`);
		await writeFile(localPath, fetched.buffer);
		return {
			localPath,
			contentType: fetched.contentType ?? "application/octet-stream",
			originalUrl: url
		};
	} catch (error) {
		console.error(`[tlon-media] Error downloading ${url}: ${formatErrorMessage$1(error)}`);
		return null;
	}
}
function getExtensionFromFileName(fileName) {
	if (!fileName) return null;
	return path$1.extname(fileName).replace(/^\./, "") || null;
}
function getExtensionFromContentType(contentType) {
	return extensionForMime(contentType)?.replace(/^\./u, "") ?? null;
}
function getExtensionFromUrl(url) {
	try {
		const match = new URL(url).pathname.match(/\.([a-z0-9]+)$/i);
		return match ? normalizeLowercaseStringOrEmpty(match[1]) : null;
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
	const inFlight = /* @__PURE__ */ new Set();
	const claim = (id) => {
		const trimmed = id?.trim();
		if (!trimmed) return { kind: "claimed" };
		if (inFlight.has(trimmed) || dedupe.peek(trimmed)) return { kind: "duplicate" };
		inFlight.add(trimmed);
		return { kind: "claimed" };
	};
	const commit = (id) => {
		const trimmed = id?.trim();
		if (!trimmed) return;
		inFlight.delete(trimmed);
		dedupe.check(trimmed);
	};
	const release = (id) => {
		const trimmed = id?.trim();
		if (!trimmed) return;
		inFlight.delete(trimmed);
	};
	const mark = (id) => {
		if (claim(id).kind === "duplicate") return false;
		commit(id);
		return true;
	};
	const has = (id) => {
		const trimmed = id?.trim();
		if (!trimmed) return false;
		return dedupe.peek(trimmed);
	};
	return {
		claim,
		commit,
		release,
		mark,
		has,
		size: () => dedupe.size()
	};
}
async function runWithProcessedMessageClaim(params) {
	const claim = params.tracker.claim(params.id);
	if (claim.kind === "duplicate") return claim;
	try {
		const value = await params.task();
		params.tracker.commit(params.id);
		return {
			kind: "processed",
			value
		};
	} catch (error) {
		params.tracker.release(params.id);
		throw error;
	}
}
//#endregion
//#region extensions/tlon/src/monitor/settings-helpers.ts
function buildTlonSettingsMigrations(account, currentSettings) {
	return [
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
}
function shouldMigrateTlonSetting(fileValue, settingsValue) {
	return (Array.isArray(fileValue) ? fileValue.length > 0 : fileValue != null) && !(settingsValue != null);
}
function applyTlonSettingsOverrides(params) {
	let effectiveDmAllowlist = params.account.dmAllowlist;
	let effectiveShowModelSig = params.account.showModelSignature ?? false;
	let effectiveAutoAcceptDmInvites = params.account.autoAcceptDmInvites ?? false;
	let effectiveAutoAcceptGroupInvites = params.account.autoAcceptGroupInvites ?? false;
	let effectiveGroupInviteAllowlist = params.account.groupInviteAllowlist;
	let effectiveAutoDiscoverChannels = params.account.autoDiscoverChannels ?? false;
	let effectiveOwnerShip = params.account.ownerShip ? normalizeShip(params.account.ownerShip) : null;
	let pendingApprovals = [];
	if (params.currentSettings.defaultAuthorizedShips?.length) params.log?.(`[tlon] Using defaultAuthorizedShips from settings store: ${params.currentSettings.defaultAuthorizedShips.join(", ")}`);
	if (params.currentSettings.autoDiscoverChannels !== void 0) {
		effectiveAutoDiscoverChannels = params.currentSettings.autoDiscoverChannels;
		params.log?.(`[tlon] Using autoDiscoverChannels from settings store: ${effectiveAutoDiscoverChannels}`);
	}
	if (params.currentSettings.dmAllowlist !== void 0) {
		effectiveDmAllowlist = params.currentSettings.dmAllowlist;
		params.log?.(`[tlon] Using dmAllowlist from settings store: ${effectiveDmAllowlist.join(", ")}`);
	}
	if (params.currentSettings.showModelSig !== void 0) effectiveShowModelSig = params.currentSettings.showModelSig;
	if (params.currentSettings.autoAcceptDmInvites !== void 0) {
		effectiveAutoAcceptDmInvites = params.currentSettings.autoAcceptDmInvites;
		params.log?.(`[tlon] Using autoAcceptDmInvites from settings store: ${effectiveAutoAcceptDmInvites}`);
	}
	if (params.currentSettings.autoAcceptGroupInvites !== void 0) {
		effectiveAutoAcceptGroupInvites = params.currentSettings.autoAcceptGroupInvites;
		params.log?.(`[tlon] Using autoAcceptGroupInvites from settings store: ${effectiveAutoAcceptGroupInvites}`);
	}
	if (params.currentSettings.groupInviteAllowlist !== void 0) {
		effectiveGroupInviteAllowlist = params.currentSettings.groupInviteAllowlist;
		params.log?.(`[tlon] Using groupInviteAllowlist from settings store: ${effectiveGroupInviteAllowlist.join(", ")}`);
	}
	if (params.currentSettings.ownerShip) {
		effectiveOwnerShip = normalizeShip(params.currentSettings.ownerShip);
		params.log?.(`[tlon] Using ownerShip from settings store: ${effectiveOwnerShip}`);
	}
	if (params.currentSettings.pendingApprovals?.length) {
		pendingApprovals = params.currentSettings.pendingApprovals;
		params.log?.(`[tlon] Loaded ${pendingApprovals.length} pending approval(s) from settings`);
	}
	return {
		effectiveDmAllowlist,
		effectiveShowModelSig,
		effectiveAutoAcceptDmInvites,
		effectiveAutoAcceptGroupInvites,
		effectiveGroupInviteAllowlist,
		effectiveAutoDiscoverChannels,
		effectiveOwnerShip,
		pendingApprovals,
		currentSettings: params.currentSettings
	};
}
function mergeUniqueStrings(base, next) {
	if (!next?.length) return [...base];
	const merged = [...base];
	for (const value of next) if (!merged.includes(value)) merged.push(value);
	return merged;
}
//#endregion
//#region extensions/tlon/src/monitor/index.ts
function readNumber(record, key) {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
async function monitorTlonProvider(opts = {}) {
	const core = getTlonRuntime();
	const cfg = core.config.current();
	if (cfg.channels?.tlon?.enabled === false) return;
	const logger = core.logging.getChildLogger({ module: "tlon-auto-reply" });
	const runtime = opts.runtime ?? createLoggerBackedRuntime({ logger });
	const account = resolveTlonAccount(cfg, opts.accountId ?? void 0);
	if (!account.enabled) return;
	if (!account.configured || !account.ship || !account.url || !account.code) throw new Error("Tlon account not configured (ship/url/code required)");
	const botShipName = normalizeShip(account.ship);
	runtime.log?.(`[tlon] Starting monitor for ${botShipName}`);
	const ssrfPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(account.dangerouslyAllowPrivateNetwork);
	const accountUrl = account.url;
	const accountCode = account.code;
	async function authenticateWithRetry(maxAttempts = 10) {
		for (let attempt = 1;; attempt++) {
			if (opts.abortSignal?.aborted) throw new Error("Aborted while waiting to authenticate");
			try {
				runtime.log?.(`[tlon] Attempting authentication to ${accountUrl}...`);
				return await authenticate(accountUrl, accountCode, { ssrfPolicy });
			} catch (error) {
				runtime.error?.(`[tlon] Failed to authenticate (attempt ${attempt}): ${formatErrorMessage(error)}`);
				if (attempt >= maxAttempts) throw error;
				const delay = Math.min(3e4, 1e3 * 2 ** (attempt - 1));
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
		runtime.log?.(`[tlon] Could not fetch nickname: ${formatErrorMessage(error)}`);
	}
	let initForeigns = null;
	async function migrateConfigToSettings() {
		const migrations = buildTlonSettingsMigrations(account, currentSettings);
		for (const { key, fileValue, settingsValue } of migrations) if (shouldMigrateTlonSetting(fileValue, settingsValue)) try {
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
	try {
		currentSettings = await settingsManager.load();
		await migrateConfigToSettings();
		({effectiveDmAllowlist, effectiveShowModelSig, effectiveAutoAcceptDmInvites, effectiveAutoAcceptGroupInvites, effectiveGroupInviteAllowlist, effectiveAutoDiscoverChannels, effectiveOwnerShip, pendingApprovals, currentSettings} = applyTlonSettingsOverrides({
			account,
			currentSettings,
			log: (message) => runtime.log?.(message)
		}));
	} catch (err) {
		runtime.log?.(`[tlon] Settings store not available, using file config: ${String(err)}`);
	}
	if (effectiveAutoDiscoverChannels) try {
		const initData = await fetchInitData(api, runtime);
		if (initData.channels.length > 0) groupChannels = initData.channels;
		initForeigns = initData.foreigns;
	} catch (error) {
		runtime.error?.(`[tlon] Auto-discovery failed: ${formatErrorMessage(error)}`);
	}
	if (account.groupChannels.length > 0) {
		groupChannels = mergeUniqueStrings(groupChannels, account.groupChannels);
		runtime.log?.(`[tlon] Added ${account.groupChannels.length} manual groupChannels to monitoring`);
	}
	groupChannels = mergeUniqueStrings(groupChannels, currentSettings.groupChannels);
	if (groupChannels.length > 0) runtime.log?.(`[tlon] Monitoring ${groupChannels.length} group channel(s): ${groupChannels.join(", ")}`);
	else runtime.log?.("[tlon] No group channels to monitor (DMs only)");
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
		const { messageId, senderShip, isGroup, channelNest, hostShip: _hostShip, channelName: _channelName, timestamp, parentId, isThreadReply, messageContent } = params;
		const groupChannel = channelNest;
		let messageText = params.messageText;
		let attachments = [];
		if (messageContent) try {
			attachments = await downloadMessageImages(messageContent);
			if (attachments.length > 0) runtime.log?.(`[tlon] Downloaded ${attachments.length} image(s) from message`);
		} catch (error) {
			runtime.log?.(`[tlon] Failed to download images: ${formatErrorMessage(error)}`);
		}
		if (isThreadReply && parentId && groupChannel) try {
			const threadHistory = await fetchThreadHistory(api, groupChannel, parentId, 20, runtime);
			if (threadHistory.length > 0) {
				const threadContext = threadHistory.slice(-10).map((msg) => `${msg.author}: ${msg.content}`).join("\n");
				messageText = `${`[Thread conversation - ${threadHistory.length} previous replies. You are participating in this thread. Only respond if relevant or helpful - you don't need to reply to every message.]`}\n\n[Previous messages]\n${threadContext}\n\n[Current message]\n${messageText}`;
				runtime?.log?.(`[tlon] Added thread context (${threadHistory.length} replies) to message`);
			}
		} catch (error) {
			runtime?.log?.(`[tlon] Could not fetch thread context: ${formatErrorMessage(error)}`);
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
			const errorMsg = `Sorry, I encountered an error while fetching the channel history: ${formatErrorMessage(error)}`;
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
			commandAuthorized = (await resolveTlonCommandAuthorizationWithIngress({
				senderShip,
				ownerShip: effectiveOwnerShip,
				useAccessGroups
			})).commandAccess.authorized;
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
		const tlonConversationId = isGroup ? groupChannel ?? channelNest ?? senderShip : senderShip;
		const ctxPayload = core.channel.turn.buildContext({
			channel: "tlon",
			accountId: route.accountId,
			messageId,
			timestamp,
			from: isGroup ? `tlon:group:${groupChannel}` : `tlon:${senderShip}`,
			sender: {
				id: senderShip,
				name: senderShip,
				roles: [senderRole]
			},
			conversation: {
				kind: isGroup ? "group" : "direct",
				id: tlonConversationId,
				label: fromLabel,
				routePeer: {
					kind: isGroup ? "group" : "direct",
					id: tlonConversationId
				}
			},
			route: {
				agentId: route.agentId,
				accountId: route.accountId,
				routeSessionKey: route.sessionKey
			},
			reply: {
				to: `tlon:${botShipName}`,
				originatingTo: `tlon:${isGroup ? groupChannel : botShipName}`,
				replyToId: parentId ?? void 0
			},
			message: {
				body,
				bodyForAgent: commandBody,
				rawBody: messageText,
				commandBody,
				envelopeFrom: fromLabel
			},
			extra: {
				GroupSubject: void 0,
				SenderRole: senderRole,
				CommandAuthorized: commandAuthorized,
				CommandSource: "text",
				...attachments.length > 0 && { Attachments: attachments },
				...parentId && { ThreadId: parentId }
			}
		});
		const dispatchStartTime = Date.now();
		const responsePrefix = core.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix;
		const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);
		const storePath = core.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
		const deliveryTarget = isGroup ? groupChannel : senderShip;
		const prepareReplyPayload = (payload) => {
			const replyText = payload.text;
			if (!replyText) return payload;
			if (!effectiveShowModelSig) return payload;
			const extPayload = payload;
			const defaultModel = cfg.agents?.defaults?.model;
			const modelInfo = extPayload.metadata?.model || extPayload.model || (typeof defaultModel === "string" ? defaultModel : defaultModel?.primary);
			return {
				...payload,
				text: `${replyText}\n\n_[Generated by ${formatModelName(modelInfo)}]_`
			};
		};
		const rememberThreadParticipation = (result) => {
			if (!isGroup || !groupChannel || !parentId || result?.visibleReplySent === false) return;
			participatedThreads.add(parentId);
			runtime.log?.(`[tlon] Now tracking thread for future replies: ${parentId}`);
		};
		await core.channel.turn.runAssembled({
			channel: "tlon",
			accountId: route.accountId,
			cfg,
			agentId: route.agentId,
			routeSessionKey: route.sessionKey,
			storePath,
			ctxPayload,
			recordInboundSession: core.channel.session.recordInboundSession,
			dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
			delivery: {
				preparePayload: prepareReplyPayload,
				durable: deliveryTarget ? () => ({
					to: deliveryTarget,
					replyToId: parentId ?? void 0,
					threadId: parentId ?? void 0
				}) : false,
				deliver: async (payload) => {
					const replyText = payload.text;
					if (!replyText) return { visibleReplySent: false };
					if (isGroup && groupChannel) {
						const parsed = parseChannelNest(groupChannel);
						if (!parsed) return { visibleReplySent: false };
						await sendGroupMessage({
							api,
							fromShip: botShipName,
							hostShip: parsed.hostShip,
							channelName: parsed.channelName,
							text: replyText,
							replyToId: parentId ?? void 0
						});
						return {
							visibleReplySent: true,
							replyToId: parentId ?? void 0
						};
					}
					await sendDm({
						api,
						fromShip: botShipName,
						toShip: senderShip,
						text: replyText
					});
					return { visibleReplySent: true };
				},
				onDelivered: (_payload, _info, result) => {
					rememberThreadParticipation(result);
				},
				onError: (err, info) => {
					const dispatchDuration = Date.now() - dispatchStartTime;
					runtime.error?.(`[tlon] ${info.kind} reply failed after ${dispatchDuration}ms: ${String(err)}`);
				}
			},
			dispatcherOptions: {
				responsePrefix,
				humanDelay
			},
			record: { onRecordError: (err) => {
				runtime.error?.(`[tlon] failed updating session meta: ${String(err)}`);
			} }
		});
	};
	const watchedChannels = new Set(groupChannels);
	const refreshWatchedChannels = async () => {
		const discoveredChannels = await fetchAllChannels(api, runtime);
		let newCount = 0;
		for (const channelNest of discoveredChannels) if (!watchedChannels.has(channelNest)) {
			watchedChannels.add(channelNest);
			newCount++;
		}
		return newCount;
	};
	const { resolveAllCites } = createTlonCitationResolver({
		api: { scry: (path) => api.scry(path) },
		runtime
	});
	const { queueApprovalRequest, handleApprovalResponse, handleAdminCommand } = createTlonApprovalRuntime({
		api: {
			poke: (payload) => api.poke(payload),
			scry: (path) => api.scry(path)
		},
		runtime,
		botShipName,
		getPendingApprovals: () => pendingApprovals,
		setPendingApprovals: (approvals) => {
			pendingApprovals = approvals;
		},
		getCurrentSettings: () => currentSettings,
		setCurrentSettings: (settings) => {
			currentSettings = settings;
		},
		getEffectiveDmAllowlist: () => effectiveDmAllowlist,
		setEffectiveDmAllowlist: (ships) => {
			effectiveDmAllowlist = ships;
		},
		getEffectiveOwnerShip: () => effectiveOwnerShip,
		processApprovedMessage: async (approval) => {
			if (!approval.originalMessage) return;
			if (approval.type === "dm") {
				await processMessage({
					messageId: approval.originalMessage.messageId,
					senderShip: approval.requestingShip,
					messageText: approval.originalMessage.messageText,
					messageContent: approval.originalMessage.messageContent,
					isGroup: false,
					timestamp: approval.originalMessage.timestamp
				});
				return;
			}
			if (approval.type === "channel" && approval.channelNest) {
				const parsedChannel = parseChannelNest(approval.channelNest);
				await processMessage({
					messageId: approval.originalMessage.messageId,
					senderShip: approval.requestingShip,
					messageText: approval.originalMessage.messageText,
					messageContent: approval.originalMessage.messageContent,
					isGroup: true,
					channelNest: approval.channelNest,
					hostShip: parsedChannel?.hostShip,
					channelName: parsedChannel?.channelName,
					timestamp: approval.originalMessage.timestamp,
					parentId: approval.originalMessage.parentId,
					isThreadReply: approval.originalMessage.isThreadReply
				});
			}
		},
		refreshWatchedChannels
	});
	const handleChannelsFirehose = async (event) => {
		try {
			const eventRecord = asRecord(event);
			const nest = readString(eventRecord, "nest");
			if (!nest) return;
			if (!watchedChannels.has(nest)) return;
			const response = asRecord(eventRecord?.response);
			if (!response) return;
			const post = asRecord(response.post);
			const rPost = asRecord(post?.["r-post"]);
			const set = asRecord(rPost?.set);
			const reply = asRecord(rPost?.reply);
			const replySet = asRecord(asRecord(reply?.["r-reply"])?.set);
			const essay = asRecord(set?.essay);
			const memo = asRecord(replySet?.memo);
			if (!essay && !memo) return;
			const content = memo ?? essay;
			if (!content) return;
			const isThreadReply = Boolean(memo);
			const messageId = isThreadReply ? readString(reply, "id") : readString(post, "id");
			if (!messageId) return;
			if ((await runWithProcessedMessageClaim({
				tracker: processedTracker,
				id: messageId,
				task: async () => {
					const senderShip = normalizeShip(readString(content, "author") ?? "");
					if (!senderShip || senderShip === botShipName) return;
					const rawText = extractMessageText(content.content);
					if (!rawText.trim()) return;
					const contentBody = content.content;
					const sentAt = readNumber(content, "sent") ?? Date.now();
					cacheMessage(nest, {
						author: senderShip,
						content: rawText,
						timestamp: sentAt,
						id: messageId
					});
					const seal = isThreadReply ? asRecord(replySet?.seal) : asRecord(set?.seal);
					const parentId = readString(seal, "parent-id") ?? readString(seal, "parent") ?? null;
					const mentioned = isBotMentioned(rawText, botShipName, botNickname ?? void 0);
					const inParticipatedThread = isThreadReply && parentId && participatedThreads.has(parentId);
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
									messagePreview: rawText.slice(0, 100),
									originalMessage: {
										messageId: messageId ?? "",
										messageText: rawText,
										messageContent: contentBody,
										timestamp: sentAt,
										parentId: parentId ?? void 0,
										isThreadReply
									}
								}));
								else runtime.log?.(`[tlon] Access denied: ${senderShip} in ${nest} (allowed: ${allowedShips.join(", ")})`);
								return;
							}
						}
					}
					const messageText = await resolveAuthorizedMessageText({
						rawText,
						content: contentBody,
						authorizedForCites: true,
						resolveAllCites
					});
					const parsed = parseChannelNest(nest);
					await processMessage({
						messageId: messageId ?? "",
						senderShip,
						messageText,
						messageContent: contentBody,
						isGroup: true,
						channelNest: nest,
						hostShip: parsed?.hostShip,
						channelName: parsed?.channelName,
						timestamp: sentAt,
						parentId,
						isThreadReply
					});
				}
			})).kind === "duplicate") return;
		} catch (error) {
			runtime.error?.(`[tlon] Error handling channel firehose event: ${formatErrorMessage(error)}`);
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
					if (effectiveAutoAcceptDmInvites && await isDmAllowedWithIngress(ship, effectiveDmAllowlist)) {
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
					if (effectiveOwnerShip && !await isDmAllowedWithIngress(ship, effectiveDmAllowlist)) {
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
			const eventRecord = asRecord(event);
			if (!eventRecord) return;
			const whom = eventRecord.whom;
			const messageId = readString(eventRecord, "id");
			const response = asRecord(eventRecord.response);
			if (!messageId || !response) return;
			const essay = asRecord(asRecord(response.add)?.essay);
			if (!essay) return;
			if ((await runWithProcessedMessageClaim({
				tracker: processedTracker,
				id: messageId,
				task: async () => {
					const authorShip = normalizeShip(readString(essay, "author") ?? "");
					const partnerShip = extractDmPartnerShip(whom);
					const senderShip = partnerShip || authorShip;
					if (authorShip === botShipName) return;
					if (!senderShip || senderShip === botShipName) return;
					if (authorShip && partnerShip && authorShip !== partnerShip) runtime.log?.(`[tlon] DM ship mismatch (author=${authorShip}, partner=${partnerShip}) - routing to partner`);
					const rawText = extractMessageText(essay.content);
					if (!rawText.trim()) return;
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
						const resolvedMessageText = await resolveAuthorizedMessageText({
							rawText,
							content: essay.content,
							authorizedForCites: true,
							resolveAllCites
						});
						runtime.log?.(`[tlon] Processing DM from owner ${senderShip}`);
						await processMessage({
							messageId: messageId ?? "",
							senderShip,
							messageText: resolvedMessageText,
							messageContent: essay.content,
							isGroup: false,
							timestamp: readNumber(essay, "sent") ?? Date.now()
						});
						return;
					}
					if (!await isDmAllowedWithIngress(senderShip, effectiveDmAllowlist)) {
						if (effectiveOwnerShip) await queueApprovalRequest(createPendingApproval({
							type: "dm",
							requestingShip: senderShip,
							messagePreview: messageText.slice(0, 100),
							originalMessage: {
								messageId: messageId ?? "",
								messageText,
								messageContent: essay.content,
								timestamp: readNumber(essay, "sent") ?? Date.now()
							}
						}));
						else runtime.log?.(`[tlon] Blocked DM from ${senderShip}: not in allowlist`);
						return;
					}
					await processMessage({
						messageText: await resolveAuthorizedMessageText({
							rawText,
							content: essay.content,
							authorizedForCites: true,
							resolveAllCites
						}),
						messageId: messageId ?? "",
						senderShip,
						messageContent: essay.content,
						isGroup: false,
						timestamp: readNumber(essay, "sent") ?? Date.now()
					});
				}
			})).kind === "duplicate") return;
		} catch (error) {
			runtime.error?.(`[tlon] Error handling chat firehose event: ${formatErrorMessage(error)}`);
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
					const eventRecord = asRecord(event);
					if (eventRecord?.self) {
						const nickname = asRecord(asRecord(asRecord(eventRecord.self)?.contact)?.nickname);
						if (nickname && "value" in nickname) {
							const newNickname = readString(nickname, "value") ?? null;
							if (newNickname !== botNickname) {
								botNickname = newNickname;
								runtime.log?.(`[tlon] Nickname updated: ${botNickname}`);
							}
						}
					}
				} catch (error) {
					runtime.error?.(`[tlon] Error handling contacts event: ${formatErrorMessage(error)}`);
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
			({effectiveDmAllowlist, effectiveShowModelSig, effectiveAutoAcceptDmInvites, effectiveAutoAcceptGroupInvites, effectiveGroupInviteAllowlist, effectiveAutoDiscoverChannels, effectiveOwnerShip, pendingApprovals} = applyTlonSettingsOverrides({
				account,
				currentSettings: newSettings,
				log: (message) => runtime.log?.(message)
			}));
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
						const eventRecord = asRecord(event);
						if (eventRecord) {
							const channels = asRecord(eventRecord.channels);
							if (channels) for (const [channelNest, _channelData] of Object.entries(channels)) {
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
							const join = asRecord(eventRecord.join);
							if (join) {
								const joinChannels = Array.isArray(join.channels) ? join.channels : [];
								if (joinChannels.length > 0) for (const channelNest of joinChannels) {
									if (typeof channelNest !== "string") continue;
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
						runtime.error?.(`[tlon] Error handling groups-ui event: ${formatErrorMessage(error)}`);
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
					if (!isGroupInviteAllowed(inviterShip, effectiveGroupInviteAllowlist)) {
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
								runtime.error?.(`[tlon] Error handling foreigns event: ${formatErrorMessage(error)}`);
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
				runtime.error?.(`[tlon] Channel refresh error: ${formatErrorMessage(error)}`);
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
			runtime.error?.(`[tlon] Cleanup error: ${formatErrorMessage(error)}`);
		}
	}
}
//#endregion
//#region node_modules/@aws-sdk/middleware-expect-continue/dist-cjs/index.js
var require_dist_cjs$9 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var protocols = (init_protocols(), __toCommonJS(protocols_exports));
	function addExpectContinueMiddleware(options) {
		return (next) => async (args) => {
			const { request } = args;
			if (options.expectContinueHeader !== false && protocols.HttpRequest.isInstance(request) && request.body && options.runtime === "node" && options.requestHandler?.constructor?.name !== "FetchHttpHandler") {
				let sendHeader = true;
				if (typeof options.expectContinueHeader === "number") try {
					sendHeader = (Number(request.headers?.["content-length"]) ?? options.bodyLengthChecker?.(request.body) ?? Infinity) >= options.expectContinueHeader;
				} catch (e) {}
				else sendHeader = !!options.expectContinueHeader;
				if (sendHeader) request.headers.Expect = "100-continue";
			}
			return next({
				...args,
				request
			});
		};
	}
	const addExpectContinueMiddlewareOptions = {
		step: "build",
		tags: ["SET_EXPECT_HEADER", "EXPECT_HEADER"],
		name: "addExpectContinueMiddleware",
		override: true
	};
	const getAddExpectContinuePlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.add(addExpectContinueMiddleware(options), addExpectContinueMiddlewareOptions);
	} });
	exports.addExpectContinueMiddleware = addExpectContinueMiddleware;
	exports.addExpectContinueMiddlewareOptions = addExpectContinueMiddlewareOptions;
	exports.getAddExpectContinuePlugin = getAddExpectContinuePlugin;
}));
//#endregion
//#region node_modules/@aws-crypto/crc32c/build/main/aws_crc32c.js
var require_aws_crc32c = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.AwsCrc32c = void 0;
	var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
	var util_1 = require_main$1();
	var index_1 = require_main();
	exports.AwsCrc32c = function() {
		function AwsCrc32c() {
			this.crc32c = new index_1.Crc32c();
		}
		AwsCrc32c.prototype.update = function(toHash) {
			if ((0, util_1.isEmptyData)(toHash)) return;
			this.crc32c.update((0, util_1.convertToBuffer)(toHash));
		};
		AwsCrc32c.prototype.digest = function() {
			return tslib_1.__awaiter(this, void 0, void 0, function() {
				return tslib_1.__generator(this, function(_a) {
					return [2, (0, util_1.numToUint8)(this.crc32c.digest())];
				});
			});
		};
		AwsCrc32c.prototype.reset = function() {
			this.crc32c = new index_1.Crc32c();
		};
		return AwsCrc32c;
	}();
}));
//#endregion
//#region node_modules/@aws-crypto/crc32c/build/main/index.js
var require_main = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.AwsCrc32c = exports.Crc32c = exports.crc32c = void 0;
	var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
	var util_1 = require_main$1();
	function crc32c(data) {
		return new Crc32c().update(data).digest();
	}
	exports.crc32c = crc32c;
	var Crc32c = function() {
		function Crc32c() {
			this.checksum = 4294967295;
		}
		Crc32c.prototype.update = function(data) {
			var e_1, _a;
			try {
				for (var data_1 = tslib_1.__values(data), data_1_1 = data_1.next(); !data_1_1.done; data_1_1 = data_1.next()) {
					var byte = data_1_1.value;
					this.checksum = this.checksum >>> 8 ^ lookupTable[(this.checksum ^ byte) & 255];
				}
			} catch (e_1_1) {
				e_1 = { error: e_1_1 };
			} finally {
				try {
					if (data_1_1 && !data_1_1.done && (_a = data_1.return)) _a.call(data_1);
				} finally {
					if (e_1) throw e_1.error;
				}
			}
			return this;
		};
		Crc32c.prototype.digest = function() {
			return (this.checksum ^ 4294967295) >>> 0;
		};
		return Crc32c;
	}();
	exports.Crc32c = Crc32c;
	var lookupTable = (0, util_1.uint32ArrayFrom)([
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
	var aws_crc32c_1 = require_aws_crc32c();
	Object.defineProperty(exports, "AwsCrc32c", {
		enumerable: true,
		get: function() {
			return aws_crc32c_1.AwsCrc32c;
		}
	});
}));
//#endregion
//#region node_modules/@aws-sdk/crc64-nvme/dist-cjs/index.js
var require_dist_cjs$8 = /* @__PURE__ */ __commonJSMin(((exports) => {
	const generateCRC64NVMETable = () => {
		const sliceLength = 8;
		const tables = new Array(sliceLength);
		for (let slice = 0; slice < sliceLength; slice++) {
			const table = new Array(512);
			for (let i = 0; i < 256; i++) {
				let crc = BigInt(i);
				for (let j = 0; j < 8 * (slice + 1); j++) if (crc & 1n) crc = crc >> 1n ^ 11127430586519243189n;
				else crc = crc >> 1n;
				table[i * 2] = Number(crc >> 32n & 4294967295n);
				table[i * 2 + 1] = Number(crc & 4294967295n);
			}
			tables[slice] = new Uint32Array(table);
		}
		return tables;
	};
	let CRC64_NVME_REVERSED_TABLE;
	let t0, t1, t2, t3;
	let t4, t5, t6, t7;
	const ensureTablesInitialized = () => {
		if (!CRC64_NVME_REVERSED_TABLE) {
			CRC64_NVME_REVERSED_TABLE = generateCRC64NVMETable();
			[t0, t1, t2, t3, t4, t5, t6, t7] = CRC64_NVME_REVERSED_TABLE;
		}
	};
	var Crc64Nvme = class {
		c1 = 0;
		c2 = 0;
		constructor() {
			ensureTablesInitialized();
			this.reset();
		}
		update(data) {
			const len = data.length;
			let i = 0;
			let crc1 = this.c1;
			let crc2 = this.c2;
			while (i + 8 <= len) {
				const idx0 = ((crc2 ^ data[i++]) & 255) << 1;
				const idx1 = ((crc2 >>> 8 ^ data[i++]) & 255) << 1;
				const idx2 = ((crc2 >>> 16 ^ data[i++]) & 255) << 1;
				const idx3 = ((crc2 >>> 24 ^ data[i++]) & 255) << 1;
				const idx4 = ((crc1 ^ data[i++]) & 255) << 1;
				const idx5 = ((crc1 >>> 8 ^ data[i++]) & 255) << 1;
				const idx6 = ((crc1 >>> 16 ^ data[i++]) & 255) << 1;
				const idx7 = ((crc1 >>> 24 ^ data[i++]) & 255) << 1;
				crc1 = t7[idx0] ^ t6[idx1] ^ t5[idx2] ^ t4[idx3] ^ t3[idx4] ^ t2[idx5] ^ t1[idx6] ^ t0[idx7];
				crc2 = t7[idx0 + 1] ^ t6[idx1 + 1] ^ t5[idx2 + 1] ^ t4[idx3 + 1] ^ t3[idx4 + 1] ^ t2[idx5 + 1] ^ t1[idx6 + 1] ^ t0[idx7 + 1];
			}
			while (i < len) {
				const idx = ((crc2 ^ data[i]) & 255) << 1;
				crc2 = (crc2 >>> 8 | (crc1 & 255) << 24) >>> 0;
				crc1 = crc1 >>> 8 ^ t0[idx];
				crc2 ^= t0[idx + 1];
				i++;
			}
			this.c1 = crc1;
			this.c2 = crc2;
		}
		async digest() {
			const c1 = this.c1 ^ 4294967295;
			const c2 = this.c2 ^ 4294967295;
			return new Uint8Array([
				c1 >>> 24,
				c1 >>> 16 & 255,
				c1 >>> 8 & 255,
				c1 & 255,
				c2 >>> 24,
				c2 >>> 16 & 255,
				c2 >>> 8 & 255,
				c2 & 255
			]);
		}
		reset() {
			this.c1 = 4294967295;
			this.c2 = 4294967295;
		}
	};
	const crc64NvmeCrtContainer = { CrtCrc64Nvme: null };
	exports.Crc64Nvme = Crc64Nvme;
	exports.crc64NvmeCrtContainer = crc64NvmeCrtContainer;
}));
//#endregion
//#region node_modules/@aws-sdk/middleware-flexible-checksums/dist-cjs/getCrc32ChecksumAlgorithmFunction.js
var require_getCrc32ChecksumAlgorithmFunction = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getCrc32ChecksumAlgorithmFunction = void 0;
	const tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
	const crc32_1 = require_main$2();
	const util_1 = require_main$1();
	const zlib = tslib_1.__importStar(__require("node:zlib"));
	var NodeCrc32 = class {
		checksum = 0;
		update(data) {
			this.checksum = zlib.crc32(data, this.checksum);
		}
		async digest() {
			return (0, util_1.numToUint8)(this.checksum);
		}
		reset() {
			this.checksum = 0;
		}
	};
	const getCrc32ChecksumAlgorithmFunction = () => {
		if (typeof zlib.crc32 === "undefined") return crc32_1.AwsCrc32;
		return NodeCrc32;
	};
	exports.getCrc32ChecksumAlgorithmFunction = getCrc32ChecksumAlgorithmFunction;
}));
//#endregion
//#region node_modules/@aws-sdk/middleware-flexible-checksums/dist-cjs/index.js
var require_dist_cjs$7 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var client = (init_client(), __toCommonJS(client_exports));
	var protocols = (init_protocols(), __toCommonJS(protocols_exports));
	var serde = (init_serde(), __toCommonJS(serde_exports));
	var crc32c = require_main();
	var crc64Nvme = require_dist_cjs$8();
	var getCrc32ChecksumAlgorithmFunction = require_getCrc32ChecksumAlgorithmFunction();
	var client$1 = (init_client$1(), __toCommonJS(client_exports$1));
	const RequestChecksumCalculation = {
		WHEN_SUPPORTED: "WHEN_SUPPORTED",
		WHEN_REQUIRED: "WHEN_REQUIRED"
	};
	const DEFAULT_REQUEST_CHECKSUM_CALCULATION = RequestChecksumCalculation.WHEN_SUPPORTED;
	const ResponseChecksumValidation = {
		WHEN_SUPPORTED: "WHEN_SUPPORTED",
		WHEN_REQUIRED: "WHEN_REQUIRED"
	};
	const DEFAULT_RESPONSE_CHECKSUM_VALIDATION = RequestChecksumCalculation.WHEN_SUPPORTED;
	exports.ChecksumAlgorithm = void 0;
	(function(ChecksumAlgorithm) {
		ChecksumAlgorithm["MD5"] = "MD5";
		ChecksumAlgorithm["CRC32"] = "CRC32";
		ChecksumAlgorithm["CRC32C"] = "CRC32C";
		ChecksumAlgorithm["CRC64NVME"] = "CRC64NVME";
		ChecksumAlgorithm["SHA1"] = "SHA1";
		ChecksumAlgorithm["SHA256"] = "SHA256";
	})(exports.ChecksumAlgorithm || (exports.ChecksumAlgorithm = {}));
	exports.ChecksumLocation = void 0;
	(function(ChecksumLocation) {
		ChecksumLocation["HEADER"] = "header";
		ChecksumLocation["TRAILER"] = "trailer";
	})(exports.ChecksumLocation || (exports.ChecksumLocation = {}));
	const DEFAULT_CHECKSUM_ALGORITHM = exports.ChecksumAlgorithm.CRC32;
	var SelectorType;
	(function(SelectorType) {
		SelectorType["ENV"] = "env";
		SelectorType["CONFIG"] = "shared config entry";
	})(SelectorType || (SelectorType = {}));
	const stringUnionSelector = (obj, key, union, type) => {
		if (!(key in obj)) return void 0;
		const value = obj[key].toUpperCase();
		if (!Object.values(union).includes(value)) throw new TypeError(`Cannot load ${type} '${key}'. Expected one of ${Object.values(union)}, got '${obj[key]}'.`);
		return value;
	};
	const ENV_REQUEST_CHECKSUM_CALCULATION = "AWS_REQUEST_CHECKSUM_CALCULATION";
	const CONFIG_REQUEST_CHECKSUM_CALCULATION = "request_checksum_calculation";
	const NODE_REQUEST_CHECKSUM_CALCULATION_CONFIG_OPTIONS = {
		environmentVariableSelector: (env) => stringUnionSelector(env, ENV_REQUEST_CHECKSUM_CALCULATION, RequestChecksumCalculation, SelectorType.ENV),
		configFileSelector: (profile) => stringUnionSelector(profile, CONFIG_REQUEST_CHECKSUM_CALCULATION, RequestChecksumCalculation, SelectorType.CONFIG),
		default: DEFAULT_REQUEST_CHECKSUM_CALCULATION
	};
	const ENV_RESPONSE_CHECKSUM_VALIDATION = "AWS_RESPONSE_CHECKSUM_VALIDATION";
	const CONFIG_RESPONSE_CHECKSUM_VALIDATION = "response_checksum_validation";
	const NODE_RESPONSE_CHECKSUM_VALIDATION_CONFIG_OPTIONS = {
		environmentVariableSelector: (env) => stringUnionSelector(env, ENV_RESPONSE_CHECKSUM_VALIDATION, ResponseChecksumValidation, SelectorType.ENV),
		configFileSelector: (profile) => stringUnionSelector(profile, CONFIG_RESPONSE_CHECKSUM_VALIDATION, ResponseChecksumValidation, SelectorType.CONFIG),
		default: DEFAULT_RESPONSE_CHECKSUM_VALIDATION
	};
	const getChecksumAlgorithmForRequest = (input, { requestChecksumRequired, requestAlgorithmMember, requestChecksumCalculation }) => {
		if (!requestAlgorithmMember) return requestChecksumCalculation === RequestChecksumCalculation.WHEN_SUPPORTED || requestChecksumRequired ? DEFAULT_CHECKSUM_ALGORITHM : void 0;
		if (!input[requestAlgorithmMember]) return;
		return input[requestAlgorithmMember];
	};
	const getChecksumLocationName = (algorithm) => algorithm === exports.ChecksumAlgorithm.MD5 ? "content-md5" : `x-amz-checksum-${algorithm.toLowerCase()}`;
	const hasHeader = (header, headers) => {
		const soughtHeader = header.toLowerCase();
		for (const headerName of Object.keys(headers)) if (soughtHeader === headerName.toLowerCase()) return true;
		return false;
	};
	const hasHeaderWithPrefix = (headerPrefix, headers) => {
		const soughtHeaderPrefix = headerPrefix.toLowerCase();
		for (const headerName of Object.keys(headers)) if (headerName.toLowerCase().startsWith(soughtHeaderPrefix)) return true;
		return false;
	};
	const isStreaming = (body) => body !== void 0 && typeof body !== "string" && !ArrayBuffer.isView(body) && !serde.isArrayBuffer(body);
	const CLIENT_SUPPORTED_ALGORITHMS = [
		exports.ChecksumAlgorithm.CRC32,
		exports.ChecksumAlgorithm.CRC32C,
		exports.ChecksumAlgorithm.CRC64NVME,
		exports.ChecksumAlgorithm.SHA1,
		exports.ChecksumAlgorithm.SHA256
	];
	const PRIORITY_ORDER_ALGORITHMS = [
		exports.ChecksumAlgorithm.SHA256,
		exports.ChecksumAlgorithm.SHA1,
		exports.ChecksumAlgorithm.CRC32,
		exports.ChecksumAlgorithm.CRC32C,
		exports.ChecksumAlgorithm.CRC64NVME
	];
	const selectChecksumAlgorithmFunction = (checksumAlgorithm, config) => {
		const { checksumAlgorithms = {} } = config;
		switch (checksumAlgorithm) {
			case exports.ChecksumAlgorithm.MD5: return checksumAlgorithms?.MD5 ?? config.md5;
			case exports.ChecksumAlgorithm.CRC32: return checksumAlgorithms?.CRC32 ?? getCrc32ChecksumAlgorithmFunction.getCrc32ChecksumAlgorithmFunction();
			case exports.ChecksumAlgorithm.CRC32C: return checksumAlgorithms?.CRC32C ?? crc32c.AwsCrc32c;
			case exports.ChecksumAlgorithm.CRC64NVME:
				if (typeof crc64Nvme.crc64NvmeCrtContainer.CrtCrc64Nvme !== "function") return checksumAlgorithms?.CRC64NVME ?? crc64Nvme.Crc64Nvme;
				return checksumAlgorithms?.CRC64NVME ?? crc64Nvme.crc64NvmeCrtContainer.CrtCrc64Nvme;
			case exports.ChecksumAlgorithm.SHA1: return checksumAlgorithms?.SHA1 ?? config.sha1;
			case exports.ChecksumAlgorithm.SHA256: return checksumAlgorithms?.SHA256 ?? config.sha256;
			default:
				if (checksumAlgorithms?.[checksumAlgorithm]) return checksumAlgorithms[checksumAlgorithm];
				throw new Error(`The checksum algorithm "${checksumAlgorithm}" is not supported by the client. Select one of ${CLIENT_SUPPORTED_ALGORITHMS}, or provide an implementation to  the client constructor checksums field.`);
		}
	};
	const stringHasher = (checksumAlgorithmFn, body) => {
		const hash = new checksumAlgorithmFn();
		hash.update(serde.toUint8Array(body || ""));
		return hash.digest();
	};
	const flexibleChecksumsMiddlewareOptions = {
		name: "flexibleChecksumsMiddleware",
		step: "build",
		tags: ["BODY_CHECKSUM"],
		override: true
	};
	const flexibleChecksumsMiddleware = (config, middlewareConfig) => (next, context) => async (args) => {
		if (!protocols.HttpRequest.isInstance(args.request)) return next(args);
		if (hasHeaderWithPrefix("x-amz-checksum-", args.request.headers)) return next(args);
		const { request, input } = args;
		const { body: requestBody, headers } = request;
		const { base64Encoder, streamHasher } = config;
		const { requestChecksumRequired, requestAlgorithmMember } = middlewareConfig;
		const requestChecksumCalculation = await config.requestChecksumCalculation();
		const requestAlgorithmMemberName = requestAlgorithmMember?.name;
		const requestAlgorithmMemberHttpHeader = requestAlgorithmMember?.httpHeader;
		if (requestAlgorithmMemberName && !input[requestAlgorithmMemberName]) {
			if (requestChecksumCalculation === RequestChecksumCalculation.WHEN_SUPPORTED || requestChecksumRequired) {
				input[requestAlgorithmMemberName] = DEFAULT_CHECKSUM_ALGORITHM;
				if (requestAlgorithmMemberHttpHeader) headers[requestAlgorithmMemberHttpHeader] = DEFAULT_CHECKSUM_ALGORITHM;
			}
		}
		const checksumAlgorithm = getChecksumAlgorithmForRequest(input, {
			requestChecksumRequired,
			requestAlgorithmMember: requestAlgorithmMember?.name,
			requestChecksumCalculation
		});
		let updatedBody = requestBody;
		let updatedHeaders = headers;
		if (checksumAlgorithm) {
			switch (checksumAlgorithm) {
				case exports.ChecksumAlgorithm.CRC32:
					client.setFeature(context, "FLEXIBLE_CHECKSUMS_REQ_CRC32", "U");
					break;
				case exports.ChecksumAlgorithm.CRC32C:
					client.setFeature(context, "FLEXIBLE_CHECKSUMS_REQ_CRC32C", "V");
					break;
				case exports.ChecksumAlgorithm.CRC64NVME:
					client.setFeature(context, "FLEXIBLE_CHECKSUMS_REQ_CRC64", "W");
					break;
				case exports.ChecksumAlgorithm.SHA1:
					client.setFeature(context, "FLEXIBLE_CHECKSUMS_REQ_SHA1", "X");
					break;
				case exports.ChecksumAlgorithm.SHA256:
					client.setFeature(context, "FLEXIBLE_CHECKSUMS_REQ_SHA256", "Y");
					break;
			}
			const checksumLocationName = getChecksumLocationName(checksumAlgorithm);
			const checksumAlgorithmFn = selectChecksumAlgorithmFunction(checksumAlgorithm, config);
			if (isStreaming(requestBody)) {
				const { getAwsChunkedEncodingStream, bodyLengthChecker } = config;
				updatedBody = getAwsChunkedEncodingStream(typeof config.requestStreamBufferSize === "number" && config.requestStreamBufferSize >= 8 * 1024 ? serde.createBufferedReadable(requestBody, config.requestStreamBufferSize, context.logger) : requestBody, {
					base64Encoder,
					bodyLengthChecker,
					checksumLocationName,
					checksumAlgorithmFn,
					streamHasher
				});
				updatedHeaders = {
					...headers,
					"content-encoding": headers["content-encoding"] ? `${headers["content-encoding"]},aws-chunked` : "aws-chunked",
					"transfer-encoding": "chunked",
					"x-amz-decoded-content-length": headers["content-length"],
					"x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
					"x-amz-trailer": checksumLocationName
				};
				delete updatedHeaders["content-length"];
			} else if (!hasHeader(checksumLocationName, headers)) {
				const rawChecksum = await stringHasher(checksumAlgorithmFn, requestBody);
				updatedHeaders = {
					...headers,
					[checksumLocationName]: base64Encoder(rawChecksum)
				};
			}
		}
		try {
			return await next({
				...args,
				request: {
					...request,
					headers: updatedHeaders,
					body: updatedBody
				}
			});
		} catch (e) {
			if (e instanceof Error && e.name === "InvalidChunkSizeError") try {
				if (!e.message.endsWith(".")) e.message += ".";
				e.message += " Set [requestStreamBufferSize=number e.g. 65_536] in client constructor to instruct AWS SDK to buffer your input stream.";
			} catch (ignored) {}
			throw e;
		}
	};
	const flexibleChecksumsInputMiddlewareOptions = {
		name: "flexibleChecksumsInputMiddleware",
		toMiddleware: "serializerMiddleware",
		relation: "before",
		tags: ["BODY_CHECKSUM"],
		override: true
	};
	const flexibleChecksumsInputMiddleware = (config, middlewareConfig) => (next, context) => async (args) => {
		const input = args.input;
		const { requestValidationModeMember } = middlewareConfig;
		const requestChecksumCalculation = await config.requestChecksumCalculation();
		const responseChecksumValidation = await config.responseChecksumValidation();
		switch (requestChecksumCalculation) {
			case RequestChecksumCalculation.WHEN_REQUIRED:
				client.setFeature(context, "FLEXIBLE_CHECKSUMS_REQ_WHEN_REQUIRED", "a");
				break;
			case RequestChecksumCalculation.WHEN_SUPPORTED:
				client.setFeature(context, "FLEXIBLE_CHECKSUMS_REQ_WHEN_SUPPORTED", "Z");
				break;
		}
		switch (responseChecksumValidation) {
			case ResponseChecksumValidation.WHEN_REQUIRED:
				client.setFeature(context, "FLEXIBLE_CHECKSUMS_RES_WHEN_REQUIRED", "c");
				break;
			case ResponseChecksumValidation.WHEN_SUPPORTED:
				client.setFeature(context, "FLEXIBLE_CHECKSUMS_RES_WHEN_SUPPORTED", "b");
				break;
		}
		if (requestValidationModeMember && !input[requestValidationModeMember]) {
			if (responseChecksumValidation === ResponseChecksumValidation.WHEN_SUPPORTED) input[requestValidationModeMember] = "ENABLED";
		}
		return next(args);
	};
	const getChecksumAlgorithmListForResponse = (responseAlgorithms = []) => {
		const validChecksumAlgorithms = [];
		let i = PRIORITY_ORDER_ALGORITHMS.length;
		for (const algorithm of responseAlgorithms) {
			const priority = PRIORITY_ORDER_ALGORITHMS.indexOf(algorithm);
			if (priority !== -1) validChecksumAlgorithms[priority] = algorithm;
			else validChecksumAlgorithms[i++] = algorithm;
		}
		return validChecksumAlgorithms.filter(Boolean);
	};
	const isChecksumWithPartNumber = (checksum) => {
		const lastHyphenIndex = checksum.lastIndexOf("-");
		if (lastHyphenIndex !== -1) {
			const numberPart = checksum.slice(lastHyphenIndex + 1);
			if (!numberPart.startsWith("0")) {
				const number = parseInt(numberPart, 10);
				if (!isNaN(number) && number >= 1 && number <= 1e4) return true;
			}
		}
		return false;
	};
	const getChecksum = async (body, { checksumAlgorithmFn, base64Encoder }) => base64Encoder(await stringHasher(checksumAlgorithmFn, body));
	const validateChecksumFromResponse = async (response, { config, responseAlgorithms, logger }) => {
		const checksumAlgorithms = getChecksumAlgorithmListForResponse(responseAlgorithms);
		const { body: responseBody, headers: responseHeaders } = response;
		for (const algorithm of checksumAlgorithms) {
			const responseHeader = getChecksumLocationName(algorithm);
			const checksumFromResponse = responseHeaders[responseHeader];
			if (checksumFromResponse) {
				let checksumAlgorithmFn;
				try {
					checksumAlgorithmFn = selectChecksumAlgorithmFunction(algorithm, config);
				} catch (error) {
					if (algorithm === exports.ChecksumAlgorithm.CRC64NVME) {
						logger?.warn(`Skipping ${exports.ChecksumAlgorithm.CRC64NVME} checksum validation: ${error.message}`);
						continue;
					}
					throw error;
				}
				const { base64Encoder } = config;
				if (isStreaming(responseBody)) {
					response.body = serde.createChecksumStream({
						expectedChecksum: checksumFromResponse,
						checksumSourceLocation: responseHeader,
						checksum: new checksumAlgorithmFn(),
						source: responseBody,
						base64Encoder
					});
					return;
				}
				const checksum = await getChecksum(responseBody, {
					checksumAlgorithmFn,
					base64Encoder
				});
				if (checksum === checksumFromResponse) break;
				throw new Error(`Checksum mismatch: expected "${checksum}" but received "${checksumFromResponse}" in response header "${responseHeader}".`);
			}
		}
	};
	const flexibleChecksumsResponseMiddlewareOptions = {
		name: "flexibleChecksumsResponseMiddleware",
		toMiddleware: "deserializerMiddleware",
		relation: "after",
		tags: ["BODY_CHECKSUM"],
		override: true
	};
	const flexibleChecksumsResponseMiddleware = (config, middlewareConfig) => (next, context) => async (args) => {
		if (!protocols.HttpRequest.isInstance(args.request)) return next(args);
		const input = args.input;
		const result = await next(args);
		const response = result.response;
		const { requestValidationModeMember, responseAlgorithms } = middlewareConfig;
		if (requestValidationModeMember && input[requestValidationModeMember] === "ENABLED") {
			const { clientName, commandName } = context;
			const customChecksumAlgorithms = Object.keys(config.checksumAlgorithms ?? {}).filter((algorithm) => {
				const responseHeader = getChecksumLocationName(algorithm);
				return response.headers[responseHeader] !== void 0;
			});
			const algoList = getChecksumAlgorithmListForResponse([...responseAlgorithms ?? [], ...customChecksumAlgorithms]);
			if (clientName === "S3Client" && commandName === "GetObjectCommand" && algoList.every((algorithm) => {
				const responseHeader = getChecksumLocationName(algorithm);
				const checksumFromResponse = response.headers[responseHeader];
				return !checksumFromResponse || isChecksumWithPartNumber(checksumFromResponse);
			})) return result;
			await validateChecksumFromResponse(response, {
				config,
				responseAlgorithms: algoList,
				logger: context.logger
			});
		}
		return result;
	};
	const getFlexibleChecksumsPlugin = (config, middlewareConfig) => ({ applyToStack: (clientStack) => {
		clientStack.add(flexibleChecksumsMiddleware(config, middlewareConfig), flexibleChecksumsMiddlewareOptions);
		clientStack.addRelativeTo(flexibleChecksumsInputMiddleware(config, middlewareConfig), flexibleChecksumsInputMiddlewareOptions);
		clientStack.addRelativeTo(flexibleChecksumsResponseMiddleware(config, middlewareConfig), flexibleChecksumsResponseMiddlewareOptions);
	} });
	const resolveFlexibleChecksumsConfig = (input) => {
		const { requestChecksumCalculation, responseChecksumValidation, requestStreamBufferSize } = input;
		return Object.assign(input, {
			requestChecksumCalculation: client$1.normalizeProvider(requestChecksumCalculation ?? DEFAULT_REQUEST_CHECKSUM_CALCULATION),
			responseChecksumValidation: client$1.normalizeProvider(responseChecksumValidation ?? DEFAULT_RESPONSE_CHECKSUM_VALIDATION),
			requestStreamBufferSize: Number(requestStreamBufferSize ?? 0),
			checksumAlgorithms: input.checksumAlgorithms ?? {}
		});
	};
	exports.CONFIG_REQUEST_CHECKSUM_CALCULATION = CONFIG_REQUEST_CHECKSUM_CALCULATION;
	exports.CONFIG_RESPONSE_CHECKSUM_VALIDATION = CONFIG_RESPONSE_CHECKSUM_VALIDATION;
	exports.DEFAULT_CHECKSUM_ALGORITHM = DEFAULT_CHECKSUM_ALGORITHM;
	exports.DEFAULT_REQUEST_CHECKSUM_CALCULATION = DEFAULT_REQUEST_CHECKSUM_CALCULATION;
	exports.DEFAULT_RESPONSE_CHECKSUM_VALIDATION = DEFAULT_RESPONSE_CHECKSUM_VALIDATION;
	exports.ENV_REQUEST_CHECKSUM_CALCULATION = ENV_REQUEST_CHECKSUM_CALCULATION;
	exports.ENV_RESPONSE_CHECKSUM_VALIDATION = ENV_RESPONSE_CHECKSUM_VALIDATION;
	exports.NODE_REQUEST_CHECKSUM_CALCULATION_CONFIG_OPTIONS = NODE_REQUEST_CHECKSUM_CALCULATION_CONFIG_OPTIONS;
	exports.NODE_RESPONSE_CHECKSUM_VALIDATION_CONFIG_OPTIONS = NODE_RESPONSE_CHECKSUM_VALIDATION_CONFIG_OPTIONS;
	exports.RequestChecksumCalculation = RequestChecksumCalculation;
	exports.ResponseChecksumValidation = ResponseChecksumValidation;
	exports.flexibleChecksumsMiddleware = flexibleChecksumsMiddleware;
	exports.flexibleChecksumsMiddlewareOptions = flexibleChecksumsMiddlewareOptions;
	exports.getFlexibleChecksumsPlugin = getFlexibleChecksumsPlugin;
	exports.resolveFlexibleChecksumsConfig = resolveFlexibleChecksumsConfig;
}));
//#endregion
//#region node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/toStream.js
var require_toStream = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.toStream = toStream;
	const node_stream_1 = __require("node:stream");
	function toStream(bytes) {
		return node_stream_1.Readable.from(Buffer.from(bytes));
	}
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/util/util-arn-parser/arn.js
var validate, parse, build;
var init_arn = __esmMin((() => {
	validate = (str) => typeof str === "string" && str.indexOf("arn:") === 0 && str.split(":").length >= 6;
	parse = (arn) => {
		const segments = arn.split(":");
		if (segments.length < 6 || segments[0] !== "arn") throw new Error("Malformed ARN");
		const [, partition, service, region, accountId, ...resource] = segments;
		return {
			partition,
			service,
			region,
			accountId,
			resource: resource.join(":")
		};
	};
	build = (arnObject) => {
		const { partition = "aws", service, region, accountId, resource } = arnObject;
		if ([
			service,
			region,
			accountId,
			resource
		].some((segment) => typeof segment !== "string")) throw new Error("Input ARN object is invalid");
		return `arn:${partition}:${service}:${region}:${accountId}:${resource}`;
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/util/util-format-url/format-url.js
function formatUrl(request) {
	const { port, query } = request;
	let { protocol, path, hostname } = request;
	if (protocol && protocol.slice(-1) !== ":") protocol += ":";
	if (port) hostname += `:${port}`;
	if (path && path.charAt(0) !== "/") path = `/${path}`;
	let queryString = query ? buildQueryString(query) : "";
	if (queryString && queryString[0] !== "?") queryString = `?${queryString}`;
	let auth = "";
	if (request.username != null || request.password != null) auth = `${request.username ?? ""}:${request.password ?? ""}@`;
	let fragment = "";
	if (request.fragment) fragment = `#${request.fragment}`;
	return `${protocol}//${auth}${hostname}${path}${queryString}${fragment}`;
}
var init_format_url = __esmMin((() => {
	init_protocols();
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/util/index.js
var util_exports = /* @__PURE__ */ __exportAll({
	build: () => build,
	formatUrl: () => formatUrl,
	parse: () => parse,
	validate: () => validate
});
var init_util = __esmMin((() => {
	init_arn();
	init_format_url();
}));
//#endregion
//#region node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js
var require_dist_cjs$6 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var client = (init_client$1(), __toCommonJS(client_exports$1));
	var protocols = (init_protocols(), __toCommonJS(protocols_exports));
	var serde = (init_serde(), __toCommonJS(serde_exports));
	var toStream = require_toStream();
	var util = (init_util(), __toCommonJS(util_exports));
	var protocols$1 = (init_protocols$1(), __toCommonJS(protocols_exports$1));
	var schema = (init_schema(), __toCommonJS(schema_exports));
	var signatureV4MultiRegion = require_dist_cjs$10();
	var config = (init_config(), __toCommonJS(config_exports));
	var client$1 = (init_client(), __toCommonJS(client_exports));
	var core = (init_dist_es(), __toCommonJS(dist_es_exports));
	const CONTENT_LENGTH_HEADER = "content-length";
	const DECODED_CONTENT_LENGTH_HEADER = "x-amz-decoded-content-length";
	function checkContentLengthHeader() {
		return (next, context) => async (args) => {
			const { request } = args;
			if (protocols.HttpRequest.isInstance(request)) {
				if (!(CONTENT_LENGTH_HEADER in request.headers) && !(DECODED_CONTENT_LENGTH_HEADER in request.headers)) {
					const message = `Are you using a Stream of unknown length as the Body of a PutObject request? Consider using Upload instead from @aws-sdk/lib-storage.`;
					if (typeof context?.logger?.warn === "function" && !(context.logger instanceof client.NoOpLogger)) context.logger.warn(message);
					else console.warn(message);
				}
			}
			return next({ ...args });
		};
	}
	const checkContentLengthHeaderMiddlewareOptions = {
		step: "finalizeRequest",
		tags: ["CHECK_CONTENT_LENGTH_HEADER"],
		name: "getCheckContentLengthHeaderPlugin",
		override: true
	};
	const getCheckContentLengthHeaderPlugin = (unused) => ({ applyToStack: (clientStack) => {
		clientStack.add(checkContentLengthHeader(), checkContentLengthHeaderMiddlewareOptions);
	} });
	const regionRedirectEndpointMiddleware = (config) => {
		return (next, context) => async (args) => {
			const originalRegion = await config.region();
			const regionProviderRef = config.region;
			let unlock = () => {};
			if (context.__s3RegionRedirect) {
				Object.defineProperty(config, "region", {
					writable: false,
					value: async () => {
						return context.__s3RegionRedirect;
					}
				});
				unlock = () => Object.defineProperty(config, "region", {
					writable: true,
					value: regionProviderRef
				});
			}
			try {
				const result = await next(args);
				if (context.__s3RegionRedirect) {
					unlock();
					if (originalRegion !== await config.region()) throw new Error("Region was not restored following S3 region redirect.");
				}
				return result;
			} catch (e) {
				unlock();
				throw e;
			}
		};
	};
	const regionRedirectEndpointMiddlewareOptions = {
		tags: ["REGION_REDIRECT", "S3"],
		name: "regionRedirectEndpointMiddleware",
		override: true,
		relation: "before",
		toMiddleware: "endpointV2Middleware"
	};
	function regionRedirectMiddleware(clientConfig) {
		return (next, context) => async (args) => {
			try {
				return await next(args);
			} catch (err) {
				if (clientConfig.followRegionRedirects) {
					const statusCode = err?.$metadata?.httpStatusCode;
					const isHeadBucket = context.commandName === "HeadBucketCommand";
					const bucketRegionHeader = err?.$response?.headers?.["x-amz-bucket-region"];
					if (bucketRegionHeader) {
						if (statusCode === 301 || statusCode === 400 && (err?.name === "IllegalLocationConstraintException" || isHeadBucket)) {
							try {
								const actualRegion = bucketRegionHeader;
								context.logger?.debug(`Redirecting from ${await clientConfig.region()} to ${actualRegion}`);
								context.__s3RegionRedirect = actualRegion;
							} catch (e) {
								throw new Error("Region redirect failed: " + e);
							}
							return next(args);
						}
					}
				}
				throw err;
			}
		};
	}
	const regionRedirectMiddlewareOptions = {
		step: "initialize",
		tags: ["REGION_REDIRECT", "S3"],
		name: "regionRedirectMiddleware",
		override: true
	};
	const getRegionRedirectMiddlewarePlugin = (clientConfig) => ({ applyToStack: (clientStack) => {
		clientStack.add(regionRedirectMiddleware(clientConfig), regionRedirectMiddlewareOptions);
		clientStack.addRelativeTo(regionRedirectEndpointMiddleware(clientConfig), regionRedirectEndpointMiddlewareOptions);
	} });
	const s3ExpiresMiddleware = (config) => {
		return (next, context) => async (args) => {
			const result = await next(args);
			const { response } = result;
			if (protocols.HttpResponse.isInstance(response)) {
				if (response.headers.expires) {
					response.headers.expiresstring = response.headers.expires;
					try {
						serde.parseRfc7231DateTime(response.headers.expires);
					} catch (e) {
						context.logger?.warn(`AWS SDK Warning for ${context.clientName}::${context.commandName} response parsing (${response.headers.expires}): ${e}`);
						delete response.headers.expires;
					}
				}
			}
			return result;
		};
	};
	const s3ExpiresMiddlewareOptions = {
		tags: ["S3"],
		name: "s3ExpiresMiddleware",
		override: true,
		relation: "after",
		toMiddleware: "deserializerMiddleware"
	};
	const getS3ExpiresMiddlewarePlugin = (clientConfig) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(s3ExpiresMiddleware(), s3ExpiresMiddlewareOptions);
	} });
	var S3ExpressIdentityCache = class S3ExpressIdentityCache {
		data;
		lastPurgeTime = Date.now();
		static EXPIRED_CREDENTIAL_PURGE_INTERVAL_MS = 3e4;
		constructor(data = {}) {
			this.data = data;
		}
		get(key) {
			const entry = this.data[key];
			if (!entry) return;
			return entry;
		}
		set(key, entry) {
			this.data[key] = entry;
			return entry;
		}
		delete(key) {
			delete this.data[key];
		}
		async purgeExpired() {
			const now = Date.now();
			if (this.lastPurgeTime + S3ExpressIdentityCache.EXPIRED_CREDENTIAL_PURGE_INTERVAL_MS > now) return;
			for (const key in this.data) {
				const entry = this.data[key];
				if (!entry.isRefreshing) {
					const credential = await entry.identity;
					if (credential.expiration) {
						if (credential.expiration.getTime() < now) delete this.data[key];
					}
				}
			}
		}
	};
	var S3ExpressIdentityCacheEntry = class {
		_identity;
		isRefreshing;
		accessed;
		constructor(_identity, isRefreshing = false, accessed = Date.now()) {
			this._identity = _identity;
			this.isRefreshing = isRefreshing;
			this.accessed = accessed;
		}
		get identity() {
			this.accessed = Date.now();
			return this._identity;
		}
	};
	var S3ExpressIdentityProviderImpl = class S3ExpressIdentityProviderImpl {
		createSessionFn;
		cache;
		static REFRESH_WINDOW_MS = 6e4;
		constructor(createSessionFn, cache = new S3ExpressIdentityCache()) {
			this.createSessionFn = createSessionFn;
			this.cache = cache;
		}
		async getS3ExpressIdentity(awsIdentity, identityProperties) {
			const key = identityProperties.Bucket;
			const { cache } = this;
			const entry = cache.get(key);
			if (entry) return entry.identity.then((identity) => {
				if ((identity.expiration?.getTime() ?? 0) < Date.now()) return cache.set(key, new S3ExpressIdentityCacheEntry(this.getIdentity(key))).identity;
				if ((identity.expiration?.getTime() ?? 0) < Date.now() + S3ExpressIdentityProviderImpl.REFRESH_WINDOW_MS && !entry.isRefreshing) {
					entry.isRefreshing = true;
					this.getIdentity(key).then((id) => {
						cache.set(key, new S3ExpressIdentityCacheEntry(Promise.resolve(id)));
					});
				}
				return identity;
			});
			return cache.set(key, new S3ExpressIdentityCacheEntry(this.getIdentity(key))).identity;
		}
		async getIdentity(key) {
			await this.cache.purgeExpired().catch((error) => {
				console.warn("Error while clearing expired entries in S3ExpressIdentityCache: \n" + error);
			});
			const session = await this.createSessionFn(key);
			if (!session.Credentials?.AccessKeyId || !session.Credentials?.SecretAccessKey) throw new Error("s3#createSession response credential missing AccessKeyId or SecretAccessKey.");
			return {
				accessKeyId: session.Credentials.AccessKeyId,
				secretAccessKey: session.Credentials.SecretAccessKey,
				sessionToken: session.Credentials.SessionToken,
				expiration: session.Credentials.Expiration ? new Date(session.Credentials.Expiration) : void 0
			};
		}
	};
	var SignatureV4S3Express = class extends signatureV4MultiRegion.SignatureV4SignWithCredentials {};
	const S3_EXPRESS_BUCKET_TYPE = "Directory";
	const S3_EXPRESS_BACKEND = "S3Express";
	const S3_EXPRESS_AUTH_SCHEME = "sigv4-s3express";
	const SESSION_TOKEN_HEADER = "X-Amz-S3session-Token".toLowerCase();
	const NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_ENV_NAME = "AWS_S3_DISABLE_EXPRESS_SESSION_AUTH";
	const NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_INI_NAME = "s3_disable_express_session_auth";
	const NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_OPTIONS = {
		environmentVariableSelector: (env) => config.booleanSelector(env, NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_ENV_NAME, config.SelectorType.ENV),
		configFileSelector: (profile) => config.booleanSelector(profile, NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_INI_NAME, config.SelectorType.CONFIG),
		default: false
	};
	const s3ExpressMiddleware = (options) => {
		return (next, context) => async (args) => {
			if (context.endpointV2) {
				const endpoint = context.endpointV2;
				const isS3ExpressAuth = endpoint.properties?.authSchemes?.[0]?.name === S3_EXPRESS_AUTH_SCHEME;
				if (endpoint.properties?.backend === S3_EXPRESS_BACKEND || endpoint.properties?.bucketType === S3_EXPRESS_BUCKET_TYPE) {
					client$1.setFeature(context, "S3_EXPRESS_BUCKET", "J");
					context.isS3ExpressBucket = true;
				}
				if (isS3ExpressAuth) {
					const requestBucket = args.input.Bucket;
					if (requestBucket) {
						const s3ExpressIdentity = await options.s3ExpressIdentityProvider.getS3ExpressIdentity(await options.credentials(), { Bucket: requestBucket });
						context.s3ExpressIdentity = s3ExpressIdentity;
						if (protocols.HttpRequest.isInstance(args.request) && s3ExpressIdentity.sessionToken) args.request.headers[SESSION_TOKEN_HEADER] = s3ExpressIdentity.sessionToken;
					}
				}
			}
			return next(args);
		};
	};
	const s3ExpressMiddlewareOptions = {
		name: "s3ExpressMiddleware",
		step: "build",
		tags: ["S3", "S3_EXPRESS"],
		override: true
	};
	const getS3ExpressPlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.add(s3ExpressMiddleware(options), s3ExpressMiddlewareOptions);
	} });
	const signS3Express = async (s3ExpressIdentity, signingOptions, request, sigV4MultiRegionSigner) => {
		const signedRequest = await sigV4MultiRegionSigner.signWithCredentials(request, s3ExpressIdentity, {});
		if (signedRequest.headers["X-Amz-Security-Token"] || signedRequest.headers["x-amz-security-token"]) throw new Error("X-Amz-Security-Token must not be set for s3-express requests.");
		return signedRequest;
	};
	const defaultErrorHandler = (signingProperties) => (error) => {
		throw error;
	};
	const defaultSuccessHandler = (httpResponse, signingProperties) => {};
	const s3ExpressHttpSigningMiddlewareOptions = core.httpSigningMiddlewareOptions;
	const s3ExpressHttpSigningMiddleware = (config) => (next, context) => async (args) => {
		if (!protocols.HttpRequest.isInstance(args.request)) return next(args);
		const scheme = client.getSmithyContext(context).selectedHttpAuthScheme;
		if (!scheme) throw new Error(`No HttpAuthScheme was selected: unable to sign request`);
		const { httpAuthOption: { signingProperties = {} }, identity, signer } = scheme;
		let request;
		if (context.s3ExpressIdentity) request = await signS3Express(context.s3ExpressIdentity, signingProperties, args.request, await config.signer());
		else request = await signer.sign(args.request, identity, signingProperties);
		const output = await next({
			...args,
			request
		}).catch((signer.errorHandler || defaultErrorHandler)(signingProperties));
		(signer.successHandler || defaultSuccessHandler)(output.response, signingProperties);
		return output;
	};
	const getS3ExpressHttpSigningPlugin = (config) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(s3ExpressHttpSigningMiddleware(config), core.httpSigningMiddlewareOptions);
	} });
	const resolveS3Config = (input, { session }) => {
		const [s3ClientProvider, CreateSessionCommandCtor] = session;
		const { forcePathStyle, useAccelerateEndpoint, disableMultiregionAccessPoints, followRegionRedirects, s3ExpressIdentityProvider, bucketEndpoint, expectContinueHeader } = input;
		return Object.assign(input, {
			forcePathStyle: forcePathStyle ?? false,
			useAccelerateEndpoint: useAccelerateEndpoint ?? false,
			disableMultiregionAccessPoints: disableMultiregionAccessPoints ?? false,
			followRegionRedirects: followRegionRedirects ?? false,
			s3ExpressIdentityProvider: s3ExpressIdentityProvider ?? new S3ExpressIdentityProviderImpl(async (key) => s3ClientProvider().send(new CreateSessionCommandCtor({ Bucket: key }))),
			bucketEndpoint: bucketEndpoint ?? false,
			expectContinueHeader: expectContinueHeader ?? 2097152
		});
	};
	const THROW_IF_EMPTY_BODY = {
		CopyObjectCommand: true,
		UploadPartCopyCommand: true,
		CompleteMultipartUploadCommand: true
	};
	const throw200ExceptionsMiddleware = (config) => (next, context) => async (args) => {
		const result = await next(args);
		const { response } = result;
		if (!protocols.HttpResponse.isInstance(response)) return result;
		const { statusCode, body } = response;
		if (statusCode < 200 || statusCode >= 300) return result;
		const bodyBytes = await collectBody(body, config);
		response.body = toStream.toStream(bodyBytes);
		if (bodyBytes.length === 0 && THROW_IF_EMPTY_BODY[context.commandName]) {
			const err = /* @__PURE__ */ new Error("S3 aborted request");
			err.$metadata = { httpStatusCode: 503 };
			err.name = "InternalError";
			throw err;
		}
		const bodyStringTail = config.utf8Encoder(bodyBytes.subarray(bodyBytes.length - 16));
		if (bodyStringTail && bodyStringTail.endsWith("</Error>")) response.statusCode = 503;
		return result;
	};
	const collectBody = (streamBody = new Uint8Array(), context) => {
		if (streamBody instanceof Uint8Array) return Promise.resolve(streamBody);
		return context.streamCollector(streamBody) || Promise.resolve(new Uint8Array());
	};
	const throw200ExceptionsMiddlewareOptions = {
		relation: "after",
		toMiddleware: "deserializerMiddleware",
		tags: ["THROW_200_EXCEPTIONS", "S3"],
		name: "throw200ExceptionsMiddleware",
		override: true
	};
	const getThrow200ExceptionsPlugin = (config) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(throw200ExceptionsMiddleware(config), throw200ExceptionsMiddlewareOptions);
	} });
	function bucketEndpointMiddleware(options) {
		return (next, context) => async (args) => {
			if (options.bucketEndpoint) {
				const endpoint = context.endpointV2;
				if (endpoint) {
					const bucket = args.input.Bucket;
					if (typeof bucket === "string") try {
						const bucketEndpointUrl = new URL(bucket);
						context.endpointV2 = {
							...endpoint,
							url: bucketEndpointUrl
						};
					} catch (e) {
						const warning = `@aws-sdk/middleware-sdk-s3: bucketEndpoint=true was set but Bucket=${bucket} could not be parsed as URL.`;
						if (context.logger?.constructor?.name === "NoOpLogger") console.warn(warning);
						else context.logger?.warn?.(warning);
						throw e;
					}
				}
			}
			return next(args);
		};
	}
	const bucketEndpointMiddlewareOptions = {
		name: "bucketEndpointMiddleware",
		override: true,
		relation: "after",
		toMiddleware: "endpointV2Middleware"
	};
	function validateBucketNameMiddleware({ bucketEndpoint }) {
		return (next) => async (args) => {
			const { input: { Bucket } } = args;
			if (!bucketEndpoint && typeof Bucket === "string" && !util.validate(Bucket) && Bucket.indexOf("/") >= 0) {
				const err = /* @__PURE__ */ new Error(`Bucket name shouldn't contain '/', received '${Bucket}'`);
				err.name = "InvalidBucketName";
				throw err;
			}
			return next({ ...args });
		};
	}
	const validateBucketNameMiddlewareOptions = {
		step: "initialize",
		tags: ["VALIDATE_BUCKET_NAME"],
		name: "validateBucketNameMiddleware",
		override: true
	};
	const getValidateBucketNamePlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.add(validateBucketNameMiddleware(options), validateBucketNameMiddlewareOptions);
		clientStack.addRelativeTo(bucketEndpointMiddleware(options), bucketEndpointMiddlewareOptions);
	} });
	var S3RestXmlProtocol = class extends protocols$1.AwsRestXmlProtocol {
		async serializeRequest(operationSchema, input, context) {
			const request = await super.serializeRequest(operationSchema, input, context);
			const ns = schema.NormalizedSchema.of(operationSchema.input);
			const staticStructureSchema = ns.getSchema();
			let bucketMemberIndex = 0;
			const requiredMemberCount = staticStructureSchema[6] ?? 0;
			if (input && typeof input === "object") for (const [memberName, memberNs] of ns.structIterator()) {
				if (++bucketMemberIndex > requiredMemberCount) break;
				if (memberName === "Bucket") {
					if (!input.Bucket && memberNs.getMergedTraits().httpLabel) throw new Error(`No value provided for input HTTP label: Bucket.`);
					break;
				}
			}
			return request;
		}
	};
	exports.NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_OPTIONS = NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_OPTIONS;
	exports.S3ExpressIdentityCache = S3ExpressIdentityCache;
	exports.S3ExpressIdentityCacheEntry = S3ExpressIdentityCacheEntry;
	exports.S3ExpressIdentityProviderImpl = S3ExpressIdentityProviderImpl;
	exports.S3RestXmlProtocol = S3RestXmlProtocol;
	exports.SignatureV4S3Express = SignatureV4S3Express;
	exports.checkContentLengthHeader = checkContentLengthHeader;
	exports.checkContentLengthHeaderMiddlewareOptions = checkContentLengthHeaderMiddlewareOptions;
	exports.getCheckContentLengthHeaderPlugin = getCheckContentLengthHeaderPlugin;
	exports.getRegionRedirectMiddlewarePlugin = getRegionRedirectMiddlewarePlugin;
	exports.getS3ExpiresMiddlewarePlugin = getS3ExpiresMiddlewarePlugin;
	exports.getS3ExpressHttpSigningPlugin = getS3ExpressHttpSigningPlugin;
	exports.getS3ExpressPlugin = getS3ExpressPlugin;
	exports.getThrow200ExceptionsPlugin = getThrow200ExceptionsPlugin;
	exports.getValidateBucketNamePlugin = getValidateBucketNamePlugin;
	exports.regionRedirectEndpointMiddleware = regionRedirectEndpointMiddleware;
	exports.regionRedirectEndpointMiddlewareOptions = regionRedirectEndpointMiddlewareOptions;
	exports.regionRedirectMiddleware = regionRedirectMiddleware;
	exports.regionRedirectMiddlewareOptions = regionRedirectMiddlewareOptions;
	exports.resolveS3Config = resolveS3Config;
	exports.s3ExpiresMiddleware = s3ExpiresMiddleware;
	exports.s3ExpiresMiddlewareOptions = s3ExpiresMiddlewareOptions;
	exports.s3ExpressHttpSigningMiddleware = s3ExpressHttpSigningMiddleware;
	exports.s3ExpressHttpSigningMiddlewareOptions = s3ExpressHttpSigningMiddlewareOptions;
	exports.s3ExpressMiddleware = s3ExpressMiddleware;
	exports.s3ExpressMiddlewareOptions = s3ExpressMiddlewareOptions;
	exports.throw200ExceptionsMiddleware = throw200ExceptionsMiddleware;
	exports.throw200ExceptionsMiddlewareOptions = throw200ExceptionsMiddlewareOptions;
	exports.validateBucketNameMiddleware = validateBucketNameMiddleware;
	exports.validateBucketNameMiddlewareOptions = validateBucketNameMiddlewareOptions;
}));
//#endregion
//#region node_modules/@aws-sdk/client-s3/dist-cjs/endpoint/bdd.js
var require_bdd = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.bdd = void 0;
	const endpoints_1 = (init_endpoints(), __toCommonJS(endpoints_exports));
	const aw = "ref", ax = "argv", ay = "backend", az = "authSchemes", aA = "disableDoubleEncoding", aB = "signingName", aC = "signingRegion", aD = "signingRegionSet";
	const a = -1, b = true, c = false, d = "isSet", e = "booleanEquals", f = "stringEquals", g = "coalesce", h = "substring", i = "", j = "aws.partition", k = "partitionResult", l = "accessPointSuffix", m = "regionPrefix", n = (n) => "outpostId_ssa_" + n + i, o = "hardwareType", p = "ite", q = "isValidHostLabel", s = "sigv4", t = "aws.isVirtualHostableS3Bucket", u = "url", v = "getAttr", w = "bucketArn", x = "--", y = "arnType", z = "accesspoint", A = (n) => "accessPointName_ssa_" + n + i, B = "s3-object-lambda", C = "s3-outposts", D = "bucketPartition", E = "us-east-1", F = "outpostType", G = "name", H = "s3", I = "{url#scheme}://{Bucket}.{url#authority}{url#path}", J = "{url#scheme}://{url#authority}{url#path}", K = "{url#scheme}://{url#authority}{url#normalizedPath}{Bucket}", L = "https://{Bucket}.s3-accelerate.{partitionResult#dnsSuffix}", M = "https://{Bucket}.s3.{partitionResult#dnsSuffix}", N = (n) => "{url#scheme}://{accessPointName_ssa_" + n + "}-{bucketArn#accountId}.{url#authority}{url#path}", O = (n) => "Invalid ARN: The access point name may only contain a-z, A-Z, 0-9 and `-`. Found: `{accessPointName_ssa_" + n + "}`", P = "sigv4a", Q = "{url#scheme}://{url#authority}{url#normalizedPath}{uri_encoded_bucket}", R = "https://s3.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", S = "https://s3.{partitionResult#dnsSuffix}", T = { [aw]: "UseFIPS" }, U = { [aw]: "UseDualStack" }, V = { [aw]: "Bucket" }, W = {
		"fn": v,
		[ax]: [{ [aw]: k }, G]
	}, X = { [aw]: u }, Y = { [aw]: "Region" }, Z = { [aw]: w }, aa = { [aw]: y }, ab = { [aw]: "accessPointName_ssa_1" }, ac = {
		"fn": v,
		[ax]: [Z, "region"]
	}, ad = { [aw]: o }, ae = {
		"fn": v,
		[ax]: [Z, "service"]
	}, af = {
		"fn": v,
		[ax]: [Z, "accountId"]
	}, ag = {
		[ay]: "S3Express",
		[az]: [{
			[aA]: true,
			[G]: "{_s3e_auth}",
			[aB]: "s3express",
			[aC]: "{Region}"
		}]
	}, ah = {
		[ay]: "S3Express",
		[az]: [{
			[aA]: true,
			[G]: s,
			[aB]: "s3express",
			[aC]: "{Region}"
		}]
	}, ai = { [az]: [{
		[aA]: true,
		[G]: P,
		[aB]: C,
		[aD]: ["*"]
	}, {
		[aA]: true,
		[G]: s,
		[aB]: C,
		[aC]: "{Region}"
	}] }, aj = { [az]: [{
		[aA]: true,
		[G]: s,
		[aB]: H,
		[aC]: E
	}] }, ak = { [az]: [{
		[aA]: true,
		[G]: s,
		[aB]: H,
		[aC]: "{Region}"
	}] }, al = { [az]: [{
		[aA]: true,
		[G]: s,
		[aB]: B,
		[aC]: "{bucketArn#region}"
	}] }, am = { [az]: [{
		[aA]: true,
		[G]: s,
		[aB]: H,
		[aC]: "{bucketArn#region}"
	}] }, an = { [az]: [{
		[aA]: true,
		[G]: P,
		[aB]: C,
		[aD]: ["*"]
	}, {
		[aA]: true,
		[G]: s,
		[aB]: C,
		[aC]: "{bucketArn#region}"
	}] }, ao = { [az]: [{
		[aA]: true,
		[G]: s,
		[aB]: B,
		[aC]: "{Region}"
	}] }, ap = [Y], aq = [{ [aw]: "Endpoint" }], as = [V], at = [
		V,
		0,
		7,
		true
	], au = [Z, "resourceId[1]"], av = ["*"];
	const _data = {
		conditions: [
			[d, ap],
			[e, [{ [aw]: "Accelerate" }, b]],
			[e, [T, b]],
			[e, [U, b]],
			[d, aq],
			[d, as],
			[f, [{
				fn: g,
				[ax]: [{
					fn: h,
					[ax]: [
						V,
						0,
						6,
						b
					]
				}, i]
			}, "--x-s3"]],
			[f, [{
				fn: g,
				[ax]: [{
					fn: h,
					[ax]: at
				}, i]
			}, "--xa-s3"]],
			[
				j,
				ap,
				k
			],
			[
				h,
				at,
				l
			],
			[f, [{ [aw]: l }, "--op-s3"]],
			[
				h,
				[
					V,
					8,
					12,
					b
				],
				m
			],
			[
				h,
				[
					V,
					32,
					49,
					b
				],
				n(2)
			],
			[
				h,
				[
					V,
					49,
					50,
					b
				],
				o
			],
			[e, [{ [aw]: "ForcePathStyle" }, b]],
			[f, [W, "aws-cn"]],
			[
				p,
				[
					U,
					".dualstack",
					i
				],
				"_s3e_ds"
			],
			[q, [{ [aw]: n(2) }, c]],
			[
				p,
				[
					T,
					"-fips",
					i
				],
				"_s3e_fips"
			],
			[
				p,
				[
					{
						fn: g,
						[ax]: [{ [aw]: "DisableS3ExpressSessionAuth" }, c]
					},
					s,
					"sigv4-s3express"
				],
				"_s3e_auth"
			],
			[t, [V, c]],
			[
				"parseURL",
				aq,
				u
			],
			[e, [{
				fn: g,
				[ax]: [{ [aw]: "UseS3ExpressControlEndpoint" }, c]
			}, b]],
			[t, [V, b]],
			[f, [{
				fn: v,
				[ax]: [X, "scheme"]
			}, "http"]],
			[q, [Y, c]],
			[
				"aws.parseArn",
				as,
				w
			],
			[
				v,
				[{
					fn: "split",
					[ax]: [
						V,
						x,
						0
					]
				}, "[-2]"],
				"s3expressAvailabilityZoneId"
			],
			[f, [{
				fn: g,
				[ax]: [{
					fn: h,
					[ax]: [
						V,
						0,
						4,
						c
					]
				}, i]
			}, "arn:"]],
			[f, [{
				fn: g,
				[ax]: [{
					fn: h,
					[ax]: [
						V,
						16,
						18,
						b
					]
				}, i]
			}, x]],
			[e, [{
				fn: v,
				[ax]: [X, "isIp"]
			}, b]],
			[f, [{
				fn: g,
				[ax]: [{
					fn: h,
					[ax]: [
						V,
						21,
						23,
						b
					]
				}, i]
			}, x]],
			[f, [{
				fn: g,
				[ax]: [{
					fn: h,
					[ax]: [
						V,
						27,
						29,
						b
					]
				}, i]
			}, x]],
			[f, [{ [aw]: m }, "beta"]],
			[
				"uriEncode",
				as,
				"uri_encoded_bucket"
			],
			[q, [Y, b]],
			[e, [{
				fn: g,
				[ax]: [{ [aw]: "UseObjectLambdaEndpoint" }, c]
			}, b]],
			[
				v,
				[Z, "resourceId[0]"],
				y
			],
			[f, [aa, i]],
			[f, [aa, z]],
			[
				v,
				au,
				A(1)
			],
			[f, [ab, i]],
			[f, [ac, i]],
			[f, [{
				fn: g,
				[ax]: [{
					fn: h,
					[ax]: [
						V,
						14,
						16,
						b
					]
				}, i]
			}, x]],
			[f, [ad, "e"]],
			[f, [ad, "o"]],
			[f, [Y, "aws-global"]],
			[f, [{
				fn: g,
				[ax]: [{
					fn: h,
					[ax]: [
						V,
						19,
						21,
						b
					]
				}, i]
			}, x]],
			[f, [ae, B]],
			[e, [{
				fn: g,
				[ax]: [{ [aw]: "DisableAccessPoints" }, c]
			}, b]],
			[f, [ae, C]],
			[
				j,
				[ac],
				D
			],
			[q, [ab, b]],
			[f, [{
				fn: g,
				[ax]: [{
					fn: h,
					[ax]: [
						V,
						26,
						28,
						b
					]
				}, i]
			}, x]],
			[f, [{
				fn: g,
				[ax]: [{
					fn: h,
					[ax]: [
						V,
						15,
						17,
						b
					]
				}, i]
			}, x]],
			[v, [Z, "resourceId[4]"]],
			[f, [{
				fn: g,
				[ax]: [{
					fn: h,
					[ax]: [
						V,
						20,
						22,
						b
					]
				}, i]
			}, x]],
			[e, [{ [aw]: "UseGlobalEndpoint" }, b]],
			[f, [Y, E]],
			[
				v,
				au,
				n(1)
			],
			[e, [{
				fn: g,
				[ax]: [{ [aw]: "UseArnRegion" }, b]
			}, b]],
			[q, [{ [aw]: n(1) }, c]],
			[
				v,
				[Z, "resourceId[2]"],
				F
			],
			[f, [Y, ac]],
			[f, [{
				fn: v,
				[ax]: [{ [aw]: D }, G]
			}, W]],
			[e, [{ [aw]: "DisableMultiRegionAccessPoints" }, b]],
			[q, [ac, b]],
			[f, [{
				fn: v,
				[ax]: [Z, "partition"]
			}, W]],
			[f, [af, i]],
			[f, [ae, H]],
			[q, [af, c]],
			[
				v,
				[Z, "resourceId[3]"],
				A(2)
			],
			[q, [ab, c]],
			[f, [{ [aw]: F }, z]],
			[q, [{ [aw]: A(2) }, c]]
		],
		results: [
			[a],
			[a, "Accelerate cannot be used with FIPS"],
			[a, "Cannot set dual-stack in combination with a custom endpoint."],
			[a, "A custom endpoint cannot be combined with FIPS"],
			[a, "A custom endpoint cannot be combined with S3 Accelerate"],
			[a, "Partition does not support FIPS"],
			[a, "S3Express does not support S3 Accelerate."],
			["{url#scheme}://{url#authority}/{uri_encoded_bucket}{url#path}", ag],
			[I, ag],
			[a, "S3Express bucket name is not a valid virtual hostable name."],
			["https://s3express-control{_s3e_fips}{_s3e_ds}.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", ah],
			["https://{Bucket}.s3express{_s3e_fips}-{s3expressAvailabilityZoneId}{_s3e_ds}.{Region}.{partitionResult#dnsSuffix}", ag],
			[a, "Unrecognized S3Express bucket name format."],
			[J, ag],
			["https://s3express-control{_s3e_fips}{_s3e_ds}.{Region}.{partitionResult#dnsSuffix}", ah],
			[a, "Expected a endpoint to be specified but no endpoint was found"],
			["https://{Bucket}.ec2.{url#authority}", ai],
			["https://{Bucket}.ec2.s3-outposts.{Region}.{partitionResult#dnsSuffix}", ai],
			["https://{Bucket}.op-{outpostId_ssa_2}.{url#authority}", ai],
			["https://{Bucket}.op-{outpostId_ssa_2}.s3-outposts.{Region}.{partitionResult#dnsSuffix}", ai],
			[a, "Unrecognized hardware type: \"Expected hardware type o or e but got {hardwareType}\""],
			[a, "Invalid Outposts Bucket alias - it must be a valid bucket name."],
			[a, "Invalid ARN: The outpost Id must only contain a-z, A-Z, 0-9 and `-`."],
			[a, "Custom endpoint `{Endpoint}` was not a valid URI"],
			[a, "S3 Accelerate cannot be used in this region"],
			["https://{Bucket}.s3-fips.dualstack.us-east-1.{partitionResult#dnsSuffix}", aj],
			["https://{Bucket}.s3-fips.dualstack.{Region}.{partitionResult#dnsSuffix}", ak],
			["https://{Bucket}.s3-fips.us-east-1.{partitionResult#dnsSuffix}", aj],
			["https://{Bucket}.s3-fips.{Region}.{partitionResult#dnsSuffix}", ak],
			["https://{Bucket}.s3-accelerate.dualstack.us-east-1.{partitionResult#dnsSuffix}", aj],
			["https://{Bucket}.s3-accelerate.dualstack.{partitionResult#dnsSuffix}", ak],
			["https://{Bucket}.s3.dualstack.us-east-1.{partitionResult#dnsSuffix}", aj],
			["https://{Bucket}.s3.dualstack.{Region}.{partitionResult#dnsSuffix}", ak],
			[K, aj],
			[I, aj],
			[K, ak],
			[I, ak],
			[L, aj],
			[L, ak],
			[M, aj],
			[M, ak],
			["https://{Bucket}.s3.{Region}.{partitionResult#dnsSuffix}", ak],
			[a, "Invalid region: region was not a valid DNS name."],
			[a, "S3 Object Lambda does not support Dual-stack"],
			[a, "S3 Object Lambda does not support S3 Accelerate"],
			[a, "Access points are not supported for this operation"],
			[a, "Invalid configuration: region from ARN `{bucketArn#region}` does not match client region `{Region}` and UseArnRegion is `false`"],
			[a, "Invalid ARN: Missing account id"],
			[N(1), al],
			["https://{accessPointName_ssa_1}-{bucketArn#accountId}.s3-object-lambda-fips.{bucketArn#region}.{bucketPartition#dnsSuffix}", al],
			["https://{accessPointName_ssa_1}-{bucketArn#accountId}.s3-object-lambda.{bucketArn#region}.{bucketPartition#dnsSuffix}", al],
			[a, O(1)],
			[a, "Invalid ARN: The account id may only contain a-z, A-Z, 0-9 and `-`. Found: `{bucketArn#accountId}`"],
			[a, "Invalid region in ARN: `{bucketArn#region}` (invalid DNS name)"],
			[a, "Client was configured for partition `{partitionResult#name}` but ARN (`{Bucket}`) has `{bucketPartition#name}`"],
			[a, "Invalid ARN: The ARN may only contain a single resource component after `accesspoint`."],
			[a, "Invalid ARN: bucket ARN is missing a region"],
			[a, "Invalid ARN: Expected a resource of the format `accesspoint:<accesspoint name>` but no name was provided"],
			[a, "Invalid ARN: Object Lambda ARNs only support `accesspoint` arn types, but found: `{arnType}`"],
			[a, "Access Points do not support S3 Accelerate"],
			["https://{accessPointName_ssa_1}-{bucketArn#accountId}.s3-accesspoint-fips.dualstack.{bucketArn#region}.{bucketPartition#dnsSuffix}", am],
			["https://{accessPointName_ssa_1}-{bucketArn#accountId}.s3-accesspoint-fips.{bucketArn#region}.{bucketPartition#dnsSuffix}", am],
			["https://{accessPointName_ssa_1}-{bucketArn#accountId}.s3-accesspoint.dualstack.{bucketArn#region}.{bucketPartition#dnsSuffix}", am],
			[N(1), am],
			["https://{accessPointName_ssa_1}-{bucketArn#accountId}.s3-accesspoint.{bucketArn#region}.{bucketPartition#dnsSuffix}", am],
			[a, "Invalid ARN: The ARN was not for the S3 service, found: {bucketArn#service}"],
			[a, "S3 MRAP does not support dual-stack"],
			[a, "S3 MRAP does not support FIPS"],
			[a, "S3 MRAP does not support S3 Accelerate"],
			[a, "Invalid configuration: Multi-Region Access Point ARNs are disabled."],
			["https://{accessPointName_ssa_1}.accesspoint.s3-global.{partitionResult#dnsSuffix}", { [az]: [{
				[aA]: b,
				name: P,
				[aB]: H,
				[aD]: av
			}] }],
			[a, "Client was configured for partition `{partitionResult#name}` but bucket referred to partition `{bucketArn#partition}`"],
			[a, "Invalid Access Point Name"],
			[a, "S3 Outposts does not support Dual-stack"],
			[a, "S3 Outposts does not support FIPS"],
			[a, "S3 Outposts does not support S3 Accelerate"],
			[a, "Invalid Arn: Outpost Access Point ARN contains sub resources"],
			["https://{accessPointName_ssa_2}-{bucketArn#accountId}.{outpostId_ssa_1}.{url#authority}", an],
			["https://{accessPointName_ssa_2}-{bucketArn#accountId}.{outpostId_ssa_1}.s3-outposts.{bucketArn#region}.{bucketPartition#dnsSuffix}", an],
			[a, O(2)],
			[a, "Expected an outpost type `accesspoint`, found {outpostType}"],
			[a, "Invalid ARN: expected an access point name"],
			[a, "Invalid ARN: Expected a 4-component resource"],
			[a, "Invalid ARN: The outpost Id may only contain a-z, A-Z, 0-9 and `-`. Found: `{outpostId_ssa_1}`"],
			[a, "Invalid ARN: The Outpost Id was not set"],
			[a, "Invalid ARN: Unrecognized format: {Bucket} (type: {arnType})"],
			[a, "Invalid ARN: No ARN type specified"],
			[a, "Invalid ARN: `{Bucket}` was not a valid ARN"],
			[a, "Path-style addressing cannot be used with ARN buckets"],
			["https://s3-fips.dualstack.us-east-1.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", aj],
			["https://s3-fips.dualstack.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", ak],
			["https://s3-fips.us-east-1.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", aj],
			["https://s3-fips.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", ak],
			["https://s3.dualstack.us-east-1.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", aj],
			["https://s3.dualstack.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", ak],
			[Q, aj],
			[Q, ak],
			[R, aj],
			[R, ak],
			["https://s3.{Region}.{partitionResult#dnsSuffix}/{uri_encoded_bucket}", ak],
			[a, "Path-style addressing cannot be used with S3 Accelerate"],
			[J, ao],
			["https://s3-object-lambda-fips.{Region}.{partitionResult#dnsSuffix}", ao],
			["https://s3-object-lambda.{Region}.{partitionResult#dnsSuffix}", ao],
			["https://s3-fips.dualstack.us-east-1.{partitionResult#dnsSuffix}", aj],
			["https://s3-fips.dualstack.{Region}.{partitionResult#dnsSuffix}", ak],
			["https://s3-fips.us-east-1.{partitionResult#dnsSuffix}", aj],
			["https://s3-fips.{Region}.{partitionResult#dnsSuffix}", ak],
			["https://s3.dualstack.us-east-1.{partitionResult#dnsSuffix}", aj],
			["https://s3.dualstack.{Region}.{partitionResult#dnsSuffix}", ak],
			[J, aj],
			[J, ak],
			[S, aj],
			[S, ak],
			["https://s3.{Region}.{partitionResult#dnsSuffix}", ak],
			[a, "A region must be set when sending requests to S3."]
		]
	};
	const root = 2;
	const nodes = new Int32Array([
		-1,
		1,
		-1,
		0,
		3,
		100000115,
		1,
		424,
		4,
		2,
		272,
		5,
		3,
		233,
		6,
		4,
		85,
		7,
		5,
		15,
		8,
		8,
		9,
		100000115,
		16,
		10,
		13,
		18,
		11,
		13,
		19,
		12,
		13,
		22,
		100000014,
		13,
		35,
		14,
		100000042,
		36,
		100000103,
		435,
		6,
		271,
		16,
		7,
		270,
		17,
		8,
		19,
		18,
		14,
		501,
		106,
		9,
		20,
		24,
		10,
		21,
		24,
		11,
		22,
		24,
		12,
		23,
		24,
		13,
		547,
		24,
		14,
		77,
		25,
		20,
		73,
		26,
		26,
		27,
		78,
		37,
		28,
		100000086,
		38,
		100000086,
		29,
		39,
		47,
		30,
		48,
		100000058,
		31,
		50,
		32,
		100000085,
		51,
		33,
		136,
		55,
		100000076,
		34,
		59,
		35,
		100000084,
		60,
		39,
		36,
		61,
		37,
		100000083,
		62,
		38,
		146,
		63,
		41,
		100000046,
		61,
		40,
		100000083,
		62,
		41,
		150,
		64,
		42,
		100000054,
		66,
		43,
		100000053,
		70,
		44,
		100000052,
		71,
		45,
		100000081,
		73,
		46,
		100000080,
		74,
		100000078,
		100000079,
		40,
		48,
		100000057,
		41,
		100000057,
		49,
		42,
		185,
		50,
		48,
		62,
		51,
		49,
		100000045,
		52,
		51,
		53,
		526,
		60,
		56,
		54,
		62,
		100000055,
		55,
		63,
		57,
		100000046,
		62,
		100000055,
		57,
		64,
		58,
		100000054,
		66,
		59,
		100000053,
		69,
		60,
		100000065,
		70,
		61,
		100000052,
		72,
		100000064,
		100000051,
		49,
		100000045,
		63,
		51,
		64,
		526,
		60,
		67,
		65,
		62,
		100000055,
		66,
		63,
		68,
		100000046,
		62,
		100000055,
		68,
		64,
		69,
		100000054,
		66,
		70,
		100000053,
		68,
		100000047,
		71,
		70,
		72,
		100000052,
		72,
		100000050,
		100000051,
		25,
		74,
		100000042,
		46,
		100000039,
		75,
		57,
		76,
		100000041,
		58,
		100000040,
		100000041,
		26,
		100000088,
		78,
		28,
		100000087,
		79,
		34,
		82,
		80,
		35,
		81,
		545,
		36,
		100000103,
		100000115,
		46,
		100000097,
		83,
		57,
		84,
		100000099,
		58,
		100000098,
		100000099,
		5,
		101,
		86,
		8,
		87,
		100000115,
		16,
		88,
		89,
		18,
		91,
		89,
		19,
		90,
		92,
		21,
		97,
		95,
		19,
		93,
		92,
		21,
		98,
		95,
		21,
		97,
		94,
		22,
		100000014,
		95,
		35,
		96,
		100000042,
		36,
		100000103,
		100000042,
		22,
		100000013,
		98,
		35,
		99,
		100000042,
		36,
		100000101,
		100,
		46,
		100000110,
		100000111,
		6,
		214,
		102,
		7,
		208,
		103,
		8,
		119,
		104,
		14,
		118,
		105,
		21,
		106,
		100000023,
		26,
		107,
		502,
		37,
		108,
		100000086,
		38,
		100000086,
		109,
		39,
		112,
		110,
		48,
		100000058,
		111,
		50,
		136,
		100000085,
		40,
		113,
		100000057,
		41,
		100000057,
		114,
		42,
		115,
		500,
		48,
		100000056,
		116,
		52,
		117,
		100000072,
		65,
		100000069,
		100000072,
		21,
		501,
		100000023,
		9,
		120,
		124,
		10,
		121,
		124,
		11,
		122,
		124,
		12,
		123,
		124,
		13,
		202,
		124,
		14,
		195,
		125,
		20,
		190,
		126,
		21,
		127,
		100000023,
		23,
		128,
		129,
		24,
		189,
		129,
		26,
		130,
		197,
		37,
		131,
		100000086,
		38,
		100000086,
		132,
		39,
		159,
		133,
		48,
		100000058,
		134,
		50,
		135,
		100000085,
		51,
		141,
		136,
		55,
		100000076,
		137,
		59,
		138,
		100000084,
		60,
		100000083,
		139,
		61,
		140,
		100000083,
		63,
		100000083,
		100000046,
		55,
		100000076,
		142,
		59,
		143,
		100000084,
		60,
		148,
		144,
		61,
		145,
		100000083,
		62,
		147,
		146,
		63,
		150,
		100000046,
		63,
		153,
		100000046,
		61,
		149,
		100000083,
		62,
		153,
		150,
		64,
		151,
		100000054,
		66,
		152,
		100000053,
		70,
		100000082,
		100000052,
		64,
		154,
		100000054,
		66,
		155,
		100000053,
		70,
		156,
		100000052,
		71,
		157,
		100000081,
		73,
		158,
		100000080,
		74,
		100000077,
		100000079,
		40,
		160,
		100000057,
		41,
		100000057,
		161,
		42,
		185,
		162,
		48,
		174,
		163,
		49,
		100000045,
		164,
		51,
		165,
		526,
		60,
		168,
		166,
		62,
		100000055,
		167,
		63,
		169,
		100000046,
		62,
		100000055,
		169,
		64,
		170,
		100000054,
		66,
		171,
		100000053,
		69,
		172,
		100000065,
		70,
		173,
		100000052,
		72,
		100000063,
		100000051,
		49,
		100000045,
		175,
		51,
		176,
		526,
		60,
		179,
		177,
		62,
		100000055,
		178,
		63,
		180,
		100000046,
		62,
		100000055,
		180,
		64,
		181,
		100000054,
		66,
		182,
		100000053,
		68,
		100000047,
		183,
		70,
		184,
		100000052,
		72,
		100000048,
		100000051,
		48,
		100000056,
		186,
		52,
		187,
		100000072,
		65,
		100000069,
		188,
		67,
		100000070,
		100000071,
		25,
		100000036,
		100000042,
		21,
		191,
		100000023,
		25,
		192,
		100000042,
		30,
		194,
		193,
		46,
		100000034,
		100000036,
		46,
		100000033,
		100000035,
		21,
		196,
		100000023,
		26,
		100000088,
		197,
		28,
		100000087,
		198,
		34,
		201,
		199,
		35,
		200,
		545,
		36,
		100000101,
		100000115,
		46,
		100000095,
		100000096,
		17,
		203,
		100000022,
		20,
		204,
		100000021,
		21,
		205,
		550,
		33,
		206,
		550,
		44,
		100000016,
		207,
		45,
		100000018,
		100000020,
		8,
		209,
		215,
		16,
		210,
		220,
		18,
		211,
		220,
		19,
		212,
		224,
		20,
		213,
		227,
		21,
		231,
		401,
		8,
		218,
		215,
		19,
		216,
		100000009,
		20,
		217,
		227,
		21,
		231,
		100000009,
		16,
		219,
		220,
		18,
		223,
		220,
		19,
		221,
		224,
		20,
		222,
		227,
		21,
		231,
		100000012,
		19,
		226,
		224,
		20,
		225,
		100000009,
		21,
		100000009,
		100000012,
		20,
		230,
		227,
		21,
		228,
		100000009,
		30,
		229,
		100000009,
		34,
		100000007,
		100000009,
		21,
		231,
		415,
		30,
		232,
		100000008,
		34,
		100000007,
		100000008,
		4,
		100000002,
		234,
		5,
		235,
		480,
		6,
		271,
		236,
		7,
		270,
		237,
		8,
		238,
		491,
		9,
		239,
		243,
		10,
		240,
		243,
		11,
		241,
		243,
		12,
		242,
		243,
		13,
		547,
		243,
		14,
		266,
		244,
		20,
		264,
		245,
		26,
		246,
		267,
		37,
		247,
		100000086,
		38,
		100000086,
		248,
		39,
		249,
		518,
		40,
		250,
		100000057,
		41,
		100000057,
		251,
		42,
		538,
		252,
		48,
		100000043,
		253,
		49,
		100000045,
		254,
		51,
		255,
		526,
		60,
		258,
		256,
		62,
		100000055,
		257,
		63,
		259,
		100000046,
		62,
		100000055,
		259,
		64,
		260,
		100000054,
		66,
		261,
		100000053,
		69,
		262,
		100000065,
		70,
		263,
		100000052,
		72,
		100000062,
		100000051,
		25,
		265,
		100000042,
		46,
		100000031,
		100000032,
		26,
		100000088,
		267,
		28,
		100000087,
		268,
		34,
		269,
		544,
		46,
		100000093,
		100000094,
		8,
		397,
		100000009,
		8,
		407,
		100000009,
		3,
		346,
		273,
		4,
		100000003,
		274,
		5,
		284,
		275,
		8,
		276,
		100000115,
		15,
		100000005,
		277,
		16,
		278,
		281,
		18,
		279,
		281,
		19,
		280,
		281,
		22,
		100000014,
		281,
		35,
		282,
		100000042,
		36,
		100000102,
		283,
		46,
		100000106,
		100000107,
		6,
		405,
		285,
		7,
		395,
		286,
		8,
		295,
		287,
		14,
		501,
		288,
		26,
		289,
		502,
		37,
		290,
		100000086,
		38,
		100000086,
		291,
		39,
		292,
		307,
		40,
		293,
		100000057,
		41,
		100000057,
		294,
		42,
		335,
		500,
		9,
		296,
		300,
		10,
		297,
		300,
		11,
		298,
		300,
		12,
		299,
		300,
		13,
		394,
		300,
		14,
		339,
		301,
		15,
		100000005,
		302,
		20,
		337,
		303,
		26,
		304,
		341,
		37,
		305,
		100000086,
		38,
		100000086,
		306,
		39,
		309,
		307,
		48,
		100000058,
		308,
		50,
		100000074,
		100000085,
		40,
		310,
		100000057,
		41,
		100000057,
		311,
		42,
		335,
		312,
		48,
		324,
		313,
		49,
		100000045,
		314,
		51,
		315,
		526,
		60,
		318,
		316,
		62,
		100000055,
		317,
		63,
		319,
		100000046,
		62,
		100000055,
		319,
		64,
		320,
		100000054,
		66,
		321,
		100000053,
		69,
		322,
		100000065,
		70,
		323,
		100000052,
		72,
		100000061,
		100000051,
		49,
		100000045,
		325,
		51,
		326,
		526,
		60,
		329,
		327,
		62,
		100000055,
		328,
		63,
		330,
		100000046,
		62,
		100000055,
		330,
		64,
		331,
		100000054,
		66,
		332,
		100000053,
		68,
		100000047,
		333,
		70,
		334,
		100000052,
		72,
		100000049,
		100000051,
		48,
		100000056,
		336,
		52,
		100000067,
		100000072,
		25,
		338,
		100000042,
		46,
		100000027,
		100000028,
		15,
		100000005,
		340,
		26,
		100000088,
		341,
		28,
		100000087,
		342,
		34,
		345,
		343,
		35,
		344,
		545,
		36,
		100000102,
		100000115,
		46,
		100000091,
		100000092,
		4,
		100000002,
		347,
		5,
		357,
		348,
		8,
		349,
		100000115,
		15,
		100000005,
		350,
		16,
		351,
		354,
		18,
		352,
		354,
		19,
		353,
		354,
		22,
		100000014,
		354,
		35,
		355,
		100000042,
		36,
		100000043,
		356,
		46,
		100000104,
		100000105,
		6,
		405,
		358,
		7,
		395,
		359,
		8,
		360,
		491,
		9,
		361,
		365,
		10,
		362,
		365,
		11,
		363,
		365,
		12,
		364,
		365,
		13,
		394,
		365,
		14,
		389,
		366,
		15,
		100000005,
		367,
		20,
		387,
		368,
		26,
		369,
		391,
		37,
		370,
		100000086,
		38,
		100000086,
		371,
		39,
		372,
		518,
		40,
		373,
		100000057,
		41,
		100000057,
		374,
		42,
		538,
		375,
		48,
		100000043,
		376,
		49,
		100000045,
		377,
		51,
		378,
		526,
		60,
		381,
		379,
		62,
		100000055,
		380,
		63,
		382,
		100000046,
		62,
		100000055,
		382,
		64,
		383,
		100000054,
		66,
		384,
		100000053,
		69,
		385,
		100000065,
		70,
		386,
		100000052,
		72,
		100000060,
		100000051,
		25,
		388,
		100000042,
		46,
		100000025,
		100000026,
		15,
		100000005,
		390,
		26,
		100000088,
		391,
		28,
		100000087,
		392,
		34,
		393,
		544,
		46,
		100000089,
		100000090,
		15,
		100000005,
		547,
		8,
		396,
		100000009,
		15,
		100000005,
		397,
		16,
		398,
		410,
		18,
		399,
		410,
		19,
		400,
		410,
		20,
		401,
		100000009,
		27,
		402,
		100000012,
		29,
		100000011,
		403,
		31,
		100000011,
		404,
		32,
		100000011,
		422,
		8,
		406,
		100000009,
		15,
		100000005,
		407,
		16,
		408,
		410,
		18,
		409,
		410,
		19,
		411,
		410,
		20,
		100000012,
		100000009,
		20,
		414,
		412,
		22,
		413,
		100000009,
		34,
		100000010,
		100000009,
		22,
		416,
		415,
		27,
		419,
		100000012,
		27,
		418,
		417,
		34,
		100000010,
		100000012,
		34,
		100000010,
		419,
		43,
		100000011,
		420,
		47,
		100000011,
		421,
		53,
		100000011,
		422,
		54,
		100000011,
		423,
		56,
		100000011,
		100000012,
		2,
		100000001,
		425,
		3,
		478,
		426,
		4,
		100000004,
		427,
		5,
		438,
		428,
		8,
		429,
		100000115,
		16,
		430,
		433,
		18,
		431,
		433,
		19,
		432,
		433,
		22,
		100000014,
		433,
		35,
		434,
		100000042,
		36,
		100000044,
		435,
		46,
		100000112,
		436,
		57,
		437,
		100000114,
		58,
		100000113,
		100000114,
		6,
		100000006,
		439,
		7,
		100000006,
		440,
		8,
		450,
		441,
		14,
		501,
		442,
		26,
		443,
		502,
		37,
		444,
		100000086,
		38,
		100000086,
		445,
		39,
		446,
		465,
		40,
		447,
		100000057,
		41,
		100000057,
		448,
		42,
		471,
		449,
		48,
		100000044,
		500,
		9,
		451,
		455,
		10,
		452,
		455,
		11,
		453,
		455,
		12,
		454,
		455,
		13,
		547,
		455,
		14,
		473,
		456,
		15,
		460,
		457,
		20,
		458,
		461,
		25,
		459,
		100000042,
		46,
		100000037,
		100000038,
		20,
		540,
		461,
		26,
		462,
		474,
		37,
		463,
		100000086,
		38,
		100000086,
		464,
		39,
		467,
		465,
		48,
		100000058,
		466,
		50,
		100000075,
		100000085,
		40,
		468,
		100000057,
		41,
		100000057,
		469,
		42,
		471,
		470,
		48,
		100000044,
		524,
		48,
		100000044,
		472,
		52,
		100000068,
		100000072,
		26,
		100000088,
		474,
		28,
		100000087,
		475,
		34,
		100000100,
		476,
		35,
		477,
		545,
		36,
		100000044,
		100000115,
		4,
		100000002,
		479,
		5,
		488,
		480,
		8,
		481,
		100000115,
		16,
		482,
		485,
		18,
		483,
		485,
		19,
		484,
		485,
		22,
		100000014,
		485,
		35,
		486,
		100000042,
		36,
		100000043,
		487,
		46,
		100000108,
		100000109,
		6,
		100000006,
		489,
		7,
		100000006,
		490,
		8,
		503,
		491,
		14,
		501,
		492,
		26,
		493,
		502,
		37,
		494,
		100000086,
		38,
		100000086,
		495,
		39,
		496,
		518,
		40,
		497,
		100000057,
		41,
		100000057,
		498,
		42,
		538,
		499,
		48,
		100000043,
		500,
		49,
		100000045,
		526,
		26,
		100000088,
		502,
		28,
		100000087,
		100000115,
		9,
		504,
		508,
		10,
		505,
		508,
		11,
		506,
		508,
		12,
		507,
		508,
		13,
		547,
		508,
		14,
		541,
		509,
		15,
		513,
		510,
		20,
		511,
		514,
		25,
		512,
		100000042,
		46,
		100000029,
		100000030,
		20,
		540,
		514,
		26,
		515,
		542,
		37,
		516,
		100000086,
		38,
		100000086,
		517,
		39,
		520,
		518,
		48,
		100000058,
		519,
		50,
		100000073,
		100000085,
		40,
		521,
		100000057,
		41,
		100000057,
		522,
		42,
		538,
		523,
		48,
		100000043,
		524,
		49,
		100000045,
		525,
		51,
		529,
		526,
		60,
		100000055,
		527,
		62,
		100000055,
		528,
		63,
		100000055,
		100000046,
		60,
		532,
		530,
		62,
		100000055,
		531,
		63,
		533,
		100000046,
		62,
		100000055,
		533,
		64,
		534,
		100000054,
		66,
		535,
		100000053,
		69,
		536,
		100000065,
		70,
		537,
		100000052,
		72,
		100000059,
		100000051,
		48,
		100000043,
		539,
		52,
		100000066,
		100000072,
		25,
		100000024,
		100000042,
		26,
		100000088,
		542,
		28,
		100000087,
		543,
		34,
		100000100,
		544,
		35,
		546,
		545,
		36,
		100000042,
		100000115,
		36,
		100000043,
		100000115,
		17,
		548,
		100000022,
		20,
		549,
		100000021,
		33,
		552,
		550,
		44,
		100000017,
		551,
		45,
		100000019,
		100000020,
		44,
		100000015,
		553,
		45,
		100000015,
		100000020
	]);
	exports.bdd = endpoints_1.BinaryDecisionDiagram.from(nodes, root, _data.conditions, _data.results);
}));
//#endregion
//#region node_modules/@aws-sdk/client-s3/dist-cjs/endpoint/endpointResolver.js
var require_endpointResolver = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.defaultEndpointResolver = void 0;
	const client_1 = (init_client(), __toCommonJS(client_exports));
	const endpoints_1 = (init_endpoints(), __toCommonJS(endpoints_exports));
	const bdd_1 = require_bdd();
	const cache = new endpoints_1.EndpointCache({
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
	});
	const defaultEndpointResolver = (endpointParams, context = {}) => {
		return cache.get(endpointParams, () => (0, endpoints_1.decideEndpoint)(bdd_1.bdd, {
			endpointParams,
			logger: context.logger
		}));
	};
	exports.defaultEndpointResolver = defaultEndpointResolver;
	endpoints_1.customEndpointFunctions.aws = client_1.awsEndpointFunctions;
}));
//#endregion
//#region node_modules/@aws-sdk/client-s3/dist-cjs/auth/httpAuthSchemeProvider.js
var require_httpAuthSchemeProvider = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.resolveHttpAuthSchemeConfig = exports.defaultS3HttpAuthSchemeProvider = exports.defaultS3HttpAuthSchemeParametersProvider = void 0;
	const httpAuthSchemes_1 = (init_httpAuthSchemes(), __toCommonJS(httpAuthSchemes_exports));
	const signature_v4_multi_region_1 = require_dist_cjs$10();
	const client_1 = (init_client$1(), __toCommonJS(client_exports$1));
	const endpoints_1 = (init_endpoints(), __toCommonJS(endpoints_exports));
	const endpointResolver_1 = require_endpointResolver();
	const createEndpointRuleSetHttpAuthSchemeParametersProvider = (defaultHttpAuthSchemeParametersProvider) => async (config, context, input) => {
		if (!input) throw new Error("Could not find `input` for `defaultEndpointRuleSetHttpAuthSchemeParametersProvider`");
		const defaultParameters = await defaultHttpAuthSchemeParametersProvider(config, context, input);
		const instructionsFn = (0, client_1.getSmithyContext)(context)?.commandInstance?.constructor?.getEndpointParameterInstructions;
		if (!instructionsFn) throw new Error(`getEndpointParameterInstructions() is not defined on '${context.commandName}'`);
		const endpointParameters = await (0, endpoints_1.resolveParams)(input, { getEndpointParameterInstructions: instructionsFn }, config);
		return Object.assign(defaultParameters, endpointParameters);
	};
	const _defaultS3HttpAuthSchemeParametersProvider = async (config, context, input) => {
		return {
			operation: (0, client_1.getSmithyContext)(context).operation,
			region: await (0, client_1.normalizeProvider)(config.region)() || (() => {
				throw new Error("expected `region` to be configured for `aws.auth#sigv4`");
			})()
		};
	};
	exports.defaultS3HttpAuthSchemeParametersProvider = createEndpointRuleSetHttpAuthSchemeParametersProvider(_defaultS3HttpAuthSchemeParametersProvider);
	function createAwsAuthSigv4HttpAuthOption(authParameters) {
		return {
			schemeId: "aws.auth#sigv4",
			signingProperties: {
				name: "s3",
				region: authParameters.region
			},
			propertiesExtractor: (config, context) => ({ signingProperties: {
				config,
				context
			} })
		};
	}
	function createAwsAuthSigv4aHttpAuthOption(authParameters) {
		return {
			schemeId: "aws.auth#sigv4a",
			signingProperties: {
				name: "s3",
				region: authParameters.region
			},
			propertiesExtractor: (config, context) => ({ signingProperties: {
				config,
				context
			} })
		};
	}
	const createEndpointRuleSetHttpAuthSchemeProvider = (defaultEndpointResolver, defaultHttpAuthSchemeResolver, createHttpAuthOptionFunctions) => {
		const endpointRuleSetHttpAuthSchemeProvider = (authParameters) => {
			const authSchemes = defaultEndpointResolver(authParameters).properties?.authSchemes;
			if (!authSchemes) return defaultHttpAuthSchemeResolver(authParameters);
			const options = [];
			for (const scheme of authSchemes) {
				const { name: resolvedName, properties = {}, ...rest } = scheme;
				const name = resolvedName.toLowerCase();
				if (resolvedName !== name) console.warn(`HttpAuthScheme has been normalized with lowercasing: '${resolvedName}' to '${name}'`);
				let schemeId;
				if (name === "sigv4a") {
					schemeId = "aws.auth#sigv4a";
					const sigv4Present = authSchemes.find((s) => {
						const name = s.name.toLowerCase();
						return name !== "sigv4a" && name.startsWith("sigv4");
					});
					if (signature_v4_multi_region_1.SignatureV4MultiRegion.sigv4aDependency() === "none" && sigv4Present) continue;
				} else if (name.startsWith("sigv4")) schemeId = "aws.auth#sigv4";
				else throw new Error(`Unknown HttpAuthScheme found in '@smithy.rules#endpointRuleSet': '${name}'`);
				const createOption = createHttpAuthOptionFunctions[schemeId];
				if (!createOption) throw new Error(`Could not find HttpAuthOption create function for '${schemeId}'`);
				const option = createOption(authParameters);
				option.schemeId = schemeId;
				option.signingProperties = {
					...option.signingProperties || {},
					...rest,
					...properties
				};
				options.push(option);
			}
			return options;
		};
		return endpointRuleSetHttpAuthSchemeProvider;
	};
	const _defaultS3HttpAuthSchemeProvider = (authParameters) => {
		const options = [];
		switch (authParameters.operation) {
			default:
				options.push(createAwsAuthSigv4HttpAuthOption(authParameters));
				options.push(createAwsAuthSigv4aHttpAuthOption(authParameters));
		}
		return options;
	};
	exports.defaultS3HttpAuthSchemeProvider = createEndpointRuleSetHttpAuthSchemeProvider(endpointResolver_1.defaultEndpointResolver, _defaultS3HttpAuthSchemeProvider, {
		"aws.auth#sigv4": createAwsAuthSigv4HttpAuthOption,
		"aws.auth#sigv4a": createAwsAuthSigv4aHttpAuthOption
	});
	const resolveHttpAuthSchemeConfig = (config) => {
		const config_0 = (0, httpAuthSchemes_1.resolveAwsSdkSigV4Config)(config);
		const config_1 = (0, httpAuthSchemes_1.resolveAwsSdkSigV4AConfig)(config_0);
		return Object.assign(config_1, { authSchemePreference: (0, client_1.normalizeProvider)(config.authSchemePreference ?? []) });
	};
	exports.resolveHttpAuthSchemeConfig = resolveHttpAuthSchemeConfig;
}));
//#endregion
//#region node_modules/@aws-sdk/client-s3/dist-cjs/models/S3ServiceException.js
var require_S3ServiceException = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.S3ServiceException = exports.__ServiceException = void 0;
	const client_1 = (init_client$1(), __toCommonJS(client_exports$1));
	Object.defineProperty(exports, "__ServiceException", {
		enumerable: true,
		get: function() {
			return client_1.ServiceException;
		}
	});
	exports.S3ServiceException = class S3ServiceException extends client_1.ServiceException {
		constructor(options) {
			super(options);
			Object.setPrototypeOf(this, S3ServiceException.prototype);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/client-s3/dist-cjs/models/errors.js
var require_errors = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ObjectAlreadyInActiveTierError = exports.IdempotencyParameterMismatch = exports.TooManyParts = exports.InvalidWriteOffset = exports.InvalidRequest = exports.EncryptionTypeMismatch = exports.NotFound = exports.NoSuchKey = exports.InvalidObjectState = exports.NoSuchBucket = exports.BucketAlreadyOwnedByYou = exports.BucketAlreadyExists = exports.ObjectNotInActiveTierError = exports.AccessDenied = exports.NoSuchUpload = void 0;
	const S3ServiceException_1 = require_S3ServiceException();
	exports.NoSuchUpload = class NoSuchUpload extends S3ServiceException_1.S3ServiceException {
		name = "NoSuchUpload";
		$fault = "client";
		constructor(opts) {
			super({
				name: "NoSuchUpload",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, NoSuchUpload.prototype);
		}
	};
	exports.AccessDenied = class AccessDenied extends S3ServiceException_1.S3ServiceException {
		name = "AccessDenied";
		$fault = "client";
		constructor(opts) {
			super({
				name: "AccessDenied",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, AccessDenied.prototype);
		}
	};
	exports.ObjectNotInActiveTierError = class ObjectNotInActiveTierError extends S3ServiceException_1.S3ServiceException {
		name = "ObjectNotInActiveTierError";
		$fault = "client";
		constructor(opts) {
			super({
				name: "ObjectNotInActiveTierError",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, ObjectNotInActiveTierError.prototype);
		}
	};
	exports.BucketAlreadyExists = class BucketAlreadyExists extends S3ServiceException_1.S3ServiceException {
		name = "BucketAlreadyExists";
		$fault = "client";
		constructor(opts) {
			super({
				name: "BucketAlreadyExists",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, BucketAlreadyExists.prototype);
		}
	};
	exports.BucketAlreadyOwnedByYou = class BucketAlreadyOwnedByYou extends S3ServiceException_1.S3ServiceException {
		name = "BucketAlreadyOwnedByYou";
		$fault = "client";
		constructor(opts) {
			super({
				name: "BucketAlreadyOwnedByYou",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, BucketAlreadyOwnedByYou.prototype);
		}
	};
	exports.NoSuchBucket = class NoSuchBucket extends S3ServiceException_1.S3ServiceException {
		name = "NoSuchBucket";
		$fault = "client";
		constructor(opts) {
			super({
				name: "NoSuchBucket",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, NoSuchBucket.prototype);
		}
	};
	exports.InvalidObjectState = class InvalidObjectState extends S3ServiceException_1.S3ServiceException {
		name = "InvalidObjectState";
		$fault = "client";
		StorageClass;
		AccessTier;
		constructor(opts) {
			super({
				name: "InvalidObjectState",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, InvalidObjectState.prototype);
			this.StorageClass = opts.StorageClass;
			this.AccessTier = opts.AccessTier;
		}
	};
	exports.NoSuchKey = class NoSuchKey extends S3ServiceException_1.S3ServiceException {
		name = "NoSuchKey";
		$fault = "client";
		constructor(opts) {
			super({
				name: "NoSuchKey",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, NoSuchKey.prototype);
		}
	};
	exports.NotFound = class NotFound extends S3ServiceException_1.S3ServiceException {
		name = "NotFound";
		$fault = "client";
		constructor(opts) {
			super({
				name: "NotFound",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, NotFound.prototype);
		}
	};
	exports.EncryptionTypeMismatch = class EncryptionTypeMismatch extends S3ServiceException_1.S3ServiceException {
		name = "EncryptionTypeMismatch";
		$fault = "client";
		constructor(opts) {
			super({
				name: "EncryptionTypeMismatch",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, EncryptionTypeMismatch.prototype);
		}
	};
	exports.InvalidRequest = class InvalidRequest extends S3ServiceException_1.S3ServiceException {
		name = "InvalidRequest";
		$fault = "client";
		constructor(opts) {
			super({
				name: "InvalidRequest",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, InvalidRequest.prototype);
		}
	};
	exports.InvalidWriteOffset = class InvalidWriteOffset extends S3ServiceException_1.S3ServiceException {
		name = "InvalidWriteOffset";
		$fault = "client";
		constructor(opts) {
			super({
				name: "InvalidWriteOffset",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, InvalidWriteOffset.prototype);
		}
	};
	exports.TooManyParts = class TooManyParts extends S3ServiceException_1.S3ServiceException {
		name = "TooManyParts";
		$fault = "client";
		constructor(opts) {
			super({
				name: "TooManyParts",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, TooManyParts.prototype);
		}
	};
	exports.IdempotencyParameterMismatch = class IdempotencyParameterMismatch extends S3ServiceException_1.S3ServiceException {
		name = "IdempotencyParameterMismatch";
		$fault = "client";
		constructor(opts) {
			super({
				name: "IdempotencyParameterMismatch",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, IdempotencyParameterMismatch.prototype);
		}
	};
	exports.ObjectAlreadyInActiveTierError = class ObjectAlreadyInActiveTierError extends S3ServiceException_1.S3ServiceException {
		name = "ObjectAlreadyInActiveTierError";
		$fault = "client";
		constructor(opts) {
			super({
				name: "ObjectAlreadyInActiveTierError",
				$fault: "client",
				...opts
			});
			Object.setPrototypeOf(this, ObjectAlreadyInActiveTierError.prototype);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/client-s3/dist-cjs/schemas/schemas_0.js
var require_schemas_0 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CreateBucketMetadataTableConfigurationRequest$ = exports.CreateBucketMetadataConfigurationRequest$ = exports.CreateBucketConfiguration$ = exports.CORSRule$ = exports.CORSConfiguration$ = exports.CopyPartResult$ = exports.CopyObjectResult$ = exports.CopyObjectRequest$ = exports.CopyObjectOutput$ = exports.ContinuationEvent$ = exports.Condition$ = exports.CompleteMultipartUploadRequest$ = exports.CompleteMultipartUploadOutput$ = exports.CompletedPart$ = exports.CompletedMultipartUpload$ = exports.CommonPrefix$ = exports.Checksum$ = exports.BucketLoggingStatus$ = exports.BucketLifecycleConfiguration$ = exports.BucketInfo$ = exports.Bucket$ = exports.BlockedEncryptionTypes$ = exports.AnalyticsS3BucketDestination$ = exports.AnalyticsExportDestination$ = exports.AnalyticsConfiguration$ = exports.AnalyticsAndOperator$ = exports.AccessControlTranslation$ = exports.AccessControlPolicy$ = exports.AccelerateConfiguration$ = exports.AbortMultipartUploadRequest$ = exports.AbortMultipartUploadOutput$ = exports.AbortIncompleteMultipartUpload$ = exports.AbacStatus$ = exports.errorTypeRegistries = exports.TooManyParts$ = exports.ObjectNotInActiveTierError$ = exports.ObjectAlreadyInActiveTierError$ = exports.NotFound$ = exports.NoSuchUpload$ = exports.NoSuchKey$ = exports.NoSuchBucket$ = exports.InvalidWriteOffset$ = exports.InvalidRequest$ = exports.InvalidObjectState$ = exports.IdempotencyParameterMismatch$ = exports.EncryptionTypeMismatch$ = exports.BucketAlreadyOwnedByYou$ = exports.BucketAlreadyExists$ = exports.AccessDenied$ = exports.S3ServiceException$ = void 0;
	exports.GetBucketAccelerateConfigurationRequest$ = exports.GetBucketAccelerateConfigurationOutput$ = exports.GetBucketAbacRequest$ = exports.GetBucketAbacOutput$ = exports.FilterRule$ = exports.ExistingObjectReplication$ = exports.EventBridgeConfiguration$ = exports.ErrorDocument$ = exports.ErrorDetails$ = exports._Error$ = exports.EndEvent$ = exports.EncryptionConfiguration$ = exports.Encryption$ = exports.DestinationResult$ = exports.Destination$ = exports.DeletePublicAccessBlockRequest$ = exports.DeleteObjectTaggingRequest$ = exports.DeleteObjectTaggingOutput$ = exports.DeleteObjectsRequest$ = exports.DeleteObjectsOutput$ = exports.DeleteObjectRequest$ = exports.DeleteObjectOutput$ = exports.DeleteMarkerReplication$ = exports.DeleteMarkerEntry$ = exports.DeletedObject$ = exports.DeleteBucketWebsiteRequest$ = exports.DeleteBucketTaggingRequest$ = exports.DeleteBucketRequest$ = exports.DeleteBucketReplicationRequest$ = exports.DeleteBucketPolicyRequest$ = exports.DeleteBucketOwnershipControlsRequest$ = exports.DeleteBucketMetricsConfigurationRequest$ = exports.DeleteBucketMetadataTableConfigurationRequest$ = exports.DeleteBucketMetadataConfigurationRequest$ = exports.DeleteBucketLifecycleRequest$ = exports.DeleteBucketInventoryConfigurationRequest$ = exports.DeleteBucketIntelligentTieringConfigurationRequest$ = exports.DeleteBucketEncryptionRequest$ = exports.DeleteBucketCorsRequest$ = exports.DeleteBucketAnalyticsConfigurationRequest$ = exports.Delete$ = exports.DefaultRetention$ = exports.CSVOutput$ = exports.CSVInput$ = exports.CreateSessionRequest$ = exports.CreateSessionOutput$ = exports.CreateMultipartUploadRequest$ = exports.CreateMultipartUploadOutput$ = exports.CreateBucketRequest$ = exports.CreateBucketOutput$ = void 0;
	exports.GetObjectLegalHoldRequest$ = exports.GetObjectLegalHoldOutput$ = exports.GetObjectAttributesRequest$ = exports.GetObjectAttributesParts$ = exports.GetObjectAttributesOutput$ = exports.GetObjectAclRequest$ = exports.GetObjectAclOutput$ = exports.GetBucketWebsiteRequest$ = exports.GetBucketWebsiteOutput$ = exports.GetBucketVersioningRequest$ = exports.GetBucketVersioningOutput$ = exports.GetBucketTaggingRequest$ = exports.GetBucketTaggingOutput$ = exports.GetBucketRequestPaymentRequest$ = exports.GetBucketRequestPaymentOutput$ = exports.GetBucketReplicationRequest$ = exports.GetBucketReplicationOutput$ = exports.GetBucketPolicyStatusRequest$ = exports.GetBucketPolicyStatusOutput$ = exports.GetBucketPolicyRequest$ = exports.GetBucketPolicyOutput$ = exports.GetBucketOwnershipControlsRequest$ = exports.GetBucketOwnershipControlsOutput$ = exports.GetBucketNotificationConfigurationRequest$ = exports.GetBucketMetricsConfigurationRequest$ = exports.GetBucketMetricsConfigurationOutput$ = exports.GetBucketMetadataTableConfigurationResult$ = exports.GetBucketMetadataTableConfigurationRequest$ = exports.GetBucketMetadataTableConfigurationOutput$ = exports.GetBucketMetadataConfigurationResult$ = exports.GetBucketMetadataConfigurationRequest$ = exports.GetBucketMetadataConfigurationOutput$ = exports.GetBucketLoggingRequest$ = exports.GetBucketLoggingOutput$ = exports.GetBucketLocationRequest$ = exports.GetBucketLocationOutput$ = exports.GetBucketLifecycleConfigurationRequest$ = exports.GetBucketLifecycleConfigurationOutput$ = exports.GetBucketInventoryConfigurationRequest$ = exports.GetBucketInventoryConfigurationOutput$ = exports.GetBucketIntelligentTieringConfigurationRequest$ = exports.GetBucketIntelligentTieringConfigurationOutput$ = exports.GetBucketEncryptionRequest$ = exports.GetBucketEncryptionOutput$ = exports.GetBucketCorsRequest$ = exports.GetBucketCorsOutput$ = exports.GetBucketAnalyticsConfigurationRequest$ = exports.GetBucketAnalyticsConfigurationOutput$ = exports.GetBucketAclRequest$ = exports.GetBucketAclOutput$ = void 0;
	exports.ListBucketInventoryConfigurationsRequest$ = exports.ListBucketInventoryConfigurationsOutput$ = exports.ListBucketIntelligentTieringConfigurationsRequest$ = exports.ListBucketIntelligentTieringConfigurationsOutput$ = exports.ListBucketAnalyticsConfigurationsRequest$ = exports.ListBucketAnalyticsConfigurationsOutput$ = exports.LifecycleRuleFilter$ = exports.LifecycleRuleAndOperator$ = exports.LifecycleRule$ = exports.LifecycleExpiration$ = exports.LambdaFunctionConfiguration$ = exports.JSONOutput$ = exports.JSONInput$ = exports.JournalTableConfigurationUpdates$ = exports.JournalTableConfigurationResult$ = exports.JournalTableConfiguration$ = exports.InventoryTableConfigurationUpdates$ = exports.InventoryTableConfigurationResult$ = exports.InventoryTableConfiguration$ = exports.InventorySchedule$ = exports.InventoryS3BucketDestination$ = exports.InventoryFilter$ = exports.InventoryEncryption$ = exports.InventoryDestination$ = exports.InventoryConfiguration$ = exports.IntelligentTieringFilter$ = exports.IntelligentTieringConfiguration$ = exports.IntelligentTieringAndOperator$ = exports.InputSerialization$ = exports.Initiator$ = exports.IndexDocument$ = exports.HeadObjectRequest$ = exports.HeadObjectOutput$ = exports.HeadBucketRequest$ = exports.HeadBucketOutput$ = exports.Grantee$ = exports.Grant$ = exports.GlacierJobParameters$ = exports.GetPublicAccessBlockRequest$ = exports.GetPublicAccessBlockOutput$ = exports.GetObjectTorrentRequest$ = exports.GetObjectTorrentOutput$ = exports.GetObjectTaggingRequest$ = exports.GetObjectTaggingOutput$ = exports.GetObjectRetentionRequest$ = exports.GetObjectRetentionOutput$ = exports.GetObjectRequest$ = exports.GetObjectOutput$ = exports.GetObjectLockConfigurationRequest$ = exports.GetObjectLockConfigurationOutput$ = void 0;
	exports.Progress$ = exports.PolicyStatus$ = exports.PartitionedPrefix$ = exports.Part$ = exports.ParquetInput$ = exports.OwnershipControlsRule$ = exports.OwnershipControls$ = exports.Owner$ = exports.OutputSerialization$ = exports.OutputLocation$ = exports.ObjectVersion$ = exports.ObjectPart$ = exports.ObjectLockRule$ = exports.ObjectLockRetention$ = exports.ObjectLockLegalHold$ = exports.ObjectLockConfiguration$ = exports.ObjectIdentifier$ = exports._Object$ = exports.NotificationConfigurationFilter$ = exports.NotificationConfiguration$ = exports.NoncurrentVersionTransition$ = exports.NoncurrentVersionExpiration$ = exports.MultipartUpload$ = exports.MetricsConfiguration$ = exports.MetricsAndOperator$ = exports.Metrics$ = exports.MetadataTableEncryptionConfiguration$ = exports.MetadataTableConfigurationResult$ = exports.MetadataTableConfiguration$ = exports.MetadataEntry$ = exports.MetadataConfigurationResult$ = exports.MetadataConfiguration$ = exports.LoggingEnabled$ = exports.LocationInfo$ = exports.ListPartsRequest$ = exports.ListPartsOutput$ = exports.ListObjectVersionsRequest$ = exports.ListObjectVersionsOutput$ = exports.ListObjectsV2Request$ = exports.ListObjectsV2Output$ = exports.ListObjectsRequest$ = exports.ListObjectsOutput$ = exports.ListMultipartUploadsRequest$ = exports.ListMultipartUploadsOutput$ = exports.ListDirectoryBucketsRequest$ = exports.ListDirectoryBucketsOutput$ = exports.ListBucketsRequest$ = exports.ListBucketsOutput$ = exports.ListBucketMetricsConfigurationsRequest$ = exports.ListBucketMetricsConfigurationsOutput$ = void 0;
	exports.RequestPaymentConfiguration$ = exports.ReplicationTimeValue$ = exports.ReplicationTime$ = exports.ReplicationRuleFilter$ = exports.ReplicationRuleAndOperator$ = exports.ReplicationRule$ = exports.ReplicationConfiguration$ = exports.ReplicaModifications$ = exports.RenameObjectRequest$ = exports.RenameObjectOutput$ = exports.RedirectAllRequestsTo$ = exports.Redirect$ = exports.RecordsEvent$ = exports.RecordExpiration$ = exports.QueueConfiguration$ = exports.PutPublicAccessBlockRequest$ = exports.PutObjectTaggingRequest$ = exports.PutObjectTaggingOutput$ = exports.PutObjectRetentionRequest$ = exports.PutObjectRetentionOutput$ = exports.PutObjectRequest$ = exports.PutObjectOutput$ = exports.PutObjectLockConfigurationRequest$ = exports.PutObjectLockConfigurationOutput$ = exports.PutObjectLegalHoldRequest$ = exports.PutObjectLegalHoldOutput$ = exports.PutObjectAclRequest$ = exports.PutObjectAclOutput$ = exports.PutBucketWebsiteRequest$ = exports.PutBucketVersioningRequest$ = exports.PutBucketTaggingRequest$ = exports.PutBucketRequestPaymentRequest$ = exports.PutBucketReplicationRequest$ = exports.PutBucketPolicyRequest$ = exports.PutBucketOwnershipControlsRequest$ = exports.PutBucketNotificationConfigurationRequest$ = exports.PutBucketMetricsConfigurationRequest$ = exports.PutBucketLoggingRequest$ = exports.PutBucketLifecycleConfigurationRequest$ = exports.PutBucketLifecycleConfigurationOutput$ = exports.PutBucketInventoryConfigurationRequest$ = exports.PutBucketIntelligentTieringConfigurationRequest$ = exports.PutBucketEncryptionRequest$ = exports.PutBucketCorsRequest$ = exports.PutBucketAnalyticsConfigurationRequest$ = exports.PutBucketAclRequest$ = exports.PutBucketAccelerateConfigurationRequest$ = exports.PutBucketAbacRequest$ = exports.PublicAccessBlockConfiguration$ = exports.ProgressEvent$ = void 0;
	exports.SelectObjectContentEventStream$ = exports.ObjectEncryption$ = exports.MetricsFilter$ = exports.AnalyticsFilter$ = exports.WriteGetObjectResponseRequest$ = exports.WebsiteConfiguration$ = exports.VersioningConfiguration$ = exports.UploadPartRequest$ = exports.UploadPartOutput$ = exports.UploadPartCopyRequest$ = exports.UploadPartCopyOutput$ = exports.UpdateObjectEncryptionResponse$ = exports.UpdateObjectEncryptionRequest$ = exports.UpdateBucketMetadataJournalTableConfigurationRequest$ = exports.UpdateBucketMetadataInventoryTableConfigurationRequest$ = exports.Transition$ = exports.TopicConfiguration$ = exports.Tiering$ = exports.TargetObjectKeyFormat$ = exports.TargetGrant$ = exports.Tagging$ = exports.Tag$ = exports.StorageClassAnalysisDataExport$ = exports.StorageClassAnalysis$ = exports.StatsEvent$ = exports.Stats$ = exports.SSES3$ = exports.SSEKMSEncryption$ = exports.SseKmsEncryptedObjects$ = exports.SSEKMS$ = exports.SourceSelectionCriteria$ = exports.SimplePrefix$ = exports.SessionCredentials$ = exports.ServerSideEncryptionRule$ = exports.ServerSideEncryptionConfiguration$ = exports.ServerSideEncryptionByDefault$ = exports.SelectParameters$ = exports.SelectObjectContentRequest$ = exports.SelectObjectContentOutput$ = exports.ScanRange$ = exports.S3TablesDestinationResult$ = exports.S3TablesDestination$ = exports.S3Location$ = exports.S3KeyFilter$ = exports.RoutingRule$ = exports.RestoreStatus$ = exports.RestoreRequest$ = exports.RestoreObjectRequest$ = exports.RestoreObjectOutput$ = exports.RequestProgress$ = void 0;
	exports.GetBucketWebsite$ = exports.GetBucketVersioning$ = exports.GetBucketTagging$ = exports.GetBucketRequestPayment$ = exports.GetBucketReplication$ = exports.GetBucketPolicyStatus$ = exports.GetBucketPolicy$ = exports.GetBucketOwnershipControls$ = exports.GetBucketNotificationConfiguration$ = exports.GetBucketMetricsConfiguration$ = exports.GetBucketMetadataTableConfiguration$ = exports.GetBucketMetadataConfiguration$ = exports.GetBucketLogging$ = exports.GetBucketLocation$ = exports.GetBucketLifecycleConfiguration$ = exports.GetBucketInventoryConfiguration$ = exports.GetBucketIntelligentTieringConfiguration$ = exports.GetBucketEncryption$ = exports.GetBucketCors$ = exports.GetBucketAnalyticsConfiguration$ = exports.GetBucketAcl$ = exports.GetBucketAccelerateConfiguration$ = exports.GetBucketAbac$ = exports.DeletePublicAccessBlock$ = exports.DeleteObjectTagging$ = exports.DeleteObjects$ = exports.DeleteObject$ = exports.DeleteBucketWebsite$ = exports.DeleteBucketTagging$ = exports.DeleteBucketReplication$ = exports.DeleteBucketPolicy$ = exports.DeleteBucketOwnershipControls$ = exports.DeleteBucketMetricsConfiguration$ = exports.DeleteBucketMetadataTableConfiguration$ = exports.DeleteBucketMetadataConfiguration$ = exports.DeleteBucketLifecycle$ = exports.DeleteBucketInventoryConfiguration$ = exports.DeleteBucketIntelligentTieringConfiguration$ = exports.DeleteBucketEncryption$ = exports.DeleteBucketCors$ = exports.DeleteBucketAnalyticsConfiguration$ = exports.DeleteBucket$ = exports.CreateSession$ = exports.CreateMultipartUpload$ = exports.CreateBucketMetadataTableConfiguration$ = exports.CreateBucketMetadataConfiguration$ = exports.CreateBucket$ = exports.CopyObject$ = exports.CompleteMultipartUpload$ = exports.AbortMultipartUpload$ = void 0;
	exports.RestoreObject$ = exports.RenameObject$ = exports.PutPublicAccessBlock$ = exports.PutObjectTagging$ = exports.PutObjectRetention$ = exports.PutObjectLockConfiguration$ = exports.PutObjectLegalHold$ = exports.PutObjectAcl$ = exports.PutObject$ = exports.PutBucketWebsite$ = exports.PutBucketVersioning$ = exports.PutBucketTagging$ = exports.PutBucketRequestPayment$ = exports.PutBucketReplication$ = exports.PutBucketPolicy$ = exports.PutBucketOwnershipControls$ = exports.PutBucketNotificationConfiguration$ = exports.PutBucketMetricsConfiguration$ = exports.PutBucketLogging$ = exports.PutBucketLifecycleConfiguration$ = exports.PutBucketInventoryConfiguration$ = exports.PutBucketIntelligentTieringConfiguration$ = exports.PutBucketEncryption$ = exports.PutBucketCors$ = exports.PutBucketAnalyticsConfiguration$ = exports.PutBucketAcl$ = exports.PutBucketAccelerateConfiguration$ = exports.PutBucketAbac$ = exports.ListParts$ = exports.ListObjectVersions$ = exports.ListObjectsV2$ = exports.ListObjects$ = exports.ListMultipartUploads$ = exports.ListDirectoryBuckets$ = exports.ListBuckets$ = exports.ListBucketMetricsConfigurations$ = exports.ListBucketInventoryConfigurations$ = exports.ListBucketIntelligentTieringConfigurations$ = exports.ListBucketAnalyticsConfigurations$ = exports.HeadObject$ = exports.HeadBucket$ = exports.GetPublicAccessBlock$ = exports.GetObjectTorrent$ = exports.GetObjectTagging$ = exports.GetObjectRetention$ = exports.GetObjectLockConfiguration$ = exports.GetObjectLegalHold$ = exports.GetObjectAttributes$ = exports.GetObjectAcl$ = exports.GetObject$ = void 0;
	exports.WriteGetObjectResponse$ = exports.UploadPartCopy$ = exports.UploadPart$ = exports.UpdateObjectEncryption$ = exports.UpdateBucketMetadataJournalTableConfiguration$ = exports.UpdateBucketMetadataInventoryTableConfiguration$ = exports.SelectObjectContent$ = void 0;
	const _A = "Account";
	const _AAO = "AnalyticsAndOperator";
	const _AC = "AccelerateConfiguration";
	const _ACL = "AccessControlList";
	const _ACL_ = "ACL";
	const _ACLn = "AnalyticsConfigurationList";
	const _ACP = "AccessControlPolicy";
	const _ACT = "AccessControlTranslation";
	const _ACn = "AnalyticsConfiguration";
	const _AD = "AccessDenied";
	const _ADb = "AbortDate";
	const _AED = "AnalyticsExportDestination";
	const _AF = "AnalyticsFilter";
	const _AH = "AllowedHeaders";
	const _AHl = "AllowedHeader";
	const _AI = "AccountId";
	const _AIMU = "AbortIncompleteMultipartUpload";
	const _AKI = "AccessKeyId";
	const _AM = "AllowedMethods";
	const _AMU = "AbortMultipartUpload";
	const _AMUO = "AbortMultipartUploadOutput";
	const _AMUR = "AbortMultipartUploadRequest";
	const _AMl = "AllowedMethod";
	const _AO = "AllowedOrigins";
	const _AOl = "AllowedOrigin";
	const _APA = "AccessPointAlias";
	const _APAc = "AccessPointArn";
	const _AQRD = "AllowQuotedRecordDelimiter";
	const _AR = "AcceptRanges";
	const _ARI = "AbortRuleId";
	const _AS = "AbacStatus";
	const _ASBD = "AnalyticsS3BucketDestination";
	const _ASSEBD = "ApplyServerSideEncryptionByDefault";
	const _ASr = "ArchiveStatus";
	const _AT = "AccessTier";
	const _An = "And";
	const _B = "Bucket";
	const _BA = "BucketArn";
	const _BAE = "BucketAlreadyExists";
	const _BAI = "BucketAccountId";
	const _BAOBY = "BucketAlreadyOwnedByYou";
	const _BET = "BlockedEncryptionTypes";
	const _BGR = "BypassGovernanceRetention";
	const _BI = "BucketInfo";
	const _BKE = "BucketKeyEnabled";
	const _BLC = "BucketLifecycleConfiguration";
	const _BLN = "BucketLocationName";
	const _BLS = "BucketLoggingStatus";
	const _BLT = "BucketLocationType";
	const _BN = "BucketNamespace";
	const _BNu = "BucketName";
	const _BP = "BytesProcessed";
	const _BPA = "BlockPublicAcls";
	const _BPP = "BlockPublicPolicy";
	const _BR = "BucketRegion";
	const _BRy = "BytesReturned";
	const _BS = "BytesScanned";
	const _Bo = "Body";
	const _Bu = "Buckets";
	const _C = "Checksum";
	const _CA = "ChecksumAlgorithm";
	const _CACL = "CannedACL";
	const _CB = "CreateBucket";
	const _CBC = "CreateBucketConfiguration";
	const _CBMC = "CreateBucketMetadataConfiguration";
	const _CBMCR = "CreateBucketMetadataConfigurationRequest";
	const _CBMTC = "CreateBucketMetadataTableConfiguration";
	const _CBMTCR = "CreateBucketMetadataTableConfigurationRequest";
	const _CBO = "CreateBucketOutput";
	const _CBR = "CreateBucketRequest";
	const _CC = "CacheControl";
	const _CCRC = "ChecksumCRC32";
	const _CCRCC = "ChecksumCRC32C";
	const _CCRCNVME = "ChecksumCRC64NVME";
	const _CC_ = "Cache-Control";
	const _CD = "CreationDate";
	const _CD_ = "Content-Disposition";
	const _CDo = "ContentDisposition";
	const _CE = "ContinuationEvent";
	const _CE_ = "Content-Encoding";
	const _CEo = "ContentEncoding";
	const _CF = "CloudFunction";
	const _CFC = "CloudFunctionConfiguration";
	const _CL = "ContentLanguage";
	const _CL_ = "Content-Language";
	const _CL__ = "Content-Length";
	const _CLo = "ContentLength";
	const _CM = "Content-MD5";
	const _CMD = "ChecksumMD5";
	const _CMDo = "ContentMD5";
	const _CMU = "CompletedMultipartUpload";
	const _CMUO = "CompleteMultipartUploadOutput";
	const _CMUOr = "CreateMultipartUploadOutput";
	const _CMUR = "CompleteMultipartUploadResult";
	const _CMURo = "CompleteMultipartUploadRequest";
	const _CMURr = "CreateMultipartUploadRequest";
	const _CMUo = "CompleteMultipartUpload";
	const _CMUr = "CreateMultipartUpload";
	const _CMh = "ChecksumMode";
	const _CO = "CopyObject";
	const _COO = "CopyObjectOutput";
	const _COR = "CopyObjectResult";
	const _CORSC = "CORSConfiguration";
	const _CORSR = "CORSRules";
	const _CORSRu = "CORSRule";
	const _CORo = "CopyObjectRequest";
	const _CP = "CommonPrefix";
	const _CPL = "CommonPrefixList";
	const _CPLo = "CompletedPartList";
	const _CPR = "CopyPartResult";
	const _CPo = "CompletedPart";
	const _CPom = "CommonPrefixes";
	const _CR = "ContentRange";
	const _CRSBA = "ConfirmRemoveSelfBucketAccess";
	const _CR_ = "Content-Range";
	const _CS = "CopySource";
	const _CSHA = "ChecksumSHA1";
	const _CSHAh = "ChecksumSHA256";
	const _CSHAhe = "ChecksumSHA512";
	const _CSIM = "CopySourceIfMatch";
	const _CSIMS = "CopySourceIfModifiedSince";
	const _CSINM = "CopySourceIfNoneMatch";
	const _CSIUS = "CopySourceIfUnmodifiedSince";
	const _CSO = "CreateSessionOutput";
	const _CSR = "CreateSessionResult";
	const _CSRo = "CopySourceRange";
	const _CSRr = "CreateSessionRequest";
	const _CSSSECA = "CopySourceSSECustomerAlgorithm";
	const _CSSSECK = "CopySourceSSECustomerKey";
	const _CSSSECKMD = "CopySourceSSECustomerKeyMD5";
	const _CSV = "CSV";
	const _CSVI = "CopySourceVersionId";
	const _CSVIn = "CSVInput";
	const _CSVO = "CSVOutput";
	const _CSo = "ConfigurationState";
	const _CSr = "CreateSession";
	const _CT = "ChecksumType";
	const _CT_ = "Content-Type";
	const _CTl = "ClientToken";
	const _CTo = "ContentType";
	const _CTom = "CompressionType";
	const _CTon = "ContinuationToken";
	const _CXXHASH = "ChecksumXXHASH64";
	const _CXXHASHh = "ChecksumXXHASH3";
	const _CXXHASHhe = "ChecksumXXHASH128";
	const _Co = "Condition";
	const _Cod = "Code";
	const _Com = "Comments";
	const _Con = "Contents";
	const _Cont = "Cont";
	const _Cr = "Credentials";
	const _D = "Days";
	const _DAI = "DaysAfterInitiation";
	const _DB = "DeleteBucket";
	const _DBAC = "DeleteBucketAnalyticsConfiguration";
	const _DBACR = "DeleteBucketAnalyticsConfigurationRequest";
	const _DBC = "DeleteBucketCors";
	const _DBCR = "DeleteBucketCorsRequest";
	const _DBE = "DeleteBucketEncryption";
	const _DBER = "DeleteBucketEncryptionRequest";
	const _DBIC = "DeleteBucketInventoryConfiguration";
	const _DBICR = "DeleteBucketInventoryConfigurationRequest";
	const _DBITC = "DeleteBucketIntelligentTieringConfiguration";
	const _DBITCR = "DeleteBucketIntelligentTieringConfigurationRequest";
	const _DBL = "DeleteBucketLifecycle";
	const _DBLR = "DeleteBucketLifecycleRequest";
	const _DBMC = "DeleteBucketMetadataConfiguration";
	const _DBMCR = "DeleteBucketMetadataConfigurationRequest";
	const _DBMCRe = "DeleteBucketMetricsConfigurationRequest";
	const _DBMCe = "DeleteBucketMetricsConfiguration";
	const _DBMTC = "DeleteBucketMetadataTableConfiguration";
	const _DBMTCR = "DeleteBucketMetadataTableConfigurationRequest";
	const _DBOC = "DeleteBucketOwnershipControls";
	const _DBOCR = "DeleteBucketOwnershipControlsRequest";
	const _DBP = "DeleteBucketPolicy";
	const _DBPR = "DeleteBucketPolicyRequest";
	const _DBR = "DeleteBucketRequest";
	const _DBRR = "DeleteBucketReplicationRequest";
	const _DBRe = "DeleteBucketReplication";
	const _DBT = "DeleteBucketTagging";
	const _DBTR = "DeleteBucketTaggingRequest";
	const _DBW = "DeleteBucketWebsite";
	const _DBWR = "DeleteBucketWebsiteRequest";
	const _DE = "DataExport";
	const _DIM = "DestinationIfMatch";
	const _DIMS = "DestinationIfModifiedSince";
	const _DINM = "DestinationIfNoneMatch";
	const _DIUS = "DestinationIfUnmodifiedSince";
	const _DM = "DeleteMarker";
	const _DME = "DeleteMarkerEntry";
	const _DMR = "DeleteMarkerReplication";
	const _DMVI = "DeleteMarkerVersionId";
	const _DMe = "DeleteMarkers";
	const _DN = "DisplayName";
	const _DO = "DeletedObject";
	const _DOO = "DeleteObjectOutput";
	const _DOOe = "DeleteObjectsOutput";
	const _DOR = "DeleteObjectRequest";
	const _DORe = "DeleteObjectsRequest";
	const _DOT = "DeleteObjectTagging";
	const _DOTO = "DeleteObjectTaggingOutput";
	const _DOTR = "DeleteObjectTaggingRequest";
	const _DOe = "DeletedObjects";
	const _DOel = "DeleteObject";
	const _DOele = "DeleteObjects";
	const _DPAB = "DeletePublicAccessBlock";
	const _DPABR = "DeletePublicAccessBlockRequest";
	const _DR = "DataRedundancy";
	const _DRe = "DefaultRetention";
	const _DRel = "DeleteResult";
	const _DRes = "DestinationResult";
	const _Da = "Date";
	const _De = "Delete";
	const _Del = "Deleted";
	const _Deli = "Delimiter";
	const _Des = "Destination";
	const _Desc = "Description";
	const _Det = "Details";
	const _E = "Expiration";
	const _EA = "EmailAddress";
	const _EBC = "EventBridgeConfiguration";
	const _EBO = "ExpectedBucketOwner";
	const _EC = "EncryptionConfiguration";
	const _ECr = "ErrorCode";
	const _ED = "ErrorDetails";
	const _EDr = "ErrorDocument";
	const _EE = "EndEvent";
	const _EH = "ExposeHeaders";
	const _EHx = "ExposeHeader";
	const _EM = "ErrorMessage";
	const _EODM = "ExpiredObjectDeleteMarker";
	const _EOR = "ExistingObjectReplication";
	const _ES = "ExpiresString";
	const _ESBO = "ExpectedSourceBucketOwner";
	const _ET = "EncryptionType";
	const _ETL = "EncryptionTypeList";
	const _ETM = "EncryptionTypeMismatch";
	const _ETa = "ETag";
	const _ETn = "EncodingType";
	const _ETv = "EventThreshold";
	const _ETx = "ExpressionType";
	const _En = "Encryption";
	const _Ena = "Enabled";
	const _End = "End";
	const _Er = "Errors";
	const _Err = "Error";
	const _Ev = "Events";
	const _Eve = "Event";
	const _Ex = "Expires";
	const _Exp = "Expression";
	const _F = "Filter";
	const _FD = "FieldDelimiter";
	const _FHI = "FileHeaderInfo";
	const _FO = "FetchOwner";
	const _FR = "FilterRule";
	const _FRL = "FilterRuleList";
	const _FRi = "FilterRules";
	const _Fi = "Field";
	const _Fo = "Format";
	const _Fr = "Frequency";
	const _G = "Grants";
	const _GBA = "GetBucketAbac";
	const _GBAC = "GetBucketAccelerateConfiguration";
	const _GBACO = "GetBucketAccelerateConfigurationOutput";
	const _GBACOe = "GetBucketAnalyticsConfigurationOutput";
	const _GBACR = "GetBucketAccelerateConfigurationRequest";
	const _GBACRe = "GetBucketAnalyticsConfigurationRequest";
	const _GBACe = "GetBucketAnalyticsConfiguration";
	const _GBAO = "GetBucketAbacOutput";
	const _GBAOe = "GetBucketAclOutput";
	const _GBAR = "GetBucketAbacRequest";
	const _GBARe = "GetBucketAclRequest";
	const _GBAe = "GetBucketAcl";
	const _GBC = "GetBucketCors";
	const _GBCO = "GetBucketCorsOutput";
	const _GBCR = "GetBucketCorsRequest";
	const _GBE = "GetBucketEncryption";
	const _GBEO = "GetBucketEncryptionOutput";
	const _GBER = "GetBucketEncryptionRequest";
	const _GBIC = "GetBucketInventoryConfiguration";
	const _GBICO = "GetBucketInventoryConfigurationOutput";
	const _GBICR = "GetBucketInventoryConfigurationRequest";
	const _GBITC = "GetBucketIntelligentTieringConfiguration";
	const _GBITCO = "GetBucketIntelligentTieringConfigurationOutput";
	const _GBITCR = "GetBucketIntelligentTieringConfigurationRequest";
	const _GBL = "GetBucketLocation";
	const _GBLC = "GetBucketLifecycleConfiguration";
	const _GBLCO = "GetBucketLifecycleConfigurationOutput";
	const _GBLCR = "GetBucketLifecycleConfigurationRequest";
	const _GBLO = "GetBucketLocationOutput";
	const _GBLOe = "GetBucketLoggingOutput";
	const _GBLR = "GetBucketLocationRequest";
	const _GBLRe = "GetBucketLoggingRequest";
	const _GBLe = "GetBucketLogging";
	const _GBMC = "GetBucketMetadataConfiguration";
	const _GBMCO = "GetBucketMetadataConfigurationOutput";
	const _GBMCOe = "GetBucketMetricsConfigurationOutput";
	const _GBMCR = "GetBucketMetadataConfigurationResult";
	const _GBMCRe = "GetBucketMetadataConfigurationRequest";
	const _GBMCRet = "GetBucketMetricsConfigurationRequest";
	const _GBMCe = "GetBucketMetricsConfiguration";
	const _GBMTC = "GetBucketMetadataTableConfiguration";
	const _GBMTCO = "GetBucketMetadataTableConfigurationOutput";
	const _GBMTCR = "GetBucketMetadataTableConfigurationResult";
	const _GBMTCRe = "GetBucketMetadataTableConfigurationRequest";
	const _GBNC = "GetBucketNotificationConfiguration";
	const _GBNCR = "GetBucketNotificationConfigurationRequest";
	const _GBOC = "GetBucketOwnershipControls";
	const _GBOCO = "GetBucketOwnershipControlsOutput";
	const _GBOCR = "GetBucketOwnershipControlsRequest";
	const _GBP = "GetBucketPolicy";
	const _GBPO = "GetBucketPolicyOutput";
	const _GBPR = "GetBucketPolicyRequest";
	const _GBPS = "GetBucketPolicyStatus";
	const _GBPSO = "GetBucketPolicyStatusOutput";
	const _GBPSR = "GetBucketPolicyStatusRequest";
	const _GBR = "GetBucketReplication";
	const _GBRO = "GetBucketReplicationOutput";
	const _GBRP = "GetBucketRequestPayment";
	const _GBRPO = "GetBucketRequestPaymentOutput";
	const _GBRPR = "GetBucketRequestPaymentRequest";
	const _GBRR = "GetBucketReplicationRequest";
	const _GBT = "GetBucketTagging";
	const _GBTO = "GetBucketTaggingOutput";
	const _GBTR = "GetBucketTaggingRequest";
	const _GBV = "GetBucketVersioning";
	const _GBVO = "GetBucketVersioningOutput";
	const _GBVR = "GetBucketVersioningRequest";
	const _GBW = "GetBucketWebsite";
	const _GBWO = "GetBucketWebsiteOutput";
	const _GBWR = "GetBucketWebsiteRequest";
	const _GFC = "GrantFullControl";
	const _GJP = "GlacierJobParameters";
	const _GO = "GetObject";
	const _GOA = "GetObjectAcl";
	const _GOAO = "GetObjectAclOutput";
	const _GOAOe = "GetObjectAttributesOutput";
	const _GOAP = "GetObjectAttributesParts";
	const _GOAR = "GetObjectAclRequest";
	const _GOARe = "GetObjectAttributesResponse";
	const _GOARet = "GetObjectAttributesRequest";
	const _GOAe = "GetObjectAttributes";
	const _GOLC = "GetObjectLockConfiguration";
	const _GOLCO = "GetObjectLockConfigurationOutput";
	const _GOLCR = "GetObjectLockConfigurationRequest";
	const _GOLH = "GetObjectLegalHold";
	const _GOLHO = "GetObjectLegalHoldOutput";
	const _GOLHR = "GetObjectLegalHoldRequest";
	const _GOO = "GetObjectOutput";
	const _GOR = "GetObjectRequest";
	const _GORO = "GetObjectRetentionOutput";
	const _GORR = "GetObjectRetentionRequest";
	const _GORe = "GetObjectRetention";
	const _GOT = "GetObjectTagging";
	const _GOTO = "GetObjectTaggingOutput";
	const _GOTOe = "GetObjectTorrentOutput";
	const _GOTR = "GetObjectTaggingRequest";
	const _GOTRe = "GetObjectTorrentRequest";
	const _GOTe = "GetObjectTorrent";
	const _GPAB = "GetPublicAccessBlock";
	const _GPABO = "GetPublicAccessBlockOutput";
	const _GPABR = "GetPublicAccessBlockRequest";
	const _GR = "GrantRead";
	const _GRACP = "GrantReadACP";
	const _GW = "GrantWrite";
	const _GWACP = "GrantWriteACP";
	const _Gr = "Grant";
	const _Gra = "Grantee";
	const _HB = "HeadBucket";
	const _HBO = "HeadBucketOutput";
	const _HBR = "HeadBucketRequest";
	const _HECRE = "HttpErrorCodeReturnedEquals";
	const _HN = "HostName";
	const _HO = "HeadObject";
	const _HOO = "HeadObjectOutput";
	const _HOR = "HeadObjectRequest";
	const _HRC = "HttpRedirectCode";
	const _I = "Id";
	const _IC = "InventoryConfiguration";
	const _ICL = "InventoryConfigurationList";
	const _ID = "ID";
	const _IDn = "IndexDocument";
	const _IDnv = "InventoryDestination";
	const _IE = "IsEnabled";
	const _IEn = "InventoryEncryption";
	const _IF = "InventoryFilter";
	const _IL = "IsLatest";
	const _IM = "IfMatch";
	const _IMIT = "IfMatchInitiatedTime";
	const _IMLMT = "IfMatchLastModifiedTime";
	const _IMS = "IfMatchSize";
	const _IMS_ = "If-Modified-Since";
	const _IMSf = "IfModifiedSince";
	const _IMUR = "InitiateMultipartUploadResult";
	const _IM_ = "If-Match";
	const _INM = "IfNoneMatch";
	const _INM_ = "If-None-Match";
	const _IOF = "InventoryOptionalFields";
	const _IOS = "InvalidObjectState";
	const _IOV = "IncludedObjectVersions";
	const _IP = "IsPublic";
	const _IPA = "IgnorePublicAcls";
	const _IPM = "IdempotencyParameterMismatch";
	const _IR = "InvalidRequest";
	const _IRIP = "IsRestoreInProgress";
	const _IS = "InputSerialization";
	const _ISBD = "InventoryS3BucketDestination";
	const _ISn = "InventorySchedule";
	const _IT = "IsTruncated";
	const _ITAO = "IntelligentTieringAndOperator";
	const _ITC = "IntelligentTieringConfiguration";
	const _ITCL = "IntelligentTieringConfigurationList";
	const _ITCR = "InventoryTableConfigurationResult";
	const _ITCU = "InventoryTableConfigurationUpdates";
	const _ITCn = "InventoryTableConfiguration";
	const _ITF = "IntelligentTieringFilter";
	const _IUS = "IfUnmodifiedSince";
	const _IUS_ = "If-Unmodified-Since";
	const _IWO = "InvalidWriteOffset";
	const _In = "Initiator";
	const _Ini = "Initiated";
	const _JSON = "JSON";
	const _JSONI = "JSONInput";
	const _JSONO = "JSONOutput";
	const _JTC = "JournalTableConfiguration";
	const _JTCR = "JournalTableConfigurationResult";
	const _JTCU = "JournalTableConfigurationUpdates";
	const _K = "Key";
	const _KC = "KeyCount";
	const _KI = "KeyId";
	const _KKA = "KmsKeyArn";
	const _KM = "KeyMarker";
	const _KMSC = "KMSContext";
	const _KMSKA = "KMSKeyArn";
	const _KMSKI = "KMSKeyId";
	const _KMSMKID = "KMSMasterKeyID";
	const _KPE = "KeyPrefixEquals";
	const _L = "Location";
	const _LAMBR = "ListAllMyBucketsResult";
	const _LAMDBR = "ListAllMyDirectoryBucketsResult";
	const _LB = "ListBuckets";
	const _LBAC = "ListBucketAnalyticsConfigurations";
	const _LBACO = "ListBucketAnalyticsConfigurationsOutput";
	const _LBACR = "ListBucketAnalyticsConfigurationResult";
	const _LBACRi = "ListBucketAnalyticsConfigurationsRequest";
	const _LBIC = "ListBucketInventoryConfigurations";
	const _LBICO = "ListBucketInventoryConfigurationsOutput";
	const _LBICR = "ListBucketInventoryConfigurationsRequest";
	const _LBITC = "ListBucketIntelligentTieringConfigurations";
	const _LBITCO = "ListBucketIntelligentTieringConfigurationsOutput";
	const _LBITCR = "ListBucketIntelligentTieringConfigurationsRequest";
	const _LBMC = "ListBucketMetricsConfigurations";
	const _LBMCO = "ListBucketMetricsConfigurationsOutput";
	const _LBMCR = "ListBucketMetricsConfigurationsRequest";
	const _LBO = "ListBucketsOutput";
	const _LBR = "ListBucketsRequest";
	const _LBRi = "ListBucketResult";
	const _LC = "LocationConstraint";
	const _LCi = "LifecycleConfiguration";
	const _LDB = "ListDirectoryBuckets";
	const _LDBO = "ListDirectoryBucketsOutput";
	const _LDBR = "ListDirectoryBucketsRequest";
	const _LE = "LoggingEnabled";
	const _LEi = "LifecycleExpiration";
	const _LFA = "LambdaFunctionArn";
	const _LFC = "LambdaFunctionConfiguration";
	const _LFCL = "LambdaFunctionConfigurationList";
	const _LFCa = "LambdaFunctionConfigurations";
	const _LH = "LegalHold";
	const _LI = "LocationInfo";
	const _LICR = "ListInventoryConfigurationsResult";
	const _LM = "LastModified";
	const _LMCR = "ListMetricsConfigurationsResult";
	const _LMT = "LastModifiedTime";
	const _LMU = "ListMultipartUploads";
	const _LMUO = "ListMultipartUploadsOutput";
	const _LMUR = "ListMultipartUploadsResult";
	const _LMURi = "ListMultipartUploadsRequest";
	const _LM_ = "Last-Modified";
	const _LO = "ListObjects";
	const _LOO = "ListObjectsOutput";
	const _LOR = "ListObjectsRequest";
	const _LOV = "ListObjectsV2";
	const _LOVO = "ListObjectsV2Output";
	const _LOVOi = "ListObjectVersionsOutput";
	const _LOVR = "ListObjectsV2Request";
	const _LOVRi = "ListObjectVersionsRequest";
	const _LOVi = "ListObjectVersions";
	const _LP = "ListParts";
	const _LPO = "ListPartsOutput";
	const _LPR = "ListPartsResult";
	const _LPRi = "ListPartsRequest";
	const _LR = "LifecycleRule";
	const _LRAO = "LifecycleRuleAndOperator";
	const _LRF = "LifecycleRuleFilter";
	const _LRi = "LifecycleRules";
	const _LVR = "ListVersionsResult";
	const _M = "Metadata";
	const _MAO = "MetricsAndOperator";
	const _MAS = "MaxAgeSeconds";
	const _MB = "MaxBuckets";
	const _MC = "MetadataConfiguration";
	const _MCL = "MetricsConfigurationList";
	const _MCR = "MetadataConfigurationResult";
	const _MCe = "MetricsConfiguration";
	const _MD = "MetadataDirective";
	const _MDB = "MaxDirectoryBuckets";
	const _MDf = "MfaDelete";
	const _ME = "MetadataEntry";
	const _MF = "MetricsFilter";
	const _MFA = "MFA";
	const _MFAD = "MFADelete";
	const _MK = "MaxKeys";
	const _MM = "MissingMeta";
	const _MOS = "MpuObjectSize";
	const _MP = "MaxParts";
	const _MTC = "MetadataTableConfiguration";
	const _MTCR = "MetadataTableConfigurationResult";
	const _MTEC = "MetadataTableEncryptionConfiguration";
	const _MU = "MultipartUpload";
	const _MUL = "MultipartUploadList";
	const _MUa = "MaxUploads";
	const _Ma = "Marker";
	const _Me = "Metrics";
	const _Mes = "Message";
	const _Mi = "Minutes";
	const _Mo = "Mode";
	const _N = "Name";
	const _NC = "NotificationConfiguration";
	const _NCF = "NotificationConfigurationFilter";
	const _NCT = "NextContinuationToken";
	const _ND = "NoncurrentDays";
	const _NEKKAS = "NonEmptyKmsKeyArnString";
	const _NF = "NotFound";
	const _NKM = "NextKeyMarker";
	const _NM = "NextMarker";
	const _NNV = "NewerNoncurrentVersions";
	const _NPNM = "NextPartNumberMarker";
	const _NSB = "NoSuchBucket";
	const _NSK = "NoSuchKey";
	const _NSU = "NoSuchUpload";
	const _NUIM = "NextUploadIdMarker";
	const _NVE = "NoncurrentVersionExpiration";
	const _NVIM = "NextVersionIdMarker";
	const _NVT = "NoncurrentVersionTransitions";
	const _NVTL = "NoncurrentVersionTransitionList";
	const _NVTo = "NoncurrentVersionTransition";
	const _O = "Owner";
	const _OA = "ObjectAttributes";
	const _OAIATE = "ObjectAlreadyInActiveTierError";
	const _OC = "OwnershipControls";
	const _OCR = "OwnershipControlsRule";
	const _OCRw = "OwnershipControlsRules";
	const _OE = "ObjectEncryption";
	const _OF = "OptionalFields";
	const _OI = "ObjectIdentifier";
	const _OIL = "ObjectIdentifierList";
	const _OL = "OutputLocation";
	const _OLC = "ObjectLockConfiguration";
	const _OLE = "ObjectLockEnabled";
	const _OLEFB = "ObjectLockEnabledForBucket";
	const _OLLH = "ObjectLockLegalHold";
	const _OLLHS = "ObjectLockLegalHoldStatus";
	const _OLM = "ObjectLockMode";
	const _OLR = "ObjectLockRetention";
	const _OLRUD = "ObjectLockRetainUntilDate";
	const _OLRb = "ObjectLockRule";
	const _OLb = "ObjectList";
	const _ONIATE = "ObjectNotInActiveTierError";
	const _OO = "ObjectOwnership";
	const _OOA = "OptionalObjectAttributes";
	const _OP = "ObjectParts";
	const _OPb = "ObjectPart";
	const _OS = "ObjectSize";
	const _OSGT = "ObjectSizeGreaterThan";
	const _OSLT = "ObjectSizeLessThan";
	const _OSV = "OutputSchemaVersion";
	const _OSu = "OutputSerialization";
	const _OV = "ObjectVersion";
	const _OVL = "ObjectVersionList";
	const _Ob = "Objects";
	const _Obj = "Object";
	const _P = "Prefix";
	const _PABC = "PublicAccessBlockConfiguration";
	const _PBA = "PutBucketAbac";
	const _PBAC = "PutBucketAccelerateConfiguration";
	const _PBACR = "PutBucketAccelerateConfigurationRequest";
	const _PBACRu = "PutBucketAnalyticsConfigurationRequest";
	const _PBACu = "PutBucketAnalyticsConfiguration";
	const _PBAR = "PutBucketAbacRequest";
	const _PBARu = "PutBucketAclRequest";
	const _PBAu = "PutBucketAcl";
	const _PBC = "PutBucketCors";
	const _PBCR = "PutBucketCorsRequest";
	const _PBE = "PutBucketEncryption";
	const _PBER = "PutBucketEncryptionRequest";
	const _PBIC = "PutBucketInventoryConfiguration";
	const _PBICR = "PutBucketInventoryConfigurationRequest";
	const _PBITC = "PutBucketIntelligentTieringConfiguration";
	const _PBITCR = "PutBucketIntelligentTieringConfigurationRequest";
	const _PBL = "PutBucketLogging";
	const _PBLC = "PutBucketLifecycleConfiguration";
	const _PBLCO = "PutBucketLifecycleConfigurationOutput";
	const _PBLCR = "PutBucketLifecycleConfigurationRequest";
	const _PBLR = "PutBucketLoggingRequest";
	const _PBMC = "PutBucketMetricsConfiguration";
	const _PBMCR = "PutBucketMetricsConfigurationRequest";
	const _PBNC = "PutBucketNotificationConfiguration";
	const _PBNCR = "PutBucketNotificationConfigurationRequest";
	const _PBOC = "PutBucketOwnershipControls";
	const _PBOCR = "PutBucketOwnershipControlsRequest";
	const _PBP = "PutBucketPolicy";
	const _PBPR = "PutBucketPolicyRequest";
	const _PBR = "PutBucketReplication";
	const _PBRP = "PutBucketRequestPayment";
	const _PBRPR = "PutBucketRequestPaymentRequest";
	const _PBRR = "PutBucketReplicationRequest";
	const _PBT = "PutBucketTagging";
	const _PBTR = "PutBucketTaggingRequest";
	const _PBV = "PutBucketVersioning";
	const _PBVR = "PutBucketVersioningRequest";
	const _PBW = "PutBucketWebsite";
	const _PBWR = "PutBucketWebsiteRequest";
	const _PC = "PartsCount";
	const _PDS = "PartitionDateSource";
	const _PE = "ProgressEvent";
	const _PI = "ParquetInput";
	const _PL = "PartsList";
	const _PN = "PartNumber";
	const _PNM = "PartNumberMarker";
	const _PO = "PutObject";
	const _POA = "PutObjectAcl";
	const _POAO = "PutObjectAclOutput";
	const _POAR = "PutObjectAclRequest";
	const _POLC = "PutObjectLockConfiguration";
	const _POLCO = "PutObjectLockConfigurationOutput";
	const _POLCR = "PutObjectLockConfigurationRequest";
	const _POLH = "PutObjectLegalHold";
	const _POLHO = "PutObjectLegalHoldOutput";
	const _POLHR = "PutObjectLegalHoldRequest";
	const _POO = "PutObjectOutput";
	const _POR = "PutObjectRequest";
	const _PORO = "PutObjectRetentionOutput";
	const _PORR = "PutObjectRetentionRequest";
	const _PORu = "PutObjectRetention";
	const _POT = "PutObjectTagging";
	const _POTO = "PutObjectTaggingOutput";
	const _POTR = "PutObjectTaggingRequest";
	const _PP = "PartitionedPrefix";
	const _PPAB = "PutPublicAccessBlock";
	const _PPABR = "PutPublicAccessBlockRequest";
	const _PS = "PolicyStatus";
	const _Pa = "Parts";
	const _Par = "Part";
	const _Parq = "Parquet";
	const _Pay = "Payer";
	const _Payl = "Payload";
	const _Pe = "Permission";
	const _Po = "Policy";
	const _Pr = "Progress";
	const _Pri = "Priority";
	const _Pro = "Protocol";
	const _Q = "Quiet";
	const _QA = "QueueArn";
	const _QC = "QuoteCharacter";
	const _QCL = "QueueConfigurationList";
	const _QCu = "QueueConfigurations";
	const _QCue = "QueueConfiguration";
	const _QEC = "QuoteEscapeCharacter";
	const _QF = "QuoteFields";
	const _Qu = "Queue";
	const _R = "Rules";
	const _RART = "RedirectAllRequestsTo";
	const _RC = "RequestCharged";
	const _RCC = "ResponseCacheControl";
	const _RCD = "ResponseContentDisposition";
	const _RCE = "ResponseContentEncoding";
	const _RCL = "ResponseContentLanguage";
	const _RCT = "ResponseContentType";
	const _RCe = "ReplicationConfiguration";
	const _RD = "RecordDelimiter";
	const _RE = "ResponseExpires";
	const _RED = "RestoreExpiryDate";
	const _REe = "RecordExpiration";
	const _REec = "RecordsEvent";
	const _RKKID = "ReplicaKmsKeyID";
	const _RKPW = "ReplaceKeyPrefixWith";
	const _RKW = "ReplaceKeyWith";
	const _RM = "ReplicaModifications";
	const _RO = "RenameObject";
	const _ROO = "RenameObjectOutput";
	const _ROOe = "RestoreObjectOutput";
	const _ROP = "RestoreOutputPath";
	const _ROR = "RenameObjectRequest";
	const _RORe = "RestoreObjectRequest";
	const _ROe = "RestoreObject";
	const _RP = "RequestPayer";
	const _RPB = "RestrictPublicBuckets";
	const _RPC = "RequestPaymentConfiguration";
	const _RPe = "RequestProgress";
	const _RR = "RoutingRules";
	const _RRAO = "ReplicationRuleAndOperator";
	const _RRF = "ReplicationRuleFilter";
	const _RRe = "ReplicationRule";
	const _RRep = "ReplicationRules";
	const _RReq = "RequestRoute";
	const _RRes = "RestoreRequest";
	const _RRo = "RoutingRule";
	const _RS = "ReplicationStatus";
	const _RSe = "RestoreStatus";
	const _RSen = "RenameSource";
	const _RT = "ReplicationTime";
	const _RTV = "ReplicationTimeValue";
	const _RTe = "RequestToken";
	const _RUD = "RetainUntilDate";
	const _Ra = "Range";
	const _Re = "Restore";
	const _Rec = "Records";
	const _Red = "Redirect";
	const _Ret = "Retention";
	const _Ro = "Role";
	const _Ru = "Rule";
	const _S = "Status";
	const _SA = "StartAfter";
	const _SAK = "SecretAccessKey";
	const _SAs = "SseAlgorithm";
	const _SB = "StreamingBlob";
	const _SBD = "S3BucketDestination";
	const _SC = "StorageClass";
	const _SCA = "StorageClassAnalysis";
	const _SCADE = "StorageClassAnalysisDataExport";
	const _SCV = "SessionCredentialValue";
	const _SCe = "SessionCredentials";
	const _SCt = "StatusCode";
	const _SDV = "SkipDestinationValidation";
	const _SE = "StatsEvent";
	const _SIM = "SourceIfMatch";
	const _SIMS = "SourceIfModifiedSince";
	const _SINM = "SourceIfNoneMatch";
	const _SIUS = "SourceIfUnmodifiedSince";
	const _SK = "SSE-KMS";
	const _SKEO = "SseKmsEncryptedObjects";
	const _SKF = "S3KeyFilter";
	const _SKe = "S3Key";
	const _SL = "S3Location";
	const _SM = "SessionMode";
	const _SOC = "SelectObjectContent";
	const _SOCES = "SelectObjectContentEventStream";
	const _SOCO = "SelectObjectContentOutput";
	const _SOCR = "SelectObjectContentRequest";
	const _SP = "SelectParameters";
	const _SPi = "SimplePrefix";
	const _SR = "ScanRange";
	const _SS = "SSE-S3";
	const _SSC = "SourceSelectionCriteria";
	const _SSE = "ServerSideEncryption";
	const _SSEA = "SSEAlgorithm";
	const _SSEBD = "ServerSideEncryptionByDefault";
	const _SSEC = "ServerSideEncryptionConfiguration";
	const _SSECA = "SSECustomerAlgorithm";
	const _SSECK = "SSECustomerKey";
	const _SSECKMD = "SSECustomerKeyMD5";
	const _SSEKMS = "SSEKMS";
	const _SSEKMSE = "SSEKMSEncryption";
	const _SSEKMSEC = "SSEKMSEncryptionContext";
	const _SSEKMSKI = "SSEKMSKeyId";
	const _SSER = "ServerSideEncryptionRule";
	const _SSERe = "ServerSideEncryptionRules";
	const _SSES = "SSES3";
	const _ST = "SessionToken";
	const _STD = "S3TablesDestination";
	const _STDR = "S3TablesDestinationResult";
	const _S_ = "S3";
	const _Sc = "Schedule";
	const _Si = "Size";
	const _St = "Start";
	const _Sta = "Stats";
	const _Su = "Suffix";
	const _T = "Tags";
	const _TA = "TableArn";
	const _TAo = "TopicArn";
	const _TB = "TargetBucket";
	const _TBA = "TableBucketArn";
	const _TBT = "TableBucketType";
	const _TC = "TagCount";
	const _TCL = "TopicConfigurationList";
	const _TCo = "TopicConfigurations";
	const _TCop = "TopicConfiguration";
	const _TD = "TaggingDirective";
	const _TDMOS = "TransitionDefaultMinimumObjectSize";
	const _TG = "TargetGrants";
	const _TGa = "TargetGrant";
	const _TL = "TieringList";
	const _TLr = "TransitionList";
	const _TMP = "TooManyParts";
	const _TN = "TableNamespace";
	const _TNa = "TableName";
	const _TOKF = "TargetObjectKeyFormat";
	const _TP = "TargetPrefix";
	const _TPC = "TotalPartsCount";
	const _TS = "TagSet";
	const _TSa = "TableStatus";
	const _Ta = "Tag";
	const _Tag = "Tagging";
	const _Ti = "Tier";
	const _Tie = "Tierings";
	const _Tier = "Tiering";
	const _Tim = "Time";
	const _To = "Token";
	const _Top = "Topic";
	const _Tr = "Transitions";
	const _Tra = "Transition";
	const _Ty = "Type";
	const _U = "Uploads";
	const _UBMITC = "UpdateBucketMetadataInventoryTableConfiguration";
	const _UBMITCR = "UpdateBucketMetadataInventoryTableConfigurationRequest";
	const _UBMJTC = "UpdateBucketMetadataJournalTableConfiguration";
	const _UBMJTCR = "UpdateBucketMetadataJournalTableConfigurationRequest";
	const _UI = "UploadId";
	const _UIM = "UploadIdMarker";
	const _UM = "UserMetadata";
	const _UOE = "UpdateObjectEncryption";
	const _UOER = "UpdateObjectEncryptionRequest";
	const _UOERp = "UpdateObjectEncryptionResponse";
	const _UP = "UploadPart";
	const _UPC = "UploadPartCopy";
	const _UPCO = "UploadPartCopyOutput";
	const _UPCR = "UploadPartCopyRequest";
	const _UPO = "UploadPartOutput";
	const _UPR = "UploadPartRequest";
	const _URI = "URI";
	const _Up = "Upload";
	const _V = "Value";
	const _VC = "VersioningConfiguration";
	const _VI = "VersionId";
	const _VIM = "VersionIdMarker";
	const _Ve = "Versions";
	const _Ver = "Version";
	const _WC = "WebsiteConfiguration";
	const _WGOR = "WriteGetObjectResponse";
	const _WGORR = "WriteGetObjectResponseRequest";
	const _WOB = "WriteOffsetBytes";
	const _WRL = "WebsiteRedirectLocation";
	const _Y = "Years";
	const _ar = "accept-ranges";
	const _br = "bucket-region";
	const _c = "client";
	const _ct = "continuation-token";
	const _d = "delimiter";
	const _e = "error";
	const _eP = "eventPayload";
	const _en = "endpoint";
	const _et = "encoding-type";
	const _fo = "fetch-owner";
	const _h = "http";
	const _hC = "httpChecksum";
	const _hE = "httpError";
	const _hH = "httpHeader";
	const _hL = "hostLabel";
	const _hP = "httpPayload";
	const _hPH = "httpPrefixHeaders";
	const _hQ = "httpQuery";
	const _hi = "http://www.w3.org/2001/XMLSchema-instance";
	const _i = "id";
	const _iT = "idempotencyToken";
	const _km = "key-marker";
	const _m = "marker";
	const _mb = "max-buckets";
	const _mdb = "max-directory-buckets";
	const _mk = "max-keys";
	const _mp = "max-parts";
	const _mu = "max-uploads";
	const _p = "prefix";
	const _pN = "partNumber";
	const _pnm = "part-number-marker";
	const _rcc = "response-cache-control";
	const _rcd = "response-content-disposition";
	const _rce = "response-content-encoding";
	const _rcl = "response-content-language";
	const _rct = "response-content-type";
	const _re = "response-expires";
	const _s = "smithy.ts.sdk.synthetic.com.amazonaws.s3";
	const _sa = "start-after";
	const _st = "streaming";
	const _uI = "uploadId";
	const _uim = "upload-id-marker";
	const _vI = "versionId";
	const _vim = "version-id-marker";
	const _x = "xsi";
	const _xA = "xmlAttribute";
	const _xF = "xmlFlattened";
	const _xN = "xmlName";
	const _xNm = "xmlNamespace";
	const _xaa = "x-amz-acl";
	const _xaad = "x-amz-abort-date";
	const _xaapa = "x-amz-access-point-alias";
	const _xaari = "x-amz-abort-rule-id";
	const _xaas = "x-amz-archive-status";
	const _xaba = "x-amz-bucket-arn";
	const _xabgr = "x-amz-bypass-governance-retention";
	const _xabln = "x-amz-bucket-location-name";
	const _xablt = "x-amz-bucket-location-type";
	const _xabn = "x-amz-bucket-namespace";
	const _xabole = "x-amz-bucket-object-lock-enabled";
	const _xabolt = "x-amz-bucket-object-lock-token";
	const _xabr = "x-amz-bucket-region";
	const _xaca = "x-amz-checksum-algorithm";
	const _xacc = "x-amz-checksum-crc32";
	const _xacc_ = "x-amz-checksum-crc32c";
	const _xacc__ = "x-amz-checksum-crc64nvme";
	const _xacm = "x-amz-checksum-md5";
	const _xacm_ = "x-amz-checksum-mode";
	const _xacrsba = "x-amz-confirm-remove-self-bucket-access";
	const _xacs = "x-amz-checksum-sha1";
	const _xacs_ = "x-amz-checksum-sha256";
	const _xacs__ = "x-amz-checksum-sha512";
	const _xacs___ = "x-amz-copy-source";
	const _xacsim = "x-amz-copy-source-if-match";
	const _xacsims = "x-amz-copy-source-if-modified-since";
	const _xacsinm = "x-amz-copy-source-if-none-match";
	const _xacsius = "x-amz-copy-source-if-unmodified-since";
	const _xacsm = "x-amz-create-session-mode";
	const _xacsr = "x-amz-copy-source-range";
	const _xacssseca = "x-amz-copy-source-server-side-encryption-customer-algorithm";
	const _xacssseck = "x-amz-copy-source-server-side-encryption-customer-key";
	const _xacssseckM = "x-amz-copy-source-server-side-encryption-customer-key-MD5";
	const _xacsvi = "x-amz-copy-source-version-id";
	const _xact = "x-amz-checksum-type";
	const _xact_ = "x-amz-client-token";
	const _xacx = "x-amz-checksum-xxhash64";
	const _xacx_ = "x-amz-checksum-xxhash3";
	const _xacx__ = "x-amz-checksum-xxhash128";
	const _xadm = "x-amz-delete-marker";
	const _xae = "x-amz-expiration";
	const _xaebo = "x-amz-expected-bucket-owner";
	const _xafec = "x-amz-fwd-error-code";
	const _xafem = "x-amz-fwd-error-message";
	const _xafhCC = "x-amz-fwd-header-Cache-Control";
	const _xafhCD = "x-amz-fwd-header-Content-Disposition";
	const _xafhCE = "x-amz-fwd-header-Content-Encoding";
	const _xafhCL = "x-amz-fwd-header-Content-Language";
	const _xafhCR = "x-amz-fwd-header-Content-Range";
	const _xafhCT = "x-amz-fwd-header-Content-Type";
	const _xafhE = "x-amz-fwd-header-ETag";
	const _xafhE_ = "x-amz-fwd-header-Expires";
	const _xafhLM = "x-amz-fwd-header-Last-Modified";
	const _xafhar = "x-amz-fwd-header-accept-ranges";
	const _xafhxacc = "x-amz-fwd-header-x-amz-checksum-crc32";
	const _xafhxacc_ = "x-amz-fwd-header-x-amz-checksum-crc32c";
	const _xafhxacc__ = "x-amz-fwd-header-x-amz-checksum-crc64nvme";
	const _xafhxacm = "x-amz-fwd-header-x-amz-checksum-md5";
	const _xafhxacs = "x-amz-fwd-header-x-amz-checksum-sha1";
	const _xafhxacs_ = "x-amz-fwd-header-x-amz-checksum-sha256";
	const _xafhxacs__ = "x-amz-fwd-header-x-amz-checksum-sha512";
	const _xafhxacx = "x-amz-fwd-header-x-amz-checksum-xxhash64";
	const _xafhxacx_ = "x-amz-fwd-header-x-amz-checksum-xxhash3";
	const _xafhxacx__ = "x-amz-fwd-header-x-amz-checksum-xxhash128";
	const _xafhxadm = "x-amz-fwd-header-x-amz-delete-marker";
	const _xafhxae = "x-amz-fwd-header-x-amz-expiration";
	const _xafhxamm = "x-amz-fwd-header-x-amz-missing-meta";
	const _xafhxampc = "x-amz-fwd-header-x-amz-mp-parts-count";
	const _xafhxaollh = "x-amz-fwd-header-x-amz-object-lock-legal-hold";
	const _xafhxaolm = "x-amz-fwd-header-x-amz-object-lock-mode";
	const _xafhxaolrud = "x-amz-fwd-header-x-amz-object-lock-retain-until-date";
	const _xafhxar = "x-amz-fwd-header-x-amz-restore";
	const _xafhxarc = "x-amz-fwd-header-x-amz-request-charged";
	const _xafhxars = "x-amz-fwd-header-x-amz-replication-status";
	const _xafhxasc = "x-amz-fwd-header-x-amz-storage-class";
	const _xafhxasse = "x-amz-fwd-header-x-amz-server-side-encryption";
	const _xafhxasseakki = "x-amz-fwd-header-x-amz-server-side-encryption-aws-kms-key-id";
	const _xafhxassebke = "x-amz-fwd-header-x-amz-server-side-encryption-bucket-key-enabled";
	const _xafhxasseca = "x-amz-fwd-header-x-amz-server-side-encryption-customer-algorithm";
	const _xafhxasseckM = "x-amz-fwd-header-x-amz-server-side-encryption-customer-key-MD5";
	const _xafhxatc = "x-amz-fwd-header-x-amz-tagging-count";
	const _xafhxavi = "x-amz-fwd-header-x-amz-version-id";
	const _xafs = "x-amz-fwd-status";
	const _xagfc = "x-amz-grant-full-control";
	const _xagr = "x-amz-grant-read";
	const _xagra = "x-amz-grant-read-acp";
	const _xagw = "x-amz-grant-write";
	const _xagwa = "x-amz-grant-write-acp";
	const _xaimit = "x-amz-if-match-initiated-time";
	const _xaimlmt = "x-amz-if-match-last-modified-time";
	const _xaims = "x-amz-if-match-size";
	const _xam = "x-amz-meta-";
	const _xam_ = "x-amz-mfa";
	const _xamd = "x-amz-metadata-directive";
	const _xamm = "x-amz-missing-meta";
	const _xamos = "x-amz-mp-object-size";
	const _xamp = "x-amz-max-parts";
	const _xampc = "x-amz-mp-parts-count";
	const _xaoa = "x-amz-object-attributes";
	const _xaollh = "x-amz-object-lock-legal-hold";
	const _xaolm = "x-amz-object-lock-mode";
	const _xaolrud = "x-amz-object-lock-retain-until-date";
	const _xaoo = "x-amz-object-ownership";
	const _xaooa = "x-amz-optional-object-attributes";
	const _xaos = "x-amz-object-size";
	const _xapnm = "x-amz-part-number-marker";
	const _xar = "x-amz-restore";
	const _xarc = "x-amz-request-charged";
	const _xarop = "x-amz-restore-output-path";
	const _xarp = "x-amz-request-payer";
	const _xarr = "x-amz-request-route";
	const _xars = "x-amz-replication-status";
	const _xars_ = "x-amz-rename-source";
	const _xarsim = "x-amz-rename-source-if-match";
	const _xarsims = "x-amz-rename-source-if-modified-since";
	const _xarsinm = "x-amz-rename-source-if-none-match";
	const _xarsius = "x-amz-rename-source-if-unmodified-since";
	const _xart = "x-amz-request-token";
	const _xasc = "x-amz-storage-class";
	const _xasca = "x-amz-sdk-checksum-algorithm";
	const _xasdv = "x-amz-skip-destination-validation";
	const _xasebo = "x-amz-source-expected-bucket-owner";
	const _xasse = "x-amz-server-side-encryption";
	const _xasseakki = "x-amz-server-side-encryption-aws-kms-key-id";
	const _xassebke = "x-amz-server-side-encryption-bucket-key-enabled";
	const _xassec = "x-amz-server-side-encryption-context";
	const _xasseca = "x-amz-server-side-encryption-customer-algorithm";
	const _xasseck = "x-amz-server-side-encryption-customer-key";
	const _xasseckM = "x-amz-server-side-encryption-customer-key-MD5";
	const _xat = "x-amz-tagging";
	const _xatc = "x-amz-tagging-count";
	const _xatd = "x-amz-tagging-directive";
	const _xatdmos = "x-amz-transition-default-minimum-object-size";
	const _xavi = "x-amz-version-id";
	const _xawob = "x-amz-write-offset-bytes";
	const _xawrl = "x-amz-website-redirect-location";
	const _xs = "xsi:type";
	const n0 = "com.amazonaws.s3";
	const schema_1 = (init_schema(), __toCommonJS(schema_exports));
	const errors_1 = require_errors();
	const S3ServiceException_1 = require_S3ServiceException();
	const _s_registry = schema_1.TypeRegistry.for(_s);
	exports.S3ServiceException$ = [
		-3,
		_s,
		"S3ServiceException",
		0,
		[],
		[]
	];
	_s_registry.registerError(exports.S3ServiceException$, S3ServiceException_1.S3ServiceException);
	const n0_registry = schema_1.TypeRegistry.for(n0);
	exports.AccessDenied$ = [
		-3,
		n0,
		_AD,
		{
			[_e]: _c,
			[_hE]: 403
		},
		[],
		[]
	];
	n0_registry.registerError(exports.AccessDenied$, errors_1.AccessDenied);
	exports.BucketAlreadyExists$ = [
		-3,
		n0,
		_BAE,
		{
			[_e]: _c,
			[_hE]: 409
		},
		[],
		[]
	];
	n0_registry.registerError(exports.BucketAlreadyExists$, errors_1.BucketAlreadyExists);
	exports.BucketAlreadyOwnedByYou$ = [
		-3,
		n0,
		_BAOBY,
		{
			[_e]: _c,
			[_hE]: 409
		},
		[],
		[]
	];
	n0_registry.registerError(exports.BucketAlreadyOwnedByYou$, errors_1.BucketAlreadyOwnedByYou);
	exports.EncryptionTypeMismatch$ = [
		-3,
		n0,
		_ETM,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[],
		[]
	];
	n0_registry.registerError(exports.EncryptionTypeMismatch$, errors_1.EncryptionTypeMismatch);
	exports.IdempotencyParameterMismatch$ = [
		-3,
		n0,
		_IPM,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[],
		[]
	];
	n0_registry.registerError(exports.IdempotencyParameterMismatch$, errors_1.IdempotencyParameterMismatch);
	exports.InvalidObjectState$ = [
		-3,
		n0,
		_IOS,
		{
			[_e]: _c,
			[_hE]: 403
		},
		[_SC, _AT],
		[0, 0]
	];
	n0_registry.registerError(exports.InvalidObjectState$, errors_1.InvalidObjectState);
	exports.InvalidRequest$ = [
		-3,
		n0,
		_IR,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[],
		[]
	];
	n0_registry.registerError(exports.InvalidRequest$, errors_1.InvalidRequest);
	exports.InvalidWriteOffset$ = [
		-3,
		n0,
		_IWO,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[],
		[]
	];
	n0_registry.registerError(exports.InvalidWriteOffset$, errors_1.InvalidWriteOffset);
	exports.NoSuchBucket$ = [
		-3,
		n0,
		_NSB,
		{
			[_e]: _c,
			[_hE]: 404
		},
		[],
		[]
	];
	n0_registry.registerError(exports.NoSuchBucket$, errors_1.NoSuchBucket);
	exports.NoSuchKey$ = [
		-3,
		n0,
		_NSK,
		{
			[_e]: _c,
			[_hE]: 404
		},
		[],
		[]
	];
	n0_registry.registerError(exports.NoSuchKey$, errors_1.NoSuchKey);
	exports.NoSuchUpload$ = [
		-3,
		n0,
		_NSU,
		{
			[_e]: _c,
			[_hE]: 404
		},
		[],
		[]
	];
	n0_registry.registerError(exports.NoSuchUpload$, errors_1.NoSuchUpload);
	exports.NotFound$ = [
		-3,
		n0,
		_NF,
		{ [_e]: _c },
		[],
		[]
	];
	n0_registry.registerError(exports.NotFound$, errors_1.NotFound);
	exports.ObjectAlreadyInActiveTierError$ = [
		-3,
		n0,
		_OAIATE,
		{
			[_e]: _c,
			[_hE]: 403
		},
		[],
		[]
	];
	n0_registry.registerError(exports.ObjectAlreadyInActiveTierError$, errors_1.ObjectAlreadyInActiveTierError);
	exports.ObjectNotInActiveTierError$ = [
		-3,
		n0,
		_ONIATE,
		{
			[_e]: _c,
			[_hE]: 403
		},
		[],
		[]
	];
	n0_registry.registerError(exports.ObjectNotInActiveTierError$, errors_1.ObjectNotInActiveTierError);
	exports.TooManyParts$ = [
		-3,
		n0,
		_TMP,
		{
			[_e]: _c,
			[_hE]: 400
		},
		[],
		[]
	];
	n0_registry.registerError(exports.TooManyParts$, errors_1.TooManyParts);
	exports.errorTypeRegistries = [_s_registry, n0_registry];
	var CopySourceSSECustomerKey = [
		0,
		n0,
		_CSSSECK,
		8,
		0
	];
	var NonEmptyKmsKeyArnString = [
		0,
		n0,
		_NEKKAS,
		8,
		0
	];
	var SessionCredentialValue = [
		0,
		n0,
		_SCV,
		8,
		0
	];
	var SSECustomerKey = [
		0,
		n0,
		_SSECK,
		8,
		0
	];
	var SSEKMSEncryptionContext = [
		0,
		n0,
		_SSEKMSEC,
		8,
		0
	];
	var SSEKMSKeyId = [
		0,
		n0,
		_SSEKMSKI,
		8,
		0
	];
	var StreamingBlob = [
		0,
		n0,
		_SB,
		{ [_st]: 1 },
		42
	];
	exports.AbacStatus$ = [
		3,
		n0,
		_AS,
		0,
		[_S],
		[0]
	];
	exports.AbortIncompleteMultipartUpload$ = [
		3,
		n0,
		_AIMU,
		0,
		[_DAI],
		[1]
	];
	exports.AbortMultipartUploadOutput$ = [
		3,
		n0,
		_AMUO,
		0,
		[_RC],
		[[0, { [_hH]: _xarc }]]
	];
	exports.AbortMultipartUploadRequest$ = [
		3,
		n0,
		_AMUR,
		0,
		[
			_B,
			_K,
			_UI,
			_RP,
			_EBO,
			_IMIT
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hQ]: _uI }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }],
			[6, { [_hH]: _xaimit }]
		],
		3
	];
	exports.AccelerateConfiguration$ = [
		3,
		n0,
		_AC,
		0,
		[_S],
		[0]
	];
	exports.AccessControlPolicy$ = [
		3,
		n0,
		_ACP,
		0,
		[_G, _O],
		[[() => Grants, { [_xN]: _ACL }], () => exports.Owner$]
	];
	exports.AccessControlTranslation$ = [
		3,
		n0,
		_ACT,
		0,
		[_O],
		[0],
		1
	];
	exports.AnalyticsAndOperator$ = [
		3,
		n0,
		_AAO,
		0,
		[_P, _T],
		[0, [() => TagSet, {
			[_xF]: 1,
			[_xN]: _Ta
		}]]
	];
	exports.AnalyticsConfiguration$ = [
		3,
		n0,
		_ACn,
		0,
		[
			_I,
			_SCA,
			_F
		],
		[
			0,
			() => exports.StorageClassAnalysis$,
			[() => exports.AnalyticsFilter$, 0]
		],
		2
	];
	exports.AnalyticsExportDestination$ = [
		3,
		n0,
		_AED,
		0,
		[_SBD],
		[() => exports.AnalyticsS3BucketDestination$],
		1
	];
	exports.AnalyticsS3BucketDestination$ = [
		3,
		n0,
		_ASBD,
		0,
		[
			_Fo,
			_B,
			_BAI,
			_P
		],
		[
			0,
			0,
			0,
			0
		],
		2
	];
	exports.BlockedEncryptionTypes$ = [
		3,
		n0,
		_BET,
		0,
		[_ET],
		[[() => EncryptionTypeList, { [_xF]: 1 }]]
	];
	exports.Bucket$ = [
		3,
		n0,
		_B,
		0,
		[
			_N,
			_CD,
			_BR,
			_BA
		],
		[
			0,
			4,
			0,
			0
		]
	];
	exports.BucketInfo$ = [
		3,
		n0,
		_BI,
		0,
		[_DR, _Ty],
		[0, 0]
	];
	exports.BucketLifecycleConfiguration$ = [
		3,
		n0,
		_BLC,
		0,
		[_R],
		[[() => LifecycleRules, {
			[_xF]: 1,
			[_xN]: _Ru
		}]],
		1
	];
	exports.BucketLoggingStatus$ = [
		3,
		n0,
		_BLS,
		0,
		[_LE],
		[[() => exports.LoggingEnabled$, 0]]
	];
	exports.Checksum$ = [
		3,
		n0,
		_C,
		0,
		[
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe,
			_CT
		],
		[
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0
		]
	];
	exports.CommonPrefix$ = [
		3,
		n0,
		_CP,
		0,
		[_P],
		[0]
	];
	exports.CompletedMultipartUpload$ = [
		3,
		n0,
		_CMU,
		0,
		[_Pa],
		[[() => CompletedPartList, {
			[_xF]: 1,
			[_xN]: _Par
		}]]
	];
	exports.CompletedPart$ = [
		3,
		n0,
		_CPo,
		0,
		[
			_ETa,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe,
			_PN
		],
		[
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			1
		]
	];
	exports.CompleteMultipartUploadOutput$ = [
		3,
		n0,
		_CMUO,
		{ [_xN]: _CMUR },
		[
			_L,
			_B,
			_K,
			_E,
			_ETa,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe,
			_CT,
			_SSE,
			_VI,
			_SSEKMSKI,
			_BKE,
			_RC
		],
		[
			0,
			0,
			0,
			[0, { [_hH]: _xae }],
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			[0, { [_hH]: _xasse }],
			[0, { [_hH]: _xavi }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[2, { [_hH]: _xassebke }],
			[0, { [_hH]: _xarc }]
		]
	];
	exports.CompleteMultipartUploadRequest$ = [
		3,
		n0,
		_CMURo,
		0,
		[
			_B,
			_K,
			_UI,
			_MU,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe,
			_CT,
			_MOS,
			_RP,
			_EBO,
			_IM,
			_INM,
			_SSECA,
			_SSECK,
			_SSECKMD
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hQ]: _uI }],
			[() => exports.CompletedMultipartUpload$, {
				[_hP]: 1,
				[_xN]: _CMUo
			}],
			[0, { [_hH]: _xacc }],
			[0, { [_hH]: _xacc_ }],
			[0, { [_hH]: _xacc__ }],
			[0, { [_hH]: _xacs }],
			[0, { [_hH]: _xacs_ }],
			[0, { [_hH]: _xacs__ }],
			[0, { [_hH]: _xacm }],
			[0, { [_hH]: _xacx }],
			[0, { [_hH]: _xacx_ }],
			[0, { [_hH]: _xacx__ }],
			[0, { [_hH]: _xact }],
			[1, { [_hH]: _xamos }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _IM_ }],
			[0, { [_hH]: _INM_ }],
			[0, { [_hH]: _xasseca }],
			[() => SSECustomerKey, { [_hH]: _xasseck }],
			[0, { [_hH]: _xasseckM }]
		],
		3
	];
	exports.Condition$ = [
		3,
		n0,
		_Co,
		0,
		[_HECRE, _KPE],
		[0, 0]
	];
	exports.ContinuationEvent$ = [
		3,
		n0,
		_CE,
		0,
		[],
		[]
	];
	exports.CopyObjectOutput$ = [
		3,
		n0,
		_COO,
		0,
		[
			_COR,
			_E,
			_CSVI,
			_VI,
			_SSE,
			_SSECA,
			_SSECKMD,
			_SSEKMSKI,
			_SSEKMSEC,
			_BKE,
			_RC
		],
		[
			[() => exports.CopyObjectResult$, 16],
			[0, { [_hH]: _xae }],
			[0, { [_hH]: _xacsvi }],
			[0, { [_hH]: _xavi }],
			[0, { [_hH]: _xasse }],
			[0, { [_hH]: _xasseca }],
			[0, { [_hH]: _xasseckM }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[() => SSEKMSEncryptionContext, { [_hH]: _xassec }],
			[2, { [_hH]: _xassebke }],
			[0, { [_hH]: _xarc }]
		]
	];
	exports.CopyObjectRequest$ = [
		3,
		n0,
		_CORo,
		0,
		[
			_B,
			_CS,
			_K,
			_ACL_,
			_CC,
			_CA,
			_CDo,
			_CEo,
			_CL,
			_CTo,
			_CSIM,
			_CSIMS,
			_CSINM,
			_CSIUS,
			_Ex,
			_GFC,
			_GR,
			_GRACP,
			_GWACP,
			_IM,
			_INM,
			_M,
			_MD,
			_TD,
			_SSE,
			_SC,
			_WRL,
			_SSECA,
			_SSECK,
			_SSECKMD,
			_SSEKMSKI,
			_SSEKMSEC,
			_BKE,
			_CSSSECA,
			_CSSSECK,
			_CSSSECKMD,
			_RP,
			_Tag,
			_OLM,
			_OLRUD,
			_OLLHS,
			_EBO,
			_ESBO
		],
		[
			[0, 1],
			[0, { [_hH]: _xacs___ }],
			[0, 1],
			[0, { [_hH]: _xaa }],
			[0, { [_hH]: _CC_ }],
			[0, { [_hH]: _xaca }],
			[0, { [_hH]: _CD_ }],
			[0, { [_hH]: _CE_ }],
			[0, { [_hH]: _CL_ }],
			[0, { [_hH]: _CT_ }],
			[0, { [_hH]: _xacsim }],
			[4, { [_hH]: _xacsims }],
			[0, { [_hH]: _xacsinm }],
			[4, { [_hH]: _xacsius }],
			[4, { [_hH]: _Ex }],
			[0, { [_hH]: _xagfc }],
			[0, { [_hH]: _xagr }],
			[0, { [_hH]: _xagra }],
			[0, { [_hH]: _xagwa }],
			[0, { [_hH]: _IM_ }],
			[0, { [_hH]: _INM_ }],
			[128, { [_hPH]: _xam }],
			[0, { [_hH]: _xamd }],
			[0, { [_hH]: _xatd }],
			[0, { [_hH]: _xasse }],
			[0, { [_hH]: _xasc }],
			[0, { [_hH]: _xawrl }],
			[0, { [_hH]: _xasseca }],
			[() => SSECustomerKey, { [_hH]: _xasseck }],
			[0, { [_hH]: _xasseckM }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[() => SSEKMSEncryptionContext, { [_hH]: _xassec }],
			[2, { [_hH]: _xassebke }],
			[0, { [_hH]: _xacssseca }],
			[() => CopySourceSSECustomerKey, { [_hH]: _xacssseck }],
			[0, { [_hH]: _xacssseckM }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xat }],
			[0, { [_hH]: _xaolm }],
			[5, { [_hH]: _xaolrud }],
			[0, { [_hH]: _xaollh }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xasebo }]
		],
		3
	];
	exports.CopyObjectResult$ = [
		3,
		n0,
		_COR,
		0,
		[
			_ETa,
			_LM,
			_CT,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe
		],
		[
			0,
			4,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0
		]
	];
	exports.CopyPartResult$ = [
		3,
		n0,
		_CPR,
		0,
		[
			_ETa,
			_LM,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe
		],
		[
			0,
			4,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0
		]
	];
	exports.CORSConfiguration$ = [
		3,
		n0,
		_CORSC,
		0,
		[_CORSR],
		[[() => CORSRules, {
			[_xF]: 1,
			[_xN]: _CORSRu
		}]],
		1
	];
	exports.CORSRule$ = [
		3,
		n0,
		_CORSRu,
		0,
		[
			_AM,
			_AO,
			_ID,
			_AH,
			_EH,
			_MAS
		],
		[
			[64, {
				[_xF]: 1,
				[_xN]: _AMl
			}],
			[64, {
				[_xF]: 1,
				[_xN]: _AOl
			}],
			0,
			[64, {
				[_xF]: 1,
				[_xN]: _AHl
			}],
			[64, {
				[_xF]: 1,
				[_xN]: _EHx
			}],
			1
		],
		2
	];
	exports.CreateBucketConfiguration$ = [
		3,
		n0,
		_CBC,
		0,
		[
			_LC,
			_L,
			_B,
			_T
		],
		[
			0,
			() => exports.LocationInfo$,
			() => exports.BucketInfo$,
			[() => TagSet, 0]
		]
	];
	exports.CreateBucketMetadataConfigurationRequest$ = [
		3,
		n0,
		_CBMCR,
		0,
		[
			_B,
			_MC,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.MetadataConfiguration$, {
				[_hP]: 1,
				[_xN]: _MC
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.CreateBucketMetadataTableConfigurationRequest$ = [
		3,
		n0,
		_CBMTCR,
		0,
		[
			_B,
			_MTC,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.MetadataTableConfiguration$, {
				[_hP]: 1,
				[_xN]: _MTC
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.CreateBucketOutput$ = [
		3,
		n0,
		_CBO,
		0,
		[_L, _BA],
		[[0, { [_hH]: _L }], [0, { [_hH]: _xaba }]]
	];
	exports.CreateBucketRequest$ = [
		3,
		n0,
		_CBR,
		0,
		[
			_B,
			_ACL_,
			_CBC,
			_GFC,
			_GR,
			_GRACP,
			_GW,
			_GWACP,
			_OLEFB,
			_OO,
			_BN
		],
		[
			[0, 1],
			[0, { [_hH]: _xaa }],
			[() => exports.CreateBucketConfiguration$, {
				[_hP]: 1,
				[_xN]: _CBC
			}],
			[0, { [_hH]: _xagfc }],
			[0, { [_hH]: _xagr }],
			[0, { [_hH]: _xagra }],
			[0, { [_hH]: _xagw }],
			[0, { [_hH]: _xagwa }],
			[2, { [_hH]: _xabole }],
			[0, { [_hH]: _xaoo }],
			[0, { [_hH]: _xabn }]
		],
		1
	];
	exports.CreateMultipartUploadOutput$ = [
		3,
		n0,
		_CMUOr,
		{ [_xN]: _IMUR },
		[
			_ADb,
			_ARI,
			_B,
			_K,
			_UI,
			_SSE,
			_SSECA,
			_SSECKMD,
			_SSEKMSKI,
			_SSEKMSEC,
			_BKE,
			_RC,
			_CA,
			_CT
		],
		[
			[4, { [_hH]: _xaad }],
			[0, { [_hH]: _xaari }],
			[0, { [_xN]: _B }],
			0,
			0,
			[0, { [_hH]: _xasse }],
			[0, { [_hH]: _xasseca }],
			[0, { [_hH]: _xasseckM }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[() => SSEKMSEncryptionContext, { [_hH]: _xassec }],
			[2, { [_hH]: _xassebke }],
			[0, { [_hH]: _xarc }],
			[0, { [_hH]: _xaca }],
			[0, { [_hH]: _xact }]
		]
	];
	exports.CreateMultipartUploadRequest$ = [
		3,
		n0,
		_CMURr,
		0,
		[
			_B,
			_K,
			_ACL_,
			_CC,
			_CDo,
			_CEo,
			_CL,
			_CTo,
			_Ex,
			_GFC,
			_GR,
			_GRACP,
			_GWACP,
			_M,
			_SSE,
			_SC,
			_WRL,
			_SSECA,
			_SSECK,
			_SSECKMD,
			_SSEKMSKI,
			_SSEKMSEC,
			_BKE,
			_RP,
			_Tag,
			_OLM,
			_OLRUD,
			_OLLHS,
			_EBO,
			_CA,
			_CT
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hH]: _xaa }],
			[0, { [_hH]: _CC_ }],
			[0, { [_hH]: _CD_ }],
			[0, { [_hH]: _CE_ }],
			[0, { [_hH]: _CL_ }],
			[0, { [_hH]: _CT_ }],
			[4, { [_hH]: _Ex }],
			[0, { [_hH]: _xagfc }],
			[0, { [_hH]: _xagr }],
			[0, { [_hH]: _xagra }],
			[0, { [_hH]: _xagwa }],
			[128, { [_hPH]: _xam }],
			[0, { [_hH]: _xasse }],
			[0, { [_hH]: _xasc }],
			[0, { [_hH]: _xawrl }],
			[0, { [_hH]: _xasseca }],
			[() => SSECustomerKey, { [_hH]: _xasseck }],
			[0, { [_hH]: _xasseckM }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[() => SSEKMSEncryptionContext, { [_hH]: _xassec }],
			[2, { [_hH]: _xassebke }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xat }],
			[0, { [_hH]: _xaolm }],
			[5, { [_hH]: _xaolrud }],
			[0, { [_hH]: _xaollh }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xaca }],
			[0, { [_hH]: _xact }]
		],
		2
	];
	exports.CreateSessionOutput$ = [
		3,
		n0,
		_CSO,
		{ [_xN]: _CSR },
		[
			_Cr,
			_SSE,
			_SSEKMSKI,
			_SSEKMSEC,
			_BKE
		],
		[
			[() => exports.SessionCredentials$, { [_xN]: _Cr }],
			[0, { [_hH]: _xasse }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[() => SSEKMSEncryptionContext, { [_hH]: _xassec }],
			[2, { [_hH]: _xassebke }]
		],
		1
	];
	exports.CreateSessionRequest$ = [
		3,
		n0,
		_CSRr,
		0,
		[
			_B,
			_SM,
			_SSE,
			_SSEKMSKI,
			_SSEKMSEC,
			_BKE
		],
		[
			[0, 1],
			[0, { [_hH]: _xacsm }],
			[0, { [_hH]: _xasse }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[() => SSEKMSEncryptionContext, { [_hH]: _xassec }],
			[2, { [_hH]: _xassebke }]
		],
		1
	];
	exports.CSVInput$ = [
		3,
		n0,
		_CSVIn,
		0,
		[
			_FHI,
			_Com,
			_QEC,
			_RD,
			_FD,
			_QC,
			_AQRD
		],
		[
			0,
			0,
			0,
			0,
			0,
			0,
			2
		]
	];
	exports.CSVOutput$ = [
		3,
		n0,
		_CSVO,
		0,
		[
			_QF,
			_QEC,
			_RD,
			_FD,
			_QC
		],
		[
			0,
			0,
			0,
			0,
			0
		]
	];
	exports.DefaultRetention$ = [
		3,
		n0,
		_DRe,
		0,
		[
			_Mo,
			_D,
			_Y
		],
		[
			0,
			1,
			1
		]
	];
	exports.Delete$ = [
		3,
		n0,
		_De,
		0,
		[_Ob, _Q],
		[[() => ObjectIdentifierList, {
			[_xF]: 1,
			[_xN]: _Obj
		}], 2],
		1
	];
	exports.DeleteBucketAnalyticsConfigurationRequest$ = [
		3,
		n0,
		_DBACR,
		0,
		[
			_B,
			_I,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.DeleteBucketCorsRequest$ = [
		3,
		n0,
		_DBCR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.DeleteBucketEncryptionRequest$ = [
		3,
		n0,
		_DBER,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.DeleteBucketIntelligentTieringConfigurationRequest$ = [
		3,
		n0,
		_DBITCR,
		0,
		[
			_B,
			_I,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.DeleteBucketInventoryConfigurationRequest$ = [
		3,
		n0,
		_DBICR,
		0,
		[
			_B,
			_I,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.DeleteBucketLifecycleRequest$ = [
		3,
		n0,
		_DBLR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.DeleteBucketMetadataConfigurationRequest$ = [
		3,
		n0,
		_DBMCR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.DeleteBucketMetadataTableConfigurationRequest$ = [
		3,
		n0,
		_DBMTCR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.DeleteBucketMetricsConfigurationRequest$ = [
		3,
		n0,
		_DBMCRe,
		0,
		[
			_B,
			_I,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.DeleteBucketOwnershipControlsRequest$ = [
		3,
		n0,
		_DBOCR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.DeleteBucketPolicyRequest$ = [
		3,
		n0,
		_DBPR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.DeleteBucketReplicationRequest$ = [
		3,
		n0,
		_DBRR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.DeleteBucketRequest$ = [
		3,
		n0,
		_DBR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.DeleteBucketTaggingRequest$ = [
		3,
		n0,
		_DBTR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.DeleteBucketWebsiteRequest$ = [
		3,
		n0,
		_DBWR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.DeletedObject$ = [
		3,
		n0,
		_DO,
		0,
		[
			_K,
			_VI,
			_DM,
			_DMVI
		],
		[
			0,
			0,
			2,
			0
		]
	];
	exports.DeleteMarkerEntry$ = [
		3,
		n0,
		_DME,
		0,
		[
			_O,
			_K,
			_VI,
			_IL,
			_LM
		],
		[
			() => exports.Owner$,
			0,
			0,
			2,
			4
		]
	];
	exports.DeleteMarkerReplication$ = [
		3,
		n0,
		_DMR,
		0,
		[_S],
		[0]
	];
	exports.DeleteObjectOutput$ = [
		3,
		n0,
		_DOO,
		0,
		[
			_DM,
			_VI,
			_RC
		],
		[
			[2, { [_hH]: _xadm }],
			[0, { [_hH]: _xavi }],
			[0, { [_hH]: _xarc }]
		]
	];
	exports.DeleteObjectRequest$ = [
		3,
		n0,
		_DOR,
		0,
		[
			_B,
			_K,
			_MFA,
			_VI,
			_RP,
			_BGR,
			_EBO,
			_IM,
			_IMLMT,
			_IMS
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hH]: _xam_ }],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _xarp }],
			[2, { [_hH]: _xabgr }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _IM_ }],
			[6, { [_hH]: _xaimlmt }],
			[1, { [_hH]: _xaims }]
		],
		2
	];
	exports.DeleteObjectsOutput$ = [
		3,
		n0,
		_DOOe,
		{ [_xN]: _DRel },
		[
			_Del,
			_RC,
			_Er
		],
		[
			[() => DeletedObjects, { [_xF]: 1 }],
			[0, { [_hH]: _xarc }],
			[() => Errors, {
				[_xF]: 1,
				[_xN]: _Err
			}]
		]
	];
	exports.DeleteObjectsRequest$ = [
		3,
		n0,
		_DORe,
		0,
		[
			_B,
			_De,
			_MFA,
			_RP,
			_BGR,
			_EBO,
			_CA
		],
		[
			[0, 1],
			[() => exports.Delete$, {
				[_hP]: 1,
				[_xN]: _De
			}],
			[0, { [_hH]: _xam_ }],
			[0, { [_hH]: _xarp }],
			[2, { [_hH]: _xabgr }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xasca }]
		],
		2
	];
	exports.DeleteObjectTaggingOutput$ = [
		3,
		n0,
		_DOTO,
		0,
		[_VI],
		[[0, { [_hH]: _xavi }]]
	];
	exports.DeleteObjectTaggingRequest$ = [
		3,
		n0,
		_DOTR,
		0,
		[
			_B,
			_K,
			_VI,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.DeletePublicAccessBlockRequest$ = [
		3,
		n0,
		_DPABR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.Destination$ = [
		3,
		n0,
		_Des,
		0,
		[
			_B,
			_A,
			_SC,
			_ACT,
			_EC,
			_RT,
			_Me
		],
		[
			0,
			0,
			0,
			() => exports.AccessControlTranslation$,
			() => exports.EncryptionConfiguration$,
			() => exports.ReplicationTime$,
			() => exports.Metrics$
		],
		1
	];
	exports.DestinationResult$ = [
		3,
		n0,
		_DRes,
		0,
		[
			_TBT,
			_TBA,
			_TN
		],
		[
			0,
			0,
			0
		]
	];
	exports.Encryption$ = [
		3,
		n0,
		_En,
		0,
		[
			_ET,
			_KMSKI,
			_KMSC
		],
		[
			0,
			[() => SSEKMSKeyId, 0],
			0
		],
		1
	];
	exports.EncryptionConfiguration$ = [
		3,
		n0,
		_EC,
		0,
		[_RKKID],
		[0]
	];
	exports.EndEvent$ = [
		3,
		n0,
		_EE,
		0,
		[],
		[]
	];
	exports._Error$ = [
		3,
		n0,
		_Err,
		0,
		[
			_K,
			_VI,
			_Cod,
			_Mes
		],
		[
			0,
			0,
			0,
			0
		]
	];
	exports.ErrorDetails$ = [
		3,
		n0,
		_ED,
		0,
		[_ECr, _EM],
		[0, 0]
	];
	exports.ErrorDocument$ = [
		3,
		n0,
		_EDr,
		0,
		[_K],
		[0],
		1
	];
	exports.EventBridgeConfiguration$ = [
		3,
		n0,
		_EBC,
		0,
		[],
		[]
	];
	exports.ExistingObjectReplication$ = [
		3,
		n0,
		_EOR,
		0,
		[_S],
		[0],
		1
	];
	exports.FilterRule$ = [
		3,
		n0,
		_FR,
		0,
		[_N, _V],
		[0, 0]
	];
	exports.GetBucketAbacOutput$ = [
		3,
		n0,
		_GBAO,
		0,
		[_AS],
		[[() => exports.AbacStatus$, 16]]
	];
	exports.GetBucketAbacRequest$ = [
		3,
		n0,
		_GBAR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketAccelerateConfigurationOutput$ = [
		3,
		n0,
		_GBACO,
		{ [_xN]: _AC },
		[_S, _RC],
		[0, [0, { [_hH]: _xarc }]]
	];
	exports.GetBucketAccelerateConfigurationRequest$ = [
		3,
		n0,
		_GBACR,
		0,
		[
			_B,
			_EBO,
			_RP
		],
		[
			[0, 1],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xarp }]
		],
		1
	];
	exports.GetBucketAclOutput$ = [
		3,
		n0,
		_GBAOe,
		{ [_xN]: _ACP },
		[_O, _G],
		[() => exports.Owner$, [() => Grants, { [_xN]: _ACL }]]
	];
	exports.GetBucketAclRequest$ = [
		3,
		n0,
		_GBARe,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketAnalyticsConfigurationOutput$ = [
		3,
		n0,
		_GBACOe,
		0,
		[_ACn],
		[[() => exports.AnalyticsConfiguration$, 16]]
	];
	exports.GetBucketAnalyticsConfigurationRequest$ = [
		3,
		n0,
		_GBACRe,
		0,
		[
			_B,
			_I,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.GetBucketCorsOutput$ = [
		3,
		n0,
		_GBCO,
		{ [_xN]: _CORSC },
		[_CORSR],
		[[() => CORSRules, {
			[_xF]: 1,
			[_xN]: _CORSRu
		}]]
	];
	exports.GetBucketCorsRequest$ = [
		3,
		n0,
		_GBCR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketEncryptionOutput$ = [
		3,
		n0,
		_GBEO,
		0,
		[_SSEC],
		[[() => exports.ServerSideEncryptionConfiguration$, 16]]
	];
	exports.GetBucketEncryptionRequest$ = [
		3,
		n0,
		_GBER,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketIntelligentTieringConfigurationOutput$ = [
		3,
		n0,
		_GBITCO,
		0,
		[_ITC],
		[[() => exports.IntelligentTieringConfiguration$, 16]]
	];
	exports.GetBucketIntelligentTieringConfigurationRequest$ = [
		3,
		n0,
		_GBITCR,
		0,
		[
			_B,
			_I,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.GetBucketInventoryConfigurationOutput$ = [
		3,
		n0,
		_GBICO,
		0,
		[_IC],
		[[() => exports.InventoryConfiguration$, 16]]
	];
	exports.GetBucketInventoryConfigurationRequest$ = [
		3,
		n0,
		_GBICR,
		0,
		[
			_B,
			_I,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.GetBucketLifecycleConfigurationOutput$ = [
		3,
		n0,
		_GBLCO,
		{ [_xN]: _LCi },
		[_R, _TDMOS],
		[[() => LifecycleRules, {
			[_xF]: 1,
			[_xN]: _Ru
		}], [0, { [_hH]: _xatdmos }]]
	];
	exports.GetBucketLifecycleConfigurationRequest$ = [
		3,
		n0,
		_GBLCR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketLocationOutput$ = [
		3,
		n0,
		_GBLO,
		{ [_xN]: _LC },
		[_LC],
		[0]
	];
	exports.GetBucketLocationRequest$ = [
		3,
		n0,
		_GBLR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketLoggingOutput$ = [
		3,
		n0,
		_GBLOe,
		{ [_xN]: _BLS },
		[_LE],
		[[() => exports.LoggingEnabled$, 0]]
	];
	exports.GetBucketLoggingRequest$ = [
		3,
		n0,
		_GBLRe,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketMetadataConfigurationOutput$ = [
		3,
		n0,
		_GBMCO,
		0,
		[_GBMCR],
		[[() => exports.GetBucketMetadataConfigurationResult$, 16]]
	];
	exports.GetBucketMetadataConfigurationRequest$ = [
		3,
		n0,
		_GBMCRe,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketMetadataConfigurationResult$ = [
		3,
		n0,
		_GBMCR,
		0,
		[_MCR],
		[() => exports.MetadataConfigurationResult$],
		1
	];
	exports.GetBucketMetadataTableConfigurationOutput$ = [
		3,
		n0,
		_GBMTCO,
		0,
		[_GBMTCR],
		[[() => exports.GetBucketMetadataTableConfigurationResult$, 16]]
	];
	exports.GetBucketMetadataTableConfigurationRequest$ = [
		3,
		n0,
		_GBMTCRe,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketMetadataTableConfigurationResult$ = [
		3,
		n0,
		_GBMTCR,
		0,
		[
			_MTCR,
			_S,
			_Err
		],
		[
			() => exports.MetadataTableConfigurationResult$,
			0,
			() => exports.ErrorDetails$
		],
		2
	];
	exports.GetBucketMetricsConfigurationOutput$ = [
		3,
		n0,
		_GBMCOe,
		0,
		[_MCe],
		[[() => exports.MetricsConfiguration$, 16]]
	];
	exports.GetBucketMetricsConfigurationRequest$ = [
		3,
		n0,
		_GBMCRet,
		0,
		[
			_B,
			_I,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.GetBucketNotificationConfigurationRequest$ = [
		3,
		n0,
		_GBNCR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketOwnershipControlsOutput$ = [
		3,
		n0,
		_GBOCO,
		0,
		[_OC],
		[[() => exports.OwnershipControls$, 16]]
	];
	exports.GetBucketOwnershipControlsRequest$ = [
		3,
		n0,
		_GBOCR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketPolicyOutput$ = [
		3,
		n0,
		_GBPO,
		0,
		[_Po],
		[[0, 16]]
	];
	exports.GetBucketPolicyRequest$ = [
		3,
		n0,
		_GBPR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketPolicyStatusOutput$ = [
		3,
		n0,
		_GBPSO,
		0,
		[_PS],
		[[() => exports.PolicyStatus$, 16]]
	];
	exports.GetBucketPolicyStatusRequest$ = [
		3,
		n0,
		_GBPSR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketReplicationOutput$ = [
		3,
		n0,
		_GBRO,
		0,
		[_RCe],
		[[() => exports.ReplicationConfiguration$, 16]]
	];
	exports.GetBucketReplicationRequest$ = [
		3,
		n0,
		_GBRR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketRequestPaymentOutput$ = [
		3,
		n0,
		_GBRPO,
		{ [_xN]: _RPC },
		[_Pay],
		[0]
	];
	exports.GetBucketRequestPaymentRequest$ = [
		3,
		n0,
		_GBRPR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketTaggingOutput$ = [
		3,
		n0,
		_GBTO,
		{ [_xN]: _Tag },
		[_TS],
		[[() => TagSet, 0]],
		1
	];
	exports.GetBucketTaggingRequest$ = [
		3,
		n0,
		_GBTR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketVersioningOutput$ = [
		3,
		n0,
		_GBVO,
		{ [_xN]: _VC },
		[_S, _MFAD],
		[0, [0, { [_xN]: _MDf }]]
	];
	exports.GetBucketVersioningRequest$ = [
		3,
		n0,
		_GBVR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetBucketWebsiteOutput$ = [
		3,
		n0,
		_GBWO,
		{ [_xN]: _WC },
		[
			_RART,
			_IDn,
			_EDr,
			_RR
		],
		[
			() => exports.RedirectAllRequestsTo$,
			() => exports.IndexDocument$,
			() => exports.ErrorDocument$,
			[() => RoutingRules, 0]
		]
	];
	exports.GetBucketWebsiteRequest$ = [
		3,
		n0,
		_GBWR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetObjectAclOutput$ = [
		3,
		n0,
		_GOAO,
		{ [_xN]: _ACP },
		[
			_O,
			_G,
			_RC
		],
		[
			() => exports.Owner$,
			[() => Grants, { [_xN]: _ACL }],
			[0, { [_hH]: _xarc }]
		]
	];
	exports.GetObjectAclRequest$ = [
		3,
		n0,
		_GOAR,
		0,
		[
			_B,
			_K,
			_VI,
			_RP,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.GetObjectAttributesOutput$ = [
		3,
		n0,
		_GOAOe,
		{ [_xN]: _GOARe },
		[
			_DM,
			_LM,
			_VI,
			_RC,
			_ETa,
			_C,
			_OP,
			_SC,
			_OS
		],
		[
			[2, { [_hH]: _xadm }],
			[4, { [_hH]: _LM_ }],
			[0, { [_hH]: _xavi }],
			[0, { [_hH]: _xarc }],
			0,
			() => exports.Checksum$,
			[() => exports.GetObjectAttributesParts$, 0],
			0,
			1
		]
	];
	exports.GetObjectAttributesParts$ = [
		3,
		n0,
		_GOAP,
		0,
		[
			_TPC,
			_PNM,
			_NPNM,
			_MP,
			_IT,
			_Pa
		],
		[
			[1, { [_xN]: _PC }],
			0,
			0,
			1,
			2,
			[() => PartsList, {
				[_xF]: 1,
				[_xN]: _Par
			}]
		]
	];
	exports.GetObjectAttributesRequest$ = [
		3,
		n0,
		_GOARet,
		0,
		[
			_B,
			_K,
			_OA,
			_VI,
			_MP,
			_PNM,
			_SSECA,
			_SSECK,
			_SSECKMD,
			_RP,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[64, { [_hH]: _xaoa }],
			[0, { [_hQ]: _vI }],
			[1, { [_hH]: _xamp }],
			[0, { [_hH]: _xapnm }],
			[0, { [_hH]: _xasseca }],
			[() => SSECustomerKey, { [_hH]: _xasseck }],
			[0, { [_hH]: _xasseckM }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }]
		],
		3
	];
	exports.GetObjectLegalHoldOutput$ = [
		3,
		n0,
		_GOLHO,
		0,
		[_LH],
		[[() => exports.ObjectLockLegalHold$, {
			[_hP]: 1,
			[_xN]: _LH
		}]]
	];
	exports.GetObjectLegalHoldRequest$ = [
		3,
		n0,
		_GOLHR,
		0,
		[
			_B,
			_K,
			_VI,
			_RP,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.GetObjectLockConfigurationOutput$ = [
		3,
		n0,
		_GOLCO,
		0,
		[_OLC],
		[[() => exports.ObjectLockConfiguration$, 16]]
	];
	exports.GetObjectLockConfigurationRequest$ = [
		3,
		n0,
		_GOLCR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GetObjectOutput$ = [
		3,
		n0,
		_GOO,
		0,
		[
			_Bo,
			_DM,
			_AR,
			_E,
			_Re,
			_LM,
			_CLo,
			_ETa,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe,
			_CT,
			_MM,
			_VI,
			_CC,
			_CDo,
			_CEo,
			_CL,
			_CR,
			_CTo,
			_Ex,
			_ES,
			_WRL,
			_SSE,
			_M,
			_SSECA,
			_SSECKMD,
			_SSEKMSKI,
			_BKE,
			_SC,
			_RC,
			_RS,
			_PC,
			_TC,
			_OLM,
			_OLRUD,
			_OLLHS
		],
		[
			[() => StreamingBlob, 16],
			[2, { [_hH]: _xadm }],
			[0, { [_hH]: _ar }],
			[0, { [_hH]: _xae }],
			[0, { [_hH]: _xar }],
			[4, { [_hH]: _LM_ }],
			[1, { [_hH]: _CL__ }],
			[0, { [_hH]: _ETa }],
			[0, { [_hH]: _xacc }],
			[0, { [_hH]: _xacc_ }],
			[0, { [_hH]: _xacc__ }],
			[0, { [_hH]: _xacs }],
			[0, { [_hH]: _xacs_ }],
			[0, { [_hH]: _xacs__ }],
			[0, { [_hH]: _xacm }],
			[0, { [_hH]: _xacx }],
			[0, { [_hH]: _xacx_ }],
			[0, { [_hH]: _xacx__ }],
			[0, { [_hH]: _xact }],
			[1, { [_hH]: _xamm }],
			[0, { [_hH]: _xavi }],
			[0, { [_hH]: _CC_ }],
			[0, { [_hH]: _CD_ }],
			[0, { [_hH]: _CE_ }],
			[0, { [_hH]: _CL_ }],
			[0, { [_hH]: _CR_ }],
			[0, { [_hH]: _CT_ }],
			[4, { [_hH]: _Ex }],
			[0, { [_hH]: _ES }],
			[0, { [_hH]: _xawrl }],
			[0, { [_hH]: _xasse }],
			[128, { [_hPH]: _xam }],
			[0, { [_hH]: _xasseca }],
			[0, { [_hH]: _xasseckM }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[2, { [_hH]: _xassebke }],
			[0, { [_hH]: _xasc }],
			[0, { [_hH]: _xarc }],
			[0, { [_hH]: _xars }],
			[1, { [_hH]: _xampc }],
			[1, { [_hH]: _xatc }],
			[0, { [_hH]: _xaolm }],
			[5, { [_hH]: _xaolrud }],
			[0, { [_hH]: _xaollh }]
		]
	];
	exports.GetObjectRequest$ = [
		3,
		n0,
		_GOR,
		0,
		[
			_B,
			_K,
			_IM,
			_IMSf,
			_INM,
			_IUS,
			_Ra,
			_RCC,
			_RCD,
			_RCE,
			_RCL,
			_RCT,
			_RE,
			_VI,
			_SSECA,
			_SSECK,
			_SSECKMD,
			_RP,
			_PN,
			_EBO,
			_CMh
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hH]: _IM_ }],
			[4, { [_hH]: _IMS_ }],
			[0, { [_hH]: _INM_ }],
			[4, { [_hH]: _IUS_ }],
			[0, { [_hH]: _Ra }],
			[0, { [_hQ]: _rcc }],
			[0, { [_hQ]: _rcd }],
			[0, { [_hQ]: _rce }],
			[0, { [_hQ]: _rcl }],
			[0, { [_hQ]: _rct }],
			[6, { [_hQ]: _re }],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _xasseca }],
			[() => SSECustomerKey, { [_hH]: _xasseck }],
			[0, { [_hH]: _xasseckM }],
			[0, { [_hH]: _xarp }],
			[1, { [_hQ]: _pN }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xacm_ }]
		],
		2
	];
	exports.GetObjectRetentionOutput$ = [
		3,
		n0,
		_GORO,
		0,
		[_Ret],
		[[() => exports.ObjectLockRetention$, {
			[_hP]: 1,
			[_xN]: _Ret
		}]]
	];
	exports.GetObjectRetentionRequest$ = [
		3,
		n0,
		_GORR,
		0,
		[
			_B,
			_K,
			_VI,
			_RP,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.GetObjectTaggingOutput$ = [
		3,
		n0,
		_GOTO,
		{ [_xN]: _Tag },
		[_TS, _VI],
		[[() => TagSet, 0], [0, { [_hH]: _xavi }]],
		1
	];
	exports.GetObjectTaggingRequest$ = [
		3,
		n0,
		_GOTR,
		0,
		[
			_B,
			_K,
			_VI,
			_EBO,
			_RP
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xarp }]
		],
		2
	];
	exports.GetObjectTorrentOutput$ = [
		3,
		n0,
		_GOTOe,
		0,
		[_Bo, _RC],
		[[() => StreamingBlob, 16], [0, { [_hH]: _xarc }]]
	];
	exports.GetObjectTorrentRequest$ = [
		3,
		n0,
		_GOTRe,
		0,
		[
			_B,
			_K,
			_RP,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.GetPublicAccessBlockOutput$ = [
		3,
		n0,
		_GPABO,
		0,
		[_PABC],
		[[() => exports.PublicAccessBlockConfiguration$, 16]]
	];
	exports.GetPublicAccessBlockRequest$ = [
		3,
		n0,
		_GPABR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.GlacierJobParameters$ = [
		3,
		n0,
		_GJP,
		0,
		[_Ti],
		[0],
		1
	];
	exports.Grant$ = [
		3,
		n0,
		_Gr,
		0,
		[_Gra, _Pe],
		[[() => exports.Grantee$, { [_xNm]: [_x, _hi] }], 0]
	];
	exports.Grantee$ = [
		3,
		n0,
		_Gra,
		0,
		[
			_Ty,
			_DN,
			_EA,
			_ID,
			_URI
		],
		[
			[0, {
				[_xA]: 1,
				[_xN]: _xs
			}],
			0,
			0,
			0,
			0
		],
		1
	];
	exports.HeadBucketOutput$ = [
		3,
		n0,
		_HBO,
		0,
		[
			_BA,
			_BLT,
			_BLN,
			_BR,
			_APA
		],
		[
			[0, { [_hH]: _xaba }],
			[0, { [_hH]: _xablt }],
			[0, { [_hH]: _xabln }],
			[0, { [_hH]: _xabr }],
			[2, { [_hH]: _xaapa }]
		]
	];
	exports.HeadBucketRequest$ = [
		3,
		n0,
		_HBR,
		0,
		[_B, _EBO],
		[[0, 1], [0, { [_hH]: _xaebo }]],
		1
	];
	exports.HeadObjectOutput$ = [
		3,
		n0,
		_HOO,
		0,
		[
			_DM,
			_AR,
			_E,
			_Re,
			_ASr,
			_LM,
			_CLo,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe,
			_CT,
			_ETa,
			_MM,
			_VI,
			_CC,
			_CDo,
			_CEo,
			_CL,
			_CTo,
			_CR,
			_Ex,
			_ES,
			_WRL,
			_SSE,
			_M,
			_SSECA,
			_SSECKMD,
			_SSEKMSKI,
			_BKE,
			_SC,
			_RC,
			_RS,
			_PC,
			_TC,
			_OLM,
			_OLRUD,
			_OLLHS
		],
		[
			[2, { [_hH]: _xadm }],
			[0, { [_hH]: _ar }],
			[0, { [_hH]: _xae }],
			[0, { [_hH]: _xar }],
			[0, { [_hH]: _xaas }],
			[4, { [_hH]: _LM_ }],
			[1, { [_hH]: _CL__ }],
			[0, { [_hH]: _xacc }],
			[0, { [_hH]: _xacc_ }],
			[0, { [_hH]: _xacc__ }],
			[0, { [_hH]: _xacs }],
			[0, { [_hH]: _xacs_ }],
			[0, { [_hH]: _xacs__ }],
			[0, { [_hH]: _xacm }],
			[0, { [_hH]: _xacx }],
			[0, { [_hH]: _xacx_ }],
			[0, { [_hH]: _xacx__ }],
			[0, { [_hH]: _xact }],
			[0, { [_hH]: _ETa }],
			[1, { [_hH]: _xamm }],
			[0, { [_hH]: _xavi }],
			[0, { [_hH]: _CC_ }],
			[0, { [_hH]: _CD_ }],
			[0, { [_hH]: _CE_ }],
			[0, { [_hH]: _CL_ }],
			[0, { [_hH]: _CT_ }],
			[0, { [_hH]: _CR_ }],
			[4, { [_hH]: _Ex }],
			[0, { [_hH]: _ES }],
			[0, { [_hH]: _xawrl }],
			[0, { [_hH]: _xasse }],
			[128, { [_hPH]: _xam }],
			[0, { [_hH]: _xasseca }],
			[0, { [_hH]: _xasseckM }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[2, { [_hH]: _xassebke }],
			[0, { [_hH]: _xasc }],
			[0, { [_hH]: _xarc }],
			[0, { [_hH]: _xars }],
			[1, { [_hH]: _xampc }],
			[1, { [_hH]: _xatc }],
			[0, { [_hH]: _xaolm }],
			[5, { [_hH]: _xaolrud }],
			[0, { [_hH]: _xaollh }]
		]
	];
	exports.HeadObjectRequest$ = [
		3,
		n0,
		_HOR,
		0,
		[
			_B,
			_K,
			_IM,
			_IMSf,
			_INM,
			_IUS,
			_Ra,
			_RCC,
			_RCD,
			_RCE,
			_RCL,
			_RCT,
			_RE,
			_VI,
			_SSECA,
			_SSECK,
			_SSECKMD,
			_RP,
			_PN,
			_EBO,
			_CMh
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hH]: _IM_ }],
			[4, { [_hH]: _IMS_ }],
			[0, { [_hH]: _INM_ }],
			[4, { [_hH]: _IUS_ }],
			[0, { [_hH]: _Ra }],
			[0, { [_hQ]: _rcc }],
			[0, { [_hQ]: _rcd }],
			[0, { [_hQ]: _rce }],
			[0, { [_hQ]: _rcl }],
			[0, { [_hQ]: _rct }],
			[6, { [_hQ]: _re }],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _xasseca }],
			[() => SSECustomerKey, { [_hH]: _xasseck }],
			[0, { [_hH]: _xasseckM }],
			[0, { [_hH]: _xarp }],
			[1, { [_hQ]: _pN }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xacm_ }]
		],
		2
	];
	exports.IndexDocument$ = [
		3,
		n0,
		_IDn,
		0,
		[_Su],
		[0],
		1
	];
	exports.Initiator$ = [
		3,
		n0,
		_In,
		0,
		[_ID, _DN],
		[0, 0]
	];
	exports.InputSerialization$ = [
		3,
		n0,
		_IS,
		0,
		[
			_CSV,
			_CTom,
			_JSON,
			_Parq
		],
		[
			() => exports.CSVInput$,
			0,
			() => exports.JSONInput$,
			() => exports.ParquetInput$
		]
	];
	exports.IntelligentTieringAndOperator$ = [
		3,
		n0,
		_ITAO,
		0,
		[_P, _T],
		[0, [() => TagSet, {
			[_xF]: 1,
			[_xN]: _Ta
		}]]
	];
	exports.IntelligentTieringConfiguration$ = [
		3,
		n0,
		_ITC,
		0,
		[
			_I,
			_S,
			_Tie,
			_F
		],
		[
			0,
			0,
			[() => TieringList, {
				[_xF]: 1,
				[_xN]: _Tier
			}],
			[() => exports.IntelligentTieringFilter$, 0]
		],
		3
	];
	exports.IntelligentTieringFilter$ = [
		3,
		n0,
		_ITF,
		0,
		[
			_P,
			_Ta,
			_An
		],
		[
			0,
			() => exports.Tag$,
			[() => exports.IntelligentTieringAndOperator$, 0]
		]
	];
	exports.InventoryConfiguration$ = [
		3,
		n0,
		_IC,
		0,
		[
			_Des,
			_IE,
			_I,
			_IOV,
			_Sc,
			_F,
			_OF
		],
		[
			[() => exports.InventoryDestination$, 0],
			2,
			0,
			0,
			() => exports.InventorySchedule$,
			() => exports.InventoryFilter$,
			[() => InventoryOptionalFields, 0]
		],
		5
	];
	exports.InventoryDestination$ = [
		3,
		n0,
		_IDnv,
		0,
		[_SBD],
		[[() => exports.InventoryS3BucketDestination$, 0]],
		1
	];
	exports.InventoryEncryption$ = [
		3,
		n0,
		_IEn,
		0,
		[_SSES, _SSEKMS],
		[[() => exports.SSES3$, { [_xN]: _SS }], [() => exports.SSEKMS$, { [_xN]: _SK }]]
	];
	exports.InventoryFilter$ = [
		3,
		n0,
		_IF,
		0,
		[_P],
		[0],
		1
	];
	exports.InventoryS3BucketDestination$ = [
		3,
		n0,
		_ISBD,
		0,
		[
			_B,
			_Fo,
			_AI,
			_P,
			_En
		],
		[
			0,
			0,
			0,
			0,
			[() => exports.InventoryEncryption$, 0]
		],
		2
	];
	exports.InventorySchedule$ = [
		3,
		n0,
		_ISn,
		0,
		[_Fr],
		[0],
		1
	];
	exports.InventoryTableConfiguration$ = [
		3,
		n0,
		_ITCn,
		0,
		[_CSo, _EC],
		[0, () => exports.MetadataTableEncryptionConfiguration$],
		1
	];
	exports.InventoryTableConfigurationResult$ = [
		3,
		n0,
		_ITCR,
		0,
		[
			_CSo,
			_TSa,
			_Err,
			_TNa,
			_TA
		],
		[
			0,
			0,
			() => exports.ErrorDetails$,
			0,
			0
		],
		1
	];
	exports.InventoryTableConfigurationUpdates$ = [
		3,
		n0,
		_ITCU,
		0,
		[_CSo, _EC],
		[0, () => exports.MetadataTableEncryptionConfiguration$],
		1
	];
	exports.JournalTableConfiguration$ = [
		3,
		n0,
		_JTC,
		0,
		[_REe, _EC],
		[() => exports.RecordExpiration$, () => exports.MetadataTableEncryptionConfiguration$],
		1
	];
	exports.JournalTableConfigurationResult$ = [
		3,
		n0,
		_JTCR,
		0,
		[
			_TSa,
			_TNa,
			_REe,
			_Err,
			_TA
		],
		[
			0,
			0,
			() => exports.RecordExpiration$,
			() => exports.ErrorDetails$,
			0
		],
		3
	];
	exports.JournalTableConfigurationUpdates$ = [
		3,
		n0,
		_JTCU,
		0,
		[_REe],
		[() => exports.RecordExpiration$],
		1
	];
	exports.JSONInput$ = [
		3,
		n0,
		_JSONI,
		0,
		[_Ty],
		[0]
	];
	exports.JSONOutput$ = [
		3,
		n0,
		_JSONO,
		0,
		[_RD],
		[0]
	];
	exports.LambdaFunctionConfiguration$ = [
		3,
		n0,
		_LFC,
		0,
		[
			_LFA,
			_Ev,
			_I,
			_F
		],
		[
			[0, { [_xN]: _CF }],
			[64, {
				[_xF]: 1,
				[_xN]: _Eve
			}],
			0,
			[() => exports.NotificationConfigurationFilter$, 0]
		],
		2
	];
	exports.LifecycleExpiration$ = [
		3,
		n0,
		_LEi,
		0,
		[
			_Da,
			_D,
			_EODM
		],
		[
			5,
			1,
			2
		]
	];
	exports.LifecycleRule$ = [
		3,
		n0,
		_LR,
		0,
		[
			_S,
			_E,
			_ID,
			_P,
			_F,
			_Tr,
			_NVT,
			_NVE,
			_AIMU
		],
		[
			0,
			() => exports.LifecycleExpiration$,
			0,
			0,
			[() => exports.LifecycleRuleFilter$, 0],
			[() => TransitionList, {
				[_xF]: 1,
				[_xN]: _Tra
			}],
			[() => NoncurrentVersionTransitionList, {
				[_xF]: 1,
				[_xN]: _NVTo
			}],
			() => exports.NoncurrentVersionExpiration$,
			() => exports.AbortIncompleteMultipartUpload$
		],
		1
	];
	exports.LifecycleRuleAndOperator$ = [
		3,
		n0,
		_LRAO,
		0,
		[
			_P,
			_T,
			_OSGT,
			_OSLT
		],
		[
			0,
			[() => TagSet, {
				[_xF]: 1,
				[_xN]: _Ta
			}],
			1,
			1
		]
	];
	exports.LifecycleRuleFilter$ = [
		3,
		n0,
		_LRF,
		0,
		[
			_P,
			_Ta,
			_OSGT,
			_OSLT,
			_An
		],
		[
			0,
			() => exports.Tag$,
			1,
			1,
			[() => exports.LifecycleRuleAndOperator$, 0]
		]
	];
	exports.ListBucketAnalyticsConfigurationsOutput$ = [
		3,
		n0,
		_LBACO,
		{ [_xN]: _LBACR },
		[
			_IT,
			_CTon,
			_NCT,
			_ACLn
		],
		[
			2,
			0,
			0,
			[() => AnalyticsConfigurationList, {
				[_xF]: 1,
				[_xN]: _ACn
			}]
		]
	];
	exports.ListBucketAnalyticsConfigurationsRequest$ = [
		3,
		n0,
		_LBACRi,
		0,
		[
			_B,
			_CTon,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _ct }],
			[0, { [_hH]: _xaebo }]
		],
		1
	];
	exports.ListBucketIntelligentTieringConfigurationsOutput$ = [
		3,
		n0,
		_LBITCO,
		0,
		[
			_IT,
			_CTon,
			_NCT,
			_ITCL
		],
		[
			2,
			0,
			0,
			[() => IntelligentTieringConfigurationList, {
				[_xF]: 1,
				[_xN]: _ITC
			}]
		]
	];
	exports.ListBucketIntelligentTieringConfigurationsRequest$ = [
		3,
		n0,
		_LBITCR,
		0,
		[
			_B,
			_CTon,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _ct }],
			[0, { [_hH]: _xaebo }]
		],
		1
	];
	exports.ListBucketInventoryConfigurationsOutput$ = [
		3,
		n0,
		_LBICO,
		{ [_xN]: _LICR },
		[
			_CTon,
			_ICL,
			_IT,
			_NCT
		],
		[
			0,
			[() => InventoryConfigurationList, {
				[_xF]: 1,
				[_xN]: _IC
			}],
			2,
			0
		]
	];
	exports.ListBucketInventoryConfigurationsRequest$ = [
		3,
		n0,
		_LBICR,
		0,
		[
			_B,
			_CTon,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _ct }],
			[0, { [_hH]: _xaebo }]
		],
		1
	];
	exports.ListBucketMetricsConfigurationsOutput$ = [
		3,
		n0,
		_LBMCO,
		{ [_xN]: _LMCR },
		[
			_IT,
			_CTon,
			_NCT,
			_MCL
		],
		[
			2,
			0,
			0,
			[() => MetricsConfigurationList, {
				[_xF]: 1,
				[_xN]: _MCe
			}]
		]
	];
	exports.ListBucketMetricsConfigurationsRequest$ = [
		3,
		n0,
		_LBMCR,
		0,
		[
			_B,
			_CTon,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _ct }],
			[0, { [_hH]: _xaebo }]
		],
		1
	];
	exports.ListBucketsOutput$ = [
		3,
		n0,
		_LBO,
		{ [_xN]: _LAMBR },
		[
			_Bu,
			_O,
			_CTon,
			_P
		],
		[
			[() => Buckets, 0],
			() => exports.Owner$,
			0,
			0
		]
	];
	exports.ListBucketsRequest$ = [
		3,
		n0,
		_LBR,
		0,
		[
			_MB,
			_CTon,
			_P,
			_BR
		],
		[
			[1, { [_hQ]: _mb }],
			[0, { [_hQ]: _ct }],
			[0, { [_hQ]: _p }],
			[0, { [_hQ]: _br }]
		]
	];
	exports.ListDirectoryBucketsOutput$ = [
		3,
		n0,
		_LDBO,
		{ [_xN]: _LAMDBR },
		[_Bu, _CTon],
		[[() => Buckets, 0], 0]
	];
	exports.ListDirectoryBucketsRequest$ = [
		3,
		n0,
		_LDBR,
		0,
		[_CTon, _MDB],
		[[0, { [_hQ]: _ct }], [1, { [_hQ]: _mdb }]]
	];
	exports.ListMultipartUploadsOutput$ = [
		3,
		n0,
		_LMUO,
		{ [_xN]: _LMUR },
		[
			_B,
			_KM,
			_UIM,
			_NKM,
			_P,
			_Deli,
			_NUIM,
			_MUa,
			_IT,
			_U,
			_CPom,
			_ETn,
			_RC
		],
		[
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			1,
			2,
			[() => MultipartUploadList, {
				[_xF]: 1,
				[_xN]: _Up
			}],
			[() => CommonPrefixList, { [_xF]: 1 }],
			0,
			[0, { [_hH]: _xarc }]
		]
	];
	exports.ListMultipartUploadsRequest$ = [
		3,
		n0,
		_LMURi,
		0,
		[
			_B,
			_Deli,
			_ETn,
			_KM,
			_MUa,
			_P,
			_UIM,
			_EBO,
			_RP
		],
		[
			[0, 1],
			[0, { [_hQ]: _d }],
			[0, { [_hQ]: _et }],
			[0, { [_hQ]: _km }],
			[1, { [_hQ]: _mu }],
			[0, { [_hQ]: _p }],
			[0, { [_hQ]: _uim }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xarp }]
		],
		1
	];
	exports.ListObjectsOutput$ = [
		3,
		n0,
		_LOO,
		{ [_xN]: _LBRi },
		[
			_IT,
			_Ma,
			_NM,
			_Con,
			_N,
			_P,
			_Deli,
			_MK,
			_CPom,
			_ETn,
			_RC
		],
		[
			2,
			0,
			0,
			[() => ObjectList, { [_xF]: 1 }],
			0,
			0,
			0,
			1,
			[() => CommonPrefixList, { [_xF]: 1 }],
			0,
			[0, { [_hH]: _xarc }]
		]
	];
	exports.ListObjectsRequest$ = [
		3,
		n0,
		_LOR,
		0,
		[
			_B,
			_Deli,
			_ETn,
			_Ma,
			_MK,
			_P,
			_RP,
			_EBO,
			_OOA
		],
		[
			[0, 1],
			[0, { [_hQ]: _d }],
			[0, { [_hQ]: _et }],
			[0, { [_hQ]: _m }],
			[1, { [_hQ]: _mk }],
			[0, { [_hQ]: _p }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }],
			[64, { [_hH]: _xaooa }]
		],
		1
	];
	exports.ListObjectsV2Output$ = [
		3,
		n0,
		_LOVO,
		{ [_xN]: _LBRi },
		[
			_IT,
			_Con,
			_N,
			_P,
			_Deli,
			_MK,
			_CPom,
			_ETn,
			_KC,
			_CTon,
			_NCT,
			_SA,
			_RC
		],
		[
			2,
			[() => ObjectList, { [_xF]: 1 }],
			0,
			0,
			0,
			1,
			[() => CommonPrefixList, { [_xF]: 1 }],
			0,
			1,
			0,
			0,
			0,
			[0, { [_hH]: _xarc }]
		]
	];
	exports.ListObjectsV2Request$ = [
		3,
		n0,
		_LOVR,
		0,
		[
			_B,
			_Deli,
			_ETn,
			_MK,
			_P,
			_CTon,
			_FO,
			_SA,
			_RP,
			_EBO,
			_OOA
		],
		[
			[0, 1],
			[0, { [_hQ]: _d }],
			[0, { [_hQ]: _et }],
			[1, { [_hQ]: _mk }],
			[0, { [_hQ]: _p }],
			[0, { [_hQ]: _ct }],
			[2, { [_hQ]: _fo }],
			[0, { [_hQ]: _sa }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }],
			[64, { [_hH]: _xaooa }]
		],
		1
	];
	exports.ListObjectVersionsOutput$ = [
		3,
		n0,
		_LOVOi,
		{ [_xN]: _LVR },
		[
			_IT,
			_KM,
			_VIM,
			_NKM,
			_NVIM,
			_Ve,
			_DMe,
			_N,
			_P,
			_Deli,
			_MK,
			_CPom,
			_ETn,
			_RC
		],
		[
			2,
			0,
			0,
			0,
			0,
			[() => ObjectVersionList, {
				[_xF]: 1,
				[_xN]: _Ver
			}],
			[() => DeleteMarkers, {
				[_xF]: 1,
				[_xN]: _DM
			}],
			0,
			0,
			0,
			1,
			[() => CommonPrefixList, { [_xF]: 1 }],
			0,
			[0, { [_hH]: _xarc }]
		]
	];
	exports.ListObjectVersionsRequest$ = [
		3,
		n0,
		_LOVRi,
		0,
		[
			_B,
			_Deli,
			_ETn,
			_KM,
			_MK,
			_P,
			_VIM,
			_EBO,
			_RP,
			_OOA
		],
		[
			[0, 1],
			[0, { [_hQ]: _d }],
			[0, { [_hQ]: _et }],
			[0, { [_hQ]: _km }],
			[1, { [_hQ]: _mk }],
			[0, { [_hQ]: _p }],
			[0, { [_hQ]: _vim }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xarp }],
			[64, { [_hH]: _xaooa }]
		],
		1
	];
	exports.ListPartsOutput$ = [
		3,
		n0,
		_LPO,
		{ [_xN]: _LPR },
		[
			_ADb,
			_ARI,
			_B,
			_K,
			_UI,
			_PNM,
			_NPNM,
			_MP,
			_IT,
			_Pa,
			_In,
			_O,
			_SC,
			_RC,
			_CA,
			_CT
		],
		[
			[4, { [_hH]: _xaad }],
			[0, { [_hH]: _xaari }],
			0,
			0,
			0,
			0,
			0,
			1,
			2,
			[() => Parts, {
				[_xF]: 1,
				[_xN]: _Par
			}],
			() => exports.Initiator$,
			() => exports.Owner$,
			0,
			[0, { [_hH]: _xarc }],
			0,
			0
		]
	];
	exports.ListPartsRequest$ = [
		3,
		n0,
		_LPRi,
		0,
		[
			_B,
			_K,
			_UI,
			_MP,
			_PNM,
			_RP,
			_EBO,
			_SSECA,
			_SSECK,
			_SSECKMD
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hQ]: _uI }],
			[1, { [_hQ]: _mp }],
			[0, { [_hQ]: _pnm }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xasseca }],
			[() => SSECustomerKey, { [_hH]: _xasseck }],
			[0, { [_hH]: _xasseckM }]
		],
		3
	];
	exports.LocationInfo$ = [
		3,
		n0,
		_LI,
		0,
		[_Ty, _N],
		[0, 0]
	];
	exports.LoggingEnabled$ = [
		3,
		n0,
		_LE,
		0,
		[
			_TB,
			_TP,
			_TG,
			_TOKF
		],
		[
			0,
			0,
			[() => TargetGrants, 0],
			[() => exports.TargetObjectKeyFormat$, 0]
		],
		2
	];
	exports.MetadataConfiguration$ = [
		3,
		n0,
		_MC,
		0,
		[_JTC, _ITCn],
		[() => exports.JournalTableConfiguration$, () => exports.InventoryTableConfiguration$],
		1
	];
	exports.MetadataConfigurationResult$ = [
		3,
		n0,
		_MCR,
		0,
		[
			_DRes,
			_JTCR,
			_ITCR
		],
		[
			() => exports.DestinationResult$,
			() => exports.JournalTableConfigurationResult$,
			() => exports.InventoryTableConfigurationResult$
		],
		1
	];
	exports.MetadataEntry$ = [
		3,
		n0,
		_ME,
		0,
		[_N, _V],
		[0, 0]
	];
	exports.MetadataTableConfiguration$ = [
		3,
		n0,
		_MTC,
		0,
		[_STD],
		[() => exports.S3TablesDestination$],
		1
	];
	exports.MetadataTableConfigurationResult$ = [
		3,
		n0,
		_MTCR,
		0,
		[_STDR],
		[() => exports.S3TablesDestinationResult$],
		1
	];
	exports.MetadataTableEncryptionConfiguration$ = [
		3,
		n0,
		_MTEC,
		0,
		[_SAs, _KKA],
		[0, 0],
		1
	];
	exports.Metrics$ = [
		3,
		n0,
		_Me,
		0,
		[_S, _ETv],
		[0, () => exports.ReplicationTimeValue$],
		1
	];
	exports.MetricsAndOperator$ = [
		3,
		n0,
		_MAO,
		0,
		[
			_P,
			_T,
			_APAc
		],
		[
			0,
			[() => TagSet, {
				[_xF]: 1,
				[_xN]: _Ta
			}],
			0
		]
	];
	exports.MetricsConfiguration$ = [
		3,
		n0,
		_MCe,
		0,
		[_I, _F],
		[0, [() => exports.MetricsFilter$, 0]],
		1
	];
	exports.MultipartUpload$ = [
		3,
		n0,
		_MU,
		0,
		[
			_UI,
			_K,
			_Ini,
			_SC,
			_O,
			_In,
			_CA,
			_CT
		],
		[
			0,
			0,
			4,
			0,
			() => exports.Owner$,
			() => exports.Initiator$,
			0,
			0
		]
	];
	exports.NoncurrentVersionExpiration$ = [
		3,
		n0,
		_NVE,
		0,
		[_ND, _NNV],
		[1, 1]
	];
	exports.NoncurrentVersionTransition$ = [
		3,
		n0,
		_NVTo,
		0,
		[
			_ND,
			_SC,
			_NNV
		],
		[
			1,
			0,
			1
		]
	];
	exports.NotificationConfiguration$ = [
		3,
		n0,
		_NC,
		0,
		[
			_TCo,
			_QCu,
			_LFCa,
			_EBC
		],
		[
			[() => TopicConfigurationList, {
				[_xF]: 1,
				[_xN]: _TCop
			}],
			[() => QueueConfigurationList, {
				[_xF]: 1,
				[_xN]: _QCue
			}],
			[() => LambdaFunctionConfigurationList, {
				[_xF]: 1,
				[_xN]: _CFC
			}],
			() => exports.EventBridgeConfiguration$
		]
	];
	exports.NotificationConfigurationFilter$ = [
		3,
		n0,
		_NCF,
		0,
		[_K],
		[[() => exports.S3KeyFilter$, { [_xN]: _SKe }]]
	];
	exports._Object$ = [
		3,
		n0,
		_Obj,
		0,
		[
			_K,
			_LM,
			_ETa,
			_CA,
			_CT,
			_Si,
			_SC,
			_O,
			_RSe
		],
		[
			0,
			4,
			0,
			[64, { [_xF]: 1 }],
			0,
			1,
			0,
			() => exports.Owner$,
			() => exports.RestoreStatus$
		]
	];
	exports.ObjectIdentifier$ = [
		3,
		n0,
		_OI,
		0,
		[
			_K,
			_VI,
			_ETa,
			_LMT,
			_Si
		],
		[
			0,
			0,
			0,
			6,
			1
		],
		1
	];
	exports.ObjectLockConfiguration$ = [
		3,
		n0,
		_OLC,
		0,
		[_OLE, _Ru],
		[0, () => exports.ObjectLockRule$]
	];
	exports.ObjectLockLegalHold$ = [
		3,
		n0,
		_OLLH,
		0,
		[_S],
		[0]
	];
	exports.ObjectLockRetention$ = [
		3,
		n0,
		_OLR,
		0,
		[_Mo, _RUD],
		[0, 5]
	];
	exports.ObjectLockRule$ = [
		3,
		n0,
		_OLRb,
		0,
		[_DRe],
		[() => exports.DefaultRetention$]
	];
	exports.ObjectPart$ = [
		3,
		n0,
		_OPb,
		0,
		[
			_PN,
			_Si,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe
		],
		[
			1,
			1,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0
		]
	];
	exports.ObjectVersion$ = [
		3,
		n0,
		_OV,
		0,
		[
			_ETa,
			_CA,
			_CT,
			_Si,
			_SC,
			_K,
			_VI,
			_IL,
			_LM,
			_O,
			_RSe
		],
		[
			0,
			[64, { [_xF]: 1 }],
			0,
			1,
			0,
			0,
			0,
			2,
			4,
			() => exports.Owner$,
			() => exports.RestoreStatus$
		]
	];
	exports.OutputLocation$ = [
		3,
		n0,
		_OL,
		0,
		[_S_],
		[[() => exports.S3Location$, 0]]
	];
	exports.OutputSerialization$ = [
		3,
		n0,
		_OSu,
		0,
		[_CSV, _JSON],
		[() => exports.CSVOutput$, () => exports.JSONOutput$]
	];
	exports.Owner$ = [
		3,
		n0,
		_O,
		0,
		[_DN, _ID],
		[0, 0]
	];
	exports.OwnershipControls$ = [
		3,
		n0,
		_OC,
		0,
		[_R],
		[[() => OwnershipControlsRules, {
			[_xF]: 1,
			[_xN]: _Ru
		}]],
		1
	];
	exports.OwnershipControlsRule$ = [
		3,
		n0,
		_OCR,
		0,
		[_OO],
		[0],
		1
	];
	exports.ParquetInput$ = [
		3,
		n0,
		_PI,
		0,
		[],
		[]
	];
	exports.Part$ = [
		3,
		n0,
		_Par,
		0,
		[
			_PN,
			_LM,
			_ETa,
			_Si,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe
		],
		[
			1,
			4,
			0,
			1,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
			0
		]
	];
	exports.PartitionedPrefix$ = [
		3,
		n0,
		_PP,
		{ [_xN]: _PP },
		[_PDS],
		[0]
	];
	exports.PolicyStatus$ = [
		3,
		n0,
		_PS,
		0,
		[_IP],
		[[2, { [_xN]: _IP }]]
	];
	exports.Progress$ = [
		3,
		n0,
		_Pr,
		0,
		[
			_BS,
			_BP,
			_BRy
		],
		[
			1,
			1,
			1
		]
	];
	exports.ProgressEvent$ = [
		3,
		n0,
		_PE,
		0,
		[_Det],
		[[() => exports.Progress$, { [_eP]: 1 }]]
	];
	exports.PublicAccessBlockConfiguration$ = [
		3,
		n0,
		_PABC,
		0,
		[
			_BPA,
			_IPA,
			_BPP,
			_RPB
		],
		[
			[2, { [_xN]: _BPA }],
			[2, { [_xN]: _IPA }],
			[2, { [_xN]: _BPP }],
			[2, { [_xN]: _RPB }]
		]
	];
	exports.PutBucketAbacRequest$ = [
		3,
		n0,
		_PBAR,
		0,
		[
			_B,
			_AS,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.AbacStatus$, {
				[_hP]: 1,
				[_xN]: _AS
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutBucketAccelerateConfigurationRequest$ = [
		3,
		n0,
		_PBACR,
		0,
		[
			_B,
			_AC,
			_EBO,
			_CA
		],
		[
			[0, 1],
			[() => exports.AccelerateConfiguration$, {
				[_hP]: 1,
				[_xN]: _AC
			}],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xasca }]
		],
		2
	];
	exports.PutBucketAclRequest$ = [
		3,
		n0,
		_PBARu,
		0,
		[
			_B,
			_ACL_,
			_ACP,
			_CMDo,
			_CA,
			_GFC,
			_GR,
			_GRACP,
			_GW,
			_GWACP,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hH]: _xaa }],
			[() => exports.AccessControlPolicy$, {
				[_hP]: 1,
				[_xN]: _ACP
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xagfc }],
			[0, { [_hH]: _xagr }],
			[0, { [_hH]: _xagra }],
			[0, { [_hH]: _xagw }],
			[0, { [_hH]: _xagwa }],
			[0, { [_hH]: _xaebo }]
		],
		1
	];
	exports.PutBucketAnalyticsConfigurationRequest$ = [
		3,
		n0,
		_PBACRu,
		0,
		[
			_B,
			_I,
			_ACn,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[() => exports.AnalyticsConfiguration$, {
				[_hP]: 1,
				[_xN]: _ACn
			}],
			[0, { [_hH]: _xaebo }]
		],
		3
	];
	exports.PutBucketCorsRequest$ = [
		3,
		n0,
		_PBCR,
		0,
		[
			_B,
			_CORSC,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.CORSConfiguration$, {
				[_hP]: 1,
				[_xN]: _CORSC
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutBucketEncryptionRequest$ = [
		3,
		n0,
		_PBER,
		0,
		[
			_B,
			_SSEC,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.ServerSideEncryptionConfiguration$, {
				[_hP]: 1,
				[_xN]: _SSEC
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutBucketIntelligentTieringConfigurationRequest$ = [
		3,
		n0,
		_PBITCR,
		0,
		[
			_B,
			_I,
			_ITC,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[() => exports.IntelligentTieringConfiguration$, {
				[_hP]: 1,
				[_xN]: _ITC
			}],
			[0, { [_hH]: _xaebo }]
		],
		3
	];
	exports.PutBucketInventoryConfigurationRequest$ = [
		3,
		n0,
		_PBICR,
		0,
		[
			_B,
			_I,
			_IC,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[() => exports.InventoryConfiguration$, {
				[_hP]: 1,
				[_xN]: _IC
			}],
			[0, { [_hH]: _xaebo }]
		],
		3
	];
	exports.PutBucketLifecycleConfigurationOutput$ = [
		3,
		n0,
		_PBLCO,
		0,
		[_TDMOS],
		[[0, { [_hH]: _xatdmos }]]
	];
	exports.PutBucketLifecycleConfigurationRequest$ = [
		3,
		n0,
		_PBLCR,
		0,
		[
			_B,
			_CA,
			_LCi,
			_EBO,
			_TDMOS
		],
		[
			[0, 1],
			[0, { [_hH]: _xasca }],
			[() => exports.BucketLifecycleConfiguration$, {
				[_hP]: 1,
				[_xN]: _LCi
			}],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xatdmos }]
		],
		1
	];
	exports.PutBucketLoggingRequest$ = [
		3,
		n0,
		_PBLR,
		0,
		[
			_B,
			_BLS,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.BucketLoggingStatus$, {
				[_hP]: 1,
				[_xN]: _BLS
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutBucketMetricsConfigurationRequest$ = [
		3,
		n0,
		_PBMCR,
		0,
		[
			_B,
			_I,
			_MCe,
			_EBO
		],
		[
			[0, 1],
			[0, { [_hQ]: _i }],
			[() => exports.MetricsConfiguration$, {
				[_hP]: 1,
				[_xN]: _MCe
			}],
			[0, { [_hH]: _xaebo }]
		],
		3
	];
	exports.PutBucketNotificationConfigurationRequest$ = [
		3,
		n0,
		_PBNCR,
		0,
		[
			_B,
			_NC,
			_EBO,
			_SDV
		],
		[
			[0, 1],
			[() => exports.NotificationConfiguration$, {
				[_hP]: 1,
				[_xN]: _NC
			}],
			[0, { [_hH]: _xaebo }],
			[2, { [_hH]: _xasdv }]
		],
		2
	];
	exports.PutBucketOwnershipControlsRequest$ = [
		3,
		n0,
		_PBOCR,
		0,
		[
			_B,
			_OC,
			_CMDo,
			_EBO,
			_CA
		],
		[
			[0, 1],
			[() => exports.OwnershipControls$, {
				[_hP]: 1,
				[_xN]: _OC
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xasca }]
		],
		2
	];
	exports.PutBucketPolicyRequest$ = [
		3,
		n0,
		_PBPR,
		0,
		[
			_B,
			_Po,
			_CMDo,
			_CA,
			_CRSBA,
			_EBO
		],
		[
			[0, 1],
			[0, 16],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[2, { [_hH]: _xacrsba }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutBucketReplicationRequest$ = [
		3,
		n0,
		_PBRR,
		0,
		[
			_B,
			_RCe,
			_CMDo,
			_CA,
			_To,
			_EBO
		],
		[
			[0, 1],
			[() => exports.ReplicationConfiguration$, {
				[_hP]: 1,
				[_xN]: _RCe
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xabolt }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutBucketRequestPaymentRequest$ = [
		3,
		n0,
		_PBRPR,
		0,
		[
			_B,
			_RPC,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.RequestPaymentConfiguration$, {
				[_hP]: 1,
				[_xN]: _RPC
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutBucketTaggingRequest$ = [
		3,
		n0,
		_PBTR,
		0,
		[
			_B,
			_Tag,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.Tagging$, {
				[_hP]: 1,
				[_xN]: _Tag
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutBucketVersioningRequest$ = [
		3,
		n0,
		_PBVR,
		0,
		[
			_B,
			_VC,
			_CMDo,
			_CA,
			_MFA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.VersioningConfiguration$, {
				[_hP]: 1,
				[_xN]: _VC
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xam_ }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutBucketWebsiteRequest$ = [
		3,
		n0,
		_PBWR,
		0,
		[
			_B,
			_WC,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.WebsiteConfiguration$, {
				[_hP]: 1,
				[_xN]: _WC
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutObjectAclOutput$ = [
		3,
		n0,
		_POAO,
		0,
		[_RC],
		[[0, { [_hH]: _xarc }]]
	];
	exports.PutObjectAclRequest$ = [
		3,
		n0,
		_POAR,
		0,
		[
			_B,
			_K,
			_ACL_,
			_ACP,
			_CMDo,
			_CA,
			_GFC,
			_GR,
			_GRACP,
			_GW,
			_GWACP,
			_RP,
			_VI,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hH]: _xaa }],
			[() => exports.AccessControlPolicy$, {
				[_hP]: 1,
				[_xN]: _ACP
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xagfc }],
			[0, { [_hH]: _xagr }],
			[0, { [_hH]: _xagra }],
			[0, { [_hH]: _xagw }],
			[0, { [_hH]: _xagwa }],
			[0, { [_hH]: _xarp }],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutObjectLegalHoldOutput$ = [
		3,
		n0,
		_POLHO,
		0,
		[_RC],
		[[0, { [_hH]: _xarc }]]
	];
	exports.PutObjectLegalHoldRequest$ = [
		3,
		n0,
		_POLHR,
		0,
		[
			_B,
			_K,
			_LH,
			_RP,
			_VI,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[() => exports.ObjectLockLegalHold$, {
				[_hP]: 1,
				[_xN]: _LH
			}],
			[0, { [_hH]: _xarp }],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutObjectLockConfigurationOutput$ = [
		3,
		n0,
		_POLCO,
		0,
		[_RC],
		[[0, { [_hH]: _xarc }]]
	];
	exports.PutObjectLockConfigurationRequest$ = [
		3,
		n0,
		_POLCR,
		0,
		[
			_B,
			_OLC,
			_RP,
			_To,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.ObjectLockConfiguration$, {
				[_hP]: 1,
				[_xN]: _OLC
			}],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xabolt }],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		1
	];
	exports.PutObjectOutput$ = [
		3,
		n0,
		_POO,
		0,
		[
			_E,
			_ETa,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe,
			_CT,
			_SSE,
			_VI,
			_SSECA,
			_SSECKMD,
			_SSEKMSKI,
			_SSEKMSEC,
			_BKE,
			_Si,
			_RC
		],
		[
			[0, { [_hH]: _xae }],
			[0, { [_hH]: _ETa }],
			[0, { [_hH]: _xacc }],
			[0, { [_hH]: _xacc_ }],
			[0, { [_hH]: _xacc__ }],
			[0, { [_hH]: _xacs }],
			[0, { [_hH]: _xacs_ }],
			[0, { [_hH]: _xacs__ }],
			[0, { [_hH]: _xacm }],
			[0, { [_hH]: _xacx }],
			[0, { [_hH]: _xacx_ }],
			[0, { [_hH]: _xacx__ }],
			[0, { [_hH]: _xact }],
			[0, { [_hH]: _xasse }],
			[0, { [_hH]: _xavi }],
			[0, { [_hH]: _xasseca }],
			[0, { [_hH]: _xasseckM }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[() => SSEKMSEncryptionContext, { [_hH]: _xassec }],
			[2, { [_hH]: _xassebke }],
			[1, { [_hH]: _xaos }],
			[0, { [_hH]: _xarc }]
		]
	];
	exports.PutObjectRequest$ = [
		3,
		n0,
		_POR,
		0,
		[
			_B,
			_K,
			_ACL_,
			_Bo,
			_CC,
			_CDo,
			_CEo,
			_CL,
			_CLo,
			_CMDo,
			_CTo,
			_CA,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe,
			_Ex,
			_IM,
			_INM,
			_GFC,
			_GR,
			_GRACP,
			_GWACP,
			_WOB,
			_M,
			_SSE,
			_SC,
			_WRL,
			_SSECA,
			_SSECK,
			_SSECKMD,
			_SSEKMSKI,
			_SSEKMSEC,
			_BKE,
			_RP,
			_Tag,
			_OLM,
			_OLRUD,
			_OLLHS,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hH]: _xaa }],
			[() => StreamingBlob, 16],
			[0, { [_hH]: _CC_ }],
			[0, { [_hH]: _CD_ }],
			[0, { [_hH]: _CE_ }],
			[0, { [_hH]: _CL_ }],
			[1, { [_hH]: _CL__ }],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _CT_ }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xacc }],
			[0, { [_hH]: _xacc_ }],
			[0, { [_hH]: _xacc__ }],
			[0, { [_hH]: _xacs }],
			[0, { [_hH]: _xacs_ }],
			[0, { [_hH]: _xacs__ }],
			[0, { [_hH]: _xacm }],
			[0, { [_hH]: _xacx }],
			[0, { [_hH]: _xacx_ }],
			[0, { [_hH]: _xacx__ }],
			[4, { [_hH]: _Ex }],
			[0, { [_hH]: _IM_ }],
			[0, { [_hH]: _INM_ }],
			[0, { [_hH]: _xagfc }],
			[0, { [_hH]: _xagr }],
			[0, { [_hH]: _xagra }],
			[0, { [_hH]: _xagwa }],
			[1, { [_hH]: _xawob }],
			[128, { [_hPH]: _xam }],
			[0, { [_hH]: _xasse }],
			[0, { [_hH]: _xasc }],
			[0, { [_hH]: _xawrl }],
			[0, { [_hH]: _xasseca }],
			[() => SSECustomerKey, { [_hH]: _xasseck }],
			[0, { [_hH]: _xasseckM }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[() => SSEKMSEncryptionContext, { [_hH]: _xassec }],
			[2, { [_hH]: _xassebke }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xat }],
			[0, { [_hH]: _xaolm }],
			[5, { [_hH]: _xaolrud }],
			[0, { [_hH]: _xaollh }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutObjectRetentionOutput$ = [
		3,
		n0,
		_PORO,
		0,
		[_RC],
		[[0, { [_hH]: _xarc }]]
	];
	exports.PutObjectRetentionRequest$ = [
		3,
		n0,
		_PORR,
		0,
		[
			_B,
			_K,
			_Ret,
			_RP,
			_VI,
			_BGR,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[() => exports.ObjectLockRetention$, {
				[_hP]: 1,
				[_xN]: _Ret
			}],
			[0, { [_hH]: _xarp }],
			[0, { [_hQ]: _vI }],
			[2, { [_hH]: _xabgr }],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.PutObjectTaggingOutput$ = [
		3,
		n0,
		_POTO,
		0,
		[_VI],
		[[0, { [_hH]: _xavi }]]
	];
	exports.PutObjectTaggingRequest$ = [
		3,
		n0,
		_POTR,
		0,
		[
			_B,
			_K,
			_Tag,
			_VI,
			_CMDo,
			_CA,
			_EBO,
			_RP
		],
		[
			[0, 1],
			[0, 1],
			[() => exports.Tagging$, {
				[_hP]: 1,
				[_xN]: _Tag
			}],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xarp }]
		],
		3
	];
	exports.PutPublicAccessBlockRequest$ = [
		3,
		n0,
		_PPABR,
		0,
		[
			_B,
			_PABC,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.PublicAccessBlockConfiguration$, {
				[_hP]: 1,
				[_xN]: _PABC
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.QueueConfiguration$ = [
		3,
		n0,
		_QCue,
		0,
		[
			_QA,
			_Ev,
			_I,
			_F
		],
		[
			[0, { [_xN]: _Qu }],
			[64, {
				[_xF]: 1,
				[_xN]: _Eve
			}],
			0,
			[() => exports.NotificationConfigurationFilter$, 0]
		],
		2
	];
	exports.RecordExpiration$ = [
		3,
		n0,
		_REe,
		0,
		[_E, _D],
		[0, 1],
		1
	];
	exports.RecordsEvent$ = [
		3,
		n0,
		_REec,
		0,
		[_Payl],
		[[21, { [_eP]: 1 }]]
	];
	exports.Redirect$ = [
		3,
		n0,
		_Red,
		0,
		[
			_HN,
			_HRC,
			_Pro,
			_RKPW,
			_RKW
		],
		[
			0,
			0,
			0,
			0,
			0
		]
	];
	exports.RedirectAllRequestsTo$ = [
		3,
		n0,
		_RART,
		0,
		[_HN, _Pro],
		[0, 0],
		1
	];
	exports.RenameObjectOutput$ = [
		3,
		n0,
		_ROO,
		0,
		[],
		[]
	];
	exports.RenameObjectRequest$ = [
		3,
		n0,
		_ROR,
		0,
		[
			_B,
			_K,
			_RSen,
			_DIM,
			_DINM,
			_DIMS,
			_DIUS,
			_SIM,
			_SINM,
			_SIMS,
			_SIUS,
			_CTl
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hH]: _xars_ }],
			[0, { [_hH]: _IM_ }],
			[0, { [_hH]: _INM_ }],
			[4, { [_hH]: _IMS_ }],
			[4, { [_hH]: _IUS_ }],
			[0, { [_hH]: _xarsim }],
			[0, { [_hH]: _xarsinm }],
			[6, { [_hH]: _xarsims }],
			[6, { [_hH]: _xarsius }],
			[0, {
				[_hH]: _xact_,
				[_iT]: 1
			}]
		],
		3
	];
	exports.ReplicaModifications$ = [
		3,
		n0,
		_RM,
		0,
		[_S],
		[0],
		1
	];
	exports.ReplicationConfiguration$ = [
		3,
		n0,
		_RCe,
		0,
		[_Ro, _R],
		[0, [() => ReplicationRules, {
			[_xF]: 1,
			[_xN]: _Ru
		}]],
		2
	];
	exports.ReplicationRule$ = [
		3,
		n0,
		_RRe,
		0,
		[
			_S,
			_Des,
			_ID,
			_Pri,
			_P,
			_F,
			_SSC,
			_EOR,
			_DMR
		],
		[
			0,
			() => exports.Destination$,
			0,
			1,
			0,
			[() => exports.ReplicationRuleFilter$, 0],
			() => exports.SourceSelectionCriteria$,
			() => exports.ExistingObjectReplication$,
			() => exports.DeleteMarkerReplication$
		],
		2
	];
	exports.ReplicationRuleAndOperator$ = [
		3,
		n0,
		_RRAO,
		0,
		[_P, _T],
		[0, [() => TagSet, {
			[_xF]: 1,
			[_xN]: _Ta
		}]]
	];
	exports.ReplicationRuleFilter$ = [
		3,
		n0,
		_RRF,
		0,
		[
			_P,
			_Ta,
			_An
		],
		[
			0,
			() => exports.Tag$,
			[() => exports.ReplicationRuleAndOperator$, 0]
		]
	];
	exports.ReplicationTime$ = [
		3,
		n0,
		_RT,
		0,
		[_S, _Tim],
		[0, () => exports.ReplicationTimeValue$],
		2
	];
	exports.ReplicationTimeValue$ = [
		3,
		n0,
		_RTV,
		0,
		[_Mi],
		[1]
	];
	exports.RequestPaymentConfiguration$ = [
		3,
		n0,
		_RPC,
		0,
		[_Pay],
		[0],
		1
	];
	exports.RequestProgress$ = [
		3,
		n0,
		_RPe,
		0,
		[_Ena],
		[2]
	];
	exports.RestoreObjectOutput$ = [
		3,
		n0,
		_ROOe,
		0,
		[_RC, _ROP],
		[[0, { [_hH]: _xarc }], [0, { [_hH]: _xarop }]]
	];
	exports.RestoreObjectRequest$ = [
		3,
		n0,
		_RORe,
		0,
		[
			_B,
			_K,
			_VI,
			_RRes,
			_RP,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[0, { [_hQ]: _vI }],
			[() => exports.RestoreRequest$, {
				[_hP]: 1,
				[_xN]: _RRes
			}],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.RestoreRequest$ = [
		3,
		n0,
		_RRes,
		0,
		[
			_D,
			_GJP,
			_Ty,
			_Ti,
			_Desc,
			_SP,
			_OL
		],
		[
			1,
			() => exports.GlacierJobParameters$,
			0,
			0,
			0,
			() => exports.SelectParameters$,
			[() => exports.OutputLocation$, 0]
		]
	];
	exports.RestoreStatus$ = [
		3,
		n0,
		_RSe,
		0,
		[_IRIP, _RED],
		[2, 4]
	];
	exports.RoutingRule$ = [
		3,
		n0,
		_RRo,
		0,
		[_Red, _Co],
		[() => exports.Redirect$, () => exports.Condition$],
		1
	];
	exports.S3KeyFilter$ = [
		3,
		n0,
		_SKF,
		0,
		[_FRi],
		[[() => FilterRuleList, {
			[_xF]: 1,
			[_xN]: _FR
		}]]
	];
	exports.S3Location$ = [
		3,
		n0,
		_SL,
		0,
		[
			_BNu,
			_P,
			_En,
			_CACL,
			_ACL,
			_Tag,
			_UM,
			_SC
		],
		[
			0,
			0,
			[() => exports.Encryption$, 0],
			0,
			[() => Grants, 0],
			[() => exports.Tagging$, 0],
			[() => UserMetadata, 0],
			0
		],
		2
	];
	exports.S3TablesDestination$ = [
		3,
		n0,
		_STD,
		0,
		[_TBA, _TNa],
		[0, 0],
		2
	];
	exports.S3TablesDestinationResult$ = [
		3,
		n0,
		_STDR,
		0,
		[
			_TBA,
			_TNa,
			_TA,
			_TN
		],
		[
			0,
			0,
			0,
			0
		],
		4
	];
	exports.ScanRange$ = [
		3,
		n0,
		_SR,
		0,
		[_St, _End],
		[1, 1]
	];
	exports.SelectObjectContentOutput$ = [
		3,
		n0,
		_SOCO,
		0,
		[_Payl],
		[[() => exports.SelectObjectContentEventStream$, 16]]
	];
	exports.SelectObjectContentRequest$ = [
		3,
		n0,
		_SOCR,
		0,
		[
			_B,
			_K,
			_Exp,
			_ETx,
			_IS,
			_OSu,
			_SSECA,
			_SSECK,
			_SSECKMD,
			_RPe,
			_SR,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			0,
			0,
			() => exports.InputSerialization$,
			() => exports.OutputSerialization$,
			[0, { [_hH]: _xasseca }],
			[() => SSECustomerKey, { [_hH]: _xasseck }],
			[0, { [_hH]: _xasseckM }],
			() => exports.RequestProgress$,
			() => exports.ScanRange$,
			[0, { [_hH]: _xaebo }]
		],
		6
	];
	exports.SelectParameters$ = [
		3,
		n0,
		_SP,
		0,
		[
			_IS,
			_ETx,
			_Exp,
			_OSu
		],
		[
			() => exports.InputSerialization$,
			0,
			0,
			() => exports.OutputSerialization$
		],
		4
	];
	exports.ServerSideEncryptionByDefault$ = [
		3,
		n0,
		_SSEBD,
		0,
		[_SSEA, _KMSMKID],
		[0, [() => SSEKMSKeyId, 0]],
		1
	];
	exports.ServerSideEncryptionConfiguration$ = [
		3,
		n0,
		_SSEC,
		0,
		[_R],
		[[() => ServerSideEncryptionRules, {
			[_xF]: 1,
			[_xN]: _Ru
		}]],
		1
	];
	exports.ServerSideEncryptionRule$ = [
		3,
		n0,
		_SSER,
		0,
		[
			_ASSEBD,
			_BKE,
			_BET
		],
		[
			[() => exports.ServerSideEncryptionByDefault$, 0],
			2,
			[() => exports.BlockedEncryptionTypes$, 0]
		]
	];
	exports.SessionCredentials$ = [
		3,
		n0,
		_SCe,
		0,
		[
			_AKI,
			_SAK,
			_ST,
			_E
		],
		[
			[0, { [_xN]: _AKI }],
			[() => SessionCredentialValue, { [_xN]: _SAK }],
			[() => SessionCredentialValue, { [_xN]: _ST }],
			[4, { [_xN]: _E }]
		],
		4
	];
	exports.SimplePrefix$ = [
		3,
		n0,
		_SPi,
		{ [_xN]: _SPi },
		[],
		[]
	];
	exports.SourceSelectionCriteria$ = [
		3,
		n0,
		_SSC,
		0,
		[_SKEO, _RM],
		[() => exports.SseKmsEncryptedObjects$, () => exports.ReplicaModifications$]
	];
	exports.SSEKMS$ = [
		3,
		n0,
		_SSEKMS,
		{ [_xN]: _SK },
		[_KI],
		[[() => SSEKMSKeyId, 0]],
		1
	];
	exports.SseKmsEncryptedObjects$ = [
		3,
		n0,
		_SKEO,
		0,
		[_S],
		[0],
		1
	];
	exports.SSEKMSEncryption$ = [
		3,
		n0,
		_SSEKMSE,
		{ [_xN]: _SK },
		[_KMSKA, _BKE],
		[[() => NonEmptyKmsKeyArnString, 0], 2],
		1
	];
	exports.SSES3$ = [
		3,
		n0,
		_SSES,
		{ [_xN]: _SS },
		[],
		[]
	];
	exports.Stats$ = [
		3,
		n0,
		_Sta,
		0,
		[
			_BS,
			_BP,
			_BRy
		],
		[
			1,
			1,
			1
		]
	];
	exports.StatsEvent$ = [
		3,
		n0,
		_SE,
		0,
		[_Det],
		[[() => exports.Stats$, { [_eP]: 1 }]]
	];
	exports.StorageClassAnalysis$ = [
		3,
		n0,
		_SCA,
		0,
		[_DE],
		[() => exports.StorageClassAnalysisDataExport$]
	];
	exports.StorageClassAnalysisDataExport$ = [
		3,
		n0,
		_SCADE,
		0,
		[_OSV, _Des],
		[0, () => exports.AnalyticsExportDestination$],
		2
	];
	exports.Tag$ = [
		3,
		n0,
		_Ta,
		0,
		[_K, _V],
		[0, 0],
		2
	];
	exports.Tagging$ = [
		3,
		n0,
		_Tag,
		0,
		[_TS],
		[[() => TagSet, 0]],
		1
	];
	exports.TargetGrant$ = [
		3,
		n0,
		_TGa,
		0,
		[_Gra, _Pe],
		[[() => exports.Grantee$, { [_xNm]: [_x, _hi] }], 0]
	];
	exports.TargetObjectKeyFormat$ = [
		3,
		n0,
		_TOKF,
		0,
		[_SPi, _PP],
		[[() => exports.SimplePrefix$, { [_xN]: _SPi }], [() => exports.PartitionedPrefix$, { [_xN]: _PP }]]
	];
	exports.Tiering$ = [
		3,
		n0,
		_Tier,
		0,
		[_D, _AT],
		[1, 0],
		2
	];
	exports.TopicConfiguration$ = [
		3,
		n0,
		_TCop,
		0,
		[
			_TAo,
			_Ev,
			_I,
			_F
		],
		[
			[0, { [_xN]: _Top }],
			[64, {
				[_xF]: 1,
				[_xN]: _Eve
			}],
			0,
			[() => exports.NotificationConfigurationFilter$, 0]
		],
		2
	];
	exports.Transition$ = [
		3,
		n0,
		_Tra,
		0,
		[
			_Da,
			_D,
			_SC
		],
		[
			5,
			1,
			0
		]
	];
	exports.UpdateBucketMetadataInventoryTableConfigurationRequest$ = [
		3,
		n0,
		_UBMITCR,
		0,
		[
			_B,
			_ITCn,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.InventoryTableConfigurationUpdates$, {
				[_hP]: 1,
				[_xN]: _ITCn
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.UpdateBucketMetadataJournalTableConfigurationRequest$ = [
		3,
		n0,
		_UBMJTCR,
		0,
		[
			_B,
			_JTC,
			_CMDo,
			_CA,
			_EBO
		],
		[
			[0, 1],
			[() => exports.JournalTableConfigurationUpdates$, {
				[_hP]: 1,
				[_xN]: _JTC
			}],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xaebo }]
		],
		2
	];
	exports.UpdateObjectEncryptionRequest$ = [
		3,
		n0,
		_UOER,
		0,
		[
			_B,
			_K,
			_OE,
			_VI,
			_RP,
			_EBO,
			_CMDo,
			_CA
		],
		[
			[0, 1],
			[0, 1],
			[() => exports.ObjectEncryption$, 16],
			[0, { [_hQ]: _vI }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }]
		],
		3
	];
	exports.UpdateObjectEncryptionResponse$ = [
		3,
		n0,
		_UOERp,
		0,
		[_RC],
		[[0, { [_hH]: _xarc }]]
	];
	exports.UploadPartCopyOutput$ = [
		3,
		n0,
		_UPCO,
		0,
		[
			_CSVI,
			_CPR,
			_SSE,
			_SSECA,
			_SSECKMD,
			_SSEKMSKI,
			_BKE,
			_RC
		],
		[
			[0, { [_hH]: _xacsvi }],
			[() => exports.CopyPartResult$, 16],
			[0, { [_hH]: _xasse }],
			[0, { [_hH]: _xasseca }],
			[0, { [_hH]: _xasseckM }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[2, { [_hH]: _xassebke }],
			[0, { [_hH]: _xarc }]
		]
	];
	exports.UploadPartCopyRequest$ = [
		3,
		n0,
		_UPCR,
		0,
		[
			_B,
			_CS,
			_K,
			_PN,
			_UI,
			_CSIM,
			_CSIMS,
			_CSINM,
			_CSIUS,
			_CSRo,
			_SSECA,
			_SSECK,
			_SSECKMD,
			_CSSSECA,
			_CSSSECK,
			_CSSSECKMD,
			_RP,
			_EBO,
			_ESBO
		],
		[
			[0, 1],
			[0, { [_hH]: _xacs___ }],
			[0, 1],
			[1, { [_hQ]: _pN }],
			[0, { [_hQ]: _uI }],
			[0, { [_hH]: _xacsim }],
			[4, { [_hH]: _xacsims }],
			[0, { [_hH]: _xacsinm }],
			[4, { [_hH]: _xacsius }],
			[0, { [_hH]: _xacsr }],
			[0, { [_hH]: _xasseca }],
			[() => SSECustomerKey, { [_hH]: _xasseck }],
			[0, { [_hH]: _xasseckM }],
			[0, { [_hH]: _xacssseca }],
			[() => CopySourceSSECustomerKey, { [_hH]: _xacssseck }],
			[0, { [_hH]: _xacssseckM }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }],
			[0, { [_hH]: _xasebo }]
		],
		5
	];
	exports.UploadPartOutput$ = [
		3,
		n0,
		_UPO,
		0,
		[
			_SSE,
			_ETa,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe,
			_SSECA,
			_SSECKMD,
			_SSEKMSKI,
			_BKE,
			_RC
		],
		[
			[0, { [_hH]: _xasse }],
			[0, { [_hH]: _ETa }],
			[0, { [_hH]: _xacc }],
			[0, { [_hH]: _xacc_ }],
			[0, { [_hH]: _xacc__ }],
			[0, { [_hH]: _xacs }],
			[0, { [_hH]: _xacs_ }],
			[0, { [_hH]: _xacs__ }],
			[0, { [_hH]: _xacm }],
			[0, { [_hH]: _xacx }],
			[0, { [_hH]: _xacx_ }],
			[0, { [_hH]: _xacx__ }],
			[0, { [_hH]: _xasseca }],
			[0, { [_hH]: _xasseckM }],
			[() => SSEKMSKeyId, { [_hH]: _xasseakki }],
			[2, { [_hH]: _xassebke }],
			[0, { [_hH]: _xarc }]
		]
	];
	exports.UploadPartRequest$ = [
		3,
		n0,
		_UPR,
		0,
		[
			_B,
			_K,
			_PN,
			_UI,
			_Bo,
			_CLo,
			_CMDo,
			_CA,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe,
			_SSECA,
			_SSECK,
			_SSECKMD,
			_RP,
			_EBO
		],
		[
			[0, 1],
			[0, 1],
			[1, { [_hQ]: _pN }],
			[0, { [_hQ]: _uI }],
			[() => StreamingBlob, 16],
			[1, { [_hH]: _CL__ }],
			[0, { [_hH]: _CM }],
			[0, { [_hH]: _xasca }],
			[0, { [_hH]: _xacc }],
			[0, { [_hH]: _xacc_ }],
			[0, { [_hH]: _xacc__ }],
			[0, { [_hH]: _xacs }],
			[0, { [_hH]: _xacs_ }],
			[0, { [_hH]: _xacs__ }],
			[0, { [_hH]: _xacm }],
			[0, { [_hH]: _xacx }],
			[0, { [_hH]: _xacx_ }],
			[0, { [_hH]: _xacx__ }],
			[0, { [_hH]: _xasseca }],
			[() => SSECustomerKey, { [_hH]: _xasseck }],
			[0, { [_hH]: _xasseckM }],
			[0, { [_hH]: _xarp }],
			[0, { [_hH]: _xaebo }]
		],
		4
	];
	exports.VersioningConfiguration$ = [
		3,
		n0,
		_VC,
		0,
		[_MFAD, _S],
		[[0, { [_xN]: _MDf }], 0]
	];
	exports.WebsiteConfiguration$ = [
		3,
		n0,
		_WC,
		0,
		[
			_EDr,
			_IDn,
			_RART,
			_RR
		],
		[
			() => exports.ErrorDocument$,
			() => exports.IndexDocument$,
			() => exports.RedirectAllRequestsTo$,
			[() => RoutingRules, 0]
		]
	];
	exports.WriteGetObjectResponseRequest$ = [
		3,
		n0,
		_WGORR,
		0,
		[
			_RReq,
			_RTe,
			_Bo,
			_SCt,
			_ECr,
			_EM,
			_AR,
			_CC,
			_CDo,
			_CEo,
			_CL,
			_CLo,
			_CR,
			_CTo,
			_CCRC,
			_CCRCC,
			_CCRCNVME,
			_CSHA,
			_CSHAh,
			_CSHAhe,
			_CMD,
			_CXXHASH,
			_CXXHASHh,
			_CXXHASHhe,
			_DM,
			_ETa,
			_Ex,
			_E,
			_LM,
			_MM,
			_M,
			_OLM,
			_OLLHS,
			_OLRUD,
			_PC,
			_RS,
			_RC,
			_Re,
			_SSE,
			_SSECA,
			_SSEKMSKI,
			_SSECKMD,
			_SC,
			_TC,
			_VI,
			_BKE
		],
		[
			[0, {
				[_hL]: 1,
				[_hH]: _xarr
			}],
			[0, { [_hH]: _xart }],
			[() => StreamingBlob, 16],
			[1, { [_hH]: _xafs }],
			[0, { [_hH]: _xafec }],
			[0, { [_hH]: _xafem }],
			[0, { [_hH]: _xafhar }],
			[0, { [_hH]: _xafhCC }],
			[0, { [_hH]: _xafhCD }],
			[0, { [_hH]: _xafhCE }],
			[0, { [_hH]: _xafhCL }],
			[1, { [_hH]: _CL__ }],
			[0, { [_hH]: _xafhCR }],
			[0, { [_hH]: _xafhCT }],
			[0, { [_hH]: _xafhxacc }],
			[0, { [_hH]: _xafhxacc_ }],
			[0, { [_hH]: _xafhxacc__ }],
			[0, { [_hH]: _xafhxacs }],
			[0, { [_hH]: _xafhxacs_ }],
			[0, { [_hH]: _xafhxacs__ }],
			[0, { [_hH]: _xafhxacm }],
			[0, { [_hH]: _xafhxacx }],
			[0, { [_hH]: _xafhxacx_ }],
			[0, { [_hH]: _xafhxacx__ }],
			[2, { [_hH]: _xafhxadm }],
			[0, { [_hH]: _xafhE }],
			[4, { [_hH]: _xafhE_ }],
			[0, { [_hH]: _xafhxae }],
			[4, { [_hH]: _xafhLM }],
			[1, { [_hH]: _xafhxamm }],
			[128, { [_hPH]: _xam }],
			[0, { [_hH]: _xafhxaolm }],
			[0, { [_hH]: _xafhxaollh }],
			[5, { [_hH]: _xafhxaolrud }],
			[1, { [_hH]: _xafhxampc }],
			[0, { [_hH]: _xafhxars }],
			[0, { [_hH]: _xafhxarc }],
			[0, { [_hH]: _xafhxar }],
			[0, { [_hH]: _xafhxasse }],
			[0, { [_hH]: _xafhxasseca }],
			[() => SSEKMSKeyId, { [_hH]: _xafhxasseakki }],
			[0, { [_hH]: _xafhxasseckM }],
			[0, { [_hH]: _xafhxasc }],
			[1, { [_hH]: _xafhxatc }],
			[0, { [_hH]: _xafhxavi }],
			[2, { [_hH]: _xafhxassebke }]
		],
		2
	];
	var __Unit = "unit";
	var AnalyticsConfigurationList = [
		1,
		n0,
		_ACLn,
		0,
		[() => exports.AnalyticsConfiguration$, 0]
	];
	var Buckets = [
		1,
		n0,
		_Bu,
		0,
		[() => exports.Bucket$, { [_xN]: _B }]
	];
	var CommonPrefixList = [
		1,
		n0,
		_CPL,
		0,
		() => exports.CommonPrefix$
	];
	var CompletedPartList = [
		1,
		n0,
		_CPLo,
		0,
		() => exports.CompletedPart$
	];
	var CORSRules = [
		1,
		n0,
		_CORSR,
		0,
		[() => exports.CORSRule$, 0]
	];
	var DeletedObjects = [
		1,
		n0,
		_DOe,
		0,
		() => exports.DeletedObject$
	];
	var DeleteMarkers = [
		1,
		n0,
		_DMe,
		0,
		() => exports.DeleteMarkerEntry$
	];
	var EncryptionTypeList = [
		1,
		n0,
		_ETL,
		0,
		[0, { [_xN]: _ET }]
	];
	var Errors = [
		1,
		n0,
		_Er,
		0,
		() => exports._Error$
	];
	var FilterRuleList = [
		1,
		n0,
		_FRL,
		0,
		() => exports.FilterRule$
	];
	var Grants = [
		1,
		n0,
		_G,
		0,
		[() => exports.Grant$, { [_xN]: _Gr }]
	];
	var IntelligentTieringConfigurationList = [
		1,
		n0,
		_ITCL,
		0,
		[() => exports.IntelligentTieringConfiguration$, 0]
	];
	var InventoryConfigurationList = [
		1,
		n0,
		_ICL,
		0,
		[() => exports.InventoryConfiguration$, 0]
	];
	var InventoryOptionalFields = [
		1,
		n0,
		_IOF,
		0,
		[0, { [_xN]: _Fi }]
	];
	var LambdaFunctionConfigurationList = [
		1,
		n0,
		_LFCL,
		0,
		[() => exports.LambdaFunctionConfiguration$, 0]
	];
	var LifecycleRules = [
		1,
		n0,
		_LRi,
		0,
		[() => exports.LifecycleRule$, 0]
	];
	var MetricsConfigurationList = [
		1,
		n0,
		_MCL,
		0,
		[() => exports.MetricsConfiguration$, 0]
	];
	var MultipartUploadList = [
		1,
		n0,
		_MUL,
		0,
		() => exports.MultipartUpload$
	];
	var NoncurrentVersionTransitionList = [
		1,
		n0,
		_NVTL,
		0,
		() => exports.NoncurrentVersionTransition$
	];
	var ObjectIdentifierList = [
		1,
		n0,
		_OIL,
		0,
		() => exports.ObjectIdentifier$
	];
	var ObjectList = [
		1,
		n0,
		_OLb,
		0,
		[() => exports._Object$, 0]
	];
	var ObjectVersionList = [
		1,
		n0,
		_OVL,
		0,
		[() => exports.ObjectVersion$, 0]
	];
	var OwnershipControlsRules = [
		1,
		n0,
		_OCRw,
		0,
		() => exports.OwnershipControlsRule$
	];
	var Parts = [
		1,
		n0,
		_Pa,
		0,
		() => exports.Part$
	];
	var PartsList = [
		1,
		n0,
		_PL,
		0,
		() => exports.ObjectPart$
	];
	var QueueConfigurationList = [
		1,
		n0,
		_QCL,
		0,
		[() => exports.QueueConfiguration$, 0]
	];
	var ReplicationRules = [
		1,
		n0,
		_RRep,
		0,
		[() => exports.ReplicationRule$, 0]
	];
	var RoutingRules = [
		1,
		n0,
		_RR,
		0,
		[() => exports.RoutingRule$, { [_xN]: _RRo }]
	];
	var ServerSideEncryptionRules = [
		1,
		n0,
		_SSERe,
		0,
		[() => exports.ServerSideEncryptionRule$, 0]
	];
	var TagSet = [
		1,
		n0,
		_TS,
		0,
		[() => exports.Tag$, { [_xN]: _Ta }]
	];
	var TargetGrants = [
		1,
		n0,
		_TG,
		0,
		[() => exports.TargetGrant$, { [_xN]: _Gr }]
	];
	var TieringList = [
		1,
		n0,
		_TL,
		0,
		() => exports.Tiering$
	];
	var TopicConfigurationList = [
		1,
		n0,
		_TCL,
		0,
		[() => exports.TopicConfiguration$, 0]
	];
	var TransitionList = [
		1,
		n0,
		_TLr,
		0,
		() => exports.Transition$
	];
	var UserMetadata = [
		1,
		n0,
		_UM,
		0,
		[() => exports.MetadataEntry$, { [_xN]: _ME }]
	];
	exports.AnalyticsFilter$ = [
		4,
		n0,
		_AF,
		0,
		[
			_P,
			_Ta,
			_An
		],
		[
			0,
			() => exports.Tag$,
			[() => exports.AnalyticsAndOperator$, 0]
		]
	];
	exports.MetricsFilter$ = [
		4,
		n0,
		_MF,
		0,
		[
			_P,
			_Ta,
			_APAc,
			_An
		],
		[
			0,
			() => exports.Tag$,
			0,
			[() => exports.MetricsAndOperator$, 0]
		]
	];
	exports.ObjectEncryption$ = [
		4,
		n0,
		_OE,
		0,
		[_SSEKMS],
		[[() => exports.SSEKMSEncryption$, { [_xN]: _SK }]]
	];
	exports.SelectObjectContentEventStream$ = [
		4,
		n0,
		_SOCES,
		{ [_st]: 1 },
		[
			_Rec,
			_Sta,
			_Pr,
			_Cont,
			_End
		],
		[
			[() => exports.RecordsEvent$, 0],
			[() => exports.StatsEvent$, 0],
			[() => exports.ProgressEvent$, 0],
			() => exports.ContinuationEvent$,
			() => exports.EndEvent$
		]
	];
	exports.AbortMultipartUpload$ = [
		9,
		n0,
		_AMU,
		{ [_h]: [
			"DELETE",
			"/{Key+}?x-id=AbortMultipartUpload",
			204
		] },
		() => exports.AbortMultipartUploadRequest$,
		() => exports.AbortMultipartUploadOutput$
	];
	exports.CompleteMultipartUpload$ = [
		9,
		n0,
		_CMUo,
		{ [_h]: [
			"POST",
			"/{Key+}",
			200
		] },
		() => exports.CompleteMultipartUploadRequest$,
		() => exports.CompleteMultipartUploadOutput$
	];
	exports.CopyObject$ = [
		9,
		n0,
		_CO,
		{ [_h]: [
			"PUT",
			"/{Key+}?x-id=CopyObject",
			200
		] },
		() => exports.CopyObjectRequest$,
		() => exports.CopyObjectOutput$
	];
	exports.CreateBucket$ = [
		9,
		n0,
		_CB,
		{ [_h]: [
			"PUT",
			"/",
			200
		] },
		() => exports.CreateBucketRequest$,
		() => exports.CreateBucketOutput$
	];
	exports.CreateBucketMetadataConfiguration$ = [
		9,
		n0,
		_CBMC,
		{
			[_hC]: "-",
			[_h]: [
				"POST",
				"/?metadataConfiguration",
				200
			]
		},
		() => exports.CreateBucketMetadataConfigurationRequest$,
		() => __Unit
	];
	exports.CreateBucketMetadataTableConfiguration$ = [
		9,
		n0,
		_CBMTC,
		{
			[_hC]: "-",
			[_h]: [
				"POST",
				"/?metadataTable",
				200
			]
		},
		() => exports.CreateBucketMetadataTableConfigurationRequest$,
		() => __Unit
	];
	exports.CreateMultipartUpload$ = [
		9,
		n0,
		_CMUr,
		{ [_h]: [
			"POST",
			"/{Key+}?uploads",
			200
		] },
		() => exports.CreateMultipartUploadRequest$,
		() => exports.CreateMultipartUploadOutput$
	];
	exports.CreateSession$ = [
		9,
		n0,
		_CSr,
		{ [_h]: [
			"GET",
			"/?session",
			200
		] },
		() => exports.CreateSessionRequest$,
		() => exports.CreateSessionOutput$
	];
	exports.DeleteBucket$ = [
		9,
		n0,
		_DB,
		{ [_h]: [
			"DELETE",
			"/",
			204
		] },
		() => exports.DeleteBucketRequest$,
		() => __Unit
	];
	exports.DeleteBucketAnalyticsConfiguration$ = [
		9,
		n0,
		_DBAC,
		{ [_h]: [
			"DELETE",
			"/?analytics",
			204
		] },
		() => exports.DeleteBucketAnalyticsConfigurationRequest$,
		() => __Unit
	];
	exports.DeleteBucketCors$ = [
		9,
		n0,
		_DBC,
		{ [_h]: [
			"DELETE",
			"/?cors",
			204
		] },
		() => exports.DeleteBucketCorsRequest$,
		() => __Unit
	];
	exports.DeleteBucketEncryption$ = [
		9,
		n0,
		_DBE,
		{ [_h]: [
			"DELETE",
			"/?encryption",
			204
		] },
		() => exports.DeleteBucketEncryptionRequest$,
		() => __Unit
	];
	exports.DeleteBucketIntelligentTieringConfiguration$ = [
		9,
		n0,
		_DBITC,
		{ [_h]: [
			"DELETE",
			"/?intelligent-tiering",
			204
		] },
		() => exports.DeleteBucketIntelligentTieringConfigurationRequest$,
		() => __Unit
	];
	exports.DeleteBucketInventoryConfiguration$ = [
		9,
		n0,
		_DBIC,
		{ [_h]: [
			"DELETE",
			"/?inventory",
			204
		] },
		() => exports.DeleteBucketInventoryConfigurationRequest$,
		() => __Unit
	];
	exports.DeleteBucketLifecycle$ = [
		9,
		n0,
		_DBL,
		{ [_h]: [
			"DELETE",
			"/?lifecycle",
			204
		] },
		() => exports.DeleteBucketLifecycleRequest$,
		() => __Unit
	];
	exports.DeleteBucketMetadataConfiguration$ = [
		9,
		n0,
		_DBMC,
		{ [_h]: [
			"DELETE",
			"/?metadataConfiguration",
			204
		] },
		() => exports.DeleteBucketMetadataConfigurationRequest$,
		() => __Unit
	];
	exports.DeleteBucketMetadataTableConfiguration$ = [
		9,
		n0,
		_DBMTC,
		{ [_h]: [
			"DELETE",
			"/?metadataTable",
			204
		] },
		() => exports.DeleteBucketMetadataTableConfigurationRequest$,
		() => __Unit
	];
	exports.DeleteBucketMetricsConfiguration$ = [
		9,
		n0,
		_DBMCe,
		{ [_h]: [
			"DELETE",
			"/?metrics",
			204
		] },
		() => exports.DeleteBucketMetricsConfigurationRequest$,
		() => __Unit
	];
	exports.DeleteBucketOwnershipControls$ = [
		9,
		n0,
		_DBOC,
		{ [_h]: [
			"DELETE",
			"/?ownershipControls",
			204
		] },
		() => exports.DeleteBucketOwnershipControlsRequest$,
		() => __Unit
	];
	exports.DeleteBucketPolicy$ = [
		9,
		n0,
		_DBP,
		{ [_h]: [
			"DELETE",
			"/?policy",
			204
		] },
		() => exports.DeleteBucketPolicyRequest$,
		() => __Unit
	];
	exports.DeleteBucketReplication$ = [
		9,
		n0,
		_DBRe,
		{ [_h]: [
			"DELETE",
			"/?replication",
			204
		] },
		() => exports.DeleteBucketReplicationRequest$,
		() => __Unit
	];
	exports.DeleteBucketTagging$ = [
		9,
		n0,
		_DBT,
		{ [_h]: [
			"DELETE",
			"/?tagging",
			204
		] },
		() => exports.DeleteBucketTaggingRequest$,
		() => __Unit
	];
	exports.DeleteBucketWebsite$ = [
		9,
		n0,
		_DBW,
		{ [_h]: [
			"DELETE",
			"/?website",
			204
		] },
		() => exports.DeleteBucketWebsiteRequest$,
		() => __Unit
	];
	exports.DeleteObject$ = [
		9,
		n0,
		_DOel,
		{ [_h]: [
			"DELETE",
			"/{Key+}?x-id=DeleteObject",
			204
		] },
		() => exports.DeleteObjectRequest$,
		() => exports.DeleteObjectOutput$
	];
	exports.DeleteObjects$ = [
		9,
		n0,
		_DOele,
		{
			[_hC]: "-",
			[_h]: [
				"POST",
				"/?delete",
				200
			]
		},
		() => exports.DeleteObjectsRequest$,
		() => exports.DeleteObjectsOutput$
	];
	exports.DeleteObjectTagging$ = [
		9,
		n0,
		_DOT,
		{ [_h]: [
			"DELETE",
			"/{Key+}?tagging",
			204
		] },
		() => exports.DeleteObjectTaggingRequest$,
		() => exports.DeleteObjectTaggingOutput$
	];
	exports.DeletePublicAccessBlock$ = [
		9,
		n0,
		_DPAB,
		{ [_h]: [
			"DELETE",
			"/?publicAccessBlock",
			204
		] },
		() => exports.DeletePublicAccessBlockRequest$,
		() => __Unit
	];
	exports.GetBucketAbac$ = [
		9,
		n0,
		_GBA,
		{ [_h]: [
			"GET",
			"/?abac",
			200
		] },
		() => exports.GetBucketAbacRequest$,
		() => exports.GetBucketAbacOutput$
	];
	exports.GetBucketAccelerateConfiguration$ = [
		9,
		n0,
		_GBAC,
		{ [_h]: [
			"GET",
			"/?accelerate",
			200
		] },
		() => exports.GetBucketAccelerateConfigurationRequest$,
		() => exports.GetBucketAccelerateConfigurationOutput$
	];
	exports.GetBucketAcl$ = [
		9,
		n0,
		_GBAe,
		{ [_h]: [
			"GET",
			"/?acl",
			200
		] },
		() => exports.GetBucketAclRequest$,
		() => exports.GetBucketAclOutput$
	];
	exports.GetBucketAnalyticsConfiguration$ = [
		9,
		n0,
		_GBACe,
		{ [_h]: [
			"GET",
			"/?analytics&x-id=GetBucketAnalyticsConfiguration",
			200
		] },
		() => exports.GetBucketAnalyticsConfigurationRequest$,
		() => exports.GetBucketAnalyticsConfigurationOutput$
	];
	exports.GetBucketCors$ = [
		9,
		n0,
		_GBC,
		{ [_h]: [
			"GET",
			"/?cors",
			200
		] },
		() => exports.GetBucketCorsRequest$,
		() => exports.GetBucketCorsOutput$
	];
	exports.GetBucketEncryption$ = [
		9,
		n0,
		_GBE,
		{ [_h]: [
			"GET",
			"/?encryption",
			200
		] },
		() => exports.GetBucketEncryptionRequest$,
		() => exports.GetBucketEncryptionOutput$
	];
	exports.GetBucketIntelligentTieringConfiguration$ = [
		9,
		n0,
		_GBITC,
		{ [_h]: [
			"GET",
			"/?intelligent-tiering&x-id=GetBucketIntelligentTieringConfiguration",
			200
		] },
		() => exports.GetBucketIntelligentTieringConfigurationRequest$,
		() => exports.GetBucketIntelligentTieringConfigurationOutput$
	];
	exports.GetBucketInventoryConfiguration$ = [
		9,
		n0,
		_GBIC,
		{ [_h]: [
			"GET",
			"/?inventory&x-id=GetBucketInventoryConfiguration",
			200
		] },
		() => exports.GetBucketInventoryConfigurationRequest$,
		() => exports.GetBucketInventoryConfigurationOutput$
	];
	exports.GetBucketLifecycleConfiguration$ = [
		9,
		n0,
		_GBLC,
		{ [_h]: [
			"GET",
			"/?lifecycle",
			200
		] },
		() => exports.GetBucketLifecycleConfigurationRequest$,
		() => exports.GetBucketLifecycleConfigurationOutput$
	];
	exports.GetBucketLocation$ = [
		9,
		n0,
		_GBL,
		{ [_h]: [
			"GET",
			"/?location",
			200
		] },
		() => exports.GetBucketLocationRequest$,
		() => exports.GetBucketLocationOutput$
	];
	exports.GetBucketLogging$ = [
		9,
		n0,
		_GBLe,
		{ [_h]: [
			"GET",
			"/?logging",
			200
		] },
		() => exports.GetBucketLoggingRequest$,
		() => exports.GetBucketLoggingOutput$
	];
	exports.GetBucketMetadataConfiguration$ = [
		9,
		n0,
		_GBMC,
		{ [_h]: [
			"GET",
			"/?metadataConfiguration",
			200
		] },
		() => exports.GetBucketMetadataConfigurationRequest$,
		() => exports.GetBucketMetadataConfigurationOutput$
	];
	exports.GetBucketMetadataTableConfiguration$ = [
		9,
		n0,
		_GBMTC,
		{ [_h]: [
			"GET",
			"/?metadataTable",
			200
		] },
		() => exports.GetBucketMetadataTableConfigurationRequest$,
		() => exports.GetBucketMetadataTableConfigurationOutput$
	];
	exports.GetBucketMetricsConfiguration$ = [
		9,
		n0,
		_GBMCe,
		{ [_h]: [
			"GET",
			"/?metrics&x-id=GetBucketMetricsConfiguration",
			200
		] },
		() => exports.GetBucketMetricsConfigurationRequest$,
		() => exports.GetBucketMetricsConfigurationOutput$
	];
	exports.GetBucketNotificationConfiguration$ = [
		9,
		n0,
		_GBNC,
		{ [_h]: [
			"GET",
			"/?notification",
			200
		] },
		() => exports.GetBucketNotificationConfigurationRequest$,
		() => exports.NotificationConfiguration$
	];
	exports.GetBucketOwnershipControls$ = [
		9,
		n0,
		_GBOC,
		{ [_h]: [
			"GET",
			"/?ownershipControls",
			200
		] },
		() => exports.GetBucketOwnershipControlsRequest$,
		() => exports.GetBucketOwnershipControlsOutput$
	];
	exports.GetBucketPolicy$ = [
		9,
		n0,
		_GBP,
		{ [_h]: [
			"GET",
			"/?policy",
			200
		] },
		() => exports.GetBucketPolicyRequest$,
		() => exports.GetBucketPolicyOutput$
	];
	exports.GetBucketPolicyStatus$ = [
		9,
		n0,
		_GBPS,
		{ [_h]: [
			"GET",
			"/?policyStatus",
			200
		] },
		() => exports.GetBucketPolicyStatusRequest$,
		() => exports.GetBucketPolicyStatusOutput$
	];
	exports.GetBucketReplication$ = [
		9,
		n0,
		_GBR,
		{ [_h]: [
			"GET",
			"/?replication",
			200
		] },
		() => exports.GetBucketReplicationRequest$,
		() => exports.GetBucketReplicationOutput$
	];
	exports.GetBucketRequestPayment$ = [
		9,
		n0,
		_GBRP,
		{ [_h]: [
			"GET",
			"/?requestPayment",
			200
		] },
		() => exports.GetBucketRequestPaymentRequest$,
		() => exports.GetBucketRequestPaymentOutput$
	];
	exports.GetBucketTagging$ = [
		9,
		n0,
		_GBT,
		{ [_h]: [
			"GET",
			"/?tagging",
			200
		] },
		() => exports.GetBucketTaggingRequest$,
		() => exports.GetBucketTaggingOutput$
	];
	exports.GetBucketVersioning$ = [
		9,
		n0,
		_GBV,
		{ [_h]: [
			"GET",
			"/?versioning",
			200
		] },
		() => exports.GetBucketVersioningRequest$,
		() => exports.GetBucketVersioningOutput$
	];
	exports.GetBucketWebsite$ = [
		9,
		n0,
		_GBW,
		{ [_h]: [
			"GET",
			"/?website",
			200
		] },
		() => exports.GetBucketWebsiteRequest$,
		() => exports.GetBucketWebsiteOutput$
	];
	exports.GetObject$ = [
		9,
		n0,
		_GO,
		{
			[_hC]: "-",
			[_h]: [
				"GET",
				"/{Key+}?x-id=GetObject",
				200
			]
		},
		() => exports.GetObjectRequest$,
		() => exports.GetObjectOutput$
	];
	exports.GetObjectAcl$ = [
		9,
		n0,
		_GOA,
		{ [_h]: [
			"GET",
			"/{Key+}?acl",
			200
		] },
		() => exports.GetObjectAclRequest$,
		() => exports.GetObjectAclOutput$
	];
	exports.GetObjectAttributes$ = [
		9,
		n0,
		_GOAe,
		{ [_h]: [
			"GET",
			"/{Key+}?attributes",
			200
		] },
		() => exports.GetObjectAttributesRequest$,
		() => exports.GetObjectAttributesOutput$
	];
	exports.GetObjectLegalHold$ = [
		9,
		n0,
		_GOLH,
		{ [_h]: [
			"GET",
			"/{Key+}?legal-hold",
			200
		] },
		() => exports.GetObjectLegalHoldRequest$,
		() => exports.GetObjectLegalHoldOutput$
	];
	exports.GetObjectLockConfiguration$ = [
		9,
		n0,
		_GOLC,
		{ [_h]: [
			"GET",
			"/?object-lock",
			200
		] },
		() => exports.GetObjectLockConfigurationRequest$,
		() => exports.GetObjectLockConfigurationOutput$
	];
	exports.GetObjectRetention$ = [
		9,
		n0,
		_GORe,
		{ [_h]: [
			"GET",
			"/{Key+}?retention",
			200
		] },
		() => exports.GetObjectRetentionRequest$,
		() => exports.GetObjectRetentionOutput$
	];
	exports.GetObjectTagging$ = [
		9,
		n0,
		_GOT,
		{ [_h]: [
			"GET",
			"/{Key+}?tagging",
			200
		] },
		() => exports.GetObjectTaggingRequest$,
		() => exports.GetObjectTaggingOutput$
	];
	exports.GetObjectTorrent$ = [
		9,
		n0,
		_GOTe,
		{ [_h]: [
			"GET",
			"/{Key+}?torrent",
			200
		] },
		() => exports.GetObjectTorrentRequest$,
		() => exports.GetObjectTorrentOutput$
	];
	exports.GetPublicAccessBlock$ = [
		9,
		n0,
		_GPAB,
		{ [_h]: [
			"GET",
			"/?publicAccessBlock",
			200
		] },
		() => exports.GetPublicAccessBlockRequest$,
		() => exports.GetPublicAccessBlockOutput$
	];
	exports.HeadBucket$ = [
		9,
		n0,
		_HB,
		{ [_h]: [
			"HEAD",
			"/",
			200
		] },
		() => exports.HeadBucketRequest$,
		() => exports.HeadBucketOutput$
	];
	exports.HeadObject$ = [
		9,
		n0,
		_HO,
		{ [_h]: [
			"HEAD",
			"/{Key+}",
			200
		] },
		() => exports.HeadObjectRequest$,
		() => exports.HeadObjectOutput$
	];
	exports.ListBucketAnalyticsConfigurations$ = [
		9,
		n0,
		_LBAC,
		{ [_h]: [
			"GET",
			"/?analytics&x-id=ListBucketAnalyticsConfigurations",
			200
		] },
		() => exports.ListBucketAnalyticsConfigurationsRequest$,
		() => exports.ListBucketAnalyticsConfigurationsOutput$
	];
	exports.ListBucketIntelligentTieringConfigurations$ = [
		9,
		n0,
		_LBITC,
		{ [_h]: [
			"GET",
			"/?intelligent-tiering&x-id=ListBucketIntelligentTieringConfigurations",
			200
		] },
		() => exports.ListBucketIntelligentTieringConfigurationsRequest$,
		() => exports.ListBucketIntelligentTieringConfigurationsOutput$
	];
	exports.ListBucketInventoryConfigurations$ = [
		9,
		n0,
		_LBIC,
		{ [_h]: [
			"GET",
			"/?inventory&x-id=ListBucketInventoryConfigurations",
			200
		] },
		() => exports.ListBucketInventoryConfigurationsRequest$,
		() => exports.ListBucketInventoryConfigurationsOutput$
	];
	exports.ListBucketMetricsConfigurations$ = [
		9,
		n0,
		_LBMC,
		{ [_h]: [
			"GET",
			"/?metrics&x-id=ListBucketMetricsConfigurations",
			200
		] },
		() => exports.ListBucketMetricsConfigurationsRequest$,
		() => exports.ListBucketMetricsConfigurationsOutput$
	];
	exports.ListBuckets$ = [
		9,
		n0,
		_LB,
		{ [_h]: [
			"GET",
			"/?x-id=ListBuckets",
			200
		] },
		() => exports.ListBucketsRequest$,
		() => exports.ListBucketsOutput$
	];
	exports.ListDirectoryBuckets$ = [
		9,
		n0,
		_LDB,
		{ [_h]: [
			"GET",
			"/?x-id=ListDirectoryBuckets",
			200
		] },
		() => exports.ListDirectoryBucketsRequest$,
		() => exports.ListDirectoryBucketsOutput$
	];
	exports.ListMultipartUploads$ = [
		9,
		n0,
		_LMU,
		{ [_h]: [
			"GET",
			"/?uploads",
			200
		] },
		() => exports.ListMultipartUploadsRequest$,
		() => exports.ListMultipartUploadsOutput$
	];
	exports.ListObjects$ = [
		9,
		n0,
		_LO,
		{ [_h]: [
			"GET",
			"/",
			200
		] },
		() => exports.ListObjectsRequest$,
		() => exports.ListObjectsOutput$
	];
	exports.ListObjectsV2$ = [
		9,
		n0,
		_LOV,
		{ [_h]: [
			"GET",
			"/?list-type=2",
			200
		] },
		() => exports.ListObjectsV2Request$,
		() => exports.ListObjectsV2Output$
	];
	exports.ListObjectVersions$ = [
		9,
		n0,
		_LOVi,
		{ [_h]: [
			"GET",
			"/?versions",
			200
		] },
		() => exports.ListObjectVersionsRequest$,
		() => exports.ListObjectVersionsOutput$
	];
	exports.ListParts$ = [
		9,
		n0,
		_LP,
		{ [_h]: [
			"GET",
			"/{Key+}?x-id=ListParts",
			200
		] },
		() => exports.ListPartsRequest$,
		() => exports.ListPartsOutput$
	];
	exports.PutBucketAbac$ = [
		9,
		n0,
		_PBA,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?abac",
				200
			]
		},
		() => exports.PutBucketAbacRequest$,
		() => __Unit
	];
	exports.PutBucketAccelerateConfiguration$ = [
		9,
		n0,
		_PBAC,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?accelerate",
				200
			]
		},
		() => exports.PutBucketAccelerateConfigurationRequest$,
		() => __Unit
	];
	exports.PutBucketAcl$ = [
		9,
		n0,
		_PBAu,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?acl",
				200
			]
		},
		() => exports.PutBucketAclRequest$,
		() => __Unit
	];
	exports.PutBucketAnalyticsConfiguration$ = [
		9,
		n0,
		_PBACu,
		{ [_h]: [
			"PUT",
			"/?analytics",
			200
		] },
		() => exports.PutBucketAnalyticsConfigurationRequest$,
		() => __Unit
	];
	exports.PutBucketCors$ = [
		9,
		n0,
		_PBC,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?cors",
				200
			]
		},
		() => exports.PutBucketCorsRequest$,
		() => __Unit
	];
	exports.PutBucketEncryption$ = [
		9,
		n0,
		_PBE,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?encryption",
				200
			]
		},
		() => exports.PutBucketEncryptionRequest$,
		() => __Unit
	];
	exports.PutBucketIntelligentTieringConfiguration$ = [
		9,
		n0,
		_PBITC,
		{ [_h]: [
			"PUT",
			"/?intelligent-tiering",
			200
		] },
		() => exports.PutBucketIntelligentTieringConfigurationRequest$,
		() => __Unit
	];
	exports.PutBucketInventoryConfiguration$ = [
		9,
		n0,
		_PBIC,
		{ [_h]: [
			"PUT",
			"/?inventory",
			200
		] },
		() => exports.PutBucketInventoryConfigurationRequest$,
		() => __Unit
	];
	exports.PutBucketLifecycleConfiguration$ = [
		9,
		n0,
		_PBLC,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?lifecycle",
				200
			]
		},
		() => exports.PutBucketLifecycleConfigurationRequest$,
		() => exports.PutBucketLifecycleConfigurationOutput$
	];
	exports.PutBucketLogging$ = [
		9,
		n0,
		_PBL,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?logging",
				200
			]
		},
		() => exports.PutBucketLoggingRequest$,
		() => __Unit
	];
	exports.PutBucketMetricsConfiguration$ = [
		9,
		n0,
		_PBMC,
		{ [_h]: [
			"PUT",
			"/?metrics",
			200
		] },
		() => exports.PutBucketMetricsConfigurationRequest$,
		() => __Unit
	];
	exports.PutBucketNotificationConfiguration$ = [
		9,
		n0,
		_PBNC,
		{ [_h]: [
			"PUT",
			"/?notification",
			200
		] },
		() => exports.PutBucketNotificationConfigurationRequest$,
		() => __Unit
	];
	exports.PutBucketOwnershipControls$ = [
		9,
		n0,
		_PBOC,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?ownershipControls",
				200
			]
		},
		() => exports.PutBucketOwnershipControlsRequest$,
		() => __Unit
	];
	exports.PutBucketPolicy$ = [
		9,
		n0,
		_PBP,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?policy",
				200
			]
		},
		() => exports.PutBucketPolicyRequest$,
		() => __Unit
	];
	exports.PutBucketReplication$ = [
		9,
		n0,
		_PBR,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?replication",
				200
			]
		},
		() => exports.PutBucketReplicationRequest$,
		() => __Unit
	];
	exports.PutBucketRequestPayment$ = [
		9,
		n0,
		_PBRP,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?requestPayment",
				200
			]
		},
		() => exports.PutBucketRequestPaymentRequest$,
		() => __Unit
	];
	exports.PutBucketTagging$ = [
		9,
		n0,
		_PBT,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?tagging",
				200
			]
		},
		() => exports.PutBucketTaggingRequest$,
		() => __Unit
	];
	exports.PutBucketVersioning$ = [
		9,
		n0,
		_PBV,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?versioning",
				200
			]
		},
		() => exports.PutBucketVersioningRequest$,
		() => __Unit
	];
	exports.PutBucketWebsite$ = [
		9,
		n0,
		_PBW,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?website",
				200
			]
		},
		() => exports.PutBucketWebsiteRequest$,
		() => __Unit
	];
	exports.PutObject$ = [
		9,
		n0,
		_PO,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/{Key+}?x-id=PutObject",
				200
			]
		},
		() => exports.PutObjectRequest$,
		() => exports.PutObjectOutput$
	];
	exports.PutObjectAcl$ = [
		9,
		n0,
		_POA,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/{Key+}?acl",
				200
			]
		},
		() => exports.PutObjectAclRequest$,
		() => exports.PutObjectAclOutput$
	];
	exports.PutObjectLegalHold$ = [
		9,
		n0,
		_POLH,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/{Key+}?legal-hold",
				200
			]
		},
		() => exports.PutObjectLegalHoldRequest$,
		() => exports.PutObjectLegalHoldOutput$
	];
	exports.PutObjectLockConfiguration$ = [
		9,
		n0,
		_POLC,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?object-lock",
				200
			]
		},
		() => exports.PutObjectLockConfigurationRequest$,
		() => exports.PutObjectLockConfigurationOutput$
	];
	exports.PutObjectRetention$ = [
		9,
		n0,
		_PORu,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/{Key+}?retention",
				200
			]
		},
		() => exports.PutObjectRetentionRequest$,
		() => exports.PutObjectRetentionOutput$
	];
	exports.PutObjectTagging$ = [
		9,
		n0,
		_POT,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/{Key+}?tagging",
				200
			]
		},
		() => exports.PutObjectTaggingRequest$,
		() => exports.PutObjectTaggingOutput$
	];
	exports.PutPublicAccessBlock$ = [
		9,
		n0,
		_PPAB,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?publicAccessBlock",
				200
			]
		},
		() => exports.PutPublicAccessBlockRequest$,
		() => __Unit
	];
	exports.RenameObject$ = [
		9,
		n0,
		_RO,
		{ [_h]: [
			"PUT",
			"/{Key+}?renameObject",
			200
		] },
		() => exports.RenameObjectRequest$,
		() => exports.RenameObjectOutput$
	];
	exports.RestoreObject$ = [
		9,
		n0,
		_ROe,
		{
			[_hC]: "-",
			[_h]: [
				"POST",
				"/{Key+}?restore",
				200
			]
		},
		() => exports.RestoreObjectRequest$,
		() => exports.RestoreObjectOutput$
	];
	exports.SelectObjectContent$ = [
		9,
		n0,
		_SOC,
		{ [_h]: [
			"POST",
			"/{Key+}?select&select-type=2",
			200
		] },
		() => exports.SelectObjectContentRequest$,
		() => exports.SelectObjectContentOutput$
	];
	exports.UpdateBucketMetadataInventoryTableConfiguration$ = [
		9,
		n0,
		_UBMITC,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?metadataInventoryTable",
				200
			]
		},
		() => exports.UpdateBucketMetadataInventoryTableConfigurationRequest$,
		() => __Unit
	];
	exports.UpdateBucketMetadataJournalTableConfiguration$ = [
		9,
		n0,
		_UBMJTC,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/?metadataJournalTable",
				200
			]
		},
		() => exports.UpdateBucketMetadataJournalTableConfigurationRequest$,
		() => __Unit
	];
	exports.UpdateObjectEncryption$ = [
		9,
		n0,
		_UOE,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/{Key+}?encryption",
				200
			]
		},
		() => exports.UpdateObjectEncryptionRequest$,
		() => exports.UpdateObjectEncryptionResponse$
	];
	exports.UploadPart$ = [
		9,
		n0,
		_UP,
		{
			[_hC]: "-",
			[_h]: [
				"PUT",
				"/{Key+}?x-id=UploadPart",
				200
			]
		},
		() => exports.UploadPartRequest$,
		() => exports.UploadPartOutput$
	];
	exports.UploadPartCopy$ = [
		9,
		n0,
		_UPC,
		{ [_h]: [
			"PUT",
			"/{Key+}?x-id=UploadPartCopy",
			200
		] },
		() => exports.UploadPartCopyRequest$,
		() => exports.UploadPartCopyOutput$
	];
	exports.WriteGetObjectResponse$ = [
		9,
		n0,
		_WGOR,
		{
			[_en]: ["{RequestRoute}."],
			[_h]: [
				"POST",
				"/WriteGetObjectResponse",
				200
			]
		},
		() => exports.WriteGetObjectResponseRequest$,
		() => __Unit
	];
}));
//#endregion
//#region node_modules/@aws-sdk/client-s3/package.json
var require_package = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {
		"name": "@aws-sdk/client-s3",
		"description": "AWS SDK for JavaScript S3 Client for Node.js, Browser and React Native",
		"version": "3.1051.0",
		"scripts": {
			"build": "concurrently 'yarn:build:types' 'yarn:build:es' && yarn build:cjs",
			"build:cjs": "node ../../scripts/compilation/inline client-s3",
			"build:es": "tsc -p tsconfig.es.json",
			"build:include:deps": "yarn g:turbo run build -F=\"$npm_package_name\"",
			"build:types": "tsc -p tsconfig.types.json",
			"build:types:downlevel": "downlevel-dts dist-types dist-types/ts3.4",
			"clean": "premove dist-cjs dist-es dist-types tsconfig.cjs.tsbuildinfo tsconfig.es.tsbuildinfo tsconfig.types.tsbuildinfo",
			"extract:docs": "api-extractor run --local",
			"generate:client": "node ../../scripts/generate-clients/single-service --solo s3",
			"test": "yarn g:vitest run",
			"test:browser": "node ./test/browser-build/esbuild && yarn g:vitest run -c vitest.config.browser.mts",
			"test:browser:watch": "node ./test/browser-build/esbuild && yarn g:vitest watch -c vitest.config.browser.mts",
			"test:e2e": "yarn g:vitest run -c vitest.config.e2e.mts && yarn test:browser",
			"test:e2e:watch": "yarn g:vitest watch -c vitest.config.e2e.mts",
			"test:index": "tsc --noEmit ./test/index-types.ts && node ./test/index-objects.spec.mjs",
			"test:integration": "yarn g:vitest run -c vitest.config.integ.mts",
			"test:integration:watch": "yarn g:vitest watch -c vitest.config.integ.mts",
			"test:watch": "yarn g:vitest watch"
		},
		"main": "./dist-cjs/index.js",
		"types": "./dist-types/index.d.ts",
		"module": "./dist-es/index.js",
		"sideEffects": false,
		"dependencies": {
			"@aws-crypto/sha1-browser": "5.2.0",
			"@aws-crypto/sha256-browser": "5.2.0",
			"@aws-crypto/sha256-js": "5.2.0",
			"@aws-sdk/core": "^3.974.12",
			"@aws-sdk/credential-provider-node": "^3.972.43",
			"@aws-sdk/middleware-bucket-endpoint": "^3.972.14",
			"@aws-sdk/middleware-expect-continue": "^3.972.12",
			"@aws-sdk/middleware-flexible-checksums": "^3.974.20",
			"@aws-sdk/middleware-location-constraint": "^3.972.10",
			"@aws-sdk/middleware-sdk-s3": "^3.972.41",
			"@aws-sdk/middleware-ssec": "^3.972.10",
			"@aws-sdk/signature-v4-multi-region": "^3.996.27",
			"@aws-sdk/types": "^3.973.8",
			"@smithy/core": "^3.24.2",
			"@smithy/fetch-http-handler": "^5.4.2",
			"@smithy/node-http-handler": "^4.7.2",
			"@smithy/types": "^4.14.1",
			"tslib": "^2.6.2"
		},
		"devDependencies": {
			"@aws-sdk/signature-v4-crt": "3.1051.0",
			"@smithy/snapshot-testing": "^2.1.2",
			"@tsconfig/node20": "20.1.8",
			"@types/node": "^20.14.8",
			"concurrently": "7.0.0",
			"downlevel-dts": "0.10.1",
			"premove": "4.0.0",
			"typescript": "~5.8.3",
			"vitest": "^4.0.17"
		},
		"engines": { "node": ">=20.0.0" },
		"typesVersions": { "<4.5": { "dist-types/*": ["dist-types/ts3.4/*"] } },
		"files": ["dist-*/**"],
		"author": {
			"name": "AWS SDK for JavaScript Team",
			"url": "https://aws.amazon.com/javascript/"
		},
		"license": "Apache-2.0",
		"browser": { "./dist-es/runtimeConfig": "./dist-es/runtimeConfig.browser" },
		"react-native": { "./dist-es/runtimeConfig": "./dist-es/runtimeConfig.native" },
		"homepage": "https://github.com/aws/aws-sdk-js-v3/tree/main/clients/client-s3",
		"repository": {
			"type": "git",
			"url": "https://github.com/aws/aws-sdk-js-v3.git",
			"directory": "clients/client-s3"
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/credential-provider-node/dist-cjs/index.js
var require_dist_cjs$5 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var credentialProviderEnv = require_dist_cjs$11();
	var config = (init_config(), __toCommonJS(config_exports));
	const ENV_IMDS_DISABLED = "AWS_EC2_METADATA_DISABLED";
	const remoteProvider = async (init) => {
		const { ENV_CMDS_FULL_URI, ENV_CMDS_RELATIVE_URI, fromContainerMetadata, fromInstanceMetadata } = await import("./dist-cjs-ulAL16eF.js").then((m) => /* @__PURE__ */ __toESM(m.default));
		if (process.env[ENV_CMDS_RELATIVE_URI] || process.env[ENV_CMDS_FULL_URI]) {
			init.logger?.debug("@aws-sdk/credential-provider-node - remoteProvider::fromHttp/fromContainerMetadata");
			const { fromHttp } = await import("./dist-cjs-sku9Z-qB2.js").then((m) => /* @__PURE__ */ __toESM(m.default));
			return config.chain(fromHttp(init), fromContainerMetadata(init));
		}
		if (process.env[ENV_IMDS_DISABLED] && process.env[ENV_IMDS_DISABLED] !== "false") return async () => {
			throw new config.CredentialsProviderError("EC2 Instance Metadata Service access disabled", { logger: init.logger });
		};
		init.logger?.debug("@aws-sdk/credential-provider-node - remoteProvider::fromInstanceMetadata");
		return fromInstanceMetadata(init);
	};
	function memoizeChain(providers, treatAsExpired) {
		const chain = internalCreateChain(providers);
		let activeLock;
		let passiveLock;
		let credentials;
		const provider = async (options) => {
			if (options?.forceRefresh) return await chain(options);
			if (credentials?.expiration) {
				if (credentials?.expiration?.getTime() < Date.now()) credentials = void 0;
			}
			if (activeLock) await activeLock;
			else if (!credentials || treatAsExpired?.(credentials)) if (credentials) {
				if (!passiveLock) passiveLock = chain(options).then((c) => {
					credentials = c;
				}).finally(() => {
					passiveLock = void 0;
				});
			} else {
				activeLock = chain(options).then((c) => {
					credentials = c;
				}).finally(() => {
					activeLock = void 0;
				});
				return provider(options);
			}
			return credentials;
		};
		return provider;
	}
	const internalCreateChain = (providers) => async (awsIdentityProperties) => {
		let lastProviderError;
		for (const provider of providers) try {
			return await provider(awsIdentityProperties);
		} catch (err) {
			lastProviderError = err;
			if (err?.tryNextLink) continue;
			throw err;
		}
		throw lastProviderError;
	};
	let multipleCredentialSourceWarningEmitted = false;
	const defaultProvider = (init = {}) => memoizeChain([
		async () => {
			if (init.profile ?? process.env[config.ENV_PROFILE]) {
				if (process.env[credentialProviderEnv.ENV_KEY] && process.env[credentialProviderEnv.ENV_SECRET]) {
					if (!multipleCredentialSourceWarningEmitted) {
						(init.logger?.warn && init.logger?.constructor?.name !== "NoOpLogger" ? init.logger.warn.bind(init.logger) : console.warn)(`@aws-sdk/credential-provider-node - defaultProvider::fromEnv WARNING:
    Multiple credential sources detected: 
    Both AWS_PROFILE and the pair AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY static credentials are set.
    This SDK will proceed with the AWS_PROFILE value.
    
    However, a future version may change this behavior to prefer the ENV static credentials.
    Please ensure that your environment only sets either the AWS_PROFILE or the
    AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY pair.
`);
						multipleCredentialSourceWarningEmitted = true;
					}
				}
				throw new config.CredentialsProviderError("AWS_PROFILE is set, skipping fromEnv provider.", {
					logger: init.logger,
					tryNextLink: true
				});
			}
			init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::fromEnv");
			return credentialProviderEnv.fromEnv(init)();
		},
		async (awsIdentityProperties) => {
			init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::fromSSO");
			const { ssoStartUrl, ssoAccountId, ssoRegion, ssoRoleName, ssoSession } = init;
			if (!ssoStartUrl && !ssoAccountId && !ssoRegion && !ssoRoleName && !ssoSession) throw new config.CredentialsProviderError("Skipping SSO provider in default chain (inputs do not include SSO fields).", { logger: init.logger });
			const { fromSSO } = await import("./dist-cjs-D0ote1dm2.js").then((m) => /* @__PURE__ */ __toESM(m.default));
			return fromSSO(init)(awsIdentityProperties);
		},
		async (awsIdentityProperties) => {
			init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::fromIni");
			const { fromIni } = await import("./dist-cjs-C2ZL4MkQ.js").then((m) => /* @__PURE__ */ __toESM(m.default));
			return fromIni(init)(awsIdentityProperties);
		},
		async (awsIdentityProperties) => {
			init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::fromProcess");
			const { fromProcess } = await import("./dist-cjs-Br3PVdcX2.js").then((m) => /* @__PURE__ */ __toESM(m.default));
			return fromProcess(init)(awsIdentityProperties);
		},
		async (awsIdentityProperties) => {
			init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::fromTokenFile");
			const { fromTokenFile } = await import("./dist-cjs-C8qzoy46.js").then((m) => /* @__PURE__ */ __toESM(m.default));
			return fromTokenFile(init)(awsIdentityProperties);
		},
		async () => {
			init.logger?.debug("@aws-sdk/credential-provider-node - defaultProvider::remoteProvider");
			return (await remoteProvider(init))();
		},
		async () => {
			throw new config.CredentialsProviderError("Could not load credentials from any providers", {
				tryNextLink: false,
				logger: init.logger
			});
		}
	], credentialsTreatedAsExpired);
	const credentialsWillNeedRefresh = (credentials) => credentials?.expiration !== void 0;
	const credentialsTreatedAsExpired = (credentials) => credentials?.expiration !== void 0 && credentials.expiration.getTime() - Date.now() < 3e5;
	exports.credentialsTreatedAsExpired = credentialsTreatedAsExpired;
	exports.credentialsWillNeedRefresh = credentialsWillNeedRefresh;
	exports.defaultProvider = defaultProvider;
}));
//#endregion
//#region node_modules/@aws-sdk/middleware-bucket-endpoint/dist-cjs/index.js
var require_dist_cjs$4 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var config = (init_config(), __toCommonJS(config_exports));
	var util = (init_util(), __toCommonJS(util_exports));
	var protocols = (init_protocols(), __toCommonJS(protocols_exports));
	const NODE_DISABLE_MULTIREGION_ACCESS_POINT_ENV_NAME = "AWS_S3_DISABLE_MULTIREGION_ACCESS_POINTS";
	const NODE_DISABLE_MULTIREGION_ACCESS_POINT_INI_NAME = "s3_disable_multiregion_access_points";
	const NODE_DISABLE_MULTIREGION_ACCESS_POINT_CONFIG_OPTIONS = {
		environmentVariableSelector: (env) => config.booleanSelector(env, NODE_DISABLE_MULTIREGION_ACCESS_POINT_ENV_NAME, config.SelectorType.ENV),
		configFileSelector: (profile) => config.booleanSelector(profile, NODE_DISABLE_MULTIREGION_ACCESS_POINT_INI_NAME, config.SelectorType.CONFIG),
		default: false
	};
	const NODE_USE_ARN_REGION_ENV_NAME = "AWS_S3_USE_ARN_REGION";
	const NODE_USE_ARN_REGION_INI_NAME = "s3_use_arn_region";
	const NODE_USE_ARN_REGION_CONFIG_OPTIONS = {
		environmentVariableSelector: (env) => config.booleanSelector(env, NODE_USE_ARN_REGION_ENV_NAME, config.SelectorType.ENV),
		configFileSelector: (profile) => config.booleanSelector(profile, NODE_USE_ARN_REGION_INI_NAME, config.SelectorType.CONFIG),
		default: void 0
	};
	const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9\.\-]{1,61}[a-z0-9]$/;
	const IP_ADDRESS_PATTERN = /(\d+\.){3}\d+/;
	const DOTS_PATTERN = /\.\./;
	const DOT_PATTERN = /\./;
	const S3_HOSTNAME_PATTERN = /^(.+\.)?s3(-fips)?(\.dualstack)?[.-]([a-z0-9-]+)\./;
	const S3_US_EAST_1_ALTNAME_PATTERN = /^s3(-external-1)?\.amazonaws\.com$/;
	const AWS_PARTITION_SUFFIX = "amazonaws.com";
	const isBucketNameOptions = (options) => typeof options.bucketName === "string";
	const isDnsCompatibleBucketName = (bucketName) => DOMAIN_PATTERN.test(bucketName) && !IP_ADDRESS_PATTERN.test(bucketName) && !DOTS_PATTERN.test(bucketName);
	const getRegionalSuffix = (hostname) => {
		const parts = hostname.match(S3_HOSTNAME_PATTERN);
		return [parts[4], hostname.replace(new RegExp(`^${parts[0]}`), "")];
	};
	const getSuffix = (hostname) => S3_US_EAST_1_ALTNAME_PATTERN.test(hostname) ? ["us-east-1", AWS_PARTITION_SUFFIX] : getRegionalSuffix(hostname);
	const getSuffixForArnEndpoint = (hostname) => S3_US_EAST_1_ALTNAME_PATTERN.test(hostname) ? [hostname.replace(`.${AWS_PARTITION_SUFFIX}`, ""), AWS_PARTITION_SUFFIX] : getRegionalSuffix(hostname);
	const validateArnEndpointOptions = (options) => {
		if (options.pathStyleEndpoint) throw new Error("Path-style S3 endpoint is not supported when bucket is an ARN");
		if (options.accelerateEndpoint) throw new Error("Accelerate endpoint is not supported when bucket is an ARN");
		if (!options.tlsCompatible) throw new Error("HTTPS is required when bucket is an ARN");
	};
	const validateService = (service) => {
		if (service !== "s3" && service !== "s3-outposts" && service !== "s3-object-lambda") throw new Error("Expect 's3' or 's3-outposts' or 's3-object-lambda' in ARN service component");
	};
	const validateS3Service = (service) => {
		if (service !== "s3") throw new Error("Expect 's3' in Accesspoint ARN service component");
	};
	const validateOutpostService = (service) => {
		if (service !== "s3-outposts") throw new Error("Expect 's3-posts' in Outpost ARN service component");
	};
	const validatePartition = (partition, options) => {
		if (partition !== options.clientPartition) throw new Error(`Partition in ARN is incompatible, got "${partition}" but expected "${options.clientPartition}"`);
	};
	const validateRegion = (region, options) => {};
	const validateRegionalClient = (region) => {
		if (["s3-external-1", "aws-global"].includes(region)) throw new Error(`Client region ${region} is not regional`);
	};
	const validateAccountId = (accountId) => {
		if (!/[0-9]{12}/.exec(accountId)) throw new Error("Access point ARN accountID does not match regex '[0-9]{12}'");
	};
	const validateDNSHostLabel = (label, options = { tlsCompatible: true }) => {
		if (label.length >= 64 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(label) || /(\d+\.){3}\d+/.test(label) || /[.-]{2}/.test(label) || options?.tlsCompatible && DOT_PATTERN.test(label)) throw new Error(`Invalid DNS label ${label}`);
	};
	const validateCustomEndpoint = (options) => {
		if (options.isCustomEndpoint) {
			if (options.dualstackEndpoint) throw new Error("Dualstack endpoint is not supported with custom endpoint");
			if (options.accelerateEndpoint) throw new Error("Accelerate endpoint is not supported with custom endpoint");
		}
	};
	const getArnResources = (resource) => {
		const delimiter = resource.includes(":") ? ":" : "/";
		const [resourceType, ...rest] = resource.split(delimiter);
		if (resourceType === "accesspoint") {
			if (rest.length !== 1 || rest[0] === "") throw new Error(`Access Point ARN should have one resource accesspoint${delimiter}{accesspointname}`);
			return { accesspointName: rest[0] };
		} else if (resourceType === "outpost") {
			if (!rest[0] || rest[1] !== "accesspoint" || !rest[2] || rest.length !== 3) throw new Error(`Outpost ARN should have resource outpost${delimiter}{outpostId}${delimiter}accesspoint${delimiter}{accesspointName}`);
			const [outpostId, _, accesspointName] = rest;
			return {
				outpostId,
				accesspointName
			};
		} else throw new Error(`ARN resource should begin with 'accesspoint${delimiter}' or 'outpost${delimiter}'`);
	};
	const validateNoDualstack = (dualstackEndpoint) => {};
	const validateNoFIPS = (useFipsEndpoint) => {
		if (useFipsEndpoint) throw new Error(`FIPS region is not supported with Outpost.`);
	};
	const validateMrapAlias = (name) => {
		try {
			name.split(".").forEach((label) => {
				validateDNSHostLabel(label);
			});
		} catch (e) {
			throw new Error(`"${name}" is not a DNS compatible name.`);
		}
	};
	const bucketHostname = (options) => {
		validateCustomEndpoint(options);
		return isBucketNameOptions(options) ? getEndpointFromBucketName(options) : getEndpointFromArn(options);
	};
	const getEndpointFromBucketName = ({ accelerateEndpoint = false, clientRegion: region, baseHostname, bucketName, dualstackEndpoint = false, fipsEndpoint = false, pathStyleEndpoint = false, tlsCompatible = true, isCustomEndpoint = false }) => {
		const [clientRegion, hostnameSuffix] = isCustomEndpoint ? [region, baseHostname] : getSuffix(baseHostname);
		if (pathStyleEndpoint || !isDnsCompatibleBucketName(bucketName) || tlsCompatible && DOT_PATTERN.test(bucketName)) return {
			bucketEndpoint: false,
			hostname: dualstackEndpoint ? `s3.dualstack.${clientRegion}.${hostnameSuffix}` : baseHostname
		};
		if (accelerateEndpoint) baseHostname = `s3-accelerate${dualstackEndpoint ? ".dualstack" : ""}.${hostnameSuffix}`;
		else if (dualstackEndpoint) baseHostname = `s3.dualstack.${clientRegion}.${hostnameSuffix}`;
		return {
			bucketEndpoint: true,
			hostname: `${bucketName}.${baseHostname}`
		};
	};
	const getEndpointFromArn = (options) => {
		const { isCustomEndpoint, baseHostname, clientRegion } = options;
		const hostnameSuffix = isCustomEndpoint ? baseHostname : getSuffixForArnEndpoint(baseHostname)[1];
		const { pathStyleEndpoint, accelerateEndpoint = false, fipsEndpoint = false, tlsCompatible = true, bucketName, clientPartition = "aws" } = options;
		validateArnEndpointOptions({
			pathStyleEndpoint,
			accelerateEndpoint,
			tlsCompatible
		});
		const { service, partition, accountId, region, resource } = bucketName;
		validateService(service);
		validatePartition(partition, { clientPartition });
		validateAccountId(accountId);
		const { accesspointName, outpostId } = getArnResources(resource);
		if (service === "s3-object-lambda") return getEndpointFromObjectLambdaArn({
			...options,
			tlsCompatible,
			bucketName,
			accesspointName,
			hostnameSuffix
		});
		if (region === "") return getEndpointFromMRAPArn({
			...options,
			mrapAlias: accesspointName,
			hostnameSuffix
		});
		if (outpostId) return getEndpointFromOutpostArn({
			...options,
			clientRegion,
			outpostId,
			accesspointName,
			hostnameSuffix
		});
		return getEndpointFromAccessPointArn({
			...options,
			clientRegion,
			accesspointName,
			hostnameSuffix
		});
	};
	const getEndpointFromObjectLambdaArn = ({ dualstackEndpoint = false, fipsEndpoint = false, tlsCompatible = true, useArnRegion, clientRegion, clientSigningRegion = clientRegion, accesspointName, bucketName, hostnameSuffix }) => {
		const { accountId, region, service } = bucketName;
		validateRegionalClient(clientRegion);
		const DNSHostLabel = `${accesspointName}-${accountId}`;
		validateDNSHostLabel(DNSHostLabel, { tlsCompatible });
		const endpointRegion = useArnRegion ? region : clientRegion;
		const signingRegion = useArnRegion ? region : clientSigningRegion;
		return {
			bucketEndpoint: true,
			hostname: `${DNSHostLabel}.${service}${fipsEndpoint ? "-fips" : ""}.${endpointRegion}.${hostnameSuffix}`,
			signingRegion,
			signingService: service
		};
	};
	const getEndpointFromMRAPArn = ({ disableMultiregionAccessPoints, dualstackEndpoint = false, isCustomEndpoint, mrapAlias, hostnameSuffix }) => {
		if (disableMultiregionAccessPoints === true) throw new Error("SDK is attempting to use a MRAP ARN. Please enable to feature.");
		validateMrapAlias(mrapAlias);
		return {
			bucketEndpoint: true,
			hostname: `${mrapAlias}${isCustomEndpoint ? "" : `.accesspoint.s3-global`}.${hostnameSuffix}`,
			signingRegion: "*"
		};
	};
	const getEndpointFromOutpostArn = ({ useArnRegion, clientRegion, clientSigningRegion = clientRegion, bucketName, outpostId, dualstackEndpoint = false, fipsEndpoint = false, tlsCompatible = true, accesspointName, isCustomEndpoint, hostnameSuffix }) => {
		validateRegionalClient(clientRegion);
		const DNSHostLabel = `${accesspointName}-${bucketName.accountId}`;
		validateDNSHostLabel(DNSHostLabel, { tlsCompatible });
		const endpointRegion = useArnRegion ? bucketName.region : clientRegion;
		const signingRegion = useArnRegion ? bucketName.region : clientSigningRegion;
		validateOutpostService(bucketName.service);
		validateDNSHostLabel(outpostId, { tlsCompatible });
		validateNoFIPS(fipsEndpoint);
		return {
			bucketEndpoint: true,
			hostname: `${`${DNSHostLabel}.${outpostId}`}${isCustomEndpoint ? "" : `.s3-outposts.${endpointRegion}`}.${hostnameSuffix}`,
			signingRegion,
			signingService: "s3-outposts"
		};
	};
	const getEndpointFromAccessPointArn = ({ useArnRegion, clientRegion, clientSigningRegion = clientRegion, bucketName, dualstackEndpoint = false, fipsEndpoint = false, tlsCompatible = true, accesspointName, isCustomEndpoint, hostnameSuffix }) => {
		validateRegionalClient(clientRegion);
		const hostnamePrefix = `${accesspointName}-${bucketName.accountId}`;
		validateDNSHostLabel(hostnamePrefix, { tlsCompatible });
		const endpointRegion = useArnRegion ? bucketName.region : clientRegion;
		const signingRegion = useArnRegion ? bucketName.region : clientSigningRegion;
		validateS3Service(bucketName.service);
		return {
			bucketEndpoint: true,
			hostname: `${hostnamePrefix}${isCustomEndpoint ? "" : `.s3-accesspoint${fipsEndpoint ? "-fips" : ""}${dualstackEndpoint ? ".dualstack" : ""}.${endpointRegion}`}.${hostnameSuffix}`,
			signingRegion
		};
	};
	const bucketEndpointMiddleware = (options) => (next, context) => async (args) => {
		const { Bucket: bucketName } = args.input;
		let replaceBucketInPath = options.bucketEndpoint;
		const request = args.request;
		if (protocols.HttpRequest.isInstance(request)) {
			if (options.bucketEndpoint) request.hostname = bucketName;
			else if (util.validate(bucketName)) {
				const bucketArn = util.parse(bucketName);
				const clientRegion = await options.region();
				const useDualstackEndpoint = await options.useDualstackEndpoint();
				const useFipsEndpoint = await options.useFipsEndpoint();
				const { partition, signingRegion = clientRegion } = await options.regionInfoProvider(clientRegion, {
					useDualstackEndpoint,
					useFipsEndpoint
				}) || {};
				const useArnRegion = await options.useArnRegion();
				const { hostname, bucketEndpoint, signingRegion: modifiedSigningRegion, signingService } = bucketHostname({
					bucketName: bucketArn,
					baseHostname: request.hostname,
					accelerateEndpoint: options.useAccelerateEndpoint,
					dualstackEndpoint: useDualstackEndpoint,
					fipsEndpoint: useFipsEndpoint,
					pathStyleEndpoint: options.forcePathStyle,
					tlsCompatible: request.protocol === "https:",
					useArnRegion,
					clientPartition: partition,
					clientSigningRegion: signingRegion,
					clientRegion,
					isCustomEndpoint: options.isCustomEndpoint,
					disableMultiregionAccessPoints: await options.disableMultiregionAccessPoints()
				});
				if (modifiedSigningRegion && modifiedSigningRegion !== signingRegion) context["signing_region"] = modifiedSigningRegion;
				if (signingService && signingService !== "s3") context["signing_service"] = signingService;
				request.hostname = hostname;
				replaceBucketInPath = bucketEndpoint;
			} else {
				const clientRegion = await options.region();
				const dualstackEndpoint = await options.useDualstackEndpoint();
				const fipsEndpoint = await options.useFipsEndpoint();
				const { hostname, bucketEndpoint } = bucketHostname({
					bucketName,
					clientRegion,
					baseHostname: request.hostname,
					accelerateEndpoint: options.useAccelerateEndpoint,
					dualstackEndpoint,
					fipsEndpoint,
					pathStyleEndpoint: options.forcePathStyle,
					tlsCompatible: request.protocol === "https:",
					isCustomEndpoint: options.isCustomEndpoint
				});
				request.hostname = hostname;
				replaceBucketInPath = bucketEndpoint;
			}
			if (replaceBucketInPath) {
				request.path = request.path.replace(/^(\/)?[^\/]+/, "");
				if (request.path === "") request.path = "/";
			}
		}
		return next({
			...args,
			request
		});
	};
	const bucketEndpointMiddlewareOptions = {
		tags: ["BUCKET_ENDPOINT"],
		name: "bucketEndpointMiddleware",
		relation: "before",
		toMiddleware: "hostHeaderMiddleware",
		override: true
	};
	const getBucketEndpointPlugin = (options) => ({ applyToStack: (clientStack) => {
		clientStack.addRelativeTo(bucketEndpointMiddleware(options), bucketEndpointMiddlewareOptions);
	} });
	function resolveBucketEndpointConfig(input) {
		const { bucketEndpoint = false, forcePathStyle = false, useAccelerateEndpoint = false, useArnRegion, disableMultiregionAccessPoints = false } = input;
		return Object.assign(input, {
			bucketEndpoint,
			forcePathStyle,
			useAccelerateEndpoint,
			useArnRegion: typeof useArnRegion === "function" ? useArnRegion : () => Promise.resolve(useArnRegion),
			disableMultiregionAccessPoints: typeof disableMultiregionAccessPoints === "function" ? disableMultiregionAccessPoints : () => Promise.resolve(disableMultiregionAccessPoints)
		});
	}
	exports.NODE_DISABLE_MULTIREGION_ACCESS_POINT_CONFIG_OPTIONS = NODE_DISABLE_MULTIREGION_ACCESS_POINT_CONFIG_OPTIONS;
	exports.NODE_DISABLE_MULTIREGION_ACCESS_POINT_ENV_NAME = NODE_DISABLE_MULTIREGION_ACCESS_POINT_ENV_NAME;
	exports.NODE_DISABLE_MULTIREGION_ACCESS_POINT_INI_NAME = NODE_DISABLE_MULTIREGION_ACCESS_POINT_INI_NAME;
	exports.NODE_USE_ARN_REGION_CONFIG_OPTIONS = NODE_USE_ARN_REGION_CONFIG_OPTIONS;
	exports.NODE_USE_ARN_REGION_ENV_NAME = NODE_USE_ARN_REGION_ENV_NAME;
	exports.NODE_USE_ARN_REGION_INI_NAME = NODE_USE_ARN_REGION_INI_NAME;
	exports.bucketEndpointMiddleware = bucketEndpointMiddleware;
	exports.bucketEndpointMiddlewareOptions = bucketEndpointMiddlewareOptions;
	exports.bucketHostname = bucketHostname;
	exports.getArnResources = getArnResources;
	exports.getBucketEndpointPlugin = getBucketEndpointPlugin;
	exports.getSuffixForArnEndpoint = getSuffixForArnEndpoint;
	exports.resolveBucketEndpointConfig = resolveBucketEndpointConfig;
	exports.validateAccountId = validateAccountId;
	exports.validateDNSHostLabel = validateDNSHostLabel;
	exports.validateNoDualstack = validateNoDualstack;
	exports.validateNoFIPS = validateNoFIPS;
	exports.validateOutpostService = validateOutpostService;
	exports.validatePartition = validatePartition;
	exports.validateRegion = validateRegion;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/checksum/chunked-blob-reader/chunked-blob-reader.js
async function blobReader(blob, onChunk, chunkSize = 1024 * 1024) {
	const size = blob.size;
	let totalBytesRead = 0;
	while (totalBytesRead < size) {
		const slice = blob.slice(totalBytesRead, Math.min(size, totalBytesRead + chunkSize));
		onChunk(new Uint8Array(await slice.arrayBuffer()));
		totalBytesRead += slice.size;
	}
}
var init_chunked_blob_reader = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/checksum/hash-blob-browser/blobHasher.js
var blobHasher;
var init_blobHasher = __esmMin((() => {
	init_chunked_blob_reader();
	blobHasher = async function blobHasher(hashCtor, blob) {
		const hash = new hashCtor();
		await blobReader(blob, (chunk) => {
			hash.update(chunk);
		});
		return hash.digest();
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/checksum/hash-stream-node/HashCalculator.js
var HashCalculator;
var init_HashCalculator = __esmMin((() => {
	init_serde();
	HashCalculator = class extends Writable {
		hash;
		constructor(hash, options) {
			super(options);
			this.hash = hash;
		}
		_write(chunk, encoding, callback) {
			try {
				this.hash.update(toUint8Array(chunk));
			} catch (err) {
				return callback(err);
			}
			callback();
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/checksum/hash-stream-node/fileStreamHasher.js
var fileStreamHasher, isReadStream;
var init_fileStreamHasher = __esmMin((() => {
	init_HashCalculator();
	fileStreamHasher = (hashCtor, fileStream) => new Promise((resolve, reject) => {
		if (!isReadStream(fileStream)) {
			reject(/* @__PURE__ */ new Error("Unable to calculate hash for non-file streams."));
			return;
		}
		const fileStreamTee = createReadStream(fileStream.path, {
			start: fileStream.start,
			end: fileStream.end
		});
		const hash = new hashCtor();
		const hashCalculator = new HashCalculator(hash);
		fileStreamTee.pipe(hashCalculator);
		fileStreamTee.on("error", (err) => {
			hashCalculator.end();
			reject(err);
		});
		hashCalculator.on("error", reject);
		hashCalculator.on("finish", function() {
			hash.digest().then(resolve).catch(reject);
		});
	});
	isReadStream = (stream) => typeof stream.path === "string";
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/checksum/hash-stream-node/readableStreamHasher.js
var readableStreamHasher;
var init_readableStreamHasher = __esmMin((() => {
	init_HashCalculator();
	readableStreamHasher = (hashCtor, readableStream) => {
		if (readableStream.readableFlowing !== null) throw new Error("Unable to calculate hash for flowing readable stream");
		const hash = new hashCtor();
		const hashCalculator = new HashCalculator(hash);
		readableStream.pipe(hashCalculator);
		return new Promise((resolve, reject) => {
			readableStream.on("error", (err) => {
				hashCalculator.end();
				reject(err);
			});
			hashCalculator.on("error", reject);
			hashCalculator.on("finish", () => {
				hash.digest().then(resolve).catch(reject);
			});
		});
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/checksum/md5-js/constants.js
var INIT;
var init_constants = __esmMin((() => {
	INIT = [
		1732584193,
		4023233417,
		2562383102,
		271733878
	];
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/checksum/md5-js/md5.js
function cmn(q, a, b, x, s, t) {
	a = (a + q & 4294967295) + (x + t & 4294967295) & 4294967295;
	return (a << s | a >>> 32 - s) + b & 4294967295;
}
function ff(a, b, c, d, x, s, t) {
	return cmn(b & c | ~b & d, a, b, x, s, t);
}
function gg(a, b, c, d, x, s, t) {
	return cmn(b & d | c & ~d, a, b, x, s, t);
}
function hh(a, b, c, d, x, s, t) {
	return cmn(b ^ c ^ d, a, b, x, s, t);
}
function ii(a, b, c, d, x, s, t) {
	return cmn(c ^ (b | ~d), a, b, x, s, t);
}
function isEmptyData(data) {
	if (typeof data === "string") return data.length === 0;
	return data.byteLength === 0;
}
function convertToBuffer(data) {
	if (typeof data === "string") return fromUtf8(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength / Uint8Array.BYTES_PER_ELEMENT);
	return new Uint8Array(data);
}
var Md5;
var init_md5 = __esmMin((() => {
	init_serde();
	init_constants();
	Md5 = class {
		state;
		buffer;
		bufferLength;
		bytesHashed;
		finished;
		constructor() {
			this.reset();
		}
		update(sourceData) {
			if (isEmptyData(sourceData)) return;
			else if (this.finished) throw new Error("Attempted to update an already finished hash.");
			const data = convertToBuffer(sourceData);
			let position = 0;
			let { byteLength } = data;
			this.bytesHashed += byteLength;
			while (byteLength > 0) {
				this.buffer.setUint8(this.bufferLength++, data[position++]);
				byteLength--;
				if (this.bufferLength === 64) {
					this.hashBuffer();
					this.bufferLength = 0;
				}
			}
		}
		async digest() {
			if (!this.finished) {
				const { buffer, bufferLength: undecoratedLength, bytesHashed } = this;
				const bitsHashed = bytesHashed * 8;
				buffer.setUint8(this.bufferLength++, 128);
				if (undecoratedLength % 64 >= 56) {
					for (let i = this.bufferLength; i < 64; i++) buffer.setUint8(i, 0);
					this.hashBuffer();
					this.bufferLength = 0;
				}
				for (let i = this.bufferLength; i < 56; i++) buffer.setUint8(i, 0);
				buffer.setUint32(56, bitsHashed >>> 0, true);
				buffer.setUint32(60, Math.floor(bitsHashed / 4294967296), true);
				this.hashBuffer();
				this.finished = true;
			}
			const out = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(16));
			for (let i = 0; i < 4; i++) out.setUint32(i * 4, this.state[i], true);
			return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
		}
		hashBuffer() {
			const { buffer, state } = this;
			let a = state[0], b = state[1], c = state[2], d = state[3];
			a = ff(a, b, c, d, buffer.getUint32(0, true), 7, 3614090360);
			d = ff(d, a, b, c, buffer.getUint32(4, true), 12, 3905402710);
			c = ff(c, d, a, b, buffer.getUint32(8, true), 17, 606105819);
			b = ff(b, c, d, a, buffer.getUint32(12, true), 22, 3250441966);
			a = ff(a, b, c, d, buffer.getUint32(16, true), 7, 4118548399);
			d = ff(d, a, b, c, buffer.getUint32(20, true), 12, 1200080426);
			c = ff(c, d, a, b, buffer.getUint32(24, true), 17, 2821735955);
			b = ff(b, c, d, a, buffer.getUint32(28, true), 22, 4249261313);
			a = ff(a, b, c, d, buffer.getUint32(32, true), 7, 1770035416);
			d = ff(d, a, b, c, buffer.getUint32(36, true), 12, 2336552879);
			c = ff(c, d, a, b, buffer.getUint32(40, true), 17, 4294925233);
			b = ff(b, c, d, a, buffer.getUint32(44, true), 22, 2304563134);
			a = ff(a, b, c, d, buffer.getUint32(48, true), 7, 1804603682);
			d = ff(d, a, b, c, buffer.getUint32(52, true), 12, 4254626195);
			c = ff(c, d, a, b, buffer.getUint32(56, true), 17, 2792965006);
			b = ff(b, c, d, a, buffer.getUint32(60, true), 22, 1236535329);
			a = gg(a, b, c, d, buffer.getUint32(4, true), 5, 4129170786);
			d = gg(d, a, b, c, buffer.getUint32(24, true), 9, 3225465664);
			c = gg(c, d, a, b, buffer.getUint32(44, true), 14, 643717713);
			b = gg(b, c, d, a, buffer.getUint32(0, true), 20, 3921069994);
			a = gg(a, b, c, d, buffer.getUint32(20, true), 5, 3593408605);
			d = gg(d, a, b, c, buffer.getUint32(40, true), 9, 38016083);
			c = gg(c, d, a, b, buffer.getUint32(60, true), 14, 3634488961);
			b = gg(b, c, d, a, buffer.getUint32(16, true), 20, 3889429448);
			a = gg(a, b, c, d, buffer.getUint32(36, true), 5, 568446438);
			d = gg(d, a, b, c, buffer.getUint32(56, true), 9, 3275163606);
			c = gg(c, d, a, b, buffer.getUint32(12, true), 14, 4107603335);
			b = gg(b, c, d, a, buffer.getUint32(32, true), 20, 1163531501);
			a = gg(a, b, c, d, buffer.getUint32(52, true), 5, 2850285829);
			d = gg(d, a, b, c, buffer.getUint32(8, true), 9, 4243563512);
			c = gg(c, d, a, b, buffer.getUint32(28, true), 14, 1735328473);
			b = gg(b, c, d, a, buffer.getUint32(48, true), 20, 2368359562);
			a = hh(a, b, c, d, buffer.getUint32(20, true), 4, 4294588738);
			d = hh(d, a, b, c, buffer.getUint32(32, true), 11, 2272392833);
			c = hh(c, d, a, b, buffer.getUint32(44, true), 16, 1839030562);
			b = hh(b, c, d, a, buffer.getUint32(56, true), 23, 4259657740);
			a = hh(a, b, c, d, buffer.getUint32(4, true), 4, 2763975236);
			d = hh(d, a, b, c, buffer.getUint32(16, true), 11, 1272893353);
			c = hh(c, d, a, b, buffer.getUint32(28, true), 16, 4139469664);
			b = hh(b, c, d, a, buffer.getUint32(40, true), 23, 3200236656);
			a = hh(a, b, c, d, buffer.getUint32(52, true), 4, 681279174);
			d = hh(d, a, b, c, buffer.getUint32(0, true), 11, 3936430074);
			c = hh(c, d, a, b, buffer.getUint32(12, true), 16, 3572445317);
			b = hh(b, c, d, a, buffer.getUint32(24, true), 23, 76029189);
			a = hh(a, b, c, d, buffer.getUint32(36, true), 4, 3654602809);
			d = hh(d, a, b, c, buffer.getUint32(48, true), 11, 3873151461);
			c = hh(c, d, a, b, buffer.getUint32(60, true), 16, 530742520);
			b = hh(b, c, d, a, buffer.getUint32(8, true), 23, 3299628645);
			a = ii(a, b, c, d, buffer.getUint32(0, true), 6, 4096336452);
			d = ii(d, a, b, c, buffer.getUint32(28, true), 10, 1126891415);
			c = ii(c, d, a, b, buffer.getUint32(56, true), 15, 2878612391);
			b = ii(b, c, d, a, buffer.getUint32(20, true), 21, 4237533241);
			a = ii(a, b, c, d, buffer.getUint32(48, true), 6, 1700485571);
			d = ii(d, a, b, c, buffer.getUint32(12, true), 10, 2399980690);
			c = ii(c, d, a, b, buffer.getUint32(40, true), 15, 4293915773);
			b = ii(b, c, d, a, buffer.getUint32(4, true), 21, 2240044497);
			a = ii(a, b, c, d, buffer.getUint32(32, true), 6, 1873313359);
			d = ii(d, a, b, c, buffer.getUint32(60, true), 10, 4264355552);
			c = ii(c, d, a, b, buffer.getUint32(24, true), 15, 2734768916);
			b = ii(b, c, d, a, buffer.getUint32(52, true), 21, 1309151649);
			a = ii(a, b, c, d, buffer.getUint32(16, true), 6, 4149444226);
			d = ii(d, a, b, c, buffer.getUint32(44, true), 10, 3174756917);
			c = ii(c, d, a, b, buffer.getUint32(8, true), 15, 718787259);
			b = ii(b, c, d, a, buffer.getUint32(36, true), 21, 3951481745);
			state[0] = a + state[0] & 4294967295;
			state[1] = b + state[1] & 4294967295;
			state[2] = c + state[2] & 4294967295;
			state[3] = d + state[3] & 4294967295;
		}
		reset() {
			this.state = Uint32Array.from(INIT);
			this.buffer = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(64));
			this.bufferLength = 0;
			this.bytesHashed = 0;
			this.finished = false;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/checksum/index.js
var checksum_exports = /* @__PURE__ */ __exportAll({
	Md5: () => Md5,
	blobHasher: () => blobHasher,
	blobReader: () => blobReader,
	fileStreamHasher: () => fileStreamHasher,
	readableStreamHasher: () => readableStreamHasher
});
var init_checksum = __esmMin((() => {
	init_blobHasher();
	init_fileStreamHasher();
	init_readableStreamHasher();
	init_md5();
	init_chunked_blob_reader();
}));
//#endregion
//#region node_modules/@aws-sdk/client-s3/dist-cjs/runtimeConfig.shared.js
var require_runtimeConfig_shared = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getRuntimeConfig = void 0;
	const httpAuthSchemes_1 = (init_httpAuthSchemes(), __toCommonJS(httpAuthSchemes_exports));
	const middleware_sdk_s3_1 = require_dist_cjs$6();
	const signature_v4_multi_region_1 = require_dist_cjs$10();
	const client_1 = (init_client$1(), __toCommonJS(client_exports$1));
	const protocols_1 = (init_protocols(), __toCommonJS(protocols_exports));
	const serde_1 = (init_serde(), __toCommonJS(serde_exports));
	const httpAuthSchemeProvider_1 = require_httpAuthSchemeProvider();
	const endpointResolver_1 = require_endpointResolver();
	const schemas_0_1 = require_schemas_0();
	const getRuntimeConfig = (config) => {
		return {
			apiVersion: "2006-03-01",
			base64Decoder: config?.base64Decoder ?? serde_1.fromBase64,
			base64Encoder: config?.base64Encoder ?? serde_1.toBase64,
			disableHostPrefix: config?.disableHostPrefix ?? false,
			endpointProvider: config?.endpointProvider ?? endpointResolver_1.defaultEndpointResolver,
			extensions: config?.extensions ?? [],
			getAwsChunkedEncodingStream: config?.getAwsChunkedEncodingStream ?? serde_1.getAwsChunkedEncodingStream,
			httpAuthSchemeProvider: config?.httpAuthSchemeProvider ?? httpAuthSchemeProvider_1.defaultS3HttpAuthSchemeProvider,
			httpAuthSchemes: config?.httpAuthSchemes ?? [{
				schemeId: "aws.auth#sigv4",
				identityProvider: (ipc) => ipc.getIdentityProvider("aws.auth#sigv4"),
				signer: new httpAuthSchemes_1.AwsSdkSigV4Signer()
			}, {
				schemeId: "aws.auth#sigv4a",
				identityProvider: (ipc) => ipc.getIdentityProvider("aws.auth#sigv4a"),
				signer: new httpAuthSchemes_1.AwsSdkSigV4ASigner()
			}],
			logger: config?.logger ?? new client_1.NoOpLogger(),
			protocol: config?.protocol ?? middleware_sdk_s3_1.S3RestXmlProtocol,
			protocolSettings: config?.protocolSettings ?? {
				defaultNamespace: "com.amazonaws.s3",
				errorTypeRegistries: schemas_0_1.errorTypeRegistries,
				xmlNamespace: "http://s3.amazonaws.com/doc/2006-03-01/",
				version: "2006-03-01",
				serviceTarget: "AmazonS3"
			},
			sdkStreamMixin: config?.sdkStreamMixin ?? serde_1.sdkStreamMixin,
			serviceId: config?.serviceId ?? "S3",
			signerConstructor: config?.signerConstructor ?? signature_v4_multi_region_1.SignatureV4MultiRegion,
			signingEscapePath: config?.signingEscapePath ?? false,
			urlParser: config?.urlParser ?? protocols_1.parseUrl,
			useArnRegion: config?.useArnRegion ?? void 0,
			utf8Decoder: config?.utf8Decoder ?? serde_1.fromUtf8,
			utf8Encoder: config?.utf8Encoder ?? serde_1.toUtf8
		};
	};
	exports.getRuntimeConfig = getRuntimeConfig;
}));
//#endregion
//#region node_modules/@aws-sdk/client-s3/dist-cjs/runtimeConfig.js
var require_runtimeConfig = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getRuntimeConfig = void 0;
	const package_json_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports)).__importDefault(require_package());
	const client_1 = (init_client(), __toCommonJS(client_exports));
	const httpAuthSchemes_1 = (init_httpAuthSchemes(), __toCommonJS(httpAuthSchemes_exports));
	const credential_provider_node_1 = require_dist_cjs$5();
	const middleware_bucket_endpoint_1 = require_dist_cjs$4();
	const middleware_flexible_checksums_1 = require_dist_cjs$7();
	const middleware_sdk_s3_1 = require_dist_cjs$6();
	const checksum_1 = (init_checksum(), __toCommonJS(checksum_exports));
	const client_2 = (init_client$1(), __toCommonJS(client_exports$1));
	const config_1 = (init_config(), __toCommonJS(config_exports));
	const event_streams_1 = (init_event_streams(), __toCommonJS(event_streams_exports));
	const retry_1 = (init_retry(), __toCommonJS(retry_exports));
	const serde_1 = (init_serde(), __toCommonJS(serde_exports));
	const node_http_handler_1 = require_dist_cjs$12();
	const runtimeConfig_shared_1 = require_runtimeConfig_shared();
	const getRuntimeConfig = (config) => {
		(0, client_2.emitWarningIfUnsupportedVersion)(process.version);
		const defaultsMode = (0, config_1.resolveDefaultsModeConfig)(config);
		const defaultConfigProvider = () => defaultsMode().then(client_2.loadConfigsForDefaultMode);
		const clientSharedValues = (0, runtimeConfig_shared_1.getRuntimeConfig)(config);
		(0, client_1.emitWarningIfUnsupportedVersion)(process.version);
		const loaderConfig = {
			profile: config?.profile,
			logger: clientSharedValues.logger
		};
		return {
			...clientSharedValues,
			...config,
			runtime: "node",
			defaultsMode,
			authSchemePreference: config?.authSchemePreference ?? (0, config_1.loadConfig)(httpAuthSchemes_1.NODE_AUTH_SCHEME_PREFERENCE_OPTIONS, loaderConfig),
			bodyLengthChecker: config?.bodyLengthChecker ?? serde_1.calculateBodyLength,
			credentialDefaultProvider: config?.credentialDefaultProvider ?? credential_provider_node_1.defaultProvider,
			defaultUserAgentProvider: config?.defaultUserAgentProvider ?? (0, client_1.createDefaultUserAgentProvider)({
				serviceId: clientSharedValues.serviceId,
				clientVersion: package_json_1.default.version
			}),
			disableS3ExpressSessionAuth: config?.disableS3ExpressSessionAuth ?? (0, config_1.loadConfig)(middleware_sdk_s3_1.NODE_DISABLE_S3_EXPRESS_SESSION_AUTH_OPTIONS, loaderConfig),
			eventStreamSerdeProvider: config?.eventStreamSerdeProvider ?? event_streams_1.eventStreamSerdeProvider,
			maxAttempts: config?.maxAttempts ?? (0, config_1.loadConfig)(retry_1.NODE_MAX_ATTEMPT_CONFIG_OPTIONS, config),
			md5: config?.md5 ?? serde_1.Hash.bind(null, "md5"),
			region: config?.region ?? (0, config_1.loadConfig)(config_1.NODE_REGION_CONFIG_OPTIONS, {
				...config_1.NODE_REGION_CONFIG_FILE_OPTIONS,
				...loaderConfig
			}),
			requestChecksumCalculation: config?.requestChecksumCalculation ?? (0, config_1.loadConfig)(middleware_flexible_checksums_1.NODE_REQUEST_CHECKSUM_CALCULATION_CONFIG_OPTIONS, loaderConfig),
			requestHandler: node_http_handler_1.NodeHttpHandler.create(config?.requestHandler ?? defaultConfigProvider),
			responseChecksumValidation: config?.responseChecksumValidation ?? (0, config_1.loadConfig)(middleware_flexible_checksums_1.NODE_RESPONSE_CHECKSUM_VALIDATION_CONFIG_OPTIONS, loaderConfig),
			retryMode: config?.retryMode ?? (0, config_1.loadConfig)({
				...retry_1.NODE_RETRY_MODE_CONFIG_OPTIONS,
				default: async () => (await defaultConfigProvider()).retryMode || retry_1.DEFAULT_RETRY_MODE
			}, config),
			sha1: config?.sha1 ?? serde_1.Hash.bind(null, "sha1"),
			sha256: config?.sha256 ?? serde_1.Hash.bind(null, "sha256"),
			sigv4aSigningRegionSet: config?.sigv4aSigningRegionSet ?? (0, config_1.loadConfig)(httpAuthSchemes_1.NODE_SIGV4A_CONFIG_OPTIONS, loaderConfig),
			streamCollector: config?.streamCollector ?? node_http_handler_1.streamCollector,
			streamHasher: config?.streamHasher ?? checksum_1.readableStreamHasher,
			useArnRegion: config?.useArnRegion ?? (0, config_1.loadConfig)(middleware_bucket_endpoint_1.NODE_USE_ARN_REGION_CONFIG_OPTIONS, loaderConfig),
			useDualstackEndpoint: config?.useDualstackEndpoint ?? (0, config_1.loadConfig)(config_1.NODE_USE_DUALSTACK_ENDPOINT_CONFIG_OPTIONS, loaderConfig),
			useFipsEndpoint: config?.useFipsEndpoint ?? (0, config_1.loadConfig)(config_1.NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS, loaderConfig),
			userAgentAppId: config?.userAgentAppId ?? (0, config_1.loadConfig)(client_1.NODE_APP_ID_CONFIG_OPTIONS, loaderConfig)
		};
	};
	exports.getRuntimeConfig = getRuntimeConfig;
}));
//#endregion
//#region node_modules/@aws-sdk/middleware-ssec/dist-cjs/index.js
var require_dist_cjs$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	function ssecMiddleware(options) {
		return (next) => async (args) => {
			const input = { ...args.input };
			for (const prop of [{
				target: "SSECustomerKey",
				hash: "SSECustomerKeyMD5"
			}, {
				target: "CopySourceSSECustomerKey",
				hash: "CopySourceSSECustomerKeyMD5"
			}]) {
				const value = input[prop.target];
				if (value) {
					let valueForHash;
					if (typeof value === "string") if (isValidBase64EncodedSSECustomerKey(value, options)) valueForHash = options.base64Decoder(value);
					else {
						valueForHash = options.utf8Decoder(value);
						input[prop.target] = options.base64Encoder(valueForHash);
					}
					else {
						valueForHash = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
						input[prop.target] = options.base64Encoder(valueForHash);
					}
					const hash = new options.md5();
					hash.update(valueForHash);
					input[prop.hash] = options.base64Encoder(await hash.digest());
				}
			}
			return next({
				...args,
				input
			});
		};
	}
	const ssecMiddlewareOptions = {
		name: "ssecMiddleware",
		step: "initialize",
		tags: ["SSE"],
		override: true
	};
	const getSsecPlugin = (config) => ({ applyToStack: (clientStack) => {
		clientStack.add(ssecMiddleware(config), ssecMiddlewareOptions);
	} });
	function isValidBase64EncodedSSECustomerKey(str, options) {
		if (!/^(?:[A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(str)) return false;
		try {
			return options.base64Decoder(str).length === 32;
		} catch {
			return false;
		}
	}
	exports.getSsecPlugin = getSsecPlugin;
	exports.isValidBase64EncodedSSECustomerKey = isValidBase64EncodedSSECustomerKey;
	exports.ssecMiddleware = ssecMiddleware;
	exports.ssecMiddlewareOptions = ssecMiddlewareOptions;
}));
//#endregion
//#region node_modules/@aws-sdk/middleware-location-constraint/dist-cjs/index.js
var require_dist_cjs$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	function locationConstraintMiddleware(options) {
		return (next) => async (args) => {
			const { CreateBucketConfiguration } = args.input;
			const region = await options.region();
			if (!CreateBucketConfiguration?.LocationConstraint && !CreateBucketConfiguration?.Location) {
				if (region !== "us-east-1") {
					args.input.CreateBucketConfiguration = args.input.CreateBucketConfiguration ?? {};
					args.input.CreateBucketConfiguration.LocationConstraint = region;
				}
			}
			return next(args);
		};
	}
	const locationConstraintMiddlewareOptions = {
		step: "initialize",
		tags: ["LOCATION_CONSTRAINT", "CREATE_BUCKET_CONFIGURATION"],
		name: "locationConstraintMiddleware",
		override: true
	};
	const getLocationConstraintPlugin = (config) => ({ applyToStack: (clientStack) => {
		clientStack.add(locationConstraintMiddleware(config), locationConstraintMiddlewareOptions);
	} });
	exports.getLocationConstraintPlugin = getLocationConstraintPlugin;
	exports.locationConstraintMiddleware = locationConstraintMiddleware;
	exports.locationConstraintMiddlewareOptions = locationConstraintMiddlewareOptions;
}));
//#endregion
//#region node_modules/@aws-sdk/client-s3/dist-cjs/index.js
var require_dist_cjs$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var client$1 = (init_client(), __toCommonJS(client_exports));
	var middlewareExpectContinue = require_dist_cjs$9();
	var middlewareFlexibleChecksums = require_dist_cjs$7();
	var middlewareSdkS3 = require_dist_cjs$6();
	var core = (init_dist_es(), __toCommonJS(dist_es_exports));
	var client = (init_client$1(), __toCommonJS(client_exports$1));
	var config = (init_config(), __toCommonJS(config_exports));
	var endpoints = (init_endpoints(), __toCommonJS(endpoints_exports));
	var eventStreams = (init_event_streams(), __toCommonJS(event_streams_exports));
	var protocols = (init_protocols(), __toCommonJS(protocols_exports));
	var retry = (init_retry(), __toCommonJS(retry_exports));
	var schema = (init_schema(), __toCommonJS(schema_exports));
	var httpAuthSchemeProvider = require_httpAuthSchemeProvider();
	var schemas_0 = require_schemas_0();
	var runtimeConfig = require_runtimeConfig();
	var middlewareSsec = require_dist_cjs$3();
	var middlewareLocationConstraint = require_dist_cjs$2();
	var errors = require_errors();
	var S3ServiceException = require_S3ServiceException();
	const resolveClientEndpointParameters = (options) => {
		return Object.assign(options, {
			useFipsEndpoint: options.useFipsEndpoint ?? false,
			useDualstackEndpoint: options.useDualstackEndpoint ?? false,
			forcePathStyle: options.forcePathStyle ?? false,
			useAccelerateEndpoint: options.useAccelerateEndpoint ?? false,
			useGlobalEndpoint: options.useGlobalEndpoint ?? false,
			disableMultiregionAccessPoints: options.disableMultiregionAccessPoints ?? false,
			defaultSigningName: "s3",
			clientContextParams: options.clientContextParams ?? {}
		});
	};
	const commonParams = {
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
	var CreateSessionCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		DisableS3ExpressSessionAuth: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "CreateSession", {}).n("S3Client", "CreateSessionCommand").sc(schemas_0.CreateSession$).build() {};
	const getHttpAuthExtensionConfiguration = (runtimeConfig) => {
		const _httpAuthSchemes = runtimeConfig.httpAuthSchemes;
		let _httpAuthSchemeProvider = runtimeConfig.httpAuthSchemeProvider;
		let _credentials = runtimeConfig.credentials;
		return {
			setHttpAuthScheme(httpAuthScheme) {
				const index = _httpAuthSchemes.findIndex((scheme) => scheme.schemeId === httpAuthScheme.schemeId);
				if (index === -1) _httpAuthSchemes.push(httpAuthScheme);
				else _httpAuthSchemes.splice(index, 1, httpAuthScheme);
			},
			httpAuthSchemes() {
				return _httpAuthSchemes;
			},
			setHttpAuthSchemeProvider(httpAuthSchemeProvider) {
				_httpAuthSchemeProvider = httpAuthSchemeProvider;
			},
			httpAuthSchemeProvider() {
				return _httpAuthSchemeProvider;
			},
			setCredentials(credentials) {
				_credentials = credentials;
			},
			credentials() {
				return _credentials;
			}
		};
	};
	const resolveHttpAuthRuntimeConfig = (config) => {
		return {
			httpAuthSchemes: config.httpAuthSchemes(),
			httpAuthSchemeProvider: config.httpAuthSchemeProvider(),
			credentials: config.credentials()
		};
	};
	const resolveRuntimeExtensions = (runtimeConfig, extensions) => {
		const extensionConfiguration = Object.assign(client$1.getAwsRegionExtensionConfiguration(runtimeConfig), client.getDefaultExtensionConfiguration(runtimeConfig), protocols.getHttpHandlerExtensionConfiguration(runtimeConfig), getHttpAuthExtensionConfiguration(runtimeConfig));
		extensions.forEach((extension) => extension.configure(extensionConfiguration));
		return Object.assign(runtimeConfig, client$1.resolveAwsRegionExtensionConfiguration(extensionConfiguration), client.resolveDefaultRuntimeConfig(extensionConfiguration), protocols.resolveHttpHandlerRuntimeConfig(extensionConfiguration), resolveHttpAuthRuntimeConfig(extensionConfiguration));
	};
	var S3Client = class extends client.Client {
		config;
		constructor(...[configuration]) {
			const _config_0 = runtimeConfig.getRuntimeConfig(configuration || {});
			super(_config_0);
			this.initConfig = _config_0;
			const _config_1 = resolveClientEndpointParameters(_config_0);
			const _config_2 = client$1.resolveUserAgentConfig(_config_1);
			const _config_3 = middlewareFlexibleChecksums.resolveFlexibleChecksumsConfig(_config_2);
			const _config_4 = retry.resolveRetryConfig(_config_3);
			const _config_5 = config.resolveRegionConfig(_config_4);
			const _config_6 = client$1.resolveHostHeaderConfig(_config_5);
			const _config_7 = endpoints.resolveEndpointConfig(_config_6);
			const _config_8 = eventStreams.resolveEventStreamSerdeConfig(_config_7);
			const _config_9 = httpAuthSchemeProvider.resolveHttpAuthSchemeConfig(_config_8);
			const _config_11 = resolveRuntimeExtensions(middlewareSdkS3.resolveS3Config(_config_9, { session: [() => this, CreateSessionCommand] }), configuration?.extensions || []);
			this.config = _config_11;
			this.middlewareStack.use(schema.getSchemaSerdePlugin(this.config));
			this.middlewareStack.use(client$1.getUserAgentPlugin(this.config));
			this.middlewareStack.use(retry.getRetryPlugin(this.config));
			this.middlewareStack.use(protocols.getContentLengthPlugin(this.config));
			this.middlewareStack.use(client$1.getHostHeaderPlugin(this.config));
			this.middlewareStack.use(client$1.getLoggerPlugin(this.config));
			this.middlewareStack.use(client$1.getRecursionDetectionPlugin(this.config));
			this.middlewareStack.use(core.getHttpAuthSchemeEndpointRuleSetPlugin(this.config, {
				httpAuthSchemeParametersProvider: httpAuthSchemeProvider.defaultS3HttpAuthSchemeParametersProvider,
				identityProviderConfigProvider: async (config) => new core.DefaultIdentityProviderConfig({
					"aws.auth#sigv4": config.credentials,
					"aws.auth#sigv4a": config.credentials
				})
			}));
			this.middlewareStack.use(core.getHttpSigningPlugin(this.config));
			this.middlewareStack.use(middlewareSdkS3.getValidateBucketNamePlugin(this.config));
			this.middlewareStack.use(middlewareExpectContinue.getAddExpectContinuePlugin(this.config));
			this.middlewareStack.use(middlewareSdkS3.getRegionRedirectMiddlewarePlugin(this.config));
			this.middlewareStack.use(middlewareSdkS3.getS3ExpressPlugin(this.config));
			this.middlewareStack.use(middlewareSdkS3.getS3ExpressHttpSigningPlugin(this.config));
		}
		destroy() {
			super.destroy();
		}
	};
	var AbortMultipartUploadCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "AbortMultipartUpload", {}).n("S3Client", "AbortMultipartUploadCommand").sc(schemas_0.AbortMultipartUpload$).build() {};
	var CompleteMultipartUploadCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config),
			middlewareSsec.getSsecPlugin(config)
		];
	}).s("AmazonS3", "CompleteMultipartUpload", {}).n("S3Client", "CompleteMultipartUploadCommand").sc(schemas_0.CompleteMultipartUpload$).build() {};
	var CopyObjectCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		DisableS3ExpressSessionAuth: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		},
		CopySource: {
			type: "contextParams",
			name: "CopySource"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config),
			middlewareSsec.getSsecPlugin(config)
		];
	}).s("AmazonS3", "CopyObject", {}).n("S3Client", "CopyObjectCommand").sc(schemas_0.CopyObject$).build() {};
	var CreateBucketCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		DisableAccessPoints: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config),
			middlewareLocationConstraint.getLocationConstraintPlugin(config)
		];
	}).s("AmazonS3", "CreateBucket", {}).n("S3Client", "CreateBucketCommand").sc(schemas_0.CreateBucket$).build() {};
	var CreateBucketMetadataConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "CreateBucketMetadataConfiguration", {}).n("S3Client", "CreateBucketMetadataConfigurationCommand").sc(schemas_0.CreateBucketMetadataConfiguration$).build() {};
	var CreateBucketMetadataTableConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "CreateBucketMetadataTableConfiguration", {}).n("S3Client", "CreateBucketMetadataTableConfigurationCommand").sc(schemas_0.CreateBucketMetadataTableConfiguration$).build() {};
	var CreateMultipartUploadCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config),
			middlewareSsec.getSsecPlugin(config)
		];
	}).s("AmazonS3", "CreateMultipartUpload", {}).n("S3Client", "CreateMultipartUploadCommand").sc(schemas_0.CreateMultipartUpload$).build() {};
	var DeleteBucketAnalyticsConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketAnalyticsConfiguration", {}).n("S3Client", "DeleteBucketAnalyticsConfigurationCommand").sc(schemas_0.DeleteBucketAnalyticsConfiguration$).build() {};
	var DeleteBucketCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucket", {}).n("S3Client", "DeleteBucketCommand").sc(schemas_0.DeleteBucket$).build() {};
	var DeleteBucketCorsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketCors", {}).n("S3Client", "DeleteBucketCorsCommand").sc(schemas_0.DeleteBucketCors$).build() {};
	var DeleteBucketEncryptionCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketEncryption", {}).n("S3Client", "DeleteBucketEncryptionCommand").sc(schemas_0.DeleteBucketEncryption$).build() {};
	var DeleteBucketIntelligentTieringConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketIntelligentTieringConfiguration", {}).n("S3Client", "DeleteBucketIntelligentTieringConfigurationCommand").sc(schemas_0.DeleteBucketIntelligentTieringConfiguration$).build() {};
	var DeleteBucketInventoryConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketInventoryConfiguration", {}).n("S3Client", "DeleteBucketInventoryConfigurationCommand").sc(schemas_0.DeleteBucketInventoryConfiguration$).build() {};
	var DeleteBucketLifecycleCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketLifecycle", {}).n("S3Client", "DeleteBucketLifecycleCommand").sc(schemas_0.DeleteBucketLifecycle$).build() {};
	var DeleteBucketMetadataConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketMetadataConfiguration", {}).n("S3Client", "DeleteBucketMetadataConfigurationCommand").sc(schemas_0.DeleteBucketMetadataConfiguration$).build() {};
	var DeleteBucketMetadataTableConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketMetadataTableConfiguration", {}).n("S3Client", "DeleteBucketMetadataTableConfigurationCommand").sc(schemas_0.DeleteBucketMetadataTableConfiguration$).build() {};
	var DeleteBucketMetricsConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketMetricsConfiguration", {}).n("S3Client", "DeleteBucketMetricsConfigurationCommand").sc(schemas_0.DeleteBucketMetricsConfiguration$).build() {};
	var DeleteBucketOwnershipControlsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketOwnershipControls", {}).n("S3Client", "DeleteBucketOwnershipControlsCommand").sc(schemas_0.DeleteBucketOwnershipControls$).build() {};
	var DeleteBucketPolicyCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketPolicy", {}).n("S3Client", "DeleteBucketPolicyCommand").sc(schemas_0.DeleteBucketPolicy$).build() {};
	var DeleteBucketReplicationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketReplication", {}).n("S3Client", "DeleteBucketReplicationCommand").sc(schemas_0.DeleteBucketReplication$).build() {};
	var DeleteBucketTaggingCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketTagging", {}).n("S3Client", "DeleteBucketTaggingCommand").sc(schemas_0.DeleteBucketTagging$).build() {};
	var DeleteBucketWebsiteCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeleteBucketWebsite", {}).n("S3Client", "DeleteBucketWebsiteCommand").sc(schemas_0.DeleteBucketWebsite$).build() {};
	var DeleteObjectCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "DeleteObject", {}).n("S3Client", "DeleteObjectCommand").sc(schemas_0.DeleteObject$).build() {};
	var DeleteObjectsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestAlgorithmMember: {
					"httpHeader": "x-amz-sdk-checksum-algorithm",
					"name": "ChecksumAlgorithm"
				},
				requestChecksumRequired: true
			}),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config)
		];
	}).s("AmazonS3", "DeleteObjects", {}).n("S3Client", "DeleteObjectsCommand").sc(schemas_0.DeleteObjects$).build() {};
	var DeleteObjectTaggingCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "DeleteObjectTagging", {}).n("S3Client", "DeleteObjectTaggingCommand").sc(schemas_0.DeleteObjectTagging$).build() {};
	var DeletePublicAccessBlockCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "DeletePublicAccessBlock", {}).n("S3Client", "DeletePublicAccessBlockCommand").sc(schemas_0.DeletePublicAccessBlock$).build() {};
	var GetBucketAbacCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketAbac", {}).n("S3Client", "GetBucketAbacCommand").sc(schemas_0.GetBucketAbac$).build() {};
	var GetBucketAccelerateConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketAccelerateConfiguration", {}).n("S3Client", "GetBucketAccelerateConfigurationCommand").sc(schemas_0.GetBucketAccelerateConfiguration$).build() {};
	var GetBucketAclCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketAcl", {}).n("S3Client", "GetBucketAclCommand").sc(schemas_0.GetBucketAcl$).build() {};
	var GetBucketAnalyticsConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketAnalyticsConfiguration", {}).n("S3Client", "GetBucketAnalyticsConfigurationCommand").sc(schemas_0.GetBucketAnalyticsConfiguration$).build() {};
	var GetBucketCorsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketCors", {}).n("S3Client", "GetBucketCorsCommand").sc(schemas_0.GetBucketCors$).build() {};
	var GetBucketEncryptionCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketEncryption", {}).n("S3Client", "GetBucketEncryptionCommand").sc(schemas_0.GetBucketEncryption$).build() {};
	var GetBucketIntelligentTieringConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketIntelligentTieringConfiguration", {}).n("S3Client", "GetBucketIntelligentTieringConfigurationCommand").sc(schemas_0.GetBucketIntelligentTieringConfiguration$).build() {};
	var GetBucketInventoryConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketInventoryConfiguration", {}).n("S3Client", "GetBucketInventoryConfigurationCommand").sc(schemas_0.GetBucketInventoryConfiguration$).build() {};
	var GetBucketLifecycleConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketLifecycleConfiguration", {}).n("S3Client", "GetBucketLifecycleConfigurationCommand").sc(schemas_0.GetBucketLifecycleConfiguration$).build() {};
	var GetBucketLocationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketLocation", {}).n("S3Client", "GetBucketLocationCommand").sc(schemas_0.GetBucketLocation$).build() {};
	var GetBucketLoggingCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketLogging", {}).n("S3Client", "GetBucketLoggingCommand").sc(schemas_0.GetBucketLogging$).build() {};
	var GetBucketMetadataConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketMetadataConfiguration", {}).n("S3Client", "GetBucketMetadataConfigurationCommand").sc(schemas_0.GetBucketMetadataConfiguration$).build() {};
	var GetBucketMetadataTableConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketMetadataTableConfiguration", {}).n("S3Client", "GetBucketMetadataTableConfigurationCommand").sc(schemas_0.GetBucketMetadataTableConfiguration$).build() {};
	var GetBucketMetricsConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketMetricsConfiguration", {}).n("S3Client", "GetBucketMetricsConfigurationCommand").sc(schemas_0.GetBucketMetricsConfiguration$).build() {};
	var GetBucketNotificationConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketNotificationConfiguration", {}).n("S3Client", "GetBucketNotificationConfigurationCommand").sc(schemas_0.GetBucketNotificationConfiguration$).build() {};
	var GetBucketOwnershipControlsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketOwnershipControls", {}).n("S3Client", "GetBucketOwnershipControlsCommand").sc(schemas_0.GetBucketOwnershipControls$).build() {};
	var GetBucketPolicyCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "GetBucketPolicy", {}).n("S3Client", "GetBucketPolicyCommand").sc(schemas_0.GetBucketPolicy$).build() {};
	var GetBucketPolicyStatusCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketPolicyStatus", {}).n("S3Client", "GetBucketPolicyStatusCommand").sc(schemas_0.GetBucketPolicyStatus$).build() {};
	var GetBucketReplicationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketReplication", {}).n("S3Client", "GetBucketReplicationCommand").sc(schemas_0.GetBucketReplication$).build() {};
	var GetBucketRequestPaymentCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketRequestPayment", {}).n("S3Client", "GetBucketRequestPaymentCommand").sc(schemas_0.GetBucketRequestPayment$).build() {};
	var GetBucketTaggingCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketTagging", {}).n("S3Client", "GetBucketTaggingCommand").sc(schemas_0.GetBucketTagging$).build() {};
	var GetBucketVersioningCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketVersioning", {}).n("S3Client", "GetBucketVersioningCommand").sc(schemas_0.GetBucketVersioning$).build() {};
	var GetBucketWebsiteCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetBucketWebsite", {}).n("S3Client", "GetBucketWebsiteCommand").sc(schemas_0.GetBucketWebsite$).build() {};
	var GetObjectAclCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetObjectAcl", {}).n("S3Client", "GetObjectAclCommand").sc(schemas_0.GetObjectAcl$).build() {};
	var GetObjectAttributesCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config),
			middlewareSsec.getSsecPlugin(config)
		];
	}).s("AmazonS3", "GetObjectAttributes", {}).n("S3Client", "GetObjectAttributesCommand").sc(schemas_0.GetObjectAttributes$).build() {};
	var GetObjectCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestChecksumRequired: false,
				requestValidationModeMember: "ChecksumMode",
				"responseAlgorithms": [
					"CRC64NVME",
					"CRC32",
					"CRC32C",
					"SHA256",
					"SHA1",
					"SHA512",
					"MD5",
					"XXHASH64",
					"XXHASH3",
					"XXHASH128"
				]
			}),
			middlewareSsec.getSsecPlugin(config),
			middlewareSdkS3.getS3ExpiresMiddlewarePlugin(config)
		];
	}).s("AmazonS3", "GetObject", {}).n("S3Client", "GetObjectCommand").sc(schemas_0.GetObject$).build() {};
	var GetObjectLegalHoldCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetObjectLegalHold", {}).n("S3Client", "GetObjectLegalHoldCommand").sc(schemas_0.GetObjectLegalHold$).build() {};
	var GetObjectLockConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetObjectLockConfiguration", {}).n("S3Client", "GetObjectLockConfigurationCommand").sc(schemas_0.GetObjectLockConfiguration$).build() {};
	var GetObjectRetentionCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetObjectRetention", {}).n("S3Client", "GetObjectRetentionCommand").sc(schemas_0.GetObjectRetention$).build() {};
	var GetObjectTaggingCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetObjectTagging", {}).n("S3Client", "GetObjectTaggingCommand").sc(schemas_0.GetObjectTagging$).build() {};
	var GetObjectTorrentCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "GetObjectTorrent", {}).n("S3Client", "GetObjectTorrentCommand").sc(schemas_0.GetObjectTorrent$).build() {};
	var GetPublicAccessBlockCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "GetPublicAccessBlock", {}).n("S3Client", "GetPublicAccessBlockCommand").sc(schemas_0.GetPublicAccessBlock$).build() {};
	var HeadBucketCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "HeadBucket", {}).n("S3Client", "HeadBucketCommand").sc(schemas_0.HeadBucket$).build() {};
	var HeadObjectCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config),
			middlewareSsec.getSsecPlugin(config),
			middlewareSdkS3.getS3ExpiresMiddlewarePlugin(config)
		];
	}).s("AmazonS3", "HeadObject", {}).n("S3Client", "HeadObjectCommand").sc(schemas_0.HeadObject$).build() {};
	var ListBucketAnalyticsConfigurationsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "ListBucketAnalyticsConfigurations", {}).n("S3Client", "ListBucketAnalyticsConfigurationsCommand").sc(schemas_0.ListBucketAnalyticsConfigurations$).build() {};
	var ListBucketIntelligentTieringConfigurationsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "ListBucketIntelligentTieringConfigurations", {}).n("S3Client", "ListBucketIntelligentTieringConfigurationsCommand").sc(schemas_0.ListBucketIntelligentTieringConfigurations$).build() {};
	var ListBucketInventoryConfigurationsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "ListBucketInventoryConfigurations", {}).n("S3Client", "ListBucketInventoryConfigurationsCommand").sc(schemas_0.ListBucketInventoryConfigurations$).build() {};
	var ListBucketMetricsConfigurationsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "ListBucketMetricsConfigurations", {}).n("S3Client", "ListBucketMetricsConfigurationsCommand").sc(schemas_0.ListBucketMetricsConfigurations$).build() {};
	var ListBucketsCommand = class extends client.Command.classBuilder().ep(commonParams).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "ListBuckets", {}).n("S3Client", "ListBucketsCommand").sc(schemas_0.ListBuckets$).build() {};
	var ListDirectoryBucketsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "ListDirectoryBuckets", {}).n("S3Client", "ListDirectoryBucketsCommand").sc(schemas_0.ListDirectoryBuckets$).build() {};
	var ListMultipartUploadsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Prefix: {
			type: "contextParams",
			name: "Prefix"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "ListMultipartUploads", {}).n("S3Client", "ListMultipartUploadsCommand").sc(schemas_0.ListMultipartUploads$).build() {};
	var ListObjectsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Prefix: {
			type: "contextParams",
			name: "Prefix"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "ListObjects", {}).n("S3Client", "ListObjectsCommand").sc(schemas_0.ListObjects$).build() {};
	var ListObjectsV2Command = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Prefix: {
			type: "contextParams",
			name: "Prefix"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "ListObjectsV2", {}).n("S3Client", "ListObjectsV2Command").sc(schemas_0.ListObjectsV2$).build() {};
	var ListObjectVersionsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Prefix: {
			type: "contextParams",
			name: "Prefix"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "ListObjectVersions", {}).n("S3Client", "ListObjectVersionsCommand").sc(schemas_0.ListObjectVersions$).build() {};
	var ListPartsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config),
			middlewareSsec.getSsecPlugin(config)
		];
	}).s("AmazonS3", "ListParts", {}).n("S3Client", "ListPartsCommand").sc(schemas_0.ListParts$).build() {};
	var PutBucketAbacCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: false
		})];
	}).s("AmazonS3", "PutBucketAbac", {}).n("S3Client", "PutBucketAbacCommand").sc(schemas_0.PutBucketAbac$).build() {};
	var PutBucketAccelerateConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: false
		})];
	}).s("AmazonS3", "PutBucketAccelerateConfiguration", {}).n("S3Client", "PutBucketAccelerateConfigurationCommand").sc(schemas_0.PutBucketAccelerateConfiguration$).build() {};
	var PutBucketAclCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutBucketAcl", {}).n("S3Client", "PutBucketAclCommand").sc(schemas_0.PutBucketAcl$).build() {};
	var PutBucketAnalyticsConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "PutBucketAnalyticsConfiguration", {}).n("S3Client", "PutBucketAnalyticsConfigurationCommand").sc(schemas_0.PutBucketAnalyticsConfiguration$).build() {};
	var PutBucketCorsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutBucketCors", {}).n("S3Client", "PutBucketCorsCommand").sc(schemas_0.PutBucketCors$).build() {};
	var PutBucketEncryptionCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutBucketEncryption", {}).n("S3Client", "PutBucketEncryptionCommand").sc(schemas_0.PutBucketEncryption$).build() {};
	var PutBucketIntelligentTieringConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "PutBucketIntelligentTieringConfiguration", {}).n("S3Client", "PutBucketIntelligentTieringConfigurationCommand").sc(schemas_0.PutBucketIntelligentTieringConfiguration$).build() {};
	var PutBucketInventoryConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "PutBucketInventoryConfiguration", {}).n("S3Client", "PutBucketInventoryConfigurationCommand").sc(schemas_0.PutBucketInventoryConfiguration$).build() {};
	var PutBucketLifecycleConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestAlgorithmMember: {
					"httpHeader": "x-amz-sdk-checksum-algorithm",
					"name": "ChecksumAlgorithm"
				},
				requestChecksumRequired: true
			}),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config)
		];
	}).s("AmazonS3", "PutBucketLifecycleConfiguration", {}).n("S3Client", "PutBucketLifecycleConfigurationCommand").sc(schemas_0.PutBucketLifecycleConfiguration$).build() {};
	var PutBucketLoggingCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutBucketLogging", {}).n("S3Client", "PutBucketLoggingCommand").sc(schemas_0.PutBucketLogging$).build() {};
	var PutBucketMetricsConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "PutBucketMetricsConfiguration", {}).n("S3Client", "PutBucketMetricsConfigurationCommand").sc(schemas_0.PutBucketMetricsConfiguration$).build() {};
	var PutBucketNotificationConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "PutBucketNotificationConfiguration", {}).n("S3Client", "PutBucketNotificationConfigurationCommand").sc(schemas_0.PutBucketNotificationConfiguration$).build() {};
	var PutBucketOwnershipControlsCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutBucketOwnershipControls", {}).n("S3Client", "PutBucketOwnershipControlsCommand").sc(schemas_0.PutBucketOwnershipControls$).build() {};
	var PutBucketPolicyCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutBucketPolicy", {}).n("S3Client", "PutBucketPolicyCommand").sc(schemas_0.PutBucketPolicy$).build() {};
	var PutBucketReplicationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutBucketReplication", {}).n("S3Client", "PutBucketReplicationCommand").sc(schemas_0.PutBucketReplication$).build() {};
	var PutBucketRequestPaymentCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutBucketRequestPayment", {}).n("S3Client", "PutBucketRequestPaymentCommand").sc(schemas_0.PutBucketRequestPayment$).build() {};
	var PutBucketTaggingCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutBucketTagging", {}).n("S3Client", "PutBucketTaggingCommand").sc(schemas_0.PutBucketTagging$).build() {};
	var PutBucketVersioningCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutBucketVersioning", {}).n("S3Client", "PutBucketVersioningCommand").sc(schemas_0.PutBucketVersioning$).build() {};
	var PutBucketWebsiteCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutBucketWebsite", {}).n("S3Client", "PutBucketWebsiteCommand").sc(schemas_0.PutBucketWebsite$).build() {};
	var PutObjectAclCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestAlgorithmMember: {
					"httpHeader": "x-amz-sdk-checksum-algorithm",
					"name": "ChecksumAlgorithm"
				},
				requestChecksumRequired: true
			}),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config)
		];
	}).s("AmazonS3", "PutObjectAcl", {}).n("S3Client", "PutObjectAclCommand").sc(schemas_0.PutObjectAcl$).build() {};
	var PutObjectCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestAlgorithmMember: {
					"httpHeader": "x-amz-sdk-checksum-algorithm",
					"name": "ChecksumAlgorithm"
				},
				requestChecksumRequired: false
			}),
			middlewareSdkS3.getCheckContentLengthHeaderPlugin(config),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config),
			middlewareSsec.getSsecPlugin(config)
		];
	}).s("AmazonS3", "PutObject", {}).n("S3Client", "PutObjectCommand").sc(schemas_0.PutObject$).build() {};
	var PutObjectLegalHoldCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestAlgorithmMember: {
					"httpHeader": "x-amz-sdk-checksum-algorithm",
					"name": "ChecksumAlgorithm"
				},
				requestChecksumRequired: true
			}),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config)
		];
	}).s("AmazonS3", "PutObjectLegalHold", {}).n("S3Client", "PutObjectLegalHoldCommand").sc(schemas_0.PutObjectLegalHold$).build() {};
	var PutObjectLockConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestAlgorithmMember: {
					"httpHeader": "x-amz-sdk-checksum-algorithm",
					"name": "ChecksumAlgorithm"
				},
				requestChecksumRequired: true
			}),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config)
		];
	}).s("AmazonS3", "PutObjectLockConfiguration", {}).n("S3Client", "PutObjectLockConfigurationCommand").sc(schemas_0.PutObjectLockConfiguration$).build() {};
	var PutObjectRetentionCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestAlgorithmMember: {
					"httpHeader": "x-amz-sdk-checksum-algorithm",
					"name": "ChecksumAlgorithm"
				},
				requestChecksumRequired: true
			}),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config)
		];
	}).s("AmazonS3", "PutObjectRetention", {}).n("S3Client", "PutObjectRetentionCommand").sc(schemas_0.PutObjectRetention$).build() {};
	var PutObjectTaggingCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestAlgorithmMember: {
					"httpHeader": "x-amz-sdk-checksum-algorithm",
					"name": "ChecksumAlgorithm"
				},
				requestChecksumRequired: true
			}),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config)
		];
	}).s("AmazonS3", "PutObjectTagging", {}).n("S3Client", "PutObjectTaggingCommand").sc(schemas_0.PutObjectTagging$).build() {};
	var PutPublicAccessBlockCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "PutPublicAccessBlock", {}).n("S3Client", "PutPublicAccessBlockCommand").sc(schemas_0.PutPublicAccessBlock$).build() {};
	var RenameObjectCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSdkS3.getThrow200ExceptionsPlugin(config)];
	}).s("AmazonS3", "RenameObject", {}).n("S3Client", "RenameObjectCommand").sc(schemas_0.RenameObject$).build() {};
	var RestoreObjectCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestAlgorithmMember: {
					"httpHeader": "x-amz-sdk-checksum-algorithm",
					"name": "ChecksumAlgorithm"
				},
				requestChecksumRequired: false
			}),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config)
		];
	}).s("AmazonS3", "RestoreObject", {}).n("S3Client", "RestoreObjectCommand").sc(schemas_0.RestoreObject$).build() {};
	var SelectObjectContentCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareSsec.getSsecPlugin(config)];
	}).s("AmazonS3", "SelectObjectContent", { eventStream: { output: true } }).n("S3Client", "SelectObjectContentCommand").sc(schemas_0.SelectObjectContent$).build() {};
	var UpdateBucketMetadataInventoryTableConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "UpdateBucketMetadataInventoryTableConfiguration", {}).n("S3Client", "UpdateBucketMetadataInventoryTableConfigurationCommand").sc(schemas_0.UpdateBucketMetadataInventoryTableConfiguration$).build() {};
	var UpdateBucketMetadataJournalTableConfigurationCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseS3ExpressControlEndpoint: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()), middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
			requestAlgorithmMember: {
				"httpHeader": "x-amz-sdk-checksum-algorithm",
				"name": "ChecksumAlgorithm"
			},
			requestChecksumRequired: true
		})];
	}).s("AmazonS3", "UpdateBucketMetadataJournalTableConfiguration", {}).n("S3Client", "UpdateBucketMetadataJournalTableConfigurationCommand").sc(schemas_0.UpdateBucketMetadataJournalTableConfiguration$).build() {};
	var UpdateObjectEncryptionCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestAlgorithmMember: {
					"httpHeader": "x-amz-sdk-checksum-algorithm",
					"name": "ChecksumAlgorithm"
				},
				requestChecksumRequired: true
			}),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config)
		];
	}).s("AmazonS3", "UpdateObjectEncryption", {}).n("S3Client", "UpdateObjectEncryptionCommand").sc(schemas_0.UpdateObjectEncryption$).build() {};
	var UploadPartCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		},
		Key: {
			type: "contextParams",
			name: "Key"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareFlexibleChecksums.getFlexibleChecksumsPlugin(config, {
				requestAlgorithmMember: {
					"httpHeader": "x-amz-sdk-checksum-algorithm",
					"name": "ChecksumAlgorithm"
				},
				requestChecksumRequired: false
			}),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config),
			middlewareSsec.getSsecPlugin(config)
		];
	}).s("AmazonS3", "UploadPart", {}).n("S3Client", "UploadPartCommand").sc(schemas_0.UploadPart$).build() {};
	var UploadPartCopyCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		DisableS3ExpressSessionAuth: {
			type: "staticContextParams",
			value: true
		},
		Bucket: {
			type: "contextParams",
			name: "Bucket"
		}
	}).m(function(Command, cs, config, o) {
		return [
			endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions()),
			middlewareSdkS3.getThrow200ExceptionsPlugin(config),
			middlewareSsec.getSsecPlugin(config)
		];
	}).s("AmazonS3", "UploadPartCopy", {}).n("S3Client", "UploadPartCopyCommand").sc(schemas_0.UploadPartCopy$).build() {};
	var WriteGetObjectResponseCommand = class extends client.Command.classBuilder().ep({
		...commonParams,
		UseObjectLambdaEndpoint: {
			type: "staticContextParams",
			value: true
		}
	}).m(function(Command, cs, config, o) {
		return [endpoints.getEndpointPlugin(config, Command.getEndpointParameterInstructions())];
	}).s("AmazonS3", "WriteGetObjectResponse", {}).n("S3Client", "WriteGetObjectResponseCommand").sc(schemas_0.WriteGetObjectResponse$).build() {};
	const paginateListBuckets = core.createPaginator(S3Client, ListBucketsCommand, "ContinuationToken", "ContinuationToken", "MaxBuckets");
	const paginateListDirectoryBuckets = core.createPaginator(S3Client, ListDirectoryBucketsCommand, "ContinuationToken", "ContinuationToken", "MaxDirectoryBuckets");
	const paginateListObjectsV2 = core.createPaginator(S3Client, ListObjectsV2Command, "ContinuationToken", "NextContinuationToken", "MaxKeys");
	const paginateListParts = core.createPaginator(S3Client, ListPartsCommand, "PartNumberMarker", "NextPartNumberMarker", "MaxParts");
	const checkState$3 = async (client$1, input) => {
		let reason;
		try {
			reason = await client$1.send(new HeadBucketCommand(input));
			return {
				state: client.WaiterState.SUCCESS,
				reason
			};
		} catch (exception) {
			reason = exception;
			if (exception.name === "NotFound") return {
				state: client.WaiterState.RETRY,
				reason
			};
		}
		return {
			state: client.WaiterState.RETRY,
			reason
		};
	};
	const waitForBucketExists = async (params, input) => {
		return client.createWaiter({
			minDelay: 5,
			maxDelay: 120,
			...params
		}, input, checkState$3);
	};
	const waitUntilBucketExists = async (params, input) => {
		const result = await client.createWaiter({
			minDelay: 5,
			maxDelay: 120,
			...params
		}, input, checkState$3);
		return client.checkExceptions(result);
	};
	const checkState$2 = async (client$1, input) => {
		let reason;
		try {
			reason = await client$1.send(new HeadBucketCommand(input));
		} catch (exception) {
			reason = exception;
			if (exception.name === "NotFound") return {
				state: client.WaiterState.SUCCESS,
				reason
			};
		}
		return {
			state: client.WaiterState.RETRY,
			reason
		};
	};
	const waitForBucketNotExists = async (params, input) => {
		return client.createWaiter({
			minDelay: 5,
			maxDelay: 120,
			...params
		}, input, checkState$2);
	};
	const waitUntilBucketNotExists = async (params, input) => {
		const result = await client.createWaiter({
			minDelay: 5,
			maxDelay: 120,
			...params
		}, input, checkState$2);
		return client.checkExceptions(result);
	};
	const checkState$1 = async (client$1, input) => {
		let reason;
		try {
			reason = await client$1.send(new HeadObjectCommand(input));
			return {
				state: client.WaiterState.SUCCESS,
				reason
			};
		} catch (exception) {
			reason = exception;
			if (exception.name === "NotFound") return {
				state: client.WaiterState.RETRY,
				reason
			};
		}
		return {
			state: client.WaiterState.RETRY,
			reason
		};
	};
	const waitForObjectExists = async (params, input) => {
		return client.createWaiter({
			minDelay: 5,
			maxDelay: 120,
			...params
		}, input, checkState$1);
	};
	const waitUntilObjectExists = async (params, input) => {
		const result = await client.createWaiter({
			minDelay: 5,
			maxDelay: 120,
			...params
		}, input, checkState$1);
		return client.checkExceptions(result);
	};
	const checkState = async (client$1, input) => {
		let reason;
		try {
			reason = await client$1.send(new HeadObjectCommand(input));
		} catch (exception) {
			reason = exception;
			if (exception.name === "NotFound") return {
				state: client.WaiterState.SUCCESS,
				reason
			};
		}
		return {
			state: client.WaiterState.RETRY,
			reason
		};
	};
	const waitForObjectNotExists = async (params, input) => {
		return client.createWaiter({
			minDelay: 5,
			maxDelay: 120,
			...params
		}, input, checkState);
	};
	const waitUntilObjectNotExists = async (params, input) => {
		const result = await client.createWaiter({
			minDelay: 5,
			maxDelay: 120,
			...params
		}, input, checkState);
		return client.checkExceptions(result);
	};
	const commands = {
		AbortMultipartUploadCommand,
		CompleteMultipartUploadCommand,
		CopyObjectCommand,
		CreateBucketCommand,
		CreateBucketMetadataConfigurationCommand,
		CreateBucketMetadataTableConfigurationCommand,
		CreateMultipartUploadCommand,
		CreateSessionCommand,
		DeleteBucketCommand,
		DeleteBucketAnalyticsConfigurationCommand,
		DeleteBucketCorsCommand,
		DeleteBucketEncryptionCommand,
		DeleteBucketIntelligentTieringConfigurationCommand,
		DeleteBucketInventoryConfigurationCommand,
		DeleteBucketLifecycleCommand,
		DeleteBucketMetadataConfigurationCommand,
		DeleteBucketMetadataTableConfigurationCommand,
		DeleteBucketMetricsConfigurationCommand,
		DeleteBucketOwnershipControlsCommand,
		DeleteBucketPolicyCommand,
		DeleteBucketReplicationCommand,
		DeleteBucketTaggingCommand,
		DeleteBucketWebsiteCommand,
		DeleteObjectCommand,
		DeleteObjectsCommand,
		DeleteObjectTaggingCommand,
		DeletePublicAccessBlockCommand,
		GetBucketAbacCommand,
		GetBucketAccelerateConfigurationCommand,
		GetBucketAclCommand,
		GetBucketAnalyticsConfigurationCommand,
		GetBucketCorsCommand,
		GetBucketEncryptionCommand,
		GetBucketIntelligentTieringConfigurationCommand,
		GetBucketInventoryConfigurationCommand,
		GetBucketLifecycleConfigurationCommand,
		GetBucketLocationCommand,
		GetBucketLoggingCommand,
		GetBucketMetadataConfigurationCommand,
		GetBucketMetadataTableConfigurationCommand,
		GetBucketMetricsConfigurationCommand,
		GetBucketNotificationConfigurationCommand,
		GetBucketOwnershipControlsCommand,
		GetBucketPolicyCommand,
		GetBucketPolicyStatusCommand,
		GetBucketReplicationCommand,
		GetBucketRequestPaymentCommand,
		GetBucketTaggingCommand,
		GetBucketVersioningCommand,
		GetBucketWebsiteCommand,
		GetObjectCommand,
		GetObjectAclCommand,
		GetObjectAttributesCommand,
		GetObjectLegalHoldCommand,
		GetObjectLockConfigurationCommand,
		GetObjectRetentionCommand,
		GetObjectTaggingCommand,
		GetObjectTorrentCommand,
		GetPublicAccessBlockCommand,
		HeadBucketCommand,
		HeadObjectCommand,
		ListBucketAnalyticsConfigurationsCommand,
		ListBucketIntelligentTieringConfigurationsCommand,
		ListBucketInventoryConfigurationsCommand,
		ListBucketMetricsConfigurationsCommand,
		ListBucketsCommand,
		ListDirectoryBucketsCommand,
		ListMultipartUploadsCommand,
		ListObjectsCommand,
		ListObjectsV2Command,
		ListObjectVersionsCommand,
		ListPartsCommand,
		PutBucketAbacCommand,
		PutBucketAccelerateConfigurationCommand,
		PutBucketAclCommand,
		PutBucketAnalyticsConfigurationCommand,
		PutBucketCorsCommand,
		PutBucketEncryptionCommand,
		PutBucketIntelligentTieringConfigurationCommand,
		PutBucketInventoryConfigurationCommand,
		PutBucketLifecycleConfigurationCommand,
		PutBucketLoggingCommand,
		PutBucketMetricsConfigurationCommand,
		PutBucketNotificationConfigurationCommand,
		PutBucketOwnershipControlsCommand,
		PutBucketPolicyCommand,
		PutBucketReplicationCommand,
		PutBucketRequestPaymentCommand,
		PutBucketTaggingCommand,
		PutBucketVersioningCommand,
		PutBucketWebsiteCommand,
		PutObjectCommand,
		PutObjectAclCommand,
		PutObjectLegalHoldCommand,
		PutObjectLockConfigurationCommand,
		PutObjectRetentionCommand,
		PutObjectTaggingCommand,
		PutPublicAccessBlockCommand,
		RenameObjectCommand,
		RestoreObjectCommand,
		SelectObjectContentCommand,
		UpdateBucketMetadataInventoryTableConfigurationCommand,
		UpdateBucketMetadataJournalTableConfigurationCommand,
		UpdateObjectEncryptionCommand,
		UploadPartCommand,
		UploadPartCopyCommand,
		WriteGetObjectResponseCommand
	};
	const paginators = {
		paginateListBuckets,
		paginateListDirectoryBuckets,
		paginateListObjectsV2,
		paginateListParts
	};
	const waiters = {
		waitUntilBucketExists,
		waitUntilBucketNotExists,
		waitUntilObjectExists,
		waitUntilObjectNotExists
	};
	var S3 = class extends S3Client {};
	client.createAggregatedClient(commands, S3, {
		paginators,
		waiters
	});
	const BucketAbacStatus = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const RequestCharged = { requester: "requester" };
	const RequestPayer = { requester: "requester" };
	const BucketAccelerateStatus = {
		Enabled: "Enabled",
		Suspended: "Suspended"
	};
	const Type = {
		AmazonCustomerByEmail: "AmazonCustomerByEmail",
		CanonicalUser: "CanonicalUser",
		Group: "Group"
	};
	const Permission = {
		FULL_CONTROL: "FULL_CONTROL",
		READ: "READ",
		READ_ACP: "READ_ACP",
		WRITE: "WRITE",
		WRITE_ACP: "WRITE_ACP"
	};
	const OwnerOverride = { Destination: "Destination" };
	const ChecksumType = {
		COMPOSITE: "COMPOSITE",
		FULL_OBJECT: "FULL_OBJECT"
	};
	const ServerSideEncryption = {
		AES256: "AES256",
		aws_fsx: "aws:fsx",
		aws_kms: "aws:kms",
		aws_kms_dsse: "aws:kms:dsse"
	};
	const ObjectCannedACL = {
		authenticated_read: "authenticated-read",
		aws_exec_read: "aws-exec-read",
		bucket_owner_full_control: "bucket-owner-full-control",
		bucket_owner_read: "bucket-owner-read",
		private: "private",
		public_read: "public-read",
		public_read_write: "public-read-write"
	};
	const ChecksumAlgorithm = {
		CRC32: "CRC32",
		CRC32C: "CRC32C",
		CRC64NVME: "CRC64NVME",
		MD5: "MD5",
		SHA1: "SHA1",
		SHA256: "SHA256",
		SHA512: "SHA512",
		XXHASH128: "XXHASH128",
		XXHASH3: "XXHASH3",
		XXHASH64: "XXHASH64"
	};
	const MetadataDirective = {
		COPY: "COPY",
		REPLACE: "REPLACE"
	};
	const ObjectLockLegalHoldStatus = {
		OFF: "OFF",
		ON: "ON"
	};
	const ObjectLockMode = {
		COMPLIANCE: "COMPLIANCE",
		GOVERNANCE: "GOVERNANCE"
	};
	const StorageClass = {
		DEEP_ARCHIVE: "DEEP_ARCHIVE",
		EXPRESS_ONEZONE: "EXPRESS_ONEZONE",
		FSX_ONTAP: "FSX_ONTAP",
		FSX_OPENZFS: "FSX_OPENZFS",
		GLACIER: "GLACIER",
		GLACIER_IR: "GLACIER_IR",
		INTELLIGENT_TIERING: "INTELLIGENT_TIERING",
		ONEZONE_IA: "ONEZONE_IA",
		OUTPOSTS: "OUTPOSTS",
		REDUCED_REDUNDANCY: "REDUCED_REDUNDANCY",
		SNOW: "SNOW",
		STANDARD: "STANDARD",
		STANDARD_IA: "STANDARD_IA"
	};
	const TaggingDirective = {
		COPY: "COPY",
		REPLACE: "REPLACE"
	};
	const BucketCannedACL = {
		authenticated_read: "authenticated-read",
		private: "private",
		public_read: "public-read",
		public_read_write: "public-read-write"
	};
	const BucketNamespace = {
		ACCOUNT_REGIONAL: "account-regional",
		GLOBAL: "global"
	};
	const DataRedundancy = {
		SingleAvailabilityZone: "SingleAvailabilityZone",
		SingleLocalZone: "SingleLocalZone"
	};
	const BucketType = { Directory: "Directory" };
	const LocationType = {
		AvailabilityZone: "AvailabilityZone",
		LocalZone: "LocalZone"
	};
	const BucketLocationConstraint = {
		EU: "EU",
		af_south_1: "af-south-1",
		ap_east_1: "ap-east-1",
		ap_east_2: "ap-east-2",
		ap_northeast_1: "ap-northeast-1",
		ap_northeast_2: "ap-northeast-2",
		ap_northeast_3: "ap-northeast-3",
		ap_south_1: "ap-south-1",
		ap_south_2: "ap-south-2",
		ap_southeast_1: "ap-southeast-1",
		ap_southeast_2: "ap-southeast-2",
		ap_southeast_3: "ap-southeast-3",
		ap_southeast_4: "ap-southeast-4",
		ap_southeast_5: "ap-southeast-5",
		ap_southeast_6: "ap-southeast-6",
		ap_southeast_7: "ap-southeast-7",
		ca_central_1: "ca-central-1",
		ca_west_1: "ca-west-1",
		cn_north_1: "cn-north-1",
		cn_northwest_1: "cn-northwest-1",
		eu_central_1: "eu-central-1",
		eu_central_2: "eu-central-2",
		eu_north_1: "eu-north-1",
		eu_south_1: "eu-south-1",
		eu_south_2: "eu-south-2",
		eu_west_1: "eu-west-1",
		eu_west_2: "eu-west-2",
		eu_west_3: "eu-west-3",
		il_central_1: "il-central-1",
		me_central_1: "me-central-1",
		me_south_1: "me-south-1",
		mx_central_1: "mx-central-1",
		sa_east_1: "sa-east-1",
		us_east_2: "us-east-2",
		us_gov_east_1: "us-gov-east-1",
		us_gov_west_1: "us-gov-west-1",
		us_west_1: "us-west-1",
		us_west_2: "us-west-2"
	};
	const ObjectOwnership = {
		BucketOwnerEnforced: "BucketOwnerEnforced",
		BucketOwnerPreferred: "BucketOwnerPreferred",
		ObjectWriter: "ObjectWriter"
	};
	const InventoryConfigurationState = {
		DISABLED: "DISABLED",
		ENABLED: "ENABLED"
	};
	const TableSseAlgorithm = {
		AES256: "AES256",
		aws_kms: "aws:kms"
	};
	const ExpirationState = {
		DISABLED: "DISABLED",
		ENABLED: "ENABLED"
	};
	const SessionMode = {
		ReadOnly: "ReadOnly",
		ReadWrite: "ReadWrite"
	};
	const AnalyticsS3ExportFileFormat = { CSV: "CSV" };
	const StorageClassAnalysisSchemaVersion = { V_1: "V_1" };
	const EncryptionType = {
		NONE: "NONE",
		SSE_C: "SSE-C"
	};
	const IntelligentTieringStatus = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const IntelligentTieringAccessTier = {
		ARCHIVE_ACCESS: "ARCHIVE_ACCESS",
		DEEP_ARCHIVE_ACCESS: "DEEP_ARCHIVE_ACCESS"
	};
	const InventoryFormat = {
		CSV: "CSV",
		ORC: "ORC",
		Parquet: "Parquet"
	};
	const InventoryIncludedObjectVersions = {
		All: "All",
		Current: "Current"
	};
	const InventoryOptionalField = {
		BucketKeyStatus: "BucketKeyStatus",
		ChecksumAlgorithm: "ChecksumAlgorithm",
		ETag: "ETag",
		EncryptionStatus: "EncryptionStatus",
		IntelligentTieringAccessTier: "IntelligentTieringAccessTier",
		IsMultipartUploaded: "IsMultipartUploaded",
		LastModifiedDate: "LastModifiedDate",
		LifecycleExpirationDate: "LifecycleExpirationDate",
		ObjectAccessControlList: "ObjectAccessControlList",
		ObjectLockLegalHoldStatus: "ObjectLockLegalHoldStatus",
		ObjectLockMode: "ObjectLockMode",
		ObjectLockRetainUntilDate: "ObjectLockRetainUntilDate",
		ObjectOwner: "ObjectOwner",
		ReplicationStatus: "ReplicationStatus",
		Size: "Size",
		StorageClass: "StorageClass"
	};
	const InventoryFrequency = {
		Daily: "Daily",
		Weekly: "Weekly"
	};
	const TransitionStorageClass = {
		DEEP_ARCHIVE: "DEEP_ARCHIVE",
		GLACIER: "GLACIER",
		GLACIER_IR: "GLACIER_IR",
		INTELLIGENT_TIERING: "INTELLIGENT_TIERING",
		ONEZONE_IA: "ONEZONE_IA",
		STANDARD_IA: "STANDARD_IA"
	};
	const ExpirationStatus = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const TransitionDefaultMinimumObjectSize = {
		all_storage_classes_128K: "all_storage_classes_128K",
		varies_by_storage_class: "varies_by_storage_class"
	};
	const BucketLogsPermission = {
		FULL_CONTROL: "FULL_CONTROL",
		READ: "READ",
		WRITE: "WRITE"
	};
	const PartitionDateSource = {
		DeliveryTime: "DeliveryTime",
		EventTime: "EventTime"
	};
	const S3TablesBucketType = {
		aws: "aws",
		customer: "customer"
	};
	const Event = {
		s3_IntelligentTiering: "s3:IntelligentTiering",
		s3_LifecycleExpiration_: "s3:LifecycleExpiration:*",
		s3_LifecycleExpiration_Delete: "s3:LifecycleExpiration:Delete",
		s3_LifecycleExpiration_DeleteMarkerCreated: "s3:LifecycleExpiration:DeleteMarkerCreated",
		s3_LifecycleTransition: "s3:LifecycleTransition",
		s3_ObjectAcl_Put: "s3:ObjectAcl:Put",
		s3_ObjectCreated_: "s3:ObjectCreated:*",
		s3_ObjectCreated_CompleteMultipartUpload: "s3:ObjectCreated:CompleteMultipartUpload",
		s3_ObjectCreated_Copy: "s3:ObjectCreated:Copy",
		s3_ObjectCreated_Post: "s3:ObjectCreated:Post",
		s3_ObjectCreated_Put: "s3:ObjectCreated:Put",
		s3_ObjectRemoved_: "s3:ObjectRemoved:*",
		s3_ObjectRemoved_Delete: "s3:ObjectRemoved:Delete",
		s3_ObjectRemoved_DeleteMarkerCreated: "s3:ObjectRemoved:DeleteMarkerCreated",
		s3_ObjectRestore_: "s3:ObjectRestore:*",
		s3_ObjectRestore_Completed: "s3:ObjectRestore:Completed",
		s3_ObjectRestore_Delete: "s3:ObjectRestore:Delete",
		s3_ObjectRestore_Post: "s3:ObjectRestore:Post",
		s3_ObjectTagging_: "s3:ObjectTagging:*",
		s3_ObjectTagging_Delete: "s3:ObjectTagging:Delete",
		s3_ObjectTagging_Put: "s3:ObjectTagging:Put",
		s3_ReducedRedundancyLostObject: "s3:ReducedRedundancyLostObject",
		s3_Replication_: "s3:Replication:*",
		s3_Replication_OperationFailedReplication: "s3:Replication:OperationFailedReplication",
		s3_Replication_OperationMissedThreshold: "s3:Replication:OperationMissedThreshold",
		s3_Replication_OperationNotTracked: "s3:Replication:OperationNotTracked",
		s3_Replication_OperationReplicatedAfterThreshold: "s3:Replication:OperationReplicatedAfterThreshold"
	};
	const FilterRuleName = {
		prefix: "prefix",
		suffix: "suffix"
	};
	const DeleteMarkerReplicationStatus = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const MetricsStatus = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const ReplicationTimeStatus = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const ExistingObjectReplicationStatus = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const ReplicaModificationsStatus = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const SseKmsEncryptedObjectsStatus = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const ReplicationRuleStatus = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const Payer = {
		BucketOwner: "BucketOwner",
		Requester: "Requester"
	};
	const MFADeleteStatus = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const BucketVersioningStatus = {
		Enabled: "Enabled",
		Suspended: "Suspended"
	};
	const Protocol = {
		http: "http",
		https: "https"
	};
	const ReplicationStatus = {
		COMPLETE: "COMPLETE",
		COMPLETED: "COMPLETED",
		FAILED: "FAILED",
		PENDING: "PENDING",
		REPLICA: "REPLICA"
	};
	const ChecksumMode = { ENABLED: "ENABLED" };
	const ObjectAttributes = {
		CHECKSUM: "Checksum",
		ETAG: "ETag",
		OBJECT_PARTS: "ObjectParts",
		OBJECT_SIZE: "ObjectSize",
		STORAGE_CLASS: "StorageClass"
	};
	const ObjectLockEnabled = { Enabled: "Enabled" };
	const ObjectLockRetentionMode = {
		COMPLIANCE: "COMPLIANCE",
		GOVERNANCE: "GOVERNANCE"
	};
	const ArchiveStatus = {
		ARCHIVE_ACCESS: "ARCHIVE_ACCESS",
		DEEP_ARCHIVE_ACCESS: "DEEP_ARCHIVE_ACCESS"
	};
	const EncodingType = { url: "url" };
	const ObjectStorageClass = {
		DEEP_ARCHIVE: "DEEP_ARCHIVE",
		EXPRESS_ONEZONE: "EXPRESS_ONEZONE",
		FSX_ONTAP: "FSX_ONTAP",
		FSX_OPENZFS: "FSX_OPENZFS",
		GLACIER: "GLACIER",
		GLACIER_IR: "GLACIER_IR",
		INTELLIGENT_TIERING: "INTELLIGENT_TIERING",
		ONEZONE_IA: "ONEZONE_IA",
		OUTPOSTS: "OUTPOSTS",
		REDUCED_REDUNDANCY: "REDUCED_REDUNDANCY",
		SNOW: "SNOW",
		STANDARD: "STANDARD",
		STANDARD_IA: "STANDARD_IA"
	};
	const OptionalObjectAttributes = { RESTORE_STATUS: "RestoreStatus" };
	const ObjectVersionStorageClass = { STANDARD: "STANDARD" };
	const MFADelete = {
		Disabled: "Disabled",
		Enabled: "Enabled"
	};
	const Tier = {
		Bulk: "Bulk",
		Expedited: "Expedited",
		Standard: "Standard"
	};
	const ExpressionType = { SQL: "SQL" };
	const CompressionType = {
		BZIP2: "BZIP2",
		GZIP: "GZIP",
		NONE: "NONE"
	};
	const FileHeaderInfo = {
		IGNORE: "IGNORE",
		NONE: "NONE",
		USE: "USE"
	};
	const JSONType = {
		DOCUMENT: "DOCUMENT",
		LINES: "LINES"
	};
	const QuoteFields = {
		ALWAYS: "ALWAYS",
		ASNEEDED: "ASNEEDED"
	};
	const RestoreRequestType = { SELECT: "SELECT" };
	exports.$Command = client.Command;
	exports.__Client = client.Client;
	exports.S3ServiceException = S3ServiceException.S3ServiceException;
	exports.AbortMultipartUploadCommand = AbortMultipartUploadCommand;
	exports.AnalyticsS3ExportFileFormat = AnalyticsS3ExportFileFormat;
	exports.ArchiveStatus = ArchiveStatus;
	exports.BucketAbacStatus = BucketAbacStatus;
	exports.BucketAccelerateStatus = BucketAccelerateStatus;
	exports.BucketCannedACL = BucketCannedACL;
	exports.BucketLocationConstraint = BucketLocationConstraint;
	exports.BucketLogsPermission = BucketLogsPermission;
	exports.BucketNamespace = BucketNamespace;
	exports.BucketType = BucketType;
	exports.BucketVersioningStatus = BucketVersioningStatus;
	exports.ChecksumAlgorithm = ChecksumAlgorithm;
	exports.ChecksumMode = ChecksumMode;
	exports.ChecksumType = ChecksumType;
	exports.CompleteMultipartUploadCommand = CompleteMultipartUploadCommand;
	exports.CompressionType = CompressionType;
	exports.CopyObjectCommand = CopyObjectCommand;
	exports.CreateBucketCommand = CreateBucketCommand;
	exports.CreateBucketMetadataConfigurationCommand = CreateBucketMetadataConfigurationCommand;
	exports.CreateBucketMetadataTableConfigurationCommand = CreateBucketMetadataTableConfigurationCommand;
	exports.CreateMultipartUploadCommand = CreateMultipartUploadCommand;
	exports.CreateSessionCommand = CreateSessionCommand;
	exports.DataRedundancy = DataRedundancy;
	exports.DeleteBucketAnalyticsConfigurationCommand = DeleteBucketAnalyticsConfigurationCommand;
	exports.DeleteBucketCommand = DeleteBucketCommand;
	exports.DeleteBucketCorsCommand = DeleteBucketCorsCommand;
	exports.DeleteBucketEncryptionCommand = DeleteBucketEncryptionCommand;
	exports.DeleteBucketIntelligentTieringConfigurationCommand = DeleteBucketIntelligentTieringConfigurationCommand;
	exports.DeleteBucketInventoryConfigurationCommand = DeleteBucketInventoryConfigurationCommand;
	exports.DeleteBucketLifecycleCommand = DeleteBucketLifecycleCommand;
	exports.DeleteBucketMetadataConfigurationCommand = DeleteBucketMetadataConfigurationCommand;
	exports.DeleteBucketMetadataTableConfigurationCommand = DeleteBucketMetadataTableConfigurationCommand;
	exports.DeleteBucketMetricsConfigurationCommand = DeleteBucketMetricsConfigurationCommand;
	exports.DeleteBucketOwnershipControlsCommand = DeleteBucketOwnershipControlsCommand;
	exports.DeleteBucketPolicyCommand = DeleteBucketPolicyCommand;
	exports.DeleteBucketReplicationCommand = DeleteBucketReplicationCommand;
	exports.DeleteBucketTaggingCommand = DeleteBucketTaggingCommand;
	exports.DeleteBucketWebsiteCommand = DeleteBucketWebsiteCommand;
	exports.DeleteMarkerReplicationStatus = DeleteMarkerReplicationStatus;
	exports.DeleteObjectCommand = DeleteObjectCommand;
	exports.DeleteObjectTaggingCommand = DeleteObjectTaggingCommand;
	exports.DeleteObjectsCommand = DeleteObjectsCommand;
	exports.DeletePublicAccessBlockCommand = DeletePublicAccessBlockCommand;
	exports.EncodingType = EncodingType;
	exports.EncryptionType = EncryptionType;
	exports.Event = Event;
	exports.ExistingObjectReplicationStatus = ExistingObjectReplicationStatus;
	exports.ExpirationState = ExpirationState;
	exports.ExpirationStatus = ExpirationStatus;
	exports.ExpressionType = ExpressionType;
	exports.FileHeaderInfo = FileHeaderInfo;
	exports.FilterRuleName = FilterRuleName;
	exports.GetBucketAbacCommand = GetBucketAbacCommand;
	exports.GetBucketAccelerateConfigurationCommand = GetBucketAccelerateConfigurationCommand;
	exports.GetBucketAclCommand = GetBucketAclCommand;
	exports.GetBucketAnalyticsConfigurationCommand = GetBucketAnalyticsConfigurationCommand;
	exports.GetBucketCorsCommand = GetBucketCorsCommand;
	exports.GetBucketEncryptionCommand = GetBucketEncryptionCommand;
	exports.GetBucketIntelligentTieringConfigurationCommand = GetBucketIntelligentTieringConfigurationCommand;
	exports.GetBucketInventoryConfigurationCommand = GetBucketInventoryConfigurationCommand;
	exports.GetBucketLifecycleConfigurationCommand = GetBucketLifecycleConfigurationCommand;
	exports.GetBucketLocationCommand = GetBucketLocationCommand;
	exports.GetBucketLoggingCommand = GetBucketLoggingCommand;
	exports.GetBucketMetadataConfigurationCommand = GetBucketMetadataConfigurationCommand;
	exports.GetBucketMetadataTableConfigurationCommand = GetBucketMetadataTableConfigurationCommand;
	exports.GetBucketMetricsConfigurationCommand = GetBucketMetricsConfigurationCommand;
	exports.GetBucketNotificationConfigurationCommand = GetBucketNotificationConfigurationCommand;
	exports.GetBucketOwnershipControlsCommand = GetBucketOwnershipControlsCommand;
	exports.GetBucketPolicyCommand = GetBucketPolicyCommand;
	exports.GetBucketPolicyStatusCommand = GetBucketPolicyStatusCommand;
	exports.GetBucketReplicationCommand = GetBucketReplicationCommand;
	exports.GetBucketRequestPaymentCommand = GetBucketRequestPaymentCommand;
	exports.GetBucketTaggingCommand = GetBucketTaggingCommand;
	exports.GetBucketVersioningCommand = GetBucketVersioningCommand;
	exports.GetBucketWebsiteCommand = GetBucketWebsiteCommand;
	exports.GetObjectAclCommand = GetObjectAclCommand;
	exports.GetObjectAttributesCommand = GetObjectAttributesCommand;
	exports.GetObjectCommand = GetObjectCommand;
	exports.GetObjectLegalHoldCommand = GetObjectLegalHoldCommand;
	exports.GetObjectLockConfigurationCommand = GetObjectLockConfigurationCommand;
	exports.GetObjectRetentionCommand = GetObjectRetentionCommand;
	exports.GetObjectTaggingCommand = GetObjectTaggingCommand;
	exports.GetObjectTorrentCommand = GetObjectTorrentCommand;
	exports.GetPublicAccessBlockCommand = GetPublicAccessBlockCommand;
	exports.HeadBucketCommand = HeadBucketCommand;
	exports.HeadObjectCommand = HeadObjectCommand;
	exports.IntelligentTieringAccessTier = IntelligentTieringAccessTier;
	exports.IntelligentTieringStatus = IntelligentTieringStatus;
	exports.InventoryConfigurationState = InventoryConfigurationState;
	exports.InventoryFormat = InventoryFormat;
	exports.InventoryFrequency = InventoryFrequency;
	exports.InventoryIncludedObjectVersions = InventoryIncludedObjectVersions;
	exports.InventoryOptionalField = InventoryOptionalField;
	exports.JSONType = JSONType;
	exports.ListBucketAnalyticsConfigurationsCommand = ListBucketAnalyticsConfigurationsCommand;
	exports.ListBucketIntelligentTieringConfigurationsCommand = ListBucketIntelligentTieringConfigurationsCommand;
	exports.ListBucketInventoryConfigurationsCommand = ListBucketInventoryConfigurationsCommand;
	exports.ListBucketMetricsConfigurationsCommand = ListBucketMetricsConfigurationsCommand;
	exports.ListBucketsCommand = ListBucketsCommand;
	exports.ListDirectoryBucketsCommand = ListDirectoryBucketsCommand;
	exports.ListMultipartUploadsCommand = ListMultipartUploadsCommand;
	exports.ListObjectVersionsCommand = ListObjectVersionsCommand;
	exports.ListObjectsCommand = ListObjectsCommand;
	exports.ListObjectsV2Command = ListObjectsV2Command;
	exports.ListPartsCommand = ListPartsCommand;
	exports.LocationType = LocationType;
	exports.MFADelete = MFADelete;
	exports.MFADeleteStatus = MFADeleteStatus;
	exports.MetadataDirective = MetadataDirective;
	exports.MetricsStatus = MetricsStatus;
	exports.ObjectAttributes = ObjectAttributes;
	exports.ObjectCannedACL = ObjectCannedACL;
	exports.ObjectLockEnabled = ObjectLockEnabled;
	exports.ObjectLockLegalHoldStatus = ObjectLockLegalHoldStatus;
	exports.ObjectLockMode = ObjectLockMode;
	exports.ObjectLockRetentionMode = ObjectLockRetentionMode;
	exports.ObjectOwnership = ObjectOwnership;
	exports.ObjectStorageClass = ObjectStorageClass;
	exports.ObjectVersionStorageClass = ObjectVersionStorageClass;
	exports.OptionalObjectAttributes = OptionalObjectAttributes;
	exports.OwnerOverride = OwnerOverride;
	exports.PartitionDateSource = PartitionDateSource;
	exports.Payer = Payer;
	exports.Permission = Permission;
	exports.Protocol = Protocol;
	exports.PutBucketAbacCommand = PutBucketAbacCommand;
	exports.PutBucketAccelerateConfigurationCommand = PutBucketAccelerateConfigurationCommand;
	exports.PutBucketAclCommand = PutBucketAclCommand;
	exports.PutBucketAnalyticsConfigurationCommand = PutBucketAnalyticsConfigurationCommand;
	exports.PutBucketCorsCommand = PutBucketCorsCommand;
	exports.PutBucketEncryptionCommand = PutBucketEncryptionCommand;
	exports.PutBucketIntelligentTieringConfigurationCommand = PutBucketIntelligentTieringConfigurationCommand;
	exports.PutBucketInventoryConfigurationCommand = PutBucketInventoryConfigurationCommand;
	exports.PutBucketLifecycleConfigurationCommand = PutBucketLifecycleConfigurationCommand;
	exports.PutBucketLoggingCommand = PutBucketLoggingCommand;
	exports.PutBucketMetricsConfigurationCommand = PutBucketMetricsConfigurationCommand;
	exports.PutBucketNotificationConfigurationCommand = PutBucketNotificationConfigurationCommand;
	exports.PutBucketOwnershipControlsCommand = PutBucketOwnershipControlsCommand;
	exports.PutBucketPolicyCommand = PutBucketPolicyCommand;
	exports.PutBucketReplicationCommand = PutBucketReplicationCommand;
	exports.PutBucketRequestPaymentCommand = PutBucketRequestPaymentCommand;
	exports.PutBucketTaggingCommand = PutBucketTaggingCommand;
	exports.PutBucketVersioningCommand = PutBucketVersioningCommand;
	exports.PutBucketWebsiteCommand = PutBucketWebsiteCommand;
	exports.PutObjectAclCommand = PutObjectAclCommand;
	exports.PutObjectCommand = PutObjectCommand;
	exports.PutObjectLegalHoldCommand = PutObjectLegalHoldCommand;
	exports.PutObjectLockConfigurationCommand = PutObjectLockConfigurationCommand;
	exports.PutObjectRetentionCommand = PutObjectRetentionCommand;
	exports.PutObjectTaggingCommand = PutObjectTaggingCommand;
	exports.PutPublicAccessBlockCommand = PutPublicAccessBlockCommand;
	exports.QuoteFields = QuoteFields;
	exports.RenameObjectCommand = RenameObjectCommand;
	exports.ReplicaModificationsStatus = ReplicaModificationsStatus;
	exports.ReplicationRuleStatus = ReplicationRuleStatus;
	exports.ReplicationStatus = ReplicationStatus;
	exports.ReplicationTimeStatus = ReplicationTimeStatus;
	exports.RequestCharged = RequestCharged;
	exports.RequestPayer = RequestPayer;
	exports.RestoreObjectCommand = RestoreObjectCommand;
	exports.RestoreRequestType = RestoreRequestType;
	exports.S3 = S3;
	exports.S3Client = S3Client;
	exports.S3TablesBucketType = S3TablesBucketType;
	exports.SelectObjectContentCommand = SelectObjectContentCommand;
	exports.ServerSideEncryption = ServerSideEncryption;
	exports.SessionMode = SessionMode;
	exports.SseKmsEncryptedObjectsStatus = SseKmsEncryptedObjectsStatus;
	exports.StorageClass = StorageClass;
	exports.StorageClassAnalysisSchemaVersion = StorageClassAnalysisSchemaVersion;
	exports.TableSseAlgorithm = TableSseAlgorithm;
	exports.TaggingDirective = TaggingDirective;
	exports.Tier = Tier;
	exports.TransitionDefaultMinimumObjectSize = TransitionDefaultMinimumObjectSize;
	exports.TransitionStorageClass = TransitionStorageClass;
	exports.Type = Type;
	exports.UpdateBucketMetadataInventoryTableConfigurationCommand = UpdateBucketMetadataInventoryTableConfigurationCommand;
	exports.UpdateBucketMetadataJournalTableConfigurationCommand = UpdateBucketMetadataJournalTableConfigurationCommand;
	exports.UpdateObjectEncryptionCommand = UpdateObjectEncryptionCommand;
	exports.UploadPartCommand = UploadPartCommand;
	exports.UploadPartCopyCommand = UploadPartCopyCommand;
	exports.WriteGetObjectResponseCommand = WriteGetObjectResponseCommand;
	exports.paginateListBuckets = paginateListBuckets;
	exports.paginateListDirectoryBuckets = paginateListDirectoryBuckets;
	exports.paginateListObjectsV2 = paginateListObjectsV2;
	exports.paginateListParts = paginateListParts;
	exports.waitForBucketExists = waitForBucketExists;
	exports.waitForBucketNotExists = waitForBucketNotExists;
	exports.waitForObjectExists = waitForObjectExists;
	exports.waitForObjectNotExists = waitForObjectNotExists;
	exports.waitUntilBucketExists = waitUntilBucketExists;
	exports.waitUntilBucketNotExists = waitUntilBucketNotExists;
	exports.waitUntilObjectExists = waitUntilObjectExists;
	exports.waitUntilObjectNotExists = waitUntilObjectNotExists;
	Object.prototype.hasOwnProperty.call(schemas_0, "__proto__") && !Object.prototype.hasOwnProperty.call(exports, "__proto__") && Object.defineProperty(exports, "__proto__", {
		enumerable: true,
		value: schemas_0["__proto__"]
	});
	Object.keys(schemas_0).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) exports[k] = schemas_0[k];
	});
	Object.prototype.hasOwnProperty.call(errors, "__proto__") && !Object.prototype.hasOwnProperty.call(exports, "__proto__") && Object.defineProperty(exports, "__proto__", {
		enumerable: true,
		value: errors["__proto__"]
	});
	Object.keys(errors).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) exports[k] = errors[k];
	});
}));
//#endregion
//#region node_modules/@aws-sdk/s3-request-presigner/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var util = (init_util(), __toCommonJS(util_exports));
	var endpoints = (init_endpoints(), __toCommonJS(endpoints_exports));
	var protocols = (init_protocols(), __toCommonJS(protocols_exports));
	var signatureV4MultiRegion = require_dist_cjs$10();
	const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
	const SHA256_HEADER = "X-Amz-Content-Sha256";
	var S3RequestPresigner = class {
		signer;
		constructor(options) {
			const resolvedOptions = {
				service: options.signingName || options.service || "s3",
				uriEscapePath: options.uriEscapePath || false,
				applyChecksum: options.applyChecksum || false,
				...options
			};
			this.signer = new signatureV4MultiRegion.SignatureV4MultiRegion(resolvedOptions);
		}
		presign(requestToSign, { unsignableHeaders = /* @__PURE__ */ new Set(), hoistableHeaders = /* @__PURE__ */ new Set(), unhoistableHeaders = /* @__PURE__ */ new Set(), ...options } = {}) {
			this.prepareRequest(requestToSign, {
				unsignableHeaders,
				unhoistableHeaders,
				hoistableHeaders
			});
			return this.signer.presign(requestToSign, {
				expiresIn: 900,
				unsignableHeaders,
				unhoistableHeaders,
				...options
			});
		}
		presignWithCredentials(requestToSign, credentials, { unsignableHeaders = /* @__PURE__ */ new Set(), hoistableHeaders = /* @__PURE__ */ new Set(), unhoistableHeaders = /* @__PURE__ */ new Set(), ...options } = {}) {
			this.prepareRequest(requestToSign, {
				unsignableHeaders,
				unhoistableHeaders,
				hoistableHeaders
			});
			return this.signer.presignWithCredentials(requestToSign, credentials, {
				expiresIn: 900,
				unsignableHeaders,
				unhoistableHeaders,
				...options
			});
		}
		prepareRequest(requestToSign, { unsignableHeaders = /* @__PURE__ */ new Set(), unhoistableHeaders = /* @__PURE__ */ new Set(), hoistableHeaders = /* @__PURE__ */ new Set() } = {}) {
			unsignableHeaders.add("content-type");
			Object.keys(requestToSign.headers).map((header) => header.toLowerCase()).filter((header) => header.startsWith("x-amz-server-side-encryption")).forEach((header) => {
				if (!hoistableHeaders.has(header)) unhoistableHeaders.add(header);
			});
			requestToSign.headers[SHA256_HEADER] = UNSIGNED_PAYLOAD;
			const currentHostHeader = requestToSign.headers.host;
			const port = requestToSign.port;
			const expectedHostHeader = `${requestToSign.hostname}${requestToSign.port != null ? ":" + port : ""}`;
			if (!currentHostHeader || currentHostHeader === requestToSign.hostname && requestToSign.port != null) requestToSign.headers.host = expectedHostHeader;
		}
	};
	const getSignedUrl = async (client, command, options = {}) => {
		let s3Presigner;
		let region;
		if (typeof client.config.endpointProvider === "function") {
			const authScheme = (await endpoints.getEndpointFromInstructions(command.input, command.constructor, client.config)).properties?.authSchemes?.[0];
			if (authScheme?.name === "sigv4a") region = authScheme?.signingRegionSet?.join(",");
			else region = authScheme?.signingRegion;
			s3Presigner = new S3RequestPresigner({
				...client.config,
				signingName: authScheme?.signingName,
				region: async () => region
			});
		} else s3Presigner = new S3RequestPresigner(client.config);
		const presignInterceptMiddleware = (next, context) => async (args) => {
			const { request } = args;
			if (!protocols.HttpRequest.isInstance(request)) throw new Error("Request to be presigned is not an valid HTTP request.");
			delete request.headers["amz-sdk-invocation-id"];
			delete request.headers["amz-sdk-request"];
			delete request.headers["x-amz-user-agent"];
			let presigned;
			const presignerOptions = {
				...options,
				signingRegion: options.signingRegion ?? context["signing_region"] ?? region,
				signingService: options.signingService ?? context["signing_service"]
			};
			if (context.s3ExpressIdentity) presigned = await s3Presigner.presignWithCredentials(request, context.s3ExpressIdentity, presignerOptions);
			else presigned = await s3Presigner.presign(request, presignerOptions);
			return {
				response: {},
				output: {
					$metadata: { httpStatusCode: 200 },
					presigned
				}
			};
		};
		const middlewareName = "presignInterceptMiddleware";
		const clientStack = client.middlewareStack.clone();
		clientStack.addRelativeTo(presignInterceptMiddleware, {
			name: middlewareName,
			relation: "before",
			toMiddleware: "awsAuthMiddleware",
			override: true
		});
		const { output } = await command.resolveMiddleware(clientStack, client.config, {})({ input: command.input });
		const { presigned } = output;
		return util.formatUrl(presigned);
	};
	exports.getSignedUrl = getSignedUrl;
}));
//#endregion
//#region extensions/tlon/src/tlon-api.ts
var import_dist_cjs = require_dist_cjs$1();
var import_dist_cjs$1 = require_dist_cjs();
const MEMEX_BASE_URL = "https://memex.tlon.network";
let currentClientConfig = null;
function configureClient(params) {
	currentClientConfig = {
		...params,
		shipName: params.shipName.replace(/^~/, "")
	};
}
function requireClientConfig() {
	if (!currentClientConfig) throw new Error("Tlon client not configured");
	return currentClientConfig;
}
function getExtensionFromMimeType(mimeType) {
	return extensionForMime(mimeType) || ".jpg";
}
function hasCustomS3Creds(credentials) {
	return Boolean(credentials?.accessKeyId && credentials?.endpoint && credentials?.secretAccessKey);
}
function isStorageCredentials(value) {
	if (!value || typeof value !== "object") return false;
	const record = value;
	return typeof record.endpoint === "string" && typeof record.accessKeyId === "string" && typeof record.secretAccessKey === "string";
}
function hostnameMatchesDomainBoundary(hostname, domain) {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}
function isHostedShipUrl(shipUrl) {
	const hostname = extractShipHostname(shipUrl);
	return hostname !== null && isHostedTlonHostname(hostname);
}
function extractShipHostname(shipUrl) {
	const trimmed = shipUrl.trim();
	if (!trimmed) return null;
	const normalized = /^[a-zA-Z][\w+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		return new URL(normalized).hostname;
	} catch {
		return null;
	}
}
function isHostedTlonHostname(hostname) {
	return hostnameMatchesDomainBoundary(hostname, "tlon.network") || hostnameMatchesDomainBoundary(hostname, "test.tlon.systems");
}
function assertTrustedMemexUploadUrl(rawUrl, label) {
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`${label} must be a valid https URL`);
	}
	if (parsed.protocol !== "https:") throw new Error(`${label} must use https`);
	if (!isHostedTlonHostname(parsed.hostname)) throw new Error(`${label} must target a trusted hosted Tlon domain`);
	if (parsed.port && parsed.port !== "443") throw new Error(`${label} must not specify a non-standard port`);
	return parsed.toString();
}
function assertSafeUploadResultUrl(rawUrl, label) {
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`${label} must be a valid http(s) URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${label} must use http or https`);
	return parsed.toString();
}
function prefixEndpoint(endpoint) {
	return /https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`;
}
function sanitizeFileName(fileName) {
	return fileName.split(/[/\\]/).pop() || fileName;
}
async function getAuthCookie(config) {
	return await authenticate(config.shipUrl, await config.getCode(), { ssrfPolicy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(config.dangerouslyAllowPrivateNetwork) });
}
async function scryJson(config, cookie, path) {
	return await scryUrbitPath({
		baseUrl: config.shipUrl,
		cookie,
		ssrfPolicy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(config.dangerouslyAllowPrivateNetwork)
	}, {
		path,
		auditContext: "tlon-storage-scry"
	});
}
async function getStorageConfiguration(config, cookie) {
	const result = await scryJson(config, cookie, "/storage/configuration.json");
	if ("storage-update" in result && result["storage-update"]?.configuration) return result["storage-update"].configuration;
	if ("currentBucket" in result) return result;
	throw new Error("Invalid storage configuration response");
}
async function getStorageCredentials(config, cookie) {
	const result = await scryJson(config, cookie, "/storage/credentials.json");
	if ("storage-update" in result) return result["storage-update"]?.credentials ?? null;
	if (isStorageCredentials(result)) return result;
	return null;
}
async function getMemexUploadUrl(params) {
	const token = await scryJson(params.config, params.cookie, "/genuine/secret.json");
	const resolvedToken = typeof token === "string" ? token : token.secret;
	if (!resolvedToken) throw new Error("Missing genuine secret");
	const endpoint = `${MEMEX_BASE_URL}/v1/${params.config.shipName}/upload`;
	let release;
	try {
		const guarded = await fetchWithSsrFGuard({
			url: endpoint,
			init: {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: resolvedToken,
					contentLength: params.contentLength,
					contentType: params.contentType,
					fileName: params.fileName
				})
			},
			auditContext: "tlon-memex-upload-url",
			capture: false,
			maxRedirects: 0
		});
		release = guarded.release;
		if (!guarded.response.ok) throw new Error(`Memex upload request failed: ${guarded.response.status}`);
		const data = await guarded.response.json();
		if (!data?.url || !data.filePath) throw new Error("Invalid response from Memex");
		return {
			hostedUrl: data.filePath,
			uploadUrl: data.url
		};
	} finally {
		await release?.();
	}
}
async function uploadFile(params) {
	const config = requireClientConfig();
	const cookie = await getAuthCookie(config);
	const privateNetworkPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(config.dangerouslyAllowPrivateNetwork);
	const [storageConfig, credentials] = await Promise.all([getStorageConfiguration(config, cookie), getStorageCredentials(config, cookie)]);
	const contentType = params.contentType || params.blob.type || "application/octet-stream";
	const extension = getExtensionFromMimeType(contentType);
	const fileName = sanitizeFileName(params.fileName || `upload${extension}`);
	const fileKey = `${config.shipName}/${Date.now()}-${crypto.randomUUID()}-${fileName}`;
	if (isHostedShipUrl(config.shipUrl) && (storageConfig.service === "presigned-url" || !hasCustomS3Creds(credentials))) {
		const { hostedUrl, uploadUrl } = await getMemexUploadUrl({
			config,
			cookie,
			contentLength: params.blob.size,
			contentType,
			fileName: fileKey
		});
		const trustedUploadUrl = assertTrustedMemexUploadUrl(uploadUrl, "Memex upload URL");
		let release;
		try {
			const guarded = await fetchWithSsrFGuard({
				url: trustedUploadUrl,
				init: {
					method: "PUT",
					body: params.blob,
					headers: {
						"Cache-Control": "public, max-age=3600",
						"Content-Type": contentType
					}
				},
				auditContext: "tlon-memex-upload",
				capture: false,
				maxRedirects: 0
			});
			release = guarded.release;
			assertTrustedMemexUploadUrl(guarded.finalUrl, "Memex final upload URL");
			if (!guarded.response.ok) throw new Error(`Upload failed: ${guarded.response.status}`);
		} finally {
			await release?.();
		}
		return { url: assertTrustedMemexUploadUrl(hostedUrl, "Memex hosted URL") };
	}
	if (!hasCustomS3Creds(credentials)) throw new Error("No storage credentials configured");
	const endpoint = new URL(prefixEndpoint(credentials.endpoint));
	const client = new import_dist_cjs.S3Client({
		endpoint: {
			protocol: endpoint.protocol.slice(0, -1),
			hostname: endpoint.host,
			path: endpoint.pathname || "/"
		},
		region: storageConfig.region || "us-east-1",
		credentials: {
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey
		},
		forcePathStyle: true
	});
	const headers = {
		"Cache-Control": "public, max-age=3600",
		"Content-Type": contentType,
		"x-amz-acl": "public-read"
	};
	const signedUrl = await (0, import_dist_cjs$1.getSignedUrl)(client, new import_dist_cjs.PutObjectCommand({
		Bucket: storageConfig.currentBucket,
		Key: fileKey,
		ContentType: headers["Content-Type"],
		CacheControl: headers["Cache-Control"],
		ACL: "public-read"
	}), {
		expiresIn: 3600,
		signableHeaders: new Set(Object.keys(headers))
	});
	let release;
	try {
		const guarded = await fetchWithSsrFGuard({
			url: signedUrl,
			init: {
				method: "PUT",
				body: params.blob,
				headers: signedUrl.includes("digitaloceanspaces.com") ? headers : void 0
			},
			auditContext: "tlon-custom-s3-upload",
			capture: false,
			maxRedirects: 0,
			policy: privateNetworkPolicy
		});
		release = guarded.release;
		if (!guarded.response.ok) throw new Error(`Upload failed: ${guarded.response.status}`);
	} finally {
		await release?.();
	}
	return { url: assertSafeUploadResultUrl(storageConfig.publicUrlBase ? new URL(fileKey, storageConfig.publicUrlBase).toString() : signedUrl.split("?")[0], "Upload result URL") };
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
			policy: void 0,
			auditContext: "tlon-upload-image"
		});
		try {
			if (!response.ok) {
				console.warn(`[tlon] Failed to fetch image from ${imageUrl}: ${response.status}`);
				return imageUrl;
			}
			const contentType = response.headers.get("content-type") || "image/png";
			return (await uploadFile({
				blob: await response.blob(),
				fileName: new URL(imageUrl).pathname.split("/").pop() || `upload-${Date.now()}.png`,
				contentType
			})).url;
		} finally {
			await release();
		}
	} catch (err) {
		console.warn(`[tlon] Failed to upload image, using original URL: ${String(err)}`);
		return imageUrl;
	}
}
//#endregion
//#region extensions/tlon/src/channel.runtime.ts
async function createHttpPokeApi(params) {
	const ssrfPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(params.dangerouslyAllowPrivateNetwork);
	const cookie = await authenticate(params.url, params.code, { ssrfPolicy });
	const channelPath = `/~/channel/${`${Math.floor(Date.now() / 1e3)}-${crypto.randomUUID()}`}`;
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
		dangerouslyAllowPrivateNetwork: account.dangerouslyAllowPrivateNetwork ?? void 0
	});
	try {
		return await run(api);
	} finally {
		try {
			await api.delete();
		} catch {}
	}
}
const tlonRuntimeOutbound = {
	deliveryMode: "direct",
	textChunkLimit: 1e4,
	resolveTarget: ({ to }) => resolveTlonOutboundTarget(to),
	deliveryCapabilities: { durableFinal: {
		text: true,
		media: true,
		replyTo: true,
		thread: true,
		messageSendingHooks: true
	} },
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
		configureClient({
			shipUrl: account.url,
			shipName: account.ship.replace(/^~/, ""),
			verbose: false,
			getCode: async () => account.code,
			dangerouslyAllowPrivateNetwork: account.dangerouslyAllowPrivateNetwork ?? void 0
		});
		const uploadedUrl = mediaUrl ? await uploadImageFromUrl(mediaUrl) : void 0;
		return withHttpPokeAccountApi(account, async (api) => {
			const fromShip = normalizeShip(account.ship);
			const story = buildMediaStory(text, uploadedUrl);
			if (parsed.kind === "dm") return await sendDmWithStory({
				api,
				fromShip,
				toShip: parsed.ship,
				story,
				kind: "media"
			});
			return await sendGroupMessageWithStory({
				api,
				fromShip,
				hostShip: parsed.hostShip,
				channelName: parsed.channelName,
				story,
				replyToId: resolveReplyId(replyToId, threadId),
				kind: "media"
			});
		});
	}
};
async function probeTlonAccount(account) {
	try {
		const ssrfPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(account.dangerouslyAllowPrivateNetwork);
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
}
async function startTlonGatewayAccount(ctx) {
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
}
//#endregion
export { probeTlonAccount, startTlonGatewayAccount, tlonRuntimeOutbound, tlonSetupWizard };
