import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LobsterCheckpointProvenance } from "./lobster-checkpoint-provenance.js";
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
    vi.unstubAllEnvs();
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

  it("passes host-provided LLM adapters into embedded context without adding Gateway credentials", async () => {
    vi.stubEnv("OPENCLAW_URL", undefined);
    vi.stubEnv("OPENCLAW_TOKEN", undefined);
    vi.stubEnv("CLAWD_URL", undefined);
    vi.stubEnv("CLAWD_TOKEN", undefined);
    const llmCommand = { name: "llm.invoke", run: vi.fn() };
    const runtime = {
      runToolRequest: vi.fn<Runtime["runToolRequest"]>().mockResolvedValue(success),
      resumeToolRequest: vi.fn<Runtime["resumeToolRequest"]>(),
      createDefaultRegistry: () => ({
        get: (name: string) => (name === "llm.invoke" ? llmCommand : undefined),
        list: () => ["llm.invoke"],
      }),
    };
    const llmAdapters = { embedded: { source: "openclaw-embedded", invoke: vi.fn() } };
    const runner = createEmbeddedLobsterRunner({
      loadRuntime: vi.fn().mockResolvedValue(runtime),
      llmAdapters,
      authorizeReplay: async () => {},
      authorizeCheckpoint: async () => {},
      describeCaller: () => ({ authority: [] }),
    });

    await runner.run(runParams());

    const context = runtime.runToolRequest.mock.calls[0]?.[0].ctx;
    expect(context?.llmAdapters).toBe(llmAdapters);
    // The LLM command reaches Lobster through the authorization wrapper, never bare.
    expect(context?.registry?.get("llm.invoke")).not.toBe(llmCommand);
    expect(context?.env?.LOBSTER_LLM_FORCE_REFRESH).toBeUndefined();
    expect(context?.env?.LOBSTER_LLM_PROVIDER).toBeUndefined();
    expect(context?.env?.OPENCLAW_URL).toBeUndefined();
    expect(context?.env?.OPENCLAW_TOKEN).toBeUndefined();
    expect(context?.env?.CLAWD_URL).toBeUndefined();
    expect(context?.env?.CLAWD_TOKEN).toBeUndefined();
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

  it("rejects an input request without a resumable checkpoint", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue({ ...success, status: "needs_input" });

    await expect(runner.run(runParams())).rejects.toThrow(
      "Lobster input request is missing its resume token",
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

  it("runs native llm.invoke through the host adapter and forwards schema retry context", async () => {
    vi.stubEnv("OPENCLAW_URL", undefined);
    vi.stubEnv("OPENCLAW_TOKEN", undefined);
    vi.stubEnv("CLAWD_URL", undefined);
    vi.stubEnv("CLAWD_TOKEN", undefined);
    vi.stubEnv("LOBSTER_STATE_DIR", tempDirs.make("openclaw-lobster-llm-invoke-"));
    const payloads: unknown[] = [];
    const responses = [
      { ok: true, result: { output: { text: "not-json", data: "not-json", format: "text" } } },
      {
        ok: true,
        result: {
          model: "openai/test-model",
          output: {
            text: JSON.stringify({ category: "school" }),
            data: { category: "school" },
            format: "json",
          },
        },
      },
    ];
    const llmAdapters = {
      embedded: {
        source: "openclaw-embedded",
        invoke: vi.fn(async ({ payload }: { payload: unknown }) => {
          payloads.push(payload);
          return responses[payloads.length - 1];
        }),
      },
    };
    const runner = createEmbeddedLobsterRunner({
      llmAdapters,
      authorizeReplay: async () => {},
      authorizeCheckpoint: async () => {},
      describeCaller: () => ({ authority: [] }),
    });
    const schema = JSON.stringify({
      type: "object",
      properties: { category: { type: "string" } },
      required: ["category"],
      additionalProperties: false,
    });
    const pipeline =
      "llm.invoke --provider embedded --prompt classify --output-schema '" +
      schema +
      "' --max-validation-retries 1 --disable-cache";

    const result = await runner.run(runParams({ pipeline, maxStdoutBytes: 16_384 }));

    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({
      prompt: "classify",
      retryContext: { attempt: 2 },
    });
    expect(result).toMatchObject({
      ok: true,
      status: "ok",
      output: [
        expect.objectContaining({
          kind: "llm.invoke",
          output: expect.objectContaining({ data: { category: "school" }, format: "json" }),
        }),
      ],
    });
  });

  it("leaves the existing openclaw HTTP provider route unshadowed by the embedded adapter", async () => {
    vi.stubEnv("OPENCLAW_URL", undefined);
    vi.stubEnv("CLAWD_URL", undefined);
    vi.stubEnv("LOBSTER_STATE_DIR", tempDirs.make("openclaw-lobster-route-"));
    const invoke = vi.fn();
    const runner = createEmbeddedLobsterRunner({
      llmAdapters: { embedded: { source: "openclaw-embedded", invoke } },
      authorizeReplay: async () => {},
      authorizeCheckpoint: async () => {},
      describeCaller: () => ({ authority: [] }),
    });
    const schema = JSON.stringify({ type: "object", additionalProperties: true });
    const pipeline =
      "llm.invoke --provider openclaw --prompt classify --output-schema '" +
      schema +
      "' --disable-cache";

    // provider=openclaw must still resolve to Lobster's HTTP route and fail
    // closed without a Gateway URL, rather than silently reaching the embedded
    // in-process adapter registered under a different provider id.
    await expect(runner.run(runParams({ pipeline, maxStdoutBytes: 16_384 }))).rejects.toThrow(
      /OPENCLAW_URL/,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps a provider-omitted workflow on its configured Gateway HTTP route", async () => {
    vi.stubEnv("OPENCLAW_URL", "http://127.0.0.1:1/");
    vi.stubEnv("CLAWD_URL", undefined);
    vi.stubEnv("LOBSTER_LLM_PROVIDER", undefined);
    vi.stubEnv("LOBSTER_PI_LLM_ADAPTER_URL", undefined);
    vi.stubEnv("LOBSTER_LLM_ADAPTER_URL", undefined);
    vi.stubEnv("LOBSTER_STATE_DIR", tempDirs.make("openclaw-lobster-omitted-route-"));
    const invoke = vi.fn();
    const runner = createEmbeddedLobsterRunner({
      llmAdapters: { embedded: { source: "openclaw-embedded", invoke } },
      authorizeReplay: async () => {},
      authorizeCheckpoint: async () => {},
      describeCaller: () => ({ authority: [] }),
    });

    // Lobster selects a sole direct adapter before OPENCLAW_URL, so without the
    // pinned provider this step would silently reach host-owned inference
    // instead of the Gateway HTTP route it used before the adapter existed.
    await expect(
      runner.run(runParams({ pipeline: "llm.invoke --prompt classify --disable-cache" })),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  describe("LLM stage authorization (real Lobster runtime)", () => {
    function stageEnv(dir: string) {
      vi.stubEnv("LOBSTER_CACHE_DIR", path.join(dir, "cache"));
      vi.stubEnv("LOBSTER_STATE_DIR", path.join(dir, "state"));
      for (const key of [
        "LOBSTER_LLM_PROVIDER",
        "OPENCLAW_URL",
        "CLAWD_URL",
        "LOBSTER_PI_LLM_ADAPTER_URL",
        "LOBSTER_LLM_ADAPTER_URL",
        "LOBSTER_LLM_FORCE_REFRESH",
        "LLM_TASK_FORCE_REFRESH",
      ]) {
        vi.stubEnv(key, undefined);
      }
    }

    function fixture() {
      const dir = tempDirs.make("openclaw-lobster-auth-");
      stageEnv(dir);
      let calls = 0;
      let denied = false;
      let replayAllowed = true;
      let checkpointAllowed = true;
      const replayChecks: unknown[] = [];
      const checkpointChecks: Array<LobsterCheckpointProvenance | undefined> = [];
      const caller = { agentId: "main", authority: ["operator.write"] };
      const runner = createEmbeddedLobsterRunner({
        llmAdapters: {
          embedded: {
            source: "openclaw-embedded",
            invoke: async () => {
              calls += 1;
              if (denied) {
                throw new Error("authority denied");
              }
              return { ok: true, result: { output: { format: "json", text: "{}", data: {} } } };
            },
          },
        },
        authorizeReplay: async (request) => {
          replayChecks.push(request);
          if (!replayAllowed) {
            throw new Error("replay not authorized");
          }
        },
        authorizeCheckpoint: async (provenance) => {
          checkpointChecks.push(provenance);
          if (!checkpointAllowed) {
            throw new Error("checkpoint not authorized");
          }
        },
        describeCaller: () => ({ ...caller, authority: [...caller.authority] }),
      });
      const run = (pipeline: string) =>
        runner.run(runParams({ pipeline, cwd: dir, maxStdoutBytes: 64_000 }));
      const workflow = async (
        pipeline: string,
        env: Record<string, string> = {},
        stepEnv: Record<string, string> = {},
      ) => {
        const filePath = path.join(dir, "flow.json");
        await fs.writeFile(
          filePath,
          JSON.stringify({ name: "auth", env, steps: [{ id: "llm", pipeline, env: stepEnv }] }),
        );
        return await runner.run(
          runParams({ pipeline: filePath, cwd: dir, maxStdoutBytes: 64_000 }),
        );
      };
      return {
        dir,
        run,
        workflow,
        runner,
        calls: () => calls,
        deny: () => {
          denied = true;
        },
        denyReplay: () => {
          replayAllowed = false;
        },
        setCheckpointAllowed: (allowed: boolean) => {
          checkpointAllowed = allowed;
        },
        resume: (decision: Partial<LobsterRunnerParams>) =>
          runner.run(
            runParams({
              action: "resume",
              pipeline: undefined,
              cwd: dir,
              maxStdoutBytes: 64_000,
              ...decision,
            }),
          ),
        replayChecks,
        checkpointChecks,
      };
    }

    async function endpoint() {
      let calls = 0;
      const server = createServer((req, res) => {
        calls += 1;
        req.resume();
        res.setHeader("content-type", "application/json");
        const result = { output: { format: "json", text: "{}", data: {} } };
        res.end(
          JSON.stringify(
            req.url === "/tools/invoke"
              ? { ok: true, result: { ok: true, result, details: { json: {} } } }
              : { ok: true, result },
          ),
        );
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      servers.push(server);
      const address = server.address() as AddressInfo;
      return { url: `http://127.0.0.1:${address.port}`, calls: () => calls };
    }

    const embedded = "llm.invoke --provider embedded --prompt registry-proof";
    const servers: Server[] = [];
    afterEach(async () => {
      await Promise.all(
        servers.splice(0).map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            }),
        ),
      );
    });

    async function jsonFiles(dir: string): Promise<string[]> {
      try {
        return (await fs.readdir(dir, { recursive: true })).filter((f) =>
          String(f).endsWith(".json"),
        );
      } catch {
        return [];
      }
    }

    it.each([false, true])(
      "never serves a saved embedded answer, even with --refresh false (run state: %s)",
      async (useState) => {
        const f = fixture();
        const pipeline = embedded + (useState ? " --state-key saved" : "");
        await f.run(pipeline);
        f.deny();
        await expect(f.run(pipeline + " --refresh false")).rejects.toThrow("authority denied");
        expect(f.calls()).toBe(2);
      },
    );

    it("ignores workflow and step refresh overrides on the embedded route", async () => {
      const f = fixture();
      const pipeline = embedded + " --refresh false --state-key saved";
      const env = { LOBSTER_LLM_FORCE_REFRESH: "0" };
      const stepEnv = { LOBSTER_LLM_FORCE_REFRESH: "false" };
      await f.workflow(pipeline, env, stepEnv);
      f.deny();
      await expect(f.workflow(pipeline, env, stepEnv)).rejects.toThrow("authority denied");
      expect(f.calls()).toBe(2);
    });

    it("writes no embedded answer to the cache or run state", async () => {
      const f = fixture();
      await f.run(embedded + " --state-key saved");
      expect(await jsonFiles(path.join(f.dir, "cache"))).toEqual([]);
      expect(
        (await jsonFiles(path.join(f.dir, "state"))).filter((x) => x.includes("saved")),
      ).toEqual([]);
      expect(f.replayChecks).toEqual([]);
    });

    it("re-executes an embedded stage on resume rather than replaying it", async () => {
      const f = fixture();
      await f.run(embedded);
      const paused = await f.run("approve --emit | " + embedded + " --refresh false");
      expect(paused).toMatchObject({ ok: true, status: "needs_approval" });
      if (!paused.ok || !paused.requiresApproval?.resumeToken) {
        throw new Error("expected a resume token");
      }
      f.deny();
      await expect(
        f.runner.run(
          runParams({
            action: "resume",
            pipeline: undefined,
            token: paused.requiresApproval.resumeToken,
            approve: true,
            cwd: f.dir,
          }),
        ),
      ).rejects.toThrow("authority denied");
      expect(f.calls()).toBe(2);
    });

    function approvalToken(envelope: Awaited<ReturnType<ReturnType<typeof fixture>["run"]>>) {
      if (!envelope.ok || envelope.status !== "needs_approval") {
        throw new Error("expected an approval checkpoint");
      }
      const token = envelope.requiresApproval?.resumeToken;
      if (!token) {
        throw new Error("expected a resume token");
      }
      return token;
    }

    const embeddedProvenance = {
      version: 1,
      stages: [{ provider: "embedded", command: "llm.invoke" }],
      caller: { agentId: "main", authority: ["operator.write"] },
    };

    it("authorizes a checkpoint holding embedded output before a resume returns it", async () => {
      const f = fixture();
      const paused = await f.run(embedded + " | approve --emit --prompt use-answer");
      const token = approvalToken(paused);
      expect(f.calls()).toBe(1);
      f.setCheckpointAllowed(false);
      await expect(f.resume({ token, approve: true })).rejects.toThrow("checkpoint not authorized");
      expect(f.checkpointChecks).toEqual([embeddedProvenance]);
      // The refusal came before Lobster claimed the checkpoint, so an authorized
      // caller can still resume it, and the stage is not run again.
      f.setCheckpointAllowed(true);
      await expect(f.resume({ token, approve: true })).resolves.toMatchObject({
        ok: true,
        status: "ok",
        output: [expect.objectContaining({ source: "openclaw-embedded" })],
      });
      expect(f.calls()).toBe(1);
    });

    it("authorizes a workflow checkpoint before a later step consumes embedded output", async () => {
      const f = fixture();
      const filePath = path.join(f.dir, "consume.json");
      const consumed = path.join(f.dir, "consumed.json");
      await fs.writeFile(
        filePath,
        JSON.stringify({
          name: "consume",
          steps: [
            { id: "ask", pipeline: embedded, approval: "Use the answer?" },
            { id: "use", command: "cat > consumed.json", stdin: "$ask.stdout" },
          ],
        }),
      );
      const paused = await f.runner.run(
        runParams({ pipeline: filePath, cwd: f.dir, maxStdoutBytes: 64_000 }),
      );
      const token = approvalToken(paused);
      f.setCheckpointAllowed(false);
      await expect(f.resume({ token, approve: true })).rejects.toThrow("checkpoint not authorized");
      await expect(fs.stat(consumed)).rejects.toMatchObject({ code: "ENOENT" });
      // A rejected approval does not end a workflow, so it is gated as well.
      await expect(f.resume({ token, approve: false })).rejects.toThrow(
        "checkpoint not authorized",
      );
      await expect(fs.stat(consumed)).rejects.toMatchObject({ code: "ENOENT" });
      expect(f.checkpointChecks).toEqual([embeddedProvenance, embeddedProvenance]);
      f.setCheckpointAllowed(true);
      await expect(f.resume({ token, approve: true })).resolves.toMatchObject({
        ok: true,
        status: "ok",
      });
      expect(JSON.parse(await fs.readFile(consumed, "utf8"))).toMatchObject({
        source: "openclaw-embedded",
      });
      expect(f.calls()).toBe(1);
    });

    it("carries embedded provenance through later checkpoints of the same run", async () => {
      const f = fixture();
      const first = approvalToken(
        await f.run(embedded + " | approve --emit --prompt one | approve --emit --prompt two"),
      );
      const second = approvalToken(await f.resume({ token: first, approve: true }));
      f.setCheckpointAllowed(false);
      await expect(f.resume({ token: second, approve: true })).rejects.toThrow(
        "checkpoint not authorized",
      );
      expect(f.checkpointChecks).toEqual([embeddedProvenance, embeddedProvenance]);
    });

    it("records a checkpoint without LLM output as carrying none", async () => {
      const f = fixture();
      const token = approvalToken(await f.run("approve --emit --prompt plain"));
      await expect(f.resume({ token, approve: true })).resolves.toMatchObject({ status: "ok" });
      expect(f.checkpointChecks).toEqual([{ version: 1, stages: [] }]);
    });

    it("hands an unrecorded checkpoint to the authorizer as unknown", async () => {
      const f = fixture();
      const untracked = createEmbeddedLobsterRunner();
      const paused = await untracked.run(
        runParams({ pipeline: "approve --emit --prompt legacy", cwd: f.dir }),
      );
      const token = approvalToken(paused);
      f.setCheckpointAllowed(false);
      await expect(f.resume({ token, approve: true })).rejects.toThrow("checkpoint not authorized");
      expect(f.checkpointChecks).toEqual([undefined]);
    });

    it("lets a caller cancel a checkpoint without disclosing it", async () => {
      const f = fixture();
      const token = approvalToken(await f.run(embedded + " | approve --emit --prompt drop"));
      f.setCheckpointAllowed(false);
      await expect(f.resume({ token, cancel: true })).resolves.toMatchObject({
        status: "cancelled",
        output: [],
      });
      expect(f.checkpointChecks).toEqual([]);
    });

    it("refuses to supply the embedded adapter without a checkpoint authorizer", async () => {
      const dir = tempDirs.make("openclaw-lobster-checkpoint-missing-");
      stageEnv(dir);
      const runner = createEmbeddedLobsterRunner({
        llmAdapters: { embedded: { source: "openclaw-embedded", invoke: vi.fn() } },
        authorizeReplay: vi.fn(),
      });
      await expect(runner.run(runParams({ cwd: dir }))).rejects.toThrow("checkpoint authorizer");
    });

    it("refuses a provider-omitted stage with no route instead of inferring embedded", async () => {
      const f = fixture();
      await expect(f.run("llm.invoke --prompt no-route")).rejects.toThrow("opt-in");
      expect(f.calls()).toBe(0);
    });

    it.each(["http", "pi", "openclaw"])(
      "keeps saved-answer reuse on the %s route, re-authorizing before it is shown",
      async (provider) => {
        const f = fixture();
        const e = await endpoint();
        vi.stubEnv("OPENCLAW_URL", e.url);
        vi.stubEnv("LOBSTER_PI_LLM_ADAPTER_URL", e.url);
        vi.stubEnv("LOBSTER_LLM_ADAPTER_URL", e.url);
        const pipeline = `llm.invoke --provider ${provider} --prompt reuse-proof`;
        await f.run(pipeline);
        expect(f.replayChecks).toEqual([]);
        const second = await f.run(pipeline);
        expect(second).toMatchObject({
          ok: true,
          output: [expect.objectContaining({ replayed: true })],
        });
        expect(f.replayChecks).toEqual([{ provider, command: "llm.invoke" }]);
        expect(e.calls()).toBe(1);
        expect(f.calls()).toBe(0);
      },
    );

    it("refuses a saved answer to a caller who is no longer authorized, on run and on resume", async () => {
      const f = fixture();
      const e = await endpoint();
      vi.stubEnv("LOBSTER_LLM_ADAPTER_URL", e.url);
      const pipeline = "llm.invoke --provider http --prompt gate-proof --state-key saved";
      await f.run(pipeline);
      const paused = await f.run("approve --emit | " + pipeline);
      if (!paused.ok || !paused.requiresApproval?.resumeToken) {
        throw new Error("expected a resume token");
      }
      f.denyReplay();
      await expect(f.run(pipeline)).rejects.toThrow("replay not authorized");
      await expect(
        f.runner.run(
          runParams({
            action: "resume",
            pipeline: undefined,
            token: paused.requiresApproval.resumeToken,
            approve: true,
            cwd: f.dir,
          }),
        ),
      ).rejects.toThrow("replay not authorized");
      expect(e.calls()).toBe(1);
    });

    it("resolves a provider-omitted route from the merged workflow and step environment", async () => {
      const f = fixture();
      const openclaw = await endpoint();
      await f.workflow("llm.invoke --prompt workflow-route", { OPENCLAW_URL: openclaw.url });
      expect(openclaw.calls()).toBe(1);
      const pi = await endpoint();
      vi.stubEnv("OPENCLAW_URL", "http://127.0.0.1:1");
      await f.workflow(
        "llm.invoke --prompt step-route",
        {},
        { LOBSTER_PI_LLM_ADAPTER_URL: pi.url },
      );
      expect(pi.calls()).toBe(1);
      expect(f.calls()).toBe(0);
    });

    it("refuses to supply the embedded adapter without a replay authorizer", async () => {
      const dir = tempDirs.make("openclaw-lobster-auth-missing-");
      stageEnv(dir);
      const runner = createEmbeddedLobsterRunner({
        llmAdapters: { embedded: { source: "openclaw-embedded", invoke: vi.fn() } },
      });
      await expect(runner.run(runParams({ cwd: dir }))).rejects.toThrow("replay authorizer");
    });
  });

  it("requires a pipeline for run", async () => {
    const { runner } = createRunner();

    await expect(runner.run(runParams({ pipeline: undefined }))).rejects.toThrow(
      /pipeline required/,
    );
  });

  it("requires a checkpoint and a decision for resume", async () => {
    const { runner } = createRunner();

    await expect(
      runner.run(runParams({ action: "resume", pipeline: undefined, approve: true })),
    ).rejects.toThrow(/token or approvalId required/);
    await expect(
      runner.run(runParams({ action: "resume", pipeline: undefined, token: "resume-token" })),
    ).rejects.toThrow(/exactly one/);
  });

  it.each([
    { responseJson: "{bad" },
    { responseJson: "" },
    { approve: true, responseJson: "null" },
    { cancel: true, responseJson: "null" },
    { cancel: true, approve: false },
    { cancel: false },
  ])(
    "rejects invalid or ambiguous resume arguments before touching state: %j",
    async (decision) => {
      const { runtime, runner } = createRunner();
      await expect(
        runner.run(runParams({ action: "resume", token: "resume-token", ...decision })),
      ).rejects.toThrow();
      expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["null", "false", "[]"])(
    "passes JSON values unchanged on resume: %s",
    async (responseJson) => {
      const { runtime, runner } = createRunner();
      runtime.resumeToolRequest.mockResolvedValue(success);
      await runner.run(runParams({ action: "resume", token: "resume-token", responseJson }));
      expect(runtime.resumeToolRequest).toHaveBeenCalledExactlyOnceWith({
        token: "resume-token",
        response: JSON.parse(responseJson),
        ctx: toolContext(),
      });
    },
  );

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
