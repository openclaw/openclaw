import type { Readable } from "node:stream";
type OpusDecoderPreference = "native" | "opusscript";
export declare function resolveOpusDecoderPreference(value?: string | undefined): OpusDecoderPreference;
export declare function decodeOpusStream(stream: Readable, params: {
    onVerbose: (message: string) => void;
    onWarn: (message: string) => void;
}): Promise<Buffer>;
export declare function decodeOpusStreamChunks(stream: Readable, params: {
    onChunk: (pcm48kStereo: Buffer) => void;
    onVerbose: (message: string) => void;
    onWarn: (message: string) => void;
}): Promise<void>;
export declare function convertDiscordPcm48kStereoToRealtimePcm24kMono(pcm: Buffer): Buffer;
export declare function convertRealtimePcm24kMonoToDiscordPcm48kStereo(pcm: Buffer): Buffer;
export declare function writeVoiceWavFile(pcm: Buffer): Promise<{
    path: string;
    durationSeconds: number;
}>;
export {};
