export declare function transcodeAudioBufferToOpus(params: {
    audioBuffer: Buffer;
    inputExtension?: string;
    inputFileName?: string;
    tempPrefix?: string;
    outputFileName?: string;
    timeoutMs?: number;
    sampleRateHz?: number;
    bitrate?: string;
    channels?: number;
}): Promise<Buffer>;
export type AudioContainerTranscodeOutcome = {
    ok: true;
    buffer: Buffer;
} | {
    ok: false;
    reason: "platform-unsupported" | "invalid-extension" | "noop-same-container" | "no-recipe" | "transcoder-failed";
    detail?: string;
};
export declare function transcodeAudioBuffer(params: {
    audioBuffer: Buffer;
    sourceExtension: string;
    targetExtension: string;
    timeoutMs?: number;
}): Promise<AudioContainerTranscodeOutcome>;
