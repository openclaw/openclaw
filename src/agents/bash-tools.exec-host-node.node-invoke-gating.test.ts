/**
 * NODE_INVOKE Gating Tests for bash-tools.exec-host-node.ts
 *
 * Verifies that dispatchNodeInvokeGuarded replaces direct
 * callGatewayTool("node.invoke", ...) calls in both execution paths,
 * with explicit behavioral verification for success and failure cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as nodeInvokeGuard from "./tools/node-invoke-guard.js";
import * as nodeUtils from "./tools/nodes-utils.js";
import * as execApprovals from "./bash-tools.exec-approval-request.js";
import * as execRuntime from "./bash-tools.exec-runtime.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.js";

const mockDispatchNodeInvokeGuarded = vi.spyOn(
  nodeInvokeGuard,
  "dispatchNodeInvokeGuarded",
);
const mockListNodes = vi.spyOn(nodeUtils, "listNodes");
const mockResolveNodeIdFromList = vi.spyOn(nodeUtils, "resolveNodeIdFromList");
const mockRegisterApproval = vi.spyOn(
  execApprovals,
  "registerExecApprovalRequestForHost",
);
const mockWaitForDecision = vi.spyOn(
  execApprovals,
  "waitForExecApprovalDecision",
);
const mockEmitExecSystemEvent = vi.spyOn(execRuntime, "emitExecSystemEvent");

describe("NODE_INVOKE Gating Refactoring - bash-tools.exec-host-node.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockListNodes.mockResolvedValue([
      {
        nodeId: "test-node",
        platform: "linux",
        commands: ["system.run"],
      } as any,
    ]);

    mockResolveNodeIdFromList.mockReturnValue("test-node");

    mockDispatchNodeInvokeGuarded.mockResolvedValue({
      payload: {
        success: true,
        stdout: "output",
        stderr: "",
        error: "",
        exitCode: 0,
      },
    });

    mockRegisterApproval.mockResolvedValue({
      id: "approval-id",
      expiresAtMs: Date.now() + 60000,
      finalDecision: "allow-once",
    } as any);

    mockWaitForDecision.mockResolvedValue("allow-once");
  });

  describe("Integration: dispatchNodeInvokeGuarded calls", () => {
    it("should call dispatchNodeInvokeGuarded with system.run function name", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo test",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "off",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      await executeNodeHostCommand(params);

      // Verify the wrapper was called with correct function name
      expect(mockDispatchNodeInvokeGuarded).toHaveBeenCalledWith(
        "system.run", // function name
        "test-node", // nodeId
        expect.objectContaining({
          nodeId: "test-node",
          command: "system.run",
        }),
        expect.objectContaining({
          timeoutMs: expect.any(Number),
        }),
      );
    });

    it("should use dispatchNodeInvokeGuarded in approval flow", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo test",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "on-miss",
        agentId: "test-agent",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      const result = await executeNodeHostCommand(params);

      // First response should be approval-pending
      expect(result.details.status).toBe("approval-pending");

      // Wait for async dispatch
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify dispatchNodeInvokeGuarded was called
      expect(mockDispatchNodeInvokeGuarded).toHaveBeenCalledWith(
        "system.run",
        "test-node",
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("should pass params with nodeId, command, and idempotencyKey", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo hello",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "off",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
        agentId: "test-agent",
        sessionKey: "test-session",
      };

      await executeNodeHostCommand(params);

      const callArgs = mockDispatchNodeInvokeGuarded.mock.calls[0];
      const paramsArg = callArgs[2];

      // Verify structure of params passed to dispatchNodeInvokeGuarded
      expect(paramsArg).toMatchObject({
        nodeId: "test-node",
        command: "system.run",
        params: {
          command: expect.any(Array), // argv
          rawCommand: "echo hello",
          cwd: "/tmp",
          env: undefined, // no requestedEnv
          agentId: "test-agent",
          sessionKey: "test-session",
          approved: false,
          approvalDecision: undefined,
          runId: undefined,
        },
        idempotencyKey: expect.any(String),
      });
    });
  });

  describe("Direct Execution Path (ask=off)", () => {
    it("should dispatch directly when no approval needed and wrapper succeeds", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo test",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "off",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      mockDispatchNodeInvokeGuarded.mockResolvedValue({
        payload: {
          success: true,
          stdout: "test output",
          stderr: "",
          error: "",
          exitCode: 0,
        },
      });

      const result = await executeNodeHostCommand(params);

      // Verify success was reflected in response
      expect(result.details.status).toBe("completed");
      if (result.details.status === "completed") {
        expect(result.details.exitCode).toBe(0);
      }
      const textContent = result.content[0];
      expect(textContent).toBeDefined();
      expect(textContent.type).toBe("text");
      if (textContent.type === "text") {
        expect(textContent.text).toBe("test output");
      }

      // Verify wrapper was called exactly once (direct path, not approval)
      expect(mockDispatchNodeInvokeGuarded).toHaveBeenCalledTimes(1);
      expect(mockRegisterApproval).not.toHaveBeenCalled();
    });

    it("should fail-closed when wrapper throws in direct path", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo test",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "off",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      mockDispatchNodeInvokeGuarded.mockRejectedValue(
        new Error("wrapper blocked")
      );

      // Should throw and not swallow the error
      await expect(executeNodeHostCommand(params)).rejects.toThrow(
        "wrapper blocked"
      );

      // Verify wrapper was called
      expect(mockDispatchNodeInvokeGuarded).toHaveBeenCalledTimes(1);
    });

    it("should reflect failure status when wrapper returns failure payload in direct path", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "false",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "off",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      mockDispatchNodeInvokeGuarded.mockResolvedValue({
        payload: {
          success: false,
          stdout: "",
          stderr: "command failed",
          error: "exit code 1",
          exitCode: 1,
        },
      });

      const result = await executeNodeHostCommand(params);

      // Verify failure was reflected
      expect(result.details.status).toBe("failed");
      if (result.details.status === "failed") {
        expect(result.details.exitCode).toBe(1);
        // Aggregated should contain stderr and error
        expect(result.details.aggregated).toContain("command failed");
        expect(result.details.aggregated).toContain("exit code 1");
      }
    });
  });

  describe("Approval Execution Path (ask=on-miss)", () => {
    it("should dispatch after approval and reflect success when wrapper succeeds", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo test",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "on-miss",
        agentId: "test-agent",
        sessionKey: "test-session",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      mockDispatchNodeInvokeGuarded.mockResolvedValue({
        payload: {
          success: true,
          stdout: "approved output",
          stderr: "",
          error: "",
          exitCode: 0,
        },
      });

      const result = await executeNodeHostCommand(params);

      // First response is approval-pending
      expect(result.details.status).toBe("approval-pending");

      // Wait for async dispatch
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify approval flow was triggered
      expect(mockRegisterApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: expect.any(String),
          command: "echo test",
        }),
      );

      // Verify wrapper was called with approved=true and approvalDecision
      const callArgs = mockDispatchNodeInvokeGuarded.mock.calls[0];
      const paramsArg = callArgs[2] as any;
      expect(paramsArg?.params?.approved).toBe(true);
      expect(paramsArg?.params?.approvalDecision).toBe("allow-once");
      // runId is the approvalId (UUID), not the registration.id
      expect(paramsArg?.params?.runId).toBeDefined();
      expect(typeof paramsArg?.params?.runId).toBe("string");
    });

    it("should fail-closed when wrapper throws in approval path", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo test",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "on-miss",
        agentId: "test-agent",
        sessionKey: "test-session",
        notifySessionKey: "notify-key",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      mockDispatchNodeInvokeGuarded.mockRejectedValue(
        new Error("wrapper blocked dispatch")
      );

      const result = await executeNodeHostCommand(params);

      // First response is approval-pending
      expect(result.details.status).toBe("approval-pending");

      // Wait for async dispatch
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify that wrapper exception was caught and denial event was emitted
      expect(mockDispatchNodeInvokeGuarded).toHaveBeenCalled();
      expect(mockEmitExecSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("invoke-failed"),
        expect.objectContaining({
          sessionKey: "notify-key",
        })
      );
    });

    it("should emit denial when user denies in approval flow", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo test",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "on-miss",
        agentId: "test-agent",
        sessionKey: "test-session",
        notifySessionKey: "notify-key",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      // Register returns undefined finalDecision so we need to wait
      mockRegisterApproval.mockResolvedValue({
        id: "approval-id",
        expiresAtMs: Date.now() + 60000,
        finalDecision: undefined,
      } as any);

      mockWaitForDecision.mockResolvedValue("deny");

      const result = await executeNodeHostCommand(params);

      // First response is approval-pending
      expect(result.details.status).toBe("approval-pending");

      // Wait for async dispatch
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify denial event was emitted, not dispatch
      expect(mockDispatchNodeInvokeGuarded).not.toHaveBeenCalled();
      expect(mockEmitExecSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("user-denied"),
        expect.objectContaining({
          sessionKey: "notify-key",
        })
      );
    });

    it("should emit timeout denial when approval request fails", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo test",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "on-miss",
        agentId: "test-agent",
        sessionKey: "test-session",
        notifySessionKey: "notify-key",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      // Register returns undefined finalDecision so we need to wait
      mockRegisterApproval.mockResolvedValue({
        id: "approval-id",
        expiresAtMs: Date.now() + 60000,
        finalDecision: undefined,
      } as any);

      mockWaitForDecision.mockRejectedValue(
        new Error("approval system offline")
      );

      const result = await executeNodeHostCommand(params);

      // First response is approval-pending
      expect(result.details.status).toBe("approval-pending");

      // Wait for async dispatch
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify approval-request-failed event was emitted
      expect(mockDispatchNodeInvokeGuarded).not.toHaveBeenCalled();
      expect(mockEmitExecSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("approval-request-failed"),
        expect.any(Object)
      );
    });

    it("should pass approved=true and approvalDecision to wrapper in approval path", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo test",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "on-miss",
        agentId: "test-agent",
        sessionKey: "test-session",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      // Register returns undefined finalDecision so we need to wait
      mockRegisterApproval.mockResolvedValue({
        id: "approval-id",
        expiresAtMs: Date.now() + 60000,
        finalDecision: undefined,
      } as any);

      mockWaitForDecision.mockResolvedValue("allow-always");

      const result = await executeNodeHostCommand(params);

      expect(result.details.status).toBe("approval-pending");

      // Wait for async dispatch
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify wrapper params reflect approval and decision type
      const callArgs = mockDispatchNodeInvokeGuarded.mock.calls[0];
      const paramsArg = callArgs[2] as any;
      expect(paramsArg?.params?.approved).toBe(true);
      expect(paramsArg?.params?.approvalDecision).toBe("allow-always");
    });

    it("should handle allow-once decision from registration", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo test",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "on-miss",
        agentId: "test-agent",
        sessionKey: "test-session",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      // Registration returns a final decision (no need to wait)
      mockRegisterApproval.mockResolvedValue({
        id: "approval-id",
        expiresAtMs: Date.now() + 60000,
        finalDecision: "allow-once",
      } as any);

      mockDispatchNodeInvokeGuarded.mockResolvedValue({
        payload: {
          success: true,
          stdout: "result",
          stderr: "",
          error: "",
          exitCode: 0,
        },
      });

      const result = await executeNodeHostCommand(params);

      expect(result.details.status).toBe("approval-pending");

      // Wait for async dispatch
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify waitForDecision was not called since registration had decision
      expect(mockWaitForDecision).not.toHaveBeenCalled();

      // Verify dispatch still happened with the pre-resolved decision
      expect(mockDispatchNodeInvokeGuarded).toHaveBeenCalledWith(
        "system.run",
        "test-node",
        expect.objectContaining({
          params: expect.objectContaining({
            approved: true,
            approvalDecision: "allow-once",
          }),
        }),
        expect.any(Object)
      );
    });
  });

  describe("Fail-Closed Behavioral Verification", () => {
    it("direct path: blocked wrapper prevents effective dispatch (throws)", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "echo test",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "off",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      mockDispatchNodeInvokeGuarded.mockRejectedValue(
        new Error("gating: blocked by policy")
      );

      // Execution should fail entirely, not be silenced
      await expect(executeNodeHostCommand(params)).rejects.toThrow(
        "gating: blocked by policy"
      );

      // No response should be returned
      expect(mockDispatchNodeInvokeGuarded).toHaveBeenCalledTimes(1);
    });

    it("approval path: blocked wrapper outcome prevents continuation and emits denial", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "sensitive-command",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "on-miss",
        agentId: "test-agent",
        notifySessionKey: "notify-key",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      mockDispatchNodeInvokeGuarded.mockRejectedValue(
        new Error("gating: blocked by policy")
      );

      const result = await executeNodeHostCommand(params);

      // Initial response is approval-pending
      expect(result.details.status).toBe("approval-pending");

      // Wait for async dispatch
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify that the blocked outcome resulted in a denial event
      expect(mockEmitExecSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("invoke-failed"),
        expect.objectContaining({
          sessionKey: "notify-key",
        })
      );

      // Verify no continuation after the block
      // (blocked wrapper prevents further processing)
      expect(mockDispatchNodeInvokeGuarded).toHaveBeenCalledTimes(1);
    });

    it("direct path: failure payload results in failed status (not success)", async () => {
      const params: ExecuteNodeHostCommandParams = {
        command: "failing-cmd",
        workdir: "/tmp",
        env: { PATH: "/usr/bin" },
        requestedNode: "test-node",
        security: "allowlist",
        ask: "off",
        timeoutSec: 5,
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 1000,
        warnings: [],
      };

      mockDispatchNodeInvokeGuarded.mockResolvedValue({
        payload: {
          success: false,
          stdout: "",
          stderr: "error message",
          error: "Command failed",
          exitCode: 127,
        },
      });

      const result = await executeNodeHostCommand(params);

      // Status must be "failed", not "completed"
      expect(result.details.status).toBe("failed");
      if (result.details.status === "failed") {
        expect(result.details.exitCode).toBe(127);
        expect(result.details.aggregated).toContain("error message");
      }
    });
  });
});
