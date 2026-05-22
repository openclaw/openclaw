import { type StatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
import type { CommandTurnContext } from "openclaw/plugin-sdk/channel-inbound";
import { type DeliverableWhatsAppOutboundPayload } from "../../outbound-media-contract.js";
import type { WhatsAppReplyDeliveryResult } from "../deliver-reply.js";
import type { WebInboundMsg } from "../types.js";
import type { GroupHistoryEntry } from "./inbound-context.js";
import { createChannelMessageReplyPipeline, resolveChunkMode, resolveMarkdownTableMode, type getChildLogger, type getReplyFromConfig, type LoadConfigFn, type ReplyPayload, type resolveAgentRoute } from "./inbound-dispatch.runtime.js";
type ChannelReplyOnModelSelected = NonNullable<ReturnType<typeof createChannelMessageReplyPipeline>["onModelSelected"]>;
type WhatsAppDispatchPipeline = {
    responsePrefix?: string;
} & Record<string, unknown>;
type VisibleReplyTarget = {
    id?: string;
    body?: string;
    sender?: {
        label?: string | null;
    } | null;
};
type ReplyThreadingContext = {
    implicitCurrentMessage?: "default" | "allow" | "deny";
};
type SenderContext = {
    id?: string;
    name?: string;
    e164?: string;
};
export declare function resolveWhatsAppResponsePrefix(params: {
    cfg: ReturnType<LoadConfigFn>;
    agentId: string;
    isSelfChat: boolean;
    pipelineResponsePrefix?: string;
}): string | undefined;
export declare function buildWhatsAppInboundContext(params: {
    bodyForAgent?: string;
    combinedBody: string;
    commandBody?: string;
    commandAuthorized?: boolean;
    commandTurn?: CommandTurnContext;
    commandSource?: "text";
    conversationId: string;
    groupHistory?: GroupHistoryEntry[];
    groupMemberRoster?: Map<string, string>;
    groupSystemPrompt?: string;
    msg: WebInboundMsg;
    rawBody?: string;
    route: ReturnType<typeof resolveAgentRoute>;
    sender: SenderContext;
    transcript?: string;
    mediaTranscribedIndexes?: number[];
    replyThreading?: ReplyThreadingContext;
    visibleReplyTo?: VisibleReplyTarget;
}): {
    LocationLat?: number | undefined;
    LocationLon?: number | undefined;
    LocationAccuracy?: number;
    LocationName?: string;
    LocationAddress?: string;
    LocationSource?: import("openclaw/plugin-sdk/channel-location").LocationSource | undefined;
    LocationIsLive?: boolean | undefined;
    LocationCaption?: string;
    Body: string;
    BodyForAgent: string;
    InboundHistory: import("openclaw/plugin-sdk/reply-history").HistoryEntry[] | undefined;
    RawBody: string;
    CommandBody: string;
    Transcript: string | undefined;
    From: string;
    To: string;
    SessionKey: string;
    AccountId: string;
    MessageSid: string | undefined;
    ReplyToId: string | undefined;
    ReplyToBody: string | undefined;
    ReplyToSender: string | null | undefined;
    MediaPath: string | undefined;
    MediaUrl: string | undefined;
    MediaType: string | undefined;
    MediaTranscribedIndexes: number[] | undefined;
    ChatType: "direct" | "group";
    Timestamp: number | undefined;
    ConversationLabel: string;
    GroupSubject: string | undefined;
    GroupMembers: string | undefined;
    SenderName: string | undefined;
    SenderId: string | undefined;
    SenderE164: string | undefined;
    CommandAuthorized: boolean | undefined;
    CommandTurn: CommandTurnContext | undefined;
    CommandSource: "native" | "text" | undefined;
    ReplyThreading: ReplyThreadingContext | undefined;
    WasMentioned: boolean | undefined;
    GroupSystemPrompt: string | undefined;
    UntrustedStructuredContext: {
        label: string;
        source?: string;
        type?: string;
        payload: unknown;
    }[] | undefined;
    Provider: string;
    Surface: string;
    OriginatingChannel: string;
    OriginatingTo: string;
} & Omit<import("openclaw/plugin-sdk/reply-runtime").MsgContext, "CommandAuthorized"> & {
    CommandAuthorized: boolean;
    CommandTurn?: CommandTurnContext;
};
export declare function resolveWhatsAppDmRouteTarget(params: {
    msg: WebInboundMsg;
    senderE164?: string;
    normalizeE164: (value: string) => string | null;
}): string | undefined;
export declare function updateWhatsAppMainLastRoute(params: {
    backgroundTasks: Set<Promise<unknown>>;
    cfg: ReturnType<LoadConfigFn>;
    ctx: Record<string, unknown>;
    dmRouteTarget?: string;
    pinnedMainDmRecipient: string | null;
    route: ReturnType<typeof resolveAgentRoute>;
    updateLastRoute: (params: {
        cfg: ReturnType<LoadConfigFn>;
        backgroundTasks: Set<Promise<unknown>>;
        storeAgentId: string;
        sessionKey: string;
        channel: "whatsapp";
        to: string;
        accountId?: string;
        ctx: Record<string, unknown>;
        warn: ReturnType<typeof getChildLogger>["warn"];
    }) => void;
    warn: ReturnType<typeof getChildLogger>["warn"];
}): void;
export declare function dispatchWhatsAppBufferedReply(params: {
    cfg: ReturnType<LoadConfigFn>;
    connectionId: string;
    context: Record<string, unknown>;
    conversationId: string;
    deliverReply: (params: {
        replyResult: ReplyPayload;
        normalizedReplyResult?: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
        msg: WebInboundMsg;
        mediaLocalRoots: readonly string[];
        maxMediaBytes: number;
        textLimit: number;
        chunkMode?: ReturnType<typeof resolveChunkMode>;
        replyLogger: ReturnType<typeof getChildLogger>;
        connectionId?: string;
        skipLog?: boolean;
        tableMode?: ReturnType<typeof resolveMarkdownTableMode>;
    }) => Promise<WhatsAppReplyDeliveryResult>;
    groupHistories: Map<string, GroupHistoryEntry[]>;
    groupHistoryKey: string;
    maxMediaBytes: number;
    maxMediaTextChunkLimit?: number;
    msg: WebInboundMsg;
    onModelSelected?: ChannelReplyOnModelSelected;
    rememberSentText: (text: string | undefined, opts: {
        combinedBody?: string;
        combinedBodySessionKey?: string;
        logVerboseMessage?: boolean;
    }) => void;
    replyLogger: ReturnType<typeof getChildLogger>;
    replyPipeline: WhatsAppDispatchPipeline;
    replyResolver: typeof getReplyFromConfig;
    route: ReturnType<typeof resolveAgentRoute>;
    shouldClearGroupHistory: boolean;
    statusReactionController?: StatusReactionController | null;
}): Promise<boolean>;
export {};
