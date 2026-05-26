export declare const formatDirectiveAck: (text: string) => string;
export declare const withOptions: (line: string, options: string) => string;
export declare const formatElevatedRuntimeHint: () => string;
export declare const formatInternalExecPersistenceDeniedText: () => string;
export declare const formatInternalVerbosePersistenceDeniedText: () => string;
export declare const formatInternalVerboseCurrentReplyOnlyText: () => string;
declare function canPersistInternalDirective(params: {
    messageProvider?: string;
    surface?: string;
    gatewayClientScopes?: string[];
}): boolean;
export declare const canPersistInternalExecDirective: typeof canPersistInternalDirective;
export declare const canPersistInternalVerboseDirective: typeof canPersistInternalDirective;
export declare function enqueueModeSwitchEvents(params: {
    enqueueSystemEvent: (text: string, meta: {
        sessionKey: string;
        contextKey: string;
    }) => void;
    sessionEntry: {
        elevatedLevel?: string | null;
        reasoningLevel?: string | null;
    };
    sessionKey: string;
    elevatedChanged?: boolean;
    reasoningChanged?: boolean;
}): void;
export declare function formatElevatedUnavailableText(params: {
    runtimeSandboxed: boolean;
    failures?: Array<{
        gate: string;
        key: string;
    }>;
    sessionKey?: string;
}): string;
export {};
