// Lobster tests cover lobster taskflow plugin behavior.
import { createRuntimeTaskFlow } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { LobsterRunner } from "./lobster-runner.js";
import {
  inspectManagedLobsterFlows,
  resumeManagedLobsterFlow,
  runManagedLobsterFlow,
  type BoundTaskFlow,
} from "./lobster-taskflow.js";
import { createFakeTaskFlow } from "./taskflow-test-helpers.js";

function expectManagedFlowFailure(
  result: Awaited<ReturnType<typeof runManagedLobsterFlow | typeof resumeManagedLobsterFlow>>,
) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected managed Lobster flow to fail");
  }
  return result;
}
function createRunner(result: Awaited<ReturnType<LobsterRunner["run"]>>): LobsterRunner {
  return {
    run: vi.fn().mockResolvedValue(result),
  };
}

function createRunFlowParams(
  taskFlow: ReturnType<typeof createFakeTaskFlow>,
  runner: LobsterRunner,
): Parameters<typeof runManagedLobsterFlow>[0] {
  return {
    taskFlow,
    config: {},
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
  };
}

function createResumeFlowParams(
  taskFlow: ReturnType<typeof createFakeTaskFlow>,
  runner: LobsterRunner,
): Parameters<typeof resumeManagedLobsterFlow>[0] {
  return {
    taskFlow,
    config: {},
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

    const result = await runManagedLobsterFlow(createRunFlowParams(taskFlow, runner));

    expect(result.ok).toBe(true);
    expect(taskFlow.tryCreateManaged).toHaveBeenCalledWith({
      controllerId: "tests/lobster",
      goal: "Run Lobster workflow",
      status: "running",
      currentStep: "run_lobster",
    });
    expect(taskFlow.finish).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
    });
  });

  it("serializes cyclic and supported approval items before waiting", async () => {
    const taskFlow = createFakeTaskFlow();
    const createdAt = new Date("2026-04-05T21:00:00.000Z");
    const selfArray: unknown[] = [];
    selfArray.push(selfArray);
    const objectArrayCycle: Record<string, unknown> = {};
    objectArrayCycle.items = [objectArrayCycle];
    const shared = { id: "shared" };
    const protoEntry: Record<string, unknown> = JSON.parse(
      '{"__proto__":{"polluted":true},"kept":"value"}',
    );
    const runner = createRunner({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "Approve this?",
        items: [
          {
            selfArray,
            objectArrayCycle,
            repeated: [shared, shared],
            createdAt,
            infinity: Number.POSITIVE_INFINITY,
            count: 2n,
            omitted: {
              kept: true,
              undefinedValue: undefined,
              function: () => true,
              symbol: Symbol("skip"),
            },
            protoEntry,
            arrayValues: [undefined, () => true, Symbol("skip"), Number.NaN],
          },
        ],
        resumeToken: "resume-1",
      },
    });

    const result = await runManagedLobsterFlow(createRunFlowParams(taskFlow, runner));

    expect(result.ok).toBe(true);
    expect(taskFlow.setWaiting).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
      currentStep: "await_lobster_approval",
      waitJson: {
        kind: "lobster_approval",
        cwd: process.cwd(),
        prompt: "Approve this?",
        items: [
          {
            selfArray: ["[Circular]"],
            objectArrayCycle: { items: ["[Circular]"] },
            repeated: [{ id: "shared" }, { id: "shared" }],
            createdAt: createdAt.toISOString(),
            infinity: "Infinity",
            count: "2",
            omitted: { kept: true },
            protoEntry: { kept: "value" },
            arrayValues: [null, null, null, "NaN"],
          },
        ],
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

    const result = expectManagedFlowFailure(
      await runManagedLobsterFlow(createRunFlowParams(taskFlow, runner)),
    );
    expect(result.error.message).toBe("boom");
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

    const result = expectManagedFlowFailure(
      await runManagedLobsterFlow(createRunFlowParams(taskFlow, runner)),
    );
    expect(result.error.message).toBe("crashed");
    expect(taskFlow.fail).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
    });
  });
});

