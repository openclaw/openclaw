import { callGatewayTool, type EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApprovalResponse, handleCodexAppServerApprovalRequest } from "./approval-bridge.js";

vi.mock("openclaw/plugin-sdk/agent-harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness")>()),
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

function createParams(): EmbeddedRunAttemptParams {
  return {
    sessionKey: "agent:main:session-1",
    agentId: "main",
    messageChannel: "telegram",
    currentChannelId: "chat-1",
    agentAccountId: "default",
    currentThreadTs: "thread-ts",
    onAgentEvent: vi.fn(),
  } as unknown as EmbeddedRunAttemptParams;
}

describe("Codex app-server approval bridge", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
  });

  it("routes command approvals through plugin approvals and accepts allowed commands", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-1",
        command: "pnpm test extensions/codex/src/app-server",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        pluginId: "openclaw-codex-app-server",
        title: "Codex app-server command approval",
        twoPhase: true,
        turnSourceChannel: "telegram",
        turnSourceTo: "chat-1",
      }),
      { expectFinal: false },
    );
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({ status: "pending", approvalId: "plugin:approval-1" }),
      }),
    );
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({ status: "approved", approvalId: "plugin:approval-1" }),
      }),
    );
  });

  it("fails closed when no approval route is available", async () => {
    const params = createParams();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-2",
      decision: null,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-1",
        reason: "needs write access",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
    expect(params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "approval",
        data: expect.objectContaining({ status: "unavailable", reason: "needs write access" }),
      }),
    );
  });

  it("fails closed for unsupported native approval methods without requesting plugin approval", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "future/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "future-1",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      decision: "decline",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(params.onAgentEvent).not.toHaveBeenCalled();
  });
  it("labels permission approvals explicitly with sanitized permission detail", async () => {
    const params = createParams();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-3",
      decision: "allow-once",
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-1",
        permissions: {
          network: { allowHosts: ["example.com", "*.internal"] },
          fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      permissions: {
        network: { allowHosts: ["example.com", "*.internal"] },
        fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
      },
      scope: "turn",
    });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        title: "Codex app-server permission approval",
        toolName: "codex_permission_approval",
        description: expect.stringContaining("Permissions: network, fileSystem"),
      }),
      { expectFinal: false },
    );
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        description: expect.stringContaining(
          "Network permission requested (allowHosts: example.com, *.internal; high-risk: wildcard hosts, private-network wildcards)",
        ),
      }),
      { expectFinal: false },
    );
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        description: expect.stringContaining(
          "File system permission requested (roots: /; writePaths: ~; high-risk: filesystem root, home directory)",
        ),
      }),
      { expectFinal: false },
    );
    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    expect(requestPayload).toEqual(
      expect.objectContaining({
        description: expect.not.stringContaining("agent:main:session-1"),
      }),
    );
  });

  it("keeps permission detail bounded and truncated within the approval description cap", async () => {
    const params = createParams();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-4",
      decision: "allow-once",
    });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-2",
        permissions: {
          network: {
            allowHosts: [
              "*.internal",
              "very-long-service-name.example.corp",
              "third.example.com",
            ],
          },
          fileSystem: {
            roots: ["/", "/workspace/project", "/Users/simone/Documents"],
            writePaths: ["/tmp/output", "/var/log/app"],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const [, , requestPayload] = mockCallGatewayTool.mock.calls[0] ?? [];
    expect(requestPayload).toEqual(
      expect.objectContaining({
        description: expect.any(String),
      }),
    );
    const description = (requestPayload as { description: string }).description;
    expect(description.length).toBeLessThanOrEqual(256);
    expect(description).toContain("*.internal");
    expect(description).toContain("/workspace/project");
    expect(description).toContain("(+1 more)");
    expect(description).toContain("high-risk:");
  });

  it("maps app-server approval response families separately", () => {
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["accept"] },
        "approved-session",
      ),
    ).toEqual({
      decision: "accept",
    });
    expect(buildApprovalResponse("item/fileChange/requestApproval", undefined, "denied")).toEqual({
      decision: "decline",
    });
    expect(
      buildApprovalResponse(
        "item/permissions/requestApproval",
        {
          permissions: {
            network: { allowHosts: ["example.com"] },
            fileSystem: null,
          },
        },
        "approved-once",
      ),
    ).toEqual({
      permissions: { network: { allowHosts: ["example.com"] } },
      scope: "turn",
    });
    expect(buildApprovalResponse("future/requestApproval", undefined, "approved-once")).toEqual({
      decision: "decline",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    });
  });
});
