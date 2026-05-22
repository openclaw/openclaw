export declare function parseStandardSetUnsetSlashCommand<T>(params: {
    raw: string;
    slash: string;
    invalidMessage: string;
    usageMessage: string;
    onKnownAction: (action: string, args: string) => T | undefined;
    onSet?: (path: string, value: unknown) => T;
    onUnset?: (path: string) => T;
    onError?: (message: string) => T;
}): T | null;
