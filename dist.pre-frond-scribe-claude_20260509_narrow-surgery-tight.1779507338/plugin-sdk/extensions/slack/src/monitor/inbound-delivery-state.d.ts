import type { SlackMessageEvent } from "../types.js";
export declare function hasSlackInboundMessageDelivery(params: {
    accountId: string;
    channelId: string | undefined;
    ts: string | undefined;
}): Promise<boolean>;
export declare function recordSlackInboundMessageDeliveries(params: {
    accountId: string;
    messages: readonly SlackMessageEvent[];
}): Promise<void>;
export declare function clearSlackInboundDeliveryStateForTest(): void;
