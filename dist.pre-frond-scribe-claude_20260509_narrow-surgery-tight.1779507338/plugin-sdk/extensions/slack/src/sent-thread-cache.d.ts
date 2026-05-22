export declare function recordSlackThreadParticipation(accountId: string, channelId: string, threadTs: string, opts?: {
    agentId?: string;
}): void;
export declare function hasSlackThreadParticipation(accountId: string, channelId: string, threadTs: string): boolean;
export declare function hasSlackThreadParticipationWithPersistence(params: {
    accountId: string;
    channelId: string;
    threadTs: string;
}): Promise<boolean>;
export declare function clearSlackThreadParticipationCache(): void;
