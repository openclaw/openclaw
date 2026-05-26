import { type DedupeCache } from "../../infra/dedupe.js";
import type { MsgContext } from "../templating.js";
export type InboundDedupeClaimResult = {
    status: "invalid";
} | {
    status: "duplicate";
    key: string;
} | {
    status: "inflight";
    key: string;
} | {
    status: "claimed";
    key: string;
};
export declare function buildInboundDedupeKey(ctx: MsgContext): string | null;
export declare function shouldSkipDuplicateInbound(ctx: MsgContext, opts?: {
    cache?: DedupeCache;
    now?: number;
}): boolean;
export declare function claimInboundDedupe(ctx: MsgContext, opts?: {
    cache?: DedupeCache;
    now?: number;
    inFlight?: Set<string>;
}): InboundDedupeClaimResult;
export declare function commitInboundDedupe(key: string, opts?: {
    cache?: DedupeCache;
    now?: number;
    inFlight?: Set<string>;
}): void;
export declare function releaseInboundDedupe(key: string, opts?: {
    inFlight?: Set<string>;
}): void;
export declare function resetInboundDedupe(): void;
