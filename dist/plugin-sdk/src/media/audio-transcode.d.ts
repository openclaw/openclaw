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
