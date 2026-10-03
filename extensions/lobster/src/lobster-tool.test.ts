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
import * as lobsterGatewayScope from "./lobster-gateway-scope.js";
import * as lobsterRunner from "./lobster-runner.js";
import { createLobsterTool } from "./lobster-tool.js";

afterEach(() => vi.unstubAllEnvs());

// A real request always carries the gateway request scope, which the host binds.
// Stub the guard here so these adapter tests stay about the adapter, and cover the
// real guard in lobster-gateway-scope.test.ts.
const gatewayScopeSpy = vi
  .spyOn(lobsterGatewayScope, "assertEmbeddedRouteRunsInGateway")
  .mockImplementation(() => {});

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
    const tool = createLobsterTool(fakeApi());
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
    expect(second.details).toMatchObject({ status: "needs_approval" });
    const approvalToken = resumeToken(second.details, "requiresApproval");
    const approved = await tool.execute("approve", {
      action: "resume",
      token: approvalToken,
      approve: true,
    });
    expect(approved.details).toMatchObject({
      status: "ok",
      output: [{ decision: "approve", feedback: "Looks good" }],
    });
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

  it("routes native Lobster LLM stages through host-owned isolated completion", async () => {
    const complete = vi.fn().mockResolvedValue({
      text: "```json\n{}\n```",
      provider: "openai",
      model: "openai/default-model",
      usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
    });
    const runtime = {
      version: "test",
      subagent: { complete },
    } as unknown as OpenClawPluginApi["runtime"];
    const runner = { run: vi.fn() };
    const runnerFactory = vi
      .spyOn(lobsterRunner, "createEmbeddedLobsterRunner")
      .mockReturnValue(runner);
    try {
      createLobsterTool(fakeApi({ runtime }), { callerAgentId: "caller-agent" });
      const adapters = runnerFactory.mock.calls[0]?.[0]?.llmAdapters;
      expect(adapters?.openclaw).toBeUndefined();
      const adapter = adapters?.embedded;
      if (!adapter) {
        throw new Error("expected an OpenClaw LLM adapter");
      }
      const outputSchema = {
        type: "object",
        properties: { category: { type: "string" } },
        required: ["category"],
        additionalProperties: false,
      };
      const signal = new AbortController().signal;
      const result = await adapter.invoke({
        args: { provider: "embedded" },
        payload: {
          prompt: "Classify this synthetic item",
          artifacts: [{ kind: "text", text: "Picture day Thursday" }],
          outputSchema,
          metadata: { lane: "triage" },
          schemaVersion: "v2",
          retryContext: { attempt: 2, validationErrors: ["category is required"] },
          temperature: 0.1,
          maxOutputTokens: 128,
        },
        signal,
      });

      // Runs as the calling agent, through the host's background inference, which
      // applies that agent's model, fallback chain and operator authority.
      expect(complete).toHaveBeenCalledExactlyOnceWith({
        agentId: "caller-agent",
        message: JSON.stringify({
          prompt: "Classify this synthetic item",
          artifacts: [{ kind: "text", text: "Picture day Thursday" }],
          outputSchema,
          metadata: { lane: "triage" },
          schemaVersion: "v2",
          retryContext: { attempt: 2, validationErrors: ["category is required"] },
        }),
        extraSystemPrompt: expect.stringContaining("do not call tools"),
        timeoutMs: 30_000,
        signal,
      });
      // No model named: the agent's configured default and failover chain apply.
      expect(vi.mocked(complete).mock.calls[0]?.[0].model).toBeUndefined();
      expect(result).toMatchObject({
        ok: true,
        result: { output: { text: "{}", data: {}, format: "json" } },
      });
    } finally {
      runnerFactory.mockRestore();
    }
  });

  it.each(["not-json", "null"])(
    "distinguishes malformed output from JSON null: %s",
    async (text) => {
      const complete = vi.fn().mockResolvedValue({ text, model: "test-model" });
      const runtime = { subagent: { complete } } as unknown as OpenClawPluginApi["runtime"];
      const runnerFactory = vi
        .spyOn(lobsterRunner, "createEmbeddedLobsterRunner")
        .mockReturnValue({ run: vi.fn() });
      try {
        createLobsterTool(fakeApi({ runtime }), { callerAgentId: "caller-agent" });
        const adapter = runnerFactory.mock.calls[0]?.[0]?.llmAdapters?.embedded;
        if (!adapter) {
          throw new Error("expected an OpenClaw LLM adapter");
        }
        const result = adapter.invoke({
          args: { provider: "embedded" },
          payload: { prompt: "Return JSON", outputSchema: { type: ["object", "null"] } },
        });
        if (text === "null") {
          await expect(result).resolves.toMatchObject({
            ok: true,
            result: { output: { text: "null", data: null, format: "json" } },
          });
        } else {
          await expect(result).rejects.toThrow("returned invalid JSON");
        }
        expect(complete).toHaveBeenCalledTimes(1);
      } finally {
        runnerFactory.mockRestore();
      }
    },
  );

  it("refuses the embedded route without a calling agent rather than running as the plugin owner", async () => {
    const complete = vi.fn();
    const runtime = {
      version: "test",
      subagent: { complete },
    } as unknown as OpenClawPluginApi["runtime"];
    const runnerFactory = vi
      .spyOn(lobsterRunner, "createEmbeddedLobsterRunner")
      .mockReturnValue({ run: vi.fn() });
    try {
      createLobsterTool(fakeApi({ runtime }));
      const adapter = runnerFactory.mock.calls[0]?.[0]?.llmAdapters?.embedded;
      if (!adapter) {
        throw new Error("expected an OpenClaw LLM adapter");
      }
      await expect(
        adapter.invoke({ args: { provider: "embedded" }, payload: { prompt: "Classify" } }),
      ).rejects.toThrow("requires the calling agent");
      expect(complete).not.toHaveBeenCalled();
    } finally {
      runnerFactory.mockRestore();
    }
  });

  it("binds the tool to the agent of the calling session", () => {
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    const runnerFactory = vi
      .spyOn(lobsterRunner, "createEmbeddedLobsterRunner")
      .mockReturnValue({ run: vi.fn() });
    try {
      plugin.register(fakeApi({ registerTool }));
      const factory = registerTool.mock.calls[0]?.[0];
      if (typeof factory !== "function") {
        throw new Error("expected a registered Lobster tool factory");
      }
      factory(fakeCtx({ agentId: "work" }));
      const options = runnerFactory.mock.calls[0]?.[0];
      expect(options?.authorizeReplay).toBeTypeOf("function");
      expect(options?.llmAdapters?.embedded).toBeDefined();
    } finally {
      runnerFactory.mockRestore();
    }
  });

  it("propagates host model authorization rejection for an explicit workflow override", async () => {
    const denied = new Error("Plugin LLM completion model is not allowlisted");
    const complete = vi.fn().mockRejectedValue(denied);
    const runtime = {
      version: "test",
      subagent: { complete },
    } as unknown as OpenClawPluginApi["runtime"];
    const runnerFactory = vi
      .spyOn(lobsterRunner, "createEmbeddedLobsterRunner")
      .mockReturnValue({ run: vi.fn() });
    try {
      createLobsterTool(fakeApi({ runtime }), { callerAgentId: "caller-agent" });
      const adapter = runnerFactory.mock.calls[0]?.[0]?.llmAdapters?.embedded;
      if (!adapter) {
        throw new Error("expected an OpenClaw LLM adapter");
      }
      await expect(
        adapter.invoke({
          args: { provider: "embedded" },
          payload: { prompt: "Classify this synthetic item", model: "openai/blocked-model" },
        }),
      ).rejects.toBe(denied);
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({ model: "openai/blocked-model" }),
      );
    } finally {
      runnerFactory.mockRestore();
    }
  });

  it("requires an explicit embedded route and refuses a provider-omitted step", async () => {
    const complete = vi.fn().mockResolvedValue({ text: '{"category":"synthetic"}' });
    const runtime = {
      version: "test",
      subagent: { complete },
    } as unknown as OpenClawPluginApi["runtime"];
    const runnerFactory = vi
      .spyOn(lobsterRunner, "createEmbeddedLobsterRunner")
      .mockReturnValue({ run: vi.fn() });
    try {
      createLobsterTool(fakeApi({ runtime }), { callerAgentId: "caller-agent" });
      const adapter = runnerFactory.mock.calls[0]?.[0]?.llmAdapters?.embedded;
      if (!adapter) {
        throw new Error("expected an OpenClaw LLM adapter");
      }

      // A step that omits --provider reaches this adapter through Lobster's
      // sole-adapter fallback, which is not an explicit opt-in, so it must be
      // refused rather than served by the ambient owner's credentials.
      await expect(
        adapter.invoke({
          args: { prompt: "Classify this synthetic item" },
          payload: { prompt: "Classify this synthetic item" },
        }),
      ).rejects.toThrow("opt-in");
      expect(complete).not.toHaveBeenCalled();

      // Naming the route in the workflow environment stays a valid opt-in.
      await expect(
        adapter.invoke({
          env: { LOBSTER_LLM_PROVIDER: "embedded" },
          payload: { prompt: "Classify this synthetic item" },
        }),
      ).resolves.toBeDefined();
      expect(complete).toHaveBeenCalledTimes(1);
      // The gateway scope validation runs before host inference is spent.
      expect(gatewayScopeSpy).toHaveBeenCalled();
    } finally {
      runnerFactory.mockRestore();
    }
  });

  it("returns approval envelopes for ordinary runs", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "needs_approval",
        output: [],
        requiresApproval: {
          type: "approval_request",
          prompt: "Continue?",
          items: [],
          resumeToken: "resume-token-1",
        },
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call-ordinary-run", {
      action: "run",
      pipeline: "noop",
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "ordinary run details");
    expect(details).toEqual({
      ok: true,
      status: "needs_approval",
      output: [],
      requiresApproval: {
        type: "approval_request",
        prompt: "Continue?",
        items: [],
        resumeToken: "resume-token-1",
      },
    });
  });

  it("resumes ordinary workflows with approval credentials", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [{ approved: true }],
        requiresApproval: null,
      }),
    };

    const tool = createLobsterTool(fakeApi(), { runner });
    const res = await tool.execute("call-ordinary-resume", {
      action: "resume",
      token: "resume-token-1",
      approve: true,
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "resume",
      token: "resume-token-1",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxStdoutBytes: 512_000,
    });
    const details = requireRecord(res.details, "ordinary resume details");
    expect(details.ok).toBe(true);
    expect(details).toEqual({
      ok: true,
      status: "ok",
      output: [{ approved: true }],
      requiresApproval: null,
    });
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
