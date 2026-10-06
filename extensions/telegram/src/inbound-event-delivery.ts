import { createInboundEventDeliveryCorrelation } from "openclaw/plugin-sdk/inbound-event-delivery";
import { stripTelegramInternalPrefixes } from "./targets.js";

function normalizeTelegramDeliveryTarget(value: string): string {
  return stripTelegramInternalPrefixes(value).toLowerCase();
}

function telegramDeliveryTargetsMatch(expected: string, actual: string): boolean {
  const expectedTarget = normalizeTelegramDeliveryTarget(expected);
  const actualTarget = normalizeTelegramDeliveryTarget(actual);
  return (
    expectedTarget === actualTarget ||
    (!/:topic:\d+$/u.test(expectedTarget) &&
      expectedTarget === actualTarget.replace(/:topic:\d+$/u, ""))
  );
}

export const telegramInboundEventDelivery = createInboundEventDeliveryCorrelation({
  targetsMatch: telegramDeliveryTargetsMatch,
});
