import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import type { RealtimeTranscriptionProviderConfig } from "../realtime-transcription/provider-types.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
type CreateTalkTranscriptionRelaySessionParams = {
    context: GatewayRequestContext;
    connId: string;
    provider: RealtimeTranscriptionProviderPlugin;
    providerConfig: RealtimeTranscriptionProviderConfig;
};
type TalkTranscriptionRelaySessionResult = {
    provider: string;
    mode: "transcription";
    transport: "gateway-relay";
    transcriptionSessionId: string;
    audio: {
        inputEncoding: "g711_ulaw";
        inputSampleRateHz: 8000;
    };
    expiresAt: number;
};
export declare function createTalkTranscriptionRelaySession(params: CreateTalkTranscriptionRelaySessionParams): TalkTranscriptionRelaySessionResult;
export declare function sendTalkTranscriptionRelayAudio(params: {
    transcriptionSessionId: string;
    connId: string;
    audioBase64: string;
}): void;
export declare function stopTalkTranscriptionRelaySession(params: {
    transcriptionSessionId: string;
    connId: string;
}): void;
export declare function cancelTalkTranscriptionRelayTurn(params: {
    transcriptionSessionId: string;
    connId: string;
    reason?: string;
}): void;
export declare function clearTalkTranscriptionRelaySessionsForTest(): void;
export {};
