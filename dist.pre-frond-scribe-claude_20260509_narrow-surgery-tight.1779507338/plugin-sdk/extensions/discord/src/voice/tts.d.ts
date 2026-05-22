import type { OpenClawConfig, TtsConfig } from "openclaw/plugin-sdk/config-contracts";
type VoiceReplyAudioResult = {
    status: "ok";
    mode: "file";
    audioPath: string;
    speakText: string;
} | {
    status: "ok";
    mode: "stream";
    audioStream: ReadableStream<Uint8Array>;
    release?: () => Promise<void>;
    speakText: string;
} | {
    status: "empty";
} | {
    status: "failed";
    error?: string;
};
export declare function transcribeVoiceAudio(params: {
    cfg: OpenClawConfig;
    agentId: string;
    filePath: string;
}): Promise<string | undefined>;
export declare function synthesizeVoiceReplyAudio(params: {
    cfg: OpenClawConfig;
    override?: TtsConfig;
    replyText: string;
    speakerLabel: string;
}): Promise<VoiceReplyAudioResult>;
export {};
