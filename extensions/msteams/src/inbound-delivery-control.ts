// Msteams plugin module implements local inbound delivery controls.
import type { MSTeamsTurnContext } from "./sdk-types.js";

const INBOUND_DELIVERY_CONTROL_PROP = "__openclawMSTeamsInboundDelivery";

export type MSTeamsInboundDeliveryControl = {
  skipDebounce?: boolean;
  complete?: () => Promise<void>;
  release?: (err: unknown) => Promise<void>;
};

type MSTeamsTurnContextWithDeliveryControl = MSTeamsTurnContext & {
  [INBOUND_DELIVERY_CONTROL_PROP]?: MSTeamsInboundDeliveryControl;
};

export function withMSTeamsInboundDeliveryControl(
  context: MSTeamsTurnContext,
  control: MSTeamsInboundDeliveryControl,
): MSTeamsTurnContext {
  return Object.assign(context, {
    [INBOUND_DELIVERY_CONTROL_PROP]: control,
  });
}

export function readMSTeamsInboundDeliveryControl(
  context: MSTeamsTurnContext,
): MSTeamsInboundDeliveryControl | undefined {
  return (context as MSTeamsTurnContextWithDeliveryControl)[INBOUND_DELIVERY_CONTROL_PROP];
}
