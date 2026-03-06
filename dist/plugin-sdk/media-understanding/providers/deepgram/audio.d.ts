import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
export declare const DEFAULT_DEEPGRAM_AUDIO_BASE_URL = "https://api.deepgram.com/v1";
export declare const DEFAULT_DEEPGRAM_AUDIO_MODEL = "nova-3";
export declare function transcribeDeepgramAudio(params: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
