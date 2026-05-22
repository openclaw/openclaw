import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
export type GatewayMemoryProbe = {
    checked: boolean;
    ready: boolean;
    error?: string;
    /**
     * True when the probe was intentionally skipped by the gateway (probe: false
     * path). Distinct from checked: false caused by a network timeout or
     * unavailable gateway. Renderers should suppress warnings only for skipped
     * probes, not for transport failures.
     */
    skipped: boolean;
};
export declare function checkGatewayHealth(params: {
    runtime: RuntimeEnv;
    cfg: OpenClawConfig;
    timeoutMs?: number;
}): Promise<{
    healthOk: boolean;
}>;
export declare function probeGatewayMemoryStatus(params: {
    cfg: OpenClawConfig;
    timeoutMs?: number;
}): Promise<GatewayMemoryProbe>;
