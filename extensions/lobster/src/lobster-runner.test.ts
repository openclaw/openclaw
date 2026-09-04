import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Lobster tests cover lobster runner plugin behavior.
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunnerParams,
} from "./lobster-runner.js";

const requireRecord = createRequireRecord("record", "expected-label-record");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requireFirstCallParam(calls: ReadonlyArray<readonly unknown[]>, label: string) {
  const call = calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

function expectToolContext(value: unknown, expected: { cwd?: string; mode: "tool" }) {
  const ctx = requireRecord(value, "tool context");
  if (expected.cwd !== undefined) {
    expect(ctx.cwd).toBe(expected.cwd);
  }
  expect(ctx.mode).toBe(expected.mode);
  expect(ctx.signal).toBeInstanceOf(AbortSignal);
}

describe("resolveLobsterCwd", () => {
  it("defaults to the current working directory", () => {
    expect(resolveLobsterCwd(undefined)).toBe(process.cwd());
  });

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

  it("runs inline pipelines through the embedded runtime", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [{ hello: "world" }],
        requiresApproval: null,
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: "exec --json=true echo hi",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.runToolRequest).toHaveBeenCalledTimes(1);
    const request = requireRecord(
      requireFirstCallParam(runtime.runToolRequest.mock.calls, "run tool request"),
      "run tool request",
    );
    expect(request.pipeline).toBe("exec --json=true echo hi");
    expectToolContext(request.ctx, { cwd: process.cwd(), mode: "tool" });
    expect(envelope).toEqual({
      ok: true,
      status: "ok",
      output: [{ hello: "world" }],
      requiresApproval: null,
    });
  });

  it.each(["inline", "workflow", "resume"])(
    "bounds the model-visible result for an embedded %s request",
    async (requestKind) => {
      const runtimeResult = {
        ok: true,
        protocolVersion: 1,
        status: "ok" as const,
        output: Array.from({ length: 115 }, () => ({ a: 1 })),
        requiresApproval: null,
        requiresInput: null,
      };
      const runtime = {
        runToolRequest: vi.fn().mockResolvedValue(runtimeResult),
        resumeToolRequest: vi.fn().mockResolvedValue(runtimeResult),
      };
      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });
      const tempDir = tempDirs.make("openclaw-lobster-limit-");
      const workflowPath = path.join(tempDir, "workflow.lobster");
      await fs.writeFile(workflowPath, "steps: []\n", "utf8");
      const params: LobsterRunnerParams =
        requestKind === "resume"
          ? {
              action: "resume",
              token: "resume-token",
              approve: false,
              cwd: tempDir,
              timeoutMs: 2000,
              maxStdoutBytes: 1024,
            }
          : {
              action: "run",
              pipeline: requestKind === "workflow" ? workflowPath : "exec --json=true echo bounded",
              cwd: tempDir,
              timeoutMs: 2000,
              maxStdoutBytes: 1024,
            };

      await expect(runner.run(params)).rejects.toThrow(
        "lobster runtime result exceeded maxStdoutBytes",
      );
    },
  );

  it.each([
    [
      "prompt",
      { prompt: "x".repeat(4097) },
      "lobster input request prompt exceeded its model-context limit",
    ],
    [
      "responseSchema",
      { responseSchema: { type: "string", description: "x".repeat(8193) } },
      "lobster input request responseSchema exceeded its model-context limit",
    ],
    [
      "defaults",
      { defaults: "x".repeat(4097) },
      "lobster input request defaults exceeded its model-context limit",
    ],
    [
      "subject",
      { subject: "x".repeat(2049) },
      "lobster input request subject exceeded its model-context limit",
    ],
    [
      "resume token",
      { resumeToken: "x".repeat(4097) },
      "lobster input request resumeToken exceeded its model-context limit",
    ],
    [
      "complete envelope",
      {
        prompt: "x".repeat(4090),
        responseSchema: { type: "string", description: "x".repeat(7900) },
        defaults: "x".repeat(3900),
        subject: "x".repeat(1900),
        resumeToken: "x".repeat(300),
      },
      "lobster input request exceeded its model-context limit",
    ],
  ])(
    "rejects an oversized structured-input %s with a fixed model budget",
    async (_field, patch, expectedError) => {
      const runtime = {
        runToolRequest: vi.fn().mockResolvedValue({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: "input_request",
            prompt: "Choose an outcome",
            responseSchema: { type: "string" },
            resumeToken: "input-token",
            ...patch,
          },
        }),
        resumeToolRequest: vi.fn(),
      };
      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await expect(
        runner.run({
          action: "run",
          pipeline: "ask --prompt 'Choose an outcome'",
          cwd: process.cwd(),
          timeoutMs: 2000,
          maxStdoutBytes: 1_000_000,
        }),
      ).rejects.toThrow(expectedError);
    },
  );

  it.each([
    "exec --json=true cat data.json",
    "exec --json=true cat config.yaml",
    "exec --json=true cat flow.lobster",
    "exec --json=true cat /tmp/missing.json",
    "http.fetch https://example.test/workflows/flow.lobster",
    "exec --json=true echo nested/path",
  ])("keeps inline pipeline with file-like args as a pipeline: %s", async (pipeline) => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await runner.run({
      action: "run",
      pipeline,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.runToolRequest).toHaveBeenCalledOnce();
    const request = requireRecord(
      requireFirstCallParam(runtime.runToolRequest.mock.calls, "inline run tool request"),
      "inline run tool request",
    );
    expect(request.pipeline).toBe(pipeline);
    expect(request.filePath).toBeUndefined();
  });

  it("detects workflow files and parses argsJson", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));
    const workflowPath = path.join(tempDir, "workflow.lobster");
    await fs.writeFile(workflowPath, "steps: []\n", "utf8");

    try {
      const runtime = {
        runToolRequest: vi.fn().mockResolvedValue({
          ok: true,
          protocolVersion: 1,
          status: "ok",
          output: [],
          requiresApproval: null,
        }),
        resumeToolRequest: vi.fn(),
      };

      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await runner.run({
        action: "run",
        pipeline: "workflow.lobster",
        argsJson: '{"limit":3}',
        cwd: tempDir,
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      });

      expect(runtime.runToolRequest).toHaveBeenCalledOnce();
      const request = requireRecord(
        requireFirstCallParam(runtime.runToolRequest.mock.calls, "workflow run tool request"),
        "workflow run tool request",
      );
      expect(request.filePath).toBe(workflowPath);
      expect(request.args).toEqual({ limit: 3 });
      expectToolContext(request.ctx, { cwd: tempDir, mode: "tool" });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("detects existing workflow file paths that contain spaces", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));
    const workflowPath = path.join(tempDir, "daily inbox.lobster");
    await fs.writeFile(workflowPath, "steps: []\n", "utf8");

    try {
      const runtime = {
        runToolRequest: vi.fn().mockResolvedValue({
          ok: true,
          protocolVersion: 1,
          status: "ok",
          output: [],
          requiresApproval: null,
        }),
        resumeToolRequest: vi.fn(),
      };

      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await runner.run({
        action: "run",
        pipeline: "daily inbox.lobster",
        cwd: tempDir,
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      });

      expect(runtime.runToolRequest).toHaveBeenCalledOnce();
      const request = requireRecord(
        requireFirstCallParam(runtime.runToolRequest.mock.calls, "workflow file with spaces"),
        "workflow file with spaces",
      );
      expect(request.filePath).toBe(workflowPath);
      expect(request.pipeline).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing.lobster", "missing.lobster"],
    ["nested/missing.yaml", path.join("nested", "missing.yaml")],
  ])("surfaces missing workflow path errors for %s", async (pipeline, expectedRelativePath) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));

    try {
      const runtime = {
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      };
      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await expect(
        runner.run({
          action: "run",
          pipeline,
          cwd: tempDir,
          timeoutMs: 2000,
          maxStdoutBytes: 4096,
        }),
      ).rejects.toMatchObject({
        code: "ENOENT",
        path: path.join(tempDir, expectedRelativePath),
      });
      expect(runtime.runToolRequest).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a parse error when workflow args are invalid JSON", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-runner-"));
    const workflowPath = path.join(tempDir, "workflow.lobster");
    await fs.writeFile(workflowPath, "steps: []\n", "utf8");

    try {
      const runtime = {
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      };
      const runner = createEmbeddedLobsterRunner({
        loadRuntime: vi.fn().mockResolvedValue(runtime),
      });

      await expect(
        runner.run({
          action: "run",
          pipeline: "workflow.lobster",
          argsJson: "{bad",
          cwd: tempDir,
          timeoutMs: 2000,
          maxStdoutBytes: 4096,
        }),
      ).rejects.toThrow("run --args-json must be valid JSON");
      expect(runtime.runToolRequest).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when the embedded runtime returns an error envelope", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: false,
        protocolVersion: 1,
        error: {
          type: "runtime_error",
          message: "boom",
        },
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "run",
        pipeline: "exec --json=true echo hi",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow("boom");
  });

  it("returns structured input requests and resumes them with a response", async () => {
    const requiresInput = {
      type: "input_request" as const,
      prompt: "Review this draft?",
      responseSchema: {
        type: "object",
        properties: { decision: { type: "string", enum: ["approve", "reject"] } },
        required: ["decision"],
        additionalProperties: false,
      },
      defaults: { decision: "approve" },
      subject: { text: "draft body" },
      resumeToken: "input-resume-token",
    };
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "needs_input",
        output: [],
        requiresApproval: null,
        requiresInput,
      }),
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [{ decision: "approve", subject: "draft body" }],
        requiresApproval: null,
        requiresInput: null,
      }),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "run",
        pipeline: "ask --prompt 'Review this draft?'",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).resolves.toEqual({
      ok: true,
      status: "needs_input",
      output: [],
      requiresApproval: null,
      requiresInput,
    });

    await expect(
      runner.run({
        action: "resume",
        token: "input-resume-token",
        response: { decision: "approve" },
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: "ok",
      output: [{ decision: "approve", subject: "draft body" }],
    });
    expect(runtime.resumeToolRequest).toHaveBeenCalledOnce();
    const request = requireRecord(
      requireFirstCallParam(runtime.resumeToolRequest.mock.calls, "input resume tool request"),
      "input resume tool request",
    );
    expect(request.token).toBe("input-resume-token");
    expect(request.response).toEqual({ decision: "approve" });
    expect(request.approved).toBeUndefined();
  });

  it("routes resume through the embedded runtime", async () => {
    const runtime = {
      runToolRequest: vi.fn(),
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "cancelled",
        output: [],
        requiresApproval: null,
      }),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "resume",
      token: "resume-token",
      approve: false,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.resumeToolRequest).toHaveBeenCalledOnce();
    const request = requireRecord(
      requireFirstCallParam(runtime.resumeToolRequest.mock.calls, "resume tool request"),
      "resume tool request",
    );
    expect(request.token).toBe("resume-token");
    expect(request.approved).toBe(false);
    expectToolContext(request.ctx, { cwd: process.cwd(), mode: "tool" });
    expect(envelope).toEqual({
      ok: true,
      status: "cancelled",
      output: [],
      requiresApproval: null,
    });
  });

  it("forwards approvalId through resume when token is absent", async () => {
    const runtime = {
      runToolRequest: vi.fn(),
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await runner.run({
      action: "resume",
      approvalId: "dbc98d05",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(runtime.resumeToolRequest).toHaveBeenCalledOnce();
    const request = requireRecord(
      requireFirstCallParam(runtime.resumeToolRequest.mock.calls, "approval resume tool request"),
      "approval resume tool request",
    );
    expect(request.approvalId).toBe("dbc98d05");
    expect(request.approved).toBe(true);
    expectToolContext(request.ctx, { mode: "tool" });
  });

  it("passes approvalId through the normalized needs_approval envelope", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "ok?",
          items: [],
          resumeToken: "eyJ...",
          approvalId: "dbc98d05",
        },
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: "exec --json=true echo hi",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(envelope).toEqual({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "ok?",
        items: [],
        resumeToken: "eyJ...",
        approvalId: "dbc98d05",
      },
    });
  });

  it("loads the embedded runtime once per runner", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
      resumeToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "cancelled",
        output: [],
        requiresApproval: null,
      }),
    };
    const loadRuntime = vi.fn().mockResolvedValue(runtime);

    const runner = createEmbeddedLobsterRunner({ loadRuntime });

    await runner.run({
      action: "run",
      pipeline: "exec --json=true echo hi",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });
    await runner.run({
      action: "resume",
      token: "resume-token",
      approve: false,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });

  it("loads the published package core runtime", async () => {
    await expect(
      createEmbeddedLobsterRunner().run({
        action: "run",
        pipeline: "commands.list",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 512_000,
      }),
    ).resolves.toMatchObject({ ok: true, status: "ok" });
  });

  it("requires a pipeline for run", async () => {
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue({
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      }),
    });

    await expect(
      runner.run({
        action: "run",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/pipeline required/);
  });

  it("requires a token and exactly one resume decision", async () => {
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue({
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      }),
    });

    await expect(
      runner.run({
        action: "resume",
        approve: true,
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/token or approvalId required/);

    await expect(
      runner.run({
        action: "resume",
        token: "resume-token",
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/exactly one of approve or response required/);

    await expect(
      runner.run({
        action: "resume",
        token: "resume-token",
        approve: true,
        response: { decision: "approve" },
        cwd: process.cwd(),
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/exactly one of approve or response required/);
  });

  it("aborts long-running embedded work", async () => {
    const runtime = {
      runToolRequest: vi.fn(
        async ({ ctx }: { ctx?: { signal?: AbortSignal } }) =>
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => resolve({ ok: true, status: "ok", output: [], requiresApproval: null }),
              500,
            );
            ctx?.signal?.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(
                toLintErrorObject(
                  ctx.signal?.reason ?? new Error("aborted"),
                  "Non-Error rejection",
                ),
              );
            });
          }),
      ),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    await expect(
      runner.run({
        action: "run",
        pipeline: "exec --json=true echo hi",
        cwd: process.cwd(),
        timeoutMs: 200,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow(/timed out|aborted/);
  });
});
