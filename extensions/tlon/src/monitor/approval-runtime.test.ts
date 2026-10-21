import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { describe, expect, it, vi } from "vitest";
import { TLON_PENDING_APPROVAL_LIMIT, type PendingApproval } from "../settings.js";
import { createTlonApprovalRuntime } from "./approval-runtime.js";

function createApproval(index: number): PendingApproval {
  return {
    id: `dm-${index}`,
    type: "dm",
    requestingShip: `~ship-${index}`,
    timestamp: index,
  };
}

function createFixture() {
  const approvals = Array.from({ length: TLON_PENDING_APPROVAL_LIMIT }, (_, index) =>
    createApproval(index),
  );
  const state: Parameters<typeof createTlonApprovalRuntime>[0]["state"] = {
    pendingApprovals: approvals,
    currentSettings: {},
    effectiveDmAllowlist: [],
    effectiveOwnerShip: "~owner",
  };
  const poke = vi.fn().mockResolvedValue(undefined);
  const api = {
    poke,
    scry: vi.fn().mockResolvedValue([]),
  };
  const runtime = {
    error: vi.fn(),
    log: vi.fn(),
    exit: vi.fn(),
  } satisfies RuntimeEnv;
  const approvalRuntime = createTlonApprovalRuntime({
    api,
    runtime,
    botShipName: "~bot",
    state,
    processApprovedMessage: vi.fn().mockResolvedValue(undefined),
    refreshWatchedChannels: vi.fn().mockResolvedValue(0),
  });
  return {
    approvals,
    poke,
    runtime,
    approvalRuntime,
    getPendingApprovals: () => state.pendingApprovals,
  };
}

describe("Tlon pending approval limit", () => {
  it.each([
    { fails: false, requests: 2, notices: 1 },
    { fails: true, requests: 4, notices: 3 },
  ])(
    "bounds overflow notifications when delivery fails=$fails",
    async ({ fails, requests, notices }) => {
      const fixture = createFixture();
      if (fails) {
        fixture.poke.mockRejectedValue(new Error("owner unavailable"));
      }
      for (let index = 0; index < requests; index += 1) {
        expect(
          await fixture.approvalRuntime.queueApprovalRequest(
            createApproval(TLON_PENDING_APPROVAL_LIMIT + index),
          ),
        ).toBe(false);
      }
      expect(fixture.getPendingApprovals()).toEqual(fixture.approvals);
      expect(fixture.poke).toHaveBeenCalledTimes(notices);
      expect(fixture.runtime.error).toHaveBeenCalledTimes(fails ? notices : 0);
      if (!fails) {
        expect(fixture.poke).toHaveBeenCalledWith(
          expect.objectContaining({ app: "chat", mark: "chat-dm-action" }),
        );
        expect(fixture.runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("Pending approval limit reached"),
        );
      }
    },
  );

  it("still updates an existing approval when the queue is full", async () => {
    const fixture = createFixture();
    const updated = {
      ...createApproval(0),
      messagePreview: "updated",
      originalMessage: {
        messageId: "message-1",
        messageText: "updated",
        messageContent: "updated",
        timestamp: 1,
      },
    } satisfies PendingApproval;

    const queued = await fixture.approvalRuntime.queueApprovalRequest(updated);

    expect(queued).toBe(true);
    expect(fixture.getPendingApprovals()).toHaveLength(TLON_PENDING_APPROVAL_LIMIT);
    expect(fixture.getPendingApprovals()[0]).toMatchObject({
      messagePreview: "updated",
      originalMessage: updated.originalMessage,
    });
    expect(fixture.poke).toHaveBeenCalledTimes(2);
  });

  it("moves verified provenance with the stored message when a request is updated", async () => {
    const fixture = createFixture();
    const message = { messageId: "m", messageText: "t", messageContent: "t", timestamp: 1 };
    await fixture.approvalRuntime.queueApprovalRequest({
      ...createApproval(0),
      verifiedDirect: true,
      originalMessage: message,
    });
    expect(fixture.getPendingApprovals()[0]?.verifiedDirect).toBe(true);
    await fixture.approvalRuntime.queueApprovalRequest({
      ...createApproval(0),
      originalMessage: message,
    });
    expect(fixture.getPendingApprovals()[0]?.verifiedDirect).toBeUndefined();
  });
});
