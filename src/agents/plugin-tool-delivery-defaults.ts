import type { DeliveryContext } from "../utils/delivery-context.js";
import type { AnyAgentTool } from "./tools/common.js";

export function applyPluginToolDeliveryDefaults(params: {
  tools: AnyAgentTool[];
  deliveryContext?: DeliveryContext;
}): AnyAgentTool[] {
  void params.deliveryContext;
  return params.tools;
}
