// Line tests cover the native approval runtime transport and terminal notices.
import type {
  ExecApprovalPendingView,
  PendingApprovalView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushFlexMessage = vi.hoisted(() => vi.fn());
const pushMessageLine = vi.hoisted(() => vi.fn());
const resolveApprovalOverGateway = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./send.js", async () => ({
  ...(await vi.importActual<typeof import("./send.js")>("./send.js")),
  pushFlexMessage,
  pushMessageLine,
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({ resolveApprovalOverGateway }));

const { lineApprovalNativeRuntime } = await import("./approval-handler.runtime.js");
const { buildLinePendingApprovalCard } = await import("./approval-card.js");
const { resolveLineApprovalPostbackTap } = await import("./approval-postback.js");

const APPROVAL_ID = "6f4a1b2c-0d3e-4f5a-8b9c-0d1e2f3a4b5c";
const APPROVER = `U${"a".repeat(32)}`;
const NOW_MS = 1_700_000_000_000;

const cfg: OpenClawConfig = {
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "line-token",
      channelSecret: "line-secret",
      allowFrom: [APPROVER],
    },
  },
};

const request: ExecApprovalRequest = {
  id: APPROVAL_ID,
  request: { command: "rm -rf ./build", host: "gateway" },
  createdAtMs: NOW_MS,
  expiresAtMs: NOW_MS + 120_000,
};

function execPendingView(): ExecApprovalPendingView {
  return {
    approvalId: APPROVAL_ID,
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    metadata: [{ label: "Host", value: "gateway" }],
    commandText: "rm -rf ./build",
    actions: (["allow-once", "allow-always", "deny"] as const).map((decision) => ({
      decision,
      label: decision,
      style: "primary",
      command: `/approve ${APPROVAL_ID} ${decision}`,
      action: { type: "approval", approvalId: APPROVAL_ID, approvalKind: "exec", decision },
    })),
    expiresAtMs: NOW_MS + 120_000,
  };
}

const plannedTarget = {
  surface: "approver-dm" as const,
  target: { to: `line:user:${APPROVER}` },
  reason: "preferred" as const,
};

beforeEach(() => {
  pushFlexMessage.mockReset();
  pushMessageLine.mockReset();
  pushFlexMessage.mockResolvedValue({ messageId: "m-1", chatId: APPROVER, receipt: {} });
  pushMessageLine.mockResolvedValue({ messageId: "m-2", chatId: APPROVER, receipt: {} });
});

