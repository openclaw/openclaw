import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedLobsterRunner,
  loadEmbeddedToolRuntimeFromPackage,
  resolveLobsterCwd,
} from "./lobster-runner.js";

const requireForTest = createRequire(import.meta.url);

type AjvCacheOwner = {
  _cache?: { size: number };
};

function readAjvInternalCacheSize(ajv: unknown): number {
  return (ajv as AjvCacheOwner)["_cache"]?.size ?? 0;
}

function createRepeatedResponseSchema() {
  return {
    type: "object",
    properties: {
      answer: { type: "string" },
    },
    required: ["answer"],
    additionalProperties: false,
  };
}

function createUniqueResponseSchema(index: number) {
  return {
    type: "object",
    properties: {
      [`answer${index}`]: { type: "string" },
    },
    required: [`answer${index}`],
    additionalProperties: false,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireFirstCallParam(calls: ReadonlyArray<readonly unknown[]>, label: string) {
  const call = calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

async function* streamFromItems(items: unknown[]) {
  for (const item of items) {
    yield item;
  }
}

async function collectAsync(value: AsyncIterable<unknown> | undefined): Promise<unknown[]> {
  const items: unknown[] = [];
  if (!value) {
    return items;
  }
  for await (const item of value) {
    items.push(item);
  }
  return items;
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

  it("overrides openclaw.invoke with an in-process native tool bridge", async () => {
    const nativeToolInvoker = vi.fn().mockResolvedValue({ sent: true });
    const runtime = {
      createDefaultRegistry: vi.fn(() => ({
        get: vi.fn(),
        list: vi.fn(() => ["exec", "openclaw.invoke"]),
      })),
      runToolRequest: vi.fn().mockImplementation(async ({ ctx }: { ctx?: unknown }) => {
        const toolContext = requireRecord(ctx, "tool context");
        const registry = requireRecord(toolContext.registry, "tool registry") as {
          get(name: string): unknown;
        };
        const command = registry.get("openclaw.invoke") as {
          run(params: {
            input: AsyncIterable<unknown>;
            args: Record<string, unknown>;
            ctx: unknown;
          }): Promise<{ output?: AsyncIterable<unknown> }>;
        };
        const result = await command.run({
          input: streamFromItems([]),
          args: {
            tool: "message",
            action: "send",
            "args-json": '{"provider":"discord","message":"done"}',
          },
          ctx,
        });
        return {
          ok: true,
          protocolVersion: 1,
          status: "ok",
          output: await collectAsync(result.output),
          requiresApproval: null,
        };
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
      nativeToolInvoker,
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: "openclaw.invoke --tool message --action send",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(nativeToolInvoker).toHaveBeenCalledWith({
      tool: "message",
      action: "send",
      args: { provider: "discord", message: "done" },
      signal: expect.any(AbortSignal),
    });
    expect(envelope).toEqual({
      ok: true,
      status: "ok",
      output: [{ sent: true }],
      requiresApproval: null,
    });
  });

  it("maps each pipeline item into in-process openclaw.invoke args", async () => {
    const nativeToolInvoker = vi
      .fn()
      .mockResolvedValueOnce({ id: "first" })
      .mockResolvedValueOnce({ id: "second" });
    const runtime = {
      createDefaultRegistry: vi.fn(() => ({
        get: vi.fn(),
        list: vi.fn(() => ["exec", "openclaw.invoke"]),
      })),
      runToolRequest: vi.fn().mockImplementation(async ({ ctx }: { ctx?: unknown }) => {
        const toolContext = requireRecord(ctx, "tool context");
        const registry = requireRecord(toolContext.registry, "tool registry") as {
          get(name: string): unknown;
        };
        const command = registry.get("openclaw.invoke") as {
          run(params: {
            input: AsyncIterable<unknown>;
            args: Record<string, unknown>;
            ctx: unknown;
          }): Promise<{ output?: AsyncIterable<unknown> }>;
        };
        const result = await command.run({
          input: streamFromItems(["one", "two"]),
          args: {
            tool: "message",
            action: "send",
            each: true,
            "item-key": "message",
            "args-json": '{"provider":"discord"}',
          },
          ctx,
        });
        return {
          ok: true,
          protocolVersion: 1,
          status: "ok",
          output: await collectAsync(result.output),
          requiresApproval: null,
        };
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
      nativeToolInvoker,
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: "openclaw.invoke --tool message --action send --each --item-key message",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(nativeToolInvoker).toHaveBeenNthCalledWith(1, {
      tool: "message",
      action: "send",
      args: { provider: "discord", message: "one" },
      signal: expect.any(AbortSignal),
    });
    expect(nativeToolInvoker).toHaveBeenNthCalledWith(2, {
      tool: "message",
      action: "send",
      args: { provider: "discord", message: "two" },
      signal: expect.any(AbortSignal),
    });
    expect(envelope).toMatchObject({
      ok: true,
      status: "ok",
      output: [{ id: "first" }, { id: "second" }],
    });
  });

  it("exposes published child workflows through the embedded lobster.workflow command", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lobster-child-workflow-"));
    const childPath = path.join(tmpDir, "child.lobster");
    await fs.writeFile(
      childPath,
      "name: child\nsteps:\n  - id: done\n    run: echo done\n",
      "utf8",
    );
    const workflowResolver = vi.fn(async () => childPath);
    const runtime = {
      createDefaultRegistry: vi.fn(() => ({
        get: vi.fn(),
        list: vi.fn(() => ["exec"]),
      })),
      runToolRequest: vi.fn().mockImplementation(async (request: Record<string, unknown>) => {
        if (request.pipeline) {
          const toolContext = requireRecord(request.ctx, "tool context");
          const registry = requireRecord(toolContext.registry, "tool registry") as {
            get(name: string): unknown;
          };
          const command = registry.get("lobster.workflow") as {
            run(params: {
              input: AsyncIterable<unknown>;
              args: Record<string, unknown>;
              ctx: Record<string, unknown>;
            }): Promise<{ output?: AsyncIterable<unknown> }>;
          };
          const result = await command.run({
            input: streamFromItems([{ customer: "c1" }]),
            args: {
              "workflow-id": "child",
              "workflow-revision": "2",
              "args-json": '{"static":true}',
              "input-key": "input",
            },
            ctx: toolContext,
          });
          return {
            ok: true,
            protocolVersion: 1,
            status: "ok",
            output: await collectAsync(result.output),
            requiresApproval: null,
          };
        }

        expect(request.filePath).toBe(childPath);
        expect(request.args).toEqual({
          static: true,
          input: { customer: "c1" },
        });
        const childContext = requireRecord(request.ctx, "child workflow context");
        const childEnv = requireRecord(childContext.env, "child workflow env");
        expect(childEnv.OPENCLAW_LOBSTER_WORKFLOW_DEPTH).toBe("1");
        return {
          ok: true,
          protocolVersion: 1,
          status: "ok",
          output: [{ child: true }],
          requiresApproval: null,
        };
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
      workflowResolver,
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: "lobster.workflow --workflow-id child",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(workflowResolver).toHaveBeenCalledWith({ workflowId: "child", workflowRevision: 2 });
    expect(envelope).toEqual({
      ok: true,
      status: "ok",
      output: [{ child: true }],
      requiresApproval: null,
    });
  });

  it("exposes parallel branch pipelines through the embedded lobster.parallel command", async () => {
    const branchStarted: string[] = [];
    let releaseBranches!: () => void;
    const branchesReady = new Promise<void>((resolve) => {
      releaseBranches = resolve;
    });
    const runtime = {
      createDefaultRegistry: vi.fn(() => ({
        get: vi.fn(),
        list: vi.fn(() => ["exec"]),
      })),
      runToolRequest: vi.fn().mockImplementation(async (request: Record<string, unknown>) => {
        if (request.pipeline === "lobster.parallel") {
          const toolContext = requireRecord(request.ctx, "tool context");
          const registry = requireRecord(toolContext.registry, "tool registry") as {
            get(name: string): unknown;
          };
          const command = registry.get("lobster.parallel") as {
            run(params: {
              input: AsyncIterable<unknown>;
              args: Record<string, unknown>;
              ctx: Record<string, unknown>;
            }): Promise<{ output?: AsyncIterable<unknown> }>;
          };
          const result = await command.run({
            input: streamFromItems([]),
            args: {
              "branches-json": JSON.stringify([
                { id: "left", pipeline: "branch-left" },
                { id: "right", pipeline: "branch-right" },
              ]),
            },
            ctx: toolContext,
          });
          return {
            ok: true,
            protocolVersion: 1,
            status: "ok",
            output: await collectAsync(result.output),
            requiresApproval: null,
          };
        }

        const branchId = request.pipeline === "branch-left" ? "left" : "right";
        branchStarted.push(branchId);
        if (branchStarted.length === 2) {
          releaseBranches();
        }
        await branchesReady;
        return {
          ok: true,
          protocolVersion: 1,
          status: "ok",
          output: [{ branch: branchId }],
          requiresApproval: null,
        };
      }),
      resumeToolRequest: vi.fn(),
    };

    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: "lobster.parallel",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    expect(branchStarted.toSorted()).toEqual(["left", "right"]);
    expect(envelope).toEqual({
      ok: true,
      status: "ok",
      output: [
        { id: "left", status: "ok", output: [{ branch: "left" }] },
        { id: "right", status: "ok", output: [{ branch: "right" }] },
      ],
      requiresApproval: null,
    });
  });

  it("normalizes workflow reference steps before handing files to Lobster core", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lobster-parent-workflow-"));
    const parentPath = path.join(tmpDir, "parent.lobster");
    await fs.writeFile(
      parentPath,
      [
        "name: parent",
        "steps:",
        "  - id: child",
        "    workflow: child-flow",
        "    workflowRevision: 2",
        "    workflow_args:",
        "      customer: c1",
        "      input: $prepare.stdout",
        "",
      ].join("\n"),
      "utf8",
    );
    const runtime = {
      createDefaultRegistry: vi.fn(() => ({
        get: vi.fn(),
        list: vi.fn(() => ["exec"]),
      })),
      runToolRequest: vi.fn().mockImplementation(async (request: Record<string, unknown>) => {
        const normalizedPath = String(request.filePath);
        expect(normalizedPath).not.toBe(parentPath);
        const normalized = await fs.readFile(normalizedPath, "utf8");
        expect(normalized).toContain("lobster.workflow");
        expect(normalized).toContain("--workflow-id");
        expect(normalized).toContain("child-flow");
        expect(normalized).toContain("--workflow-revision");
        expect(normalized).toContain("--input-key");
        expect(normalized).toContain("stdin: $prepare.stdout");
        return {
          ok: true,
          protocolVersion: 1,
          status: "ok",
          output: [{ parent: true }],
          requiresApproval: null,
        };
      }),
      resumeToolRequest: vi.fn(),
    };
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
      workflowResolver: vi.fn(),
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: parentPath,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    if (!envelope.ok) {
      throw new Error(envelope.error.message);
    }
    expect(envelope.output).toEqual([{ parent: true }]);
  });

  it("normalizes parallel steps before handing files to Lobster core", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lobster-parallel-workflow-"));
    const parentPath = path.join(tmpDir, "parallel.lobster");
    await fs.writeFile(
      parentPath,
      [
        "name: parallel-parent",
        "steps:",
        "  - id: fanout",
        "    parallel:",
        "      wait: all",
        "      branches:",
        "        - id: child-a",
        '          pipeline: "lobster.workflow --workflow-id child-a"',
        "        - id: child-b",
        '          pipeline: "lobster.workflow --workflow-id child-b"',
        "",
      ].join("\n"),
      "utf8",
    );
    const runtime = {
      createDefaultRegistry: vi.fn(() => ({
        get: vi.fn(),
        list: vi.fn(() => ["exec"]),
      })),
      runToolRequest: vi.fn().mockImplementation(async (request: Record<string, unknown>) => {
        const normalizedPath = String(request.filePath);
        expect(normalizedPath).not.toBe(parentPath);
        const normalized = await fs.readFile(normalizedPath, "utf8");
        expect(normalized).toContain("lobster.parallel");
        expect(normalized).toContain("--branches-json");
        expect(normalized).toContain("child-a");
        expect(normalized).toContain("child-b");
        return {
          ok: true,
          protocolVersion: 1,
          status: "ok",
          output: [{ parent: true }],
          requiresApproval: null,
        };
      }),
      resumeToolRequest: vi.fn(),
    };
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
      workflowResolver: vi.fn(),
    });

    const envelope = await runner.run({
      action: "run",
      pipeline: parentPath,
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
    });

    if (!envelope.ok) {
      throw new Error(envelope.error.message);
    }
    expect(envelope.output).toEqual([{ parent: true }]);
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

  it("fails closed when the embedded runtime requests unsupported input", async () => {
    const runtime = {
      runToolRequest: vi.fn().mockResolvedValue({
        ok: true,
        protocolVersion: 1,
        status: "needs_input",
        output: [],
        requiresApproval: null,
        requiresInput: {
          prompt: "Need more data",
          schema: { type: "string" },
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
    ).rejects.toThrow("Lobster input requests are not supported by the OpenClaw Lobster tool yet");
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

  it("installs an Ajv content cache before loading the embedded runtime", async () => {
    const AjvModule = await import("ajv");
    const AjvCtor = AjvModule.default as unknown as new (opts?: object) => import("ajv").default;
    const ajv = new AjvCtor({ allErrors: true, strict: false, addUsedSchema: false });
    const before = readAjvInternalCacheSize(ajv);

    await loadEmbeddedToolRuntimeFromPackage({
      importModule: async () => ({
        runToolRequest: vi.fn(),
        resumeToolRequest: vi.fn(),
      }),
    });

    const first = ajv.compile(createRepeatedResponseSchema());
    const second = ajv.compile(createRepeatedResponseSchema());
    const afterRepeated = readAjvInternalCacheSize(ajv);

    expect(second).toBe(first);
    expect(afterRepeated - before).toBe(1);

    for (let index = 0; index < 520; index += 1) {
      ajv.compile(createUniqueResponseSchema(index));
    }

    expect(readAjvInternalCacheSize(ajv)).toBeLessThanOrEqual(before + 512);
  });

  it("deduplicates content-identical schema compilation in the installed Lobster runtime", async () => {
    await loadEmbeddedToolRuntimeFromPackage();

    const corePath = requireForTest.resolve("@clawdbot/lobster/core");
    const validationPath = path.join(path.dirname(path.dirname(corePath)), "validation.js");
    const validationModule = (await import(pathToFileURL(validationPath).href)) as {
      sharedAjv: import("ajv").default;
    };
    const before = readAjvInternalCacheSize(validationModule.sharedAjv);

    const first = validationModule.sharedAjv.compile(createRepeatedResponseSchema());
    for (let index = 0; index < 1000; index += 1) {
      validationModule.sharedAjv.compile(createRepeatedResponseSchema());
    }
    const second = validationModule.sharedAjv.compile(createRepeatedResponseSchema());

    expect(second).toBe(first);
    expect(readAjvInternalCacheSize(validationModule.sharedAjv) - before).toBe(1);
  });

  it("falls back to the installed package core file when the core export is unavailable", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lobster-package-"));
    const packageRoot = path.join(tempDir, "node_modules", "@clawdbot", "lobster");
    const packageEntryPath = path.join(packageRoot, "dist", "src", "sdk", "index.js");
    const packageCorePath = path.join(packageRoot, "dist", "src", "core", "index.js");

    try {
      await fs.mkdir(path.dirname(packageEntryPath), { recursive: true });
      await fs.mkdir(path.dirname(packageCorePath), { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@clawdbot/lobster",
          type: "module",
          main: "./dist/src/sdk/index.js",
        }),
        "utf8",
      );
      await fs.writeFile(packageEntryPath, "export {};\n", "utf8");
      await fs.writeFile(
        packageCorePath,
        [
          "export async function runToolRequest() {",
          "  return { ok: true, status: 'ok', output: [{ source: 'fallback' }], requiresApproval: null };",
          "}",
          "export async function resumeToolRequest() {",
          "  return { ok: true, status: 'cancelled', output: [], requiresApproval: null };",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const runtime = await loadEmbeddedToolRuntimeFromPackage({
        importModule: async (specifier) => {
          if (specifier === "@clawdbot/lobster/core") {
            throw new Error("package export missing");
          }
          return (await import(`${specifier}?t=${Date.now()}`)) as object;
        },
        resolvePackageEntry: () => packageEntryPath,
      });

      await expect(runtime.runToolRequest({ pipeline: "commands.list" })).resolves.toEqual({
        ok: true,
        status: "ok",
        output: [{ source: "fallback" }],
        requiresApproval: null,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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

  it("requires token and approve for resume", async () => {
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
    ).rejects.toThrow(/approve required/);
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
              reject(ctx.signal?.reason ?? new Error("aborted"));
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
