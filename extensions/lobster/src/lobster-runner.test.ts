import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunnerParams,
} from "./lobster-runner.js";

type RuntimeLoader = NonNullable<
  NonNullable<Parameters<typeof createEmbeddedLobsterRunner>[0]>["loadRuntime"]
>;
type Runtime = Awaited<ReturnType<RuntimeLoader>>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const success = {
  ok: true,
  protocolVersion: 1,
  status: "ok" as const,
  output: [],
  requiresApproval: null,
};

function createRunner() {
  const runtime = {
    decodeResumeToken: vi.fn<Runtime["decodeResumeToken"]>(),
    runToolRequest: vi.fn<Runtime["runToolRequest"]>(),
    resumeToolRequest: vi.fn<Runtime["resumeToolRequest"]>(),
  };
  const loadRuntime = vi.fn<RuntimeLoader>().mockResolvedValue(runtime);
  return { runtime, loadRuntime, runner: createEmbeddedLobsterRunner({ loadRuntime }) };
}

function runParams(overrides: Partial<LobsterRunnerParams> = {}): LobsterRunnerParams {
  return {
    action: "run",
    pipeline: "exec --json=true echo hi",
    cwd: process.cwd(),
    timeoutMs: 2000,
    maxStdoutBytes: 4096,
    ...overrides,
  };
}

async function createWorkflow(name = "workflow.lobster") {
  const cwd = tempDirs.make("openclaw-lobster-runner-");
  const filePath = path.join(cwd, name);
  await fs.writeFile(filePath, "steps: []\n", "utf8");
  return { cwd, filePath };
}

const toolContext = (cwd = process.cwd()) =>
  expect.objectContaining({ cwd, mode: "tool", signal: expect.any(AbortSignal) });

describe("resolveLobsterCwd", () => {
  it("keeps relative paths inside the repo root", () => {
    expect(resolveLobsterCwd("extensions/lobster")).toBe(
      path.resolve(process.cwd(), "extensions/lobster"),
    );
  });
});

