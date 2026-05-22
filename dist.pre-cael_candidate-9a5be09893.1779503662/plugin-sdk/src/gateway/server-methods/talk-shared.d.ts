import type { OpenClawConfig } from "../../config/types.js";
import type { RealtimeTranscriptionProviderConfig } from "../../realtime-transcription/provider-types.js";
import type { RealtimeVoiceBrowserSession, RealtimeVoiceProviderConfig } from "../../talk/provider-types.js";
import type { TalkEvent } from "../../talk/talk-events.js";
import type { TalkHandoffTurnResult } from "../talk-handoff.js";
export declare function canUseTalkDirectTools(client: {
    connect?: {
        scopes?: string[];
    };
} | null): boolean;
export declare function broadcastTalkRoomEvents(context: {
    broadcastToConnIds: (event: string, payload: unknown, connIds: Set<string>, opts?: {
        dropIfSlow?: boolean;
    }) => void;
}, connId: string | undefined, params: {
    handoffId: string;
    roomId: string;
    events: TalkEvent[];
}): void;
type TalkHandoffFailureReason = Extract<TalkHandoffTurnResult, {
    ok: false;
}>["reason"];
export declare function talkHandoffErrorCode(reason: TalkHandoffFailureReason): "INVALID_REQUEST" | "UNAVAILABLE";
export declare function getVoiceCallStreamingConfig(config: OpenClawConfig): {
    provider?: string;
    providers?: Record<string, RealtimeTranscriptionProviderConfig>;
};
export declare function buildTalkRealtimeConfig(config: OpenClawConfig, requestedProvider?: string): {
    provider: string | undefined;
    providers: {
        [x: string]: RealtimeVoiceProviderConfig;
    };
    model: string | undefined;
    voice: string | undefined;
    instructions: string | undefined;
    mode: string | undefined;
    transport: string | undefined;
    brain: string | undefined;
    consultRouting: string | undefined;
};
export declare function buildTalkTranscriptionConfig(config: OpenClawConfig, requestedProvider?: string): {
    provider: string | undefined;
    providers: Record<string, RealtimeTranscriptionProviderConfig>;
};
export declare function configuredOrFalse(callback: () => boolean): boolean;
export declare function resolveConfiguredRealtimeTranscriptionProvider(params: {
    config: OpenClawConfig;
    configuredProviderId?: string;
    providerConfigs: Record<string, RealtimeTranscriptionProviderConfig>;
}): {
    provider: import("openclaw/plugin-sdk").RealtimeTranscriptionProviderPlugin;
    providerConfig: RealtimeTranscriptionProviderConfig;
};
export declare function buildRealtimeInstructions(configuredInstructions?: string): string;
type RealtimeVoiceLaunchOptions = {
    model?: string;
    voice?: string;
    vadThreshold?: number;
    silenceDurationMs?: number;
    prefixPaddingMs?: number;
    reasoningEffort?: string;
};
type RealtimeVoiceLaunchOptionInput = {
    model?: unknown;
    voice?: unknown;
    vadThreshold?: unknown;
    silenceDurationMs?: unknown;
    prefixPaddingMs?: unknown;
    reasoningEffort?: unknown;
};
export declare function buildRealtimeVoiceLaunchOptions(params: {
    requested: RealtimeVoiceLaunchOptionInput;
    defaults: RealtimeVoiceLaunchOptions;
}): RealtimeVoiceLaunchOptions;
export declare function withRealtimeBrowserOverrides(providerConfig: RealtimeVoiceProviderConfig, params: RealtimeVoiceLaunchOptionInput): RealtimeVoiceProviderConfig;
export declare function isUnsupportedBrowserWebRtcSession(session: RealtimeVoiceBrowserSession): boolean;
export {};
