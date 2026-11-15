import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { baseDeliveryParams } from "./auto-reply-delivery.test-helpers.js";

type DeliveryParams = Parameters<typeof deliverLineAutoReply>[0];
export function deliver(
  payload: DeliveryParams["payload"],
  lineData: DeliveryParams["lineData"] = {},
  overrides: Partial<DeliveryParams> = {},
) {
  return deliverLineAutoReply({ ...baseDeliveryParams, payload, lineData, ...overrides });
}
