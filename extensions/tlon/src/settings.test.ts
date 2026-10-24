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

function createMockSettingsApi(settings: Record<string, unknown>, logs?: string[]) {
  const handlers: SubscriptionHandlers = {};
  const api = {
    async scry() {
      return { all: { moltbot: { tlon: settings } } };
    },
    async subscribe(params: SubscriptionHandlers) {
      handlers.event = params.event;
      return 1;
    },
  } as unknown as UrbitSSEClient;
  return {
    manager: createSettingsManager(api, logs && { log: (message) => logs.push(message) }),
    emit: async (key: string, value: unknown) =>
      handlers.event?.({
        "put-entry": { desk: "moltbot", "bucket-key": "tlon", "entry-key": key, value },
      }),
  };
}

const pendingApproval = (id: string, timestamp: number, ship = "~bus"): PendingApproval => ({
  id,
  type: "dm",
  requestingShip: ship,
  timestamp,
});

describe("tlon settings store", () => {
  it("loads autoDiscoverChannels from the settings-store scry response", async () => {
    const { manager } = createMockSettingsApi({ autoDiscoverChannels: true });
    // Regression: the parser previously read the dead `autoDiscover` key.
    expect((await manager.load()).autoDiscoverChannels).toBe(true);
  });

  it("preserves oversized pending approvals loaded from persisted settings", async () => {
    const pendingApprovals = Array.from({ length: TLON_PENDING_APPROVAL_LIMIT + 1 }, (_, index) =>
      pendingApproval(`dm-${index}`, index, `~ship-${index}`),
    );
    const { manager } = createMockSettingsApi({
      pendingApprovals: JSON.stringify(pendingApprovals),
    });
    expect((await manager.load()).pendingApprovals).toEqual(pendingApprovals);
  });

  it("loads pre-upgrade and current pending approval records from persisted settings", async () => {
    const message = { messageId: "m", messageText: "hi", messageContent: [], timestamp: 1 };
    const stored = [
      // Saved before sender provenance existed: no clubId, no verifiedDirect.
      { ...pendingApproval("dm-old", 1), originalMessage: message },
      { ...pendingApproval("dm-new", 2, "~nec"), verifiedDirect: true, originalMessage: message },
      { ...pendingApproval("dm-club", 3, "~zod"), clubId: "0v3.abc" },
      // Malformed provenance fields are rejected rather than coerced.
      { ...pendingApproval("dm-bad-club", 4), clubId: 7 },
      { ...pendingApproval("dm-bad-verified", 5), verifiedDirect: "yes" },
    ];
    const { manager } = createMockSettingsApi({ pendingApprovals: JSON.stringify(stored) });
    expect((await manager.load()).pendingApprovals).toEqual(stored.slice(0, 3));
  });

  it("applies live autoDiscoverChannels updates delivered over the subscription", async () => {
    const { manager, emit } = createMockSettingsApi({});
    expect((await manager.load()).autoDiscoverChannels).toBeUndefined();
    const updates: TlonSettingsStore[] = [];
    await manager.startSubscription((settings) => updates.push(settings));
    await emit("autoDiscoverChannels", false);

    expect(updates).toEqual([expect.objectContaining({ autoDiscoverChannels: false })]);
  });

  it("preserves pending approval contents without logging them", async () => {
    const approval: PendingApproval = {
      ...pendingApproval("approval-1", 1, "~zod"),
      messagePreview: "private-tlon-preview",
      originalMessage: {
        messageId: "message-1",
        messageText: "private-tlon-body",
        messageContent: { text: "private-tlon-body" },
        timestamp: 1,
      },
    };
    const logs: string[] = [];
    const { manager, emit } = createMockSettingsApi({ pendingApprovals: [approval] }, logs);
    expect((await manager.load()).pendingApprovals).toEqual([approval]);
    const updates: TlonSettingsStore[] = [];
    await manager.startSubscription((settings) => updates.push(settings));
    await emit("pendingApprovals", JSON.stringify([approval]));

    expect(updates[0]?.pendingApprovals).toEqual([approval]);
    expect(logs).toContain("[settings] Loaded");
    expect(logs).toContain("[settings] Update: pendingApprovals");
    expect(logs.join("\n")).not.toContain("private-tlon-");
  });
});
