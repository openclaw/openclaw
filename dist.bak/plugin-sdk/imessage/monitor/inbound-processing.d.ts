import { type EnvelopeFormatOptions } from "../../auto-reply/envelope.js";
import { type HistoryEntry } from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import type { MonitorIMessageOpts, IMessagePayload } from "./types.js";
type IMessageReplyContext = {
    id?: string;
    body: string;
    sender?: string;
};
export type IMessageInboundDispatchDecision = {
    kind: "dispatch";
    isGroup: boolean;
    chatId?: number;
    chatGuid?: string;
    chatIdentifier?: string;
    groupId?: string;
    historyKey?: string;
    sender: string;
    senderNormalized: string;
    route: ReturnType<typeof resolveAgentRoute>;
    bodyText: string;
    createdAt?: number;
    replyContext: IMessageReplyContext | null;
    effectiveWasMentioned: boolean;
    commandAuthorized: boolean;
    effectiveDmAllowFrom: string[];
    effectiveGroupAllowFrom: string[];
};
export type IMessageInboundDecision = {
    kind: "drop";
    reason: string;
} | {
    kind: "pairing";
    senderId: string;
} | IMessageInboundDispatchDecision;
export declare function resolveIMessageInboundDecision(params: {
    cfg: OpenClawConfig;
    accountId: string;
    message: IMessagePayload;
    opts?: Pick<MonitorIMessageOpts, "requireMention">;
    messageText: string;
    bodyText: string;
    allowFrom: string[];
    groupAllowFrom: string[];
    groupPolicy: string;
    dmPolicy: string;
    storeAllowFrom: string[];
    historyLimit: number;
    groupHistories: Map<string, HistoryEntry[]>;
    echoCache?: {
        has: (scope: string, lookup: {
            text?: string;
            messageId?: string;
        }) => boolean;
    };
    logVerbose?: (msg: string) => void;
}): IMessageInboundDecision;
export declare function buildIMessageInboundContext(params: {
    cfg: OpenClawConfig;
    decision: IMessageInboundDispatchDecision;
    message: IMessagePayload;
    envelopeOptions?: EnvelopeFormatOptions;
    previousTimestamp?: number;
    remoteHost?: string;
    media?: {
        path?: string;
        type?: string;
        paths?: string[];
        types?: Array<string | undefined>;
    };
    historyLimit: number;
    groupHistories: Map<string, HistoryEntry[]>;
}): {
    ctxPayload: ReturnType<typeof finalizeInboundContext>;
    fromLabel: string;
    chatTarget?: string;
    imessageTo: string;
    inboundHistory?: Array<{
        sender: string;
        body: string;
        timestamp?: number;
    }>;
};
export declare function buildIMessageEchoScope(params: {
    accountId: string;
    isGroup: boolean;
    chatId?: number;
    sender: string;
}): string;
export declare function describeIMessageEchoDropLog(params: {
    messageText: string;
    messageId?: string;
}): string;
export {};
