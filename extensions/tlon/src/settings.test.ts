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

  it("applies live autoDiscoverChannels updates delivered over the subscription", async () => {
    const { api, emitSettingsEvent } = createMockSettingsApi({
      all: { moltbot: { tlon: {} } },
    });

    const manager = createSettingsManager(api);
    expect((await manager.load()).autoDiscoverChannels).toBeUndefined();
    const updates: TlonSettingsStore[] = [];
    manager.onChange((settings) => updates.push(settings));

    await manager.startSubscription();
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
