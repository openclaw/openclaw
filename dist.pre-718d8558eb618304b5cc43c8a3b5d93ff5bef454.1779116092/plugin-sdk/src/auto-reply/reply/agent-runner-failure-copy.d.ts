export declare const GENERIC_EXTERNAL_RUN_FAILURE_TEXT = "\u26A0\uFE0F Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
export declare const HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT = "\u26A0\uFE0F Heartbeat check failed before it could produce an update. The main chat session remains available.";
export declare function isGenericExternalRunFailureText(text: string | undefined): boolean;
export declare function replaceGenericExternalRunFailureText(text: string): {
    text: string;
    replaced: boolean;
};
