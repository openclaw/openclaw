import { describe, expect, it, vi } from "vitest";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";

function correlate(outboundTo: string, roomEvent = false) {
  const sessionKey = "sess:correlation";
  const markInboundEventDelivered = vi.fn();
  const options = roomEvent ? { inboundEventKind: "room_event" as const } : {};
  const end = telegramInboundEventDelivery.begin(
    sessionKey,
    { outboundTo, markInboundEventDelivered },
    options,
  );
  return {
    end,
    markInboundEventDelivered,
    notify: (to: string) => telegramInboundEventDelivery.notify({ sessionKey, to, ...options }),
  };
}

describe("telegram inbound event delivery", () => {
  it("ignores outbound sends to another destination", () => {
    const { notify, end, markInboundEventDelivered } = correlate("1");
    notify("2");
    expect(markInboundEventDelivered).not.toHaveBeenCalled();
    end();
  });

  it.each([
    ["provider-prefixed", "telegram:-100123", false],
    ["topic", "telegram:-100123:topic:77", false],
    ["legacy group", "telegram:group:-100123:topic:77", true],
  ] as const)("matches %s targets by conversation", (_name, to, roomEvent) => {
    const { notify, end, markInboundEventDelivered } = correlate("-100123", roomEvent);
    notify(to);
    expect(markInboundEventDelivered).toHaveBeenCalledTimes(1);
    end();
  });

  it("keeps topic-scoped delivery correlations topic-specific", () => {
    const { notify, end, markInboundEventDelivered } = correlate(
      "telegram:group:-100123:topic:77",
      true,
    );
    notify("telegram:group:-100123:topic:88");
    notify("telegram:group:-100123");
    expect(markInboundEventDelivered).not.toHaveBeenCalled();
    notify("telegram:group:-100123:topic:77");
    expect(markInboundEventDelivered).toHaveBeenCalledTimes(1);
    end();
  });
});
