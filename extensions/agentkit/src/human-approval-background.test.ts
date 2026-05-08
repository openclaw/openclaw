import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  startAgentkitWorldHumanApprovalSessionMock,
  listPendingAgentkitApprovalsMock,
  resolvePendingAgentkitApprovalMock,
  saveAgentkitHitlGrantMock,
  renderQrCodeToStringMock,
  gatewayRequestMock,
  withOperatorAdminGatewayClientMock,
  withOperatorApprovalsGatewayClientMock,
} = vi.hoisted(() => ({
  startAgentkitWorldHumanApprovalSessionMock: vi.fn(),
  listPendingAgentkitApprovalsMock: vi.fn(async (): Promise<unknown[]> => []),
  resolvePendingAgentkitApprovalMock: vi.fn(),
  saveAgentkitHitlGrantMock: vi.fn(),
  renderQrCodeToStringMock: vi.fn(async () => "qr-text"),
  gatewayRequestMock: vi.fn(async (_method: string, _payload?: unknown) => undefined),
  withOperatorAdminGatewayClientMock: vi.fn(),
  withOperatorApprovalsGatewayClientMock: vi.fn(),
}));

vi.mock("./human-approval.js", () => ({
  startAgentkitWorldHumanApprovalSession: startAgentkitWorldHumanApprovalSessionMock,
}));

vi.mock("./hitl-approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hitl-approvals.js")>();
  return {
    ...actual,
    formatPendingAgentkitApprovalsText: (approvals: Array<{ id: string }>) =>
      approvals.length === 0
        ? "No pending AgentKit approvals."
        : ["Pending AgentKit approvals:", ...approvals.map((approval) => `- ${approval.id}`)].join(
            "\n",
          ),
    listPendingAgentkitApprovals: listPendingAgentkitApprovalsMock,
    resolvePendingAgentkitApproval: resolvePendingAgentkitApprovalMock,
  };
});

vi.mock("./hitl-grants.js", () => ({
  saveAgentkitHitlGrant: saveAgentkitHitlGrantMock,
}));

vi.mock("./qr.runtime.js", () => ({
  renderQrCodeToString: renderQrCodeToStringMock,
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  withOperatorAdminGatewayClient: withOperatorAdminGatewayClientMock,
  withOperatorApprovalsGatewayClient: withOperatorApprovalsGatewayClientMock,
}));

import {
  __testing,
  startOrReuseAgentkitHumanApprovalSession,
} from "./human-approval-background.js";

