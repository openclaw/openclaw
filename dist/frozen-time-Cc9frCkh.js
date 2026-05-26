import { a as normalizeLowercaseStringOrEmpty, r as lowercasePreservingWhitespace, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { X as loadShellEnvFallback } from "./io-DoswVvYe.js";
import { t as getProviderEnvVars } from "./provider-env-vars-HpAfBQBJ.js";
import { i as drainFileLockStateForTest } from "./file-lock-D5OTq3qW.js";
import "./file-lock-BSRN56ID.js";
import { u as clearSessionStoreCaches } from "./store-load-z4thf6ld.js";
import { m as drainSessionStoreWriterQueuesForTest } from "./store-BmtchQvp.js";
import { o as drainSessionWriteLockStateForTest } from "./session-write-lock-_a5O1H8L.js";
import { S as ssrf_exports, _ as resolvePinnedHostnameWithPolicy, g as resolvePinnedHostname } from "./ssrf-DdDeGa5L.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import "@earendil-works/pi-ai";
import { afterEach, beforeEach, vi } from "vitest";
//#region src/test-utils/fetch-mock.ts
function withFetchPreconnect(fn) {
	return Object.assign(fn, {
		preconnect: (_url, _options) => {},
		__openclawAcceptsDispatcher: true
	});
}
//#endregion
//#region src/media-understanding/audio.test-helpers.ts
function resolveRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}
function installPinnedHostnameTestHooks() {
	const resolvePinnedHostname$2 = resolvePinnedHostname;
	const resolvePinnedHostnameWithPolicy$2 = resolvePinnedHostnameWithPolicy;
	const lookupMock = vi.fn();
	let resolvePinnedHostnameSpy = null;
	let resolvePinnedHostnameWithPolicySpy = null;
	beforeEach(() => {
		lookupMock.mockResolvedValue([{
			address: "93.184.216.34",
			family: 4
		}]);
		resolvePinnedHostnameSpy = vi.spyOn(ssrf_exports, "resolvePinnedHostname").mockImplementation((hostname) => resolvePinnedHostname$2(hostname, lookupMock));
		resolvePinnedHostnameWithPolicySpy = vi.spyOn(ssrf_exports, "resolvePinnedHostnameWithPolicy").mockImplementation((hostname, params) => resolvePinnedHostnameWithPolicy$2(hostname, {
			...params,
			lookupFn: lookupMock
		}));
	});
	afterEach(() => {
		lookupMock.mockReset();
		resolvePinnedHostnameSpy?.mockRestore();
		resolvePinnedHostnameWithPolicySpy?.mockRestore();
		resolvePinnedHostnameSpy = null;
		resolvePinnedHostnameWithPolicySpy = null;
	});
}
function createAuthCaptureJsonFetch(responseBody) {
	let seenAuth = null;
	return {
		fetchFn: withFetchPreconnect(async (_input, init) => {
			seenAuth = new Headers(init?.headers).get("authorization");
			return new Response(JSON.stringify(responseBody), {
				status: 200,
				headers: { "content-type": "application/json" }
			});
		}),
		getAuthHeader: () => seenAuth
	};
}
function createRequestCaptureJsonFetch(responseBody) {
	let seenUrl = null;
	let seenInit;
	return {
		fetchFn: withFetchPreconnect(async (input, init) => {
			seenUrl = resolveRequestUrl(input);
			seenInit = init;
			return new Response(JSON.stringify(responseBody), {
				status: 200,
				headers: { "content-type": "application/json" }
			});
		}),
		getRequest: () => ({
			url: seenUrl,
			init: seenInit
		})
	};
}
//#endregion
//#region src/agents/live-test-helpers.ts
const LIVE_OK_PROMPT = "Reply with the word ok.";
function isLiveTestEnabled(extraEnvVars = [], env = process.env) {
	return [
		...extraEnvVars,
		"LIVE",
		"OPENCLAW_LIVE_TEST"
	].some((name) => isTruthyEnvValue(env[name]));
}
function isLiveProfileKeyModeEnabled(env = process.env) {
	return isTruthyEnvValue(env.OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS);
}
function createSingleUserPromptMessage(content = LIVE_OK_PROMPT) {
	return [{
		role: "user",
		content,
		timestamp: Date.now()
	}];
}
function extractNonEmptyAssistantText(content) {
	return content.filter((block) => block.type === "text").map((block) => block.text?.trim() ?? "").filter(Boolean).join(" ");
}
//#endregion
//#region src/test-utils/generation-live-test-helpers.ts
function maybeLoadShellEnvForGenerationProviders(providerIds) {
	const expectedKeys = [...new Set(providerIds.flatMap((providerId) => getProviderEnvVars(providerId)))];
	if (expectedKeys.length === 0) return;
	loadShellEnvFallback({
		enabled: true,
		env: process.env,
		expectedKeys,
		logger: { warn: (message) => console.warn(message) }
	});
}
//#endregion
//#region src/media-generation/live-test-helpers.ts
function redactLiveApiKey(value) {
	const trimmed = value?.trim();
	if (!trimmed) return "none";
	if (trimmed.length <= 12) return trimmed;
	return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}
