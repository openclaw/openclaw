import type { OpenClawConfig } from "../../config/config.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
type DispatchProcessedRecorder = (outcome: "completed" | "skipped" | "error", opts?: {
    reason?: string;
    error?: string;
}) => void;
export declare function shouldBypassAcpDispatchForCommand(ctx: FinalizedMsgContext, cfg: OpenClawConfig): boolean;
export type AcpDispatchAttemptResult = {
    queuedFinal: boolean;
    counts: Record<ReplyDispatchKind, number>;
};
export declare function tryDispatchAcpReply(params: {
    ctx: FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcher: ReplyDispatcher;
    sessionKey?: string;
    inboundAudio: boolean;
    sessionTtsAuto?: TtsAutoMode;
    ttsChannel?: string;
    shouldRouteToOriginating: boolean;
    originatingChannel?: string;
    originatingTo?: string;
    shouldSendToolSummaries: boolean;
    bypassForCommand: boolean;
    recordProcessed: DispatchProcessedRecorder;
    markIdle: (reason: string) => void;
}): Promise<AcpDispatchAttemptResult | null>;
export {};
