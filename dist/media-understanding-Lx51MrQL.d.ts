import { n as AudioTranscriptionResult, t as AudioTranscriptionRequest } from "./types-ByzWuf9L.js";
//#region src/media-understanding/openai-compatible-video.d.ts
type OpenAiCompatibleVideoPayload = {
  choices?: Array<{
    message?: {
      content?: string | Array<{
        text?: string;
      }>;
      reasoning_content?: string;
    };
  }>;
};
declare function resolveMediaUnderstandingString(value: string | undefined, fallback: string): string;
declare function coerceOpenAiCompatibleVideoText(payload: OpenAiCompatibleVideoPayload): string | null;
declare function buildOpenAiCompatibleVideoRequestBody(params: {
  model: string;
  prompt: string;
  mime: string;
  buffer: Buffer;
}): {
  model: string;
  messages: {
    role: string;
    content: ({
      type: string;
      text: string;
      video_url?: undefined;
    } | {
      type: string;
      video_url: {
        url: string;
      };
      text?: undefined;
    })[];
  }[];
};
//#endregion
//#region src/media-understanding/openai-compatible-audio.d.ts
type OpenAiCompatibleAudioParams = AudioTranscriptionRequest & {
  defaultBaseUrl: string;
  defaultModel: string;
  provider?: string;
};
declare function transcribeOpenAiCompatibleAudio(params: OpenAiCompatibleAudioParams): Promise<AudioTranscriptionResult>;
//#endregion
export { resolveMediaUnderstandingString as a, coerceOpenAiCompatibleVideoText as i, OpenAiCompatibleVideoPayload as n, buildOpenAiCompatibleVideoRequestBody as r, transcribeOpenAiCompatibleAudio as t };