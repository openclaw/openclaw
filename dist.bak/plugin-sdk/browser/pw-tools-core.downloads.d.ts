export declare function armFileUploadViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    paths?: string[];
    timeoutMs?: number;
}): Promise<void>;
export declare function armDialogViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    accept: boolean;
    promptText?: string;
    timeoutMs?: number;
}): Promise<void>;
export declare function waitForDownloadViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    path?: string;
    timeoutMs?: number;
}): Promise<{
    url: string;
    suggestedFilename: string;
    path: string;
}>;
export declare function downloadViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    path: string;
    timeoutMs?: number;
}): Promise<{
    url: string;
    suggestedFilename: string;
    path: string;
}>;
