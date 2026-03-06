import type { SessionEntry } from "../../config/sessions.js";
import type { MsgContext } from "../templating.js";
export type LegacyMainDeliveryRetirement = {
    key: string;
    entry: SessionEntry;
};
export declare function resolveLastChannelRaw(params: {
    originatingChannelRaw?: string;
    persistedLastChannel?: string;
    sessionKey?: string;
}): string | undefined;
export declare function resolveLastToRaw(params: {
    originatingChannelRaw?: string;
    originatingToRaw?: string;
    toRaw?: string;
    persistedLastTo?: string;
    persistedLastChannel?: string;
    sessionKey?: string;
}): string | undefined;
export declare function maybeRetireLegacyMainDeliveryRoute(params: {
    sessionCfg: {
        dmScope?: string;
    } | undefined;
    sessionKey: string;
    sessionStore: Record<string, SessionEntry>;
    agentId: string;
    mainKey: string;
    isGroup: boolean;
    ctx: MsgContext;
}): LegacyMainDeliveryRetirement | undefined;
