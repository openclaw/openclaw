import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";
type DispatchProcessedRecorder = (outcome: "completed" | "skipped" | "error", opts?: {
    reason?: string;
    error?: string;
}) => void;
export type AcpDispatchAttemptResult = {
    queuedFinal: boolean;
    counts: Record<ReplyDispatchKind, number>;
};
export declare function tryDispatchAcpReply(params: {
    ctx: FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcher: ReplyDispatcher;
    runId?: string;
    sessionKey?: string;
    images?: Array<{
        data: string;
        mimeType: string;
    }>;
    abortSignal?: AbortSignal;
    inboundAudio: boolean;
    sessionTtsAuto?: TtsAutoMode;
    ttsChannel?: string;
    suppressUserDelivery?: boolean;
    suppressReplyLifecycle?: boolean;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    shouldRouteToOriginating: boolean;
    originatingChannel?: string;
    originatingTo?: string;
    shouldSendToolSummaries: boolean;
    bypassForCommand: boolean;
    onReplyStart?: () => Promise<void> | void;
    recordProcessed: DispatchProcessedRecorder;
    markIdle: (reason: string) => void;
}): Promise<AcpDispatchAttemptResult | null>;
export {};
