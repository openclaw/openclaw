import type { Readable } from "node:stream";
type VoiceCaptureEntry = {
    generation: number;
    stream: Readable;
};
type VoiceCaptureFinalizeTimer = {
    generation: number;
    timer: ReturnType<typeof setTimeout>;
};
export type VoiceCaptureState = {
    activeSpeakers: Set<string>;
    activeCaptureStreams: Map<string, VoiceCaptureEntry>;
    captureFinalizeTimers: Map<string, VoiceCaptureFinalizeTimer>;
    captureGenerations: Map<string, number>;
};
export declare function createVoiceCaptureState(): VoiceCaptureState;
export declare function stopVoiceCaptureState(state: VoiceCaptureState): void;
export declare function getActiveVoiceCapture(state: VoiceCaptureState, userId: string): VoiceCaptureEntry | undefined;
export declare function isVoiceCaptureActive(state: VoiceCaptureState, userId: string): boolean;
export declare function clearVoiceCaptureFinalizeTimer(state: VoiceCaptureState, userId: string, generation?: number): boolean;
export declare function beginVoiceCapture(state: VoiceCaptureState, userId: string, stream: Readable): number;
export declare function finishVoiceCapture(state: VoiceCaptureState, userId: string, generation: number): boolean;
export declare function scheduleVoiceCaptureFinalize(params: {
    state: VoiceCaptureState;
    userId: string;
    delayMs: number;
    onFinalize?: (capture: VoiceCaptureEntry) => void;
}): boolean;
export {};
