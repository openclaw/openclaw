import type { ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function extractRequesterPeer(channelId: string | undefined, requesterTo: string | undefined): {
    peerId?: string;
    peerKind?: ChatType;
};
export declare function resolveRequesterOriginForChild(params: {
    cfg: OpenClawConfig;
    targetAgentId: string;
    requesterAgentId: string;
    requesterChannel?: string;
    requesterAccountId?: string;
    requesterTo?: string;
    requesterThreadId?: string | number;
    requesterGroupSpace?: string | null;
    requesterMemberRoleIds?: string[];
}): import("../utils/delivery-context.types.js").DeliveryContext | undefined;
