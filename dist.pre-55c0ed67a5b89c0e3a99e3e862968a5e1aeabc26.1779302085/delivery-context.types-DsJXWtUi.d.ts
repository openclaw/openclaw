import { c as ChannelRouteTargetInput } from "./channel-route-BCPDrLfB.js";

//#region src/utils/delivery-context.types.d.ts
type DeliveryIntentRef = {
  id: string;
  kind: "outbound_queue";
  queuePolicy?: "required" | "best_effort";
};
type DeliveryContext = Pick<ChannelRouteTargetInput, "accountId" | "channel" | "threadId" | "to"> & {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryIntent?: DeliveryIntentRef;
};
//#endregion
export { DeliveryContext as t };