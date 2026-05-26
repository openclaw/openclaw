import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/openai/default-models.d.ts
declare const OPENAI_DEFAULT_MODEL = "openai/gpt-5.5";
declare const OPENAI_CODEX_DEFAULT_MODEL = "openai/gpt-5.5";
declare const OPENAI_DEFAULT_IMAGE_MODEL = "gpt-image-2";
declare const OPENAI_DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
declare const OPENAI_DEFAULT_TTS_VOICE = "alloy";
declare const OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
declare const OPENAI_DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
declare function applyOpenAIProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyOpenAIConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { OPENAI_DEFAULT_MODEL as a, applyOpenAIConfig as c, OPENAI_DEFAULT_IMAGE_MODEL as i, applyOpenAIProviderConfig as l, OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL as n, OPENAI_DEFAULT_TTS_MODEL as o, OPENAI_DEFAULT_EMBEDDING_MODEL as r, OPENAI_DEFAULT_TTS_VOICE as s, OPENAI_CODEX_DEFAULT_MODEL as t };