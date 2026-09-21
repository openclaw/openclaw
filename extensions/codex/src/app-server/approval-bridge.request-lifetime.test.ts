import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import { codexTestTurnIds } from "./codex-app-server.test-fixtures.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { CodexServerRequestResolvedError } from "./server-requests.js";

type AgentHarnessHostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];

function createParams(): EmbeddedRunAttemptParams {
  return {
    sessionKey: "agent:main:approval-lifetime",
    agentId: "main",
    onAgentEvent: vi.fn(),
    hostCapabilities: createCodexTestHostCapabilities(),
  } as unknown as EmbeddedRunAttemptParams;
}

describe("Codex approval request lifetime", () => {
  it.each([
    { reason: "turn_progress_idle_timeout", disposition: "timed_out" },
    { reason: "turn_completion_idle_timeout", disposition: "timed_out" },
    { reason: "turn_terminal_idle_timeout", disposition: "timed_out" },
    { reason: "client_closed", disposition: "failed" },
  ] as const)(
    "normalizes aborted approval reason $reason as $disposition",
    async ({ reason, disposition }) => {
      const params = createParams();
      const controller = new AbortController();
      controller.abort(reason);
      const onNativeToolFailureDisposition = vi.fn();

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "cmd-aborted-policy",
          command: "pnpm test",
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
        signal: controller.signal,
        onNativeToolFailureDisposition,
      });

      expect(result).toEqual({ decision: "cancel" });
      expect(onNativeToolFailureDisposition).toHaveBeenCalledWith(
        "cmd-aborted-policy",
        disposition,
      );
    },
  );

  it.each(["before dispatch", "policy", "registration", "decision"] as const)(
    "does not report a native tool failure when another client resolves approval during %s",
    async (phase) => {
      const params = createParams();
      const controller = new AbortController();
      const resolved = new CodexServerRequestResolvedError();
      const onNativeToolFailureDisposition = vi.fn();
      const resolveDuring = (stage: typeof phase) => {
        if (phase === stage) {
          controller.abort(resolved);
        }
      };
      const waitForApproval = vi.fn<AgentHarnessHostCapabilities["waitForApproval"]>(async () => {
        resolveDuring("decision");
        return undefined;
      });
      params.hostCapabilities = {
        ...params.hostCapabilities,
        runBeforeToolCall: async ({ params: toolParams }) => {
          resolveDuring("policy");
          return { blocked: false, params: toolParams };
        },
        requestApproval: async ({ signal }) => {
          expect(signal).toBe(controller.signal);
          resolveDuring("registration");
          return { id: "plugin:approval-resolved" };
        },
        waitForApproval,
      };
      resolveDuring("before dispatch");

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/fileChange/requestApproval",
        requestParams: { ...codexTestTurnIds(), itemId: "patch-resolved" },
        paramsForRun: params,
        ...codexTestTurnIds(),
        signal: controller.signal,
        onNativeToolFailureDisposition,
      });

      expect(result).toBeUndefined();
      expect(onNativeToolFailureDisposition).not.toHaveBeenCalled();
      expect(params.onAgentEvent).not.toHaveBeenCalledWith({
        stream: "approval",
        data: expect.objectContaining({ phase: "resolved" }),
      });
      expect(waitForApproval).toHaveBeenCalledTimes(phase === "decision" ? 1 : 0);
    },
  );

  it.each(["registration", "decision"] as const)(
    "retains the approval correlation when its run aborts during %s",
    async (phase) => {
      const params = createParams();
      const controller = new AbortController();
      const onNativeToolFailureDisposition = vi.fn();
      params.hostCapabilities = {
        ...params.hostCapabilities,
        requestApproval: async () => {
          if (phase === "registration") {
            controller.abort("run stopped");
          }
          return { id: "plugin:approval-cancelled" };
        },
        waitForApproval: async () => {
          controller.abort("run stopped");
          return undefined;
        },
      };
      const response = await handleCodexAppServerApprovalRequest({
        method: "item/fileChange/requestApproval",
        requestParams: { ...codexTestTurnIds(), itemId: "patch-cancelled" },
        paramsForRun: params,
        ...codexTestTurnIds(),
        signal: controller.signal,
        onNativeToolFailureDisposition,
      });
      expect(response).toEqual({ decision: "cancel" });
      expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("patch-cancelled", "cancelled");
      expect(params.onAgentEvent).toHaveBeenCalledWith({
        stream: "approval",
        data: expect.objectContaining({
          phase: "resolved",
          status: "failed",
          approvalId: "plugin:approval-cancelled",
          approvalSlug: "plugin:approval-cancelled",
        }),
      });
    },
  );
});
