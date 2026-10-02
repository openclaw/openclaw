import fs from "node:fs/promises";
import path from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { createLobsterTool } from "./lobster-tool.js";

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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resumeToken(details: unknown, field = "requiresInput") {
  const envelope = requireRecord(details, "Lobster envelope");
  const request = requireRecord(envelope[field], field);
  if (typeof request.resumeToken !== "string") {
    throw new Error("expected a resume token");
  }
  return request.resumeToken;
}

describe("lobster plugin tool", () => {
  it("resumes real pipeline input, preserves invalid answers, and still handles approvals", async () => {
    vi.stubEnv("LOBSTER_STATE_DIR", tempDirs.make("openclaw-lobster-input-"));
    const request = vi.fn(async () => ({ decision: "allow-once" }));
    const tool = createLobsterTool(
      fakeApi({ runtime: { version: "test", gateway: { request } } as never }),
      { context: fakeCtx({ assertInvocationCurrent: vi.fn() }) },
    );
    const first = await tool.execute("run", {
      action: "run",
      pipeline: 'ask --prompt "Review draft?" | approve --prompt "Publish?"',
    });
    expect(first.details).toMatchObject({
      status: "needs_input",
      requiresInput: { type: "input_request", prompt: "Review draft?" },
    });
    const token = resumeToken(first.details);
    await expect(
      tool.execute("invalid", { action: "resume", token, responseJson: '{"decision":123}' }),
    ).rejects.toThrow(/schema validation/);
    const second = await tool.execute("answer", {
      action: "resume",
      token,
      responseJson: '{"decision":"approve","feedback":"Looks good"}',
    });
    expect(second.details).toMatchObject({
      status: "ok",
      output: [{ decision: "approve", feedback: "Looks good" }],
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(second)).not.toContain("resumeToken");
    expect(JSON.stringify(second)).not.toContain("approvalId");
    await expect(
      tool.execute("replay", { action: "resume", token, responseJson: '{"decision":"reject"}' }),
    ).rejects.toThrow(/not found/i);
  });

  it("resumes real workflow files through successive questions without repeating preparation", async () => {
    const dir = tempDirs.make("openclaw-lobster-workflow-input-");
    vi.stubEnv("LOBSTER_STATE_DIR", dir);
    const seed = path.join(dir, "seed.json");
    await fs.writeFile(seed, JSON.stringify({ draft: "original" }));
    const file = path.join(dir, "review.lobster");
    await fs.writeFile(
      file,
      JSON.stringify({
        steps: [
          { id: "prepare", pipeline: "state.get seed | state.set prepared" },
          {
            id: "review",
            input: {
              prompt: "Review draft?",
              responseSchema: {
                type: "object",
                properties: { feedback: { type: "string" } },
                required: ["feedback"],
              },
              defaults: { feedback: "" },
            },
          },
          {
            id: "confirm",
            input: {
              prompt: "Which label?",
              responseSchema: { type: "string" },
            },
          },
          { id: "finish", pipeline: "state.get prepared" },
        ],
      }),
    );
    const tool = createLobsterTool(fakeApi());
    const first = await tool.execute("run", { action: "run", pipeline: file });
    expect(first.details).toMatchObject({
      status: "needs_input",
      requiresInput: { defaults: { feedback: "" }, subject: { draft: "original" } },
    });
    await fs.writeFile(seed, JSON.stringify({ draft: "changed" }));
    const second = await tool.execute("answer", {
      action: "resume",
      token: resumeToken(first.details),
      responseJson: '{"feedback":"Keep it"}',
    });
    expect(second.details).toMatchObject({
      status: "needs_input",
      requiresInput: { prompt: "Which label?" },
    });
    // A new tool instance proves continuation comes from saved state, not the runner's memory.
    const finished = await createLobsterTool(fakeApi()).execute("finish", {
      action: "resume",
      token: resumeToken(second.details),
      responseJson: '"reviewed"',
    });
    expect(finished.details).toMatchObject({ status: "ok", output: [{ draft: "original" }] });
  });

  it.each(["allow-once", "deny"] as const)(
    "keeps a real workflow side effect behind the operator's %s decision",
    async (operatorDecision) => {
      const dir = tempDirs.make("openclaw-lobster-approval-effect-");
      vi.stubEnv("LOBSTER_STATE_DIR", dir);
      let resolveDecision!: (value: { decision: typeof operatorDecision }) => void;
      const decision = new Promise<{ decision: typeof operatorDecision }>((resolve) => {
        resolveDecision = resolve;
      });
      let requestStarted!: () => void;
      const requested = new Promise<void>((resolve) => {
        requestStarted = resolve;
      });
      const request = vi.fn(() => {
        requestStarted();
        return decision;
      });
      const tool = createLobsterTool(
        fakeApi({ runtime: { version: "test", gateway: { request } } as never }),
        { context: fakeCtx({ assertInvocationCurrent: vi.fn() }) },
      );
      const effect = path.join(dir, "committed.json");

      const first = await tool.execute("prepare", {
        action: "run",
        pipeline: 'ask --prompt "Value?" | approve --prompt "Write?" | state.set committed',
      });
      const pending = tool.execute("write-after-approval", {
        action: "resume",
        token: resumeToken(first.details),
        responseJson: '{"decision":"approve","approved":true}',
      });
      await Promise.race([
        requested,
        pending.then(() => {
          throw new Error("workflow returned before requesting operator approval");
        }),
      ]);
      await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
      resolveDecision({ decision: operatorDecision });
      const result = await pending;

      expect(result.details).toMatchObject({
        status: operatorDecision === "allow-once" ? "ok" : "cancelled",
      });
      if (operatorDecision === "allow-once") {
        expect(JSON.parse(await fs.readFile(effect, "utf8"))).toEqual({
          decision: "approve",
          approved: true,
        });
      } else {
        await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(JSON.stringify(result)).not.toContain("resumeToken");
      expect(JSON.stringify(result)).not.toContain("approvalId");
    },
  );

  it("cancels a real input checkpoint without executing its remaining steps", async () => {
    const dir = tempDirs.make("openclaw-lobster-input-cancel-");
    vi.stubEnv("LOBSTER_STATE_DIR", dir);
    const tool = createLobsterTool(fakeApi());
    const first = await tool.execute("run", {
      action: "run",
      pipeline: "ask | state.set should-not-exist",
    });
    const token = resumeToken(first.details);
    const cancelled = await tool.execute("cancel", { action: "resume", token, cancel: true });
    expect(cancelled.details).toMatchObject({ status: "cancelled" });
    await expect(fs.stat(path.join(dir, "should-not-exist.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      tool.execute("resume", {
        action: "resume",
        token,
        responseJson: '{"decision":"approve"}',
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("cancels a pre-existing approval checkpoint without executing or replaying it", async () => {
    const dir = tempDirs.make("openclaw-lobster-legacy-approval-cancel-");
    vi.stubEnv("LOBSTER_STATE_DIR", dir);
    const env = { ...process.env };
    const coreSpecifier = ["@clawdbot", "lobster", "core"].join("/");
    const core = (await import(coreSpecifier)) as {
      runToolRequest: (params: {
        pipeline: string;
        ctx: { cwd: string; env: NodeJS.ProcessEnv };
      }) => Promise<unknown>;
      resumeToolRequest: (params: {
        token: string;
        approved: boolean;
        ctx: { cwd: string; env: NodeJS.ProcessEnv };
      }) => Promise<{ ok: boolean; error?: { message: string } }>;
    };
    // This persisted checkpoint predates the plugin invocation that retires it.
    const checkpoint = await core.runToolRequest({
      pipeline: 'approve --prompt "Write?" | state.set should-not-exist',
      ctx: { cwd: dir, env },
    });
    expect(checkpoint).toMatchObject({ ok: true, status: "needs_approval" });
    const token = resumeToken(checkpoint, "requiresApproval");
    const effectPath = path.join(dir, "should-not-exist.json");
    await expect(fs.stat(effectPath)).rejects.toMatchObject({ code: "ENOENT" });

    const tool = createLobsterTool(fakeApi());
    const cancelled = await tool.execute("retire-old-approval", {
      action: "resume",
      token,
      cancel: true,
    });
    expect(cancelled.details).toMatchObject({ status: "cancelled" });
    await expect(fs.stat(effectPath)).rejects.toMatchObject({ code: "ENOENT" });

    const replay = await core.resumeToolRequest({ token, approved: true, ctx: { cwd: dir, env } });
    expect(replay).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/not found/i) },
    });
    await expect(fs.stat(effectPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("registers ordinary execution without a task runtime and keeps sandbox gating", () => {
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    plugin.register(fakeApi({ registerTool }));
    const factory = registerTool.mock.calls[0]?.[0];
    if (typeof factory !== "function") {
      throw new Error("expected a registered Lobster tool factory");
    }
    expect(factory(fakeCtx())).toMatchObject({ name: "lobster" });
    expect(factory(fakeCtx({ sandboxed: true }))).toBeNull();
  });

  it("fails closed when no operator approval route is available", async () => {
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_approval",
          output: [],
          requiresApproval: {
            type: "approval_request",
            prompt: "Continue?",
            items: [],
            resumeToken: "resume-token-1",
            approvalId: "approval-id-1",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "cancelled",
          output: [],
          requiresApproval: null,
        }),
    };
    const request = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const tool = createLobsterTool(
      fakeApi({ runtime: { version: "test", gateway: { request } } as never }),
      { runner, context: fakeCtx({ assertInvocationCurrent: vi.fn() }) },
    );
    await expect(
      tool.execute("call-ordinary-run", { action: "run", pipeline: "noop" }),
    ).rejects.toThrow("Lobster approval route unavailable; workflow was not approved");

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: "resume", token: "resume-token-1", approve: false }),
    );
  });

  it.each([
    {
      field: "prompt",
      prompt: "p".repeat(513),
      items: [],
      error:
        "Lobster approval prompt exceeds the Gateway's 512-character review limit; shorten the approval prompt and rerun the workflow",
    },
    {
      field: "preview",
      prompt: "Publish?",
      items: ["x".repeat(16_381)],
      error:
        "Lobster approval preview exceeds the Gateway's 16,384-character review limit; reduce the approval items and rerun the workflow",
    },
    {
      field: "preview with 9,000 emoji",
      prompt: "Publish?",
      items: ["\u{1F600}".repeat(9_000)],
      error:
        "Lobster approval preview exceeds the Gateway's 16,384-character review limit; reduce the approval items and rerun the workflow",
    },
    {
      field: "preview with 3,000 zero-width characters",
      prompt: "Publish?",
      items: ["\u200B".repeat(3_000)],
      error:
        "Lobster approval preview exceeds the Gateway's 16,384-character review limit; reduce the approval items and rerun the workflow",
    },
  ])(
    "denies an oversized approval $field with an actionable error",
    async ({ prompt, items, error }) => {
      const runner = {
        run: vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            status: "needs_approval",
            output: [],
            requiresApproval: {
              type: "approval_request",
              prompt,
              items,
              resumeToken: "private-resume-token",
            },
          })
          .mockResolvedValueOnce({
            ok: true,
            status: "cancelled",
            output: [],
            requiresApproval: null,
          }),
      };
      const request = vi.fn(async () => ({ decision: "allow-once" }));
      const tool = createLobsterTool(
        fakeApi({ runtime: { version: "test", gateway: { request } } as never }),
        { runner, context: fakeCtx({ assertInvocationCurrent: vi.fn() }) },
      );

      await expect(
        tool.execute("oversized-approval", { action: "run", pipeline: "publish" }),
      ).rejects.toMatchObject({ message: error });
      expect(request).not.toHaveBeenCalled();
      expect(runner.run).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          action: "resume",
          token: "private-resume-token",
          approve: false,
        }),
      );
    },
  );

  it("keeps approval credentials off the tool result until an operator decides", async () => {
    let resolveDecision!: (value: { decision: "allow-once" }) => void;
    const decision = new Promise<{ decision: "allow-once" }>((resolve) => {
      resolveDecision = resolve;
    });
    let requestStarted!: () => void;
    const requested = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const request = vi.fn(() => {
      requestStarted();
      return decision;
    });
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_approval",
          output: [],
          requiresApproval: {
            type: "approval_request",
            prompt: "Publish the draft?",
            items: [{ action: "publish" }],
            resumeToken: "private-resume-token",
            approvalId: "private-approval-id",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "ok",
          output: [{ published: true }],
          requiresApproval: null,
        }),
    };
    const assertInvocationCurrent = vi.fn();
    const tool = createLobsterTool(
      fakeApi({ runtime: { version: "test", gateway: { request } } as never }),
      {
        runner,
        context: fakeCtx({
          agentId: "main",
          sessionKey: "agent:main:main",
          assertInvocationCurrent,
        }),
      },
    );

    const pendingResult = tool.execute("operator-gated", { action: "run", pipeline: "publish" });
    const firstSettled = await Promise.race([
      requested.then(() => "operator-requested"),
      pendingResult.then(() => "tool-returned"),
    ]);
    expect(firstSettled).toBe("operator-requested");
    expect(runner.run).toHaveBeenCalledTimes(1);
    resolveDecision({ decision: "allow-once" });
    const result = await pendingResult;

    expect(request).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.objectContaining({
        title: "Lobster workflow approval",
        description: "Publish the draft?",
        allowedDecisions: ["allow-once", "deny"],
        agentId: "main",
        sessionKey: "agent:main:main",
        toolCallId: "operator-gated",
      }),
      expect.anything(),
    );
    expect(JSON.stringify(request.mock.calls)).not.toContain("private-resume-token");
    expect(JSON.stringify(request.mock.calls)).not.toContain("private-approval-id");
    expect(assertInvocationCurrent).toHaveBeenCalledTimes(2);
    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "resume",
        token: "private-resume-token",
        approve: true,
      }),
    );
    expect(result.details).toMatchObject({ status: "ok", output: [{ published: true }] });
    expect(JSON.stringify(result)).not.toContain("private-resume-token");
    expect(JSON.stringify(result)).not.toContain("private-approval-id");
  });

  it("denies an approval checkpoint when the operator declines", async () => {
    const request = vi.fn(async () => ({ decision: "deny" }));
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: "needs_approval",
          output: [],
          requiresApproval: {
            type: "approval_request",
            prompt: "Publish?",
            items: [],
            resumeToken: "private-resume-token",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: "cancelled",
          output: [],
          requiresApproval: null,
        }),
    };
    const tool = createLobsterTool(
      fakeApi({ runtime: { version: "test", gateway: { request } } as never }),
      { runner, context: fakeCtx({ assertInvocationCurrent: vi.fn() }) },
    );

    const result = await tool.execute("declined", { action: "run", pipeline: "publish" });

    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: "resume", token: "private-resume-token", approve: false }),
    );
    expect(result.details).toMatchObject({ status: "cancelled" });
    expect(JSON.stringify(result)).not.toContain("private-resume-token");
  });

  it("cannot request approval without live host invocation authority", async () => {
    const request = vi.fn(async () => ({ decision: "allow-once" }));
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Publish?",
          items: [],
          resumeToken: "private-resume-token",
        },
      }),
    };
    const tool = createLobsterTool(
      fakeApi({ runtime: { version: "test", gateway: { request } } as never }),
      { runner },
    );

    await expect(tool.execute("no-host", { action: "run", pipeline: "publish" })).rejects.toThrow(
      "Lobster approval requires an active host invocation",
    );
    expect(request).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("does not continue an approved checkpoint after its host invocation retires", async () => {
    let resolveDecision!: (value: { decision: "allow-once" }) => void;
    const decision = new Promise<{ decision: "allow-once" }>((resolve) => {
      resolveDecision = resolve;
    });
    let requestStarted!: () => void;
    const requested = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const request = vi.fn(() => {
      requestStarted();
      return decision;
    });
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Publish?",
          items: [],
          resumeToken: "private-resume-token",
        },
      }),
    };
    let current = true;
    const assertInvocationCurrent = vi.fn(() => {
      if (!current) {
        throw new Error("host invocation retired");
      }
    });
    const tool = createLobsterTool(
      fakeApi({ runtime: { version: "test", gateway: { request } } as never }),
      { runner, context: fakeCtx({ assertInvocationCurrent }) },
    );

    const pending = tool.execute("retired", { action: "run", pipeline: "publish" });
    await requested;
    current = false;
    resolveDecision({ decision: "allow-once" });

    await expect(pending).rejects.toThrow("host invocation retired");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("rejects model-supplied approval credentials or decisions", async () => {
    const runner = {
      run: vi.fn(),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    await expect(
      tool.execute("call-ordinary-resume", {
        action: "resume",
        token: "resume-token-1",
        approve: true,
      }),
    ).rejects.toThrow("operator-only");
    await expect(
      tool.execute("call-ordinary-resume", {
        action: "resume",
        approvalId: "approval-id-1",
        responseJson: "true",
      }),
    ).rejects.toThrow("operator-only");
    expect(tool.parameters.properties).not.toHaveProperty("approve");
    expect(tool.parameters.properties).not.toHaveProperty("approvalId");
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
      argsJson: '{"since_hours":1}',
      timeoutMs: "1500",
      maxStdoutBytes: "4096",
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
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
});
