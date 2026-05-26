import type { OpenClawConfig } from "../config/types.openclaw.js";
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
}): import("../utils/delivery-context.types.ts").DeliveryContext | undefined;
