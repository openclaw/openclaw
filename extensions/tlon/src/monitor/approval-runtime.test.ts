import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { describe, expect, it, vi } from "vitest";
import { TLON_PENDING_APPROVAL_LIMIT, type PendingApproval } from "../settings.js";
import { createTlonApprovalRuntime } from "./approval-runtime.js";

function createApproval(index: number): PendingApproval {
  return { id: `dm-${index}`, type: "dm", requestingShip: `~ship-${index}`, timestamp: index };
}

const message = { messageId: "m", messageText: "updated", messageContent: "updated", timestamp: 1 };

function createFixture(
  approvals = Array.from({ length: TLON_PENDING_APPROVAL_LIMIT }, (_, index) =>
    createApproval(index),
  ),
) {
  const state: Parameters<typeof createTlonApprovalRuntime>[0]["state"] = {
    pendingApprovals: approvals,
    currentSettings: {},
    effectiveDmAllowlist: [],
    effectiveOwnerShip: "~owner",
  };
  const poke = vi.fn().mockResolvedValue(undefined);
  const runtime = { error: vi.fn(), log: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv;
  const approvalRuntime = createTlonApprovalRuntime({
    api: { poke, scry: vi.fn().mockResolvedValue([]) },
    runtime,
    botShipName: "~bot",
    state,
    processApprovedMessage: vi.fn().mockResolvedValue(undefined),
    refreshWatchedChannels: vi.fn().mockResolvedValue(0),
  });
  return { approvals, poke, runtime, ...approvalRuntime, state };
}

describe("Tlon pending approval limit", () => {
  it.each([false, true])("bounds overflow notifications when delivery fails=%s", async (fails) => {
    const requests = fails ? 4 : 2;
    const notices = fails ? 3 : 1;
    const fixture = createFixture();
    if (fails) {
      fixture.poke.mockRejectedValue(new Error("owner unavailable"));
    }
    for (let index = 0; index < requests; index += 1) {
      const approval = createApproval(TLON_PENDING_APPROVAL_LIMIT + index);
      expect(await fixture.queueApprovalRequest(approval)).toBe(false);
    }
    expect(fixture.state.pendingApprovals).toEqual(fixture.approvals);
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
  });

  it("still updates an existing approval when the queue is full", async () => {
    const fixture = createFixture();
    const updated = {
      ...createApproval(0),
      messagePreview: "updated",
      originalMessage: message,
    } satisfies PendingApproval;

    expect(await fixture.queueApprovalRequest(updated)).toBe(true);
    expect(fixture.state.pendingApprovals).toHaveLength(TLON_PENDING_APPROVAL_LIMIT);
    expect(fixture.state.pendingApprovals[0]).toMatchObject({
      messagePreview: "updated",
      originalMessage: updated.originalMessage,
    });
    expect(fixture.poke).toHaveBeenCalledTimes(2);
  });

  it("moves verified provenance with the stored message when a request is updated", async () => {
    const fixture = createFixture();
    await fixture.queueApprovalRequest({
      ...createApproval(0),
      verifiedDirect: true,
      originalMessage: message,
    });
    expect(fixture.state.pendingApprovals[0]?.verifiedDirect).toBe(true);
    await fixture.queueApprovalRequest({ ...createApproval(0), originalMessage: message });
    expect(fixture.state.pendingApprovals[0]?.verifiedDirect).toBeUndefined();
  });
});

describe("Tlon approval targeting", () => {
  it("applies a bare decision when exactly one request is pending", async () => {
    const fixture = createFixture([createApproval(0)]);

    expect(await fixture.handleApprovalResponse("approve")).toBe(true);

    expect(fixture.state.effectiveDmAllowlist).toEqual(["~ship-0"]);
    expect(fixture.state.pendingApprovals).toEqual([]);
  });

  it("does not guess when a bare decision has multiple pending requests", async () => {
    const fixture = createFixture();

    expect(await fixture.handleApprovalResponse("approve")).toBe(true);

    expect(fixture.state.effectiveDmAllowlist).toEqual([]);
    expect(fixture.state.pendingApprovals).toEqual(fixture.approvals);
    expect(JSON.stringify(fixture.poke.mock.calls)).toContain("Multiple approvals are pending");
    expect(JSON.stringify(fixture.poke.mock.calls)).toContain("dm-0");
    expect(JSON.stringify(fixture.poke.mock.calls)).toContain("dm-99");
  });
});
