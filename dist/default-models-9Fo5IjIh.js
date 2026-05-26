import { m as ensureModelAllowlistEntry, n as applyAgentDefaultModelPrimary } from "./provider-onboard-MLXAQX8H.js";
//#region extensions/openai/default-models.ts
const OPENAI_DEFAULT_MODEL = "openai/gpt-5.5";
const OPENAI_CODEX_DEFAULT_MODEL = OPENAI_DEFAULT_MODEL;
const OPENAI_DEFAULT_IMAGE_MODEL = "gpt-image-2";
const OPENAI_DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const OPENAI_DEFAULT_TTS_VOICE = "alloy";
const OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const OPENAI_DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
function applyOpenAIProviderConfig(cfg) {
	const next = ensureModelAllowlistEntry({
		cfg,
		modelRef: OPENAI_DEFAULT_MODEL
	});
	const models = { ...next.agents?.defaults?.models };
	models[OPENAI_DEFAULT_MODEL] = {
		...models[OPENAI_DEFAULT_MODEL],
		alias: models["openai/gpt-5.5"]?.alias ?? "GPT"
	};
	return {
		...next,
		agents: {
			...next.agents,
			defaults: {
				...next.agents?.defaults,
				models
			}
		}
	};
}
function applyOpenAIConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyOpenAIProviderConfig(cfg), OPENAI_DEFAULT_MODEL);
}
//#endregion
export { OPENAI_DEFAULT_MODEL as a, applyOpenAIConfig as c, OPENAI_DEFAULT_IMAGE_MODEL as i, applyOpenAIProviderConfig as l, OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL as n, OPENAI_DEFAULT_TTS_MODEL as o, OPENAI_DEFAULT_EMBEDDING_MODEL as r, OPENAI_DEFAULT_TTS_VOICE as s, OPENAI_CODEX_DEFAULT_MODEL as t };
