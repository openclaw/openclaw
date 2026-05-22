import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { r as theme, t as colorize } from "./theme-CVJvORNs.js";
import { t as createLazyImportLoader } from "./lazy-promise-AiZRy56y.js";
import { g as shortenHomePath } from "./utils-D5swhEXt.js";
import { n as resolveAgentModelPrimaryValue, t as resolveAgentModelFallbackValues } from "./model-input-gjsFWrBi.js";
import { n as resolveDefaultAgentWorkspaceDir } from "./workspace-default-Bz2DImFN.js";
import { S as resolveDefaultAgentId, b as resolveAgentDir, i as resolveAgentExplicitModelPrimary, s as resolveAgentModelFallbacksOverride, x as resolveAgentWorkspaceDir } from "./agent-scope-CcybJBoN.js";
import { r as writeRuntimeJson } from "./runtime-bzt9CHmD.js";
import { r as normalizeProviderId } from "./provider-id-DIRgKpoh.js";
import { G as getShellEnvAppliedKeys, Y as shouldEnableShellEnvFallback, r as createConfigIO } from "./io-C04VWQdx.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-xppxcKrw.js";
import "./config-Dk0DnRek.js";
import { u as resolveAuthStorePathForDisplay } from "./source-check-CaD2hrdb.js";
import { h as loadPersistedAuthProfileStore, i as ensureAuthProfileStoreWithoutExternalProfiles } from "./store-CWaY5GDh.js";
import { N as resolveProviderSyntheticAuthWithPlugin } from "./provider-runtime-QoyUXw0b.js";
import { t as resolveOpenClawAgentDir } from "./agent-paths-CYt_vl-H.js";
import { C as parseModelRef, f as resolveConfiguredModelRef, h as resolveModelRefFromString, i as buildModelAliasIndex, x as modelKey } from "./model-selection-shared-BQtX8Bw-.js";
import { t as isCliProvider } from "./model-selection-cli-Dl_STjo6.js";
import "./model-selection-CyWx9aXc.js";
import { i as resolveAuthProfileDisplayLabel } from "./auth-profiles-BwVGW7W3.js";
import { n as listProfilesForProvider } from "./profile-list-DOXb6axb.js";
import "./profiles-CBkGkiws.js";
import { o as resolveProfileUnusableUntilForDisplay } from "./usage-BPAEZ9Bv.js";
import { b as resolveProviderEnvAuthEvidence, u as isNonSecretApiKeyMarker, v as listProviderEnvAuthLookupKeys, y as resolveProviderEnvApiKeyCandidates } from "./model-auth-markers-8j_EsMZw.js";
import { t as resolveEnvApiKey } from "./model-auth-env-DgoygRso.js";
import { d as resolveUsableCustomProviderApiKey, i as getCustomProviderApiKey } from "./model-auth-4K4rXeIE.js";
import "./workspace-BY7PlQ5_.js";
import { t as resolveRuntimeSyntheticAuthProviderRefs } from "./synthetic-auth.runtime.js";
import { n as ensureFlagCompatibility, s as resolveKnownAgentId } from "./shared-CuyMvlgj.js";
import { n as buildAuthHealthSummary, r as formatRemainingShort, t as DEFAULT_OAUTH_WARN_MS } from "./auth-health-DwfeV9rU.js";
import { t as maskApiKey } from "./mask-api-key-BSnQsfe8.js";
import { t as loadModelsConfig } from "./load-config-B96SvIur.js";
import { n as isRich } from "./list.format-430xE5sk.js";
import path from "node:path";
//#region src/commands/models/list.auth-overview.ts
function formatMarkerOrSecret(value) {
	return isNonSecretApiKeyMarker(value, { includeEnvVarName: false }) ? `marker(${value.trim()})` : maskApiKey(value);
}
function formatProfileSecretLabel(params) {
	const value = normalizeOptionalString(params.value) ?? "";
	if (value) {
		const display = formatMarkerOrSecret(value);
		return params.kind === "token" ? `token:${display}` : display;
	}
	if (params.ref) {
		const refLabel = `ref(${params.ref.source}:${params.ref.id})`;
		return params.kind === "token" ? `token:${refLabel}` : refLabel;
	}
	return params.kind === "token" ? "token:missing" : "missing";
}
function resolveProfileSourceAgentDir(params) {
	if (!params.agentDir || params.profileIds.length === 0) return params.agentDir;
	const localStore = loadPersistedAuthProfileStore(params.agentDir);
	if (params.profileIds.some((profileId) => Boolean(localStore?.profiles[profileId]))) return params.agentDir;
	const mainStore = loadPersistedAuthProfileStore(void 0);
	return params.profileIds.every((profileId) => Boolean(mainStore?.profiles[profileId])) ? void 0 : params.agentDir;
}
function resolveProviderAuthOverview(params) {
	const { provider, cfg, store } = params;
	const now = Date.now();
	const profiles = listProfilesForProvider(store, provider);
	const withUnusableSuffix = (base, profileId) => {
		const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId);
		if (!unusableUntil || now >= unusableUntil) return base;
		const stats = store.usageStats?.[profileId];
		return `${base} [${typeof stats?.disabledUntil === "number" && now < stats.disabledUntil ? `disabled${stats.disabledReason ? `:${stats.disabledReason}` : ""}` : "cooldown"} ${formatRemainingShort(unusableUntil - now)}]`;
	};
	const labels = profiles.map((profileId) => {
		const profile = store.profiles[profileId];
		if (!profile) return `${profileId}=missing`;
		if (profile.type === "api_key") return withUnusableSuffix(`${profileId}=${formatProfileSecretLabel({
			value: profile.key,
			ref: profile.keyRef,
			kind: "api-key"
		})}`, profileId);
		if (profile.type === "token") return withUnusableSuffix(`${profileId}=${formatProfileSecretLabel({
			value: profile.token,
			ref: profile.tokenRef,
			kind: "token"
		})}`, profileId);
		const display = resolveAuthProfileDisplayLabel({
			cfg,
			store,
			profileId
		});
		const suffix = display === profileId ? "" : display.startsWith(profileId) ? display.slice(profileId.length).trim() : `(${display})`;
		return withUnusableSuffix(`${profileId}=OAuth${suffix ? ` ${suffix}` : ""}`, profileId);
	});
	const oauthCount = profiles.filter((id) => store.profiles[id]?.type === "oauth").length;
	const tokenCount = profiles.filter((id) => store.profiles[id]?.type === "token").length;
	const apiKeyCount = profiles.filter((id) => store.profiles[id]?.type === "api_key").length;
	const envKey = resolveEnvApiKey(provider, process.env, {
		config: cfg,
		workspaceDir: params.workspaceDir
	});
	const customKey = getCustomProviderApiKey(cfg, provider);
	const usableCustomKey = resolveUsableCustomProviderApiKey({
		cfg,
		provider
	});
	return {
		provider,
		effective: (() => {
			if (profiles.length > 0) return {
				kind: "profiles",
				detail: shortenHomePath(resolveAuthStorePathForDisplay(resolveProfileSourceAgentDir({
					agentDir: params.agentDir,
					profileIds: profiles
				})))
			};
			if (envKey) {
				const normalizedSource = normalizeLowercaseStringOrEmpty(envKey.source);
				return {
					kind: "env",
					detail: envKey.source.includes("OAUTH_TOKEN") || normalizedSource.includes("oauth") ? "OAuth (env)" : maskApiKey(envKey.apiKey)
				};
			}
			if (usableCustomKey) return {
				kind: "models.json",
				detail: formatMarkerOrSecret(usableCustomKey.apiKey)
			};
			if (params.syntheticAuth) return {
				kind: "synthetic",
				detail: params.syntheticAuth.source
			};
			return {
				kind: "missing",
				detail: "missing"
			};
		})(),
		profiles: {
			count: profiles.length,
			oauth: oauthCount,
			token: tokenCount,
			apiKey: apiKeyCount,
			labels
		},
		...envKey ? { env: {
			value: (() => {
				const normalizedSource = normalizeLowercaseStringOrEmpty(envKey.source);
				return envKey.source.includes("OAUTH_TOKEN") || normalizedSource.includes("oauth") ? "OAuth (env)" : maskApiKey(envKey.apiKey);
			})(),
			source: envKey.source
		} } : {},
		...customKey ? { modelsJson: {
			value: formatMarkerOrSecret(customKey),
			source: `models.json: ${shortenHomePath(params.modelsPath)}`
		} } : {},
		...params.syntheticAuth ? { syntheticAuth: params.syntheticAuth } : {}
	};
}
//#endregion
//#region src/commands/models/list.status-command.ts
const providerUsageRuntimeLoader = createLazyImportLoader(() => import("./provider-usage-d48RhYQL.js"));
const progressRuntimeLoader = createLazyImportLoader(() => import("./progress-B9Z82WX_.js"));
const terminalTableRuntimeLoader = createLazyImportLoader(() => import("./table-BObiAfwR.js"));
const listProbeRuntimeLoader = createLazyImportLoader(() => import("./list.probe-BZad7VQK.js"));
const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false };
function loadProviderUsageRuntime() {
	return providerUsageRuntimeLoader.load();
}
function loadProgressRuntime() {
	return progressRuntimeLoader.load();
}
function loadTerminalTableRuntime() {
	return terminalTableRuntimeLoader.load();
}
function loadListProbeRuntime() {
	return listProbeRuntimeLoader.load();
}
function resolveProviderConfigForStatus(cfg, provider) {
	const providers = cfg.models?.providers ?? {};
	const direct = providers[provider];
	if (direct) return direct;
	const normalized = normalizeProviderId(provider);
	return providers[normalized] ?? Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1];
}
function syntheticAuthCredential(provider, auth) {
	if (!auth.mode) return;
	if (auth.mode === "api-key") return {
		type: "api_key",
		provider,
		key: auth.credential
	};
	if (auth.mode === "token") return {
		type: "token",
		provider,
		token: auth.credential,
		expires: auth.expiresAt
	};
	if (auth.expiresAt === void 0) return;
	return {
		type: "oauth",
		provider,
		access: auth.credential ?? "",
		refresh: "",
		expires: auth.expiresAt
	};
}
async function modelsStatusCommand(opts, runtime) {
	ensureFlagCompatibility(opts);
	if (opts.plain && opts.probe) throw new Error("--probe cannot be used with --plain output.");
	const configPath = createConfigIO().configPath;
	const cfg = await loadModelsConfig({
		commandName: "models status",
		runtime
	});
	const agentId = resolveKnownAgentId({
		cfg,
		rawAgentId: opts.agent
	});
	const agentDir = agentId ? resolveAgentDir(cfg, agentId) : resolveOpenClawAgentDir();
	const workspaceAgentId = agentId ?? resolveDefaultAgentId(cfg);
	const workspaceDir = resolveAgentWorkspaceDir(cfg, workspaceAgentId) ?? resolveDefaultAgentWorkspaceDir();
	const agentModelPrimary = agentId ? resolveAgentExplicitModelPrimary(cfg, agentId) : void 0;
	const agentFallbacksOverride = agentId ? resolveAgentModelFallbacksOverride(cfg, agentId) : void 0;
	const resolved = resolveConfiguredModelRef({
		cfg: agentModelPrimary && agentModelPrimary.length > 0 ? {
			...cfg,
			agents: {
				...cfg.agents,
				defaults: {
					...cfg.agents?.defaults,
					model: {
						...typeof cfg.agents?.defaults?.model === "object" ? cfg.agents.defaults.model : {},
						primary: agentModelPrimary
					}
				}
			}
		} : cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL,
		...DISPLAY_MODEL_PARSE_OPTIONS
	});
	const rawDefaultsModel = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "";
	const rawModel = agentModelPrimary ?? rawDefaultsModel;
	const resolvedLabel = modelKey(resolved.provider, resolved.model);
	const defaultLabel = rawModel || resolvedLabel;
	const defaultsFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
	const fallbacks = agentFallbacksOverride ?? defaultsFallbacks;
	const imageModel = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel) ?? "";
	const imageFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel);
	const aliases = Object.entries(cfg.agents?.defaults?.models ?? {}).reduce((acc, [key, entry]) => {
		const alias = normalizeOptionalString(entry?.alias);
		if (alias) acc[alias] = key;
		return acc;
	}, {});
	const allowed = Object.keys(cfg.agents?.defaults?.models ?? {});
	const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
	const modelsPath = path.join(agentDir, "models.json");
	const providersFromStore = new Set(Object.values(store.profiles).map((profile) => normalizeProviderId(profile.provider)).filter((p) => Boolean(p)));
	const providersFromConfig = new Set(Object.keys(cfg.models?.providers ?? {}).map((p) => typeof p === "string" ? normalizeProviderId(p) : "").filter(Boolean));
	const providersFromModels = /* @__PURE__ */ new Set();
	const providersInUse = /* @__PURE__ */ new Set();
	for (const raw of [
		defaultLabel,
		...fallbacks,
		imageModel,
		...imageFallbacks,
		...allowed
	]) {
		const parsed = parseModelRef(raw ?? "", DEFAULT_PROVIDER, DISPLAY_MODEL_PARSE_OPTIONS);
		if (parsed?.provider) providersFromModels.add(normalizeProviderId(parsed.provider));
	}
	for (const raw of [
		defaultLabel,
		...fallbacks,
		imageModel,
		...imageFallbacks
	]) {
		const parsed = parseModelRef(raw ?? "", DEFAULT_PROVIDER, DISPLAY_MODEL_PARSE_OPTIONS);
		if (parsed?.provider) providersInUse.add(normalizeProviderId(parsed.provider));
	}
	const providersFromEnv = /* @__PURE__ */ new Set();
	const envLookupParams = {
		config: cfg,
		workspaceDir
	};
	const envCandidateMap = resolveProviderEnvApiKeyCandidates(envLookupParams);
	const authEvidenceMap = resolveProviderEnvAuthEvidence(envLookupParams);
	for (const provider of listProviderEnvAuthLookupKeys({
		envCandidateMap,
		authEvidenceMap
	})) if (resolveEnvApiKey(provider, process.env, {
		config: cfg,
		workspaceDir,
		candidateMap: envCandidateMap,
		authEvidenceMap
	})) providersFromEnv.add(provider);
	const syntheticAuthByProvider = /* @__PURE__ */ new Map();
	for (const provider of resolveRuntimeSyntheticAuthProviderRefs()) {
		const normalized = normalizeProviderId(provider);
		const resolved = resolveProviderSyntheticAuthWithPlugin({
			provider: normalized,
			config: cfg,
			context: {
				config: cfg,
				provider: normalized,
				providerConfig: resolveProviderConfigForStatus(cfg, normalized)
			}
		});
		syntheticAuthByProvider.set(normalized, {
			value: "plugin-owned",
			source: resolved?.source ?? "plugin synthetic auth",
			credential: resolved?.apiKey,
			mode: resolved?.mode,
			expiresAt: resolved?.expiresAt
		});
	}
	const runtimeCredentialsByProvider = new Map(Array.from(syntheticAuthByProvider.entries()).map(([provider, auth]) => [provider, syntheticAuthCredential(provider, auth)]).filter((entry) => Boolean(entry[1])));
	const providers = Array.from(new Set([
		...providersFromStore,
		...providersFromConfig,
		...providersFromModels,
		...providersFromEnv
	])).map((p) => normalizeOptionalString(p) ?? "").filter(Boolean).toSorted((a, b) => a.localeCompare(b));
	const applied = getShellEnvAppliedKeys();
	const shellFallbackEnabled = shouldEnableShellEnvFallback(process.env) || cfg.env?.shellEnv?.enabled === true;
	const providerAuth = providers.map((provider) => resolveProviderAuthOverview({
		provider,
		cfg,
		store,
		modelsPath,
		agentDir,
		workspaceDir,
		syntheticAuth: syntheticAuthByProvider.get(provider)
	})).filter((entry) => {
		return entry.profiles.count > 0 || Boolean(entry.env) || Boolean(entry.modelsJson) || Boolean(entry.syntheticAuth);
	});
	const providerAuthMap = new Map(providerAuth.map((entry) => [entry.provider, entry]));
	const missingProvidersInUse = Array.from(providersInUse).filter((provider) => !providerAuthMap.has(provider)).filter((provider) => !syntheticAuthByProvider.has(provider)).filter((provider) => !isCliProvider(provider, cfg)).toSorted((a, b) => a.localeCompare(b));
	const probeProfileIds = (() => {
		if (!opts.probeProfile) return [];
		return (Array.isArray(opts.probeProfile) ? opts.probeProfile : [opts.probeProfile]).flatMap((value) => (value ?? "").split(",")).map((value) => value.trim()).filter(Boolean);
	})();
	const probeTimeoutMs = opts.probeTimeout ? Number(opts.probeTimeout) : 8e3;
	if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) throw new Error("--probe-timeout must be a positive number (ms).");
	const probeConcurrency = opts.probeConcurrency ? Number(opts.probeConcurrency) : 2;
	if (!Number.isFinite(probeConcurrency) || probeConcurrency <= 0) throw new Error("--probe-concurrency must be > 0.");
	const probeMaxTokens = opts.probeMaxTokens ? Number(opts.probeMaxTokens) : 8;
	if (!Number.isFinite(probeMaxTokens) || probeMaxTokens <= 0) throw new Error("--probe-max-tokens must be > 0.");
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		...DISPLAY_MODEL_PARSE_OPTIONS
	});
	const modelCandidates = [
		rawModel || resolvedLabel,
		...fallbacks,
		imageModel,
		...imageFallbacks,
		...allowed
	].filter(Boolean).map((raw) => resolveModelRefFromString({
		raw: raw ?? "",
		defaultProvider: DEFAULT_PROVIDER,
		aliasIndex,
		...DISPLAY_MODEL_PARSE_OPTIONS
	})?.ref).filter((ref) => Boolean(ref)).map((ref) => `${ref.provider}/${ref.model}`);
	let probeSummary;
	if (opts.probe) {
		const [{ withProgressTotals }, { runAuthProbes }] = await Promise.all([loadProgressRuntime(), loadListProbeRuntime()]);
		probeSummary = await withProgressTotals({
			label: "Probing auth profiles…",
			total: 1
		}, async (update) => {
			return await runAuthProbes({
				cfg,
				agentId: workspaceAgentId,
				agentDir,
				workspaceDir,
				providers,
				modelCandidates,
				options: {
					provider: opts.probeProvider,
					profileIds: probeProfileIds,
					timeoutMs: probeTimeoutMs,
					concurrency: probeConcurrency,
					maxTokens: probeMaxTokens
				},
				onProgress: update
			});
		});
	}
	const providersWithOauth = providerAuth.filter((entry) => entry.profiles.oauth > 0 || entry.profiles.token > 0 || entry.env?.value === "OAuth (env)").map((entry) => {
		const count = entry.profiles.oauth + entry.profiles.token + (entry.env?.value === "OAuth (env)" ? 1 : 0);
		return `${entry.provider} (${count})`;
	});
	const authHealth = buildAuthHealthSummary({
		store,
		cfg,
		warnAfterMs: DEFAULT_OAUTH_WARN_MS,
		runtimeCredentialsByProvider
	});
	const oauthProfiles = authHealth.profiles.filter((profile) => profile.type === "oauth" || profile.type === "token");
	const unusableProfiles = (() => {
		const now = Date.now();
		const out = [];
		for (const profileId of Object.keys(store.usageStats ?? {})) {
			const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId);
			if (!unusableUntil || now >= unusableUntil) continue;
			const stats = store.usageStats?.[profileId];
			const kind = typeof stats?.disabledUntil === "number" && now < stats.disabledUntil ? "disabled" : "cooldown";
			out.push({
				profileId,
				provider: store.profiles[profileId]?.provider,
				kind,
				reason: stats?.disabledReason,
				until: unusableUntil,
				remainingMs: unusableUntil - now
			});
		}
		return out.toSorted((a, b) => a.remainingMs - b.remainingMs);
	})();
	const checkStatus = (() => {
		const hasExpiredOrMissing = oauthProfiles.some((profile) => ["expired", "missing"].includes(profile.status)) || missingProvidersInUse.length > 0;
		const hasExpiring = oauthProfiles.some((profile) => profile.status === "expiring");
		if (hasExpiredOrMissing) return 1;
		if (hasExpiring) return 2;
		return 0;
	})();
	if (opts.json) {
		writeRuntimeJson(runtime, {
			configPath,
			...agentId ? { agentId } : {},
			agentDir,
			defaultModel: defaultLabel,
			resolvedDefault: resolvedLabel,
			fallbacks,
			imageModel: imageModel || null,
			imageFallbacks,
			...agentId ? { modelConfig: {
				defaultSource: agentModelPrimary ? "agent" : "defaults",
				fallbacksSource: agentFallbacksOverride !== void 0 ? "agent" : "defaults"
			} } : {},
			aliases,
			allowed,
			auth: {
				storePath: resolveAuthStorePathForDisplay(agentDir),
				shellEnvFallback: {
					enabled: shellFallbackEnabled,
					appliedKeys: applied
				},
				providersWithOAuth: providersWithOauth,
				missingProvidersInUse,
				providers: providerAuth,
				unusableProfiles,
				oauth: {
					warnAfterMs: authHealth.warnAfterMs,
					profiles: authHealth.profiles,
					providers: authHealth.providers
				},
				probes: probeSummary
			}
		});
		if (opts.check) runtime.exit(checkStatus);
		return;
	}
	if (opts.plain) {
		runtime.log(resolvedLabel);
		if (opts.check) runtime.exit(checkStatus);
		return;
	}
	const rich = isRich(opts);
	const label = (value) => colorize(rich, theme.accent, value.padEnd(14));
	const labelWithSource = (value, source) => label(source ? `${value} (${source})` : value);
	const displayDefault = rawModel && rawModel !== resolvedLabel ? `${resolvedLabel} (from ${rawModel})` : resolvedLabel;
	runtime.log(`${label("Config")}${colorize(rich, theme.muted, ":")} ${colorize(rich, theme.info, shortenHomePath(configPath))}`);
	runtime.log(`${label("Agent dir")}${colorize(rich, theme.muted, ":")} ${colorize(rich, theme.info, shortenHomePath(agentDir))}`);
	runtime.log(`${labelWithSource("Default", agentId ? agentModelPrimary ? "agent" : "defaults" : void 0)}${colorize(rich, theme.muted, ":")} ${colorize(rich, theme.success, displayDefault)}`);
	runtime.log(`${labelWithSource(`Fallbacks (${fallbacks.length || 0})`, agentId ? agentFallbacksOverride !== void 0 ? "agent" : "defaults" : void 0)}${colorize(rich, theme.muted, ":")} ${colorize(rich, fallbacks.length ? theme.warn : theme.muted, fallbacks.length ? fallbacks.join(", ") : "-")}`);
	runtime.log(`${labelWithSource("Image model", agentId ? "defaults" : void 0)}${colorize(rich, theme.muted, ":")} ${colorize(rich, imageModel ? theme.accentBright : theme.muted, imageModel || "-")}`);
	runtime.log(`${labelWithSource(`Image fallbacks (${imageFallbacks.length || 0})`, agentId ? "defaults" : void 0)}${colorize(rich, theme.muted, ":")} ${colorize(rich, imageFallbacks.length ? theme.accentBright : theme.muted, imageFallbacks.length ? imageFallbacks.join(", ") : "-")}`);
	runtime.log(`${label(`Aliases (${Object.keys(aliases).length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(rich, Object.keys(aliases).length ? theme.accent : theme.muted, Object.keys(aliases).length ? Object.entries(aliases).map(([alias, target]) => rich ? `${theme.accentDim(alias)} ${theme.muted("->")} ${theme.info(target)}` : `${alias} -> ${target}`).join(", ") : "-")}`);
	runtime.log(`${label(`Configured models (${allowed.length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(rich, allowed.length ? theme.info : theme.muted, allowed.length ? allowed.join(", ") : "all")}`);
	runtime.log("");
	runtime.log(colorize(rich, theme.heading, "Auth overview"));
	runtime.log(`${label("Auth store")}${colorize(rich, theme.muted, ":")} ${colorize(rich, theme.info, shortenHomePath(resolveAuthStorePathForDisplay(agentDir)))}`);
	runtime.log(`${label("Shell env")}${colorize(rich, theme.muted, ":")} ${colorize(rich, shellFallbackEnabled ? theme.success : theme.muted, shellFallbackEnabled ? "on" : "off")}${applied.length ? colorize(rich, theme.muted, ` (applied: ${applied.join(", ")})`) : ""}`);
	runtime.log(`${label(`Providers w/ OAuth/tokens (${providersWithOauth.length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(rich, providersWithOauth.length ? theme.info : theme.muted, providersWithOauth.length ? providersWithOauth.join(", ") : "-")}`);
	const formatKey = (key) => colorize(rich, theme.warn, key);
	const formatKeyValue = (key, value) => `${formatKey(key)}=${colorize(rich, theme.info, value)}`;
	const formatSeparator = () => colorize(rich, theme.muted, " | ");
	for (const entry of providerAuth) {
		const separator = formatSeparator();
		const bits = [];
		bits.push(formatKeyValue("effective", `${colorize(rich, theme.accentBright, entry.effective.kind)}:${colorize(rich, theme.muted, entry.effective.detail)}`));
		if (entry.profiles.count > 0) {
			bits.push(formatKeyValue("profiles", `${entry.profiles.count} (oauth=${entry.profiles.oauth}, token=${entry.profiles.token}, api_key=${entry.profiles.apiKey})`));
			if (entry.profiles.labels.length > 0) bits.push(colorize(rich, theme.info, entry.profiles.labels.join(", ")));
		}
		if (entry.env) bits.push(formatKeyValue("env", `${entry.env.value}${separator}${formatKeyValue("source", entry.env.source)}`));
		if (entry.modelsJson) bits.push(formatKeyValue("models.json", `${entry.modelsJson.value}${separator}${formatKeyValue("source", entry.modelsJson.source)}`));
		if (entry.syntheticAuth) bits.push(formatKeyValue("synthetic", `${entry.syntheticAuth.value}${separator}${formatKeyValue("source", entry.syntheticAuth.source)}`));
		runtime.log(`- ${theme.heading(entry.provider)} ${bits.join(separator)}`);
	}
	if (missingProvidersInUse.length > 0) {
		const { buildProviderAuthRecoveryHint } = await import("./provider-auth-guidance-CErOCIcl.js");
		runtime.log("");
		runtime.log(colorize(rich, theme.heading, "Missing auth"));
		for (const provider of missingProvidersInUse) {
			const hint = buildProviderAuthRecoveryHint({
				provider,
				config: cfg,
				includeEnvVar: true
			});
			runtime.log(`- ${theme.heading(provider)} ${hint}`);
		}
	}
	runtime.log("");
	runtime.log(colorize(rich, theme.heading, "OAuth/token status"));
	if (oauthProfiles.length === 0) runtime.log(colorize(rich, theme.muted, "- none"));
	else {
		const { formatUsageWindowSummary, loadProviderUsageSummary, resolveUsageProviderId } = await loadProviderUsageRuntime();
		const usageByProvider = /* @__PURE__ */ new Map();
		const usageProviders = Array.from(new Set(oauthProfiles.map((profile) => resolveUsageProviderId(profile.provider)).filter((provider) => Boolean(provider))));
		if (usageProviders.length > 0) try {
			const usageSummary = await loadProviderUsageSummary({
				providers: usageProviders,
				agentDir,
				timeoutMs: 3500
			});
			for (const snapshot of usageSummary.providers) {
				const formatted = formatUsageWindowSummary(snapshot, {
					now: Date.now(),
					maxWindows: 2,
					includeResets: true
				});
				if (formatted) usageByProvider.set(snapshot.provider, formatted);
			}
		} catch {}
		const formatStatus = (status) => {
			if (status === "ok") return colorize(rich, theme.success, "ok");
			if (status === "static") return colorize(rich, theme.muted, "static");
			if (status === "expiring") return colorize(rich, theme.warn, "expiring");
			if (status === "missing") return colorize(rich, theme.warn, "unknown");
			return colorize(rich, theme.error, "expired");
		};
		const profilesByProvider = /* @__PURE__ */ new Map();
		for (const profile of oauthProfiles) {
			const current = profilesByProvider.get(profile.provider);
			if (current) current.push(profile);
			else profilesByProvider.set(profile.provider, [profile]);
		}
		for (const [provider, profiles] of profilesByProvider) {
			const usageKey = resolveUsageProviderId(provider);
			const usage = usageKey ? usageByProvider.get(usageKey) : void 0;
			const usageSuffix = usage ? colorize(rich, theme.muted, ` usage: ${usage}`) : "";
			runtime.log(`- ${colorize(rich, theme.heading, provider)}${usageSuffix}`);
			for (const profile of profiles) {
				const labelText = profile.label || profile.profileId;
				const label = colorize(rich, theme.accent, labelText);
				const status = formatStatus(profile.status);
				const expiry = profile.status === "static" ? "" : profile.expiresAt ? ` expires in ${formatRemainingShort(profile.remainingMs)}` : " expires unknown";
				runtime.log(`  - ${label} ${status}${expiry}`);
			}
		}
	}
	if (probeSummary) {
		const [{ getTerminalTableWidth, renderTable }, { describeProbeSummary, formatProbeLatency, sortProbeResults }] = await Promise.all([loadTerminalTableRuntime(), loadListProbeRuntime()]);
		runtime.log("");
		runtime.log(colorize(rich, theme.heading, "Auth probes"));
		if (probeSummary.results.length === 0) runtime.log(colorize(rich, theme.muted, "- none"));
		else {
			const tableWidth = getTerminalTableWidth();
			const sorted = sortProbeResults(probeSummary.results);
			const statusColor = (status) => {
				if (status === "ok") return theme.success;
				if (status === "rate_limit") return theme.warn;
				if (status === "timeout" || status === "billing") return theme.warn;
				if (status === "auth" || status === "format") return theme.error;
				if (status === "no_model") return theme.muted;
				return theme.muted;
			};
			const rows = sorted.map((result) => {
				const status = colorize(rich, statusColor(result.status), result.status);
				const latency = formatProbeLatency(result.latencyMs);
				const modelLabel = result.model ?? `${result.provider}/-`;
				const modeLabel = result.mode ? ` ${colorize(rich, theme.muted, `(${result.mode})`)}` : "";
				const profile = `${colorize(rich, theme.accent, result.label)}${modeLabel}`;
				const detail = result.error?.trim();
				const detailLabel = detail ? `\n${colorize(rich, theme.muted, `↳ ${detail}`)}` : "";
				const statusLabel = `${status}${colorize(rich, theme.muted, ` · ${latency}`)}${detailLabel}`;
				return {
					Model: colorize(rich, theme.heading, modelLabel),
					Profile: profile,
					Status: statusLabel
				};
			});
			runtime.log(renderTable({
				width: tableWidth,
				columns: [
					{
						key: "Model",
						header: "Model",
						minWidth: 18
					},
					{
						key: "Profile",
						header: "Profile",
						minWidth: 24
					},
					{
						key: "Status",
						header: "Status",
						minWidth: 12
					}
				],
				rows
			}).trimEnd());
			runtime.log(colorize(rich, theme.muted, describeProbeSummary(probeSummary)));
		}
	}
	if (opts.check) runtime.exit(checkStatus);
}
//#endregion
export { modelsStatusCommand };