describe("human approval background retry flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing.activeHumanApprovalSessions.clear();
    listPendingAgentkitApprovalsMock.mockResolvedValue([]);
    withOperatorAdminGatewayClientMock.mockImplementation(
      async (_opts, callback) =>
        await callback({
          request: gatewayRequestMock,
        }),
    );
    withOperatorApprovalsGatewayClientMock.mockImplementation(
      async (_opts, callback) =>
        await callback({
          request: gatewayRequestMock,
        }),
    );
  });

  it("generates QR text for chat approval replies even when stdout is not a TTY", async () => {
    startAgentkitWorldHumanApprovalSessionMock.mockResolvedValueOnce({
      approvalId: "plugin:approval-qr",
      action: "openclaw-approval-qr",
      connectorURI: "https://world.org/verify?t=wld",
      requestId: "request-qr",
      waitForCompletion: async () => ({
        success: false,
        action: "openclaw-approval-qr",
        approvalId: "plugin:approval-qr",
        connectorURI: "https://world.org/verify?t=wld",
        requestId: "request-qr",
        verifyStatus: null,
        verifyBody: null,
        errorCode: "verification_rejected",
        nullifier: null,
      }),
    });

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    try {
      const approval = {
        id: "plugin:approval-qr",
        createdAtMs: 1,
        expiresAtMs: 2,
        request: {
          pluginId: "agentkit",
          title: "World proof required for exec",
          description: "desc",
          severity: "warning" as const,
          toolName: "exec",
          toolCallId: "tool-call-qr",
          agentId: "main",
          sessionKey: "agent:main:test",
        },
      };
      const pluginConfig = {
        hitl: {
          timeoutMs: 120_000,
          grantScope: "session" as const,
          grantTtlMs: 30_000,
        },
      };

      const session = await startOrReuseAgentkitHumanApprovalSession({
        appConfig: {},
        approval,
        decision: "allow-once",
        pluginConfig: pluginConfig as never,
        env: {},
      });

      expect(renderQrCodeToStringMock).toHaveBeenCalledWith("https://world.org/verify?t=wld");
      expect(session.qrText).toBe("qr-text");
      await __testing.activeHumanApprovalSessions.get(approval.id)?.completionPromise;
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
    }
  });

  it("injects a retryable pending prompt into the session when verification fails", async () => {
    startAgentkitWorldHumanApprovalSessionMock.mockResolvedValueOnce({
      approvalId: "plugin:approval-1",
      action: "openclaw-approval-1",
      connectorURI: "https://world.org/verify?t=wld",
      requestId: "request-1",
      waitForCompletion: async () => ({
        success: false,
        action: "openclaw-approval-1",
        approvalId: "plugin:approval-1",
        connectorURI: "https://world.org/verify?t=wld",
        requestId: "request-1",
        verifyStatus: 400,
        verifyBody: {
          code: "invalid_proof",
        },
        errorCode: null,
        nullifier: null,
      }),
    });

    const approval = {
      id: "plugin:approval-1",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        pluginId: "agentkit",
        title: "World proof required for agents_list",
        description: "desc",
        severity: "warning" as const,
        toolName: "agents_list",
        toolCallId: "tool-call-1",
        agentId: "main",
        sessionKey: "agent:main:test",
      },
    };
    const pluginConfig = {
      hitl: {
        timeoutMs: 120_000,
        grantScope: "session" as const,
        grantTtlMs: 30_000,
      },
    };

    await startOrReuseAgentkitHumanApprovalSession({
      appConfig: {},
      approval,
      pluginConfig: pluginConfig as never,
      env: {},
    });

    await __testing.activeHumanApprovalSessions.get(approval.id)?.completionPromise;

    expect(resolvePendingAgentkitApprovalMock).not.toHaveBeenCalled();
    expect(gatewayRequestMock).toHaveBeenCalledWith(
      "chat.inject",
      expect.objectContaining({
        sessionKey: "agent:main:test",
        command: true,
        idempotencyKey: "plugin-approval:plugin:approval-1:world-failure:request-1",
        message: expect.stringContaining("Retry with World"),
      }),
    );
    expect(withOperatorAdminGatewayClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientDisplayName: "AgentKit approval retry",
      }),
      expect.any(Function),
    );
    const firstInjectCall = gatewayRequestMock.mock.calls as unknown as Array<[string, unknown]>;
    const firstInjectParams = firstInjectCall[0]?.[1] as {
      channelData: {
        execApproval: {
          state: string;
          title: string;
          actions: Array<{ label: string }>;
        };
      };
    };
    expect(firstInjectParams.channelData.execApproval.state).toBe("pending");
    expect(firstInjectParams.channelData.execApproval.title).toBe(
      "World verification failed for agents_list",
    );
    expect(firstInjectParams.channelData.execApproval.actions[0]?.label).toBe(
      "Retry with World (Once)",
    );
    expect(firstInjectParams.channelData.execApproval.actions[1]?.label).toBe(
      "Verify and trust for session",
    );
    expect(firstInjectParams.channelData.execApproval.actions[2]?.label).toBe("Deny");
  });

  it("allows a fresh World session to start after a failed attempt", async () => {
    startAgentkitWorldHumanApprovalSessionMock
      .mockResolvedValueOnce({
        approvalId: "plugin:approval-2",
        action: "openclaw-approval-2a",
        connectorURI: "https://world.org/verify?t=first",
        requestId: "request-first",
        waitForCompletion: async () => ({
          success: false,
          action: "openclaw-approval-2a",
          approvalId: "plugin:approval-2",
          connectorURI: "https://world.org/verify?t=first",
          requestId: "request-first",
          verifyStatus: null,
          verifyBody: null,
          errorCode: "verification_rejected",
          nullifier: null,
        }),
      })
      .mockResolvedValueOnce({
        approvalId: "plugin:approval-2",
        action: "openclaw-approval-2b",
        connectorURI: "https://world.org/verify?t=second",
        requestId: "request-second",
        waitForCompletion: async () => ({
          success: false,
          action: "openclaw-approval-2b",
          approvalId: "plugin:approval-2",
          connectorURI: "https://world.org/verify?t=second",
          requestId: "request-second",
          verifyStatus: null,
          verifyBody: null,
          errorCode: "verification_rejected",
          nullifier: null,
        }),
      });

    const approval = {
      id: "plugin:approval-2",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        pluginId: "agentkit",
        title: "World proof required for agents_list",
        description: "desc",
        severity: "warning" as const,
        toolName: "agents_list",
        toolCallId: "tool-call-2",
        agentId: "main",
        sessionKey: "agent:main:test",
      },
    };
    const pluginConfig = {
      hitl: {
        timeoutMs: 120_000,
        grantScope: "session" as const,
        grantTtlMs: 30_000,
      },
    };

    const first = await startOrReuseAgentkitHumanApprovalSession({
      appConfig: {},
      approval,
      pluginConfig: pluginConfig as never,
      env: {},
    });
    await __testing.activeHumanApprovalSessions.get(approval.id)?.completionPromise;

    const second = await startOrReuseAgentkitHumanApprovalSession({
      appConfig: {},
      approval,
      pluginConfig: pluginConfig as never,
      env: {},
    });

    expect(first.requestId).toBe("request-first");
    expect(second.requestId).toBe("request-second");
    expect(startAgentkitWorldHumanApprovalSessionMock).toHaveBeenCalledTimes(2);
  });

  it("reuses an active World session with the original approval decision", async () => {
    let complete!: (value: unknown) => void;
    const completion = new Promise((resolve) => {
      complete = resolve;
    });
    startAgentkitWorldHumanApprovalSessionMock.mockResolvedValueOnce({
      approvalId: "plugin:approval-reuse",
      action: "openclaw-approval-reuse",
      connectorURI: "https://world.org/verify?t=reuse",
      requestId: "request-reuse",
      waitForCompletion: async () => {
        await completion;
        return {
          success: false,
          action: "openclaw-approval-reuse",
          approvalId: "plugin:approval-reuse",
          connectorURI: "https://world.org/verify?t=reuse",
          requestId: "request-reuse",
          verifyStatus: null,
          verifyBody: null,
          errorCode: "verification_rejected",
          nullifier: null,
        };
      },
    });

    const approval = {
      id: "plugin:approval-reuse",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        pluginId: "agentkit",
        title: "World proof required for exec",
        description: "desc",
        severity: "warning" as const,
        toolName: "exec",
        toolCallId: "tool-call-reuse",
        agentId: "main",
        sessionKey: "agent:main:test",
      },
    };
    const pluginConfig = {
      hitl: {
        timeoutMs: 120_000,
        grantScope: "session" as const,
        grantTtlMs: 30_000,
      },
    };

    const first = await startOrReuseAgentkitHumanApprovalSession({
      appConfig: {},
      approval,
      decision: "allow-once",
      pluginConfig: pluginConfig as never,
      env: {},
    });
    const second = await startOrReuseAgentkitHumanApprovalSession({
      appConfig: {},
      approval,
      decision: "allow-always",
      pluginConfig: pluginConfig as never,
      env: {},
    });

    expect(first.reused).toBe(false);
    expect(first.decision).toBe("allow-once");
    expect(second.reused).toBe(true);
    expect(second.decision).toBe("allow-once");
    expect(startAgentkitWorldHumanApprovalSessionMock).toHaveBeenCalledTimes(1);

    complete(undefined);
    await __testing.activeHumanApprovalSessions.get(approval.id)?.completionPromise;
  });

  it("does not persist a future grant for allow-once after successful verification", async () => {
    startAgentkitWorldHumanApprovalSessionMock.mockResolvedValueOnce({
      approvalId: "plugin:approval-3",
      action: "openclaw-approval-3",
      connectorURI: "https://world.org/verify?t=success",
      requestId: "request-success",
      waitForCompletion: async () => ({
        success: true,
        action: "openclaw-approval-3",
        approvalId: "plugin:approval-3",
        connectorURI: "https://world.org/verify?t=success",
        requestId: "request-success",
        verifyStatus: 200,
        verifyBody: { success: true },
        errorCode: null,
        nullifier: "nullifier-3",
      }),
    });

    const approval = {
      id: "plugin:approval-3",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        pluginId: "agentkit",
        title: "World proof required for agents_list",
        description: "desc",
        severity: "warning" as const,
        toolName: "agents_list",
        toolCallId: "tool-call-3",
        agentId: "main",
        sessionKey: "agent:main:test",
      },
    };
    const pluginConfig = {
      hitl: {
        timeoutMs: 120_000,
        grantScope: "session" as const,
        grantTtlMs: 30_000,
      },
    };

    await startOrReuseAgentkitHumanApprovalSession({
      appConfig: {},
      approval,
      decision: "allow-once",
      pluginConfig: pluginConfig as never,
      env: {},
    });

    await __testing.activeHumanApprovalSessions.get(approval.id)?.completionPromise;

    expect(resolvePendingAgentkitApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: approval.id,
        decision: "allow-once",
      }),
    );
    expect(saveAgentkitHitlGrantMock).not.toHaveBeenCalled();
  });

  it("injects a reminder when allow-once leaves another matching approval pending", async () => {
    startAgentkitWorldHumanApprovalSessionMock.mockResolvedValueOnce({
      approvalId: "plugin:approval-3b",
      action: "openclaw-approval-3b",
      connectorURI: "https://world.org/verify?t=success",
      requestId: "request-success-3b",
      waitForCompletion: async () => ({
        success: true,
        action: "openclaw-approval-3b",
        approvalId: "plugin:approval-3b",
        connectorURI: "https://world.org/verify?t=success",
        requestId: "request-success-3b",
        verifyStatus: 200,
        verifyBody: { success: true },
        errorCode: null,
        nullifier: "nullifier-3b",
      }),
    });

    const approval = {
      id: "plugin:approval-3b",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        pluginId: "agentkit",
        title: "World proof required for exec",
        description: "desc",
        severity: "warning" as const,
        toolName: "exec",
        toolCallId: "tool-call-3b",
        agentId: "main",
        sessionKey: "agent:main:test",
      },
    };
    const sibling = {
      ...approval,
      id: "plugin:sibling-3b",
      createdAtMs: 4,
      request: {
        ...approval.request,
        toolCallId: "tool-call-sibling-3b",
      },
    };
    const olderSibling = {
      ...approval,
      id: "plugin:sibling-older-3b",
      createdAtMs: 3,
      request: {
        ...approval.request,
        toolCallId: "tool-call-sibling-older-3b",
      },
    };
    const otherSession = {
      ...approval,
      id: "plugin:other-session-3b",
      createdAtMs: 2,
      request: {
        ...approval.request,
        sessionKey: "agent:main:other",
        toolCallId: "tool-call-other-session-3b",
      },
    };
    listPendingAgentkitApprovalsMock.mockResolvedValueOnce([sibling, otherSession, olderSibling]);
    const pluginConfig = {
      hitl: {
        timeoutMs: 120_000,
        grantScope: "session" as const,
        grantTtlMs: 30_000,
      },
    };

    await startOrReuseAgentkitHumanApprovalSession({
      appConfig: {},
      approval,
      decision: "allow-once",
      pluginConfig: pluginConfig as never,
      env: {},
    });

    await __testing.activeHumanApprovalSessions.get(approval.id)?.completionPromise;

    expect(gatewayRequestMock).toHaveBeenCalledWith(
      "chat.inject",
      expect.objectContaining({
        sessionKey: "agent:main:test",
        idempotencyKey: "plugin-approval:plugin:approval-3b:remaining-pending",
        message: expect.stringContaining("still pending for this session"),
      }),
    );
    expect(gatewayRequestMock).toHaveBeenCalledWith(
      "chat.inject",
      expect.objectContaining({
        interactive: expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: "buttons",
            }),
          ]),
        }),
        channelData: expect.objectContaining({
          execApproval: expect.objectContaining({
            approvalId: "plugin:sibling-older-3b",
            approvalKind: "plugin",
            state: "pending",
          }),
        }),
      }),
    );
    const reminderPayload = gatewayRequestMock.mock.calls.find(
      ([method, payload]) =>
        method === "chat.inject" &&
        typeof payload === "object" &&
        payload != null &&
        "idempotencyKey" in payload &&
        payload.idempotencyKey === "plugin-approval:plugin:approval-3b:remaining-pending",
    )?.[1];
    expect(reminderPayload).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("plugin:sibling-older-3b"),
      }),
    );
    expect(reminderPayload).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("plugin:sibling-3b"),
      }),
    );
    expect(reminderPayload).toEqual(
      expect.objectContaining({
        message: expect.not.stringContaining("plugin:other-session-3b"),
      }),
    );
  });

  it("persists a future grant only for allow-always after successful verification", async () => {
    startAgentkitWorldHumanApprovalSessionMock.mockResolvedValueOnce({
      approvalId: "plugin:approval-4",
      action: "openclaw-approval-4",
      connectorURI: "https://world.org/verify?t=success",
      requestId: "request-success-4",
      waitForCompletion: async () => ({
        success: true,
        action: "openclaw-approval-4",
        approvalId: "plugin:approval-4",
        connectorURI: "https://world.org/verify?t=success",
        requestId: "request-success-4",
        verifyStatus: 200,
        verifyBody: { success: true },
        errorCode: null,
        nullifier: "nullifier-4",
      }),
    });

    const approval = {
      id: "plugin:approval-4",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        pluginId: "agentkit",
        title: "World proof required for agents_list",
        description: "desc",
        severity: "warning" as const,
        toolName: "agents_list",
        toolCallId: "tool-call-4",
        agentId: "main",
        sessionKey: "agent:main:test",
      },
    };
    const pluginConfig = {
      hitl: {
        timeoutMs: 120_000,
        grantScope: "session" as const,
        grantTtlMs: 30_000,
      },
    };

    await startOrReuseAgentkitHumanApprovalSession({
      appConfig: {},
      approval,
      decision: "allow-always",
      pluginConfig: pluginConfig as never,
      env: {},
    });

    await __testing.activeHumanApprovalSessions.get(approval.id)?.completionPromise;

    expect(resolvePendingAgentkitApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: approval.id,
        decision: "allow-always",
      }),
    );
    expect(saveAgentkitHitlGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: expect.objectContaining({
          id: `${approval.id}:allow-always`,
          decision: "allow-always",
        }),
      }),
    );
  });

  it("resolves matching already-pending approvals after an allow-always verification", async () => {
    startAgentkitWorldHumanApprovalSessionMock.mockResolvedValueOnce({
      approvalId: "plugin:approval-5",
      action: "openclaw-approval-5",
      connectorURI: "https://world.org/verify?t=success",
      requestId: "request-success-5",
      waitForCompletion: async () => ({
        success: true,
        action: "openclaw-approval-5",
        approvalId: "plugin:approval-5",
        connectorURI: "https://world.org/verify?t=success",
        requestId: "request-success-5",
        verifyStatus: 200,
        verifyBody: { success: true },
        errorCode: null,
        nullifier: "nullifier-5",
      }),
    });

    const approval = {
      id: "plugin:approval-5",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        pluginId: "agentkit",
        title: "World proof required for exec",
        description: "desc",
        severity: "warning" as const,
        toolName: "exec",
        toolCallId: "tool-call-5",
        agentId: "main",
        sessionKey: "agent:main:test",
      },
    };
    const matchingSibling = {
      ...approval,
      id: "plugin:sibling-5",
      request: {
        ...approval.request,
        toolCallId: "tool-call-sibling-5",
      },
    };
    const otherTool = {
      ...approval,
      id: "plugin:other-tool-5",
      request: {
        ...approval.request,
        toolName: "agents_list",
        toolCallId: "tool-call-other-5",
      },
    };
    listPendingAgentkitApprovalsMock.mockResolvedValueOnce([matchingSibling, otherTool]);
    const pluginConfig = {
      hitl: {
        timeoutMs: 120_000,
        grantScope: "session" as const,
        grantTtlMs: 30_000,
      },
    };

    await startOrReuseAgentkitHumanApprovalSession({
      appConfig: {},
      approval,
      decision: "allow-always",
      pluginConfig: pluginConfig as never,
      env: {},
    });

    await __testing.activeHumanApprovalSessions.get(approval.id)?.completionPromise;

    expect(resolvePendingAgentkitApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: approval.id,
        decision: "allow-always",
      }),
    );
    expect(resolvePendingAgentkitApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: matchingSibling.id,
        decision: "allow-always",
      }),
    );
    expect(resolvePendingAgentkitApprovalMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: otherTool.id,
      }),
    );
  });
});
