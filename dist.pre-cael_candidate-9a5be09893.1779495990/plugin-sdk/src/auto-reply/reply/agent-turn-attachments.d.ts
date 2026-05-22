import type { AcpTurnAttachment as AgentTurnAttachment } from "../../acp/control-plane/manager.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import { type RecentInboundHistoryImage } from "./history-media.js";
export declare function loadAgentTurnMediaRuntime(): Promise<typeof import("./dispatch-acp-media.runtime.js")>;
export type AgentTurnAttachmentRuntime = Pick<Awaited<ReturnType<typeof loadAgentTurnMediaRuntime>>, "MediaAttachmentCache" | "isMediaUnderstandingSkipError" | "normalizeAttachments" | "resolveMediaAttachmentLocalRoots">;
export declare function hasPotentialAgentTurnAttachments(ctx: MsgContext): boolean;
export declare function resolveAgentTurnAttachments(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    runtime?: AgentTurnAttachmentRuntime;
    includeRecentHistoryImages?: boolean;
}): Promise<{
    attachments: AgentTurnAttachment[];
    recentHistoryImages: RecentInboundHistoryImage[];
}>;
export declare function resolveAgentAttachments(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    runtime?: AgentTurnAttachmentRuntime;
}): Promise<AgentTurnAttachment[]>;
export declare function resolveInlineAgentImageAttachments(images: Array<{
    data: string;
    mimeType: string;
}> | undefined): AgentTurnAttachment[];
