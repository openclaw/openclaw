import type { ResolvedApprovalView } from "openclaw/plugin-sdk/approval-handler-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixApprovalNativeRuntime } from "./approval-handler.runtime.js";
import {
  resolveMatrixApprovalReactionTargetWithPersistence,
  unregisterMatrixApprovalReactionTargetsForApproval,
} from "./approval-reactions.js";

const { sendSingleTextMessage, sendMessage, reactMessage, repairDirectRooms } = vi.hoisted(() => ({
  sendSingleTextMessage: vi.fn(),
  sendMessage: vi.fn(),
  reactMessage: vi.fn(),
  repairDirectRooms: vi.fn(),
}));
vi.mock("./matrix/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./matrix/send.js")>()),
  sendSingleTextMessageMatrix: sendSingleTextMessage,
  sendMessageMatrix: sendMessage,
  reactMatrixMessage: reactMessage,
}));
vi.mock("./matrix/direct-management.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./matrix/direct-management.js")>()),
  repairMatrixDirectRooms: repairDirectRooms,
}));

type MatrixDeliverPendingParams = Parameters<
  typeof matrixApprovalNativeRuntime.transport.deliverPending
>[0];
type MatrixPendingApprovalView = MatrixDeliverPendingParams["view"];
type MatrixPendingExecApprovalView = Extract<MatrixPendingApprovalView, { approvalKind: "exec" }>;
type MatrixPendingPluginApprovalView = Extract<
  MatrixPendingApprovalView,
  { approvalKind: "plugin" }
>;

function buildMatrixReceipt(messageIds: readonly string[]) {
  return {
    primaryPlatformMessageId: messageIds[0],
    platformMessageIds: [...messageIds],
  };
}

function lookupReaction(eventId: string) {
  return resolveMatrixApprovalReactionTargetWithPersistence({
    accountId: "default",
    roomId: "!room:example.org",
    eventId,
    reactionKey: "✅",
  });
}

// The reaction store TTL requires a future expiry.
const TEST_APPROVAL_EXPIRES_AT_MS = Date.now() + 5 * 60_000;
const handlerContext = {
  cfg: {},
  accountId: "default",
  context: { client: {} },
  // Presentation/transport consume the view and prepared target, not the request.
  request: { id: "req-1", request: { command: "echo hi" }, createdAtMs: 0, expiresAtMs: 1_000 },
} satisfies Pick<MatrixDeliverPendingParams, "cfg" | "accountId" | "context" | "request">;
const allowAction = (id: string) => ({
  decision: "allow-once" as const,
  label: "Allow Once",
  style: "success" as const,
  command: `/approve ${id} allow-once`,
});
const pendingView = {
  phase: "pending" as const,
  metadata: [],
  agentId: "agent-1",
  expiresAtMs: TEST_APPROVAL_EXPIRES_AT_MS,
};

const execView: MatrixPendingExecApprovalView = {
  ...pendingView,
  approvalKind: "exec",
  approvalId: "req-1",
  title: "Exec Approval Required",
  commandText: "echo hi",
  actions: [allowAction("req-1")],
};
const pluginView: MatrixPendingPluginApprovalView = {
  ...pendingView,
  approvalKind: "plugin",
  approvalId: "plugin:req-1",
  title: "Plugin Approval Required",
  description: "Approve the tool call.",
  pluginId: "ops",
  toolName: "deploy",
  severity: "critical",
  actions: [allowAction("plugin:req-1")],
};

async function deliverPending(view: MatrixPendingApprovalView) {
  const params = {
    ...handlerContext,
    approvalKind: view.approvalKind,
    view,
  };
  const pendingPayload = await matrixApprovalNativeRuntime.presentation.buildPendingPayload({
    ...params,
    nowMs: 100,
  });
  const entry = await matrixApprovalNativeRuntime.transport.deliverPending({
    ...params,
    plannedTarget: {
      surface: "approver-dm",
      target: { to: "room:!room:example.org" },
      reason: "preferred",
    },
    preparedTarget: { to: "room:!room:example.org" },
    pendingPayload,
  });
  return { entry, pendingPayload };
}

