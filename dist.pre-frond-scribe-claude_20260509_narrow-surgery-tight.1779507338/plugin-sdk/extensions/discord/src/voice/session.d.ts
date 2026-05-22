import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { ChannelType } from "../internal/discord.js";
import type { VoiceCaptureState } from "./capture-state.js";
import type { VoiceReceiveRecoveryState } from "./receive-recovery.js";
export declare const MIN_SEGMENT_SECONDS = 0.35;
export declare const CAPTURE_FINALIZE_GRACE_MS = 2500;
export declare const VOICE_CONNECT_READY_TIMEOUT_MS = 30000;
export declare const VOICE_RECONNECT_GRACE_MS = 15000;
export declare const PLAYBACK_READY_TIMEOUT_MS = 60000;
export declare const SPEAKING_READY_TIMEOUT_MS = 60000;
export declare function resolveVoiceTimeoutMs(value: number | undefined, fallbackMs: number): number;
export type VoiceOperationResult = {
    ok: boolean;
    message: string;
    channelId?: string;
    guildId?: string;
};
export type VoiceRealtimeSpeakerContext = {
    extraSystemPrompt?: string;
    senderIsOwner: boolean;
    speakerLabel: string;
};
export type VoiceRealtimeAgentTurnParams = {
    context: VoiceRealtimeSpeakerContext;
    message: string;
    toolsAllow?: string[];
    userId: string;
};
export type VoiceRealtimeSpeakerTurn = {
    close: () => void;
    sendInputAudio: (discordPcm48kStereo: Buffer) => void;
};
export type VoiceRealtimeSession = {
    beginSpeakerTurn: (context: VoiceRealtimeSpeakerContext, userId: string) => VoiceRealtimeSpeakerTurn;
    close: () => void;
    connect: () => Promise<void>;
    handleBargeIn: (reason?: string) => void;
    isBargeInEnabled: () => boolean;
};
export type VoiceSessionEntry = {
    guildId: string;
    guildName?: string;
    channelId: string;
    channelName?: string;
    sessionChannelId: string;
    voiceSessionKey: string;
    route: ReturnType<typeof resolveAgentRoute>;
    connection: import("@discordjs/voice").VoiceConnection;
    player: import("@discordjs/voice").AudioPlayer;
    playbackQueue: Promise<void>;
    processingQueue: Promise<void>;
    capture: VoiceCaptureState;
    realtime?: VoiceRealtimeSession;
    receiveRecovery: VoiceReceiveRecoveryState;
    stop: () => void;
};
export declare function logVoiceVerbose(message: string): void;
export declare function isVoiceChannel(type: ChannelType): boolean;
