import { type TalkBrain, type TalkEvent, type TalkMode, type TalkSessionController, type TalkTransport } from "../talk/talk-session-controller.js";
export type TalkHandoffCreateParams = {
    sessionKey: string;
    sessionId?: string;
    channel?: string;
    target?: string;
    provider?: string;
    model?: string;
    voice?: string;
    mode?: TalkMode;
    transport?: TalkTransport;
    brain?: TalkBrain;
    ttlMs?: number;
};
export type TalkHandoffRecord = {
    id: string;
    roomId: string;
    roomUrl: string;
    tokenHash: string;
    sessionKey: string;
    sessionId?: string;
    channel?: string;
    target?: string;
    provider?: string;
    model?: string;
    voice?: string;
    mode: TalkMode;
    transport: TalkTransport;
    brain: TalkBrain;
    createdAt: number;
    expiresAt: number;
    room: TalkHandoffRoomState;
};
export type TalkHandoffPublicRecord = Omit<TalkHandoffRecord, "tokenHash" | "room"> & {
    room: {
        activeClientId?: string;
        activeTurnId?: string;
        recentTalkEvents: TalkEvent[];
    };
};
export type TalkHandoffCreateResult = TalkHandoffPublicRecord & {
    token: string;
};
export type TalkHandoffJoinResult = {
    ok: true;
    record: TalkHandoffPublicRecord;
    events: TalkEvent[];
    replacedClientId?: string;
    replacementEvents: TalkEvent[];
    activeClientEvents: TalkEvent[];
} | {
    ok: false;
    reason: "not_found" | "expired" | "invalid_token";
};
export type TalkHandoffRevokeResult = {
    revoked: boolean;
    roomId?: string;
    activeClientId?: string;
    events: TalkEvent[];
};
export type TalkHandoffTurnResult = {
    ok: true;
    record: TalkHandoffPublicRecord;
    turnId: string;
    events: TalkEvent[];
} | {
    ok: false;
    reason: "not_found" | "expired" | "invalid_token" | "no_active_turn" | "stale_turn";
};
type TalkHandoffRoomState = {
    activeClientId?: string;
    talk: TalkSessionController;
};
export declare function createTalkHandoff(params: TalkHandoffCreateParams): TalkHandoffCreateResult;
export declare function getTalkHandoff(id: string): TalkHandoffRecord | undefined;
export declare function joinTalkHandoff(id: string, token: string, opts?: {
    clientId?: string;
}): TalkHandoffJoinResult;
export declare function startTalkHandoffTurn(id: string, token: string, opts?: {
    turnId?: string;
    clientId?: string;
}): TalkHandoffTurnResult;
export declare function endTalkHandoffTurn(id: string, token: string, opts?: {
    turnId?: string;
}): TalkHandoffTurnResult;
export declare function cancelTalkHandoffTurn(id: string, token: string, opts?: {
    reason?: string;
    turnId?: string;
}): TalkHandoffTurnResult;
export declare function revokeTalkHandoff(id: string): TalkHandoffRevokeResult;
export declare function verifyTalkHandoffToken(record: TalkHandoffRecord, token: string): boolean;
export declare function clearTalkHandoffsForTest(): void;
export {};