describe("LINE native approval runtime", () => {
  // The card is tagged with the sending account's secret and the tap is verified with the
  // secret of the account whose webhook carried it. If either side picked another
  // account, every card on that account would be a dead button, with nothing to show it.
  it("draws cards an approver of the same account can decide, and no other account", async () => {
    const accounts: OpenClawConfig = {
      approvals: { exec: { enabled: true } },
      channels: {
        line: {
          channelAccessToken: "line-token",
          channelSecret: "line-secret",
          accounts: {
            work: {
              channelAccessToken: "work-token",
              channelSecret: "work-secret",
              allowFrom: [APPROVER],
            },
          },
        },
      },
    };
    const card = await lineApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: accounts,
      accountId: "work",
      request,
      approvalKind: "exec",
      nowMs: NOW_MS,
      view: execPendingView(),
    });
    const data = (card?.bubble.footer?.contents ?? []).flatMap((content) =>
      content.type === "button" && content.action.type === "postback" && content.action.data
        ? [content.action.data]
        : [],
    )[0];
    expect(data).toBeDefined();
    const tap = (channelSecret: string) =>
      resolveLineApprovalPostbackTap({
        resolveConfig: () => accounts,
        account: { accountId: "work", channelSecret },
        data: data ?? "",
        senderId: APPROVER,
      });

    resolveApprovalOverGateway.mockClear();
    await tap("line-secret");
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();

    await tap("work-secret");
    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: APPROVAL_ID, accountId: "work", senderId: APPROVER }),
    );
  });

  it("prepares a LINE address into a bare recipient with its account", async () => {
    const prepared = await lineApprovalNativeRuntime.transport.prepareTarget({
      cfg,
      accountId: "work",
      plannedTarget,
      request,
      approvalKind: "exec",
      view: execPendingView(),
      pendingPayload: null,
    });
    expect(prepared).toEqual({
      dedupeKey: expect.stringContaining(APPROVER),
      target: { to: APPROVER, accountId: "work" },
    });
  });

  it("declines a target with no recipient", async () => {
    expect(
      await lineApprovalNativeRuntime.transport.prepareTarget({
        cfg,
        plannedTarget: { ...plannedTarget, target: { to: "  " } },
        request,
        approvalKind: "exec",
        view: execPendingView(),
        pendingPayload: null,
      }),
    ).toBeNull();
  });

  it("pushes the card and tracks the approver chat for the outcome", async () => {
    const view = execPendingView();
    const pendingPayload = buildLinePendingApprovalCard({
      view,
      nowMs: NOW_MS,
      channelSecret: "line-secret",
    });
    const entry = await lineApprovalNativeRuntime.transport.deliverPending({
      cfg,
      accountId: "default",
      plannedTarget,
      preparedTarget: { to: APPROVER, accountId: "default" },
      request,
      approvalKind: "exec",
      view,
      pendingPayload,
    });
    expect(entry).toEqual({ to: APPROVER, accountId: "default" });
    expect(pushFlexMessage).toHaveBeenCalledWith(
      APPROVER,
      pendingPayload?.altText,
      pendingPayload?.bubble,
      expect.objectContaining({ accountId: "default" }),
    );
    expect(pushMessageLine).not.toHaveBeenCalled();
  });

  it("offers the approval command when the card cannot be drawn", async () => {
    // Native delivery already suppressed the local prompt, so the approver would
    // otherwise be left with no way to decide.
    const entry = await lineApprovalNativeRuntime.transport.deliverPending({
      cfg,
      accountId: "default",
      plannedTarget,
      preparedTarget: { to: APPROVER, accountId: "default" },
      request,
      approvalKind: "exec",
      view: execPendingView(),
      pendingPayload: null,
    });
    expect(entry).toBeNull();
    expect(pushFlexMessage).not.toHaveBeenCalled();
    // The notice quotes the commands the view itself publishes, one per decision.
    const [, text] = pushMessageLine.mock.calls[0] ?? [];
    for (const decision of ["allow-once", "allow-always", "deny"]) {
      expect(text).toContain(`/approve ${APPROVAL_ID} ${decision}`);
    }
  });

  it("publishes the terminal decision as a new message", async () => {
    const view = execPendingView();
    const resolvedView: ResolvedApprovalView = {
      ...view,
      phase: "resolved",
      decision: "allow-once",
      resolvedBy: APPROVER,
    };
    const final = await lineApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg,
      accountId: "default",
      request,
      resolved: { id: APPROVAL_ID, decision: "allow-once", resolvedBy: APPROVER, ts: NOW_MS },
      view: resolvedView,
      entry: { to: APPROVER, accountId: "default" },
    });
    if (final.kind !== "update") {
      throw new Error("Expected a LINE terminal approval update");
    }
    expect(final.payload.text).toContain("allow-once");
    await lineApprovalNativeRuntime.transport.updateEntry?.({
      cfg,
      accountId: "default",
      entry: { to: APPROVER, accountId: "default" },
      request,
      approvalKind: "exec",
      payload: final.payload,
      phase: "resolved",
    });
    // LINE has no message edit, so the outcome has to arrive as its own message.
    expect(pushMessageLine).toHaveBeenCalledWith(
      APPROVER,
      final.payload.text,
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("offers the approval command after a failed card send", () => {
    const view = execPendingView();
    lineApprovalNativeRuntime.observe?.onDeliveryError?.({
      cfg,
      accountId: "default",
      error: new Error("connection reset"),
      plannedTarget,
      request,
      approvalKind: "exec",
      view,
      pendingPayload: buildLinePendingApprovalCard({
        view,
        nowMs: NOW_MS,
        channelSecret: "line-secret",
      }),
    });
    expect(pushMessageLine).toHaveBeenCalledWith(
      APPROVER,
      expect.stringContaining(`/approve ${APPROVAL_ID}`),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  // Typed `/approve` decides only exec and plugin approvals, so the fallbacks for an
  // OpenClaw-change card must not hand the approver commands that would fail.
  it("sends an OpenClaw-change approval that has no card to the Control UI", async () => {
    const view: PendingApprovalView = {
      approvalId: APPROVAL_ID,
      approvalKind: "system-agent",
      phase: "pending",
      title: "OpenClaw Change Approval Required",
      metadata: [],
      commandText: "openclaw config set tools.exec.ask off",
      operationSummary: "Turn off exec approvals",
      actions: execPendingView().actions,
      expiresAtMs: NOW_MS + 120_000,
    };
    const fallback = `⚠️ Could not deliver the approval card for ${APPROVAL_ID}. Decide it from the Control UI.`;
    const delivery = {
      cfg,
      accountId: "default",
      plannedTarget,
      request,
      approvalKind: "system-agent" as const,
      view,
    };

    await lineApprovalNativeRuntime.transport.deliverPending({
      ...delivery,
      preparedTarget: { to: APPROVER, accountId: "default" },
      pendingPayload: null,
    });
    lineApprovalNativeRuntime.observe?.onDeliveryError?.({
      ...delivery,
      error: new Error("connection reset"),
      pendingPayload: buildLinePendingApprovalCard({
        view,
        nowMs: NOW_MS,
        channelSecret: "line-secret",
      }),
    });

    expect(pushMessageLine.mock.calls.map(([, text]) => text)).toEqual([fallback, fallback]);
  });

  // A rejected card must fail the delivery, or core would count it delivered and the
  // approver would get neither the card nor the command fallback.
  it("fails the delivery when LINE rejects the card", async () => {
    const view = execPendingView();
    pushFlexMessage.mockRejectedValueOnce(new Error("400 Bad Request"));

    await expect(
      lineApprovalNativeRuntime.transport.deliverPending({
        cfg,
        accountId: "default",
        plannedTarget,
        preparedTarget: { to: APPROVER, accountId: "default" },
        request,
        approvalKind: "exec",
        view,
        pendingPayload: buildLinePendingApprovalCard({
          view,
          nowMs: NOW_MS,
          channelSecret: "line-secret",
        }),
      }),
    ).rejects.toThrow("400 Bad Request");
  });

  // A card LINE accepted is on the approver's screen even when its receipt is
  // unreadable; without an entry, core would report it undelivered and skip the outcome.
  it("tracks a card LINE accepted when only its receipt failed", async () => {
    const view = execPendingView();
    pushFlexMessage.mockRejectedValueOnce(
      Object.assign(new Error("unreadable receipt"), {
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: { visibleReplySent: true },
      }),
    );

    const entry = await lineApprovalNativeRuntime.transport.deliverPending({
      cfg,
      accountId: "default",
      plannedTarget,
      preparedTarget: { to: APPROVER, accountId: "default" },
      request,
      approvalKind: "exec",
      view,
      pendingPayload: buildLinePendingApprovalCard({
        view,
        nowMs: NOW_MS,
        channelSecret: "line-secret",
      }),
    });

    expect(entry).toEqual({ to: APPROVER, accountId: "default" });
    expect(pushMessageLine).not.toHaveBeenCalled();
  });
});
