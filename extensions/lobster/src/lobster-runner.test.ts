import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
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
    runToolRequest: vi.fn<Runtime["runToolRequest"]>(),
    resumeToolRequest: vi.fn<Runtime["resumeToolRequest"]>(),
  };
  const loadRuntime = vi.fn().mockResolvedValue(runtime);
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

  it("bounds the model-visible result for an embedded workflow request", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue({
      ...success,
      output: Array.from({ length: 115 }, () => ({ a: 1 })),
    });
    const { cwd, filePath } = await createWorkflow();

    await expect(
      runner.run(runParams({ pipeline: filePath, cwd, maxStdoutBytes: 1024 })),
    ).rejects.toThrow("lobster runtime result exceeded maxStdoutBytes");
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

  it("fails closed when the embedded runtime requests unsupported input", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue({ ...success, status: "needs_input" });

    await expect(runner.run(runParams())).rejects.toThrow(
      "Lobster input requests are not supported by the OpenClaw Lobster tool yet",
    );
  });

  it("routes resume through the embedded runtime", async () => {
    const { runtime, runner } = createRunner();
    runtime.resumeToolRequest.mockResolvedValue({ ...success, status: "cancelled" });

    const envelope = await runner.run(
      runParams({ action: "resume", pipeline: undefined, token: "resume-token", approve: false }),
    );

    expect(runtime.resumeToolRequest).toHaveBeenCalledExactlyOnceWith({
      token: "resume-token",
      approved: false,
      ctx: toolContext(),
    });
    expect(envelope).toEqual({
      ok: true,
      status: "cancelled",
      output: [],
      requiresApproval: null,
    });
  });

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

  it("requires token and approve for resume", async () => {
    const { runner } = createRunner();

    await expect(
      runner.run(runParams({ action: "resume", pipeline: undefined, approve: true })),
    ).rejects.toThrow(/token or approvalId required/);
    await expect(
      runner.run(runParams({ action: "resume", pipeline: undefined, token: "resume-token" })),
    ).rejects.toThrow(/approve required/);
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
