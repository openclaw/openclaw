// Tlon tests cover bounded pending approval behavior and replay provenance.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  TLON_PENDING_APPROVAL_LIMIT,
  type PendingApproval,
  type TlonSettingsStore,
} from "../settings.js";
import type { UrbitSSEClient } from "../urbit/sse-client.js";
import { createTlonApprovalRuntime } from "./approval-runtime.js";

function createApproval(index: number): PendingApproval {
  return {
    id: `dm-${index}`,
    type: "dm",
    requestingShip: `~ship-${index}`,
    timestamp: index,
  };
}

function createFixture(initialApprovals: PendingApproval[]) {
  let pendingApprovals = initialApprovals;
  const poke = vi.fn().mockResolvedValue(undefined);
  const api = {
    poke,
    scry: vi.fn().mockResolvedValue([]),
    // SAFETY: the approval runtime only consumes these two mocked Urbit client methods.
  } as unknown as Pick<UrbitSSEClient, "poke" | "scry">;
  const runtime = {
    error: vi.fn(),
    log: vi.fn(),
    // SAFETY: the approval runtime only consumes these two mocked runtime callbacks.
  } as unknown as RuntimeEnv;
  let currentSettings: TlonSettingsStore = {};
  const approvalRuntime = createTlonApprovalRuntime({
    api,
    runtime,
    botShipName: "~bot",
    getPendingApprovals: () => pendingApprovals,
    setPendingApprovals: (approvals) => {
      pendingApprovals = approvals;
    },
    getCurrentSettings: () => currentSettings,
    setCurrentSettings: (settings) => {
      currentSettings = settings;
    },
    getEffectiveDmAllowlist: () => [],
    setEffectiveDmAllowlist: vi.fn(),
    getEffectiveOwnerShip: () => "~owner",
    processApprovedMessage: vi.fn().mockResolvedValue(undefined),
    refreshWatchedChannels: vi.fn().mockResolvedValue(0),
  });
  return {
    api,
    poke,
    runtime,
    approvalRuntime,
    getPendingApprovals: () => pendingApprovals,
  };
}

describe("Tlon pending approval limit", () => {
  it("rejects unique overflow and notifies the owner once", async () => {
    const approvals = Array.from({ length: TLON_PENDING_APPROVAL_LIMIT }, (_, index) =>
      createApproval(index),
    );
    const fixture = createFixture(approvals);

    const firstQueued = await fixture.approvalRuntime.queueApprovalRequest(
      createApproval(TLON_PENDING_APPROVAL_LIMIT),
    );
    const secondQueued = await fixture.approvalRuntime.queueApprovalRequest(
      createApproval(TLON_PENDING_APPROVAL_LIMIT + 1),
    );

    expect(firstQueued).toBe(false);
    expect(secondQueued).toBe(false);
    expect(fixture.getPendingApprovals()).toEqual(approvals);
    expect(fixture.poke).toHaveBeenCalledOnce();
    expect(fixture.poke).toHaveBeenCalledWith(
      expect.objectContaining({ app: "chat", mark: "chat-dm-action" }),
    );
    expect(fixture.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Pending approval limit reached"),
    );
  });

  it("retries failed overflow notices with a per-run bound", async () => {
    const approvals = Array.from({ length: TLON_PENDING_APPROVAL_LIMIT }, (_, index) =>
      createApproval(index),
    );
    const fixture = createFixture(approvals);
    fixture.poke.mockRejectedValue(new Error("owner unavailable"));

    for (let index = 0; index < 4; index += 1) {
      await fixture.approvalRuntime.queueApprovalRequest(
        createApproval(TLON_PENDING_APPROVAL_LIMIT + index),
      );
    }

    expect(fixture.poke).toHaveBeenCalledTimes(3);
    expect(fixture.runtime.error).toHaveBeenCalledTimes(3);
    expect(fixture.getPendingApprovals()).toEqual(approvals);
  });

  it("still updates an existing approval when the queue is full", async () => {
    const approvals = Array.from({ length: TLON_PENDING_APPROVAL_LIMIT }, (_, index) =>
      createApproval(index),
    );
    const fixture = createFixture(approvals);
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
});

describe("approved DM replay provenance", () => {
  function createApprovalHarness(authenticatedSenderShip?: string) {
    const approval: PendingApproval = {
      id: "dm-legacy",
      type: "dm",
      requestingShip: "~bus",
      messagePreview: "hello",
      originalMessage: {
        messageId: "message-1",
        messageText: "hello",
        messageContent: [{ inline: ["hello"] }],
        timestamp: 1,
        ...(authenticatedSenderShip ? { authenticatedSenderShip } : {}),
      },
      timestamp: 1,
    };
    let pendingApprovals: PendingApproval[] = [approval];
    let dmAllowlist: string[] = [];
    const processApprovedMessage = vi.fn(async () => {});
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const api = {
      poke: vi.fn(async () => 1),
      scry: vi.fn(async () => []),
    };
    const approvalRuntime = createTlonApprovalRuntime({
      api,
      runtime,
      botShipName: "~zod",
      getPendingApprovals: () => pendingApprovals,
      setPendingApprovals: (approvals) => {
        pendingApprovals = approvals;
      },
      getCurrentSettings: () => ({}),
      setCurrentSettings: vi.fn(),
      getEffectiveDmAllowlist: () => dmAllowlist,
      setEffectiveDmAllowlist: (ships) => {
        dmAllowlist = ships;
      },
      getEffectiveOwnerShip: () => "~nec",
      processApprovedMessage,
      refreshWatchedChannels: vi.fn(async () => 0),
    });
    return {
      api,
      approvalRuntime,
      processApprovedMessage,
      runtime,
      getDmAllowlist: () => dmAllowlist,
    };
  }

  it("does not replay pre-upgrade DM content without authenticated sender provenance", async () => {
    const harness = createApprovalHarness();

    await expect(harness.approvalRuntime.handleApprovalResponse("approve dm-legacy")).resolves.toBe(
      true,
    );

    expect(harness.getDmAllowlist()).toEqual(["~bus"]);
    expect(harness.processApprovedMessage).not.toHaveBeenCalled();
    expect(harness.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("authenticated sender provenance is unavailable"),
    );
    expect(JSON.stringify(harness.api.poke.mock.calls)).toContain(
      "Ask the approved ship to send a fresh DM.",
    );
  });

  it("replays content when the stored authenticated DM peer matches the approved ship", async () => {
    const harness = createApprovalHarness("~bus");

    await expect(harness.approvalRuntime.handleApprovalResponse("approve dm-legacy")).resolves.toBe(
      true,
    );

    expect(harness.processApprovedMessage).toHaveBeenCalledOnce();
  });

  it("does not replay content whose authenticated DM peer differs from the approved ship", async () => {
    const harness = createApprovalHarness("~nec");

    await expect(harness.approvalRuntime.handleApprovalResponse("approve dm-legacy")).resolves.toBe(
      true,
    );

    expect(harness.getDmAllowlist()).toEqual(["~bus"]);
    expect(harness.processApprovedMessage).not.toHaveBeenCalled();
    expect(harness.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("does not match the approved ship"),
    );
  });
});
