import { createInboundEventDeliveryCorrelation } from "openclaw/plugin-sdk/inbound-event-delivery";
import { stripTelegramInternalPrefixes } from "./targets.js";

export const telegramInboundEventDelivery = createInboundEventDeliveryCorrelation({
  targetsMatch(expected, actual) {
    const expectedTarget = stripTelegramInternalPrefixes(expected).toLowerCase();
    const actualTarget = stripTelegramInternalPrefixes(actual).toLowerCase();
    return (
      expectedTarget === actualTarget ||
      (!/:topic:\d+$/u.test(expectedTarget) &&
        expectedTarget === actualTarget.replace(/:topic:\d+$/u, ""))
    );
  },
});
