import type { AfterToolCallContext, AfterToolCallResult, Agent } from "@earendil-works/pi-agent-core";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
export declare function shouldTerminateAfterMessageToolOnlySend(params: {
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    context: AfterToolCallContext;
    hookResult?: AfterToolCallResult;
}): boolean;
export declare function installMessageToolOnlyTerminalHook(params: {
    agent: Agent;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): void;
