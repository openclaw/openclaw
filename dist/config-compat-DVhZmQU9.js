import { i as asOptionalRecord, o as readStringField } from "./record-coerce-aMlBWINm.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as VoiceCallConfigSchema } from "./config-Ct8zalEd.js";
//#region extensions/voice-call/src/config-compat.ts
const VOICE_CALL_LEGACY_CONFIG_REMOVAL_VERSION = "2026.6.0";
const asObject = asOptionalRecord;
const getString = readStringField;
function getNumber(obj, key) {
	const value = obj?.[key];
	return typeof value === "number" ? value : void 0;
}
function mergeProviderConfig(providersValue, providerId, compatValues) {
	if (Object.keys(compatValues).length === 0) return asObject(providersValue);
	const providers = asObject(providersValue) ?? {};
	const existing = asObject(providers[providerId]) ?? {};
	return {
		...providers,
		[providerId]: {
			...existing,
			...compatValues
		}
	};
}
function collectVoiceCallLegacyConfigIssues(value) {
	const raw = asObject(value) ?? {};
	const twilio = asObject(raw.twilio);
	const streaming = asObject(raw.streaming);
	const issues = [];
	if (raw.provider === "log") issues.push({
		path: "provider",
		replacement: "provider",
		message: "Replace provider \"log\" with \"mock\"."
	});
	if (typeof twilio?.from === "string") issues.push({
		path: "twilio.from",
		replacement: "fromNumber",
		message: "Move twilio.from to fromNumber."
	});
	if (typeof streaming?.sttProvider === "string") issues.push({
		path: "streaming.sttProvider",
		replacement: "streaming.provider",
		message: "Move streaming.sttProvider to streaming.provider."
	});
	if (typeof streaming?.openaiApiKey === "string") issues.push({
		path: "streaming.openaiApiKey",
		replacement: "streaming.providers.openai.apiKey",
		message: "Move streaming.openaiApiKey to streaming.providers.openai.apiKey."
	});
	if (typeof streaming?.sttModel === "string") issues.push({
		path: "streaming.sttModel",
		replacement: "streaming.providers.openai.model",
		message: "Move streaming.sttModel to streaming.providers.openai.model."
	});
	if (typeof streaming?.silenceDurationMs === "number") issues.push({
		path: "streaming.silenceDurationMs",
		replacement: "streaming.providers.openai.silenceDurationMs",
		message: "Move streaming.silenceDurationMs to streaming.providers.openai.silenceDurationMs."
	});
	if (typeof streaming?.vadThreshold === "number") issues.push({
		path: "streaming.vadThreshold",
		replacement: "streaming.providers.openai.vadThreshold",
		message: "Move streaming.vadThreshold to streaming.providers.openai.vadThreshold."
	});
	return issues;
}
function formatVoiceCallLegacyConfigWarnings(params) {
	const issues = collectVoiceCallLegacyConfigIssues(params.value);
	if (issues.length === 0) return [];
	return [`[voice-call] legacy config keys detected under ${params.configPathPrefix}; runtime loading will not rewrite them, and support for the legacy shape will be removed in ${VOICE_CALL_LEGACY_CONFIG_REMOVAL_VERSION}. Run "${params.doctorFixCommand}".`, ...issues.map((issue) => `[voice-call] ${params.configPathPrefix}.${issue.path}: ${issue.message}`)];
}
function migrateVoiceCallLegacyConfigInput(params) {
	const raw = asObject(params.value) ?? {};
	const twilio = asObject(raw.twilio);
	const streaming = asObject(raw.streaming);
	const configPathPrefix = params.configPathPrefix ?? "plugins.entries.voice-call.config";
	const issues = collectVoiceCallLegacyConfigIssues(raw);
	const legacyStreamingOpenAICompat = {};
	const streamingOpenAIApiKey = getString(streaming, "openaiApiKey");
	if (streamingOpenAIApiKey) legacyStreamingOpenAICompat.apiKey = streamingOpenAIApiKey;
	const streamingSttModel = getString(streaming, "sttModel");
	if (streamingSttModel) legacyStreamingOpenAICompat.model = streamingSttModel;
	const streamingSilenceDurationMs = getNumber(streaming, "silenceDurationMs");
	if (streamingSilenceDurationMs !== void 0) legacyStreamingOpenAICompat.silenceDurationMs = streamingSilenceDurationMs;
	const streamingVadThreshold = getNumber(streaming, "vadThreshold");
	if (streamingVadThreshold !== void 0) legacyStreamingOpenAICompat.vadThreshold = streamingVadThreshold;
	const streamingProvider = getString(streaming, "provider");
	const legacyStreamingProvider = getString(streaming, "sttProvider");
	const normalizedStreaming = streaming ? {
		...streaming,
		provider: streamingProvider ?? legacyStreamingProvider,
		providers: mergeProviderConfig(streaming.providers, "openai", legacyStreamingOpenAICompat)
	} : void 0;
	if (normalizedStreaming) {
		delete normalizedStreaming.sttProvider;
		delete normalizedStreaming.openaiApiKey;
		delete normalizedStreaming.sttModel;
		delete normalizedStreaming.silenceDurationMs;
		delete normalizedStreaming.vadThreshold;
	}
	const normalizedTwilio = twilio ? { ...twilio } : void 0;
	if (normalizedTwilio) delete normalizedTwilio.from;
	const config = {
		...raw,
		provider: raw.provider === "log" ? "mock" : raw.provider,
		fromNumber: raw.fromNumber ?? (typeof twilio?.from === "string" ? twilio.from : void 0),
		twilio: normalizedTwilio,
		streaming: normalizedStreaming
	};
	const changes = [];
	if (raw.provider === "log") changes.push(`Moved ${configPathPrefix}.provider "log" → "mock".`);
	if (typeof twilio?.from === "string" && typeof raw.fromNumber !== "string") changes.push(`Moved ${configPathPrefix}.twilio.from → ${configPathPrefix}.fromNumber.`);
	if (typeof streaming?.sttProvider === "string") changes.push(`Moved ${configPathPrefix}.streaming.sttProvider → ${configPathPrefix}.streaming.provider.`);
	if (typeof streaming?.openaiApiKey === "string") changes.push(`Moved ${configPathPrefix}.streaming.openaiApiKey → ${configPathPrefix}.streaming.providers.openai.apiKey.`);
	if (typeof streaming?.sttModel === "string") changes.push(`Moved ${configPathPrefix}.streaming.sttModel → ${configPathPrefix}.streaming.providers.openai.model.`);
	if (typeof streaming?.silenceDurationMs === "number") changes.push(`Moved ${configPathPrefix}.streaming.silenceDurationMs → ${configPathPrefix}.streaming.providers.openai.silenceDurationMs.`);
	if (typeof streaming?.vadThreshold === "number") changes.push(`Moved ${configPathPrefix}.streaming.vadThreshold → ${configPathPrefix}.streaming.providers.openai.vadThreshold.`);
	return {
		config,
		changes,
		issues
	};
}
function normalizeVoiceCallLegacyConfigInput(value) {
	return migrateVoiceCallLegacyConfigInput({ value }).config;
}
function parseVoiceCallPluginConfig(value) {
	return VoiceCallConfigSchema.parse(normalizeVoiceCallLegacyConfigInput(value));
}
//#endregion
export { parseVoiceCallPluginConfig as i, migrateVoiceCallLegacyConfigInput as n, normalizeVoiceCallLegacyConfigInput as r, formatVoiceCallLegacyConfigWarnings as t };
