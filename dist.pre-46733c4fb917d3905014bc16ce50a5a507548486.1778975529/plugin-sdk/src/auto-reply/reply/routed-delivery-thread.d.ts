import type { MsgContext } from "../templating.js";
export declare function resolveRoutedDeliveryThreadId(params: {
    ctx: MsgContext;
    sessionKey?: string;
}): string | number | undefined;