function parseLiveCsvFilter(raw, options = {}) {
	const trimmed = raw?.trim();
	if (!trimmed || trimmed === "all") return null;
	const values = trimmed.split(",").map((entry) => options.lowercase === false ? entry.trim() : normalizeOptionalLowercaseString(entry)).filter((entry) => Boolean(entry));
	return values.length > 0 ? new Set(values) : null;
}
function parseProviderModelMap(raw) {
	const entries = /* @__PURE__ */ new Map();
	for (const token of raw?.split(",") ?? []) {
		const trimmed = token.trim();
		if (!trimmed) continue;
		const slash = trimmed.indexOf("/");
		if (slash <= 0 || slash === trimmed.length - 1) continue;
		const providerId = normalizeOptionalLowercaseString(trimmed.slice(0, slash));
		if (!providerId) continue;
		entries.set(providerId, trimmed);
	}
	return entries;
}
function resolveConfiguredLiveProviderModels(configured) {
	const resolved = /* @__PURE__ */ new Map();
	const add = (value) => {
		const trimmed = value?.trim();
		if (!trimmed) return;
		const slash = trimmed.indexOf("/");
		if (slash <= 0 || slash === trimmed.length - 1) return;
		const providerId = normalizeOptionalLowercaseString(trimmed.slice(0, slash));
		if (!providerId) return;
		resolved.set(providerId, trimmed);
	};
	if (typeof configured === "string") {
		add(configured);
		return resolved;
	}
	add(configured?.primary);
	for (const fallback of configured?.fallbacks ?? []) add(fallback);
	return resolved;
}
function resolveLiveAuthStore(params) {
	if (params.requireProfileKeys || !params.hasLiveKeys) return;
	return {
		version: 1,
		profiles: {}
	};
}
//#endregion
//#region src/music-generation/live-test-helpers.ts
const DEFAULT_LIVE_MUSIC_MODELS = {
	fal: "fal/fal-ai/minimax-music/v2.6",
	google: "google/lyria-3-clip-preview",
	minimax: "minimax/music-2.6",
	openrouter: "openrouter/google/lyria-3-pro-preview"
};
function resolveConfiguredLiveMusicModels(cfg) {
	return resolveConfiguredLiveProviderModels(cfg.agents?.defaults?.musicGenerationModel);
}
function resolveLiveMusicAuthStore(params) {
	return resolveLiveAuthStore(params);
}
//#endregion
//#region src/video-generation/live-test-helpers.ts
const DEFAULT_LIVE_VIDEO_MODELS = {
	alibaba: "alibaba/wan2.6-t2v",
	byteplus: "byteplus/seedance-1-0-lite-t2v-250428",
	deepinfra: "deepinfra/Pixverse/Pixverse-T2V",
	fal: "fal/fal-ai/minimax/video-01-live",
	google: "google/veo-3.1-fast-generate-preview",
	minimax: "minimax/MiniMax-Hailuo-2.3",
	openai: "openai/sora-2",
	openrouter: "openrouter/google/veo-3.1-fast",
	qwen: "qwen/wan2.6-t2v",
	runway: "runway/gen4.5",
	together: "together/Wan-AI/Wan2.2-T2V-A14B",
	vydra: "vydra/veo3",
	xai: "xai/grok-imagine-video"
};
const REMOTE_URL_VIDEO_TO_VIDEO_PROVIDERS = new Set([
	"alibaba",
	"google",
	"openai",
	"qwen",
	"xai"
]);
const BUFFER_BACKED_IMAGE_TO_VIDEO_UNSUPPORTED_PROVIDERS = new Set(["vydra"]);
function resolveLiveVideoResolution(params) {
	const providerId = normalizeLowercaseStringOrEmpty(params.providerId);
	if (providerId === "minimax") return "768P";
	if (providerId === "openrouter") return "720P";
	return "480P";
}
function resolveConfiguredLiveVideoModels(cfg) {
	return resolveConfiguredLiveProviderModels(cfg.agents?.defaults?.videoGenerationModel);
}
function canRunBufferBackedVideoToVideoLiveLane(params) {
	const providerId = normalizeLowercaseStringOrEmpty(params.providerId);
	if (REMOTE_URL_VIDEO_TO_VIDEO_PROVIDERS.has(providerId)) return false;
	if (providerId !== "runway") {
		if (providerId === "fal") return params.modelRef.includes("reference-to-video");
		return true;
	}
	const slash = params.modelRef.indexOf("/");
	return (slash <= 0 || slash === params.modelRef.length - 1 ? params.modelRef.trim() : params.modelRef.slice(slash + 1).trim()) === "gen4_aleph";
}
function canRunBufferBackedImageToVideoLiveLane(params) {
	const providerId = normalizeLowercaseStringOrEmpty(params.providerId);
	if (BUFFER_BACKED_IMAGE_TO_VIDEO_UNSUPPORTED_PROVIDERS.has(providerId)) return false;
	return true;
}
function resolveLiveVideoAuthStore(params) {
	return resolveLiveAuthStore(params);
}
//#endregion
//#region src/test-helpers/http.ts
function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" }
	});
}
function requestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}
function requestBodyText(body) {
	return typeof body === "string" ? body : "{}";
}
//#endregion
//#region src/test-helpers/ssrf.ts
function mockPinnedHostnameResolution(addresses = ["93.184.216.34"]) {
	const resolvePinnedHostname$1 = resolvePinnedHostname;
	const resolvePinnedHostnameWithPolicy$1 = resolvePinnedHostnameWithPolicy;
	const lookupFn = (async (hostname, options) => {
		const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.$/, "");
		const resolved = addresses.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
			hostname: normalized
		}));
		return options?.all === true ? resolved : resolved[0];
	});
	const pinned = vi.spyOn(ssrf_exports, "resolvePinnedHostname").mockImplementation((hostname) => resolvePinnedHostname$1(hostname, lookupFn));
	const pinnedWithPolicy = vi.spyOn(ssrf_exports, "resolvePinnedHostnameWithPolicy").mockImplementation((hostname, params) => resolvePinnedHostnameWithPolicy$1(hostname, {
		...params,
		lookupFn
	}));
	return { mockRestore: () => {
		pinned.mockRestore();
		pinnedWithPolicy.mockRestore();
	} };
}
//#endregion
//#region src/test-helpers/windows-cmd-shim.ts
async function createWindowsCmdShimFixture(params) {
	await fs.mkdir(path.dirname(params.scriptPath), { recursive: true });
	await fs.mkdir(path.dirname(params.shimPath), { recursive: true });
	await fs.writeFile(params.scriptPath, "module.exports = {};\n", "utf8");
	await fs.writeFile(params.shimPath, `@echo off\r\n${params.shimLine}\r\n`, "utf8");
}
//#endregion
//#region src/test-utils/env.ts
function captureEnv(keys) {
	const snapshot = /* @__PURE__ */ new Map();
	for (const key of keys) snapshot.set(key, process.env[key]);
	return { restore() {
		for (const [key, value] of snapshot) if (value === void 0) delete process.env[key];
		else process.env[key] = value;
	} };
}
function applyEnvValues(env) {
	for (const [key, value] of Object.entries(env)) if (value === void 0) delete process.env[key];
	else process.env[key] = value;
}
function withEnv(env, fn) {
	const snapshot = captureEnv(Object.keys(env));
	try {
		applyEnvValues(env);
		return fn();
	} finally {
		snapshot.restore();
	}
}
async function withEnvAsync(env, fn) {
	const snapshot = captureEnv(Object.keys(env));
	try {
		applyEnvValues(env);
		return await fn();
	} finally {
		snapshot.restore();
	}
}
async function cleanupSessionStateForTest() {
	await drainSessionStoreWriterQueuesForTest();
	clearSessionStoreCaches();
	await drainFileLockStateForTest();
	await drainSessionWriteLockStateForTest();
}
//#endregion
//#region src/test-helpers/state-dir-env.ts
function snapshotStateDirEnv() {
	return captureEnv(["OPENCLAW_STATE_DIR"]);
}
function restoreStateDirEnv(snapshot) {
	snapshot.restore();
}
function setStateDirEnv(stateDir) {
	process.env.OPENCLAW_STATE_DIR = stateDir;
}
async function withStateDirEnv(prefix, fn) {
	const snapshot = snapshotStateDirEnv();
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const stateDir = path.join(tempRoot, "state");
	await fs.mkdir(stateDir, { recursive: true });
	setStateDirEnv(stateDir);
	try {
		return await fn({
			tempRoot,
			stateDir
		});
	} finally {
		await cleanupSessionStateForTest().catch(() => void 0);
		restoreStateDirEnv(snapshot);
		await fs.rm(tempRoot, {
			recursive: true,
			force: true
		});
	}
}
//#endregion
//#region src/test-utils/mock-http-response.ts
function createMockServerResponse() {
	const headers = {};
	const res = {
		headersSent: false,
		statusCode: 200,
		setHeader: (key, value) => {
			headers[lowercasePreservingWhitespace(key)] = value;
			return res;
		},
		getHeader: (key) => headers[lowercasePreservingWhitespace(key)],
		end: (body) => {
			res.headersSent = true;
			res.body = body;
			return res;
		}
	};
	return res;
}
//#endregion
//#region src/test-utils/temp-home.ts
const HOME_ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"OPENCLAW_STATE_DIR"
];
const prefixRoots = /* @__PURE__ */ new Map();
const pendingPrefixRoots = /* @__PURE__ */ new Map();
let nextHomeIndex = 0;
async function ensurePrefixRoot(prefix) {
	const cached = prefixRoots.get(prefix);
	if (cached) return cached;
	const pending = pendingPrefixRoots.get(prefix);
	if (pending) return await pending;
	const create = fs.mkdtemp(path.join(os.tmpdir(), prefix));
	pendingPrefixRoots.set(prefix, create);
	try {
		const root = await create;
		prefixRoots.set(prefix, root);
		return root;
	} finally {
		pendingPrefixRoots.delete(prefix);
	}
}
async function createTempHomeEnv(prefix) {
	const prefixRoot = await ensurePrefixRoot(prefix);
	const home = path.join(prefixRoot, `home-${String(nextHomeIndex)}`);
	nextHomeIndex += 1;
	await fs.rm(home, {
		recursive: true,
		force: true
	});
	await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
	const snapshot = captureEnv([...HOME_ENV_KEYS]);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
	if (process.platform === "win32") {
		const match = home.match(/^([A-Za-z]:)(.*)$/);
		if (match) {
			process.env.HOMEDRIVE = match[1];
			process.env.HOMEPATH = match[2] || "\\";
		}
	}
	return {
		home,
		restore: async () => {
			await cleanupSessionStateForTest().catch(() => void 0);
			snapshot.restore();
			await fs.rm(home, {
				recursive: true,
				force: true
			});
		}
	};
}
//#endregion
//#region src/test-utils/temp-dir.ts
async function withTempDir(prefix, run) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		return await run(dir);
	} finally {
		await fs.rm(dir, {
			recursive: true,
			force: true
		});
	}
}
//#endregion
//#region src/test-utils/provider-usage-fetch.ts
function makeResponse(status, body) {
	const payload = typeof body === "string" ? body : JSON.stringify(body);
	return new Response(payload, {
		status,
		headers: typeof body === "string" ? void 0 : { "Content-Type": "application/json" }
	});
}
function toRequestUrl(input) {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
function createProviderUsageFetch(handler) {
	return withFetchPreconnect(vi.fn(async (input, init) => handler(toRequestUrl(input), init)));
}
//#endregion
//#region src/test-utils/frozen-time.ts
function useFrozenTime(at) {
	vi.useFakeTimers();
	vi.setSystemTime(at);
}
function useRealTime() {
	vi.useRealTimers();
}
//#endregion
export { maybeLoadShellEnvForGenerationProviders as A, resolveLiveVideoResolution as C, parseLiveCsvFilter as D, resolveLiveMusicAuthStore as E, createAuthCaptureJsonFetch as F, createRequestCaptureJsonFetch as I, installPinnedHostnameTestHooks as L, extractNonEmptyAssistantText as M, isLiveProfileKeyModeEnabled as N, parseProviderModelMap as O, isLiveTestEnabled as P, withFetchPreconnect as R, resolveLiveVideoAuthStore as S, resolveConfiguredLiveMusicModels as T, requestUrl as _, withTempDir as a, canRunBufferBackedVideoToVideoLiveLane as b, withStateDirEnv as c, withEnv as d, withEnvAsync as f, requestBodyText as g, jsonResponse as h, makeResponse as i, createSingleUserPromptMessage as j, redactLiveApiKey as k, cleanupSessionStateForTest as l, mockPinnedHostnameResolution as m, useRealTime as n, createTempHomeEnv as o, createWindowsCmdShimFixture as p, createProviderUsageFetch as r, createMockServerResponse as s, useFrozenTime as t, captureEnv as u, DEFAULT_LIVE_VIDEO_MODELS as v, DEFAULT_LIVE_MUSIC_MODELS as w, resolveConfiguredLiveVideoModels as x, canRunBufferBackedImageToVideoLiveLane as y };
