import { Bn as SpeechProviderPlugin } from "./types-lCXG2pW_.js";
//#region extensions/google/speech-provider.d.ts
declare function normalizeGoogleTtsModel(model: unknown): string;
declare function renderGoogleAudioProfilePrompt(params: {
  text: string;
  persona?: {
    id: string;
    label?: string;
    prompt?: {
      profile?: string;
      scene?: string;
      sampleContext?: string;
      style?: string;
      accent?: string;
      pacing?: string;
      constraints?: string[];
    };
  };
  personaPrompt?: string;
}): string;
declare function wrapPcm16MonoToWav(pcm: Buffer, sampleRate?: number): Buffer;
declare function buildGoogleSpeechProvider(): SpeechProviderPlugin;
declare const __testing: {
  DEFAULT_GOOGLE_TTS_MODEL: string;
  DEFAULT_GOOGLE_TTS_VOICE: string;
  GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE: string;
  GOOGLE_TTS_MODELS: readonly ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"];
  GOOGLE_TTS_SAMPLE_RATE: number;
  normalizeGoogleTtsModel: typeof normalizeGoogleTtsModel;
  renderGoogleAudioProfilePrompt: typeof renderGoogleAudioProfilePrompt;
  wrapPcm16MonoToWav: typeof wrapPcm16MonoToWav;
};
//#endregion
export { buildGoogleSpeechProvider as n, __testing as t };