export type UnifiedTalkSessionRecord = {
    kind: "realtime-relay";
    connId: string;
    relaySessionId: string;
} | {
    kind: "transcription-relay";
    connId: string;
    transcriptionSessionId: string;
} | {
    kind: "managed-room";
    handoffId: string;
    token: string;
    roomId: string;
};
export declare function rememberUnifiedTalkSession(sessionId: string, session: UnifiedTalkSessionRecord): void;
export declare function getUnifiedTalkSession(sessionId: string): UnifiedTalkSessionRecord;
export declare function forgetUnifiedTalkSession(sessionId: string): void;
export declare function requireUnifiedTalkSessionConn(session: Extract<UnifiedTalkSessionRecord, {
    connId: string;
}>, connId: string | undefined): string;
export declare function clearUnifiedTalkSessionsForTest(): void;
