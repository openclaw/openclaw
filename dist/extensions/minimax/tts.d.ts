//#region extensions/minimax/tts.d.ts
declare const DEFAULT_MINIMAX_TTS_BASE_URL = "https://api.minimax.io";
declare const MINIMAX_TTS_MODELS: readonly ["speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo", "speech-02-hd", "speech-02-turbo", "speech-01-hd", "speech-01-turbo", "speech-01-240228"];
declare const MINIMAX_TTS_VOICES: readonly ["English_expressive_narrator", "Chinese (Mandarin)_Warm_Girl", "Chinese (Mandarin)_Lively_Girl", "Chinese (Mandarin)_Gentle_Boy", "Chinese (Mandarin)_Steady_Boy"];
declare function normalizeMinimaxTtsBaseUrl(baseUrl?: string): string;
declare function minimaxTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  format?: string;
  sampleRate?: number;
  timeoutMs: number;
}): Promise<Buffer>;
//#endregion
export { DEFAULT_MINIMAX_TTS_BASE_URL, MINIMAX_TTS_MODELS, MINIMAX_TTS_VOICES, minimaxTTS, normalizeMinimaxTtsBaseUrl };