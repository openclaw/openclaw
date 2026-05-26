import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { t as CONFIG_PATH } from "./paths-Cw7f9XhU.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { c as isRecord$1 } from "./utils-sBTEdeml.js";
import { i as LEGACY_SECRETREF_ENV_MARKER_PREFIX, p as parseLegacySecretRefEnvMarker } from "./types.secrets-DwPik3M8.js";
import { r as normalizeProviderId$1 } from "./provider-id-zTW9Rdln.js";
import { n as normalizeAccountId, r as normalizeOptionalAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-B32J-iNN.js";
import { r as normalizeChatChannelId } from "./ids-BE_yccbC.js";
import { i as setPathExistingStrict } from "./path-utils-BCEW_1WB.js";
import { n as discoverConfigSecretTargets } from "./target-registry-t5xykQQS.js";
import { L as resolveNormalizedProviderModelMaxTokens } from "./io-DoswVvYe.js";
import { n as formatConfigIssueLines } from "./issue-format-c8ezaSew.js";
import { r as normalizeTalkSection } from "./talk-C8XF4d_d.js";
import { n as collectConfiguredModelRefs } from "./model-refs-BGL2fwMX.js";
import { t as splitTrailingAuthProfile } from "./model-ref-profile-L6rqw6O0.js";
import { r as getBundledChannelPlugin, s as hasBundledChannelPackageSetupFeature } from "./bundled-0oTAwz0N.js";
import { o as runPluginSetupConfigMigrations } from "./setup-registry-DHllMAAd.js";
import { n as getLoadedChannelPlugin } from "./registry-Bf5TpUad.js";
import { i as listRouteBindings } from "./bindings-D1F1bOgs.js";
import { a as legacyRuntimeModelAliasRequiresRuntimePolicy, o as listLegacyRuntimeModelProviderAliases, s as migrateLegacyRuntimeModelRef } from "./model-runtime-aliases-D35Lx2no.js";
import { t as DEFAULT_GOOGLE_API_BASE_URL } from "./google-api-base-url-UBNiBOzj.js";
import { n as formatSetExplicitDefaultInstruction, r as formatSetExplicitDefaultToConfiguredInstruction, t as formatChannelAccountsDefaultPath } from "./default-account-warnings-CK3UKJwX.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { t as asObjectRecord } from "./object-BsiS9JXh.js";
import { i as noteOpencodeProviderOverrides, n as noteImplicitFallbackClobberWarnings, o as stripUnknownConfigKeys } from "./doctor-config-analysis-C3r66ucv.js";
import { a as mergeMissing, i as migrateLegacyXSearchConfig, r as migrateLegacyWebSearchConfig } from "./legacy-config-migrations-BXj3KPAt.js";
import { n as ensureRecord, r as hasOwnKey, t as cloneRecord } from "./legacy-config-record-shared-CpOX8vW0.js";
import { t as runDoctorConfigPreflight } from "./doctor-config-preflight-saOhiD-1.js";
import { n as applyChannelDoctorCompatibilityMigrations, t as migrateLegacyConfig } from "./legacy-config-migrate-BzDDmBit.js";
import { t as applyDoctorConfigMutation } from "./config-mutation-state-C1d35St0.js";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
//#region src/secrets/legacy-secretref-env-marker.ts
function isLegacySecretRefEnvMarker(value) {
	return typeof value === "string" && value.trim().startsWith("secretref-env:");
}
function toCandidate(target, defaults) {
	if (!isLegacySecretRefEnvMarker(target.value)) return null;
	return {
		path: target.path,
		pathSegments: target.pathSegments,
		value: target.value.trim(),
		ref: parseLegacySecretRefEnvMarker(target.value, defaults?.env)
	};
}
function collectLegacySecretRefEnvMarkerCandidates(config) {
	const defaults = config.secrets?.defaults;
	return discoverConfigSecretTargets(config).map((target) => toCandidate(target, defaults)).filter((candidate) => candidate !== null);
}
function migrateLegacySecretRefEnvMarkers(config) {
	const candidates = collectLegacySecretRefEnvMarkerCandidates(config).filter((candidate) => candidate.ref !== null);
	if (candidates.length === 0) return {
		config,
		changes: []
	};
	const next = structuredClone(config);
	const changes = [];
	for (const candidate of candidates) {
		const ref = candidate.ref;
		if (!ref) continue;
		if (setPathExistingStrict(next, candidate.pathSegments, ref)) changes.push(`Moved ${candidate.path} ${LEGACY_SECRETREF_ENV_MARKER_PREFIX}${ref.id} marker → structured env SecretRef.`);
	}
	return {
		config: next,
		changes
	};
}
//#endregion
//#region src/channels/plugins/setup-promotion-helpers.ts
const COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
	"name",
	"token",
	"tokenFile",
	"botToken",
	"appToken",
	"account",
	"signalNumber",
	"authDir",
	"cliPath",
	"dbPath",
	"httpUrl",
	"httpHost",
	"httpPort",
	"webhookPath",
	"webhookUrl",
	"webhookSecret",
	"service",
	"region",
	"homeserver",
	"userId",
	"accessToken",
	"password",
	"deviceName",
	"url",
	"code",
	"dmPolicy",
	"allowFrom",
	"groupPolicy",
	"groupAllowFrom",
	"defaultTo"
]);
function asPromotionSurface(setup) {
	return setup && typeof setup === "object" ? setup : null;
}
function getLoadedChannelSetupPromotionSurface(channelKey) {
	return asPromotionSurface(getLoadedChannelPlugin(channelKey)?.setup);
}
function getBundledChannelSetupPromotionSurface(channelKey) {
	if (!hasBundledChannelPackageSetupFeature(channelKey, "configPromotion")) return null;
	return asPromotionSurface(getBundledChannelPlugin(channelKey)?.setup);
}
function isStaticSingleAccountPromotionKey(key) {
	return COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(key);
}
function resolveSingleAccountKeysToMove(params) {
	const hasNamedAccounts = Object.keys(params.channel.accounts ?? {}).some(Boolean);
	const entries = Object.entries(params.channel).filter(([key, value]) => key !== "accounts" && key !== "defaultAccount" && key !== "enabled" && value !== void 0).map(([key]) => key);
	if (entries.length === 0) return [];
	let loadedSetupSurface;
	const resolveLoadedSetupSurface = () => {
		loadedSetupSurface ??= getLoadedChannelSetupPromotionSurface(params.channelKey);
		return loadedSetupSurface;
	};
	let bundledSetupSurface;
	const resolveBundledSetupSurface = () => {
		bundledSetupSurface ??= getBundledChannelSetupPromotionSurface(params.channelKey);
		return bundledSetupSurface;
	};
	const keysToMove = entries.filter((key) => {
		if (isStaticSingleAccountPromotionKey(key)) return true;
		return Boolean(resolveLoadedSetupSurface()?.singleAccountKeysToMove?.includes(key) || resolveBundledSetupSurface()?.singleAccountKeysToMove?.includes(key));
	});
	if (!hasNamedAccounts || keysToMove.length === 0) return keysToMove;
	const namedAccountPromotionKeys = resolveLoadedSetupSurface()?.namedAccountPromotionKeys ?? resolveBundledSetupSurface()?.namedAccountPromotionKeys;
	if (!namedAccountPromotionKeys) return keysToMove;
	return keysToMove.filter((key) => namedAccountPromotionKeys.includes(key));
}
//#endregion
//#region src/commands/doctor/shared/legacy-models-add-metadata.ts
const LEGACY_MODELS_ADD_CODEX_MODEL_IDS = new Set(["gpt-5.5", "gpt-5.5-pro"]);
function isLegacyModelsAddCodexMetadataModel(params) {
	const model = params.model;
	if (normalizeProviderId$1(params.provider) !== "openai-codex" || !model) return false;
	const id = model.id?.trim().toLowerCase();
	if (!id || !LEGACY_MODELS_ADD_CODEX_MODEL_IDS.has(id)) return false;
	return model.api === "openai-codex-responses" && model.reasoning === true && Array.isArray(model.input) && model.input.length === 2 && model.input[0] === "text" && model.input[1] === "image" && model.cost?.input === 5 && model.cost.output === 30 && model.cost.cacheRead === .5 && model.cost.cacheWrite === 0 && model.contextWindow === 4e5 && model.contextTokens === 272e3 && model.maxTokens === 128e3;
}
//#endregion
//#region src/commands/doctor/shared/legacy-talk-config-normalizer.ts
function buildLegacyTalkProviderCompat(talk) {
	const compat = {};
	for (const key of [
		"voiceId",
		"voiceAliases",
		"modelId",
		"outputFormat",
		"apiKey"
	]) if (talk[key] !== void 0) compat[key] = talk[key];
	return Object.keys(compat).length > 0 ? compat : void 0;
}
function buildLegacyRealtimeTalkCompat(talk, normalizedTalk) {
	if (talk.realtime !== void 0) return;
	const compat = {};
	for (const key of [
		"model",
		"voice",
		"mode",
		"transport",
		"brain"
	]) if (talk[key] !== void 0) compat[key] = talk[key];
	if (Object.keys(compat).length === 0) return;
	if (normalizedTalk.provider !== void 0) compat.provider = normalizedTalk.provider;
	if (normalizedTalk.providers !== void 0) compat.providers = normalizedTalk.providers;
	return normalizeTalkSection({ realtime: compat })?.realtime;
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function normalizeLegacyTalkConfig(cfg, changes) {
	const rawTalk = cfg.talk;
	if (!isRecord(rawTalk)) return cfg;
	const normalizedTalk = normalizeTalkSection(rawTalk) ?? {};
	const legacyProviderCompat = buildLegacyTalkProviderCompat(rawTalk);
	if (legacyProviderCompat) normalizedTalk.providers = {
		...normalizedTalk.providers,
		elevenlabs: {
			...legacyProviderCompat,
			...normalizedTalk.providers?.elevenlabs
		}
	};
	const legacyRealtimeCompat = buildLegacyRealtimeTalkCompat(rawTalk, normalizedTalk);
	if (legacyRealtimeCompat) normalizedTalk.realtime = {
		...legacyRealtimeCompat,
		...normalizedTalk.realtime
	};
	if (Object.keys(normalizedTalk).length === 0 || isDeepStrictEqual(normalizedTalk, rawTalk)) return cfg;
	changes.push("Normalized talk.provider/providers shape (trimmed provider ids and merged missing compatibility fields).");
	if (legacyRealtimeCompat) changes.push("Moved legacy realtime Talk provider/model fields into talk.realtime.");
	return {
		...cfg,
		talk: normalizedTalk
	};
}
//#endregion
//#region src/commands/doctor/shared/legacy-config-core-normalizers.ts
function normalizeLegacyCommandsConfig(cfg, changes) {
	const rawCommands = cfg.commands;
	if (!isRecord$1(rawCommands) || !("modelsWrite" in rawCommands)) return cfg;
	const commands = { ...rawCommands };
	delete commands.modelsWrite;
	changes.push("Removed deprecated commands.modelsWrite (/models add is deprecated).");
	return {
		...cfg,
		commands
	};
}
function normalizeLegacyBrowserConfig(cfg, changes) {
	const rawBrowser = cfg.browser;
	if (!isRecord$1(rawBrowser)) return cfg;
	const browser = structuredClone(rawBrowser);
	let browserChanged = false;
	if ("relayBindHost" in browser) {
		delete browser.relayBindHost;
		browserChanged = true;
		changes.push("Removed browser.relayBindHost (legacy Chrome extension relay setting; host-local Chrome now uses Chrome MCP existing-session attach).");
	}
	const rawProfiles = browser.profiles;
	if (isRecord$1(rawProfiles)) {
		const profiles = { ...rawProfiles };
		let profilesChanged = false;
		for (const [profileName, rawProfile] of Object.entries(rawProfiles)) {
			if (!isRecord$1(rawProfile)) continue;
			if ((normalizeOptionalString(rawProfile.driver) ?? "") !== "extension") continue;
			profiles[profileName] = {
				...rawProfile,
				driver: "existing-session"
			};
			profilesChanged = true;
			changes.push(`Moved browser.profiles.${profileName}.driver "extension" → "existing-session" (Chrome MCP attach).`);
		}
		if (profilesChanged) {
			browser.profiles = profiles;
			browserChanged = true;
		}
	}
	const rawSsrFPolicy = browser.ssrfPolicy;
	if (isRecord$1(rawSsrFPolicy) && "allowPrivateNetwork" in rawSsrFPolicy) {
		const legacyAllowPrivateNetwork = rawSsrFPolicy.allowPrivateNetwork;
		const currentDangerousAllowPrivateNetwork = rawSsrFPolicy.dangerouslyAllowPrivateNetwork;
		let resolvedDangerousAllowPrivateNetwork = currentDangerousAllowPrivateNetwork;
		if (typeof legacyAllowPrivateNetwork === "boolean" || typeof currentDangerousAllowPrivateNetwork === "boolean") resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork === true || currentDangerousAllowPrivateNetwork === true;
		else if (currentDangerousAllowPrivateNetwork === void 0) resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
		const nextSsrFPolicy = { ...rawSsrFPolicy };
		delete nextSsrFPolicy.allowPrivateNetwork;
		if (resolvedDangerousAllowPrivateNetwork !== void 0) nextSsrFPolicy.dangerouslyAllowPrivateNetwork = resolvedDangerousAllowPrivateNetwork;
		browser.ssrfPolicy = nextSsrFPolicy;
		browserChanged = true;
		changes.push(`Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (${String(resolvedDangerousAllowPrivateNetwork)}).`);
	}
	if (!browserChanged) return cfg;
	return {
		...cfg,
		browser
	};
}
function seedMissingDefaultAccountsFromSingleAccountBase(cfg, changes) {
	const channels = cfg.channels;
	if (!channels) return cfg;
	let channelsChanged = false;
	const nextChannels = { ...channels };
	for (const [channelId, rawChannel] of Object.entries(channels)) {
		if (!isRecord$1(rawChannel)) continue;
		const rawAccounts = rawChannel.accounts;
		if (!isRecord$1(rawAccounts)) continue;
		const accountKeys = Object.keys(rawAccounts);
		if (accountKeys.length === 0) continue;
		if (accountKeys.some((key) => normalizeOptionalLowercaseString(key) === "default")) continue;
		const keysToMove = resolveSingleAccountKeysToMove({
			channelKey: channelId,
			channel: rawChannel
		});
		if (keysToMove.length === 0) continue;
		const defaultAccount = {};
		for (const key of keysToMove) {
			const value = rawChannel[key];
			defaultAccount[key] = value && typeof value === "object" ? structuredClone(value) : value;
		}
		const nextChannel = { ...rawChannel };
		for (const key of keysToMove) delete nextChannel[key];
		nextChannel.accounts = {
			...rawAccounts,
			[DEFAULT_ACCOUNT_ID]: defaultAccount
		};
		nextChannels[channelId] = nextChannel;
		channelsChanged = true;
		changes.push(`Moved channels.${channelId} single-account top-level values into channels.${channelId}.accounts.default.`);
	}
	if (!channelsChanged) return cfg;
	return {
		...cfg,
		channels: nextChannels
	};
}
const LEGACY_CODEX_CLI_RUNTIME_ID = "codex-cli";
const CODEX_APP_SERVER_RUNTIME_ID = "codex";
function resolveLegacyWholeAgentRuntimePolicy(raw) {
	if (!isRecord$1(raw)) return;
	const runtime = normalizeOptionalLowercaseString(raw.id);
	if (!runtime || runtime === "auto" || runtime === "pi") return;
	const alias = listLegacyRuntimeModelProviderAliases().find((entry) => entry.cli && normalizeProviderId$1(entry.runtime) === runtime);
	return alias ? {
		provider: alias.provider,
		runtime: alias.runtime,
		requiresRuntimePolicy: alias.requiresRuntimePolicy
	} : void 0;
}
function migratedRuntimeRequiresPolicy(legacyProvider) {
	return legacyRuntimeModelAliasRequiresRuntimePolicy(legacyProvider);
}
function mergeModelEntry(legacyEntry, currentEntry) {
	if (!isRecord$1(legacyEntry) || !isRecord$1(currentEntry)) return currentEntry ?? legacyEntry;
	return {
		...legacyEntry,
		...currentEntry
	};
}
function normalizeLegacyCodexCliAgentRuntimePolicy(raw) {
	if (!isRecord$1(raw)) return {
		value: raw,
		changed: false
	};
	if (normalizeOptionalLowercaseString(raw.id) !== LEGACY_CODEX_CLI_RUNTIME_ID) return {
		value: raw,
		changed: false
	};
	return {
		value: {
			...raw,
			id: CODEX_APP_SERVER_RUNTIME_ID
		},
		changed: true
	};
}
function normalizeLegacyRuntimeAgentModelConfig(raw) {
	if (typeof raw === "string") {
		const migrated = migrateLegacyRuntimeModelRef(raw);
		return migrated ? {
			value: migrated.ref,
			changed: true,
			selectedRuntime: migrated.runtime,
			selectedRuntimeRequiresPolicy: migratedRuntimeRequiresPolicy(migrated.legacyProvider),
			selectedRefs: [{
				ref: migrated.ref,
				runtime: migrated.runtime,
				requiresRuntimePolicy: migratedRuntimeRequiresPolicy(migrated.legacyProvider)
			}]
		} : {
			value: raw,
			changed: false,
			selectedRuntimeRequiresPolicy: false,
			selectedRefs: []
		};
	}
	if (!isRecord$1(raw)) return {
		value: raw,
		changed: false,
		selectedRuntimeRequiresPolicy: false,
		selectedRefs: []
	};
	const migratedPrimary = typeof raw.primary === "string" ? migrateLegacyRuntimeModelRef(raw.primary) : null;
	let changed = false;
	const next = { ...raw };
	const selectedRefs = [];
	let selectedRuntime = migratedPrimary?.runtime;
	let selectedRuntimeRequiresPolicy = migratedPrimary !== null && migratedRuntimeRequiresPolicy(migratedPrimary.legacyProvider);
	if (migratedPrimary) {
		next.primary = migratedPrimary.ref;
		selectedRefs.push({
			ref: migratedPrimary.ref,
			runtime: migratedPrimary.runtime,
			requiresRuntimePolicy: migratedRuntimeRequiresPolicy(migratedPrimary.legacyProvider)
		});
		changed = true;
	}
	if (Array.isArray(raw.fallbacks)) next.fallbacks = raw.fallbacks.map((fallback) => {
		if (typeof fallback !== "string") return fallback;
		const migratedFallback = migrateLegacyRuntimeModelRef(fallback);
		if (migratedFallback && (migratedFallback.runtime === selectedRuntime || migratedFallback.legacyProvider === LEGACY_CODEX_CLI_RUNTIME_ID)) {
			selectedRuntime ??= migratedFallback.runtime;
			selectedRuntimeRequiresPolicy ||= migratedRuntimeRequiresPolicy(migratedFallback.legacyProvider);
			selectedRefs.push({
				ref: migratedFallback.ref,
				runtime: migratedFallback.runtime,
				requiresRuntimePolicy: migratedRuntimeRequiresPolicy(migratedFallback.legacyProvider)
			});
			changed = true;
			return migratedFallback.ref;
		}
		return fallback;
	});
	if (!changed) return {
		value: raw,
		changed: false,
		selectedRuntimeRequiresPolicy: false,
		selectedRefs: []
	};
	return {
		value: next,
		changed: true,
		selectedRuntime,
		selectedRuntimeRequiresPolicy,
		selectedRefs
	};
}
function runtimeNeedsExplicitModelPolicy(runtime) {
	return Boolean(runtime && runtime !== "codex");
}
function modelEntryWithRuntimePolicy(entry, runtime) {
	const base = isRecord$1(entry) ? { ...entry } : {};
	const currentRuntime = isRecord$1(base.agentRuntime) ? normalizeOptionalLowercaseString(base.agentRuntime.id) : void 0;
	if (!currentRuntime || currentRuntime === "auto") base.agentRuntime = {
		...isRecord$1(base.agentRuntime) ? base.agentRuntime : {},
		id: runtime
	};
	return base;
}
function mergeModelEntryWithRuntimePolicy(legacyEntry, currentEntry, runtime, requiresRuntimePolicy = runtimeNeedsExplicitModelPolicy(runtime)) {
	const merged = mergeModelEntry(legacyEntry, currentEntry);
	return runtime && requiresRuntimePolicy ? modelEntryWithRuntimePolicy(merged, runtime) : merged;
}
function normalizeLegacyRuntimeAllowlistModels(rawModels, selectedRuntime, selectedRuntimeRequiresPolicy) {
	if (!isRecord$1(rawModels)) return {
		value: rawModels,
		changed: false
	};
	let changed = false;
	const next = {};
	const legacyEntries = [];
	for (const [rawKey, entry] of Object.entries(rawModels)) {
		const migrated = migrateLegacyRuntimeModelRef(rawKey);
		if (migrated && (migrated.runtime === selectedRuntime || migrated.legacyProvider === LEGACY_CODEX_CLI_RUNTIME_ID)) {
			changed = true;
			next[rawKey] = mergeModelEntry(entry, next[rawKey]);
			legacyEntries.push({
				migratedKey: migrated.ref,
				entry,
				runtime: migrated.runtime,
				requiresRuntimePolicy: migratedRuntimeRequiresPolicy(migrated.legacyProvider)
			});
			continue;
		}
		next[rawKey] = mergeModelEntry(entry, next[rawKey]);
	}
	for (const { migratedKey, entry, runtime, requiresRuntimePolicy } of legacyEntries) next[migratedKey] = mergeModelEntryWithRuntimePolicy(entry, next[migratedKey], runtime, requiresRuntimePolicy || runtime === selectedRuntime && selectedRuntimeRequiresPolicy);
	return {
		value: next,
		changed
	};
}
function ensureSelectedModelRuntimePolicies(rawModels, selectedRefs) {
	if (selectedRefs.length === 0) return {
		value: rawModels,
		changed: false
	};
	const next = isRecord$1(rawModels) ? { ...rawModels } : {};
	let changed = false;
	for (const { ref, runtime, requiresRuntimePolicy } of selectedRefs) {
		if (!requiresRuntimePolicy) continue;
		const current = next[ref];
		const updated = modelEntryWithRuntimePolicy(current, runtime);
		if (JSON.stringify(updated) !== JSON.stringify(current ?? {})) {
			next[ref] = updated;
			changed = true;
		}
	}
	return {
		value: next,
		changed
	};
}
function selectedCanonicalModelRefsForRuntimePolicy(rawModel, provider, runtime, requiresRuntimePolicy) {
	const refs = [];
	const addRef = (rawRef) => {
		if (typeof rawRef !== "string") return;
		const trimmed = rawRef.trim();
		const slash = trimmed.indexOf("/");
		if (slash <= 0 || slash >= trimmed.length - 1) return;
		if (normalizeProviderId$1(trimmed.slice(0, slash)) !== normalizeProviderId$1(provider)) return;
		refs.push({
			ref: trimmed,
			runtime,
			requiresRuntimePolicy
		});
	};
	if (typeof rawModel === "string") {
		addRef(rawModel);
		return refs;
	}
	if (!isRecord$1(rawModel)) return refs;
	addRef(rawModel.primary);
	if (Array.isArray(rawModel.fallbacks)) for (const fallback of rawModel.fallbacks) addRef(fallback);
	return refs;
}
function normalizeLegacyCodexCliRuntimePinsInModels(rawModels, path, changes) {
	if (!isRecord$1(rawModels)) return {
		value: rawModels,
		changed: false
	};
	let changed = false;
	const next = { ...rawModels };
	for (const [modelRef, rawEntry] of Object.entries(rawModels)) {
		if (!isRecord$1(rawEntry)) continue;
		const runtime = normalizeLegacyCodexCliAgentRuntimePolicy(rawEntry.agentRuntime);
		if (!runtime.changed) continue;
		next[modelRef] = {
			...rawEntry,
			agentRuntime: runtime.value
		};
		changed = true;
		changes.push(`Moved ${path}.${sanitizeForLog(modelRef)} agentRuntime.id from codex-cli to codex.`);
	}
	return {
		value: next,
		changed
	};
}
function normalizeLegacyRuntimeAgentContainer(raw, path, changes) {
	let changed = false;
	const next = { ...raw };
	const legacyWholeAgentRuntime = resolveLegacyWholeAgentRuntimePolicy(raw.agentRuntime);
	const model = normalizeLegacyRuntimeAgentModelConfig(raw.model);
	if (model.changed) {
		next.model = model.value;
		changed = true;
		const runtimeSuffix = model.selectedRuntime ? ` and selected ${model.selectedRuntime} runtime` : "";
		changes.push(`Moved ${path}.model legacy runtime primary refs to canonical provider refs${runtimeSuffix}.`);
	}
	const models = normalizeLegacyRuntimeAllowlistModels(raw.models, model.selectedRuntime, model.selectedRuntimeRequiresPolicy);
	if (models.changed) {
		next.models = models.value;
		changed = true;
		changes.push(`Moved ${path}.models legacy runtime keys to canonical provider keys.`);
	}
	if (model.selectedRuntime) {
		const modelRuntimes = ensureSelectedModelRuntimePolicies(next.models, model.selectedRefs);
		if (modelRuntimes.changed) {
			next.models = modelRuntimes.value;
			changed = true;
			changes.push(`Selected ${model.selectedRuntime} runtime for ${path}.models entries.`);
		}
	}
	if (legacyWholeAgentRuntime) {
		const selectedRefs = selectedCanonicalModelRefsForRuntimePolicy(next.model ?? raw.model, legacyWholeAgentRuntime.provider, legacyWholeAgentRuntime.runtime, legacyWholeAgentRuntime.requiresRuntimePolicy);
		const modelRuntimes = ensureSelectedModelRuntimePolicies(next.models, selectedRefs);
		if (modelRuntimes.changed) {
			next.models = modelRuntimes.value;
			changed = true;
			changes.push(`Moved ${path}.agentRuntime.id ${legacyWholeAgentRuntime.runtime} to matching ${legacyWholeAgentRuntime.provider} model runtime policy.`);
		}
	}
	const codexCliRuntimePins = normalizeLegacyCodexCliRuntimePinsInModels(next.models, `${path}.models`, changes);
	if (codexCliRuntimePins.changed) {
		next.models = codexCliRuntimePins.value;
		changed = true;
	}
	return {
		value: next,
		changed
	};
}
function normalizeLegacyCodexCliProviderRuntimePins(cfg, changes) {
	const rawModels = cfg.models;
	if (!isRecord$1(rawModels) || !isRecord$1(rawModels.providers)) return {
		config: cfg,
		changed: false
	};
	let changed = false;
	const nextProviders = { ...rawModels.providers };
	for (const [providerId, rawProvider] of Object.entries(rawModels.providers)) {
		if (!isRecord$1(rawProvider)) continue;
		let providerChanged = false;
		const nextProvider = { ...rawProvider };
		const providerRuntime = normalizeLegacyCodexCliAgentRuntimePolicy(rawProvider.agentRuntime);
		if (providerRuntime.changed) {
			nextProvider.agentRuntime = providerRuntime.value;
			providerChanged = true;
			changes.push(`Moved models.providers.${sanitizeForLog(providerId)} agentRuntime.id from codex-cli to codex.`);
		}
		if (Array.isArray(rawProvider.models)) {
			const nextProviderModels = rawProvider.models.map((entry, index) => {
				if (!isRecord$1(entry)) return entry;
				const runtime = normalizeLegacyCodexCliAgentRuntimePolicy(entry.agentRuntime);
				if (!runtime.changed) return entry;
				providerChanged = true;
				const modelId = normalizeOptionalString(entry.id) ?? `[${index}]`;
				changes.push(`Moved models.providers.${sanitizeForLog(providerId)}.models.${sanitizeForLog(modelId)} agentRuntime.id from codex-cli to codex.`);
				return Object.assign({}, entry, { agentRuntime: runtime.value });
			});
			if (providerChanged) nextProvider.models = nextProviderModels;
		}
		if (providerChanged) {
			nextProviders[providerId] = nextProvider;
			changed = true;
		}
	}
	return changed ? {
		config: {
			...cfg,
			models: {
				...rawModels,
				providers: nextProviders
			}
		},
		changed: true
	} : {
		config: cfg,
		changed: false
	};
}
function normalizeLegacyRuntimeModelRefs(cfg, changes) {
	const cfgWithProviders = normalizeLegacyCodexCliProviderRuntimePins(cfg, changes).config;
	const rawAgents = cfgWithProviders.agents;
	if (!isRecord$1(rawAgents)) return cfgWithProviders;
	let changed = false;
	const nextAgents = { ...rawAgents };
	if (isRecord$1(rawAgents.defaults)) {
		const defaults = normalizeLegacyRuntimeAgentContainer(rawAgents.defaults, "agents.defaults", changes);
		if (defaults.changed) {
			nextAgents.defaults = defaults.value;
			changed = true;
		}
	}
	if (Array.isArray(rawAgents.list)) {
		const nextList = rawAgents.list.map((entry, index) => {
			if (!isRecord$1(entry)) return entry;
			const agentId = normalizeOptionalString(entry.id);
			const agent = normalizeLegacyRuntimeAgentContainer(entry, agentId ? `agents.list.${sanitizeForLog(agentId)}` : `agents.list[${index}]`, changes);
			if (agent.changed) {
				changed = true;
				return agent.value;
			}
			return entry;
		});
		if (changed) nextAgents.list = nextList;
	}
	return changed ? {
		...cfgWithProviders,
		agents: nextAgents
	} : cfgWithProviders;
}
function normalizeLegacyOpenAICodexModelsAddMetadata(cfg, changes) {
	const rawModels = cfg.models;
	if (!isRecord$1(rawModels) || !isRecord$1(rawModels.providers)) return cfg;
	const rawProviders = rawModels.providers;
	let providersChanged = false;
	const nextProviders = { ...rawProviders };
	for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
		if (normalizeProviderId$1(providerId) !== "openai-codex" || !isRecord$1(rawProvider)) continue;
		const rawProviderModels = rawProvider.models;
		if (!Array.isArray(rawProviderModels)) continue;
		let providerChanged = false;
		const nextModels = [];
		for (const model of rawProviderModels) if (isRecord$1(model) && !("metadataSource" in model) && isLegacyModelsAddCodexMetadataModel({
			provider: providerId,
			model
		})) {
			providerChanged = true;
			const safeProviderId = sanitizeForLog(providerId);
			const safeModelId = sanitizeForLog(normalizeOptionalString(model.id) ?? "unknown");
			changes.push(`Marked models.providers.${safeProviderId}.models.${safeModelId} as /models add metadata so official OpenAI Codex metadata can override it.`);
			nextModels.push(Object.assign({}, model, { metadataSource: "models-add" }));
		} else nextModels.push(model);
		if (!providerChanged) continue;
		nextProviders[providerId] = {
			...rawProvider,
			models: nextModels
		};
		providersChanged = true;
	}
	if (!providersChanged) return cfg;
	return {
		...cfg,
		models: {
			...rawModels,
			providers: nextProviders
		}
	};
}
function normalizeLegacyOpenAIModelProviderApi(cfg, changes) {
	const rawModels = cfg.models;
	if (!isRecord$1(rawModels) || !isRecord$1(rawModels.providers)) return cfg;
	const rawProviders = rawModels.providers;
	let providersChanged = false;
	const nextProviders = { ...rawProviders };
	for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
		if (!isRecord$1(rawProvider)) continue;
		let providerChanged = false;
		const nextProvider = { ...rawProvider };
		if (nextProvider.api === "openai") {
			nextProvider.api = "openai-completions";
			providerChanged = true;
			changes.push(`Moved models.providers.${sanitizeForLog(providerId)}.api "openai" → "openai-completions".`);
		}
		const rawProviderModels = rawProvider.models;
		if (Array.isArray(rawProviderModels)) {
			let modelsChanged = false;
			const nextModels = [];
			rawProviderModels.forEach((model, index) => {
				if (!isRecord$1(model) || model.api !== "openai") {
					nextModels.push(model);
					return;
				}
				modelsChanged = true;
				changes.push(`Moved models.providers.${sanitizeForLog(providerId)}.models[${index}].api "openai" → "openai-completions".`);
				nextModels.push({
					...model,
					api: "openai-completions"
				});
			});
			if (modelsChanged) {
				nextProvider.models = nextModels;
				providerChanged = true;
			}
		}
		if (!providerChanged) continue;
		nextProviders[providerId] = nextProvider;
		providersChanged = true;
	}
	if (!providersChanged) return cfg;
	return {
		...cfg,
		models: {
			...rawModels,
			providers: nextProviders
		}
	};
}
function normalizeLegacyNanoBananaSkill(cfg, changes) {
	const NANO_BANANA_SKILL_KEY = "nano-banana-pro";
	const NANO_BANANA_MODEL = "google/gemini-3-pro-image-preview";
	const rawSkills = cfg.skills;
	if (!isRecord$1(rawSkills)) return cfg;
	let next = cfg;
	let skillsChanged = false;
	const skills = structuredClone(rawSkills);
	if (Array.isArray(skills.allowBundled)) {
		const allowBundled = skills.allowBundled.filter((value) => typeof value !== "string" || value.trim() !== NANO_BANANA_SKILL_KEY);
		if (allowBundled.length !== skills.allowBundled.length) {
			if (allowBundled.length === 0) {
				delete skills.allowBundled;
				changes.push(`Removed skills.allowBundled entry for ${NANO_BANANA_SKILL_KEY}.`);
			} else {
				skills.allowBundled = allowBundled;
				changes.push(`Removed ${NANO_BANANA_SKILL_KEY} from skills.allowBundled.`);
			}
			skillsChanged = true;
		}
	}
	const rawEntries = skills.entries;
	if (!isRecord$1(rawEntries)) {
		if (!skillsChanged) return cfg;
		return {
			...cfg,
			skills
		};
	}
	const rawLegacyEntry = rawEntries[NANO_BANANA_SKILL_KEY];
	if (!isRecord$1(rawLegacyEntry)) {
		if (!skillsChanged) return cfg;
		return {
			...cfg,
			skills
		};
	}
	if (next.agents?.defaults?.imageGenerationModel === void 0) {
		next = {
			...next,
			agents: {
				...next.agents,
				defaults: {
					...next.agents?.defaults,
					imageGenerationModel: { primary: NANO_BANANA_MODEL }
				}
			}
		};
		changes.push(`Moved skills.entries.${NANO_BANANA_SKILL_KEY} → agents.defaults.imageGenerationModel.primary (${NANO_BANANA_MODEL}).`);
	}
	const legacyEnvApiKey = normalizeOptionalString((isRecord$1(rawLegacyEntry.env) ? rawLegacyEntry.env : void 0)?.GEMINI_API_KEY) ?? "";
	const legacyApiKey = legacyEnvApiKey || (typeof rawLegacyEntry.apiKey === "string" ? normalizeOptionalString(rawLegacyEntry.apiKey) : rawLegacyEntry.apiKey && isRecord$1(rawLegacyEntry.apiKey) ? structuredClone(rawLegacyEntry.apiKey) : void 0);
	const rawModels = isRecord$1(next.models) ? structuredClone(next.models) : {};
	const rawProviders = isRecord$1(rawModels.providers) ? { ...rawModels.providers } : {};
	const rawGoogle = isRecord$1(rawProviders.google) ? { ...rawProviders.google } : {};
	if (!(rawGoogle.apiKey !== void 0) && legacyApiKey) {
		rawGoogle.apiKey = legacyApiKey;
		if (!rawGoogle.baseUrl) rawGoogle.baseUrl = DEFAULT_GOOGLE_API_BASE_URL;
		if (!Array.isArray(rawGoogle.models)) rawGoogle.models = [];
		rawProviders.google = rawGoogle;
		rawModels.providers = rawProviders;
		next = {
			...next,
			models: rawModels
		};
		changes.push(`Moved skills.entries.${NANO_BANANA_SKILL_KEY}.${legacyEnvApiKey ? "env.GEMINI_API_KEY" : "apiKey"} → models.providers.google.apiKey.`);
	}
	const entries = { ...rawEntries };
	delete entries[NANO_BANANA_SKILL_KEY];
	if (Object.keys(entries).length === 0) delete skills.entries;
	else skills.entries = entries;
	changes.push(`Removed legacy skills.entries.${NANO_BANANA_SKILL_KEY}.`);
	skillsChanged = true;
	if (Object.keys(skills).length === 0) {
		const { skills: _ignored, ...rest } = next;
		return rest;
	}
	if (!skillsChanged) return next;
	return {
		...next,
		skills
	};
}
function normalizeLegacyCrossContextMessageConfig(cfg, changes) {
	const rawTools = cfg.tools;
	if (!isRecord$1(rawTools)) return cfg;
	const rawMessage = rawTools.message;
	if (!isRecord$1(rawMessage) || !("allowCrossContextSend" in rawMessage)) return cfg;
	const legacyAllowCrossContextSend = rawMessage.allowCrossContextSend;
	if (typeof legacyAllowCrossContextSend !== "boolean") return cfg;
	const nextMessage = { ...rawMessage };
	delete nextMessage.allowCrossContextSend;
	if (legacyAllowCrossContextSend) {
		const rawCrossContext = isRecord$1(nextMessage.crossContext) ? structuredClone(nextMessage.crossContext) : {};
		rawCrossContext.allowWithinProvider = true;
		rawCrossContext.allowAcrossProviders = true;
		nextMessage.crossContext = rawCrossContext;
		changes.push("Moved tools.message.allowCrossContextSend → tools.message.crossContext.allowWithinProvider/allowAcrossProviders (true).");
	} else changes.push("Removed tools.message.allowCrossContextSend=false (default cross-context policy already matches canonical settings).");
	return {
		...cfg,
		tools: {
			...cfg.tools,
			message: nextMessage
		}
	};
}
function mapDeepgramCompatToProviderOptions(rawCompat) {
	const providerOptions = {};
	if (typeof rawCompat.detectLanguage === "boolean") providerOptions.detect_language = rawCompat.detectLanguage;
	if (typeof rawCompat.punctuate === "boolean") providerOptions.punctuate = rawCompat.punctuate;
	if (typeof rawCompat.smartFormat === "boolean") providerOptions.smart_format = rawCompat.smartFormat;
	return providerOptions;
}
function migrateLegacyDeepgramCompat(params) {
	const rawCompat = isRecord$1(params.owner.deepgram) ? structuredClone(params.owner.deepgram) : null;
	if (!rawCompat) return false;
	const compatProviderOptions = mapDeepgramCompatToProviderOptions(rawCompat);
	const currentProviderOptions = isRecord$1(params.owner.providerOptions) ? structuredClone(params.owner.providerOptions) : {};
	const currentDeepgram = isRecord$1(currentProviderOptions.deepgram) ? structuredClone(currentProviderOptions.deepgram) : {};
	const mergedDeepgram = {
		...compatProviderOptions,
		...currentDeepgram
	};
	delete params.owner.deepgram;
	currentProviderOptions.deepgram = mergedDeepgram;
	params.owner.providerOptions = currentProviderOptions;
	const hadCanonicalDeepgram = Object.keys(currentDeepgram).length > 0;
	params.changes.push(hadCanonicalDeepgram ? `Merged ${params.pathPrefix}.deepgram → ${params.pathPrefix}.providerOptions.deepgram (filled missing canonical fields from legacy).` : `Moved ${params.pathPrefix}.deepgram → ${params.pathPrefix}.providerOptions.deepgram.`);
	return true;
}
function normalizeLegacyMediaProviderOptions(cfg, changes) {
	const rawTools = cfg.tools;
	if (!isRecord$1(rawTools)) return cfg;
	const rawMedia = rawTools.media;
	if (!isRecord$1(rawMedia)) return cfg;
	let mediaChanged = false;
	const nextMedia = structuredClone(rawMedia);
	const migrateModelList = (models, pathPrefix) => {
		if (!Array.isArray(models)) return false;
		let changedAny = false;
		for (const [index, entry] of models.entries()) {
			if (!isRecord$1(entry)) continue;
			if (migrateLegacyDeepgramCompat({
				owner: entry,
				pathPrefix: `${pathPrefix}[${index}]`,
				changes
			})) changedAny = true;
		}
		return changedAny;
	};
	for (const capability of [
		"audio",
		"image",
		"video"
	]) {
		const config = isRecord$1(nextMedia[capability]) ? structuredClone(nextMedia[capability]) : null;
		if (!config) continue;
		let configChanged = false;
		if (migrateLegacyDeepgramCompat({
			owner: config,
			pathPrefix: `tools.media.${capability}`,
			changes
		})) configChanged = true;
		if (migrateModelList(config.models, `tools.media.${capability}.models`)) configChanged = true;
		if (configChanged) {
			nextMedia[capability] = config;
			mediaChanged = true;
		}
	}
	if (migrateModelList(nextMedia.models, "tools.media.models")) mediaChanged = true;
	if (!mediaChanged) return cfg;
	return {
		...cfg,
		tools: {
			...cfg.tools,
			media: nextMedia
		}
	};
}
function normalizeConfiguredPositiveInteger(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.floor(value);
}
function resolveConfiguredOllamaModelNumCtxBudget(params) {
	const modelContextWindow = normalizeConfiguredPositiveInteger(params.model.contextWindow);
	if (modelContextWindow !== void 0) return modelContextWindow;
	const providerContextWindow = normalizeConfiguredPositiveInteger(params.provider.contextWindow);
	if (providerContextWindow !== void 0) return params.providerNumCtxApplies ? void 0 : providerContextWindow;
	const modelMaxTokens = normalizeConfiguredPositiveInteger(params.model.maxTokens);
	if (modelMaxTokens !== void 0) return modelMaxTokens;
	const providerMaxTokens = normalizeConfiguredPositiveInteger(params.provider.maxTokens);
	if (providerMaxTokens !== void 0) return params.providerNumCtxApplies ? void 0 : providerMaxTokens;
}
function resolveConfiguredOllamaProviderNumCtxBudget(provider) {
	return normalizeConfiguredPositiveInteger(provider.contextWindow) ?? normalizeConfiguredPositiveInteger(provider.maxTokens);
}
function isNativeOllamaProviderConfig(_providerId, provider) {
	return normalizeOptionalLowercaseString(provider.api) === "ollama";
}
function isNativeOllamaModelConfig(params) {
	const modelApi = normalizeOptionalLowercaseString(params.model.api);
	if (modelApi) return modelApi === "ollama";
	const providerApi = normalizeOptionalLowercaseString(params.provider.api);
	if (providerApi) return providerApi === "ollama";
	return false;
}
function hasConfiguredOllamaProviderNumCtx(provider) {
	const rawParams = provider.params;
	return isRecord$1(rawParams) && hasOwnKey(rawParams, "num_ctx");
}
function applyLegacyOllamaProviderNumCtxParams(params) {
	if (!isNativeOllamaProviderConfig(params.providerId, params.provider)) return {
		provider: params.provider,
		changed: false
	};
	const rawParams = params.provider.params;
	if (rawParams !== void 0 && !isRecord$1(rawParams)) return {
		provider: params.provider,
		changed: false
	};
	if (rawParams && hasOwnKey(rawParams, "num_ctx")) return {
		provider: params.provider,
		changed: false
	};
	const numCtx = resolveConfiguredOllamaProviderNumCtxBudget(params.provider);
	if (numCtx === void 0) return {
		provider: params.provider,
		changed: false
	};
	params.changes.push(`Set models.providers.${sanitizeForLog(params.providerId)}.params.num_ctx to ${numCtx} for native Ollama compatibility.`);
	return {
		provider: {
			...params.provider,
			params: rawParams ? {
				...rawParams,
				num_ctx: numCtx
			} : { num_ctx: numCtx }
		},
		changed: true
	};
}
function normalizeLegacyOllamaNativeNumCtxParams(cfg, changes) {
	const rawProviders = cfg.models?.providers;
	if (!isRecord$1(rawProviders)) return cfg;
	let providersChanged = false;
	const nextProviders = { ...rawProviders };
	for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
		if (!isRecord$1(rawProvider)) continue;
		const rawModels = rawProvider.models;
		if (!Array.isArray(rawModels)) continue;
		const providerParams = applyLegacyOllamaProviderNumCtxParams({
			providerId,
			provider: rawProvider,
			changes
		});
		const providerNumCtxApplies = isNativeOllamaProviderConfig(providerId, providerParams.provider) && hasConfiguredOllamaProviderNumCtx(providerParams.provider);
		if (rawModels.length === 0) {
			if (!providerParams.changed) continue;
			nextProviders[providerId] = providerParams.provider;
			providersChanged = true;
			continue;
		}
		let modelsChanged = false;
		const nextModels = rawModels.map((model, index) => {
			if (!isRecord$1(model)) return model;
			if (!isNativeOllamaModelConfig({
				providerId,
				provider: providerParams.provider,
				model
			})) return model;
			const rawParams = model.params;
			if (rawParams !== void 0 && !isRecord$1(rawParams)) return model;
			if (rawParams && hasOwnKey(rawParams, "num_ctx")) return model;
			const numCtx = resolveConfiguredOllamaModelNumCtxBudget({
				model,
				provider: providerParams.provider,
				providerNumCtxApplies
			});
			if (numCtx === void 0) return model;
			modelsChanged = true;
			changes.push(`Set models.providers.${sanitizeForLog(providerId)}.models[${index}].params.num_ctx to ${numCtx} for native Ollama compatibility.`);
			return Object.assign({}, model, { params: rawParams ? {
				...rawParams,
				num_ctx: numCtx
			} : { num_ctx: numCtx } });
		});
		if (!modelsChanged && !providerParams.changed) continue;
		nextProviders[providerId] = {
			...providerParams.provider,
			models: nextModels
		};
		providersChanged = true;
	}
	if (!providersChanged) return cfg;
	return {
		...cfg,
		models: {
			...cfg.models,
			providers: nextProviders
		}
	};
}
function normalizeLegacyMistralModelMaxTokens(cfg, changes) {
	const rawProviders = cfg.models?.providers;
	if (!isRecord$1(rawProviders)) return cfg;
	let providersChanged = false;
	const nextProviders = { ...rawProviders };
	for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
		if (normalizeProviderId$1(providerId) !== "mistral" || !isRecord$1(rawProvider)) continue;
		const rawModels = rawProvider.models;
		if (!Array.isArray(rawModels)) continue;
		let modelsChanged = false;
		const nextModels = rawModels.map((model, index) => {
			if (!isRecord$1(model)) return model;
			const modelId = normalizeOptionalString(model.id) ?? "";
			const contextWindow = typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) ? model.contextWindow : null;
			const maxTokens = typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) ? model.maxTokens : null;
			if (!modelId || contextWindow === null || maxTokens === null) return model;
			const normalizedMaxTokens = resolveNormalizedProviderModelMaxTokens({
				providerId,
				modelId,
				contextWindow,
				rawMaxTokens: maxTokens
			});
			if (normalizedMaxTokens === maxTokens) return model;
			modelsChanged = true;
			changes.push(`Normalized models.providers.${providerId}.models[${index}].maxTokens (${maxTokens} → ${normalizedMaxTokens}) to avoid Mistral context-window rejects.`);
			return Object.assign({}, model, { maxTokens: normalizedMaxTokens });
		});
		if (!modelsChanged) continue;
		nextProviders[providerId] = {
			...rawProvider,
			models: nextModels
		};
		providersChanged = true;
	}
	if (!providersChanged) return cfg;
	return {
		...cfg,
		models: {
			...cfg.models,
			providers: nextProviders
		}
	};
}
//#endregion
//#region src/commands/doctor/shared/legacy-web-fetch-migrate.ts
const DANGEROUS_RECORD_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function resolveLegacyFetchConfig(raw) {
	if (!isRecord$1(raw)) return;
	const tools = isRecord$1(raw.tools) ? raw.tools : void 0;
	const web = isRecord$1(tools?.web) ? tools.web : void 0;
	return isRecord$1(web?.fetch) ? web.fetch : void 0;
}
function copyLegacyFirecrawlFetchConfig(fetch) {
	const current = fetch.firecrawl;
	if (!isRecord$1(current)) return;
	const next = cloneRecord(current);
	delete next.enabled;
	return next;
}
function hasMappedLegacyWebFetchConfig(raw) {
	const fetch = resolveLegacyFetchConfig(raw);
	if (!fetch) return false;
	return isRecord$1(fetch.firecrawl);
}
function migratePluginWebFetchConfig(params) {
	const entry = ensureRecord(ensureRecord(ensureRecord(params.root, "plugins"), "entries"), "firecrawl");
	const config = ensureRecord(entry, "config");
	const hadEnabled = entry.enabled !== void 0;
	const existing = isRecord$1(config.webFetch) ? cloneRecord(config.webFetch) : void 0;
	if (!hadEnabled) entry.enabled = true;
	if (!existing) {
		config.webFetch = cloneRecord(params.payload);
		params.changes.push("Moved tools.web.fetch.firecrawl → plugins.entries.firecrawl.config.webFetch.");
		return;
	}
	const merged = cloneRecord(existing);
	mergeMissing(merged, params.payload);
	const changed = JSON.stringify(merged) !== JSON.stringify(existing) || !hadEnabled;
	config.webFetch = merged;
	if (changed) {
		params.changes.push("Merged tools.web.fetch.firecrawl → plugins.entries.firecrawl.config.webFetch (filled missing fields from legacy; kept explicit plugin config values).");
		return;
	}
	params.changes.push("Removed tools.web.fetch.firecrawl (plugins.entries.firecrawl.config.webFetch already set).");
}
function migrateLegacyWebFetchConfig(raw) {
	if (!isRecord$1(raw) || !hasMappedLegacyWebFetchConfig(raw)) return {
		config: raw,
		changes: []
	};
	return normalizeLegacyWebFetchConfigRecord(raw);
}
function normalizeLegacyWebFetchConfigRecord(raw) {
	const nextRoot = structuredClone(raw);
	const web = ensureRecord(ensureRecord(nextRoot, "tools"), "web");
	const fetch = resolveLegacyFetchConfig(nextRoot);
	if (!fetch) return {
		config: raw,
		changes: []
	};
	const nextFetch = {};
	for (const [key, value] of Object.entries(fetch)) {
		if (key === "firecrawl" && isRecord$1(value)) continue;
		if (DANGEROUS_RECORD_KEYS.has(key)) continue;
		nextFetch[key] = value;
	}
	web.fetch = nextFetch;
	const firecrawl = copyLegacyFirecrawlFetchConfig(fetch);
	const changes = [];
	if (firecrawl && Object.keys(firecrawl).length > 0) migratePluginWebFetchConfig({
		root: nextRoot,
		payload: firecrawl,
		changes
	});
	else if (hasOwnKey(fetch, "firecrawl")) changes.push("Removed empty tools.web.fetch.firecrawl.");
	return {
		config: nextRoot,
		changes
	};
}
//#endregion
//#region src/commands/doctor/shared/legacy-config-compatibility-base.ts
function normalizeBaseCompatibilityConfigValues(cfg, changes, afterBrowser) {
	let next = seedMissingDefaultAccountsFromSingleAccountBase(cfg, changes);
	next = normalizeLegacyBrowserConfig(next, changes);
	next = afterBrowser ? afterBrowser(next) : next;
	for (const migrate of [
		migrateLegacyWebSearchConfig,
		migrateLegacyWebFetchConfig,
		migrateLegacyXSearchConfig
	]) {
		const migrated = migrate(next);
		if (migrated.changes.length === 0) continue;
		next = migrated.config;
		changes.push(...migrated.changes);
	}
	next = normalizeLegacyNanoBananaSkill(next, changes);
	next = normalizeLegacyTalkConfig(next, changes);
	next = normalizeLegacyOpenAIModelProviderApi(next, changes);
	next = normalizeLegacyRuntimeModelRefs(next, changes);
	next = normalizeLegacyCrossContextMessageConfig(next, changes);
	next = normalizeLegacyMediaProviderOptions(next, changes);
	next = normalizeLegacyOllamaNativeNumCtxParams(next, changes);
	return normalizeLegacyMistralModelMaxTokens(next, changes);
}
//#endregion
//#region src/commands/doctor/shared/legacy-config-core-migrate.ts
function normalizeCompatibilityConfigValues(cfg) {
	const changes = [];
	let next = normalizeBaseCompatibilityConfigValues(cfg, changes, (config) => {
		const setupMigration = runPluginSetupConfigMigrations({ config });
		if (setupMigration.changes.length === 0) return config;
		changes.push(...setupMigration.changes);
		return setupMigration.config;
	});
	const channelMigrations = applyChannelDoctorCompatibilityMigrations(next);
	if (channelMigrations.changes.length > 0) {
		next = channelMigrations.next;
		changes.push(...channelMigrations.changes);
	}
	const secretRefMarkers = migrateLegacySecretRefEnvMarkers(next);
	if (secretRefMarkers.changes.length > 0) {
		next = secretRefMarkers.config;
		changes.push(...secretRefMarkers.changes);
	}
	next = normalizeLegacyCommandsConfig(next, changes);
	next = normalizeLegacyOpenAICodexModelsAddMetadata(next, changes);
	return {
		config: next,
		changes
	};
}
//#endregion
//#region src/commands/doctor/emit-notes.ts
function sanitizeDoctorNote(note) {
	return note.split("\n").map((line) => sanitizeForLog(line)).join("\n");
}
function emitDoctorNotes(params) {
	for (const change of params.changeNotes ?? []) params.note(sanitizeDoctorNote(change), "Doctor changes");
	for (const info of params.infoNotes ?? []) params.note(sanitizeDoctorNote(info), "Doctor info");
	for (const warning of params.warningNotes ?? []) params.note(sanitizeDoctorNote(warning), "Doctor warnings");
}
//#endregion
//#region src/commands/doctor/finalize-config-flow.ts
async function finalizeDoctorConfigFlow(params) {
	if (!params.shouldRepair && params.pendingChanges) {
		if (await params.confirm({
			message: "Apply recommended config repairs now?",
			initialValue: true
		})) return {
			cfg: params.candidate,
			shouldWriteConfig: true
		};
		if (params.fixHints.length > 0) params.note(params.fixHints.join("\n"), "Doctor");
		return {
			cfg: params.cfg,
			shouldWriteConfig: false
		};
	}
	if (params.shouldRepair && params.pendingChanges) return {
		cfg: params.cfg,
		shouldWriteConfig: true
	};
	return {
		cfg: params.cfg,
		shouldWriteConfig: false
	};
}
//#endregion
//#region src/commands/doctor-auth-profile-config.ts
const AUTH_PROFILE_MODES = new Set([
	"api_key",
	"aws-sdk",
	"oauth",
	"token"
]);
function normalizeProviderId(value) {
	return normalizeLowercaseStringOrEmpty(value);
}
function normalizeProfileId(value) {
	return normalizeOptionalString(value) ?? null;
}
function normalizeMode(value) {
	return typeof value === "string" && AUTH_PROFILE_MODES.has(value) ? value : null;
}
function extractProviderFromModelRef(value) {
	const { model } = splitTrailingAuthProfile(value);
	const slash = model.indexOf("/");
	if (slash <= 0) return null;
	return normalizeProviderId(model.slice(0, slash)) || null;
}
function extractProviderFromProfileId(profileId) {
	const colon = profileId.indexOf(":");
	if (colon <= 0) return null;
	return normalizeProviderId(profileId.slice(0, colon)) || null;
}
function collectActiveAuthHints(config) {
	const activeProviders = /* @__PURE__ */ new Set();
	const explicitProfileIds = /* @__PURE__ */ new Set();
	const explicitProfileProviders = /* @__PURE__ */ new Map();
	const models = isRecord$1(config.models) ? config.models : {};
	const providers = isRecord$1(models.providers) ? models.providers : {};
	for (const providerId of Object.keys(providers)) {
		const normalized = normalizeProviderId(providerId);
		if (normalized) activeProviders.add(normalized);
	}
	for (const { value } of collectConfiguredModelRefs(config)) {
		const { profile } = splitTrailingAuthProfile(value);
		const provider = extractProviderFromModelRef(value);
		if (profile) {
			explicitProfileIds.add(profile);
			if (provider) {
				const providers = explicitProfileProviders.get(profile) ?? /* @__PURE__ */ new Set();
				providers.add(provider);
				explicitProfileProviders.set(profile, providers);
			}
		}
		if (provider) activeProviders.add(provider);
	}
	const auth = isRecord$1(config.auth) ? config.auth : {};
	const order = isRecord$1(auth.order) ? auth.order : {};
	for (const [providerId, profileIds] of Object.entries(order)) {
		const provider = normalizeProviderId(providerId);
		if (!provider || !activeProviders.has(provider) || !Array.isArray(profileIds)) continue;
		for (const profileId of profileIds) {
			const normalized = normalizeProfileId(profileId);
			if (normalized) explicitProfileIds.add(normalized);
		}
	}
	return {
		activeProviders,
		explicitProfileIds,
		explicitProfileProviders
	};
}
function isValidProfileMetadata(value) {
	if (!isRecord$1(value)) return false;
	return normalizeProviderId(value.provider) !== "" && normalizeMode(value.mode) !== null;
}
function buildProfileMetadata(params) {
	const before = isRecord$1(params.before) ? params.before : {};
	const after = isRecord$1(params.after) ? params.after : {};
	const provider = normalizeProviderId(after.provider) || normalizeProviderId(before.provider) || extractProviderFromProfileId(params.profileId) || normalizeProviderId(params.providerHint);
	if (!provider) return null;
	const repaired = {
		provider,
		mode: normalizeMode(after.mode) ?? normalizeMode(before.mode) ?? "api_key"
	};
	const email = normalizeOptionalString(after.email) ?? normalizeOptionalString(before.email);
	const displayName = normalizeOptionalString(after.displayName) ?? normalizeOptionalString(before.displayName);
	if (email) repaired.email = email;
	if (displayName) repaired.displayName = displayName;
	return repaired;
}
function ensureAuthProfiles(config) {
	const root = config;
	const auth = isRecord$1(root.auth) ? root.auth : {};
	if (root.auth !== auth) root.auth = auth;
	if (!isRecord$1(auth.profiles)) auth.profiles = {};
	return auth.profiles;
}
function protectActiveAuthProfileConfig(params) {
	const { activeProviders, explicitProfileIds, explicitProfileProviders } = collectActiveAuthHints(params.before);
	const beforeAuth = isRecord$1(params.before.auth) ? params.before.auth : {};
	const beforeProfiles = isRecord$1(beforeAuth.profiles) ? beforeAuth.profiles : {};
	if (Object.keys(beforeProfiles).length === 0) return {
		config: params.after,
		repairs: [],
		warnings: []
	};
	const config = structuredClone(params.after);
	const afterAuth = isRecord$1(config.auth) ? config.auth : {};
	const afterProfiles = isRecord$1(afterAuth.profiles) ? afterAuth.profiles : {};
	const repairs = [];
	const warnings = [];
	for (const [profileId, beforeProfile] of Object.entries(beforeProfiles)) {
		const afterProfile = afterProfiles[profileId];
		const afterProfileRecord = isRecord$1(afterProfile) ? afterProfile : null;
		const beforeProfileRecord = isRecord$1(beforeProfile) ? beforeProfile : null;
		if (isValidProfileMetadata(afterProfile)) continue;
		const provider = normalizeProviderId(afterProfileRecord?.provider) || normalizeProviderId(beforeProfileRecord?.provider) || extractProviderFromProfileId(profileId);
		const protectsActiveProvider = !!provider && activeProviders.has(provider);
		const protectsExplicitProfile = explicitProfileIds.has(profileId);
		if (!protectsActiveProvider && !protectsExplicitProfile) continue;
		const repaired = buildProfileMetadata({
			profileId,
			before: beforeProfile,
			after: afterProfile,
			providerHint: explicitProfileProviders.get(profileId)?.size === 1 ? [...explicitProfileProviders.get(profileId) ?? []][0] : void 0
		});
		if (!repaired) {
			warnings.push(`auth.profiles.${profileId}: active auth profile metadata could not be inferred; repair manually before running doctor --fix.`);
			continue;
		}
		const profiles = ensureAuthProfiles(config);
		profiles[profileId] = repaired;
		repairs.push(`Repaired auth.profiles.${profileId} metadata for active ${repaired.provider} auth.`);
	}
	return {
		config,
		repairs,
		warnings
	};
}
//#endregion
//#region src/commands/doctor/shared/config-flow-steps.ts
function applyLegacyCompatibilityStep(params) {
	if (params.snapshot.legacyIssues.length === 0) return {
		state: params.state,
		issueLines: [],
		changeLines: []
	};
	const issueLines = formatConfigIssueLines(params.snapshot.legacyIssues, "-");
	const { config: migrated, changes, partiallyValid } = migrateLegacyConfig(params.snapshot.parsed);
	if (!migrated) return {
		state: {
			...params.state,
			pendingChanges: params.state.pendingChanges || params.snapshot.legacyIssues.length > 0,
			fixHints: params.shouldRepair ? params.state.fixHints : [...params.state.fixHints, `Run "${params.doctorFixCommand}" to migrate legacy config keys.`]
		},
		issueLines,
		changeLines: changes
	};
	return {
		state: {
			cfg: migrated,
			candidate: migrated,
			pendingChanges: params.state.pendingChanges || params.snapshot.legacyIssues.length > 0,
			fixHints: params.shouldRepair ? params.state.fixHints : [...params.state.fixHints, `Run "${params.doctorFixCommand}" to ${partiallyValid ? "finish fixing" : "migrate"} legacy config keys.`]
		},
		issueLines,
		changeLines: changes,
		partiallyValid: partiallyValid === true ? true : void 0
	};
}
function applyUnknownConfigKeyStep(params) {
	const unknown = stripUnknownConfigKeys(params.state.candidate);
	if (unknown.removed.length === 0) return {
		state: params.state,
		removed: [],
		repairs: [],
		warnings: []
	};
	const protectedAuth = protectActiveAuthProfileConfig({
		before: params.state.candidate,
		after: unknown.config
	});
	return {
		state: {
			cfg: params.shouldRepair ? protectedAuth.config : params.state.cfg,
			candidate: protectedAuth.config,
			pendingChanges: true,
			fixHints: params.shouldRepair ? params.state.fixHints : [...params.state.fixHints, `Run "${params.doctorFixCommand}" to remove these keys.`]
		},
		removed: unknown.removed,
		repairs: protectedAuth.repairs,
		warnings: protectedAuth.warnings
	};
}
//#endregion
//#region src/commands/doctor/shared/default-account-warnings.ts
function normalizeBindingChannelKey(raw) {
	const normalized = normalizeChatChannelId(raw);
	if (normalized) return normalized;
	return normalizeLowercaseStringOrEmpty(raw);
}
function collectChannelsMissingDefaultAccount(cfg) {
	const channels = asObjectRecord(cfg.channels);
	if (!channels) return [];
	const contexts = [];
	for (const [channelKey, rawChannel] of Object.entries(channels)) {
		const channel = asObjectRecord(rawChannel);
		if (!channel) continue;
		const accounts = asObjectRecord(channel.accounts);
		if (!accounts) continue;
		const normalizedAccountIds = Array.from(new Set(Object.keys(accounts).map((accountId) => normalizeAccountId(accountId)).filter(Boolean))).toSorted((a, b) => a.localeCompare(b));
		if (normalizedAccountIds.length === 0 || normalizedAccountIds.includes("default")) continue;
		contexts.push({
			channelKey,
			channel,
			normalizedAccountIds
		});
	}
	return contexts;
}
function collectMissingDefaultAccountBindingWarnings(cfg) {
	const bindings = listRouteBindings(cfg);
	const warnings = [];
	for (const { channelKey, normalizedAccountIds } of collectChannelsMissingDefaultAccount(cfg)) {
		const accountIdSet = new Set(normalizedAccountIds);
		const channelPattern = normalizeBindingChannelKey(channelKey);
		let hasWildcardBinding = false;
		const coveredAccountIds = /* @__PURE__ */ new Set();
		for (const binding of bindings) {
			const bindingRecord = asObjectRecord(binding);
			if (!bindingRecord) continue;
			const match = asObjectRecord(bindingRecord.match);
			if (!match) continue;
			const matchChannel = typeof match.channel === "string" ? normalizeBindingChannelKey(match.channel) : "";
			if (!matchChannel || matchChannel !== channelPattern) continue;
			const rawAccountId = normalizeOptionalString(match.accountId) ?? "";
			if (!rawAccountId) continue;
			if (rawAccountId === "*") {
				hasWildcardBinding = true;
				continue;
			}
			const normalizedBindingAccountId = normalizeAccountId(rawAccountId);
			if (accountIdSet.has(normalizedBindingAccountId)) coveredAccountIds.add(normalizedBindingAccountId);
		}
		if (hasWildcardBinding) continue;
		const uncoveredAccountIds = normalizedAccountIds.filter((accountId) => !coveredAccountIds.has(accountId));
		if (uncoveredAccountIds.length === 0) continue;
		if (coveredAccountIds.size > 0) {
			warnings.push(`- channels.${channelKey}: accounts.default is missing and account bindings only cover a subset of configured accounts. Uncovered accounts: ${uncoveredAccountIds.join(", ")}. Add bindings[].match.accountId for uncovered accounts (or "*"), or add ${formatChannelAccountsDefaultPath(channelKey)}.`);
			continue;
		}
		warnings.push(`- channels.${channelKey}: accounts.default is missing and no valid account-scoped binding exists for configured accounts (${normalizedAccountIds.join(", ")}). Channel-only bindings (no accountId) match only default. Add bindings[].match.accountId for one of these accounts (or "*"), or add ${formatChannelAccountsDefaultPath(channelKey)}.`);
	}
	return warnings;
}
function collectMissingExplicitDefaultAccountWarnings(cfg) {
	const warnings = [];
	for (const { channelKey, channel, normalizedAccountIds } of collectChannelsMissingDefaultAccount(cfg)) {
		if (normalizedAccountIds.length < 2) continue;
		const preferredDefault = normalizeOptionalAccountId(typeof channel.defaultAccount === "string" ? channel.defaultAccount : void 0);
		if (preferredDefault) {
			if (normalizedAccountIds.includes(preferredDefault)) continue;
			warnings.push(`- channels.${channelKey}: defaultAccount is set to "${preferredDefault}" but does not match configured accounts (${normalizedAccountIds.join(", ")}). ${formatSetExplicitDefaultToConfiguredInstruction({ channelKey })} to avoid fallback routing.`);
			continue;
		}
		warnings.push(`- channels.${channelKey}: multiple accounts are configured but no explicit default is set. ${formatSetExplicitDefaultInstruction(channelKey)} to avoid fallback routing.`);
	}
	return warnings;
}
//#endregion
//#region src/commands/doctor-config-flow.ts
function hasLegacyInternalHookHandlers(raw) {
	const handlers = raw?.hooks?.internal?.handlers;
	return Array.isArray(handlers) && handlers.length > 0;
}
function collectInvalidHookTransformsDirWarnings(cfg, configPath) {
	const transformsDir = cfg.hooks?.transformsDir?.trim();
	if (!transformsDir) return [];
	const configDir = path.dirname(configPath);
	const transformsRoot = path.join(configDir, "hooks", "transforms");
	const resolved = path.isAbsolute(transformsDir) ? path.resolve(transformsDir) : path.resolve(transformsRoot, transformsDir);
	const relative = path.relative(transformsRoot, resolved);
	if (!(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) return [];
	return [`- hooks.transformsDir: ${transformsDir} is outside ${transformsRoot}. Hook transform modules must live under ${transformsRoot}; move custom transforms there or remove hooks.transformsDir.`];
}
function collectConfiguredChannelIds(cfg) {
	const channels = cfg.channels && typeof cfg.channels === "object" && !Array.isArray(cfg.channels) ? cfg.channels : null;
	if (!channels) return [];
	return Object.keys(channels).filter((channelId) => channelId !== "defaults");
}
function emitDoctorChangesPanel(changeLines, shouldRepair, options = {}) {
	if (changeLines.length === 0) return;
	const body = changeLines.join("\n");
	note(options.sanitize ? sanitizeDoctorNote(body) : body, shouldRepair ? "Doctor changes" : "Doctor changes preview");
}
async function loadAndMaybeMigrateDoctorConfig(params) {
	const shouldRepair = params.options.repair === true || params.options.yes === true;
	const preflight = await runDoctorConfigPreflight({ repairPrefixedConfig: shouldRepair });
	let snapshot = preflight.snapshot;
	const baseCfg = preflight.baseConfig;
	let cfg = baseCfg;
	let candidate = structuredClone(baseCfg);
	let pendingChanges = false;
	let fixHints = [];
	const doctorFixCommand = formatCliCommand("openclaw doctor --fix");
	const sourceMeta = snapshot.sourceConfig?.meta;
	const sourceLastTouchedVersion = typeof sourceMeta?.lastTouchedVersion === "string" ? sourceMeta.lastTouchedVersion : void 0;
	const legacyStep = applyLegacyCompatibilityStep({
		snapshot,
		state: {
			cfg,
			candidate,
			pendingChanges,
			fixHints
		},
		shouldRepair,
		doctorFixCommand
	});
	({cfg, candidate, pendingChanges, fixHints} = legacyStep.state);
	const legacyMigrationPartiallyValid = legacyStep.partiallyValid === true;
	const pluginLegacyIssues = await (async () => {
		if (snapshot.parsed === snapshot.sourceConfig) return [];
		const { findDoctorLegacyConfigIssues } = await import("./legacy-config-issues-Czu0_ffE.js");
		return findDoctorLegacyConfigIssues(snapshot.parsed, snapshot.parsed);
	})();
	const seenLegacyIssues = new Set(snapshot.legacyIssues.map((issue) => `${issue.path}:${issue.message}`));
	const pluginIssueLines = pluginLegacyIssues.filter((issue) => {
		const key = `${issue.path}:${issue.message}`;
		if (seenLegacyIssues.has(key)) return false;
		seenLegacyIssues.add(key);
		return true;
	}).map((issue) => `- ${issue.path}: ${issue.message}`);
	const legacyIssueLines = [...legacyStep.issueLines, ...pluginIssueLines];
	if (pluginIssueLines.length > 0 && !shouldRepair && !fixHints.includes(`Run "${doctorFixCommand}" to migrate legacy config keys.`)) fixHints = [...fixHints, `Run "${doctorFixCommand}" to migrate legacy config keys.`];
	if (legacyIssueLines.length > 0) note(legacyIssueLines.join("\n"), "Legacy config keys detected");
	emitDoctorChangesPanel(legacyStep.changeLines, shouldRepair);
	if (hasLegacyInternalHookHandlers(snapshot.parsed)) note([
		"- hooks.internal.handlers: legacy inline hook modules are no longer part of the public config surface.",
		"- Migrate each entry to a managed or workspace hook directory with HOOK.md + handler.js, then enable it through hooks.internal.entries.<hookKey> as needed.",
		"- openclaw doctor --fix does not rewrite this shape automatically."
	].join("\n"), "Legacy config keys detected");
	const hookTransformsDirWarnings = collectInvalidHookTransformsDirWarnings(cfg, snapshot.path);
	if (hookTransformsDirWarnings.length > 0) note(sanitizeDoctorNote(hookTransformsDirWarnings.join("\n")), "Doctor warnings");
	const normalized = normalizeCompatibilityConfigValues(candidate);
	if (normalized.changes.length > 0) {
		emitDoctorChangesPanel(normalized.changes, shouldRepair);
		({cfg, candidate, pendingChanges, fixHints} = applyDoctorConfigMutation({
			state: {
				cfg,
				candidate,
				pendingChanges,
				fixHints
			},
			mutation: normalized,
			shouldRepair,
			fixHint: `Run "${doctorFixCommand}" to apply these changes.`
		}));
	}
	const { applyPluginAutoEnable } = await import("./plugin-auto-enable-BMI9kQdv.js");
	const autoEnable = applyPluginAutoEnable({
		config: candidate,
		env: process.env
	});
	if (autoEnable.changes.length > 0) {
		emitDoctorChangesPanel(autoEnable.changes, shouldRepair);
		({cfg, candidate, pendingChanges, fixHints} = applyDoctorConfigMutation({
			state: {
				cfg,
				candidate,
				pendingChanges,
				fixHints
			},
			mutation: autoEnable,
			shouldRepair,
			fixHint: `Run "${doctorFixCommand}" to apply these changes.`
		}));
	}
	const { collectBundledProviderAllowlistPolicyWarnings, collectPluginToolAllowlistWarnings } = await import("./plugin-tool-allowlist-warnings-CRlsLNrw.js");
	const pluginToolAllowlistWarnings = [...collectPluginToolAllowlistWarnings({
		cfg: candidate,
		env: process.env
	}), ...collectBundledProviderAllowlistPolicyWarnings({ cfg: candidate })];
	if (pluginToolAllowlistWarnings.length > 0) note(sanitizeDoctorNote(pluginToolAllowlistWarnings.join("\n")), "Doctor warnings");
	const hasConfiguredChannels = collectConfiguredChannelIds(candidate).length > 0;
	let collectMutableAllowlistWarnings;
	if (hasConfiguredChannels) {
		const channelDoctor = await import("./channel-doctor-BrnniJHy.js");
		collectMutableAllowlistWarnings = channelDoctor.collectChannelDoctorMutableAllowlistWarnings;
		const channelDoctorSequence = await channelDoctor.runChannelDoctorConfigSequences({
			cfg: candidate,
			env: process.env,
			shouldRepair
		});
		emitDoctorNotes({
			note,
			changeNotes: channelDoctorSequence.changeNotes,
			warningNotes: channelDoctorSequence.warningNotes
		});
		for (const staleCleanup of await channelDoctor.collectChannelDoctorStaleConfigMutations(candidate, { env: process.env })) {
			if (staleCleanup.changes.length === 0) continue;
			emitDoctorChangesPanel(staleCleanup.changes, shouldRepair, { sanitize: true });
			({cfg, candidate, pendingChanges, fixHints} = applyDoctorConfigMutation({
				state: {
					cfg,
					candidate,
					pendingChanges,
					fixHints
				},
				mutation: staleCleanup,
				shouldRepair,
				fixHint: `Run "${doctorFixCommand}" to remove stale channel plugin references.`
			}));
		}
	}
	const missingDefaultAccountBindingWarnings = collectMissingDefaultAccountBindingWarnings(candidate);
	if (missingDefaultAccountBindingWarnings.length > 0) note(missingDefaultAccountBindingWarnings.join("\n"), "Doctor warnings");
	const missingExplicitDefaultWarnings = collectMissingExplicitDefaultAccountWarnings(candidate);
	if (missingExplicitDefaultWarnings.length > 0) note(missingExplicitDefaultWarnings.join("\n"), "Doctor warnings");
	if (shouldRepair) {
		const { runDoctorRepairSequence } = await import("./repair-sequencing-CO0b7lrW.js");
		const repairSequence = await runDoctorRepairSequence({
			state: {
				cfg,
				candidate,
				pendingChanges,
				fixHints
			},
			doctorFixCommand,
			env: process.env
		});
		({cfg, candidate, pendingChanges, fixHints} = repairSequence.state);
		emitDoctorNotes({
			note,
			changeNotes: repairSequence.changeNotes,
			warningNotes: repairSequence.warningNotes
		});
	} else {
		const { collectDoctorPreviewNotes } = await import("./preview-warnings-E9fk_M-l.js");
		const previewNotes = await collectDoctorPreviewNotes({
			cfg: candidate,
			doctorFixCommand,
			env: process.env
		});
		emitDoctorNotes({
			note,
			infoNotes: previewNotes.infoNotes,
			warningNotes: previewNotes.warningNotes
		});
	}
	const mutableAllowlistWarnings = collectMutableAllowlistWarnings ? await collectMutableAllowlistWarnings({
		cfg: candidate,
		env: process.env
	}) : [];
	if (mutableAllowlistWarnings.length > 0) note(sanitizeDoctorNote(mutableAllowlistWarnings.join("\n")), "Doctor warnings");
	const unknownStep = applyUnknownConfigKeyStep({
		state: {
			cfg,
			candidate,
			pendingChanges,
			fixHints
		},
		shouldRepair,
		doctorFixCommand
	});
	({cfg, candidate, pendingChanges, fixHints} = unknownStep.state);
	if (unknownStep.removed.length > 0 || unknownStep.repairs.length > 0) note([...unknownStep.removed.map((path) => `- ${path}`), ...unknownStep.repairs.map((change) => `- ${change}`)].join("\n"), shouldRepair ? "Doctor changes" : "Unknown config keys");
	if (unknownStep.warnings.length > 0) note(unknownStep.warnings.join("\n"), "Doctor warnings");
	const finalized = await finalizeDoctorConfigFlow({
		cfg,
		candidate,
		pendingChanges,
		shouldRepair,
		fixHints,
		confirm: params.confirm,
		note
	});
	cfg = finalized.cfg;
	noteOpencodeProviderOverrides(cfg);
	noteImplicitFallbackClobberWarnings(cfg);
	return {
		cfg,
		path: snapshot.path ?? CONFIG_PATH,
		shouldWriteConfig: finalized.shouldWriteConfig,
		sourceConfigValid: snapshot.valid,
		preservedLegacyRootKeys: ["defaultModel"],
		...sourceLastTouchedVersion ? { sourceLastTouchedVersion } : {},
		...legacyMigrationPartiallyValid ? { skipPluginValidationOnWrite: true } : {}
	};
}
//#endregion
export { loadAndMaybeMigrateDoctorConfig };
