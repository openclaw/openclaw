import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionEntry } from "./types.js";
export declare function loadCombinedSessionStoreForGateway(cfg: OpenClawConfig, opts?: {
    agentId?: string;
}): {
    storePath: string;
    store: Record<string, SessionEntry>;
};
