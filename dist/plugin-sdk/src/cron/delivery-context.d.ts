import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type DeliveryContext } from "../utils/delivery-context.shared.js";
import type { CronDelivery } from "./types.js";
export declare function cronDeliveryFromContext(context?: DeliveryContext): CronDelivery | null;
export declare function resolveCronStoredDeliveryContext(params: {
    cfg: OpenClawConfig;
    sessionKey?: string;
}): DeliveryContext | undefined;
export declare function resolveCronCreationDelivery(params: {
    cfg: OpenClawConfig;
    currentDeliveryContext?: DeliveryContext;
    agentSessionKey?: string;
}): CronDelivery | null;
