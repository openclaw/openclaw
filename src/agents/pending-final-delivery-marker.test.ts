import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { persistPendingFinalDeliveryMarker } from "./pending-final-delivery-marker.js";

const state = vi.hoisted(() => ({ applySessionEntryReplacements: vi.fn() }));

vi.mock("../config/sessions/session-accessor.js", () => ({
  applySessionEntryReplacements: (...args: unknown[]) =>
    state.applySessionEntryReplacements(...args),
}));

describe("persistPendingFinalDeliveryMarker", () => {
  beforeEach(() => {
    state.applySessionEntryReplacements.mockReset();
  });

  it("owns a multi-payload command delivery as one durable batch", async () => {
    const entry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
    state.applySessionEntryReplacements.mockImplementation(
      async (
        params: Parameters<
          typeof import("../config/sessions/session-accessor.js").applySessionEntryReplacements
        >[0],
      ) => (await params.update([{ sessionKey: "agent:main:main", entry }])).result,
    );
    const payloads = [
      { text: "first" },
      { text: "internal reasoning", isReasoning: true },
      { text: "second" },
    ];

    const result = await persistPendingFinalDeliveryMarker({
      agentId: "main",
      deliver: true,
      sessionStore: { main: entry },
      sessionKey: "main",
      sessionEntry: entry,
      storePath: "/tmp/sessions.json",
      suppressVisibleSessionEffects: false,
      sessionReboundDuringRun: false,
      payloads,
      deliveryContext: { channel: "discord", to: "channel:c1" },
      runOwnedSessionId: "session-1",
    });

    expect(result.sessionEntry?.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: "first\n\nsecond",
    });
    expect(result.sessionEntry?.pendingFinalDelivery?.deliveries).toEqual([
      { id: expect.any(String), state: "prepared" },
    ]);
    const deliveryId = result.sessionEntry?.pendingFinalDelivery?.deliveries?.[0]?.id;
    expect(
      payloads.map(
        (payload) => getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion?.deliveryId,
      ),
    ).toEqual([deliveryId, undefined, deliveryId]);
  });
});
