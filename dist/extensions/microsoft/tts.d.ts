//#region extensions/microsoft/tts.d.ts
type EdgeTTSRuntimeConfig = {
  voice?: string;
  lang?: string;
  outputFormat?: string;
  saveSubtitles?: boolean;
  proxy?: string;
  rate?: string;
  pitch?: string;
  volume?: string;
  timeout?: number;
};
type EdgeTTSDeps = {
  EdgeTTS: new (config: EdgeTTSRuntimeConfig) => {
    ttsPromise: (text: string, outputPath: string) => Promise<unknown>;
  };
};
declare function inferEdgeExtension(outputFormat: string): string;
declare function edgeTTS(params: {
  text: string;
  outputPath: string;
  config: {
    voice: string;
    lang: string;
    outputFormat: string;
    saveSubtitles: boolean;
    proxy?: string;
    rate?: string;
    pitch?: string;
    volume?: string;
    timeoutMs?: number;
  };
  timeoutMs: number;
}, deps?: EdgeTTSDeps): Promise<void>;
//#endregion
export { edgeTTS, inferEdgeExtension };