import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../paths-OqPpu-UR.js";
import { Eo as readJsonBodyWithLimit, Oo as requestBodyErrorToText, Qa as createFixedWindowRateLimiter } from "../../auth-profiles-CuJtivJK.js";
import "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import { H as isBlockedHostnameOrIp } from "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../resolve-utils-BpDGEQsl.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import "../../compat-DDXNEdAm.js";
import "../../inbound-envelope-DsNRW6ln.js";
import "../../run-command-Psw08BkS.js";
import "../../device-pairing-DYWF-CWB.js";
import "../../line-iO245OTq.js";
import "../../upsert-with-lock-CLs2bE4R.js";
import "../../self-hosted-provider-setup-C4OZCxyb.js";
import "../../ollama-setup-BM-G12b6.js";
import { a as getNostrRuntime, c as NostrProfileSchema, i as resolveNostrAccount, l as SimplePool, n as nostrPlugin, o as setNostrRuntime, r as publishNostrProfile, s as contentToProfile, t as getNostrProfileState, u as verifyEvent } from "../../channel-G_wtd4eo.js";
import { z } from "zod";
//#region extensions/nostr/src/nostr-profile-import.ts
/**
* Nostr Profile Import
*
* Fetches and verifies kind:0 profile events from relays.
* Used to import existing profiles before editing.
*/
const DEFAULT_TIMEOUT_MS = 5e3;
/**
* Sanitize URLs in an imported profile to prevent SSRF attacks.
* Removes any URLs that don't pass SSRF validation.
*/
function sanitizeProfileUrls(profile) {
	const result = { ...profile };
	for (const field of [
		"picture",
		"banner",
		"website"
	]) {
		const value = result[field];
		if (value && typeof value === "string") {
			if (!validateUrlSafety(value).ok) delete result[field];
		}
	}
	return result;
}
/**
* Fetch the latest kind:0 profile event for a pubkey from relays.
*
* - Queries all relays in parallel
* - Takes the event with the highest created_at
* - Verifies the event signature
* - Parses and returns the profile
*/
async function importProfileFromRelays(opts) {
	const { pubkey, relays, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
	if (!pubkey || !/^[0-9a-fA-F]{64}$/.test(pubkey)) return {
		ok: false,
		error: "Invalid pubkey format (must be 64 hex characters)",
		relaysQueried: []
	};
	if (relays.length === 0) return {
		ok: false,
		error: "No relays configured",
		relaysQueried: []
	};
	const pool = new SimplePool();
	const relaysQueried = [];
	try {
		const events = [];
		const timeoutPromise = new Promise((resolve) => {
			setTimeout(resolve, timeoutMs);
		});
		const subscriptionPromise = new Promise((resolve) => {
			let completed = 0;
			for (const relay of relays) {
				relaysQueried.push(relay);
				const sub = pool.subscribeMany([relay], [{
					kinds: [0],
					authors: [pubkey],
					limit: 1
				}], {
					onevent(event) {
						events.push({
							event,
							relay
						});
					},
					oneose() {
						completed++;
						if (completed >= relays.length) resolve();
					},
					onclose() {
						completed++;
						if (completed >= relays.length) resolve();
					}
				});
				setTimeout(() => {
					sub.close();
				}, timeoutMs);
			}
		});
		await Promise.race([subscriptionPromise, timeoutPromise]);
		if (events.length === 0) return {
			ok: false,
			error: "No profile found on any relay",
			relaysQueried
		};
		let bestEvent = null;
		for (const item of events) if (!bestEvent || item.event.created_at > bestEvent.event.created_at) bestEvent = item;
		if (!bestEvent) return {
			ok: false,
			error: "No valid profile event found",
			relaysQueried
		};
		if (!verifyEvent(bestEvent.event)) return {
			ok: false,
			error: "Profile event has invalid signature",
			relaysQueried,
			sourceRelay: bestEvent.relay
		};
		let content;
		try {
			content = JSON.parse(bestEvent.event.content);
		} catch {
			return {
				ok: false,
				error: "Profile event has invalid JSON content",
				relaysQueried,
				sourceRelay: bestEvent.relay
			};
		}
		return {
			ok: true,
			profile: sanitizeProfileUrls(contentToProfile(content)),
			event: {
				id: bestEvent.event.id,
				pubkey: bestEvent.event.pubkey,
				created_at: bestEvent.event.created_at
			},
			relaysQueried,
			sourceRelay: bestEvent.relay
		};
	} finally {
		pool.close(relays);
	}
}
/**
* Merge imported profile with local profile.
*
* Strategy:
* - For each field, prefer local if set, otherwise use imported
* - This preserves user customizations while filling in missing data
*/
function mergeProfiles(local, imported) {
	if (!imported) return local ?? {};
	if (!local) return imported;
	return {
		name: local.name ?? imported.name,
		displayName: local.displayName ?? imported.displayName,
		about: local.about ?? imported.about,
		picture: local.picture ?? imported.picture,
		banner: local.banner ?? imported.banner,
		website: local.website ?? imported.website,
		nip05: local.nip05 ?? imported.nip05,
		lud16: local.lud16 ?? imported.lud16
	};
}
//#endregion
//#region extensions/nostr/src/nostr-profile-http.ts
const profileRateLimiter = createFixedWindowRateLimiter({
	windowMs: 6e4,
	maxRequests: 5,
	maxTrackedKeys: 2048
});
function checkRateLimit(accountId) {
	return !profileRateLimiter.isRateLimited(accountId);
}
const publishLocks = /* @__PURE__ */ new Map();
async function withPublishLock(accountId, fn) {
	const prev = publishLocks.get(accountId) ?? Promise.resolve();
	let resolve;
	const next = new Promise((r) => {
		resolve = r;
	});
	publishLocks.set(accountId, next);
	await prev.catch(() => {});
	try {
		return await fn();
	} finally {
		resolve();
		if (publishLocks.get(accountId) === next) publishLocks.delete(accountId);
	}
}
function validateUrlSafety(urlStr) {
	try {
		const url = new URL(urlStr);
		if (url.protocol !== "https:") return {
			ok: false,
			error: "URL must use https:// protocol"
		};
		if (isBlockedHostnameOrIp(url.hostname.toLowerCase())) return {
			ok: false,
			error: "URL must not point to private/internal addresses"
		};
		return { ok: true };
	} catch {
		return {
			ok: false,
			error: "Invalid URL format"
		};
	}
}
const nip05FormatSchema = z.string().regex(/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, "Invalid NIP-05 format (user@domain.com)").optional();
const lud16FormatSchema = z.string().regex(/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, "Invalid Lightning address format").optional();
const ProfileUpdateSchema = NostrProfileSchema.extend({
	nip05: nip05FormatSchema,
	lud16: lud16FormatSchema
});
function sendJson(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}
async function readJsonBody(req, maxBytes = 64 * 1024, timeoutMs = 3e4) {
	const result = await readJsonBodyWithLimit(req, {
		maxBytes,
		timeoutMs,
		emptyObjectOnEmpty: true
	});
	if (result.ok) return result.value;
	if (result.code === "PAYLOAD_TOO_LARGE") throw new Error("Request body too large");
	if (result.code === "REQUEST_BODY_TIMEOUT") throw new Error(requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
	if (result.code === "CONNECTION_CLOSED") throw new Error(requestBodyErrorToText("CONNECTION_CLOSED"));
	throw new Error(result.code === "INVALID_JSON" ? "Invalid JSON" : result.error);
}
function parseAccountIdFromPath(pathname) {
	return pathname.match(/^\/api\/channels\/nostr\/([^/]+)\/profile/)?.[1] ?? null;
}
function isLoopbackRemoteAddress(remoteAddress) {
	if (!remoteAddress) return false;
	const ipLower = remoteAddress.toLowerCase().replace(/^\[|\]$/g, "");
	if (ipLower === "::1") return true;
	if (ipLower === "127.0.0.1" || ipLower.startsWith("127.")) return true;
	const v4Mapped = ipLower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (v4Mapped) return isLoopbackRemoteAddress(v4Mapped[1]);
	return false;
}
function isLoopbackOriginLike(value) {
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
	} catch {
		return false;
	}
}
function firstHeaderValue(value) {
	if (Array.isArray(value)) return value[0];
	return typeof value === "string" ? value : void 0;
}
function normalizeIpCandidate(raw) {
	const unquoted = raw.trim().replace(/^"|"$/g, "");
	const bracketedWithOptionalPort = unquoted.match(/^\[([^[\]]+)\](?::\d+)?$/);
	if (bracketedWithOptionalPort) return bracketedWithOptionalPort[1] ?? "";
	const ipv4WithPort = unquoted.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
	if (ipv4WithPort) return ipv4WithPort[1] ?? "";
	return unquoted;
}
function hasNonLoopbackForwardedClient(req) {
	const forwardedFor = firstHeaderValue(req.headers["x-forwarded-for"]);
	if (forwardedFor) for (const hop of forwardedFor.split(",")) {
		const candidate = normalizeIpCandidate(hop);
		if (!candidate) continue;
		if (!isLoopbackRemoteAddress(candidate)) return true;
	}
	const realIp = firstHeaderValue(req.headers["x-real-ip"]);
	if (realIp) {
		const candidate = normalizeIpCandidate(realIp);
		if (candidate && !isLoopbackRemoteAddress(candidate)) return true;
	}
	return false;
}
function enforceLoopbackMutationGuards(ctx, req, res) {
	const remoteAddress = req.socket.remoteAddress;
	if (!isLoopbackRemoteAddress(remoteAddress)) {
		ctx.log?.warn?.(`Rejected mutation from non-loopback remoteAddress=${String(remoteAddress)}`);
		sendJson(res, 403, {
			ok: false,
			error: "Forbidden"
		});
		return false;
	}
	if (hasNonLoopbackForwardedClient(req)) {
		ctx.log?.warn?.("Rejected mutation with non-loopback forwarded client headers");
		sendJson(res, 403, {
			ok: false,
			error: "Forbidden"
		});
		return false;
	}
	if (firstHeaderValue(req.headers["sec-fetch-site"])?.trim().toLowerCase() === "cross-site") {
		ctx.log?.warn?.("Rejected mutation with cross-site sec-fetch-site header");
		sendJson(res, 403, {
			ok: false,
			error: "Forbidden"
		});
		return false;
	}
	const origin = firstHeaderValue(req.headers.origin);
	if (typeof origin === "string" && !isLoopbackOriginLike(origin)) {
		ctx.log?.warn?.(`Rejected mutation with non-loopback origin=${origin}`);
		sendJson(res, 403, {
			ok: false,
			error: "Forbidden"
		});
		return false;
	}
	const referer = firstHeaderValue(req.headers.referer ?? req.headers.referrer);
	if (typeof referer === "string" && !isLoopbackOriginLike(referer)) {
		ctx.log?.warn?.(`Rejected mutation with non-loopback referer=${referer}`);
		sendJson(res, 403, {
			ok: false,
			error: "Forbidden"
		});
		return false;
	}
	return true;
}
function createNostrProfileHttpHandler(ctx) {
	return async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (!url.pathname.startsWith("/api/channels/nostr/")) return false;
		const accountId = parseAccountIdFromPath(url.pathname);
		if (!accountId) return false;
		const isImport = url.pathname.endsWith("/profile/import");
		if (!(url.pathname.endsWith("/profile") || isImport)) return false;
		try {
			if (req.method === "GET" && !isImport) return await handleGetProfile(accountId, ctx, res);
			if (req.method === "PUT" && !isImport) return await handleUpdateProfile(accountId, ctx, req, res);
			if (req.method === "POST" && isImport) return await handleImportProfile(accountId, ctx, req, res);
			sendJson(res, 405, {
				ok: false,
				error: "Method not allowed"
			});
			return true;
		} catch (err) {
			ctx.log?.error(`Profile HTTP error: ${String(err)}`);
			sendJson(res, 500, {
				ok: false,
				error: "Internal server error"
			});
			return true;
		}
	};
}
async function handleGetProfile(accountId, ctx, res) {
	const configProfile = ctx.getConfigProfile(accountId);
	const publishState = await getNostrProfileState(accountId);
	sendJson(res, 200, {
		ok: true,
		profile: configProfile ?? null,
		publishState: publishState ?? null
	});
	return true;
}
async function handleUpdateProfile(accountId, ctx, req, res) {
	if (!enforceLoopbackMutationGuards(ctx, req, res)) return true;
	if (!checkRateLimit(accountId)) {
		sendJson(res, 429, {
			ok: false,
			error: "Rate limit exceeded (5 requests/minute)"
		});
		return true;
	}
	let body;
	try {
		body = await readJsonBody(req);
	} catch (err) {
		sendJson(res, 400, {
			ok: false,
			error: String(err)
		});
		return true;
	}
	const parseResult = ProfileUpdateSchema.safeParse(body);
	if (!parseResult.success) {
		sendJson(res, 400, {
			ok: false,
			error: "Validation failed",
			details: parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
		});
		return true;
	}
	const profile = parseResult.data;
	if (profile.picture) {
		const pictureCheck = validateUrlSafety(profile.picture);
		if (!pictureCheck.ok) {
			sendJson(res, 400, {
				ok: false,
				error: `picture: ${pictureCheck.error}`
			});
			return true;
		}
	}
	if (profile.banner) {
		const bannerCheck = validateUrlSafety(profile.banner);
		if (!bannerCheck.ok) {
			sendJson(res, 400, {
				ok: false,
				error: `banner: ${bannerCheck.error}`
			});
			return true;
		}
	}
	if (profile.website) {
		const websiteCheck = validateUrlSafety(profile.website);
		if (!websiteCheck.ok) {
			sendJson(res, 400, {
				ok: false,
				error: `website: ${websiteCheck.error}`
			});
			return true;
		}
	}
	const mergedProfile = {
		...ctx.getConfigProfile(accountId) ?? {},
		...profile
	};
	try {
		const result = await withPublishLock(accountId, async () => {
			return await publishNostrProfile(accountId, mergedProfile);
		});
		if (result.successes.length > 0) {
			await ctx.updateConfigProfile(accountId, mergedProfile);
			ctx.log?.info(`[${accountId}] Profile published to ${result.successes.length} relay(s)`);
		} else ctx.log?.warn(`[${accountId}] Profile publish failed on all relays`);
		sendJson(res, 200, {
			ok: true,
			eventId: result.eventId,
			createdAt: result.createdAt,
			successes: result.successes,
			failures: result.failures,
			persisted: result.successes.length > 0
		});
	} catch (err) {
		ctx.log?.error(`[${accountId}] Profile publish error: ${String(err)}`);
		sendJson(res, 500, {
			ok: false,
			error: `Publish failed: ${String(err)}`
		});
	}
	return true;
}
async function handleImportProfile(accountId, ctx, req, res) {
	if (!enforceLoopbackMutationGuards(ctx, req, res)) return true;
	const accountInfo = ctx.getAccountInfo(accountId);
	if (!accountInfo) {
		sendJson(res, 404, {
			ok: false,
			error: `Account not found: ${accountId}`
		});
		return true;
	}
	const { pubkey, relays } = accountInfo;
	if (!pubkey) {
		sendJson(res, 400, {
			ok: false,
			error: "Account has no public key configured"
		});
		return true;
	}
	let autoMerge = false;
	try {
		const body = await readJsonBody(req);
		if (typeof body === "object" && body !== null) autoMerge = body.autoMerge === true;
	} catch {}
	ctx.log?.info(`[${accountId}] Importing profile for ${pubkey.slice(0, 8)}...`);
	const result = await importProfileFromRelays({
		pubkey,
		relays,
		timeoutMs: 1e4
	});
	if (!result.ok) {
		sendJson(res, 200, {
			ok: false,
			error: result.error,
			relaysQueried: result.relaysQueried
		});
		return true;
	}
	if (autoMerge && result.profile) {
		const merged = mergeProfiles(ctx.getConfigProfile(accountId), result.profile);
		await ctx.updateConfigProfile(accountId, merged);
		ctx.log?.info(`[${accountId}] Profile imported and merged`);
		sendJson(res, 200, {
			ok: true,
			imported: result.profile,
			merged,
			saved: true,
			event: result.event,
			sourceRelay: result.sourceRelay,
			relaysQueried: result.relaysQueried
		});
		return true;
	}
	sendJson(res, 200, {
		ok: true,
		imported: result.profile,
		saved: false,
		event: result.event,
		sourceRelay: result.sourceRelay,
		relaysQueried: result.relaysQueried
	});
	return true;
}
//#endregion
//#region extensions/nostr/index.ts
const plugin = {
	id: "nostr",
	name: "Nostr",
	description: "Nostr DM channel plugin via NIP-04",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		setNostrRuntime(api.runtime);
		api.registerChannel({ plugin: nostrPlugin });
		if (api.registrationMode !== "full") return;
		const httpHandler = createNostrProfileHttpHandler({
			getConfigProfile: (accountId) => {
				return resolveNostrAccount({
					cfg: getNostrRuntime().config.loadConfig(),
					accountId
				}).profile;
			},
			updateConfigProfile: async (accountId, profile) => {
				const runtime = getNostrRuntime();
				const cfg = runtime.config.loadConfig();
				const channels = cfg.channels ?? {};
				const updatedNostrConfig = {
					...channels.nostr ?? {},
					profile
				};
				const updatedChannels = {
					...channels,
					nostr: updatedNostrConfig
				};
				await runtime.config.writeConfigFile({
					...cfg,
					channels: updatedChannels
				});
			},
			getAccountInfo: (accountId) => {
				const account = resolveNostrAccount({
					cfg: getNostrRuntime().config.loadConfig(),
					accountId
				});
				if (!account.configured || !account.publicKey) return null;
				return {
					pubkey: account.publicKey,
					relays: account.relays
				};
			},
			log: api.logger
		});
		api.registerHttpRoute({
			path: "/api/channels/nostr",
			auth: "gateway",
			match: "prefix",
			handler: httpHandler
		});
	}
};
//#endregion
export { plugin as default };
