//#region extensions/elevenlabs/tts.d.ts
type ElevenLabsTtsRequestParams = {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  seed?: number;
  applyTextNormalization?: "auto" | "on" | "off";
  languageCode?: string;
  latencyTier?: number;
  voiceSettings: {
    stability: number;
    similarityBoost: number;
    style: number;
    useSpeakerBoost: boolean;
    speed: number;
  };
  timeoutMs: number;
};
declare function elevenLabsTTS(params: ElevenLabsTtsRequestParams): Promise<Buffer>;
declare function elevenLabsTTSStream(params: ElevenLabsTtsRequestParams): Promise<{
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
}>;
//#endregion
export { elevenLabsTTS, elevenLabsTTSStream };