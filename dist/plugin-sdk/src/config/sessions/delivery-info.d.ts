import type { OpenClawConfig } from "../types.openclaw.js";
import { parseSessionThreadInfo } from "./thread-info.js";
export { parseSessionThreadInfo };
export declare function extractDeliveryInfo(sessionKey: string | undefined, options?: {
    cfg?: OpenClawConfig;
}): {
    deliveryContext: {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string | number;
    } | undefined;
    threadId: string | undefined;
};
