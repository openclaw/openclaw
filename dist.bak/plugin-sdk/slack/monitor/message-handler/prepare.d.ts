import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { type SlackMonitorContext } from "../context.js";
import type { PreparedSlackMessage } from "./types.js";
export declare function prepareSlackMessage(params: {
    ctx: SlackMonitorContext;
    account: ResolvedSlackAccount;
    message: SlackMessageEvent;
    opts: {
        source: "message" | "app_mention";
        wasMentioned?: boolean;
    };
}): Promise<PreparedSlackMessage | null>;
