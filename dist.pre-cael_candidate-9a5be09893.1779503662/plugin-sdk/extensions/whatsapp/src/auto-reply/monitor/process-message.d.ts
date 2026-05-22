import { type AckReactionHandle } from "openclaw/plugin-sdk/channel-feedback";
import type { WebInboundMsg } from "../types.js";
import { type GroupHistoryEntry } from "./inbound-context.js";
import { type getChildLogger, type getReplyFromConfig, type LoadConfigFn, type resolveAgentRoute } from "./runtime-api.js";
import { type StatusReactionController } from "./status-reaction.js";
export declare function processMessage(params: {
    cfg: ReturnType<LoadConfigFn>;
    msg: WebInboundMsg;
    route: ReturnType<typeof resolveAgentRoute>;
    groupHistoryKey: string;
    groupHistories: Map<string, GroupHistoryEntry[]>;
    groupMemberNames: Map<string, Map<string, string>>;
    connectionId: string;
    verbose: boolean;
    maxMediaBytes: number;
    replyResolver: typeof getReplyFromConfig;
    replyLogger: ReturnType<typeof getChildLogger>;
    backgroundTasks: Set<Promise<unknown>>;
    rememberSentText: (text: string | undefined, opts: {
        combinedBody?: string;
        combinedBodySessionKey?: string;
        logVerboseMessage?: boolean;
    }) => void;
    echoHas: (key: string) => boolean;
    echoForget: (key: string) => void;
    buildCombinedEchoKey: (p: {
        sessionKey: string;
        combinedBody: string;
    }) => string;
    maxMediaTextChunkLimit?: number;
    groupHistory?: GroupHistoryEntry[];
    suppressGroupHistoryClear?: boolean;
    ackAlreadySent?: boolean;
    ackReaction?: AckReactionHandle | null;
    statusReactionController?: StatusReactionController | null;
    /** Pre-computed audio transcript from a caller-level preflight, used to avoid
     * re-transcribing the same voice note once per broadcast agent.
     * - string  → transcript obtained; use it directly, skip internal STT
     * - null    → preflight was attempted but failed / returned nothing; skip internal STT
     * - undefined (omitted) → caller did not attempt preflight; run internal STT as normal */
    preflightAudioTranscript?: string | null;
}): Promise<boolean>;
