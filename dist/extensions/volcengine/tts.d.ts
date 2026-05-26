//#region extensions/volcengine/tts.d.ts
type VolcengineTtsEncoding = "ogg_opus" | "mp3" | "pcm" | "wav";
type VolcengineTTSParams = {
  text: string;
  apiKey?: string;
  appId?: string;
  token?: string;
  voice?: string;
  cluster?: string;
  resourceId?: string;
  appKey?: string;
  baseUrl?: string;
  speedRatio?: number;
  volumeRatio?: number;
  pitchRatio?: number;
  emotion?: string;
  encoding?: VolcengineTtsEncoding;
  timeoutMs?: number;
};
declare function volcengineTTS(params: VolcengineTTSParams): Promise<Buffer>;
//#endregion
export { VolcengineTtsEncoding, volcengineTTS };