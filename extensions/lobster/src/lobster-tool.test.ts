import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../runtime-api.js";

let createLobsterTool: typeof import("./lobster-tool.js").createLobsterTool;

type BoundTaskFlow = ReturnType<
  NonNullable<OpenClawPluginApi["runtime"]>["taskFlow"]["bindSession"]
>;

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "lobster",
    name: "lobster",
    source: "test",
    // oxlint-disable-next-line typescript/no-explicit-any
    runtime: { version: "test" } as any,
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

function createFakeTaskFlow(overrides?: Partial<BoundTaskFlow>): BoundTaskFlow {
  const baseFlow = {
    flowId: "flow-1",
    revision: 1,
    syncMode: "managed" as const,
    controllerId: "tests/lobster",
    ownerKey: "agent:main:main",
    status: "running" as const,
    goal: "Run Lobster workflow",
  };

  return {
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
}

describe("lobster plugin tool", () => {
  it("returns the Lobster envelope in details", async () => {
    ({ createLobsterTool } = await import("./lobster-tool.js"));

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
    expect(res.details).toMatchObject({
      ok: true,
      status: "ok",
      output: [{ hello: "world" }],
      requiresApproval: null,
    });
  });

  it("supports approval envelopes without changing the tool contract", async () => {
    ({ createLobsterTool } = await import("./lobster-tool.js"));

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
    expect(res.details).toMatchObject({
      ok: true,
      status: "needs_approval",
      requiresApproval: {
        type: "approval_request",
        prompt: "Send these alerts?",
        resumeToken: "resume-token-1",
      },
    });
  });

  it("throws when the runner returns an error envelope", async () => {
    ({ createLobsterTool } = await import("./lobster-tool.js"));

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
    ({ createLobsterTool } = await import("./lobster-tool.js"));

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
      flowCurrentStep: "run_lobster",
      flowWaitingStep: "await_review",
    });

    expect(taskFlow.createManaged).toHaveBeenCalledWith({
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
      },
    });
    expect(res.details).toMatchObject({
      ok: true,
      status: "needs_approval",
      flow: {
        flowId: "flow-1",
      },
      mutation: {
        applied: true,
      },
    });
  });

  it("rejects managed TaskFlow params when no bound taskFlow runtime is available", async () => {
    ({ createLobsterTool } = await import("./lobster-tool.js"));

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
    ({ createLobsterTool } = await import("./lobster-tool.js"));

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

  it("requires action", async () => {
    ({ createLobsterTool } = await import("./lobster-tool.js"));

    const tool = createLobsterTool(fakeApi(), {
      runner: { run: vi.fn() },
    });
    await expect(tool.execute("call-action-missing", {})).rejects.toThrow(/action required/);
  });

  it("rejects unknown action", async () => {
    ({ createLobsterTool } = await import("./lobster-tool.js"));

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
    ({ createLobsterTool } = await import("./lobster-tool.js"));

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
    ({ createLobsterTool } = await import("./lobster-tool.js"));

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

  it("can be gated off in sandboxed contexts", async () => {
    ({ createLobsterTool } = await import("./lobster-tool.js"));

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
