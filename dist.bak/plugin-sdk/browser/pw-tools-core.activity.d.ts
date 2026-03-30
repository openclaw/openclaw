import type { BrowserConsoleMessage, BrowserNetworkRequest, BrowserPageError } from "./pw-session.js";
export declare function getPageErrorsViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    clear?: boolean;
}): Promise<{
    errors: BrowserPageError[];
}>;
export declare function getNetworkRequestsViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    filter?: string;
    clear?: boolean;
}): Promise<{
    requests: BrowserNetworkRequest[];
}>;
export declare function getConsoleMessagesViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    level?: string;
}): Promise<BrowserConsoleMessage[]>;
