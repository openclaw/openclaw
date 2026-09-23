import { Value } from "typebox/value";
import { expect, it, type Mock } from "vitest";
import { readInProcessSubagentResume } from "../gateway/in-process-subagent-resume.js";
import { createOperationalRunInstanceRef } from "./admitted-run-context.js";
import { subagentRuns } from "./subagents/registry/subagent-registry-memory.js";
import { addSubagentRunForTests } from "./subagents/registry/subagent-registry.test-helpers.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

type SessionsSendResumeFixtures = {
  getSessionTool: (name: "sessions_send", options: { agentSessionKey: string }) => AnyAgentTool;
  callGatewayMock: Mock;
  loadSessionEntryByKeyMock: Mock;
};

export function registerSessionsSendResumeTests({
  getSessionTool,
  callGatewayMock,
  loadSessionEntryByKeyMock,
}: SessionsSendResumeFixtures) {
  it("sessions_send resume rejects a caller without admitted authority instead of sending a message", async () => {
    const tool = getSessionTool("sessions_send", { agentSessionKey: "agent:main:main" });
    const result = await tool.execute("resume", {
      sessionKey: "agent:main:dashboard:paused-child",
      message: "Continue the assigned task",
      mode: "resume",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("admitted"),
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each(
    ["agent:main:subagent:resume-child", "agent:main:dashboard:resume-child"].flatMap((targetKey) =>
      [
        { scenario: "explicit resume", options: { mode: "resume" as const } },
        { scenario: "automatic resume", options: {} },
        { scenario: "newer completed sibling", options: {} },
        {
          scenario: "automatic resume with reply options",
          options: { timeoutSeconds: 30, watch: true },
        },
        { scenario: "explicit separate followup", options: { mode: "followup" as const } },
        { scenario: "unrelated caller", options: {} },
        { scenario: "completed child", options: {} },
        { scenario: "completion disabled", options: {} },
        { scenario: "completion unspecified", options: {} },
      ].map((testCase) => Object.assign({ targetKey }, testCase)),
    ),
  )(
    "sessions_send preserves completion ownership for $targetKey: $scenario",
    async ({ targetKey, scenario, options }) => {
      const parent = "agent:main:main";
      const previousRunId = "tool-resume-paused";
      const siblingRunId = "tool-resume-independent-sibling";
      const controller =
        scenario === "unrelated caller" ? "agent:main:dashboard:other-parent" : parent;
      const pauseReason = scenario === "completed child" ? undefined : "sessions_yield";
      const resumes =
        scenario !== "explicit separate followup" &&
        scenario !== "unrelated caller" &&
        scenario !== "completed child" &&
        scenario !== "completion disabled" &&
        scenario !== "completion unspecified";
      addSubagentRunForTests({
        runId: previousRunId,
        childSessionKey: targetKey,
        requesterSessionKey: controller,
        requesterDisplayKey: controller,
        controllerSessionKey: controller,
        task: "Wait",
        cleanup: "keep",
        startedAt: Date.now() - 100,
        endedAt: Date.now(),
        pauseReason,
        expectsCompletionMessage:
          scenario === "completion unspecified" ? undefined : scenario !== "completion disabled",
      });
      if (scenario === "newer completed sibling") {
        addSubagentRunForTests({
          runId: siblingRunId,
          childSessionKey: targetKey,
          requesterSessionKey: "agent:main:dashboard:separate-requester",
          requesterDisplayKey: "separate-requester",
          controllerSessionKey: parent,
          task: "Independent follow-up",
          cleanup: "keep",
          generation: 2,
          createdAt: Date.now() + 1,
          execution: { status: "terminal", endedAt: Date.now() + 1, outcome: { status: "ok" } },
        });
      }
      loadSessionEntryByKeyMock.mockReturnValue({
        sessionId: "tool-resume-session",
        updatedAt: Date.now(),
      });
      callGatewayMock.mockImplementation(async ({ method }) => {
        if (method === "agent") {
          return {
            status: "accepted",
            runId: "tool-resume-successor",
            ...(resumes ? { taskRunId: previousRunId } : {}),
          };
        }
        return method === "agent.wait"
          ? { status: "ok", terminalReply: { disposition: "empty" } }
          : {};
      });
      const tool = getSessionTool("sessions_send", { agentSessionKey: parent });
      try {
        const result = await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: parent,
            operationalRunInstance: createOperationalRunInstanceRef("parent-turn"),
            receiptAuthority: () => true,
          },
          () => tool.execute("resume", { sessionKey: targetKey, message: "Continue", ...options }),
        );
        expect(result.details).toEqual(
          resumes
            ? {
                status: "accepted",
                mode: "resume",
                runId: "tool-resume-successor",
                taskRunId: previousRunId,
                sessionKey: targetKey,
                completion: "task",
              }
            : {
                status: "no_reply",
                runId: "tool-resume-successor",
                sessionKey: targetKey,
                message: expect.any(String),
              },
        );
        expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
        expect(
          callGatewayMock.mock.calls.filter(([request]) => request.method === "agent"),
        ).toHaveLength(1);
        expect(
          callGatewayMock.mock.calls.filter(([request]) => request.method === "agent.wait"),
        ).toHaveLength(resumes ? 0 : 1);
        const request = callGatewayMock.mock.calls.find(
          ([candidate]) => candidate.method === "agent",
        )?.[0];
        if (resumes) {
          expect(readInProcessSubagentResume(request)).toMatchObject({
            previousRunId,
            childSessionKey: targetKey,
            childSessionId: "tool-resume-session",
          });
          expect(request.params).toMatchObject({
            expectedExistingSessionId: "tool-resume-session",
          });
        } else {
          expect(readInProcessSubagentResume(request)).toBeUndefined();
          expect(request.params).toMatchObject({ sessionKey: targetKey });
        }
        expect(request.params).not.toHaveProperty("subagentResume");
        expect(subagentRuns.get(previousRunId)).toMatchObject({
          pauseReason,
          requesterSessionKey: controller,
          controllerSessionKey: controller,
        });
      } finally {
        subagentRuns.delete(previousRunId);
        subagentRuns.delete(siblingRunId);
      }
    },
  );

  it.each([{ watch: true }, { timeoutSeconds: 1 }])(
    "sessions_send resume rejects competing delivery options %j",
    async (options) => {
      const parent = "agent:main:main";
      const tool = getSessionTool("sessions_send", { agentSessionKey: parent });
      await expect(
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: parent,
            operationalRunInstance: createOperationalRunInstanceRef("parent-options-turn"),
            receiptAuthority: () => true,
          },
          () =>
            tool.execute("resume-options", {
              sessionKey: "agent:main:subagent:child",
              message: "Continue",
              mode: "resume",
              ...options,
            }),
        ),
      ).rejects.toThrow("admission only");
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );
}
