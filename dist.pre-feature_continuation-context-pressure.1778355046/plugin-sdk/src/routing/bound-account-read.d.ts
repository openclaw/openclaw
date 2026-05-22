import { type ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolveFirstBoundAccountId(params: {
    cfg: OpenClawConfig;
    channelId: string;
    agentId: string;
    peerId?: string;
    exactPeerIdAliases?: string[];
    peerKind?: ChatType;
    groupSpace?: string | null;
    memberRoleIds?: string[];
}): string | undefined;
