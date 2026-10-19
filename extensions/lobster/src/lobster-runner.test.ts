import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function createWorkflow() {
  const cwd = tempDirs.make("openclaw-lobster-runner-");
  const filePath = path.join(cwd, "workflow.lobster");
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
  const runtime = {
    runToolRequest: vi.fn<Runtime["runToolRequest"]>(),
    resumeToolRequest: vi.fn<Runtime["resumeToolRequest"]>(),
  };
  const loadRuntime = vi.fn().mockResolvedValue(runtime);
  let runner: ReturnType<typeof createEmbeddedLobsterRunner>;
  const run = (overrides: Partial<LobsterRunnerParams> = {}) =>
    runner.run({
      action: "run",
      pipeline: "exec --json=true echo hi",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
      ...overrides,
    });
  beforeEach(() => {
    runtime.runToolRequest.mockReset();
    runtime.resumeToolRequest.mockReset();
    loadRuntime.mockClear();
    runner = createEmbeddedLobsterRunner({ loadRuntime });
  });
  afterEach(() => vi.restoreAllMocks());

  it("bounds the model-visible result for an embedded workflow request", async () => {
    runtime.runToolRequest.mockResolvedValue({
      ...success,
      output: Array.from({ length: 115 }, () => ({ a: 1 })),
    });
    const { cwd, filePath } = await createWorkflow();

    await expect(run({ pipeline: filePath, cwd, maxStdoutBytes: 1024 })).rejects.toThrow(
      "lobster runtime result exceeded maxStdoutBytes",
    );
  });

  it("runs inline pipelines with file-like arguments through the embedded runtime", async () => {
    runtime.runToolRequest.mockResolvedValue({ ...success, output: [{ hello: "world" }] });
    const pipeline = "exec --json=true cat data.json";

    const envelope = await run({ pipeline });

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

  it("surfaces missing workflow path errors", async () => {
    const cwd = tempDirs.make("openclaw-lobster-runner-");

    await expect(run({ pipeline: "missing.lobster", cwd })).rejects.toMatchObject({
      code: "ENOENT",
      path: path.join(cwd, "missing.lobster"),
    });
    expect(runtime.runToolRequest).not.toHaveBeenCalled();
  });

  it("returns a parse error when workflow args are invalid JSON", async () => {
    const { cwd } = await createWorkflow();

    await expect(run({ pipeline: "workflow.lobster", argsJson: "{bad", cwd })).rejects.toThrow(
      "run --args-json must be valid JSON",
    );
    expect(runtime.runToolRequest).not.toHaveBeenCalled();
  });

  it("rejects an input request without a resumable checkpoint", async () => {
    runtime.runToolRequest.mockResolvedValue({ ...success, status: "needs_input" });

    await expect(run()).rejects.toThrow("Lobster input request is missing its resume token");
  });

  it("forwards approvalId through resume when token is absent", async () => {
    runtime.resumeToolRequest.mockResolvedValue(success);

    await run({ action: "resume", pipeline: undefined, approvalId: "dbc98d05", approve: true });

    expect(runtime.resumeToolRequest).toHaveBeenCalledExactlyOnceWith({
      approvalId: "dbc98d05",
      approved: true,
      ctx: toolContext(),
    });
  });

  it("loads the embedded runtime once per runner", async () => {
    runtime.runToolRequest.mockResolvedValue(success);
    runtime.resumeToolRequest.mockResolvedValue({ ...success, status: "cancelled" });

    await run();
    await run({ action: "resume", pipeline: undefined, token: "resume-token", approve: false });

    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });

  it("requires a pipeline for run", async () => {
    await expect(run({ pipeline: undefined })).rejects.toThrow(/pipeline required/);
  });

  it("requires a checkpoint and a decision for resume", async () => {
    await expect(run({ action: "resume", approve: true })).rejects.toThrow(
      /token or approvalId required/,
    );
    await expect(run({ action: "resume", token: "resume-token" })).rejects.toThrow(/exactly one/);
  });

  it.each([{ responseJson: "{bad" }, { approve: true, responseJson: "null" }, { cancel: false }])(
    "rejects invalid or ambiguous resume arguments before touching state: %j",
    async (decision) => {
      await expect(run({ action: "resume", token: "resume-token", ...decision })).rejects.toThrow();
      expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
    },
  );

  it("aborts long-running embedded work", async () => {
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

    await expect(run({ timeoutMs: 200 })).rejects.toThrow(/timed out|aborted/);
  });
});
