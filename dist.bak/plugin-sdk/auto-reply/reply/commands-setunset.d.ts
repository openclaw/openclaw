export type SetUnsetParseResult = {
    kind: "set";
    path: string;
    value: unknown;
} | {
    kind: "unset";
    path: string;
} | {
    kind: "error";
    message: string;
};
export declare function parseSetUnsetCommand(params: {
    slash: string;
    action: "set" | "unset";
    args: string;
}): SetUnsetParseResult;
export declare function parseSetUnsetCommandAction<T>(params: {
    slash: string;
    action: string;
    args: string;
    onSet: (path: string, value: unknown) => T;
    onUnset: (path: string) => T;
    onError: (message: string) => T;
}): T | null;
export declare function parseSlashCommandWithSetUnset<T>(params: {
    raw: string;
    slash: string;
    invalidMessage: string;
    usageMessage: string;
    onKnownAction: (action: string, args: string) => T | undefined;
    onSet: (path: string, value: unknown) => T;
    onUnset: (path: string) => T;
    onError: (message: string) => T;
}): T | null;
