import type { MsgContext } from "../../../auto-reply/templating.js";
import type { loadConfig } from "../../../config/config.js";
export declare function trackBackgroundTask(backgroundTasks: Set<Promise<unknown>>, task: Promise<unknown>): void;
export declare function updateLastRouteInBackground(params: {
    cfg: ReturnType<typeof loadConfig>;
    backgroundTasks: Set<Promise<unknown>>;
    storeAgentId: string;
    sessionKey: string;
    channel: "whatsapp";
    to: string;
    accountId?: string;
    ctx?: MsgContext;
    warn: (obj: unknown, msg: string) => void;
}): void;
export declare function awaitBackgroundTasks(backgroundTasks: Set<Promise<unknown>>): Promise<void>;
