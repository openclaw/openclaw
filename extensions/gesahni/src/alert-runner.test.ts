import { deliverOutboundPayloads } from "openclaw/plugin-sdk/outbound-runtime";
import { describe, expect, it, vi } from "vitest";
import { deliverDiscordAlert } from "./alert-runner.js";
import type { AlertRecord } from "./alerts.js";

vi.mock("openclaw/plugin-sdk/outbound-runtime", () => ({
  deliverOutboundPayloads: vi.fn(async () => [{ channel: "discord", messageId: "m1" }]),
}));

function createAlert(overrides: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id: "alrt_test",
    scope: "group",
    owner: {
      channel: "discord",
      senderId: "1309247958029701190",
    },
    instrument: {
      kind: "equity",
      symbol: "AAPL",
    },
    condition: {
      metric: "price",
      operator: ">=",
      value: 210,
    },
    delivery: {
      channel: "discord",
      target: "channel:stock-alerts",
      label: "#stock-alerts",
    },
    schedule: {
      marketHours: "regular",
      pollSeconds: 30,
      cooldownSeconds: 300,
      dedupe: "state_change",
    },
    status: "active",
    originalText: "group AAPL above 210",
    createdAt: "2026-05-06T14:30:00Z",
    ...overrides,
  };
}

describe("gesahni alert runner delivery", () => {
  it("delivers group alerts through the stock-alerts Discord target", async () => {
    await deliverDiscordAlert({
      cfg: {},
      alert: createAlert(),
      text: "Stock alert fired",
    });

    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:stock-alerts",
        payloads: [{ text: "Stock alert fired" }],
        session: {
          conversationType: "group",
          requesterSenderId: "1309247958029701190",
        },
      }),
    );
  });

  it("marks private alert delivery as a direct conversation", async () => {
    await deliverDiscordAlert({
      cfg: {},
      alert: createAlert({
        scope: "private",
        delivery: {
          channel: "discord",
          target: "user:1309247958029701190",
          label: "DM",
        },
      }),
      text: "Private alert fired",
    });

    expect(deliverOutboundPayloads).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to: "user:1309247958029701190",
        session: {
          conversationType: "direct",
          requesterSenderId: "1309247958029701190",
        },
      }),
    );
  });
});
