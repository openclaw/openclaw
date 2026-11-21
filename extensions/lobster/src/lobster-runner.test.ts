import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLobsterCwd } from "./lobster-runner.js";
import { createLobsterTool } from "./lobster-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const success = { ok: true, status: "ok" as const, output: [], requiresApproval: null };

async function createWorkflow() {
  const cwd = tempDirs.make("openclaw-lobster-runner-");
  const filePath = path.join(cwd, "workflow.lobster");
  await fs.writeFile(filePath, "steps: []\n", "utf8");
  return { cwd, filePath };
}

it("resolves relative Lobster paths inside the repo root", () => {
  for (const relative of ["extensions/lobster", "demo ", " demo", "demo\t"]) {
    expect(resolveLobsterCwd(relative)).toBe(path.resolve(process.cwd(), relative));
  }
});

describe("createEmbeddedLobsterRunner", () => {
  const runRequest = vi.fn<(params: { ctx?: { signal?: AbortSignal } }) => Promise<unknown>>();
  const resumeRequest = vi.fn<() => Promise<unknown>>();
  let tool: ReturnType<typeof createLobsterTool>;
  const run = async (overrides: Record<string, unknown> = {}) =>
    (
      await tool.execute("test", {
        action: "run",
        pipeline: "exec --json=true echo hi",
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
        ...overrides,
      })
    ).details;
  beforeEach(() => {
    runRequest.mockReset();
    resumeRequest.mockReset();
    vi.doMock("@clawdbot/lobster/core", () => ({
      runToolRequest: runRequest,
      resumeToolRequest: resumeRequest,
    }));
    tool = createLobsterTool();
  });

  it("applies a numeric-string output limit through the tool to embedded workflows", async () => {
    runRequest.mockResolvedValue({ ...success, output: ["x".repeat(1024)] });
    const { cwd } = await createWorkflow();
    await fs.writeFile(path.join(cwd, " workflow.lobster"), "steps: []\n");
    const currentDirectory = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      for (const pipeline of ["workflow.lobster", " workflow.lobster"]) {
        await expect(run({ pipeline, maxStdoutBytes: "1024" })).rejects.toThrow(
          "lobster runtime result exceeded maxStdoutBytes",
        );
        expect(runRequest).toHaveBeenLastCalledWith(
          expect.objectContaining({ filePath: path.join(cwd, pipeline) }),
        );
      }
    } finally {
      currentDirectory.mockRestore();
    }
  });

  it("runs inline pipelines with file-like arguments through the embedded runtime", async () => {
    runRequest.mockResolvedValue({ ...success, protocolVersion: 1, output: [{ hello: "world" }] });
    const pipeline = "exec --json=true cat data.json";
    const envelope = await run({ pipeline });
    expect(runRequest.mock.calls[0]?.[0].ctx).toMatchObject({ mode: "tool" });
    expect(runRequest.mock.calls[0]?.[0].ctx?.signal).toBeInstanceOf(AbortSignal);
    expect(envelope).toEqual({ ...success, output: [{ hello: "world" }] });
  });

  it.each(["missing.lobster", "workflow.lobster"])(
    "rejects invalid workflow request: %s",
    async (pipeline) => {
      const { cwd } = await createWorkflow();
      const rejection = expect(
        run({ pipeline: path.join(cwd, pipeline), argsJson: "{bad" }),
      ).rejects;
      if (pipeline === "missing.lobster") {
        await rejection.toMatchObject({ code: "ENOENT", path: path.join(cwd, pipeline) });
      } else {
        await rejection.toThrow("run --args-json must be valid JSON");
      }
      expect(runRequest).not.toHaveBeenCalled();
    },
  );

  it("rejects an input request without a resumable checkpoint", async () => {
    runRequest.mockResolvedValue({ ...success, status: "needs_input" });
    await expect(run()).rejects.toThrow("Lobster input request is missing its resume token");
  });

  it("forwards approvalId through resume when token is absent", async () => {
    resumeRequest.mockResolvedValue(success);
    await run({ action: "resume", pipeline: undefined, approvalId: "dbc98d05", approve: true });
    expect(resumeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "dbc98d05", approved: true }),
    );
  });

  it.each<[Record<string, unknown>, RegExp]>([
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

  it("applies a numeric-string timeout through the tool and aborts embedded work", async () => {
    runRequest.mockImplementation(
      ({ ctx: context }) =>
        new Promise((_resolve, reject) => {
          context?.signal?.addEventListener("abort", () => {
            reject(
              toErrorObject(context.signal?.reason ?? new Error("aborted"), "Non-Error rejection"),
            );
          });
        }),
    );
    await expect(run({ timeoutMs: "200" })).rejects.toThrow(/timed out|aborted/);
  });
});
