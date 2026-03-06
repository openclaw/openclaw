export type MediaExecOptions = {
    timeoutMs?: number;
    maxBufferBytes?: number;
};
export declare function runFfprobe(args: string[], options?: MediaExecOptions): Promise<string>;
export declare function runFfmpeg(args: string[], options?: MediaExecOptions): Promise<string>;
export declare function parseFfprobeCsvFields(stdout: string, maxFields: number): string[];
export declare function parseFfprobeCodecAndSampleRate(stdout: string): {
    codec: string | null;
    sampleRateHz: number | null;
};
