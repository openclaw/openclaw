import type { MsgContext } from "../auto-reply/templating.js";
import { type GroupKeyResolution, type SessionEntry } from "../config/sessions.js";
export type InboundLastRouteUpdate = {
    sessionKey: string;
    channel: SessionEntry["lastChannel"];
    to: string;
    accountId?: string;
    threadId?: string | number;
};
export declare function recordInboundSession(params: {
    storePath: string;
    sessionKey: string;
    ctx: MsgContext;
    groupResolution?: GroupKeyResolution | null;
    createIfMissing?: boolean;
    updateLastRoute?: InboundLastRouteUpdate;
    onRecordError: (err: unknown) => void;
}): Promise<void>;