describe("createEmbeddedLobsterRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs inline pipelines with file-like arguments through the embedded runtime", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue({ ...success, output: [{ hello: "world" }] });
    const pipeline = "exec --json=true cat data.json";

    const envelope = await runner.run(runParams({ pipeline }));

    expect(runtime.runToolRequest).toHaveBeenCalledExactlyOnceWith({
      pipeline,
      ctx: toolContext(),
    });
    expect(runtime.runToolRequest.mock.calls[0]?.[0].filePath).toBeUndefined();
    expect(envelope).toEqual({
      ok: true,
      status: "ok",
      output: [{ hello: "world" }],
      requiresApproval: null,
    });
  });

  it("detects workflow files with spaces and parses argsJson", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue(success);
    const { cwd, filePath } = await createWorkflow("daily inbox.lobster");

    await runner.run(runParams({ pipeline: "daily inbox.lobster", argsJson: '{"limit":3}', cwd }));

    expect(runtime.runToolRequest).toHaveBeenCalledExactlyOnceWith({
      filePath,
      args: { limit: 3 },
      ctx: toolContext(cwd),
    });
    expect(runtime.runToolRequest.mock.calls[0]?.[0].pipeline).toBeUndefined();
  });

  it("surfaces missing workflow path errors", async () => {
    const { runtime, runner } = createRunner();
    const cwd = tempDirs.make("openclaw-lobster-runner-");

    await expect(runner.run(runParams({ pipeline: "missing.lobster", cwd }))).rejects.toMatchObject(
      {
        code: "ENOENT",
        path: path.join(cwd, "missing.lobster"),
      },
    );
    expect(runtime.runToolRequest).not.toHaveBeenCalled();
  });

  it("returns a parse error when workflow args are invalid JSON", async () => {
    const { runtime, runner } = createRunner();
    const { cwd } = await createWorkflow();

    await expect(
      runner.run(runParams({ pipeline: "workflow.lobster", argsJson: "{bad", cwd })),
    ).rejects.toThrow("run --args-json must be valid JSON");
    expect(runtime.runToolRequest).not.toHaveBeenCalled();
  });

  it("throws when the embedded runtime returns an error envelope", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue({
      ok: false,
      error: { message: "boom" },
    });

    await expect(runner.run(runParams())).rejects.toThrow("boom");
  });

  it.each(["complete", "resumeToken", "prompt", "responseSchema"])(
    "validates the dependency input checkpoint (%s)",
    async (checkpoint) => {
      const { runtime, runner } = createRunner();
      const requiresInput = {
        prompt: "Need more data",
        responseSchema: { type: "string" },
        resumeToken: "input-checkpoint",
        defaults: "draft",
        subject: { title: "Review" },
      };
      if (checkpoint !== "complete") {
        // The dependency can return a malformed checkpoint despite its declared type.
        Reflect.deleteProperty(requiresInput, checkpoint);
      }
      runtime.runToolRequest.mockResolvedValue({
        ...success,
        status: "needs_input",
        requiresInput,
      });

      const result = runner.run(runParams());
      if (checkpoint !== "complete") {
        await expect(result).rejects.toThrow("Lobster returned an incomplete input checkpoint");
        return;
      }
      await expect(result).resolves.toEqual({
        ok: true,
        status: "needs_input",
        output: [],
        requiresApproval: null,
        requiresInput: { type: "input_request", ...requiresInput },
      });
    },
  );

  it.each([
    { label: "approval", decision: { approve: false }, expected: { approved: false } },
    { label: "false input", decision: { response: false }, expected: { response: false } },
    { label: "null input", decision: { response: null }, expected: { response: null } },
    { label: "cancellation", decision: { cancel: true }, expected: { cancel: true } },
  ])("routes $label resume through the embedded runtime", async ({ decision, expected }) => {
    const { runtime, runner } = createRunner();
    runtime.resumeToolRequest.mockResolvedValue({ ...success, status: "cancelled" });

    const envelope = await runner.run(
      runParams({ action: "resume", pipeline: undefined, token: "resume-token", ...decision }),
    );

    expect(runtime.decodeResumeToken).toHaveBeenCalledTimes("response" in decision ? 1 : 0);
    expect(runtime.resumeToolRequest).toHaveBeenCalledExactlyOnceWith({
      token: "resume-token",
      ...expected,
      ctx: toolContext(),
    });
    expect(envelope).toEqual({
      ok: true,
      status: "cancelled",
      output: [],
      requiresApproval: null,
    });
  });

  it.each([undefined, "approval-id"])(
    "validates the response token only when it is used (approvalId=%s)",
    async (approvalId) => {
      const { runtime, runner } = createRunner();
      const failure = new Error("Invalid token");
      runtime.decodeResumeToken.mockImplementation(() => {
        throw failure;
      });
      runtime.resumeToolRequest.mockResolvedValue(success);
      const result = runner.run(
        runParams({
          action: "resume",
          pipeline: undefined,
          token: "invalid-token",
          approvalId,
          response: false,
        }),
      );
      if (approvalId) {
        await expect(result).resolves.toMatchObject({ ok: true });
        expect(runtime.decodeResumeToken).not.toHaveBeenCalled();
        expect(runtime.resumeToolRequest).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toBe(failure);
        expect(runtime.decodeResumeToken).toHaveBeenCalledExactlyOnceWith("invalid-token");
        expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
      }
    },
  );

  it("forwards approvalId through resume when token is absent", async () => {
    const { runtime, runner } = createRunner();
    runtime.resumeToolRequest.mockResolvedValue(success);

    await runner.run(
      runParams({ action: "resume", pipeline: undefined, approvalId: "dbc98d05", approve: true }),
    );

    expect(runtime.resumeToolRequest).toHaveBeenCalledExactlyOnceWith({
      approvalId: "dbc98d05",
      approved: true,
      ctx: toolContext(),
    });
  });

  it("passes approvalId through the normalized needs_approval envelope", async () => {
    const { runtime, runner } = createRunner();
    const approval = { prompt: "ok?", items: [], resumeToken: "eyJ...", approvalId: "dbc98d05" };
    runtime.runToolRequest.mockResolvedValue({
      ...success,
      status: "needs_approval",
      requiresApproval: approval,
    });

    expect(await runner.run(runParams())).toEqual({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: { type: "approval_request", ...approval },
    });
  });

  it("loads the embedded runtime once per runner", async () => {
    const { runtime, loadRuntime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue(success);
    runtime.resumeToolRequest.mockResolvedValue({ ...success, status: "cancelled" });

    await runner.run(runParams());
    await runner.run(
      runParams({ action: "resume", pipeline: undefined, token: "resume-token", approve: false }),
    );

    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });

  it("loads the published package core runtime", async () => {
    await expect(
      createEmbeddedLobsterRunner().run(
        runParams({ pipeline: "commands.list", maxStdoutBytes: 512_000 }),
      ),
    ).resolves.toMatchObject({ ok: true, status: "ok" });
  });

  it("requires a pipeline for run", async () => {
    const { runner } = createRunner();

    await expect(runner.run(runParams({ pipeline: undefined }))).rejects.toThrow(
      /pipeline required/,
    );
  });

  it.each([
    { label: "credential", decision: { approve: true }, error: "token or approvalId required" },
    { label: "decision", decision: { token: "resume-token" }, error: "Exactly one" },
    {
      label: "approval and input",
      decision: { token: "resume-token", approve: false, response: null },
      error: "Exactly one",
    },
    {
      label: "input and cancel",
      decision: { token: "resume-token", response: false, cancel: true },
      error: "Exactly one",
    },
    {
      label: "approval and cancel",
      decision: { token: "resume-token", approve: true, cancel: true },
      error: "Exactly one",
    },
  ])("rejects invalid resume $label before dispatch", async ({ decision, error }) => {
    const { runtime, runner } = createRunner();

    await expect(
      runner.run(runParams({ action: "resume", pipeline: undefined, ...decision })),
    ).rejects.toThrow(error);
    expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
  });

  it("rechecks the managed claim after runtime loading before dispatch", async () => {
    const { runtime, loadRuntime, runner } = createRunner();
    const loaded = createDeferred<Runtime>();
    loadRuntime.mockReturnValueOnce(loaded.promise);
    let claimActive = true;
    const beforeExecute = vi.fn(() => {
      if (!claimActive) {
        throw new Error("Flow claim was cancelled");
      }
    });
    const result = runner.run(
      runParams({
        action: "resume",
        pipeline: undefined,
        token: "resume-token",
        response: null,
        beforeExecute,
      }),
    );
    try {
      expect(beforeExecute).not.toHaveBeenCalled();
      claimActive = false;
      loaded.resolve(runtime);
      await expect(result).rejects.toThrow("Flow claim was cancelled");
      expect(beforeExecute).toHaveBeenCalledOnce();
      expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
    } finally {
      claimActive = false;
      loaded.resolve(runtime);
      await Promise.allSettled([result]);
    }
  });

  it.each(["inline", "workflow", "resume"])(
    "awaits the managed claim before an embedded %s request and honors cancellation while waiting",
    async (requestKind) => {
      const { runtime, runner } = createRunner();
      const entered = createDeferred<void>();
      const claim = createDeferred<void>();
      const controller = new AbortController();
      const { cwd, filePath } = await createWorkflow();
      const request: Partial<LobsterRunnerParams> =
        requestKind === "resume"
          ? { action: "resume", pipeline: undefined, token: "resume-token", approve: true }
          : { pipeline: requestKind === "workflow" ? filePath : "commands.list" };
      const result = runner.run(
        runParams({
          ...request,
          cwd,
          signal: controller.signal,
          beforeExecute: async () => {
            entered.resolve();
            await claim.promise;
          },
        }),
      );
      try {
        await Promise.race([entered.promise, result]);
        expect(runtime.runToolRequest).not.toHaveBeenCalled();
        expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
        controller.abort(new Error("Caller cancelled while reading claim"));
        claim.resolve();
        await expect(result).rejects.toThrow("Caller cancelled while reading claim");
        expect(runtime.runToolRequest).not.toHaveBeenCalled();
        expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        claim.resolve();
        await Promise.allSettled([result]);
      }
    },
  );

  it("refuses dispatch when an asynchronous managed claim rejects", async () => {
    const { runtime, runner } = createRunner();
    await expect(
      runner.run(
        runParams({
          action: "resume",
          pipeline: undefined,
          token: "resume-token",
          approve: true,
          beforeExecute: async () => {
            await Promise.resolve();
            throw new Error("Claim no longer active");
          },
        }),
      ),
    ).rejects.toThrow("Claim no longer active");
    expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
  });

  it("aborts long-running embedded work", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockImplementation(
      async ({ ctx }) =>
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve(success), 500);
          ctx?.signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(
              toLintErrorObject(ctx.signal?.reason ?? new Error("aborted"), "Non-Error rejection"),
            );
          });
        }),
    );

    await expect(runner.run(runParams({ timeoutMs: 200 }))).rejects.toThrow(/timed out|aborted/);
  });
});
