// Tlon tests cover settings store behavior.
import { describe, expect, it } from "vitest";
import {
  createSettingsManager,
  TLON_PENDING_APPROVAL_LIMIT,
  type PendingApproval,
  type TlonSettingsStore,
} from "./settings.js";
import type { UrbitSSEClient } from "./urbit/sse-client.js";

type SubscriptionHandlers = {
  event?: (data: unknown) => Promise<void> | void;
};

function createMockSettingsApi(scryResult: unknown): {
  api: UrbitSSEClient;
  emitSettingsEvent: (event: unknown) => Promise<void>;
} {
  const handlers: SubscriptionHandlers = {};
  const api = {
    async scry() {
      return scryResult;
    },
    async subscribe(params: {
      app: string;
      path: string;
      event?: (data: unknown) => Promise<void> | void;
    }) {
      handlers.event = params.event;
      return 1;
    },
  } as unknown as UrbitSSEClient;
  return {
    api,
    emitSettingsEvent: async (event: unknown) => {
      await handlers.event?.(event);
    },
  };
}

describe("tlon settings store", () => {
  it("loads autoDiscoverChannels from the settings-store scry response", async () => {
    const { api } = createMockSettingsApi({
      all: { moltbot: { tlon: { autoDiscoverChannels: true } } },
    });

    const manager = createSettingsManager(api);
    const settings = await manager.load();

    // Regression: parseSettingsResponse previously read the dead `autoDiscover`
    // key, so the live `autoDiscoverChannels` override never reached the monitor.
    expect(settings.autoDiscoverChannels).toBe(true);
  });

  it("preserves oversized pending approvals loaded from persisted settings", async () => {
    const pendingApprovals = Array.from(
      { length: TLON_PENDING_APPROVAL_LIMIT + 1 },
      (_, index): PendingApproval => ({
        id: `dm-${index}`,
        type: "dm",
        requestingShip: `~ship-${index}`,
        timestamp: index,
      }),
    );
    const { api } = createMockSettingsApi({
      all: { moltbot: { tlon: { pendingApprovals: JSON.stringify(pendingApprovals) } } },
    });

    const settings = await createSettingsManager(api).load();

    expect(settings.pendingApprovals).toEqual(pendingApprovals);
  });

  it("loads pre-upgrade and current pending approval records from persisted settings", async () => {
    const message = { messageId: "m", messageText: "hi", messageContent: [], timestamp: 1 };
    const stored = [
      // Saved before sender provenance existed: no clubId, no verifiedDirect.
      { id: "dm-old", type: "dm", requestingShip: "~bus", timestamp: 1, originalMessage: message },
      {
        id: "dm-new",
        type: "dm",
        requestingShip: "~nec",
        timestamp: 2,
        verifiedDirect: true,
        originalMessage: message,
      },
      { id: "dm-club", type: "dm", requestingShip: "~zod", timestamp: 3, clubId: "0v3.abc" },
      // Malformed provenance fields are rejected rather than coerced.
      { id: "dm-bad-club", type: "dm", requestingShip: "~bus", timestamp: 4, clubId: 7 },
      {
        id: "dm-bad-verified",
        type: "dm",
        requestingShip: "~bus",
        timestamp: 5,
        verifiedDirect: "yes",
      },
    ];
    const { api } = createMockSettingsApi({
      all: { moltbot: { tlon: { pendingApprovals: JSON.stringify(stored) } } },
    });

    const settings = await createSettingsManager(api).load();

    expect(settings.pendingApprovals?.map((approval) => approval.id)).toEqual([
      "dm-old",
      "dm-new",
      "dm-club",
    ]);
    expect(settings.pendingApprovals?.[0]).toEqual(stored[0]);
    expect(settings.pendingApprovals?.[0]?.verifiedDirect).toBeUndefined();
    expect(settings.pendingApprovals?.[1]?.verifiedDirect).toBe(true);
    expect(settings.pendingApprovals?.[2]?.clubId).toBe("0v3.abc");
  });

  it("applies live autoDiscoverChannels updates delivered over the subscription", async () => {
    const { api, emitSettingsEvent } = createMockSettingsApi({
      all: { moltbot: { tlon: {} } },
    });

    const manager = createSettingsManager(api);
    expect((await manager.load()).autoDiscoverChannels).toBeUndefined();
    const updates: TlonSettingsStore[] = [];
    await manager.startSubscription((settings) => updates.push(settings));
    await emitSettingsEvent({
      "put-entry": {
        desk: "moltbot",
        "bucket-key": "tlon",
        "entry-key": "autoDiscoverChannels",
        value: false,
      },
    });

    expect(updates).toEqual([expect.objectContaining({ autoDiscoverChannels: false })]);
  });
});
