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

  it.each(
    (
      [
        { method: "finish", errorType: undefined },
        { method: "setWaiting", errorType: undefined },
        { method: "setWaiting", errorType: "parse_error" },
        { method: "fail", errorType: "runtime_error" },
      ] as const
    ).flatMap(({ method, errorType }) =>
      [false, true].map((newerClaim) => ({ method, errorType, newerClaim })),
    ),
  )(
    "settles only cancellation's successor when $method loses the result race (error: $errorType, newer claim: $newerClaim)",
    async ({ method, errorType, newerClaim }) => {
      const taskFlow = createFakeTaskFlow();
      const runner = createRunner(
        errorType
          ? { ok: false, error: { type: errorType, message: "Synthetic runtime error" } }
          : {
              ok: true,
              status: method === "finish" ? "ok" : "needs_approval",
              output: [],
              requiresApproval: {
                type: "approval_request",
                prompt: "Continue?",
                items: [],
                resumeToken: "resume-1",
              },
            },
      );
      const params = createResumeFlowParams(taskFlow, runner);
      if (errorType === "parse_error") {
        await taskFlow.setWaiting({
          flowId: "flow-1",
          expectedRevision: 4,
          waitJson: {
            kind: "lobster_input",
            prompt: "Answer?",
            responseSchema: { type: "boolean" },
            resumeToken: "resume-1",
            cwd: process.cwd(),
          },
        });
        vi.mocked(taskFlow.setWaiting).mockClear();
        params.expectedRevision = 5;
        delete params.runnerParams.approve;
        params.runnerParams.response = null;
      }
      vi.mocked(taskFlow[method]).mockImplementation(async () => {
        const claimed = await taskFlow.get("flow-1");
        if (!claimed) {
          throw new Error("Expected the active flow claim");
        }
        const successor = {
          ...claimed,
          revision: claimed.revision + (newerClaim ? 2 : 1),
          cancelRequestedAt: 10,
        };
        vi.mocked(taskFlow.get).mockResolvedValue(successor);
        vi.mocked(taskFlow.cancel).mockResolvedValue({
          found: true,
          cancelled: true,
          tasks: [],
          flow: { ...successor, status: "cancelled", endedAt: 11 },
        });
        return { applied: false, code: "revision_conflict" };
      });

      const result = expectManagedFlowFailure(await resumeManagedLobsterFlow(params));

      expect(result.error.message).toContain(
        errorType ? "Synthetic runtime error" : "do not replay the workflow",
      );
      expect(taskFlow[method]).toHaveBeenCalledOnce();
      expect(runner.run).toHaveBeenCalledOnce();
      if (method !== "fail") {
        expect(taskFlow.fail).not.toHaveBeenCalled();
      }
      if (newerClaim) {
        expect(taskFlow.cancel).not.toHaveBeenCalled();
      } else {
        expect(taskFlow.cancel).toHaveBeenCalledExactlyOnceWith({ flowId: "flow-1", cfg: {} });
        expect(result.flow?.status).toBe("cancelled");
      }
    },
  );
});

describe("resumeManagedLobsterFlow", () => {
  it.each([false, true])(
    "settles cancellation arriving during recovery claim validation (newer update: %s)",
    async (newerUpdate) => {
      const taskFlow = createFakeTaskFlow();
      const read = vi.mocked(taskFlow.get).getMockImplementation();
      if (!read) {
        throw new Error("Expected the stateful test reader");
      }
      let failed = false;
      let recoveryReads = 0;
      vi.mocked(taskFlow.get).mockImplementation(async (flowId) => {
        const current = await read(flowId);
        if (failed && ++recoveryReads >= 2 && current) {
          const successor = {
            ...current,
            revision: current.revision + (newerUpdate ? 2 : 1),
            cancelRequestedAt: 10,
          };
          vi.mocked(taskFlow.cancel).mockResolvedValue({
            found: true,
            cancelled: true,
            tasks: [],
            flow: { ...successor, status: "cancelled", endedAt: 11 },
          });
          return successor;
        }
        return current;
      });
      const runner: LobsterRunner = {
        run: vi.fn(async () => {
          failed = true;
          throw new Error("Synthetic execution failure");
        }),
      };

      const result = expectManagedFlowFailure(
        await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner)),
      );

      expect(result.error.message).toBe("Synthetic execution failure");
      expect(taskFlow.fail).not.toHaveBeenCalled();
      expect(runner.run).toHaveBeenCalledOnce();
      if (newerUpdate) {
        expect(taskFlow.cancel).not.toHaveBeenCalled();
      } else {
        expect(taskFlow.cancel).toHaveBeenCalledExactlyOnceWith({ flowId: "flow-1", cfg: {} });
        expect(result.flow?.status).toBe("cancelled");
      }
    },
  );

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
    { input: true, cancel: false, type: "parse_error", waiting: true },
    { input: true, cancel: false, type: "runtime_error", waiting: false },
    { input: true, cancel: true, type: "parse_error", waiting: false },
    { input: false, cancel: false, type: "parse_error", waiting: false },
    { input: false, cancel: false, type: "runtime_error", waiting: false },
  ])(
    "settles $type for input=$input cancel=$cancel without classifying message text",
    async (failure) => {
      const taskFlow = createFakeTaskFlow();
      if (failure.input) {
        await taskFlow.setWaiting({
          flowId: "flow-1",
          expectedRevision: 4,
          waitJson: {
            kind: "lobster_input",
            prompt: "Answer?",
            responseSchema: { type: "boolean" },
            resumeToken: "resume-1",
            cwd: process.cwd(),
          },
        });
        vi.mocked(taskFlow.setWaiting).mockClear();
      }
      const saved = await taskFlow.get("flow-1");
      const message = "Synthetic dependency failure";
      const runner = createRunner({
        ok: false,
        error: { type: failure.type, message },
      });
      const params = createResumeFlowParams(taskFlow, runner);
      params.expectedRevision = failure.input ? 5 : 4;
      if (failure.input) {
        delete params.runnerParams.approve;
        if (failure.cancel) {
          params.runnerParams.cancel = true;
        } else {
          params.runnerParams.response = null;
        }
      }

      const result = expectManagedFlowFailure(await resumeManagedLobsterFlow(params));

      expect(result.error.message).toBe(message);
      expect(result.flow?.status).toBe(failure.waiting ? "waiting" : "failed");
      expect(runner.run).toHaveBeenCalledOnce();
      if (failure.waiting) {
        expect(taskFlow.setWaiting).toHaveBeenCalledWith({
          flowId: "flow-1",
          expectedRevision: params.expectedRevision + 1,
          currentStep: saved?.currentStep,
          waitJson: saved?.waitJson,
        });
        expect(taskFlow.fail).not.toHaveBeenCalled();
      } else {
        expect(taskFlow.fail).toHaveBeenCalledWith({
          flowId: "flow-1",
          expectedRevision: params.expectedRevision + 1,
        });
        expect(taskFlow.setWaiting).not.toHaveBeenCalled();
        expect(result.flow?.waitJson).toBeNull();
      }
    },
  );

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
  it("persists a cancelled TaskFlow for a rejected Lobster resume", async () => {
    const legacy = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:lobster-cancel-resume",
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
    const result = await resumeManagedLobsterFlow({
      ...createResumeFlowParams(taskFlow, runner),
      flowId: waitingFlow.flowId,
      expectedRevision: waitingFlow.revision,
    });

    if (!result.ok) {
      throw result.error;
    }
    expect(result.flow.status).toBe("cancelled");
    expect(legacy.get(result.flow.flowId)?.status).toBe("cancelled");
  });

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
