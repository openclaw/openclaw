import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";
export type PrivateCommandRouteTarget = {
    channel: string;
    to: string;
    accountId?: string | null;
    threadId?: string | number | null;
};
export declare function resolvePrivateCommandRouteTargets(params: {
    commandParams: HandleCommandsParams;
    request: ExecApprovalRequest;
}): Promise<PrivateCommandRouteTarget[]>;
export declare function deliverPrivateCommandReply(params: {
    commandParams: HandleCommandsParams;
    targets: PrivateCommandRouteTarget[];
    reply: ReplyPayload;
}): Promise<boolean>;
export declare function readCommandMessageThreadId(params: HandleCommandsParams): string | undefined;
export declare function readCommandDeliveryTarget(params: HandleCommandsParams): string | undefined;
