import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import type { LobsterRunner } from "./lobster-runner.js";
import { resumeManagedLobsterFlow, runManagedLobsterFlow } from "./lobster-taskflow.js";

type BoundTaskFlow = ReturnType<
  NonNullable<OpenClawPluginApi["runtime"]>["taskFlow"]["bindSession"]
>;

function expectManagedFlowFailure(
  result: Awaited<ReturnType<typeof runManagedLobsterFlow | typeof resumeManagedLobsterFlow>>,
) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected managed Lobster flow to fail");
  }
  return result;
}

function createFakeTaskFlow(overrides?: Partial<BoundTaskFlow>) {
  const baseFlow = {
    flowId: "flow-1",
    revision: 1,
    syncMode: "managed" as const,
    controllerId: "tests/lobster",
    ownerKey: "agent:main:main",
    status: "running" as const,
    goal: "Run Lobster workflow",
  };

  const taskFlow: BoundTaskFlow = {
    sessionKey: "agent:main:main",
    createManaged: vi.fn().mockReturnValue(baseFlow),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    findLatest: vi.fn(),
    resolve: vi.fn(),
    getTaskSummary: vi.fn(),
    setWaiting: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "waiting" as const },
    })),
    resume: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "running" as const },
    })),
    finish: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "completed" as const },
    })),
    fail: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "failed" as const },
    })),
    requestCancel: vi.fn(),
    cancel: vi.fn(),
    runTask: vi.fn(),
    ...overrides,
  };

  return taskFlow;
}

function createRunner(result: Awaited<ReturnType<LobsterRunner["run"]>>): LobsterRunner {
  return {
    run: vi.fn().mockResolvedValue(result),
  };
}

describe("runManagedLobsterFlow", () => {
  it("creates a flow and finishes it when Lobster succeeds", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner = createRunner({
      ok: true,
      status: "ok",
      output: [{ id: "result-1" }],
      requiresApproval: null,
    });

    const result = await runManagedLobsterFlow({
      taskFlow,
      runner,
      runnerParams: {
        action: "run",
        pipeline: "noop",
        cwd: process.cwd(),
        timeoutMs: 1000,
        maxStdoutBytes: 4096,
      },
      controllerId: "tests/lobster",
      goal: "Run Lobster workflow",
    });

    expect(result.ok).toBe(true);
    expect(taskFlow.createManaged).toHaveBeenCalledWith({
      controllerId: "tests/lobster",
      goal: "Run Lobster workflow",
      currentStep: "run_lobster",
    });
    expect(taskFlow.finish).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
    });
  });

  it("moves the flow to waiting when Lobster requests approval", async () => {
    const taskFlow = createFakeTaskFlow();
    const createdAt = new Date("2026-04-05T21:00:00.000Z");
    const runner = createRunner({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "Approve this?",
        items: [{ id: "item-1", createdAt, count: 2n, skip: undefined }],
        resumeToken: "resume-1",
      },
    });

    const result = await runManagedLobsterFlow({
      taskFlow,
      runner,
      runnerParams: {
        action: "run",
        pipeline: "noop",
        cwd: process.cwd(),
        timeoutMs: 1000,
        maxStdoutBytes: 4096,
      },
      controllerId: "tests/lobster",
      goal: "Run Lobster workflow",
    });

    expect(result.ok).toBe(true);
    expect(taskFlow.setWaiting).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
      currentStep: "await_lobster_approval",
      waitJson: {
        kind: "lobster_approval",
        prompt: "Approve this?",
        items: [{ id: "item-1", createdAt: createdAt.toISOString(), count: "2" }],
        resumeToken: "resume-1",
      },
    });
  });

  it("fails the flow when Lobster returns an error envelope", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner = createRunner({
      ok: false,
      error: {
        type: "runtime_error",
        message: "boom",
      },
    });

    const result = await runManagedLobsterFlow({
      taskFlow,
      runner,
      runnerParams: {
        action: "run",
        pipeline: "noop",
        cwd: process.cwd(),
        timeoutMs: 1000,
        maxStdoutBytes: 4096,
      },
      controllerId: "tests/lobster",
      goal: "Run Lobster workflow",
    });

    const failure = expectManagedFlowFailure(result);
    expect(failure.error.message).toBe("boom");
    expect(taskFlow.fail).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
    });
  });

  it("fails the flow when the runner throws", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner: LobsterRunner = {
      run: vi.fn().mockRejectedValue(new Error("crashed")),
    };

    const result = await runManagedLobsterFlow({
      taskFlow,
      runner,
      runnerParams: {
        action: "run",
        pipeline: "noop",
        cwd: process.cwd(),
        timeoutMs: 1000,
        maxStdoutBytes: 4096,
      },
      controllerId: "tests/lobster",
      goal: "Run Lobster workflow",
    });

    const failure = expectManagedFlowFailure(result);
    expect(failure.error.message).toBe("crashed");
    expect(taskFlow.fail).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
    });
  });
});

describe("resumeManagedLobsterFlow", () => {
  it("resumes the flow and finishes it on success", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner = createRunner({
      ok: true,
      status: "ok",
      output: [],
      requiresApproval: null,
    });

    const result = await resumeManagedLobsterFlow({
      taskFlow,
      runner,
      flowId: "flow-1",
      expectedRevision: 4,
      runnerParams: {
        action: "resume",
        token: "resume-1",
        approve: true,
        cwd: process.cwd(),
        timeoutMs: 1000,
        maxStdoutBytes: 4096,
      },
    });

    expect(result.ok).toBe(true);
    expect(taskFlow.resume).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 4,
      status: "running",
      currentStep: "resume_lobster",
    });
    expect(taskFlow.finish).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 5,
    });
  });

  it("returns a mutation error when taskFlow resume is rejected", async () => {
    const taskFlow = createFakeTaskFlow({
      resume: vi.fn().mockReturnValue({
        applied: false,
        code: "revision_conflict",
      }),
    });
    const runner = createRunner({
      ok: true,
      status: "ok",
      output: [],
      requiresApproval: null,
    });

    const result = await resumeManagedLobsterFlow({
      taskFlow,
      runner,
      flowId: "flow-1",
      expectedRevision: 4,
      runnerParams: {
        action: "resume",
        token: "resume-1",
        approve: true,
        cwd: process.cwd(),
        timeoutMs: 1000,
        maxStdoutBytes: 4096,
      },
    });

    const failure = expectManagedFlowFailure(result);
    expect(failure.error.message).toMatch(/revision_conflict/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("returns to waiting when the resumed Lobster run needs approval again", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner = createRunner({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "Approve this too?",
        items: [{ id: "item-2" }],
        resumeToken: "resume-2",
      },
    });

    const result = await resumeManagedLobsterFlow({
      taskFlow,
      runner,
      flowId: "flow-1",
      expectedRevision: 4,
      runnerParams: {
        action: "resume",
        token: "resume-1",
        approve: true,
        cwd: process.cwd(),
        timeoutMs: 1000,
        maxStdoutBytes: 4096,
      },
    });

    expect(result.ok).toBe(true);
    expect(taskFlow.setWaiting).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 5,
      currentStep: "await_lobster_approval",
      waitJson: {
        kind: "lobster_approval",
        prompt: "Approve this too?",
        items: [{ id: "item-2" }],
        resumeToken: "resume-2",
      },
    });
  });
});
