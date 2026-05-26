import { type TalkBrain, type TalkEvent, type TalkEventContext, type TalkEventInput, type TalkEventSequencer, type TalkMode, type TalkTransport } from "./talk-events.js";
export type TalkTurnFailureReason = "no_active_turn" | "stale_turn";
export type TalkTurnSuccess = {
    event: TalkEvent;
    ok: true;
    turnId: string;
};
export type TalkTurnFailure = {
    ok: false;
    reason: TalkTurnFailureReason;
};
export type TalkTurnResult = TalkTurnSuccess | TalkTurnFailure;
export type TalkEnsureTurnResult = {
    event?: TalkEvent;
    turnId: string;
};
export type TalkSessionController = {
    readonly activeTurnId: string | undefined;
    readonly context: TalkEventContext;
    readonly outputAudioActive: boolean;
    readonly recentEvents: readonly TalkEvent[];
    clearActiveTurn(): void;
    emit<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload>;
    ensureTurn(params?: {
        payload?: unknown;
        turnId?: string;
    }): TalkEnsureTurnResult;
    startTurn(params?: {
        payload?: unknown;
        turnId?: string;
    }): TalkEnsureTurnResult;
    endTurn(params?: {
        payload?: unknown;
        turnId?: string;
    }): TalkTurnResult;
    cancelTurn(params?: {
        payload?: unknown;
        turnId?: string;
    }): TalkTurnResult;
    finishOutputAudio(params?: {
        payload?: unknown;
        turnId?: string;
    }): TalkEvent | undefined;
    startOutputAudio(params?: {
        payload?: unknown;
        turnId?: string;
    }): TalkEnsureTurnResult;
};
export type TalkSessionControllerParams = TalkEventContext & {
    maxRecentEvents?: number;
    turnIdPrefix?: string;
};
export type TalkSessionControllerOptions = {
    now?: () => Date | string;
    onEvent?: (event: TalkEvent) => void;
    sequencer?: TalkEventSequencer;
};
export declare function createTalkSessionController(params: TalkSessionControllerParams, options?: TalkSessionControllerOptions): TalkSessionController;
export declare function normalizeTalkTransport(value: string | undefined): string | undefined;
export type { TalkBrain, TalkEvent, TalkEventContext, TalkEventInput, TalkMode, TalkTransport };
