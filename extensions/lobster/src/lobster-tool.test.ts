import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRuntimeMock,
  createRuntimeTaskFlow,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
// Lobster tests cover lobster tool plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../runtime-api.js";
import * as lobsterRunner from "./lobster-runner.js";
import type { BoundTaskFlow } from "./lobster-taskflow.js";
import { createLobsterTool } from "./lobster-tool.js";
import { createFakeTaskFlow } from "./taskflow-test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "lobster",
    name: "lobster",
    source: "test",
    runtime: { version: "test" } as OpenClawPluginApi["runtime"],
    resolvePath: (p) => p,
    ...overrides,
  });
}

function fakeCtx(overrides: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext {
  return {
    config: {},
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    agentId: "main",
    sessionKey: "main",
    messageChannel: undefined,
    agentAccountId: undefined,
    sandboxed: false,
    ...overrides,
  };
}

const requireRecord = createRequireRecord("record", "expected-label-record");

describe("lobster plugin tool", () => {
  it("propagates uncertain registered creation without retrying or starting its runner", async () => {
    const runtime = createPluginRuntimeMock();
    const ctx = fakeCtx();
    const bound = runtime.tasks.async.managedFlows.fromToolContext(ctx);
    const legacy = runtime.tasks.managedFlows.fromToolContext(ctx);
    const lost = Object.assign(new Error("Worker reply was lost"), { code: "outcome-unknown" });
    const failure = new AggregateError(
      [new Error("Cleanup failed")],
      "Creation outcome is unknown",
      { cause: lost },
    );
    vi.mocked(bound.tryCreateManaged).mockRejectedValue(failure);
    vi.mocked(runtime.tasks.async.managedFlows.fromToolContext).mockReturnValue(bound);
    vi.mocked(runtime.tasks.managedFlows.fromToolContext).mockReturnValue(legacy);
    const runner = { run: vi.fn<lobsterRunner.LobsterRunner["run"]>() };
    const runnerFactory = vi
      .spyOn(lobsterRunner, "createEmbeddedLobsterRunner")
      .mockReturnValue(runner);
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    try {
      plugin.register(fakeApi({ runtime, registerTool }));
      const factory = registerTool.mock.calls[0]?.[0];
      if (typeof factory !== "function") {
        throw new Error("Expected the registered Lobster tool factory");
      }
      const tool = factory(ctx);
      if (!tool || Array.isArray(tool)) {
        throw new Error("Expected a bound Lobster tool");
      }
      await expect(
        tool.execute("uncertain-create", {
          action: "run",
          pipeline: "noop",
          flowControllerId: "tests/lobster",
          flowGoal: "Synthetic uncertain flow",
        }),
      ).rejects.toBe(failure);
      expect(bound.tryCreateManaged).toHaveBeenCalledTimes(1);
      expect(bound.createManaged).not.toHaveBeenCalled();
      expect(legacy.tryCreateManaged).not.toHaveBeenCalled();
      expect(legacy.createManaged).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
    } finally {
      runnerFactory.mockRestore();
    }
  });

  it.each(["run", "resume"] as const)(
    "awaits persistence before and after a registered managed %s",
    async (action) => {
      const runtime = createPluginRuntimeMock();
      const ctx = fakeCtx();
      const bound = runtime.tasks.async.managedFlows.fromToolContext(ctx);
      const taskFlow = createFakeTaskFlow();
      const admitted = createDeferred<void>();
      const admissionEntered = createDeferred<void>();
      const completed = createDeferred<void>();
      const completionEntered = createDeferred<void>();
      const create = taskFlow.tryCreateManaged;
      taskFlow.tryCreateManaged = vi.fn(async (params) => {
        admissionEntered.resolve();
        await admitted.promise;
        return create(params);
      });
      const resume = taskFlow.resume;
      taskFlow.resume = vi.fn(async (params) => {
        admissionEntered.resolve();
        await admitted.promise;
        return resume(params);
      });
      const finish = taskFlow.finish;
      taskFlow.finish = vi.fn(async (params) => {
        completionEntered.resolve();
        await completed.promise;
        return finish(params);
      });
      vi.mocked(runtime.tasks.async.managedFlows.fromToolContext).mockReturnValue({
        ...bound,
        ...taskFlow,
      });
      const runner = {
        run: vi.fn<lobsterRunner.LobsterRunner["run"]>().mockResolvedValue({
          ok: true,
          status: "ok",
          output: [],
          requiresApproval: null,
        }),
      };
      const runnerFactory = vi
        .spyOn(lobsterRunner, "createEmbeddedLobsterRunner")
        .mockReturnValue(runner);
      const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
      let execution: Promise<unknown> | undefined;
      try {
        plugin.register(fakeApi({ runtime, registerTool }));
        const factory = registerTool.mock.calls[0]?.[0];
        if (typeof factory !== "function") {
          throw new Error("Expected the registered Lobster tool factory");
        }
        const tool = factory(ctx);
        if (!tool || Array.isArray(tool)) {
          throw new Error("Expected a bound Lobster tool");
        }
        let settled = false;
        execution = Promise.resolve(
          tool.execute(
            "managed-registered",
            action === "run"
              ? {
                  action,
                  pipeline: "noop",
                  flowControllerId: "tests/lobster",
                  flowGoal: "Synthetic flow",
                }
              : {
                  action,
                  token: "resume-1",
                  approve: true,
                  flowId: "flow-1",
                  flowExpectedRevision: 4,
                },
          ),
        ).finally(() => {
          settled = true;
        });
        await Promise.race([admissionEntered.promise, execution]);
        expect(runner.run).not.toHaveBeenCalled();
        admitted.resolve();
        await Promise.race([completionEntered.promise, execution]);
        expect(runner.run).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        completed.resolve();
        expect(await execution).toMatchObject({
          details: { ok: true, mutation: { applied: true, flow: { status: "succeeded" } } },
        });
      } finally {
        admitted.resolve();
        completed.resolve();
        await Promise.allSettled([execution]);
        runnerFactory.mockRestore();
      }
    },
  );

  it("returns the Lobster envelope in details", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [{ hello: "world" }],
        requiresApproval: null,
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call1", {
      action: "run",
      pipeline: "noop",
      timeoutMs: 1000,
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 1000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("ok");
    expect(details.output).toEqual([{ hello: "world" }]);
    expect(details.requiresApproval).toBeNull();
  });

  it("supports approval envelopes without changing the tool contract", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Send these alerts?",
          items: [{ id: "alert-1" }],
          resumeToken: "resume-token-1",
        },
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call-injected-runner", {
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      cwd: process.cwd(),
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });
    const details = requireRecord(res.details, "approval lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("needs_approval");
    const approval = requireRecord(details.requiresApproval, "approval request");
    expect(approval.type).toBe("approval_request");
    expect(approval.prompt).toBe("Send these alerts?");
    expect(approval.resumeToken).toBe("resume-token-1");
  });

  it("keeps ordinary run on the runner for neutral flow defaults and ignores resume credentials", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Continue?",
          items: [],
          resumeToken: "resume-token-1",
        },
      }),
    };
    const taskFlow = createFakeTaskFlow();

    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });
    const res = await tool.execute("call-default-flow-run", {
      action: "run",
      pipeline: "noop",
      token: 42,
      approve: "yes",
      flowControllerId: " ",
      flowGoal: "",
      flowStateJson: "{}",
      flowId: " ",
      flowExpectedRevision: "0",
      flowCurrentStep: "",
      flowWaitingStep: " ",
    });

    expect(taskFlow.tryCreateManaged).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "ordinary run with flow defaults details");
    expect(details.status).toBe("needs_approval");
  });

  it.each([{ flowId: "flow-1" }, { flowExpectedRevision: 1 }])(
    "rejects resume-only fields on run before the ordinary fallback",
    async (resumeFields) => {
      const runner = { run: vi.fn() };
      const tool = createLobsterTool(fakeApi(), {
        runner,
        taskFlow: createFakeTaskFlow(),
      });

      await expect(
        tool.execute("call-run-with-resume-fields", {
          action: "run",
          pipeline: "noop",
          flowStateJson: "{}",
          flowExpectedRevision: 0,
          ...resumeFields,
        }),
      ).rejects.toThrow(/run action does not accept flowId or flowExpectedRevision/);
      expect(runner.run).not.toHaveBeenCalled();
    },
  );

  it("keeps ordinary resume on the runner for neutral flow defaults", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [{ approved: true }],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow();

    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });
    const res = await tool.execute("call-default-flow-resume", {
      action: "resume",
      token: "resume-token-1",
      approve: true,
      flowControllerId: " ",
      flowGoal: "",
      flowStateJson: "{}",
      flowId: " ",
      flowExpectedRevision: "0",
      flowCurrentStep: "",
      flowWaitingStep: " ",
    });

    expect(taskFlow.resume).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledWith({
      action: "resume",
      token: "resume-token-1",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "ordinary resume with flow defaults details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("ok");
  });

  it("rejects malformed resume credentials before ordinary fallback", async () => {
    const runner = { run: vi.fn() };
    const tool = createLobsterTool(fakeApi(), { runner });

    await expect(
      tool.execute("call-ordinary-resume-invalid-credentials", {
        action: "resume",
        token: 42,
        approve: "yes",
      }),
    ).rejects.toThrow("token must be a string");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each([
    { flowControllerId: "tests/lobster" },
    { flowGoal: "Run Lobster workflow" },
    { flowStateJson: '{"lane":"email"}' },
  ])("rejects run-only fields on resume before the ordinary fallback", async (runFields) => {
    const runner = { run: vi.fn() };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-resume-with-run-fields", {
        action: "resume",
        token: "resume-token-1",
        approve: true,
        flowExpectedRevision: 0,
        ...runFields,
      }),
    ).rejects.toThrow(/resume action does not accept flowControllerId, flowGoal, or flowStateJson/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each([
    [
      { action: "run", flowCurrentStep: "run_lobster" },
      "flowControllerId required when using managed TaskFlow run mode",
    ],
    [
      { action: "run", flowWaitingStep: "await_review" },
      "flowControllerId required when using managed TaskFlow run mode",
    ],
    [
      { action: "run", flowControllerId: "tests/lobster" },
      "flowGoal required when using managed TaskFlow run mode",
    ],
    [
      { action: "resume", token: "resume-token-1", approve: true, flowExpectedRevision: 1 },
      "flowId required when using managed TaskFlow resume mode",
    ],
    [
      { action: "resume", token: "resume-token-1", approve: true, flowId: "flow-1" },
      "flowExpectedRevision required when using managed TaskFlow resume mode",
    ],
    [
      {
        action: "resume",
        token: "resume-token-1",
        approve: true,
        flowCurrentStep: "resume_lobster",
      },
      "flowId required when using managed TaskFlow resume mode",
    ],
    [
      { action: "resume", token: "resume-token-1", approve: true, flowWaitingStep: "await_review" },
      "flowId required when using managed TaskFlow resume mode",
    ],
    [
      { action: "resume", token: "resume-token-1", flowId: "flow-1", flowExpectedRevision: 1 },
      "approve required when using managed TaskFlow resume mode",
    ],
  ])("requires managed TaskFlow fields", async (params, error) => {
    const runner = { run: vi.fn() };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      taskFlow: createFakeTaskFlow(),
    });

    await expect(tool.execute("call-missing-managed-field", params)).rejects.toThrow(error);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each([
    [
      { action: "run", flowControllerId: 42, flowId: "flow-1" },
      "flowControllerId must be a string",
    ],
    [{ action: "resume", token: 42, flowControllerId: "tests/lobster" }, "token must be a string"],
  ])("preserves mixed-invalid field error precedence", async (params, error) => {
    const runner = { run: vi.fn() };
    const tool = createLobsterTool(fakeApi(), {
      runner,
      taskFlow: createFakeTaskFlow(),
    });

    await expect(tool.execute("call-mixed-invalid-fields", params)).rejects.toThrow(error);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("normalizes numeric string run limits before invoking the runner", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    await tool.execute("call-string-limits", {
      action: "run",
      pipeline: "noop",
      timeoutMs: "1500",
      maxStdoutBytes: "4096",
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });
  });

  it("rejects malformed numeric run limits before invoking the runner", async () => {
    const runner = { run: vi.fn() };
    const tool = createLobsterTool(fakeApi(), { runner });

    await expect(
      tool.execute("call-bad-timeout", {
        action: "run",
        pipeline: "noop",
        timeoutMs: "1500.5",
      }),
    ).rejects.toThrow("timeoutMs must be a positive integer");
    await expect(
      tool.execute("call-bad-stdout", {
        action: "run",
        pipeline: "noop",
        maxStdoutBytes: 0,
      }),
    ).rejects.toThrow("maxStdoutBytes must be a positive integer");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("throws when the runner returns an error envelope", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: {
        run: vi.fn().mockResolvedValue({
          ok: false,
          error: {
            type: "runtime_error",
            message: "boom",
          },
        }),
      },
    });

    await expect(
      tool.execute("call-runner-error", {
        action: "run",
        pipeline: "noop",
      }),
    ).rejects.toThrow("boom");
  });

  it("can run through managed TaskFlow mode", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Approve this?",
          items: [{ id: "item-1" }],
          resumeToken: "resume-1",
          approvalId: "approval-1",
        },
      }),
    };
    const taskFlow = createFakeTaskFlow();

    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });
    const res = await tool.execute("call-managed-run", {
      action: "run",
      pipeline: "noop",
      flowControllerId: "tests/lobster",
      flowGoal: "Run Lobster workflow",
      flowStateJson: '{"lane":"email"}',
      flowExpectedRevision: 0,
      flowCurrentStep: "run_lobster",
      flowWaitingStep: "await_review",
    });

    expect(taskFlow.tryCreateManaged).toHaveBeenCalledWith({
      controllerId: "tests/lobster",
      goal: "Run Lobster workflow",
      currentStep: "run_lobster",
      stateJson: { lane: "email" },
    });
    expect(taskFlow.setWaiting).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
      currentStep: "await_review",
      waitJson: {
        kind: "lobster_approval",
        prompt: "Approve this?",
        items: [{ id: "item-1" }],
        resumeToken: "resume-1",
        approvalId: "approval-1",
      },
    });
    const details = requireRecord(res.details, "managed run lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("needs_approval");
    const flow = requireRecord(details.flow, "managed run flow details");
    expect(flow.flowId).toBe("flow-1");
    const mutation = requireRecord(details.mutation, "managed run mutation details");
    expect(mutation.applied).toBe(true);
  });

  it("does not start the runner when managed creation fails to persist", async () => {
    const taskFlow = createFakeTaskFlow({ tryCreateManaged: vi.fn().mockResolvedValue(null) });
    const runner = { run: vi.fn<lobsterRunner.LobsterRunner["run"]>() };
    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });
    await expect(
      tool.execute("failed-create", {
        action: "run",
        pipeline: "noop",
        flowControllerId: "tests/lobster",
        flowGoal: "Synthetic flow",
      }),
    ).rejects.toThrow("TaskFlow persistence failed.");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("preserves explicit empty flow state in managed TaskFlow run mode", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow();

    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });
    await tool.execute("call-managed-run-empty-state", {
      action: "run",
      pipeline: "noop",
      flowControllerId: "tests/lobster",
      flowGoal: "Run Lobster workflow",
      flowStateJson: "{}",
    });

    expect(taskFlow.tryCreateManaged).toHaveBeenCalledWith({
      controllerId: "tests/lobster",
      goal: "Run Lobster workflow",
      currentStep: "run_lobster",
      stateJson: {},
    });
    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
  });

  it("rejects managed TaskFlow params when no bound taskFlow runtime is available", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });

    await expect(
      tool.execute("call-missing-taskflow", {
        action: "run",
        pipeline: "noop",
        flowControllerId: "tests/lobster",
        flowGoal: "Run Lobster workflow",
      }),
    ).rejects.toThrow(/Managed TaskFlow run mode requires a bound taskFlow runtime/);
  });

  it("rejects invalid flowStateJson in managed TaskFlow mode", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
      taskFlow: createFakeTaskFlow(),
    });

    await expect(
      tool.execute("call-invalid-flow-json", {
        action: "run",
        pipeline: "noop",
        flowControllerId: "tests/lobster",
        flowGoal: "Run Lobster workflow",
        flowStateJson: "{bad",
      }),
    ).rejects.toThrow(/flowStateJson must be valid JSON/);
  });

  it("recovers a saved approval in the owning session without replaying completed work", async () => {
    function bind(sessionKey: string): BoundTaskFlow {
      const owner = createRuntimeTaskFlow().bindSession({ sessionKey });
      return {
        get: async (id) => owner.get(id),
        tryCreateManaged: async (input) => owner.tryCreateManaged(input),
        resume: async (input) => owner.resume(input),
        setWaiting: async (input) => owner.setWaiting(input),
        finish: async (input) => owner.finish(input),
        fail: async (input) => owner.fail(input),
        cancel: owner.cancel,
      };
    }
    vi.stubEnv("LOBSTER_STATE_DIR", tempDirs.make("openclaw-lobster-checkpoint-"));
    const runner = lobsterRunner.createEmbeddedLobsterRunner();
    vi.spyOn(runner, "run");
    const sessionKey = "agent:main:lobster-checkpoint-recovery";
    const first = createLobsterTool(fakeApi(), { runner, taskFlow: bind(sessionKey) });
    const started = await first.execute("start", {
      action: "run",
      pipeline: "skills/taskflow/examples/inbox-triage.lobster",
      flowControllerId: "tests/checkpoint",
      flowGoal: "Prepare and accept a result",
    });
    const details = requireRecord(started.details, "checkpoint start");
    const mutation = requireRecord(details.mutation, "checkpoint mutation");
    const saved = requireRecord(mutation.flow, "saved checkpoint");
    const wait = requireRecord(saved.waitJson, "saved approval");
    const input = {
      action: "resume",
      approve: true,
      flowId: saved.flowId,
      flowExpectedRevision: saved.revision,
    };
    const stranger = createLobsterTool(fakeApi(), { runner, taskFlow: bind("agent:main:other") });
    await expect(stranger.execute("wrong-owner", input)).rejects.toThrow(
      "no resumable Lobster checkpoint",
    );

    const recovered = createLobsterTool(fakeApi(), { runner, taskFlow: bind(sessionKey) });
    await expect(
      recovered.execute("wrong-checkpoint", { ...input, token: "another-checkpoint" }),
    ).rejects.toThrow("does not match");
    expect(runner.run).toHaveBeenCalledTimes(1);
    const resumed = await recovered.execute("recover", input);
    expect(runner.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "resume", token: wait.resumeToken, approve: true }),
    );
    expect(requireRecord(resumed.details, "resumed workflow").output).toEqual([
      {
        synthetic: true,
        routes: {
          business: ["demo-business-1", "demo-business-2"],
          personal: ["demo-personal-1"],
          later: ["demo-later-1"],
        },
      },
    ]);
    expect(runner.run).toHaveBeenCalledTimes(2);
    await expect(recovered.execute("replay", input)).rejects.toThrow(
      "no resumable Lobster checkpoint",
    );
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("can resume managed TaskFlow revision zero with only approvalId", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow();
    const saved = await taskFlow.get("flow-1");
    vi.mocked(taskFlow.get).mockResolvedValue(saved && { ...saved, revision: 0 });
    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });

    const res = await tool.execute("call-managed-resume-approval-id", {
      action: "resume",
      approvalId: "approval-1",
      approve: true,
      flowId: "flow-1",
      flowExpectedRevision: 0,
      flowStateJson: "{}",
      flowCurrentStep: "resume_lobster",
    });

    expect(taskFlow.resume).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 0,
      status: "running",
      currentStep: "resume_lobster",
    });
    expect(runner.run).toHaveBeenCalledWith({
      action: "resume",
      approvalId: "approval-1",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "managed resume lobster tool details");
    expect(details.ok).toBe(true);
    expect(details.status).toBe("ok");
    const mutation = requireRecord(details.mutation, "managed resume mutation details");
    expect(mutation.applied).toBe(true);
  });

  it("normalizes numeric string flowExpectedRevision before managed resume", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };
    const taskFlow = createFakeTaskFlow();
    const saved = await taskFlow.get("flow-1");
    vi.mocked(taskFlow.get).mockResolvedValue(saved && { ...saved, revision: 1 });
    const tool = createLobsterTool(fakeApi(), { runner, taskFlow });

    await tool.execute("call-managed-resume-string-revision", {
      action: "resume",
      token: " resume-1 ",
      approve: true,
      flowId: "flow-1",
      flowExpectedRevision: "1",
      flowCurrentStep: "resume_lobster",
    });

    expect(taskFlow.resume).toHaveBeenCalledWith({
      flowId: "flow-1",
      expectedRevision: 1,
      status: "running",
      currentStep: "resume_lobster",
    });
    expect(runner.run).toHaveBeenCalledWith({
      action: "resume",
      token: " resume-1 ",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
  });

  it("requires action", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(tool.execute("call-action-missing", {})).rejects.toThrow(/action required/);
  });

  it("rejects unknown action", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-action-unknown", {
        action: "explode",
      }),
    ).rejects.toThrow(/Unknown action/);
  });

  it("rejects absolute cwd", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-absolute-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/cwd must be a relative path/);
  });

  it("rejects cwd that escapes the gateway working directory", async () => {
    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(
      tool.execute("call-escape-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "../../etc",
      }),
    ).rejects.toThrow(/must stay within/);
  });

  it("can be gated off in sandboxed contexts", () => {
    const api = fakeApi();
    const factoryTool = (ctx: OpenClawPluginToolContext) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api, {
        runner: { run: vi.fn() },
      });
    };

    expect(factoryTool(fakeCtx({ sandboxed: true }))).toBeNull();
    expect(factoryTool(fakeCtx({ sandboxed: false }))?.name).toBe("lobster");
  });
});
