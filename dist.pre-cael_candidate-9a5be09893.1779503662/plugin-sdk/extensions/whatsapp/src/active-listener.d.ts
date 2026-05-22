import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ActiveWebListener } from "./inbound/types.js";
export type { ActiveWebListener, ActiveWebSendOptions } from "./inbound/types.js";
export declare function resolveWebAccountId(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): string;
export declare function getActiveWebListener(accountId: string): ActiveWebListener | null;
