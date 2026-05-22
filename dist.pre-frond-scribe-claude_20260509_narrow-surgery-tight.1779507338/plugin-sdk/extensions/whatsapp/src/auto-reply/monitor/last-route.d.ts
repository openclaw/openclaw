import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
export declare function trackBackgroundTask(backgroundTasks: Set<Promise<unknown>>, task: Promise<unknown>): void;
export declare function updateLastRouteInBackground(params: {
    cfg: OpenClawConfig;
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
