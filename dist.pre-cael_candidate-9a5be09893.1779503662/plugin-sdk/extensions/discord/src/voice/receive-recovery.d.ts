export declare const DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS = 30;
export declare const DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS = 15;
export type VoiceReceiveRecoveryState = {
    decryptFailureCount: number;
    lastDecryptFailureAt: number;
    decryptRecoveryInFlight: boolean;
};
type VoiceReceiveErrorAnalysis = {
    message: string;
    isAbortLike: boolean;
    shouldAttemptPassthrough: boolean;
    countsAsDecryptFailure: boolean;
};
type DavePassthroughTarget = {
    guildId: string;
    channelId: string;
    connection: {
        state: {
            status: unknown;
            networking?: {
                state?: {
                    code?: unknown;
                    dave?: {
                        session?: {
                            setPassthroughMode: (passthrough: boolean, expirySeconds: number) => void;
                        };
                    };
                };
            };
        };
    };
};
type DavePassthroughSdk = {
    VoiceConnectionStatus: {
        Ready: unknown;
    };
    NetworkingStatusCode: {
        Ready: unknown;
        Resuming: unknown;
    };
};
export declare function createVoiceReceiveRecoveryState(): VoiceReceiveRecoveryState;
export declare function analyzeVoiceReceiveError(err: unknown): VoiceReceiveErrorAnalysis;
export declare function noteVoiceDecryptFailure(state: VoiceReceiveRecoveryState, now?: number): {
    firstFailure: boolean;
    shouldRecover: boolean;
};
export declare function resetVoiceReceiveRecoveryState(state: VoiceReceiveRecoveryState): void;
export declare function finishVoiceDecryptRecovery(state: VoiceReceiveRecoveryState): void;
export declare function enableDaveReceivePassthrough(params: {
    target: DavePassthroughTarget;
    sdk: DavePassthroughSdk;
    reason: string;
    expirySeconds: number;
    onVerbose: (message: string) => void;
    onWarn: (message: string) => void;
}): boolean;
export {};
