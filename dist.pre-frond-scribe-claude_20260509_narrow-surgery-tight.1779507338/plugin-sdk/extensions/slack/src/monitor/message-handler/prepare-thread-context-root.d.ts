export type SlackBotAuthorIdentity = {
    botUserId?: string;
    botId?: string;
};
export type SlackThreadAuthorTuple = {
    userId?: string;
    botId?: string;
};
export type SlackThreadRootCandidate = SlackThreadAuthorTuple & {
    text?: string;
    ts?: string;
};
export type SlackThreadHistoryFilterPolicy = {
    retainCurrentBotRootTs?: string;
};
export type SlackThreadHistoryFilterResult<T> = {
    kept: T[];
    omittedCurrentBot: number;
};
export declare function isSlackThreadAuthorCurrentBot(params: {
    identity: SlackBotAuthorIdentity;
    author: SlackThreadAuthorTuple;
}): boolean;
export declare function resolveSlackThreadHistoryFilterPolicy(params: {
    includeBotStarterAsRootContext: boolean;
    starterTs?: string;
}): SlackThreadHistoryFilterPolicy;
export declare function applySlackThreadHistoryFilterPolicy<T extends SlackThreadRootCandidate>(params: {
    history: T[];
    policy: SlackThreadHistoryFilterPolicy;
    identity: SlackBotAuthorIdentity;
}): SlackThreadHistoryFilterResult<T>;
export declare function shouldIncludeBotThreadStarterContext(params: {
    starterIsCurrentBot: boolean;
    isNewThreadSession: boolean;
    hasStarterText: boolean;
}): boolean;
export declare function ensureSlackThreadHistoryHasBotRoot<T extends SlackThreadRootCandidate>(params: {
    history: T[];
    includeBotStarterAsRootContext: boolean;
    threadStarter: (T & {
        ts: string;
    }) | null;
}): T[];
export declare function formatSlackBotStarterThreadLabel(params: {
    roomLabel: string;
    starterText?: string;
}): string;
