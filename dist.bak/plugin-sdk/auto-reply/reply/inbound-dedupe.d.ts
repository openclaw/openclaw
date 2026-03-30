import { type DedupeCache } from "../../infra/dedupe.js";
import type { MsgContext } from "../templating.js";
export declare function buildInboundDedupeKey(ctx: MsgContext): string | null;
export declare function shouldSkipDuplicateInbound(ctx: MsgContext, opts?: {
    cache?: DedupeCache;
    now?: number;
}): boolean;
export declare function resetInboundDedupe(): void;
