// Telegram tests cover inbound event delivery plugin behavior.
import { describe, expect, it } from "vitest";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";

describe("telegram inbound event delivery", () => {
  it("ignores outbound sends to another destination", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin("sess:y", {
      outboundTo: "1",
      markInboundEventDelivered: () => {
        count += 1;
      },
    });
    telegramInboundEventDelivery.notify({
      sessionKey: "sess:y",
      to: "2",
      accountId: undefined,
    });
    expect(count).toBe(0);
    end();
  });

  it("matches provider-prefixed Telegram targets for delivery correlation", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin("sess:prefixed", {
      outboundTo: "-100123",
      markInboundEventDelivered: () => {
        count += 1;
      },
    });

    telegramInboundEventDelivery.notify({
      sessionKey: "sess:prefixed",
      to: "telegram:-100123",
    });

    expect(count).toBe(1);
    end();
  });

  it("matches Telegram topic targets by conversation for delivery correlation", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin("sess:topic", {
      outboundTo: "-100123",
      markInboundEventDelivered: () => {
        count += 1;
      },
    });

    telegramInboundEventDelivery.notify({
      sessionKey: "sess:topic",
      to: "telegram:-100123:topic:77",
    });

    expect(count).toBe(1);
    end();
  });

  it("matches legacy Telegram group targets for delivery correlation", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin(
      "sess:legacy-group",
      {
        outboundTo: "-100123",
        markInboundEventDelivered: () => {
          count += 1;
        },
      },
      { inboundEventKind: "room_event" },
    );

    telegramInboundEventDelivery.notify({
      sessionKey: "sess:legacy-group",
      to: "telegram:group:-100123:topic:77",
      inboundEventKind: "room_event",
    });

    expect(count).toBe(1);
    end();
  });

  it("keeps topic-scoped delivery correlations topic-specific", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin(
      "sess:topic-specific",
      {
        outboundTo: "telegram:group:-100123:topic:77",
        markInboundEventDelivered: () => {
          count += 1;
        },
      },
      { inboundEventKind: "room_event" },
    );

    telegramInboundEventDelivery.notify({
      sessionKey: "sess:topic-specific",
      to: "telegram:group:-100123:topic:88",
      inboundEventKind: "room_event",
    });
    telegramInboundEventDelivery.notify({
      sessionKey: "sess:topic-specific",
      to: "telegram:group:-100123",
      inboundEventKind: "room_event",
    });

    expect(count).toBe(0);
    telegramInboundEventDelivery.notify({
      sessionKey: "sess:topic-specific",
      to: "telegram:group:-100123:topic:77",
      inboundEventKind: "room_event",
    });
    expect(count).toBe(1);
    end();
  });
});
