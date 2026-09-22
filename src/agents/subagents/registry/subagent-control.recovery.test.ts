import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import * as sessionLifecycle from "../../../sessions/session-lifecycle-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import * as taskControlRuntime from "../../../tasks/task-registry-control.runtime.js";
import { cancelTaskById, findTaskByRunId, getTaskById } from "../../../tasks/task-registry.js";
import type { AgentWaitResult } from "../../run-wait.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRegistryDeps } from "./subagent-registry-deps.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  markSubagentRunTerminated,
  registerSubagentRun,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { testing } from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();

it("does not promote a provisional task when replacement wins before admin admission", async () => {
  testing.setDepsForTest({
    ...subagentRegistryDeps,
    cleanupBrowserSessionsForLifecycleEnd: async () => {},
    runSubagentAnnounceFlow: async () => "delivered",
  });
  const nextWait = createDeferred<AgentWaitResult>();
  vi.spyOn(subagentRegistryDeps, "callGateway").mockImplementation(async (request) => {
    expect(request.method).toBe("agent.wait");
    return (request.params as { runId: string }).runId === "admission-b1"
      ? await nextWait.promise
      : await new Promise<never>(() => {});
  });
  const sessionKey = "agent:main:subagent:publication-admission";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: "publication-admission-session",
  });
  registerSubagentRun({
    runId: "admission-b0",
    childSessionKey: sessionKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "original task",
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
  const b0 = subagentRuns.get("admission-b0")!;
  const task = findTaskByRunId(b0.runId)!;
  expect(markSubagentRunTerminated({ runId: b0.runId, reason: "killed" })).toBe(1);
  expect(getTaskById(task.taskId)).toMatchObject({
    status: "cancelled",
    error: SUBAGENT_KILL_TASK_ERROR,
  });
  const completed = createDeferred();
  fixture.persist.mockImplementation((...runIds) => {
    persistSubagentRunsToDiskOrThrow(...runIds);
    if (subagentRuns.get("admission-b1")?.execution.outcome?.status === "ok") {
      completed.resolve();
    }
  });
  const followup = await sessionLifecycle.beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, "publication-admission-session"],
    assertAllowed: () => {},
    onInterrupt: () => {},
  });
  const runAdmin = killSubagentRunAdmin;
  const admin = vi.spyOn(taskControlRuntime, "killSubagentRunAdmin").mockImplementation(runAdmin);
  const pending = cancelTaskById({ cfg: getRuntimeConfig(), taskId: task.taskId });
  try {
    expect(admin).not.toHaveBeenCalled();
    // The existing lazy-runtime await leaves admission open before admin captures a run.
    await followup.run(async () => {
      expect(
        replaceSubagentRunAfterSteerCore({
          previousRunId: b0.runId,
          nextRunId: "admission-b1",
          fallback: b0,
          runTimeoutSeconds: 0,
          task: "admitted follow-up",
        }),
      ).toBe(true);
      expect(admin).not.toHaveBeenCalled();
      expect(getTaskById(task.taskId)?.detail).toMatchObject({
        generation: subagentRuns.get("admission-b1")?.generation,
      });
    });
    const result = await pending;
    expect(await admin.mock.results[0]!.value).toEqual({ found: false, killed: false });
    expect.soft(result.cancelled).toBe(false);
    expect.soft(getTaskById(task.taskId)?.status).toBe("running");
    expect.soft(getTaskById(task.taskId)?.error).toBeUndefined();
    nextWait.resolve({
      status: "ok",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "follow-up completed" },
    });
    await completed.promise;
    expect.soft(getTaskById(task.taskId)?.status).toBe("succeeded");
  } finally {
    followup.release();
    await pending;
    admin.mockRestore();
  }
});
