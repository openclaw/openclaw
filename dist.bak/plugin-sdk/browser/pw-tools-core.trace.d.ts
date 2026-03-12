export declare function traceStartViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    screenshots?: boolean;
    snapshots?: boolean;
    sources?: boolean;
}): Promise<void>;
export declare function traceStopViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    path: string;
}): Promise<void>;
