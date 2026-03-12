import type { AcpRuntimeEvent } from "../../acp/runtime/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.js";
export type AcpReplyProjector = {
    onEvent: (event: AcpRuntimeEvent) => Promise<void>;
    flush: (force?: boolean) => Promise<void>;
};
export declare function createAcpReplyProjector(params: {
    cfg: OpenClawConfig;
    shouldSendToolSummaries: boolean;
    deliver: (kind: ReplyDispatchKind, payload: ReplyPayload) => Promise<boolean>;
    provider?: string;
    accountId?: string;
}): AcpReplyProjector;
