import { i as redactSensitiveText } from "../../redact-1fZUZMlV.js";
import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "../../string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "../../errors-QN8rySzW.js";
import { d as resolveConfigDir, p as resolveUserPath } from "../../utils-D5swhEXt.js";
import { b as isVerbose } from "../../logger-CQ0p51p4.js";
import { n as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-DItE5Xhf.js";
import { r as logVerbose } from "../../globals-BHVmraBM.js";
import { g as selectApplicableRuntimeConfig, i as getRuntimeConfigSnapshot, s as getRuntimeConfigSourceSnapshot } from "../../runtime-snapshot-Dmp4nHnj.js";
import { m as resolveSendableOutboundReplyParts } from "../../reply-payload-4x-lSxGs.js";
import { n as normalizeTtsAutoMode } from "../../tts-auto-mode-CKCtDRTw.js";
import { n as resolveEffectiveTtsConfig } from "../../tts-config-Cj2gxvsj.js";
import { i as normalizeSpeechProviderId, n as getSpeechProvider, r as listSpeechProviders, t as canonicalizeSpeechProviderId } from "../../provider-registry-CDGSCEoJ.js";
import { n as parseTtsDirectives } from "../../directives-DrPy6OM5.js";
import { r as stripMarkdown } from "../../text-runtime-FOsx_CPC.js";
import "../../error-runtime-RY0qqoh6.js";
import { t as resolveChannelTtsVoiceDelivery } from "../../channel-targets-c18sQnt-.js";
import "../../sandbox-qtjKjr-t.js";
import "../../runtime-env-DyZrKYOx.js";
import "../../runtime-config-snapshot-CGsgy2BE.js";
import { a as scheduleCleanup } from "../../tts-provider-helpers-rbwu1IrH.js";
import { t as summarizeText } from "../../speech-core-Co-fxNKQ.js";
import "../../logging-core-KfhbscUq.js";
import "../../api-DKKaIGQC.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
//#region extensions/speech-core/src/audio-transcode.ts
/**
* Best-effort audio container transcode using macOS `afconvert`.
*
* Used by the TTS pipeline to pre-encode synthesized audio into a channel's
* preferred container (see `ChannelTtsVoiceDeliveryCapabilities.preferAudioFileFormat`)
* so the channel's downstream does not have to perform a container
* conversion of its own. Returns a discriminated outcome so callers can
* distinguish "we didn't try" (platform/recipe/noop) from "we tried and the
* transcoder failed", which is the case worth logging.
*
* Currently only macOS is supported because `afconvert` is the only widely
* available encoder we ship a recipe for.
*/
async function transcodeAudioBuffer(params) {
	const source = normalizeExt(params.sourceExtension);
	const target = normalizeExt(params.targetExtension);
	if (!source || !target) return {
		ok: false,
		reason: "invalid-extension"
	};
	if (source === target) return {
		ok: false,
		reason: "noop-same-container"
	};
	const recipe = pickAfconvertRecipe(source, target);
	if (!recipe) return {
		ok: false,
		reason: "no-recipe"
	};
	if (process.platform !== "darwin") return {
		ok: false,
		reason: "platform-unsupported"
	};
	const tmpRoot = resolvePreferredOpenClawTmpDir();
	mkdirSync(tmpRoot, {
		recursive: true,
		mode: 448
	});
	const tmpDir = mkdtempSync(join(tmpRoot, "tts-transcode-"));
	const inPath = join(tmpDir, `in.${source}`);
	const outPath = join(tmpDir, `out.${target}`);
	try {
		writeFileSync(inPath, params.audioBuffer, { mode: 384 });
		const result = await runAfconvert({
			args: [
				...recipe,
				inPath,
				outPath
			],
			timeoutMs: params.timeoutMs ?? 5e3
		});
		if (!result.ok) return {
			ok: false,
			reason: "transcoder-failed",
			detail: result.detail
		};
		return {
			ok: true,
			buffer: readFileSync(outPath)
		};
	} catch (err) {
		return {
			ok: false,
			reason: "transcoder-failed",
			detail: err.message
		};
	} finally {
		try {
			rmSync(tmpDir, {
				recursive: true,
				force: true
			});
		} catch {}
	}
}
function normalizeExt(ext) {
	const trimmed = ext.trim().toLowerCase().replace(/^\./, "");
	return /^[a-z0-9]{1,12}$/.test(trimmed) ? trimmed : void 0;
}
function pickAfconvertRecipe(source, target) {
	if (target === "caf") return [
		"-f",
		"caff",
		"-d",
		"opus@24000",
		"-c",
		"1"
	];
}
function runAfconvert(params) {
	return new Promise((resolve) => {
		const child = spawn("/usr/bin/afconvert", params.args, { stdio: "ignore" });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({
				ok: false,
				detail: `timeout-${params.timeoutMs}ms`
			});
		}, params.timeoutMs);
		child.once("error", (err) => {
			clearTimeout(timer);
			resolve({
				ok: false,
				detail: err.message
			});
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve({ ok: true });
			else resolve({
				ok: false,
				detail: `exit-${code ?? "unknown"}`
			});
		});
	});
}
//#endregion
//#region extensions/speech-core/src/tts.ts
const DEFAULT_TIMEOUT_MS = 3e4;
const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;
const DEFAULT_MAX_TEXT_LENGTH = 4096;
let lastTtsAttempt;
function resolveConfiguredTtsAutoMode(raw) {
	return normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off");
}
function normalizeConfiguredSpeechProviderId(providerId) {
	const normalized = normalizeSpeechProviderId(providerId);
	if (!normalized) return;
	return normalized === "edge" ? "microsoft" : normalized;
}
function normalizeTtsPersonaId(personaId) {
	return normalizeOptionalLowercaseString(personaId ?? void 0);
}
function resolveTtsPrefsPathValue(prefsPath) {
	if (prefsPath?.trim()) return resolveUserPath(prefsPath.trim());
	const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
	if (envPath) return resolveUserPath(envPath);
	return path.join(resolveConfigDir(process.env), "settings", "tts.json");
}
function resolveModelOverridePolicy(overrides) {
	if (!(overrides?.enabled ?? true)) return {
		enabled: false,
		allowText: false,
		allowProvider: false,
		allowVoice: false,
		allowModelId: false,
		allowVoiceSettings: false,
		allowNormalization: false,
		allowSeed: false
	};
	const allow = (value, defaultValue = true) => value ?? defaultValue;
	return {
		enabled: true,
		allowText: allow(overrides?.allowText),
		allowProvider: allow(overrides?.allowProvider, false),
		allowVoice: allow(overrides?.allowVoice),
		allowModelId: allow(overrides?.allowModelId),
		allowVoiceSettings: allow(overrides?.allowVoiceSettings),
		allowNormalization: allow(overrides?.allowNormalization),
		allowSeed: allow(overrides?.allowSeed)
	};
}
function sortSpeechProvidersForAutoSelection(cfg) {
	return listSpeechProviders(cfg).toSorted((left, right) => {
		const leftOrder = left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
		const rightOrder = right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
		if (leftOrder !== rightOrder) return leftOrder - rightOrder;
		return left.id.localeCompare(right.id);
	});
}
function resolveTtsRuntimeConfig(cfg) {
	return selectApplicableRuntimeConfig({
		inputConfig: cfg,
		runtimeConfig: getRuntimeConfigSnapshot(),
		runtimeSourceConfig: getRuntimeConfigSourceSnapshot()
	}) ?? cfg;
}
function asProviderConfig(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function asProviderConfigMap(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function hasOwnProperty(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}
function normalizeProviderConfigMap(value) {
	const rawMap = asProviderConfigMap(value);
	if (Object.keys(rawMap).length === 0) return;
	const next = {};
	for (const [providerId, providerConfig] of Object.entries(rawMap)) {
		const normalized = normalizeConfiguredSpeechProviderId(providerId) ?? providerId;
		next[normalized] = asProviderConfig(providerConfig);
	}
	return next;
}
function collectTtsPersonas(raw) {
	const rawPersonas = asProviderConfigMap(raw.personas);
	const personas = {};
	for (const [id, value] of Object.entries(rawPersonas)) {
		const normalizedId = normalizeTtsPersonaId(id);
		if (!normalizedId || typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const persona = value;
		personas[normalizedId] = {
			...persona,
			id: normalizedId,
			provider: normalizeConfiguredSpeechProviderId(persona.provider) ?? persona.provider,
			providers: normalizeProviderConfigMap(persona.providers)
		};
	}
	return personas;
}
function resolvePersonaProviderConfig(persona, providerId) {
	if (!persona?.providers) return;
	const normalized = normalizeConfiguredSpeechProviderId(providerId) ?? providerId;
	if (hasOwnProperty(persona.providers, normalized)) return persona.providers[normalized];
	if (hasOwnProperty(persona.providers, providerId)) return persona.providers[providerId];
}
function mergeProviderConfigWithPersona(params) {
	if (!params.persona) return {
		providerConfig: params.providerConfig,
		personaBinding: "none"
	};
	const personaProviderConfig = resolvePersonaProviderConfig(params.persona, params.providerId);
	if (!personaProviderConfig) return {
		providerConfig: params.providerConfig,
		personaBinding: "missing"
	};
	return {
		providerConfig: {
			...params.providerConfig,
			...personaProviderConfig
		},
		personaProviderConfig,
		personaBinding: "applied"
	};
}
function resolveRawProviderConfig(raw, providerId) {
	if (!raw) return {};
	return asProviderConfig(asProviderConfigMap(raw.providers)[providerId] ?? raw[providerId]);
}
function resolveLazyProviderConfig(config, providerId, cfg) {
	const canonical = normalizeConfiguredSpeechProviderId(providerId) ?? normalizeLowercaseStringOrEmpty(providerId);
	const existing = config.providerConfigs[canonical];
	const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : config.sourceConfig;
	if (existing && !effectiveCfg) return existing;
	const rawConfig = resolveRawProviderConfig(config.rawConfig, canonical);
	const resolvedProvider = getSpeechProvider(canonical, effectiveCfg);
	const next = effectiveCfg && resolvedProvider?.resolveConfig ? resolvedProvider.resolveConfig({
		cfg: effectiveCfg,
		rawConfig: {
			...config.rawConfig,
			providers: asProviderConfigMap(config.rawConfig?.providers)
		},
		timeoutMs: config.timeoutMs
	}) : rawConfig;
	config.providerConfigs[canonical] = next;
	return next;
}
function collectDirectProviderConfigEntries(raw) {
	const entries = {};
	const rawProviders = asProviderConfigMap(raw.providers);
	for (const [providerId, value] of Object.entries(rawProviders)) {
		const normalized = normalizeConfiguredSpeechProviderId(providerId) ?? providerId;
		entries[normalized] = asProviderConfig(value);
	}
	const reservedKeys = new Set([
		"auto",
		"enabled",
		"maxTextLength",
		"mode",
		"modelOverrides",
		"persona",
		"personas",
		"prefsPath",
		"provider",
		"providers",
		"summaryModel",
		"timeoutMs"
	]);
	for (const [key, value] of Object.entries(raw)) {
		if (reservedKeys.has(key)) continue;
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const normalized = normalizeConfiguredSpeechProviderId(key) ?? key;
		entries[normalized] ??= asProviderConfig(value);
	}
	return entries;
}
function getResolvedSpeechProviderConfig(config, providerId, cfg) {
	const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : config.sourceConfig;
	return resolveLazyProviderConfig(config, canonicalizeSpeechProviderId(providerId, effectiveCfg) ?? normalizeConfiguredSpeechProviderId(providerId) ?? normalizeLowercaseStringOrEmpty(providerId), effectiveCfg);
}
function resolveTtsConfig(cfg, contextOrAgentId) {
	cfg = resolveTtsRuntimeConfig(cfg);
	const raw = resolveEffectiveTtsConfig(cfg, contextOrAgentId);
	const providerSource = raw.provider ? "config" : "default";
	const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const auto = resolveConfiguredTtsAutoMode(raw);
	const persona = normalizeTtsPersonaId(raw.persona);
	return {
		auto,
		mode: raw.mode ?? "final",
		provider: normalizeConfiguredSpeechProviderId(raw.provider) ?? (providerSource === "config" ? normalizeOptionalLowercaseString(raw.provider) ?? "" : ""),
		providerSource,
		persona,
		personas: collectTtsPersonas(raw),
		summaryModel: normalizeOptionalString(raw.summaryModel),
		modelOverrides: resolveModelOverridePolicy(raw.modelOverrides),
		providerConfigs: collectDirectProviderConfigEntries(raw),
		prefsPath: raw.prefsPath,
		maxTextLength: raw.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
		timeoutMs,
		rawConfig: raw,
		sourceConfig: cfg
	};
}
function resolveTtsPrefsPath(config) {
	return resolveTtsPrefsPathValue(config.prefsPath);
}
function resolveTtsAutoModeFromPrefs(prefs) {
	const auto = normalizeTtsAutoMode(prefs.tts?.auto);
	if (auto) return auto;
	if (typeof prefs.tts?.enabled === "boolean") return prefs.tts.enabled ? "always" : "off";
}
function resolveTtsAutoMode(params) {
	const sessionAuto = normalizeTtsAutoMode(params.sessionAuto);
	if (sessionAuto) return sessionAuto;
	const prefsAuto = resolveTtsAutoModeFromPrefs(readPrefs(params.prefsPath));
	if (prefsAuto) return prefsAuto;
	return params.config.auto;
}
function resolveEffectiveTtsAutoState(params) {
	const raw = resolveEffectiveTtsConfig(params.cfg, {
		agentId: params.agentId,
		channelId: params.channelId,
		accountId: params.accountId
	});
	const prefsPath = resolveTtsPrefsPathValue(raw.prefsPath);
	const sessionAuto = normalizeTtsAutoMode(params.sessionAuto);
	if (sessionAuto) return {
		autoMode: sessionAuto,
		prefsPath
	};
	const prefsAuto = resolveTtsAutoModeFromPrefs(readPrefs(prefsPath));
	if (prefsAuto) return {
		autoMode: prefsAuto,
		prefsPath
	};
	return {
		autoMode: resolveConfiguredTtsAutoMode(raw),
		prefsPath
	};
}
function buildTtsSystemPromptHint(cfg, agentId) {
	cfg = resolveTtsRuntimeConfig(cfg);
	const { autoMode, prefsPath } = resolveEffectiveTtsAutoState({
		cfg,
		agentId
	});
	if (autoMode === "off") return;
	const persona = getTtsPersona(resolveTtsConfig(cfg, agentId), prefsPath);
	const maxLength = getTtsMaxLength(prefsPath);
	const summarize = isSummarizationEnabled(prefsPath) ? "on" : "off";
	return [
		"Voice (TTS) is enabled.",
		autoMode === "inbound" ? "Only use TTS when the user's last message includes audio/voice." : autoMode === "tagged" ? "Only use TTS when you include [[tts:key=value]] directives or a [[tts:text]]...[[/tts:text]] block." : void 0,
		persona ? `Active TTS persona: ${persona.label ?? persona.id}${persona.description ? ` - ${persona.description}` : ""}.` : void 0,
		`Keep spoken text ≤${maxLength} chars to avoid auto-summary (summary ${summarize}).`,
		"Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness."
	].filter(Boolean).join("\n");
}
function readPrefs(prefsPath) {
	try {
		if (!existsSync(prefsPath)) return {};
		return JSON.parse(readFileSync(prefsPath, "utf8"));
	} catch {
		return {};
	}
}
function atomicWriteFileSync(filePath, content) {
	const tmpPath = `${filePath}.tmp.${Date.now()}.${randomBytes(8).toString("hex")}`;
	writeFileSync(tmpPath, content, { mode: 384 });
	try {
		renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			unlinkSync(tmpPath);
		} catch {}
		throw err;
	}
}
function updatePrefs(prefsPath, update) {
	const prefs = readPrefs(prefsPath);
	update(prefs);
	mkdirSync(path.dirname(prefsPath), { recursive: true });
	atomicWriteFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}
function isTtsEnabled(config, prefsPath, sessionAuto) {
	return resolveTtsAutoMode({
		config,
		prefsPath,
		sessionAuto
	}) !== "off";
}
function setTtsAutoMode(prefsPath, mode) {
	updatePrefs(prefsPath, (prefs) => {
		const next = { ...prefs.tts };
		delete next.enabled;
		next.auto = mode;
		prefs.tts = next;
	});
}
function setTtsEnabled(prefsPath, enabled) {
	setTtsAutoMode(prefsPath, enabled ? "always" : "off");
}
function getTtsProvider(config, prefsPath) {
	const prefs = readPrefs(prefsPath);
	const prefsProvider = canonicalizeSpeechProviderId(prefs.tts?.provider) ?? normalizeConfiguredSpeechProviderId(prefs.tts?.provider);
	if (prefsProvider) return prefsProvider;
	const activePersona = resolveTtsPersonaFromPrefs(config, prefs);
	const personaProvider = canonicalizeSpeechProviderId(activePersona?.provider, config.sourceConfig) ?? normalizeConfiguredSpeechProviderId(activePersona?.provider);
	if (personaProvider && getSpeechProvider(personaProvider, config.sourceConfig)) return personaProvider;
	if (config.providerSource === "config") return normalizeConfiguredSpeechProviderId(config.provider) ?? config.provider;
	const effectiveCfg = config.sourceConfig;
	for (const provider of sortSpeechProvidersForAutoSelection(effectiveCfg)) if (provider.isConfigured({
		cfg: effectiveCfg,
		providerConfig: config.providerConfigs[provider.id] ?? {},
		timeoutMs: config.timeoutMs
	})) return provider.id;
	return config.provider;
}
function resolveTtsPersonaFromPrefs(config, prefs) {
	if (prefs.tts && hasOwnProperty(prefs.tts, "persona")) {
		const prefsPersona = normalizeTtsPersonaId(prefs.tts.persona);
		return prefsPersona ? config.personas[prefsPersona] : void 0;
	}
	const configPersona = normalizeTtsPersonaId(config.persona);
	return configPersona ? config.personas[configPersona] : void 0;
}
function getTtsPersona(config, prefsPath) {
	return resolveTtsPersonaFromPrefs(config, readPrefs(prefsPath));
}
function listTtsPersonas(config) {
	return Object.values(config.personas).toSorted((left, right) => left.id.localeCompare(right.id));
}
function setTtsPersona(prefsPath, persona) {
	updatePrefs(prefsPath, (prefs) => {
		const next = { ...prefs.tts };
		next.persona = normalizeTtsPersonaId(persona) ?? null;
		prefs.tts = next;
	});
}
function setTtsProvider(prefsPath, provider) {
	updatePrefs(prefsPath, (prefs) => {
		prefs.tts = {
			...prefs.tts,
			provider: canonicalizeSpeechProviderId(provider) ?? provider
		};
	});
}
function resolveExplicitTtsOverrides(params) {
	const cfg = resolveTtsRuntimeConfig(params.cfg);
	const providerInput = params.provider?.trim();
	const modelId = params.modelId?.trim();
	const voiceId = params.voiceId?.trim();
	const config = resolveTtsConfig(cfg, {
		agentId: params.agentId,
		channelId: params.channelId,
		accountId: params.accountId
	});
	const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
	const selectedProvider = canonicalizeSpeechProviderId(providerInput, cfg) ?? (modelId || voiceId ? getTtsProvider(config, prefsPath) : void 0);
	if (providerInput && !selectedProvider) throw new Error(`Unknown TTS provider "${providerInput}".`);
	if (!modelId && !voiceId) return selectedProvider ? { provider: selectedProvider } : {};
	if (!selectedProvider) throw new Error("TTS model or voice overrides require a resolved provider.");
	const provider = getSpeechProvider(selectedProvider, cfg);
	if (!provider) throw new Error(`speech provider ${selectedProvider} is not registered`);
	if (!provider.resolveTalkOverrides) throw new Error(`TTS provider "${selectedProvider}" does not support model or voice overrides.`);
	const providerOverrides = provider.resolveTalkOverrides({
		talkProviderConfig: {},
		params: {
			...voiceId ? { voiceId } : {},
			...modelId ? { modelId } : {}
		}
	});
	if ((voiceId || modelId) && (!providerOverrides || Object.keys(providerOverrides).length === 0)) throw new Error(`TTS provider "${selectedProvider}" ignored the requested model or voice overrides.`);
	const overridesRecord = providerOverrides;
	return {
		provider: selectedProvider,
		providerOverrides: { [provider.id]: overridesRecord }
	};
}
function getTtsMaxLength(prefsPath) {
	return readPrefs(prefsPath).tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH;
}
function setTtsMaxLength(prefsPath, maxLength) {
	updatePrefs(prefsPath, (prefs) => {
		prefs.tts = {
			...prefs.tts,
			maxLength
		};
	});
}
function isSummarizationEnabled(prefsPath) {
	return readPrefs(prefsPath).tts?.summarize ?? DEFAULT_TTS_SUMMARIZE;
}
function setSummarizationEnabled(prefsPath, enabled) {
	updatePrefs(prefsPath, (prefs) => {
		prefs.tts = {
			...prefs.tts,
			summarize: enabled
		};
	});
}
function getLastTtsAttempt() {
	return lastTtsAttempt;
}
function setLastTtsAttempt(entry) {
	lastTtsAttempt = entry;
}
function supportsNativeVoiceNoteTts(channel) {
	return resolveChannelTtsVoiceDelivery(channel) !== void 0;
}
function supportsTranscodedVoiceNoteTts(channel) {
	const delivery = resolveChannelTtsVoiceDelivery(channel);
	return delivery?.synthesisTarget === "voice-note" && delivery.transcodesAudio === true;
}
function resolveTtsSynthesisTarget(channel) {
	return resolveChannelTtsVoiceDelivery(channel)?.synthesisTarget ?? "audio-file";
}
function supportsAudioFileVoiceMemoOutput(params) {
	const formats = new Set(params.audioFileFormats?.map((format) => format.trim().toLowerCase()));
	if (formats.size === 0) return false;
	const extension = params.fileExtension?.trim().toLowerCase();
	if (extension && formats.has(extension.replace(/^\./, ""))) return true;
	const outputFormat = params.outputFormat?.trim().toLowerCase();
	return outputFormat ? formats.has(outputFormat) : false;
}
function shouldDeliverTtsAsVoice(params) {
	const delivery = resolveChannelTtsVoiceDelivery(params.channel);
	if (!delivery) return false;
	if (delivery.synthesisTarget === "audio-file") return params.target === "audio-file" && supportsAudioFileVoiceMemoOutput({
		fileExtension: params.fileExtension,
		outputFormat: params.outputFormat,
		audioFileFormats: delivery.audioFileFormats
	});
	if (params.target !== "voice-note") return false;
	return params.voiceCompatible === true || delivery.transcodesAudio === true;
}
function resolveTtsProviderOrder(primary, cfg) {
	const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : void 0;
	const normalizedPrimary = canonicalizeSpeechProviderId(primary, effectiveCfg) ?? primary;
	const ordered = new Set([normalizedPrimary]);
	for (const provider of sortSpeechProvidersForAutoSelection(effectiveCfg)) {
		const normalized = provider.id;
		if (normalized !== normalizedPrimary) ordered.add(normalized);
	}
	return [...ordered];
}
function isTtsProviderConfigured(config, provider, cfg) {
	const effectiveCfg = cfg ? resolveTtsRuntimeConfig(cfg) : config.sourceConfig;
	const resolvedProvider = getSpeechProvider(provider, effectiveCfg);
	if (!resolvedProvider) return false;
	return resolvedProvider.isConfigured({
		cfg: effectiveCfg,
		providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, effectiveCfg),
		timeoutMs: config.timeoutMs
	}) ?? false;
}
function formatTtsProviderError(provider, err) {
	const error = err instanceof Error ? err : new Error(String(err));
	if (error.name === "AbortError") return `${provider}: request timed out`;
	return `${provider}: ${redactSensitiveText(error.message)}`;
}
function sanitizeTtsErrorForLog(err) {
	return redactSensitiveText(formatErrorMessage(err)).replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}
function buildTtsFailureResult(errors, attemptedProviders, attempts, persona) {
	return {
		success: false,
		error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
		attemptedProviders,
		attempts,
		persona
	};
}
function resolveReadySpeechProvider(params) {
	const resolvedProvider = getSpeechProvider(params.provider, params.cfg);
	if (!resolvedProvider) return {
		kind: "skip",
		reasonCode: "no_provider_registered",
		message: `${params.provider}: no provider registered`
	};
	const merged = mergeProviderConfigWithPersona({
		providerConfig: getResolvedSpeechProviderConfig(params.config, resolvedProvider.id, params.cfg),
		persona: params.persona,
		providerId: resolvedProvider.id
	});
	if (params.persona?.fallbackPolicy === "fail" && merged.personaBinding === "missing") return {
		kind: "skip",
		reasonCode: "not_configured",
		message: `${params.provider}: persona ${params.persona.id} has no provider binding`,
		personaBinding: "missing"
	};
	if (!resolvedProvider.isConfigured({
		cfg: params.cfg,
		providerConfig: merged.providerConfig,
		timeoutMs: params.config.timeoutMs
	})) return {
		kind: "skip",
		reasonCode: "not_configured",
		message: `${params.provider}: not configured`
	};
	if (params.requireTelephony && !resolvedProvider.synthesizeTelephony) return {
		kind: "skip",
		reasonCode: "unsupported_for_telephony",
		message: `${params.provider}: unsupported for telephony`
	};
	return {
		kind: "ready",
		provider: resolvedProvider,
		providerConfig: merged.providerConfig,
		personaProviderConfig: merged.personaProviderConfig,
		synthesisPersona: params.persona?.fallbackPolicy === "provider-defaults" && merged.personaBinding === "missing" ? void 0 : params.persona,
		personaBinding: merged.personaBinding
	};
}
async function prepareSpeechSynthesis(params) {
	if (!params.provider.prepareSynthesis) return {
		text: params.text,
		providerConfig: params.providerConfig,
		providerOverrides: params.providerOverrides
	};
	const prepared = await params.provider.prepareSynthesis({
		text: params.text,
		cfg: params.cfg,
		providerConfig: params.providerConfig,
		providerOverrides: params.providerOverrides,
		persona: params.persona,
		personaProviderConfig: params.personaProviderConfig,
		target: params.target,
		timeoutMs: params.timeoutMs
	});
	return {
		text: prepared?.text ?? params.text,
		providerConfig: prepared?.providerConfig ? {
			...params.providerConfig,
			...prepared.providerConfig
		} : params.providerConfig,
		providerOverrides: prepared?.providerOverrides ? {
			...params.providerOverrides,
			...prepared.providerOverrides
		} : params.providerOverrides
	};
}
function resolveTtsRequestSetup(params) {
	const cfg = resolveTtsRuntimeConfig(params.cfg);
	const config = resolveTtsConfig(cfg, {
		agentId: params.agentId,
		channelId: params.channelId,
		accountId: params.accountId
	});
	const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
	if (params.text.length > config.maxTextLength) return { error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})` };
	const userProvider = getTtsProvider(config, prefsPath);
	const provider = canonicalizeSpeechProviderId(params.providerOverride, cfg) ?? userProvider;
	return {
		cfg,
		config,
		persona: getTtsPersona(config, prefsPath),
		providers: params.disableFallback ? [provider] : resolveTtsProviderOrder(provider, cfg)
	};
}
function readTtsResultString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function resolveTtsResultModel(providerConfig, providerOverrides) {
	return readTtsResultString(providerOverrides?.modelId) ?? readTtsResultString(providerOverrides?.model) ?? readTtsResultString(providerConfig.modelId) ?? readTtsResultString(providerConfig.model);
}
function resolveTtsResultVoice(providerConfig, providerOverrides) {
	return readTtsResultString(providerOverrides?.voiceId) ?? readTtsResultString(providerOverrides?.voiceName) ?? readTtsResultString(providerOverrides?.voice) ?? readTtsResultString(providerConfig.voiceId) ?? readTtsResultString(providerConfig.voiceName) ?? readTtsResultString(providerConfig.voice);
}
async function textToSpeech(params) {
	const synthesis = await synthesizeSpeech(params);
	if (!synthesis.success || !synthesis.audioBuffer || !synthesis.fileExtension) return {
		success: false,
		error: synthesis.error ?? "TTS conversion failed",
		persona: synthesis.persona,
		attemptedProviders: synthesis.attemptedProviders,
		attempts: synthesis.attempts
	};
	let audioBuffer = synthesis.audioBuffer;
	let fileExtension = synthesis.fileExtension;
	let outputFormat = synthesis.outputFormat;
	const transcoded = await maybePreTranscodeForVoiceDelivery({
		channel: params.channel,
		target: synthesis.target,
		audioBuffer,
		fileExtension,
		outputFormat
	});
	if (transcoded) {
		audioBuffer = transcoded.audioBuffer;
		fileExtension = transcoded.fileExtension;
		outputFormat = transcoded.outputFormat;
	}
	const tempRoot = resolvePreferredOpenClawTmpDir();
	mkdirSync(tempRoot, {
		recursive: true,
		mode: 448
	});
	const tempDir = mkdtempSync(path.join(tempRoot, "tts-"));
	const audioPath = path.join(tempDir, `voice-${Date.now()}${fileExtension}`);
	writeFileSync(audioPath, audioBuffer);
	scheduleCleanup(tempDir);
	return {
		success: true,
		audioPath,
		latencyMs: synthesis.latencyMs,
		provider: synthesis.provider,
		persona: synthesis.persona,
		fallbackFrom: synthesis.fallbackFrom,
		attemptedProviders: synthesis.attemptedProviders,
		attempts: synthesis.attempts,
		outputFormat,
		voiceCompatible: synthesis.voiceCompatible,
		audioAsVoice: shouldDeliverTtsAsVoice({
			channel: params.channel,
			target: synthesis.target,
			voiceCompatible: synthesis.voiceCompatible,
			fileExtension,
			outputFormat
		}),
		target: synthesis.target
	};
}
async function maybePreTranscodeForVoiceDelivery(params) {
	if (params.target !== "audio-file") return;
	const preferred = resolveChannelTtsVoiceDelivery(params.channel)?.preferAudioFileFormat?.trim().toLowerCase();
	if (!preferred) return;
	const sourceExt = params.fileExtension.trim().toLowerCase().replace(/^\./, "");
	if (sourceExt === preferred) return;
	const outcome = await transcodeAudioBuffer({
		audioBuffer: params.audioBuffer,
		sourceExtension: sourceExt,
		targetExtension: preferred
	});
	if (!outcome.ok) {
		if (outcome.reason === "transcoder-failed") logVerbose(`TTS: pre-transcode ${sourceExt}->${preferred} for channel=${params.channel ?? "?"} failed: ${outcome.detail ?? "unknown"}`);
		return;
	}
	return {
		audioBuffer: outcome.buffer,
		fileExtension: `.${preferred}`,
		outputFormat: preferred
	};
}
async function synthesizeSpeech(params) {
	const setup = resolveTtsRequestSetup({
		text: params.text,
		cfg: params.cfg,
		prefsPath: params.prefsPath,
		providerOverride: params.overrides?.provider,
		disableFallback: params.disableFallback,
		agentId: params.agentId,
		channelId: params.channel,
		accountId: params.accountId
	});
	if ("error" in setup) return {
		success: false,
		error: setup.error
	};
	const { cfg, config, persona, providers } = setup;
	const timeoutMs = params.timeoutMs ?? config.timeoutMs;
	const target = resolveTtsSynthesisTarget(params.channel);
	const errors = [];
	const attemptedProviders = [];
	const attempts = [];
	const primaryProvider = providers[0];
	logVerbose(`TTS: starting with provider ${primaryProvider}, fallbacks: ${providers.slice(1).join(", ") || "none"}`);
	for (const provider of providers) {
		attemptedProviders.push(provider);
		const providerStart = Date.now();
		try {
			const resolvedProvider = resolveReadySpeechProvider({
				provider,
				cfg,
				config,
				persona
			});
			if (resolvedProvider.kind === "skip") {
				errors.push(resolvedProvider.message);
				attempts.push({
					provider,
					outcome: "skipped",
					reasonCode: resolvedProvider.reasonCode,
					persona: persona?.id,
					...resolvedProvider.personaBinding ? { personaBinding: resolvedProvider.personaBinding } : {},
					error: resolvedProvider.message
				});
				logVerbose(`TTS: provider ${provider} skipped (${resolvedProvider.message})`);
				continue;
			}
			const prepared = await prepareSpeechSynthesis({
				provider: resolvedProvider.provider,
				text: params.text,
				cfg,
				providerConfig: resolvedProvider.providerConfig,
				providerOverrides: params.overrides?.providerOverrides?.[resolvedProvider.provider.id],
				persona: resolvedProvider.synthesisPersona,
				personaProviderConfig: resolvedProvider.personaProviderConfig,
				target,
				timeoutMs
			});
			const synthesis = await resolvedProvider.provider.synthesize({
				text: prepared.text,
				cfg,
				providerConfig: prepared.providerConfig,
				target,
				providerOverrides: prepared.providerOverrides,
				timeoutMs
			});
			const latencyMs = Date.now() - providerStart;
			attempts.push({
				provider,
				outcome: "success",
				reasonCode: "success",
				persona: persona?.id,
				personaBinding: resolvedProvider.personaBinding,
				latencyMs
			});
			return {
				success: true,
				audioBuffer: synthesis.audioBuffer,
				latencyMs,
				provider,
				providerModel: resolveTtsResultModel(prepared.providerConfig, prepared.providerOverrides),
				providerVoice: resolveTtsResultVoice(prepared.providerConfig, prepared.providerOverrides),
				persona: persona?.id,
				fallbackFrom: provider !== primaryProvider ? primaryProvider : void 0,
				attemptedProviders,
				attempts,
				outputFormat: synthesis.outputFormat,
				voiceCompatible: synthesis.voiceCompatible,
				fileExtension: synthesis.fileExtension,
				target
			};
		} catch (err) {
			const errorMsg = formatTtsProviderError(provider, err);
			const latencyMs = Date.now() - providerStart;
			errors.push(errorMsg);
			attempts.push({
				provider,
				outcome: "failed",
				reasonCode: err instanceof Error && err.name === "AbortError" ? "timeout" : "provider_error",
				latencyMs,
				persona: persona?.id,
				personaBinding: resolvePersonaProviderConfig(persona, provider) != null ? "applied" : persona ? "missing" : "none",
				error: errorMsg
			});
			const rawError = sanitizeTtsErrorForLog(err);
			if (provider === primaryProvider) logVerbose(`TTS: primary provider ${provider} failed (${rawError})${providers.length > 1 ? "; trying fallback providers." : "; no fallback providers configured."}`);
			else logVerbose(`TTS: ${provider} failed (${rawError}); trying next provider.`);
		}
	}
	return buildTtsFailureResult(errors, attemptedProviders, attempts, persona?.id);
}
async function textToSpeechTelephony(params) {
	const setup = resolveTtsRequestSetup({
		text: params.text,
		cfg: params.cfg,
		prefsPath: params.prefsPath,
		providerOverride: params.overrides?.provider
	});
	if ("error" in setup) return {
		success: false,
		error: setup.error
	};
	const { cfg, config, persona, providers } = setup;
	const errors = [];
	const attemptedProviders = [];
	const attempts = [];
	const primaryProvider = providers[0];
	logVerbose(`TTS telephony: starting with provider ${primaryProvider}, fallbacks: ${providers.slice(1).join(", ") || "none"}`);
	for (const provider of providers) {
		attemptedProviders.push(provider);
		const providerStart = Date.now();
		try {
			const resolvedProvider = resolveReadySpeechProvider({
				provider,
				cfg,
				config,
				persona,
				requireTelephony: true
			});
			if (resolvedProvider.kind === "skip") {
				errors.push(resolvedProvider.message);
				attempts.push({
					provider,
					outcome: "skipped",
					reasonCode: resolvedProvider.reasonCode,
					persona: persona?.id,
					...resolvedProvider.personaBinding ? { personaBinding: resolvedProvider.personaBinding } : {},
					error: resolvedProvider.message
				});
				logVerbose(`TTS telephony: provider ${provider} skipped (${resolvedProvider.message})`);
				continue;
			}
			const synthesizeTelephony = resolvedProvider.provider.synthesizeTelephony;
			const prepared = await prepareSpeechSynthesis({
				provider: resolvedProvider.provider,
				text: params.text,
				cfg,
				providerConfig: resolvedProvider.providerConfig,
				providerOverrides: params.overrides?.providerOverrides?.[resolvedProvider.provider.id],
				persona: resolvedProvider.synthesisPersona,
				personaProviderConfig: resolvedProvider.personaProviderConfig,
				target: "telephony",
				timeoutMs: config.timeoutMs
			});
			const synthesis = await synthesizeTelephony({
				text: prepared.text,
				cfg,
				providerConfig: prepared.providerConfig,
				providerOverrides: prepared.providerOverrides,
				timeoutMs: config.timeoutMs
			});
			const latencyMs = Date.now() - providerStart;
			attempts.push({
				provider,
				outcome: "success",
				reasonCode: "success",
				persona: persona?.id,
				personaBinding: resolvedProvider.personaBinding,
				latencyMs
			});
			return {
				success: true,
				audioBuffer: synthesis.audioBuffer,
				latencyMs,
				provider,
				providerModel: resolveTtsResultModel(prepared.providerConfig, prepared.providerOverrides),
				providerVoice: resolveTtsResultVoice(prepared.providerConfig, prepared.providerOverrides),
				persona: persona?.id,
				fallbackFrom: provider !== primaryProvider ? primaryProvider : void 0,
				attemptedProviders,
				attempts,
				outputFormat: synthesis.outputFormat,
				sampleRate: synthesis.sampleRate
			};
		} catch (err) {
			const errorMsg = formatTtsProviderError(provider, err);
			const latencyMs = Date.now() - providerStart;
			errors.push(errorMsg);
			attempts.push({
				provider,
				outcome: "failed",
				reasonCode: err instanceof Error && err.name === "AbortError" ? "timeout" : "provider_error",
				latencyMs,
				persona: persona?.id,
				personaBinding: resolvePersonaProviderConfig(persona, provider) != null ? "applied" : persona ? "missing" : "none",
				error: errorMsg
			});
			const rawError = sanitizeTtsErrorForLog(err);
			if (provider === primaryProvider) logVerbose(`TTS telephony: primary provider ${provider} failed (${rawError})${providers.length > 1 ? "; trying fallback providers." : "; no fallback providers configured."}`);
			else logVerbose(`TTS telephony: ${provider} failed (${rawError}); trying next provider.`);
		}
	}
	return buildTtsFailureResult(errors, attemptedProviders, attempts, persona?.id);
}
async function listSpeechVoices(params) {
	const cfg = params.cfg ? resolveTtsRuntimeConfig(params.cfg) : void 0;
	const provider = canonicalizeSpeechProviderId(params.provider, cfg);
	if (!provider) throw new Error("speech provider id is required");
	const config = params.config ?? (cfg ? resolveTtsConfig(cfg) : void 0);
	if (!config) throw new Error(`speech provider ${provider} requires cfg or resolved config`);
	const resolvedProvider = getSpeechProvider(provider, cfg);
	if (!resolvedProvider) throw new Error(`speech provider ${provider} is not registered`);
	if (!resolvedProvider.listVoices) throw new Error(`speech provider ${provider} does not support voice listing`);
	return await resolvedProvider.listVoices({
		cfg,
		providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, cfg),
		apiKey: params.apiKey,
		baseUrl: params.baseUrl
	});
}
async function maybeApplyTtsToPayload(params) {
	if (params.payload.isCompactionNotice) return params.payload;
	const cfg = resolveTtsRuntimeConfig(params.cfg);
	const { autoMode, prefsPath } = resolveEffectiveTtsAutoState({
		cfg,
		sessionAuto: params.ttsAuto,
		agentId: params.agentId,
		channelId: params.channel,
		accountId: params.accountId
	});
	if (autoMode === "off") return params.payload;
	const config = resolveTtsConfig(cfg, {
		agentId: params.agentId,
		channelId: params.channel,
		accountId: params.accountId
	});
	const activeProvider = getTtsProvider(config, prefsPath);
	const reply = resolveSendableOutboundReplyParts(params.payload);
	const text = reply.text;
	const directives = parseTtsDirectives(text, config.modelOverrides, {
		cfg,
		providerConfigs: config.providerConfigs,
		preferredProviderId: activeProvider
	});
	if (directives.warnings.length > 0) logVerbose(`TTS: ignored directive overrides (${directives.warnings.join("; ")})`);
	if (isVerbose()) {
		const effectiveProvider = directives.overrides?.provider ? canonicalizeSpeechProviderId(directives.overrides.provider, cfg) ?? activeProvider : activeProvider;
		logVerbose(`TTS: auto mode enabled (${autoMode}), channel=${params.channel}, selected provider=${effectiveProvider}, config.provider=${config.provider}, config.providerSource=${config.providerSource}`);
	}
	const trimmedCleaned = directives.cleanedText.trim();
	const visibleText = trimmedCleaned.length > 0 ? trimmedCleaned : "";
	const explicitTtsText = directives.ttsText?.trim() || "";
	const ttsText = explicitTtsText || visibleText;
	const nextPayload = visibleText === text.trim() ? params.payload : {
		...params.payload,
		text: visibleText.length > 0 ? visibleText : void 0
	};
	if (autoMode === "tagged" && !directives.hasDirective) return nextPayload;
	if (autoMode === "inbound" && params.inboundAudio !== true) return nextPayload;
	if ((config.mode ?? "final") === "final" && params.kind && params.kind !== "final") return nextPayload;
	if (!ttsText.trim()) return nextPayload;
	if (reply.hasMedia) return nextPayload;
	if (text.includes("MEDIA:")) return nextPayload;
	if (!explicitTtsText && ttsText.trim().length < 10) return nextPayload;
	const maxLength = getTtsMaxLength(prefsPath);
	let textForAudio = ttsText.trim();
	let wasSummarized = false;
	if (textForAudio.length > maxLength) if (!isSummarizationEnabled(prefsPath)) {
		logVerbose(`TTS: truncating long text (${textForAudio.length} > ${maxLength}), summarization disabled.`);
		textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
	} else try {
		textForAudio = (await summarizeText({
			text: textForAudio,
			targetLength: maxLength,
			cfg,
			config,
			timeoutMs: config.timeoutMs
		})).summary;
		wasSummarized = true;
		if (textForAudio.length > config.maxTextLength) {
			logVerbose(`TTS: summary exceeded hard limit (${textForAudio.length} > ${config.maxTextLength}); truncating.`);
			textForAudio = `${textForAudio.slice(0, config.maxTextLength - 3)}...`;
		}
	} catch (err) {
		logVerbose(`TTS: summarization failed, truncating instead: ${err.message}`);
		textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
	}
	textForAudio = stripMarkdown(textForAudio).trim();
	if (!textForAudio) return nextPayload;
	if (!explicitTtsText && textForAudio.length < 10) return nextPayload;
	const ttsStart = Date.now();
	const result = await textToSpeech({
		text: textForAudio,
		cfg,
		prefsPath,
		channel: params.channel,
		overrides: directives.overrides,
		agentId: params.agentId,
		accountId: params.accountId
	});
	if (result.success && result.audioPath) {
		lastTtsAttempt = {
			timestamp: Date.now(),
			success: true,
			textLength: text.length,
			summarized: wasSummarized,
			provider: result.provider,
			persona: result.persona,
			fallbackFrom: result.fallbackFrom,
			attemptedProviders: result.attemptedProviders,
			attempts: result.attempts,
			latencyMs: result.latencyMs
		};
		return {
			...nextPayload,
			mediaUrl: result.audioPath,
			audioAsVoice: result.audioAsVoice || params.payload.audioAsVoice,
			spokenText: textForAudio
		};
	}
	lastTtsAttempt = {
		timestamp: Date.now(),
		success: false,
		textLength: text.length,
		summarized: wasSummarized,
		persona: result.persona,
		attemptedProviders: result.attemptedProviders,
		attempts: result.attempts,
		error: result.error
	};
	logVerbose(`TTS: conversion failed after ${Date.now() - ttsStart}ms (${result.error ?? "unknown"}).`);
	return nextPayload;
}
const _test = {
	parseTtsDirectives,
	resolveModelOverridePolicy,
	supportsNativeVoiceNoteTts,
	supportsTranscodedVoiceNoteTts,
	resolveTtsSynthesisTarget,
	shouldDeliverTtsAsVoice,
	summarizeText,
	getResolvedSpeechProviderConfig,
	formatTtsProviderError,
	sanitizeTtsErrorForLog
};
//#endregion
export { _test, buildTtsSystemPromptHint, getLastTtsAttempt, getResolvedSpeechProviderConfig, getTtsMaxLength, getTtsPersona, getTtsProvider, isSummarizationEnabled, isTtsEnabled, isTtsProviderConfigured, listSpeechVoices, listTtsPersonas, maybeApplyTtsToPayload, resolveExplicitTtsOverrides, resolveTtsAutoMode, resolveTtsConfig, resolveTtsPrefsPath, resolveTtsProviderOrder, setLastTtsAttempt, setSummarizationEnabled, setTtsAutoMode, setTtsEnabled, setTtsMaxLength, setTtsPersona, setTtsProvider, synthesizeSpeech, textToSpeech, textToSpeechTelephony };
