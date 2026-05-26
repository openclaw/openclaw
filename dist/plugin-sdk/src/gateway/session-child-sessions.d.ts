import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type DirectChildSessionEntry = {
    sessionKey: string;
    entry: SessionEntry;
};
export declare function isDirectChildSessionEntry(params: {
    sessionKey: string;
    entry: SessionEntry | undefined;
    parentKey: string;
}): boolean;
export declare function findDirectChildSessionsForParent(params: {
    cfg: OpenClawConfig;
    parentKey: string;
}): DirectChildSessionEntry[];
