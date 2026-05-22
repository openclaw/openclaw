import { readWebAuthExistsForDecision } from "./auth-store.js";
import type { OpenClawConfig } from "./runtime-api.js";
export declare function checkWhatsAppHeartbeatReady(params: {
    cfg: OpenClawConfig;
    accountId?: string;
    deps?: {
        readWebAuthExistsForDecision?: typeof readWebAuthExistsForDecision;
        hasActiveWebListener?: (accountId?: string) => boolean;
    };
}): Promise<{
    ok: false;
    reason: string;
} | {
    ok: true;
    reason: "ok";
}>;
