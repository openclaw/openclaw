export { movePathToTrash, type MovePathToTrashOptions } from "./browser-trash.js";
type CloseTrackedBrowserTabsParams = {
    sessionKeys: Array<string | undefined>;
    closeTab?: (tab: {
        targetId: string;
        baseUrl?: string;
        profile?: string;
    }) => Promise<void>;
    onWarn?: (message: string) => void;
};
export declare function closeTrackedBrowserTabsForSessions(params: CloseTrackedBrowserTabsParams): Promise<number>;
