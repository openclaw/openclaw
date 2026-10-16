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
import { createEmbeddedLobsterRunner } from "./lobster-runner.js";
import { createLobsterTool } from "./lobster-tool.js";

vi.mock("./lobster-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lobster-runner.js")>();
  return { ...actual, createEmbeddedLobsterRunner: vi.fn(actual.createEmbeddedLobsterRunner) };
});

afterEach(() => vi.mocked(createEmbeddedLobsterRunner).mockReset());

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

  it("normalizes numeric string run limits before invoking the runner", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };

    vi.mocked(createEmbeddedLobsterRunner).mockReturnValueOnce(runner);
    const tool = createLobsterTool(fakeApi());
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

  it("requires action", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(tool.execute("call-action-missing", {})).rejects.toThrow(/action required/);
  });

  it("rejects unknown action", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-action-unknown", {
        action: "explode",
      }),
    ).rejects.toThrow(/Unknown action/);
  });

  it("rejects absolute cwd", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-absolute-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/cwd must be a relative path/);
  });

  it("rejects cwd that escapes the gateway working directory", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-escape-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "../../etc",
      }),
    ).rejects.toThrow(/must stay within/);
  });
});
