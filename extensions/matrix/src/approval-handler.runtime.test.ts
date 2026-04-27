import { describe, expect, it, vi } from "vitest";
import { matrixApprovalNativeRuntime } from "./approval-handler.runtime.js";

type MatrixDeliverPendingParams = Parameters<
  typeof matrixApprovalNativeRuntime.transport.deliverPending
>[0];

function buildMatrixApprovalRoomTarget(
  roomId: string,
): MatrixDeliverPendingParams["plannedTarget"] {
  return {
    surface: "approver-dm",
    target: {
      to: `room:${roomId}`,
    },
    reason: "preferred",
  };
}

describe("matrixApprovalNativeRuntime", () => {
  it("sends versioned Matrix approval content with pending exec approvals", async () => {
    const sendSingleTextMessage = vi.fn().mockResolvedValue({
      messageId: "$approval",
      primaryMessageId: "$approval",
      messageIds: ["$approval"],
      roomId: "!room:example.org",
    });
    const reactMessage = vi.fn().mockResolvedValue(undefined);
    const view = {
      approvalKind: "exec",
      approvalId: "req-1",
      phase: "pending",
      title: "Exec Approval Required",
      description: "A command needs your approval.",
      metadata: [],
      ask: "on-request",
      agentId: "agent-1",
      commandText: "echo hi",
      commandPreview: "echo hi",
      cwd: "/repo",
      host: "gateway",
      actions: [
        {
          decision: "allow-once",
          label: "Allow Once",
          style: "success",
          command: "/approve req-1 allow-once",
        },
        {
          decision: "deny",
          label: "Deny",
          style: "danger",
          command: "/approve req-1 deny",
        },
      ],
      expiresAtMs: 1_000,
    } satisfies MatrixDeliverPendingParams["view"];
    const pendingPayload = await matrixApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { client: {} as never },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          cwd: "/repo",
          host: "gateway",
          agentId: "agent-1",
        },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      approvalKind: "exec",
      nowMs: 100,
      view,
    });

    await matrixApprovalNativeRuntime.transport.deliverPending({
      cfg: {} as never,
      accountId: "default",
      context: {
        client: {} as never,
        deps: {
          sendSingleTextMessage,
          reactMessage,
        },
      },
      request: {} as never,
      approvalKind: "exec",
      plannedTarget: buildMatrixApprovalRoomTarget("!room:example.org"),
      preparedTarget: {
        to: "room:!room:example.org",
        roomId: "!room:example.org",
      },
      view,
      pendingPayload,
    });

    expect(sendSingleTextMessage).toHaveBeenCalledWith(
      "room:!room:example.org",
      expect.stringContaining("echo hi"),
      expect.objectContaining({
        extraContent: {
          "com.openclaw.approval": expect.objectContaining({
            version: 1,
            type: "approval.request",
            state: "pending",
            id: "req-1",
            kind: "exec",
            commandText: "echo hi",
            cwd: "/repo",
            agentId: "agent-1",
            allowedDecisions: ["allow-once", "deny"],
          }),
        },
      }),
    );
  });

  it("includes plugin approval fields in Matrix approval content", async () => {
    const pendingPayload = await matrixApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { client: {} as never },
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin Approval Required",
          description: "Approve the tool call.",
          severity: "critical",
          toolName: "deploy",
          pluginId: "ops",
          agentId: "agent-1",
        },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      approvalKind: "plugin",
      nowMs: 100,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:req-1",
        phase: "pending",
        title: "Plugin Approval Required",
        description: "Approve the tool call.",
        metadata: [],
        agentId: "agent-1",
        pluginId: "ops",
        toolName: "deploy",
        severity: "critical",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            style: "success",
            command: "/approve plugin:req-1 allow-once",
          },
        ],
        expiresAtMs: 1_000,
      } as never,
    });

    expect(pendingPayload).toMatchObject({
      extraContent: {
        "com.openclaw.approval": {
          version: 1,
          type: "approval.request",
          state: "pending",
          id: "plugin:req-1",
          kind: "plugin",
          pluginId: "ops",
          toolName: "deploy",
          agentId: "agent-1",
          severity: "critical",
        },
      },
    });
  });

  it("falls back to chunked Matrix delivery when approval content exceeds one event", async () => {
    const sendSingleTextMessage = vi
      .fn()
      .mockRejectedValue(new Error("Matrix single-message text exceeds limit (5000 > 4000)"));
    const sendMessage = vi.fn().mockResolvedValue({
      messageId: "$last",
      primaryMessageId: "$primary",
      messageIds: ["$primary", "$last"],
      roomId: "!room:example.org",
    });
    const reactMessage = vi.fn().mockResolvedValue(undefined);
    const view = {
      approvalKind: "exec",
      approvalId: "req-1",
      phase: "pending",
      title: "Exec Approval Required",
      description: "A command needs your approval.",
      metadata: [],
      commandText: "echo hi",
      actions: [
        {
          decision: "allow-once",
          label: "Allow Once",
          style: "success",
          command: "/approve req-1 allow-once",
        },
      ],
      expiresAtMs: 1_000,
    } satisfies MatrixDeliverPendingParams["view"];
    const pendingPayload = await matrixApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { client: {} as never },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      approvalKind: "exec",
      nowMs: 100,
      view,
    });

    const entry = await matrixApprovalNativeRuntime.transport.deliverPending({
      cfg: {} as never,
      accountId: "default",
      context: {
        client: {} as never,
        deps: {
          sendSingleTextMessage,
          sendMessage,
          reactMessage,
        },
      },
      request: {} as never,
      approvalKind: "exec",
      plannedTarget: buildMatrixApprovalRoomTarget("!room:example.org"),
      preparedTarget: {
        to: "room:!room:example.org",
        roomId: "!room:example.org",
      },
      view,
      pendingPayload,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "room:!room:example.org",
      pendingPayload.text,
      expect.objectContaining({
        accountId: "default",
        extraContent: pendingPayload.extraContent,
      }),
    );
    expect(reactMessage).toHaveBeenCalledWith(
      "!room:example.org",
      "$primary",
      expect.any(String),
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(entry).toMatchObject({
      roomId: "!room:example.org",
      messageIds: ["$primary", "$last"],
      reactionEventId: "$primary",
    });
  });

  it("uses a longer code fence when resolved commands contain triple backticks", async () => {
    const result = await matrixApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg: {} as never,
      accountId: "default",
      context: {
        client: {} as never,
      },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      resolved: {
        id: "req-1",
        decision: "allow-once",
        ts: 0,
      },
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        decision: "allow-once",
        commandText: "echo ```danger```",
      } as never,
      entry: {} as never,
    });

    expect(result).toEqual({
      kind: "update",
      payload: [
        "Exec approval: Allowed once",
        "",
        "Command",
        "````",
        "echo ```danger```",
        "````",
      ].join("\n"),
    });
  });
});
