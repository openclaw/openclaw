import { Value } from "typebox/value";
import { expect, it, type Mock } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readInProcessSubagentResume } from "../gateway/in-process-subagent-resume.js";
import { createOperationalRunInstanceRef } from "./admitted-run-context.js";
import { subagentRuns } from "./subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagents/registry/subagent-registry-persistence.js";
import { addSubagentRunForTests } from "./subagents/registry/subagent-registry.test-helpers.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

type SessionsSendResumeFixtures = {
  getSessionTool: (name: "sessions_send", options: { agentSessionKey: string }) => AnyAgentTool;
  callGatewayMock: Mock;
};
const parent = "agent:main:main";
const caller = (runId: string) => ({
  agentId: "main",
  sessionKey: parent,
  operationalRunInstance: createOperationalRunInstanceRef(runId),
  receiptAuthority: () => true,
});

export function registerSessionsSendResumeTests({
  getSessionTool,
  callGatewayMock,
}: SessionsSendResumeFixtures) {
  it.each([
    [
      "unadmitted caller",
      { sessionKey: "agent:main:dashboard:paused-child", message: "Continue the assigned task" },
    ],
    [
      "competing delivery options",
      { sessionKey: "agent:main:subagent:child", message: "Continue", timeoutSeconds: 1 },
    ],
  ] as const)("sessions_send resume rejects %s before gateway work", async (scenario, options) => {
    const tool = getSessionTool("sessions_send", { agentSessionKey: parent });
    const execute = () => tool.execute("resume", { mode: "resume", ...options });
    if (scenario === "competing delivery options") {
      await expect(
        withGatewayToolCallerIdentity(caller("parent-options-turn"), execute),
      ).rejects.toThrow("admission only");
    } else {
      expect((await execute()).details).toMatchObject({
        status: "forbidden",
        error: expect.stringContaining("admitted"),
      });
    }
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([
    ["explicit resume", { mode: "resume" }, true],
    ["newer completed sibling", {}, true],
    ["automatic resume with reply options", { timeoutSeconds: 30, watch: true }, true],
    ["explicit separate followup", { mode: "followup" }, false],
    ["unrelated caller", {}, false],
    ["completion unspecified", {}, false],
  ] as const)("sessions_send completion ownership: %s", async (scenario, options, resumes) => {
    const targetKey = `agent:main:${scenario === "explicit resume" ? "subagent" : "dashboard"}:resume-child`;
    const previousRunId = "tool-resume-paused";
    const siblingRunId = "tool-resume-independent-sibling";
    const controller =
      scenario === "unrelated caller" ? "agent:main:dashboard:other-parent" : parent;
    const pauseReason = "sessions_yield";
    const childSessionIdentity = {
      sessionId: "tool-resume-session",
      lifecycleRevision: "tool-resume-revision",
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: targetKey },
      { ...childSessionIdentity, updatedAt: Date.now() },
    );
    const run = {
      childSessionKey: targetKey,
      childSessionIdentity,
      requesterSessionKey: controller,
      requesterDisplayKey: controller,
      controllerSessionKey: controller,
      task: "Wait",
      cleanup: "keep" as const,
    };
    await addSubagentRunForTests({
      ...run,
      runId: previousRunId,
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
      pauseReason,
      expectsCompletionMessage: scenario === "completion unspecified" ? undefined : true,
    });
    if (scenario === "newer completed sibling") {
      await addSubagentRunForTests({
        ...run,
        runId: siblingRunId,
        requesterSessionKey: "agent:main:dashboard:separate-requester",
        requesterDisplayKey: "separate-requester",
        controllerSessionKey: parent,
        task: "Independent follow-up",
        generation: 2,
        createdAt: Date.now() + 1,
        execution: { status: "terminal", endedAt: Date.now() + 1, outcome: { status: "ok" } },
      });
    }
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
      const result = await withGatewayToolCallerIdentity(caller("parent-turn"), () =>
        tool.execute("resume", { sessionKey: targetKey, message: "Continue", ...options }),
      );
      expect(result.details).toEqual({
        runId: "tool-resume-successor",
        sessionKey: targetKey,
        ...(resumes
          ? {
              status: "accepted",
              mode: "resume",
              taskRunId: previousRunId,
              completion: "task",
            }
          : {
              status: "no_reply",
              message: expect.any(String),
            }),
      });
      expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
      const callsFor = (method: string) =>
        callGatewayMock.mock.calls.filter(([request]) => request.method === method);
      expect(callsFor("agent")).toHaveLength(1);
      expect(callsFor("agent.wait")).toHaveLength(resumes ? 0 : 1);
      const request = callsFor("agent")[0]?.[0];
      expect({
        resume: readInProcessSubagentResume(request),
        params: request.params,
      }).toMatchObject({
        resume: resumes
          ? {
              previousRunId,
              childSessionKey: targetKey,
              childSessionId: "tool-resume-session",
            }
          : undefined,
        params: resumes
          ? { expectedExistingSessionId: "tool-resume-session" }
          : { sessionKey: targetKey },
      });
      expect(request.params).not.toHaveProperty("subagentResume");
      expect(subagentRuns.get(previousRunId)).toMatchObject({
        pauseReason,
        requesterSessionKey: controller,
        controllerSessionKey: controller,
      });
    } finally {
      await mutateSubagentRuns([previousRunId, siblingRunId], (rows) => ({
        value: undefined,
        postimages: new Map([...rows.keys()].map((runId) => [runId, null])),
      }));
    }
  });
}
