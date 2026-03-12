import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
export declare const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
export declare function transcribeOpenAiCompatibleAudio(params: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
