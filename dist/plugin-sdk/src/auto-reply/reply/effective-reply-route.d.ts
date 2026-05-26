import type { SessionEntry } from "../../config/sessions/types.js";
import type { FinalizedMsgContext } from "../templating.js";
export type EffectiveReplyRouteContext = Pick<FinalizedMsgContext, "Provider" | "OriginatingChannel" | "OriginatingTo" | "AccountId">;
export type EffectiveReplyRouteEntry = Pick<SessionEntry, "deliveryContext" | "lastChannel" | "lastTo" | "lastAccountId">;
export type EffectiveReplyRoute = {
    channel?: string;
    to?: string;
    accountId?: string;
};
export declare function isSystemEventProvider(provider?: string): boolean;
export declare function resolveEffectiveReplyRoute(params: {
    ctx: EffectiveReplyRouteContext;
    entry?: EffectiveReplyRouteEntry;
}): EffectiveReplyRoute;
