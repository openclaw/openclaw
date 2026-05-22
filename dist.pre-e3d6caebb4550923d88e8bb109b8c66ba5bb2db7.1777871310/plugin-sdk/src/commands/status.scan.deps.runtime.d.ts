import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import type { MemoryProviderStatus } from "../memory-host-sdk/engine-storage.js";
export { getTailnetHostname };
type StatusMemoryManager = {
    probeVectorAvailability(): Promise<boolean>;
    status(): MemoryProviderStatus;
    close?(): Promise<void>;
};
export declare function getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose: "status";
}): Promise<{
    manager: StatusMemoryManager | null;
}>;