describe("matrixApprovalNativeRuntime", () => {
  beforeEach(async () => {
    for (const mock of [sendSingleTextMessage, sendMessage, reactMessage, repairDirectRooms]) {
      mock.mockReset();
    }
    for (const [approvalId, approvalKind] of [
      ["req-1", "exec"],
      ["plugin:req-1", "plugin"],
    ] as const) {
      await unregisterMatrixApprovalReactionTargetsForApproval({
        accountId: "default",
        approvalId,
        approvalKind,
      });
    }
  });

  it("delivers Matrix approval content with plugin approval fields", async () => {
    sendSingleTextMessage.mockResolvedValue({
      messageId: "$plugin-approval",
      primaryMessageId: "$plugin-approval",
      receipt: buildMatrixReceipt(["$plugin-approval"]),
      roomId: "!room:example.org",
    });
    reactMessage.mockResolvedValue(undefined);
    await deliverPending(pluginView);

    const [target, text, options] = sendSingleTextMessage.mock.calls[0] ?? [];
    expect(target).toBe("room:!room:example.org");
    expect(String(text)).toContain("deploy");
    const extraContent = (options as { extraContent?: Record<string, unknown> } | undefined)
      ?.extraContent;
    expect(extraContent?.["com.openclaw.approval"]).toEqual({
      version: 1,
      type: "approval.request",
      state: "pending",
      phase: "pending",
      id: "plugin:req-1",
      kind: "plugin",
      title: "Plugin Approval Required",
      description: "Approve the tool call.",
      expiresAtMs: TEST_APPROVAL_EXPIRES_AT_MS,
      metadata: [],
      allowedDecisions: ["allow-once"],
      actions: [
        {
          decision: "allow-once",
          label: "Allow Once",
          style: "success",
          command: "/approve plugin:req-1 allow-once",
        },
      ],
      pluginId: "ops",
      toolName: "deploy",
      agentId: "agent-1",
      severity: "critical",
    });
    expect(reactMessage.mock.calls[0]).toEqual([
      "!room:example.org",
      "$plugin-approval",
      "✅",
      expect.objectContaining({ accountId: "default" }),
    ]);
  });

  it("retries transient Matrix direct-room repair failures before preparing approval DMs", async () => {
    repairDirectRooms
      .mockRejectedValueOnce(new Error("direct account data not ready"))
      .mockResolvedValue({ activeRoomId: "!dm:example.org" });

    const prepared = await matrixApprovalNativeRuntime.transport.prepareTarget({
      ...handlerContext,
      cfg: { channels: { matrix: { encryption: false } } },
      approvalKind: "exec",
      view: execView,
      pendingPayload: {} as never,
      plannedTarget: {
        surface: "approver-dm",
        target: { to: "user:@owner:example.org" },
        reason: "preferred",
      },
    });

    expect(repairDirectRooms).toHaveBeenCalledTimes(2);
    expect(prepared?.target).toEqual({
      to: "room:!dm:example.org",
      threadId: undefined,
    });
  });

  it("falls back to chunked Matrix delivery when approval content exceeds one event", async () => {
    sendSingleTextMessage.mockRejectedValue(
      new Error("Matrix single-message text exceeds limit (5000 > 4000)"),
    );
    sendMessage.mockResolvedValue({
      messageId: "$last",
      primaryMessageId: "$legacy-primary",
      receipt: buildMatrixReceipt(["$primary", "$last"]),
      roomId: "!room:example.org",
    });
    const targetsAtReaction: unknown[] = [];
    reactMessage.mockImplementation(async () => {
      targetsAtReaction.push(await lookupReaction("$primary"));
    });
    const { entry, pendingPayload } = await deliverPending(execView);

    expect(targetsAtReaction).toEqual([
      { approvalId: "req-1", approvalKind: "exec", decision: "allow-once" },
    ]);
    expect(sendMessage.mock.calls[0]).toEqual([
      "room:!room:example.org",
      pendingPayload.text,
      expect.objectContaining({ accountId: "default", extraContent: pendingPayload.extraContent }),
    ]);
    expect(reactMessage.mock.calls[0]).toEqual([
      "!room:example.org",
      "$primary",
      expect.any(String),
      expect.objectContaining({ accountId: "default" }),
    ]);
    expect(entry).toMatchObject({
      roomId: "!room:example.org",
      platformMessageIds: ["$primary", "$last"],
      reactionEventId: "$primary",
    });
    const bindPending = matrixApprovalNativeRuntime.interactions?.bindPending;
    if (!bindPending) {
      throw new Error("Matrix approval runtime must expose bindPending");
    }
    const binding = await bindPending({
      ...handlerContext,
      approvalKind: "exec",
      view: execView,
      pendingPayload,
      entry: entry!,
    });

    expect(binding).toEqual({
      accountId: "default",
      roomId: "!room:example.org",
      eventId: "$primary",
    });
    expect(await lookupReaction("$last")).toBeNull();
  });

  it.each([
    {
      name: "preserves the Denied system-agent heading",
      view: {
        approvalKind: "system-agent",
        approvalId: "system-agent:change-1",
        phase: "resolved",
        title: "OpenClaw change",
        metadata: [],
        commandText: "restart the Gateway",
        operationSummary: "restart the Gateway",
        decision: "deny",
        applicationStatus: "not-applied",
      },
      payload: "OpenClaw change: Denied\n\nChange\n```\nrestart the Gateway\n```",
    },
    {
      name: "uses a longer fence for triple backticks",
      view: {
        ...execView,
        phase: "resolved",
        approvalKind: "exec",
        decision: "allow-once",
        commandText: "echo ```danger```",
      },
      payload: "Exec approval: Allowed once\n\nCommand\n````\necho ```danger```\n````",
    },
  ] satisfies { name: string; view: ResolvedApprovalView; payload: string }[])(
    "$name",
    async ({ view, payload }) => {
      expect(
        await matrixApprovalNativeRuntime.presentation.buildResolvedResult({
          ...handlerContext,
          resolved: { id: view.approvalId, decision: view.decision, ts: 0 },
          view,
          entry: null,
        }),
      ).toEqual({ kind: "update", payload });
    },
  );
});
