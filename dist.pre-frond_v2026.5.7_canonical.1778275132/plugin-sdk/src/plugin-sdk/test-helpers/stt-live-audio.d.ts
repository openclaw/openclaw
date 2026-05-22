import type { RealtimeTranscriptionProviderConfig, RealtimeTranscriptionProviderPlugin } from "../realtime-transcription.js";
export declare function normalizeTranscriptForMatch(value: string): string;
type ExpectedTranscriptMatch = RegExp | string;
export declare const OPENCLAW_LIVE_TRANSCRIPT_MARKER_RE: RegExp;
export declare function expectOpenClawLiveTranscriptMarker(value: string): void;
export declare function waitForLiveExpectation(expectation: () => void, timeoutMs?: number): Promise<void>;
export declare function synthesizeElevenLabsLiveSpeech(params: {
    text: string;
    apiKey: string;
    outputFormat: "mp3_44100_128" | "ulaw_8000";
    timeoutMs?: number;
}): Promise<Buffer>;
export declare function streamAudioForLiveTest(params: {
    audio: Buffer;
    sendAudio: (chunk: Buffer) => void;
    chunkSize?: number;
    delayMs?: number;
}): Promise<void>;
export declare function runRealtimeSttLiveTest(params: {
    provider: RealtimeTranscriptionProviderPlugin;
    providerConfig: RealtimeTranscriptionProviderConfig;
    audio: Buffer;
    expectedNormalizedText?: ExpectedTranscriptMatch;
    timeoutMs?: number;
    closeBeforeWait?: boolean;
    chunkSize?: number;
    delayMs?: number;
}): Promise<{
    transcripts: string[];
    partials: string[];
    errors: Error[];
}>;
export {};
