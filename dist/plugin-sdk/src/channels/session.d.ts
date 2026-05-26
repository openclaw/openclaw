import type { MsgContext } from "../auto-reply/templating.js";
import type { GroupKeyResolution } from "../config/sessions/types.js";
import type { InboundLastRouteUpdate } from "./session.types.js";
export type { InboundLastRouteUpdate, RecordInboundSession } from "./session.types.js";
export declare function recordInboundSession(params: {
    storePath: string;
    sessionKey: string;
    ctx: MsgContext;
    groupResolution?: GroupKeyResolution | null;
    createIfMissing?: boolean;
    updateLastRoute?: InboundLastRouteUpdate;
    onRecordError: (err: unknown) => void;
    trackSessionMetaTask?: (task: Promise<unknown>) => void;
}): Promise<void>;
