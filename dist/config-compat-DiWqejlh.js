import { c as isRecord } from "./utils-sBTEdeml.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region extensions/elevenlabs/config-compat.ts
const ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY";
const PROFILE_CANDIDATES = [
	".profile",
	".zprofile",
	".zshrc",
	".bashrc"
];
const LEGACY_TALK_FIELD_KEYS = [
	"voiceId",
	"voiceAliases",
	"modelId",
	"outputFormat",
	"apiKey"
];
const ELEVENLABS_TALK_PROVIDER_ID = "elevenlabs";
function getRecord(value) {
	return isRecord(value) ? value : null;
}
function ensureRecord(root, key) {
	const existing = getRecord(root[key]);
	if (existing) return existing;
	const next = {};
	root[key] = next;
	return next;
}
function isBlockedObjectKey(key) {
	return key === "__proto__" || key === "prototype" || key === "constructor";
}
function mergeMissing(target, source) {
	for (const [key, value] of Object.entries(source)) {
		if (value === void 0 || isBlockedObjectKey(key)) continue;
		const existing = target[key];
		if (existing === void 0) {
			target[key] = value;
			continue;
		}
		if (isRecord(existing) && isRecord(value)) mergeMissing(existing, value);
	}
}
function hasLegacyTalkFields(value) {
	const talk = getRecord(value);
	if (!talk) return false;
	return LEGACY_TALK_FIELD_KEYS.some((key) => Object.prototype.hasOwnProperty.call(talk, key));
}
function resolveTalkMigrationTargetProviderId(talk) {
	const explicitProvider = typeof talk.provider === "string" && talk.provider.trim() ? talk.provider.trim() : null;
	const providers = getRecord(talk.providers);
	if (explicitProvider) {
		if (isBlockedObjectKey(explicitProvider)) return null;
		return explicitProvider;
	}
	if (!providers) return ELEVENLABS_TALK_PROVIDER_ID;
	const providerIds = Object.keys(providers).filter((key) => !isBlockedObjectKey(key));
	if (providerIds.length === 0) return ELEVENLABS_TALK_PROVIDER_ID;
	if (providerIds.length === 1) return providerIds[0] ?? null;
	return null;
}
function migrateElevenLabsLegacyTalkConfig(raw) {
	if (!isRecord(raw)) return {
		config: raw,
		changes: []
	};
	const talk = getRecord(raw.talk);
	if (!talk || !hasLegacyTalkFields(talk)) return {
		config: raw,
		changes: []
	};
	const providerId = resolveTalkMigrationTargetProviderId(talk);
	if (!providerId) return {
		config: raw,
		changes: ["Skipped talk legacy field migration because talk.providers defines multiple providers and talk.provider is unset; move talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey under the intended provider manually."]
	};
	const nextRoot = structuredClone(raw);
	const nextTalk = ensureRecord(nextRoot, "talk");
	const providers = ensureRecord(nextTalk, "providers");
	const existingProvider = getRecord(providers[providerId]) ?? {};
	const migratedProvider = structuredClone(existingProvider);
	const legacyFields = {};
	const movedKeys = [];
	for (const key of LEGACY_TALK_FIELD_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(nextTalk, key)) continue;
		legacyFields[key] = nextTalk[key];
		delete nextTalk[key];
		movedKeys.push(key);
	}
	if (movedKeys.length === 0) return {
		config: raw,
		changes: []
	};
	mergeMissing(migratedProvider, legacyFields);
	providers[providerId] = migratedProvider;
	nextTalk.providers = providers;
	nextRoot.talk = nextTalk;
	return {
		config: nextRoot,
		changes: [`Moved talk legacy fields (${movedKeys.join(", ")}) → talk.providers.${providerId} (filled missing provider fields only).`]
	};
}
function readApiKeyFromProfile(deps = {}) {
	const fsImpl = deps.fs ?? fs;
	const osImpl = deps.os ?? os;
	const pathImpl = deps.path ?? path;
	const home = osImpl.homedir();
	for (const candidate of PROFILE_CANDIDATES) {
		const fullPath = pathImpl.join(home, candidate);
		if (!fsImpl.existsSync(fullPath)) continue;
		try {
			const value = fsImpl.readFileSync(fullPath, "utf-8").match(/(?:^|\n)\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^\n"']+)["']?/)?.[1]?.trim();
			if (value) return value;
		} catch {}
	}
	return null;
}
function resolveElevenLabsApiKeyWithProfileFallback(env = process.env, deps = {}) {
	const envValue = (env[ELEVENLABS_API_KEY_ENV] ?? "").trim();
	if (envValue) return envValue;
	return readApiKeyFromProfile(deps);
}
//#endregion
export { migrateElevenLabsLegacyTalkConfig as n, resolveElevenLabsApiKeyWithProfileFallback as r, ELEVENLABS_TALK_PROVIDER_ID as t };
