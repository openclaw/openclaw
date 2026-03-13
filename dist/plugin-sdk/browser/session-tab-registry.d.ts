export type TrackedSessionBrowserTab = {
    sessionKey: string;
    targetId: string;
    baseUrl?: string;
    profile?: string;
    trackedAt: number;
};
export declare function trackSessionBrowserTab(params: {
    sessionKey?: string;
    targetId?: string;
    baseUrl?: string;
    profile?: string;
}): void;
export declare function untrackSessionBrowserTab(params: {
    sessionKey?: string;
    targetId?: string;
    baseUrl?: string;
    profile?: string;
}): void;
export declare function closeTrackedBrowserTabsForSessions(params: {
    sessionKeys: Array<string | undefined>;
    closeTab?: (tab: {
        targetId: string;
        baseUrl?: string;
        profile?: string;
    }) => Promise<void>;
    onWarn?: (message: string) => void;
}): Promise<number>;
export declare function __resetTrackedSessionBrowserTabsForTests(): void;
export declare function __countTrackedSessionBrowserTabsForTests(sessionKey?: string): number;
