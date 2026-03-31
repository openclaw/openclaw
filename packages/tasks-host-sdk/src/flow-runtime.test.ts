import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../../src/test-helpers/temp-dir.js";
import { getFlowById, resetFlowRegistryForTests, updateFlowRecordById } from "./flow-registry.js";
import {
  appendFlowOutput,
  createFlow,
  emitFlowUpdate,
  failFlow,
  finishFlow,
  resumeFlow,
  runTaskInFlow,
  setFlowOutput,
} from "./flow-runtime.js";
import { listTasksForFlowId, resetTaskRegistryForTests } from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const mocks = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  enqueueSystemEventMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
}));

vi.mock("./task-registry-delivery-runtime.js", () => ({
  sendMessage: (...args: unknown[]) => mocks.sendMessageMock(...args),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => mocks.enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => mocks.requestHeartbeatNowMock(...args),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: () => () => {},
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: vi.fn(),
  }),
}));

vi.mock("../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: vi.fn(),
}));

async function withFlowRuntimeStateDir(run: (root: string) => Promise<void>): Promise<void> {
  await withTempDir({ prefix: "openclaw-flow-runtime-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryForTests();
    resetFlowRegistryForTests();
    try {
      await run(root);
    } finally {
      resetTaskRegistryForTests();
      resetFlowRegistryForTests();
    }
  });
}

describe("flow-runtime", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryForTests();
    resetFlowRegistryForTests();
    mocks.sendMessageMock.mockReset();
    mocks.enqueueSystemEventMock.mockReset();
    mocks.requestHeartbeatNowMock.mockReset();
  });

  it("runs a child task under a linear flow and marks the flow as waiting on it", async () => {
    await withFlowRuntimeStateDir(async () => {
      const flow = createFlow({
        ownerSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        goal: "Triage inbox",
      });

      const started = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-runtime-1",
        task: "Classify inbox messages",
        currentStep: "wait_for_classification",
      });

      expect(started.task).toMatchObject({
        requesterSessionKey: "agent:main:main",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-runtime-1",
        status: "queued",
      });
      expect(started.flow).toMatchObject({
        flowId: flow.flowId,
        status: "waiting",
        currentStep: "wait_for_classification",
        waitingOnTaskId: started.task.taskId,
      });
      expect(listTasksForFlowId(flow.flowId)).toHaveLength(1);
    });
  });

  it("stores outputs and waiting metadata across sqlite restore", async () => {
    await withFlowRuntimeStateDir(async () => {
      const flow = createFlow({
        ownerSessionKey: "agent:main:main",
        goal: "Inbox routing",
      });

      const started = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "subagent",
        childSessionKey: "agent:codex:subagent:child",
        runId: "run-flow-runtime-restore",
        task: "Bucket messages",
      });

      setFlowOutput({
        flowId: flow.flowId,
        key: "classification",
        value: {
          business: 1,
          personal: 2,
        },
      });
      appendFlowOutput({
        flowId: flow.flowId,
        key: "eod_summary",
        value: {
          subject: "Newsletter",
        },
      });

      resetTaskRegistryForTests({ persist: false });
      resetFlowRegistryForTests({ persist: false });

      expect(getFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "waiting",
        waitingOnTaskId: started.task.taskId,
        outputs: {
          classification: {
            business: 1,
            personal: 2,
          },
          eod_summary: [
            {
              subject: "Newsletter",
            },
          ],
        },
      });
    });
  });

  it("reopens a blocked flow with resume and marks terminal states with finish/fail", async () => {
    await withFlowRuntimeStateDir(async () => {
      const flow = createFlow({
        ownerSessionKey: "agent:main:main",
        goal: "Review inbox",
      });
      const started = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-runtime-reopen",
        task: "Review inbox",
      });

      updateFlowRecordById(flow.flowId, {
        status: "blocked",
        blockedTaskId: started.task.taskId,
        blockedSummary: "Need auth.",
        endedAt: 120,
      });

      expect(resumeFlow({ flowId: flow.flowId, currentStep: "retry_auth" })).toMatchObject({
        flowId: flow.flowId,
        status: "running",
        currentStep: "retry_auth",
      });
      expect(getFlowById(flow.flowId)?.blockedTaskId).toBeUndefined();
      expect(getFlowById(flow.flowId)?.waitingOnTaskId).toBeUndefined();
      expect(getFlowById(flow.flowId)?.endedAt).toBeUndefined();

      expect(
        finishFlow({ flowId: flow.flowId, currentStep: "finish", endedAt: 200 }),
      ).toMatchObject({
        flowId: flow.flowId,
        status: "succeeded",
        currentStep: "finish",
        endedAt: 200,
      });

      const failed = createFlow({
        ownerSessionKey: "agent:main:main",
        goal: "Failing flow",
      });
      expect(failFlow({ flowId: failed.flowId, currentStep: "abort", endedAt: 300 })).toMatchObject(
        {
          flowId: failed.flowId,
          status: "failed",
          currentStep: "abort",
          endedAt: 300,
        },
      );
    });
  });

  it("delivers explicit flow updates through the flow owner context when possible", async () => {
    await withFlowRuntimeStateDir(async () => {
      const flow = createFlow({
        ownerSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
          threadId: "42",
        },
        goal: "Inbox routing",
      });

      const result = await emitFlowUpdate({
        flowId: flow.flowId,
        content: "Personal message needs your attention.",
        eventKey: "personal-alert",
      });

      expect(result.delivery).toBe("direct");
      expect(mocks.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "telegram",
          to: "telegram:123",
          threadId: "42",
          content: "Personal message needs your attention.",
          idempotencyKey: `flow:${flow.flowId}:update:personal-alert`,
          mirror: expect.objectContaining({
            sessionKey: "agent:main:main",
          }),
        }),
      );
    });
  });

  it("falls back to session-queued flow updates when direct delivery is unavailable", async () => {
    await withFlowRuntimeStateDir(async () => {
      const flow = createFlow({
        ownerSessionKey: "agent:main:main",
        goal: "Inbox routing",
      });

      const result = await emitFlowUpdate({
        flowId: flow.flowId,
        content: "Business email sent to Slack and waiting for reply.",
      });

      expect(result.delivery).toBe("session_queued");
      expect(mocks.enqueueSystemEventMock).toHaveBeenCalledWith(
        "Business email sent to Slack and waiting for reply.",
        expect.objectContaining({
          sessionKey: "agent:main:main",
          contextKey: `flow:${flow.flowId}`,
        }),
      );
      expect(mocks.requestHeartbeatNowMock).toHaveBeenCalledWith({
        reason: "clawflow-update",
        sessionKey: "agent:main:main",
      });
    });
  });
});