describe("resumeManagedLobsterFlow", () => {
  it.each([
    { status: "running" as const },
    { status: "succeeded" as const },
    { cancelRequestedAt: 10 },
    { endedAt: 10 },
    { waitJson: { kind: "external_event" } },
    { waitJson: { kind: "lobster_approval" } },
    { revision: 5 },
  ])("does not execute an unavailable or changed checkpoint: %j", async (change) => {
    const taskFlow = createFakeTaskFlow();
    const saved = await taskFlow.get("flow-1");
    vi.mocked(taskFlow.get).mockResolvedValue(saved && { ...saved, ...change });
    const runner = createRunner({ ok: true, status: "ok", output: [], requiresApproval: null });
    expectManagedFlowFailure(
      await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner)),
    );
    expect(runner.run).not.toHaveBeenCalled();
    expect(taskFlow.resume).not.toHaveBeenCalled();
  });

  it("resumes the flow and finishes it on success", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner = createRunner({
      ok: true,
      status: "ok",
      output: [],
      requiresApproval: null,
    });

    const result = await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner));

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

  it("continues an existing blocked approval checkpoint", async () => {
    const taskFlow = createFakeTaskFlow();
    const saved = await taskFlow.get("flow-1");
    if (!saved) {
      throw new Error("Expected a saved approval checkpoint");
    }
    vi.mocked(taskFlow.get).mockResolvedValueOnce({ ...saved, status: "blocked" });
    const runner = createRunner({ ok: true, status: "ok", output: [], requiresApproval: null });

    const result = await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner));

    expect(result.ok).toBe(true);
    expect(runner.run).toHaveBeenCalledOnce();
    expect(taskFlow.finish).toHaveBeenCalledWith({ flowId: "flow-1", expectedRevision: 5 });
  });

  it.each([
    { type: "parse_error", message: "Response does not match the saved schema", waiting: true },
    { type: "parse_error", message: 'Approval ID "deadbeef" not found or expired', waiting: true },
    { type: "runtime_error", message: "Execution failed after dispatch", waiting: false },
  ])("preserves the dependency error and settles $type safely: $message", async (failure) => {
    const taskFlow = createFakeTaskFlow();
    const saved = await taskFlow.get("flow-1");
    const runner = createRunner({
      ok: false,
      error: { type: failure.type, message: failure.message },
    });

    const result = expectManagedFlowFailure(
      await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner)),
    );

    expect(result.error.message).toBe(failure.message);
    expect(result.flow?.status).toBe(failure.waiting ? "waiting" : "failed");
    expect(runner.run).toHaveBeenCalledOnce();
    if (failure.waiting) {
      expect(taskFlow.setWaiting).toHaveBeenCalledWith({
        flowId: "flow-1",
        expectedRevision: 5,
        currentStep: saved?.currentStep,
        waitJson: saved?.waitJson,
      });
      expect(taskFlow.fail).not.toHaveBeenCalled();
    } else {
      expect(taskFlow.fail).toHaveBeenCalledWith({ flowId: "flow-1", expectedRevision: 5 });
      expect(taskFlow.setWaiting).not.toHaveBeenCalled();
    }
  });

  it("returns a mutation error when taskFlow resume is rejected", async () => {
    const taskFlow = createFakeTaskFlow({
      resume: vi.fn().mockResolvedValue({
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

    const result = expectManagedFlowFailure(
      await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner)),
    );
    expect(result.error.message).toMatch(/revision_conflict/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("fails the resumed flow when the runner throws", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner: LobsterRunner = {
      run: vi.fn().mockRejectedValue(new Error("crashed")),
    };

    const result = expectManagedFlowFailure(
      await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner)),
    );

    expect(result.error.message).toBe("crashed");
    expect(taskFlow.fail).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 5,
    });
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

    const result = await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner));

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
        cwd: process.cwd(),
      },
    });
  });
});

describe("inspectManagedLobsterFlows", () => {
  it.each(["waiting", "blocked"] as const)(
    "lists live %s checkpoints without ended or cancelled waits",
    async (status) => {
      const taskFlow = createFakeTaskFlow();
      const saved = await taskFlow.get("flow-1");
      if (!saved) {
        throw new Error("Expected a saved approval checkpoint");
      }
      vi.mocked(taskFlow.list).mockResolvedValue([
        { ...saved, status },
        { ...saved, status, flowId: "ended", endedAt: 10 },
        { ...saved, status, flowId: "cancelled", cancelRequestedAt: 10 },
      ]);

      const result = await inspectManagedLobsterFlows(taskFlow);

      if (!("flows" in result)) {
        throw new Error("Expected a pending-flow list");
      }
      expect(result.flows.map((flow) => flow.flowId)).toEqual(["flow-1"]);
    },
  );
});

describe("cancelled managed Lobster flows", () => {
  it.each(["run", "resume"])(
    "persists a cancelled TaskFlow for a rejected Lobster %s",
    async (action) => {
      const legacy = createRuntimeTaskFlow().bindSession({
        sessionKey: `agent:main:lobster-cancel-${action}`,
      });
      const taskFlow: BoundTaskFlow = {
        get: async (id) => legacy.get(id),
        list: async () => legacy.list(),
        tryCreateManaged: async (params) => legacy.tryCreateManaged(params),
        resume: async (params) => legacy.resume(params),
        setWaiting: async (params) => legacy.setWaiting(params),
        finish: async (params) => legacy.finish(params),
        fail: async (params) => legacy.fail(params),
        cancel: legacy.cancel,
      };
      const runner = createRunner({
        ok: true,
        status: "cancelled",
        output: [],
        requiresApproval: null,
      });
      let result;
      if (action === "run") {
        result = await runManagedLobsterFlow(createRunFlowParams(taskFlow, runner));
      } else {
        const waitingFlow = legacy.createManaged({
          controllerId: "tests/lobster",
          goal: "Resume Lobster workflow",
          status: "waiting",
          waitJson: {
            kind: "lobster_approval",
            prompt: "Continue?",
            items: [],
            resumeToken: "resume-1",
          },
        });
        result = await resumeManagedLobsterFlow({
          ...createResumeFlowParams(taskFlow, runner),
          flowId: waitingFlow.flowId,
          expectedRevision: waitingFlow.revision,
        });
      }

      if (!result.ok) {
        throw result.error;
      }
      expect(result.flow.status).toBe("cancelled");
      expect(legacy.get(result.flow.flowId)?.status).toBe("cancelled");
    },
  );

  it.each(["unsettled", "rejected"])(
    "does not finish or fail when TaskFlow cancellation is %s",
    async (outcome) => {
      const cancel =
        outcome === "unsettled"
          ? vi.fn().mockResolvedValue({
              found: true,
              cancelled: false,
              reason: "One or more child tasks are still active.",
              tasks: [],
            })
          : vi.fn().mockRejectedValue(new Error("cancel transport error"));
      const taskFlow = createFakeTaskFlow({ cancel });
      const runner = createRunner({
        ok: true,
        status: "cancelled",
        output: [],
        requiresApproval: null,
      });

      const result = expectManagedFlowFailure(
        await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner)),
      );

      expect(result.error.message).toMatch(/cancellation failed|cancel transport error/u);
      expect(taskFlow.finish).not.toHaveBeenCalled();
      expect(taskFlow.fail).not.toHaveBeenCalled();
    },
  );
});
