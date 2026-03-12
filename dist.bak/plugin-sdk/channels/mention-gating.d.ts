export type MentionGateParams = {
    requireMention: boolean;
    canDetectMention: boolean;
    wasMentioned: boolean;
    implicitMention?: boolean;
    shouldBypassMention?: boolean;
};
export type MentionGateResult = {
    effectiveWasMentioned: boolean;
    shouldSkip: boolean;
};
export type MentionGateWithBypassParams = {
    isGroup: boolean;
    requireMention: boolean;
    canDetectMention: boolean;
    wasMentioned: boolean;
    implicitMention?: boolean;
    hasAnyMention?: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
    commandAuthorized: boolean;
};
export type MentionGateWithBypassResult = MentionGateResult & {
    shouldBypassMention: boolean;
};
export declare function resolveMentionGating(params: MentionGateParams): MentionGateResult;
export declare function resolveMentionGatingWithBypass(params: MentionGateWithBypassParams): MentionGateWithBypassResult;
