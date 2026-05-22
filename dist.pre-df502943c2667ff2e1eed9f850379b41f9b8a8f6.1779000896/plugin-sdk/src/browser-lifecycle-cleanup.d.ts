export declare function cleanupBrowserSessionsForLifecycleEnd(params: {
    sessionKeys: string[];
    onWarn?: (message: string) => void;
    onError?: (error: unknown) => void;
}): Promise<void>;
