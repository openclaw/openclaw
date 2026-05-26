import type { ReplyPayload } from "../types.js";
import type { ApplyInlineDirectivesFastLaneParams } from "./directive-handling.params.js";
export declare function applyInlineDirectivesFastLane(params: ApplyInlineDirectivesFastLaneParams): Promise<{
    directiveAck?: ReplyPayload;
    provider: string;
    model: string;
}>;
