export declare function formatPortRangeHint(example?: number): string;
export declare function formatInvalidPortOption(option: string, example?: number): string;
export declare function formatInvalidConfigPort(path: string, example?: number): string;
export declare function formatUnknownChannelMessage(params: {
    channel: string;
    listCommand?: string;
    purpose?: string;
}): string;
export declare function formatUnsupportedChannelActionMessage(params: {
    channel: string;
    action: string;
    inspectCommand?: string;
}): string;
export declare function formatStrictJsonParseFailure(params: {
    value: string;
    cause: unknown;
}): string;
export declare function formatGatewayCommandFailure(params: {
    action: string;
    error: unknown;
    inspectCommand?: string;
}): string;
export declare function formatLookupMiss(params: {
    noun: string;
    value: string;
    listCommand: string;
    valueLabel?: string;
}): string;
export declare function formatMissingPluginMessage(params: {
    id: string;
    listCommand?: string;
    includeSearch?: boolean;
}): string;
