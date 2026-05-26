import type { AcpTurnAttachment } from "../../acp/control-plane/manager.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedMsgContext } from "../templating.js";
export declare function loadDispatchAcpMediaRuntime(): Promise<typeof import("./dispatch-acp-media.runtime.js")>;
export type DispatchAcpAttachmentRuntime = Pick<Awaited<ReturnType<typeof loadDispatchAcpMediaRuntime>>, "MediaAttachmentCache" | "isMediaUnderstandingSkipError" | "normalizeAttachments" | "resolveMediaAttachmentLocalRoots">;
export declare function resolveAcpAttachments(params: {
    ctx: FinalizedMsgContext;
    cfg: OpenClawConfig;
    runtime?: DispatchAcpAttachmentRuntime;
}): Promise<AcpTurnAttachment[]>;
export declare function resolveAcpInlineImageAttachments(images: Array<{
    data: string;
    mimeType: string;
}> | undefined): AcpTurnAttachment[];
