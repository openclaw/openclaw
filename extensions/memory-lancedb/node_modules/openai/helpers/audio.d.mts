export declare function playAudio(input: NodeJS.ReadableStream | Response | File): Promise<void>;
type RecordAudioOptions = {
    signal?: AbortSignal;
    device?: number;
    timeout?: number;
};
export declare function recordAudio(options?: RecordAudioOptions): Promise<File>;
export {};
//# sourceMappingURL=audio.d.mts.map