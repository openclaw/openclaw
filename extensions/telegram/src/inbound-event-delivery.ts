import { createInboundEventDeliveryCorrelation } from "openclaw/plugin-sdk/inbound-event-delivery";
import { parseTelegramTarget } from "./targets.js";

export const telegramInboundEventDelivery = createInboundEventDeliveryCorrelation({
  targetsMatch(expected, actual) {
    // A chat-level expectation also accepts deliveries into one of its topics.
    const want = parseTelegramTarget(expected.toLowerCase());
    const got = parseTelegramTarget(actual.toLowerCase());
    return (
      want.chatId === got.chatId &&
      want.directMessagesTopicId === got.directMessagesTopicId &&
      (want.messageThreadId === undefined || want.messageThreadId === got.messageThreadId)
    );
  },
});
