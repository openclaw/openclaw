import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { AnyAgentTool } from "./tools/common.js";
export declare function applyPluginToolDeliveryDefaults(params: {
    tools: AnyAgentTool[];
    deliveryContext?: DeliveryContext;
}): AnyAgentTool[];
