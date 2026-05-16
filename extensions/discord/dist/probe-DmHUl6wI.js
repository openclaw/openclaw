import { t as normalizeDiscordToken } from "./token-BZtonk7d.js";
import { n as fetchDiscord, t as DiscordApiError } from "./api-DzNBVTto.js";
import { fetchWithTimeout } from "openclaw/plugin-sdk/text-runtime";
import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
//#region extensions/discord/src/probe.ts
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_APP_FLAG_GATEWAY_PRESENCE = 4096;
const DISCORD_APP_FLAG_GATEWAY_PRESENCE_LIMITED = 8192;
const DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS = 16384;
const DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED = 32768;
const DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 18;
const DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
async function fetchDiscordApplicationMe(token, timeoutMs, fetcher) {
	try {
		const normalized = normalizeDiscordToken(token, "channels.discord.token");
		if (!normalized) return;
		return await fetchDiscord("/oauth2/applications/@me", normalized, createDiscordTimeoutFetch(fetcher, timeoutMs), { retry: { attempts: 1 } });
	} catch {
		return;
	}
}
function createDiscordTimeoutFetch(fetcher, timeoutMs) {
	const fetchImpl = getResolvedFetch(fetcher);
	return ((input, init) => fetchWithTimeout(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init ?? {}, timeoutMs, fetchImpl));
}
function resolveDiscordPrivilegedIntentsFromFlags(flags) {
	const resolve = (enabledBit, limitedBit) => {
		if ((flags & enabledBit) !== 0) return "enabled";
		if ((flags & limitedBit) !== 0) return "limited";
		return "disabled";
	};
	return {
		presence: resolve(DISCORD_APP_FLAG_GATEWAY_PRESENCE, DISCORD_APP_FLAG_GATEWAY_PRESENCE_LIMITED),
		guildMembers: resolve(DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS, DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED),
		messageContent: resolve(DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT, DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED)
	};
}
async function fetchDiscordApplicationSummary(token, timeoutMs, fetcher = fetch) {
	const json = await fetchDiscordApplicationMe(token, timeoutMs, fetcher);
	if (!json) return;
	const flags = typeof json.flags === "number" && Number.isFinite(json.flags) ? json.flags : void 0;
	return {
		id: json.id ?? null,
		flags: flags ?? null,
		intents: typeof flags === "number" ? resolveDiscordPrivilegedIntentsFromFlags(flags) : void 0
	};
}
function getResolvedFetch(fetcher) {
	const fetchImpl = resolveFetch(fetcher);
	if (!fetchImpl) throw new Error("fetch is not available");
	return fetchImpl;
}
async function probeDiscord(token, timeoutMs, opts) {
	const started = Date.now();
	const fetcher = opts?.fetcher ?? fetch;
	const includeApplication = opts?.includeApplication === true;
	const normalized = normalizeDiscordToken(token, "channels.discord.token");
	const result = {
		ok: false,
		status: null,
		error: null,
		elapsedMs: 0
	};
	if (!normalized) return {
		...result,
		error: "missing token",
		elapsedMs: Date.now() - started
	};
	try {
		const res = await fetchWithTimeout(`${DISCORD_API_BASE}/users/@me`, { headers: { Authorization: `Bot ${normalized}` } }, timeoutMs, getResolvedFetch(fetcher));
		if (!res.ok) {
			result.status = res.status;
			result.error = `getMe failed (${res.status})`;
			return {
				...result,
				elapsedMs: Date.now() - started
			};
		}
		const json = await res.json();
		result.ok = true;
		result.bot = {
			id: json.id ?? null,
			username: json.username ?? null
		};
		if (includeApplication) result.application = await fetchDiscordApplicationSummary(normalized, timeoutMs, fetcher) ?? void 0;
		return {
			...result,
			elapsedMs: Date.now() - started
		};
	} catch (err) {
		return {
			...result,
			status: err instanceof Response ? err.status : result.status,
			error: formatErrorMessage(err),
			elapsedMs: Date.now() - started
		};
	}
}
/**
* Extract the application (bot user) ID from a Discord bot token by
* base64-decoding the first segment.  Discord tokens have the format:
*   base64(user_id) . timestamp . hmac
* The decoded first segment is the numeric snowflake ID as a plain string,
* so we keep it as a string to avoid precision loss for IDs that exceed
* Number.MAX_SAFE_INTEGER.
*/
function parseApplicationIdFromToken(token) {
	const normalized = normalizeDiscordToken(token, "channels.discord.token");
	if (!normalized) return;
	const firstDot = normalized.indexOf(".");
	if (firstDot <= 0) return;
	try {
		const decoded = Buffer.from(normalized.slice(0, firstDot), "base64").toString("utf-8");
		if (/^\d+$/.test(decoded)) return decoded;
		return;
	} catch {
		return;
	}
}
async function fetchDiscordApplicationId(token, timeoutMs, fetcher = fetch) {
	const normalized = normalizeDiscordToken(token, "channels.discord.token");
	if (!normalized) return;
	const parsedApplicationId = parseApplicationIdFromToken(token);
	if (parsedApplicationId) return parsedApplicationId;
	try {
		const json = await fetchDiscord("/oauth2/applications/@me", normalized, createDiscordTimeoutFetch(fetcher, timeoutMs));
		if (json?.id) return json.id;
		return;
	} catch (error) {
		if (error instanceof DiscordApiError) {
			if (error.status === 429) throw error;
			return;
		}
		return;
	}
}
//#endregion
export { resolveDiscordPrivilegedIntentsFromFlags as a, probeDiscord as i, fetchDiscordApplicationSummary as n, parseApplicationIdFromToken as r, fetchDiscordApplicationId as t };
