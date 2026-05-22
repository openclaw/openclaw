import type { RealtimeVoiceBridgeEvent, RealtimeVoiceRole } from "./provider-types.js";
export type RealtimeVoiceTranscriptEntry = {
    at: string;
    role: RealtimeVoiceRole;
    text: string;
};
export type RealtimeVoiceTranscriptHealth = {
    realtimeTranscriptLines: number;
    lastRealtimeTranscriptAt?: string;
    lastRealtimeTranscriptRole?: RealtimeVoiceRole;
    lastRealtimeTranscriptText?: string;
    recentRealtimeTranscript: RealtimeVoiceTranscriptEntry[];
};
export type RealtimeVoiceBridgeEventLogEntry = RealtimeVoiceBridgeEvent & {
    at: string;
};
export type RealtimeVoiceBridgeEventHealth = {
    lastRealtimeEventAt?: string;
    lastRealtimeEventType?: string;
    lastRealtimeEventDetail?: string;
    recentRealtimeEvents: RealtimeVoiceBridgeEventLogEntry[];
};
export declare function recordRealtimeVoiceTranscript(transcript: RealtimeVoiceTranscriptEntry[], role: RealtimeVoiceRole, text: string, maxEntries?: number): RealtimeVoiceTranscriptEntry;
export declare function getRealtimeVoiceTranscriptHealth(transcript: RealtimeVoiceTranscriptEntry[]): RealtimeVoiceTranscriptHealth;
export declare function recordRealtimeVoiceBridgeEvent(events: RealtimeVoiceBridgeEventLogEntry[], event: RealtimeVoiceBridgeEvent, maxEntries?: number): void;
export declare function getRealtimeVoiceBridgeEventHealth(events: RealtimeVoiceBridgeEventLogEntry[]): RealtimeVoiceBridgeEventHealth;
export declare function isLikelyRealtimeVoiceAssistantEchoTranscript(params: {
    transcript: RealtimeVoiceTranscriptEntry[];
    text: string;
    lookbackMs: number;
    nowMs?: number;
}): boolean;
export declare function extendRealtimeVoiceOutputEchoSuppression(params: {
    audio: Buffer;
    bytesPerMs: number;
    tailMs: number;
    nowMs: number;
    lastOutputPlayableUntilMs: number;
    suppressInputUntilMs: number;
}): {
    lastOutputPlayableUntilMs: number;
    suppressInputUntilMs: number;
    durationMs: number;
};
