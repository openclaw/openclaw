import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunnerParams,
} from "./lobster-runner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const success = {
  ok: true,
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

const ctx = expect.objectContaining({
  cwd: process.cwd(),
  mode: "tool",
  signal: expect.any(AbortSignal),
});

it("resolves relative Lobster paths inside the repo root", () => {
  const relative = "extensions/lobster";
  expect(resolveLobsterCwd(relative)).toBe(path.resolve(process.cwd(), relative));
});

describe("createEmbeddedLobsterRunner", () => {
  const runRequest = vi.fn<(params: { ctx?: { signal?: AbortSignal } }) => Promise<unknown>>();
  const resumeRequest = vi.fn<() => Promise<unknown>>();
  const loadRuntime = vi
    .fn()
    .mockResolvedValue({ runToolRequest: runRequest, resumeToolRequest: resumeRequest });
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
    runRequest.mockReset();
    resumeRequest.mockReset();
    loadRuntime.mockClear();
    vi.doMock("@clawdbot/lobster/core", loadRuntime);
    runner = createEmbeddedLobsterRunner();
  });

  it("bounds the model-visible result for an embedded workflow request", async () => {
    runRequest.mockResolvedValue({
      ...success,
      output: Array.from({ length: 115 }, () => ({ a: 1 })),
    });
    const { cwd, filePath } = await createWorkflow();
    await expect(run({ pipeline: filePath, cwd, maxStdoutBytes: 1024 })).rejects.toThrow(
      "lobster runtime result exceeded maxStdoutBytes",
    );
  });

  it("runs inline pipelines with file-like arguments through the embedded runtime", async () => {
    const raw = { ...success, protocolVersion: 1 };
    runRequest.mockResolvedValue({ ...raw, output: [{ hello: "world" }] });
    const pipeline = "exec --json=true cat data.json";
    const envelope = await run({ pipeline });
    expect(runRequest).toHaveBeenCalledExactlyOnceWith({ pipeline, ctx });
    expect(envelope).toEqual({ ...success, output: [{ hello: "world" }] });
  });

  it("surfaces missing workflow path errors", async () => {
    const cwd = tempDirs.make("openclaw-lobster-runner-");
    await expect(run({ pipeline: "missing.lobster", cwd })).rejects.toMatchObject({
      code: "ENOENT",
      path: path.join(cwd, "missing.lobster"),
    });
    expect(runRequest).not.toHaveBeenCalled();
  });

  it("returns a parse error when workflow args are invalid JSON", async () => {
    const { cwd } = await createWorkflow();
    await expect(run({ pipeline: "workflow.lobster", argsJson: "{bad", cwd })).rejects.toThrow(
      "run --args-json must be valid JSON",
    );
    expect(runRequest).not.toHaveBeenCalled();
  });

  it("rejects an input request without a resumable checkpoint", async () => {
    runRequest.mockResolvedValue({ ...success, status: "needs_input" });
    await expect(run()).rejects.toThrow("Lobster input request is missing its resume token");
  });

  it("forwards approvalId through resume when token is absent", async () => {
    resumeRequest.mockResolvedValue(success);
    await run({ action: "resume", pipeline: undefined, approvalId: "dbc98d05", approve: true });
    expect(resumeRequest).toHaveBeenCalledExactlyOnceWith({
      approvalId: "dbc98d05",
      approved: true,
      ctx,
    });
  });

  it("loads the embedded runtime once per runner", async () => {
    runRequest.mockResolvedValue(success);
    resumeRequest.mockResolvedValue({ ...success, status: "cancelled" });
    await run();
    await run({ action: "resume", pipeline: undefined, token: "resume-token", approve: false });
    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });

  it.each<[Partial<LobsterRunnerParams>, RegExp]>([
    [{ action: "run", pipeline: undefined }, /pipeline required/],
    [{ token: undefined, approve: true }, /token or approvalId required/],
    [{}, /exactly one/],
    [{ responseJson: "{bad" }, /responseJson must be valid JSON/],
    [{ approve: true, responseJson: "null" }, /exactly one/],
    [{ cancel: false }, /cancel must be true/],
  ])("rejects invalid arguments before touching state: %j", async (params, error) => {
    await expect(run({ action: "resume", token: "resume-token", ...params })).rejects.toThrow(
      error,
    );
    expect(runRequest).not.toHaveBeenCalled();
    expect(resumeRequest).not.toHaveBeenCalled();
  });

  it("aborts long-running embedded work", async () => {
    runRequest.mockImplementation(
      ({ ctx: context }) =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve(success), 500);
          context?.signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(
              toErrorObject(context.signal?.reason ?? new Error("aborted"), "Non-Error rejection"),
            );
          });
        }),
    );
    await expect(run({ timeoutMs: 200 })).rejects.toThrow(/timed out|aborted/);
  });
});
