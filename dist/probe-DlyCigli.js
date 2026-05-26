import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as detectBinary } from "./detect-binary-C4HxcF68.js";
import "./setup-DPvocg6M.js";
import "./runtime-config-snapshot-BBsNBtE3.js";
import "./process-runtime-Bice6fS7.js";
import { t as createIMessageRpcClient } from "./client-BcN4Qxqo.js";
import { r as setCachedIMessagePrivateApiStatus, t as getCachedIMessagePrivateApiStatus } from "./private-api-status-hXzk6Zzf.js";
import path from "node:path";
//#region extensions/imessage/src/probe.ts
const RPC_SUPPORT_CACHE_TTL_MS = 300 * 1e3;
const PRIVATE_API_NEGATIVE_TTL_MS = 10 * 1e3;
const rpcSupportCache = /* @__PURE__ */ new Map();
function isDefaultLocalIMessageCliPath(cliPath) {
	const trimmed = cliPath.trim();
	return trimmed === "imsg" || !trimmed.includes("/") && path.basename(trimmed) === "imsg";
}
function resolveIMessageNonMacHostError(cliPath, platform = process.platform) {
	if (platform === "darwin" || !isDefaultLocalIMessageCliPath(cliPath)) return;
	return "iMessage via the default imsg CLI must run on macOS. Run OpenClaw on the signed-in Messages Mac, or set channels.imessage.cliPath to an SSH wrapper that runs imsg on that Mac.";
}
async function probeRpcSupport(cliPath, timeoutMs) {
	const cached = rpcSupportCache.get(cliPath);
	if (cached && cached.expiresAt > Date.now()) return cached.result;
	try {
		const result = await runCommandWithTimeout([
			cliPath,
			"rpc",
			"--help"
		], { timeoutMs });
		const combined = `${result.stdout}\n${result.stderr}`.trim();
		const normalized = normalizeLowercaseStringOrEmpty(combined);
		if (normalized.includes("unknown command") && normalized.includes("rpc")) {
			const fatal = {
				supported: false,
				fatal: true,
				error: "imsg CLI does not support the \"rpc\" subcommand (update imsg)"
			};
			rpcSupportCache.set(cliPath, {
				result: fatal,
				expiresAt: Date.now() + RPC_SUPPORT_CACHE_TTL_MS
			});
			return fatal;
		}
		if (result.code === 0) {
			const supported = { supported: true };
			rpcSupportCache.set(cliPath, {
				result: supported,
				expiresAt: Date.now() + RPC_SUPPORT_CACHE_TTL_MS
			});
			return supported;
		}
		return {
			supported: false,
			error: combined || `imsg rpc --help failed (code ${String(result.code ?? "unknown")})`
		};
	} catch (err) {
		return {
			supported: false,
			error: String(err)
		};
	}
}
function parseStatusPayload(stdout) {
	const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (const line of lines.toReversed()) try {
		const value = JSON.parse(line);
		if (value && typeof value === "object" && !Array.isArray(value)) return { payload: value };
	} catch {}
	return {
		payload: null,
		firstLineSnippet: lines[0]?.slice(0, 120)
	};
}
function selectorsFromPayload(payload) {
	const raw = payload.selectors;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const selectors = {};
	for (const [key, value] of Object.entries(raw)) if (typeof value === "boolean") selectors[key] = value;
	return selectors;
}
function rpcMethodsFromPayload(payload) {
	const raw = payload.rpc_methods;
	if (!Array.isArray(raw)) return [];
	return raw.filter((entry) => typeof entry === "string");
}
async function probeSendRichSupportsAttachment(cliPath, timeoutMs) {
	try {
		const result = await runCommandWithTimeout([
			cliPath,
			"send-rich",
			"--help"
		], { timeoutMs });
		if (result.code !== 0) return false;
		const combined = `${result.stdout}\n${result.stderr}`;
		return /(?:^|\s)--file\b/m.test(combined);
	} catch {
		return false;
	}
}
async function probeIMessagePrivateApi(cliPath, timeoutMs, options = {}) {
	const key = cliPath.trim() || "imsg";
	if (!options.forceRefresh) {
		const cached = getCachedIMessagePrivateApiStatus(key);
		if (cached) return cached;
	}
	try {
		const result = await runCommandWithTimeout([
			key,
			"status",
			"--json"
		], { timeoutMs });
		const combined = `${result.stdout}\n${result.stderr}`.trim();
		const { payload, firstLineSnippet } = parseStatusPayload(result.stdout);
		const selectors = payload ? selectorsFromPayload(payload) : {};
		const rpcMethods = payload ? rpcMethodsFromPayload(payload) : [];
		const advancedFeatures = payload?.advanced_features === true;
		const v2Ready = payload?.v2_ready === true;
		const sendRichSupportsAttachment = await probeSendRichSupportsAttachment(key, timeoutMs);
		const status = {
			available: result.code === 0 && advancedFeatures && v2Ready,
			v2Ready,
			selectors,
			rpcMethods,
			cliCapabilities: { sendRichSupportsAttachment },
			...result.code === 0 ? !payload && firstLineSnippet ? { error: `imsg status --json returned no parseable JSONL (first line: "${firstLineSnippet}") — output schema may have changed` } : {} : { error: combined || `imsg status --json failed (code ${String(result.code)})` }
		};
		setCachedIMessagePrivateApiStatus(key, status, status.available ? 0 : Date.now() + PRIVATE_API_NEGATIVE_TTL_MS);
		return status;
	} catch (err) {
		const status = {
			available: false,
			v2Ready: false,
			selectors: {},
			rpcMethods: [],
			cliCapabilities: { sendRichSupportsAttachment: false },
			error: String(err)
		};
		setCachedIMessagePrivateApiStatus(key, status, Date.now() + PRIVATE_API_NEGATIVE_TTL_MS);
		return status;
	}
}
/**
* Probe iMessage RPC availability.
* @param timeoutMs - Explicit timeout in ms. If undefined, uses config or default.
* @param opts - Additional options (cliPath, dbPath, runtime).
*/
async function probeIMessage(timeoutMs, opts = {}) {
	const cfg = opts.cliPath || opts.dbPath ? void 0 : getRuntimeConfig();
	const cliPath = opts.cliPath?.trim() || cfg?.channels?.imessage?.cliPath?.trim() || "imsg";
	const dbPath = opts.dbPath?.trim() || cfg?.channels?.imessage?.dbPath?.trim();
	const effectiveTimeout = timeoutMs ?? cfg?.channels?.imessage?.probeTimeoutMs ?? 1e4;
	const nonMacHostError = resolveIMessageNonMacHostError(cliPath, opts.platform);
	if (nonMacHostError) return {
		ok: false,
		fatal: true,
		error: nonMacHostError
	};
	if (!await detectBinary(cliPath)) return {
		ok: false,
		error: `imsg not found (${cliPath})`
	};
	const rpcSupport = await probeRpcSupport(cliPath, effectiveTimeout);
	if (!rpcSupport.supported) return {
		ok: false,
		error: rpcSupport.error ?? "imsg rpc unavailable",
		fatal: rpcSupport.fatal
	};
	const privateApi = await probeIMessagePrivateApi(cliPath, effectiveTimeout);
	const client = await createIMessageRpcClient({
		cliPath,
		dbPath,
		runtime: opts.runtime
	});
	try {
		await client.request("chats.list", { limit: 1 }, { timeoutMs: effectiveTimeout });
		return {
			ok: true,
			privateApi
		};
	} catch (err) {
		return {
			ok: false,
			error: String(err),
			privateApi
		};
	} finally {
		await client.stop();
	}
}
//#endregion
export { probeIMessagePrivateApi as n, resolveIMessageNonMacHostError as r, probeIMessage as t };
