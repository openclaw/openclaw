export type PollCreationParamKind = "string" | "stringArray" | "number" | "boolean";
export type PollCreationParamDef = {
    kind: PollCreationParamKind;
    telegramOnly?: boolean;
};
export declare const POLL_CREATION_PARAM_DEFS: Record<string, PollCreationParamDef>;
export type PollCreationParamName = keyof typeof POLL_CREATION_PARAM_DEFS;
export declare const POLL_CREATION_PARAM_NAMES: string[];
export declare function resolveTelegramPollVisibility(params: {
    pollAnonymous?: boolean;
    pollPublic?: boolean;
}): boolean | undefined;
export declare function hasPollCreationParams(params: Record<string, unknown>): boolean;
