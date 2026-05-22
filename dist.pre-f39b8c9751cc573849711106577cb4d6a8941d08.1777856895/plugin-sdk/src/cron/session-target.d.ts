export declare function isInvalidCronSessionTargetIdError(error: unknown): boolean;
export declare function assertSafeCronSessionTargetId(sessionId: string): string;
export declare function resolveCronSessionTargetSessionKey(sessionTarget?: string | null): string | undefined;
export declare function resolveCronDeliverySessionKey(job: {
    sessionTarget?: string | null;
    sessionKey?: string | null;
}): string | undefined;
export declare function resolveCronNotificationSessionKey(params: {
    jobId: string;
    sessionKey?: string | null;
}): string;
export declare function resolveCronFailureNotificationSessionKey(job: {
    id: string;
    sessionTarget?: string | null;
    sessionKey?: string | null;
}): string;
