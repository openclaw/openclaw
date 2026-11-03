import { expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  advancePendingFinalDeliveryCompletion,
  persistPendingFinalDeliveryMarker,
} from "./pending-final-delivery-marker.js";

const state = vi.hoisted(() => ({ applySessionEntryReplacements: vi.fn() }));

// mock-isolation: Apply the replacement callback to the fixture entry without opening a session store.
vi.mock("../config/sessions/session-accessor.js", () => ({
  applySessionEntryReplacements: state.applySessionEntryReplacements,
}));

it.each(["matching", "wrong-intent", "wrong-delivery", "wrong-predecessor"])(
  "captures a durable batch and fences its compaction locator (%s)",
  async (mode) => {
    const entry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
    state.applySessionEntryReplacements.mockImplementationOnce(
      async (params: Parameters<typeof applySessionEntryReplacements>[0]) =>
        (await params.update([{ sessionKey: "agent:main:main", entry }])).result,
    );
    const payloads = [
      { text: "first" },
      { text: "reasoning", isReasoning: true },
      { text: "second" },
    ];

    const result = await persistPendingFinalDeliveryMarker({
      agentId: "main",
      deliver: true,
      sessionStore: { main: entry },
      sessionKey: "main",
      storePath: "/tmp/sessions.json",
      suppressVisibleSessionEffects: false,
      sessionReboundDuringRun: false,
      payloads,
      deliveryContext: { channel: "discord", to: "channel:c1" },
      runOwnedSessionId: "session-1",
    });

    const marker = result.sessionEntry?.pendingFinalDelivery;
    expect(marker).toMatchObject({ kind: "transport-only" });
    expect(marker).not.toHaveProperty("text");
    expect(marker?.deliveries).toEqual([{ id: expect.any(String), state: "prepared" }]);
    const deliveryId = marker?.deliveries?.[0]?.id;
    expect(
      payloads.map(
        (payload) => getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion?.deliveryId,
      ),
    ).toEqual([deliveryId, undefined, deliveryId]);
    const completion = getReplyPayloadMetadata(payloads[0]!)?.pendingFinalDeliveryCompletion;
    const current = { sessionId: "compacted", lifecycleRevision: "next" };
    advancePendingFinalDeliveryCompletion({
      payloads,
      intentId: mode === "wrong-intent" ? "other" : marker!.intentId,
      transition: {
        previous: { sessionId: mode === "wrong-predecessor" ? "other" : entry.sessionId },
        current,
      },
      entry: {
        ...result.sessionEntry!,
        ...current,
        pendingFinalDelivery: {
          ...marker!,
          deliveries: [
            { id: mode === "wrong-delivery" ? "other" : deliveryId!, state: "prepared" },
          ],
        },
      },
    });
    expect(getReplyPayloadMetadata(payloads[0]!)?.pendingFinalDeliveryCompletion).toEqual({
      ...completion,
      sessionId: mode === "matching" ? current.sessionId : entry.sessionId,
    });
  },
);
