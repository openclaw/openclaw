import type { ReplyPayload } from "../types.js";
import { type ResponsePrefixContext } from "./response-prefix-template.js";
export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat";
export type NormalizeReplyOptions = {
    responsePrefix?: string;
    /** Context for template variable interpolation in responsePrefix */
    responsePrefixContext?: ResponsePrefixContext;
    onHeartbeatStrip?: () => void;
    stripHeartbeat?: boolean;
    silentToken?: string;
    onSkip?: (reason: NormalizeReplySkipReason) => void;
};
export declare function normalizeReplyPayload(payload: ReplyPayload, opts?: NormalizeReplyOptions): ReplyPayload | null;
