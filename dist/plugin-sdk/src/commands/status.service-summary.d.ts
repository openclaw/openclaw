import { type GatewayServiceLayoutSummary } from "../daemon/service-layout.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import { type GatewayService } from "../daemon/service.js";
export type ServiceStatusSummary = {
    label: string;
    installed: boolean | null;
    loaded: boolean;
    managedByOpenClaw: boolean;
    externallyManaged: boolean;
    loadedText: string;
    runtime: GatewayServiceRuntime | undefined;
    layout?: GatewayServiceLayoutSummary;
};
export declare function readServiceStatusSummary(service: GatewayService, fallbackLabel: string): Promise<ServiceStatusSummary>;
