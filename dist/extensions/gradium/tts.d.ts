//#region extensions/gradium/tts.d.ts
declare function gradiumTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  outputFormat: "wav" | "opus" | "ulaw_8000" | "pcm" | "pcm_24000" | "alaw_8000";
  timeoutMs: number;
}): Promise<Buffer>;
//#endregion
export { gradiumTTS };