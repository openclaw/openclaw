type CronSessionContext = {
    agentId?: string;
    cronJobId?: string;
    cronRunId?: string;
    cronJobName?: string;
    lastAssistant?: string;
};
declare function quoteLogField(value: string): string;
export declare function parseCronRunSessionKey(sessionKey?: string): {
    agentId?: string;
    cronJobId?: string;
    cronRunId?: string;
};
export declare function readLastAssistantFromSessionFile(filePath: string | undefined): string | undefined;
export declare function resolveCronSessionDiagnosticContext(params: {
    sessionKey?: string;
    activeSessionId?: string;
}): CronSessionContext;
export declare function formatCronSessionDiagnosticFields(context: CronSessionContext): string;
export declare function formatStoppedCronSessionDiagnosticFields(context: CronSessionContext): string;
export declare const __testing: {
    quoteLogField: typeof quoteLogField;
};
export {};
