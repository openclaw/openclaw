export type EchoTracker = {
    rememberText: (text: string | undefined, opts: {
        combinedBody?: string;
        combinedBodySessionKey?: string;
        logVerboseMessage?: boolean;
    }) => void;
    has: (key: string) => boolean;
    forget: (key: string) => void;
    buildCombinedKey: (params: {
        sessionKey: string;
        combinedBody: string;
    }) => string;
};
export declare function createEchoTracker(params: {
    maxItems?: number;
    logVerbose?: (msg: string) => void;
}): EchoTracker;
