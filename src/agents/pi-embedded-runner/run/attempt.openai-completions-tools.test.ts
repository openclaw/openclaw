import type { Api, Model } from "@mariozechner/pi-ai";
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { discoverAuthStorage, discoverModels } from "../../pi-model-discovery.js";
import { runEmbeddedAttempt } from "./attempt.js";

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    createAgentSession: vi.fn(async () => {
      throw new Error("TEST_ABORT_CREATE_AGENT_SESSION");
    }),
  };
});

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

function createVllmModel(params: { enableCompatFlag: boolean }): Model<Api> {
  const compatBase = { supportsDeveloperRole: false } as unknown as Record<string, unknown>;
  if (params.enableCompatFlag) {
    compatBase.openaiCompletionsTools = true;
  }
  return {
    id: "Qwen2.5-1.5B",
    name: "Qwen2.5-1.5B",
    api: "openai-completions",
    provider: "vllm",
    baseUrl: "http://127.0.0.1:8001/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16384,
    maxTokens: 2048,
    compat: compatBase as never,
  } as unknown as Model<Api>;
}

describe("runEmbeddedAttempt (openai-completions tool routing)", () => {
  it("passes tools via builtIn tools when compat.openaiCompletionsTools is enabled", async () => {
    const mockedCreateAgentSession = vi.mocked(createAgentSession);
    mockedCreateAgentSession.mockClear();

    const agentDir = await makeTempDir("moltbot-agent");
    const workspaceDir = await makeTempDir("moltbot-workspace");
    const sessionFile = path.join(agentDir, "sessions", "session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });

    const authStorage = discoverAuthStorage(agentDir);
    const modelRegistry = discoverModels(authStorage, agentDir);
    const model = createVllmModel({ enableCompatFlag: true });

    await expect(
      runEmbeddedAttempt({
        sessionId: "session:test",
        sessionKey: "main:session:test",
        sessionFile,
        workspaceDir,
        agentDir,
        config: {} satisfies OpenClawConfig,
        prompt: "hi",
        provider: "vllm",
        modelId: model.id,
        model,
        authStorage,
        modelRegistry,
        thinkLevel: "off",
        timeoutMs: 1000,
        runId: "run:test",
        // Keep this fast and isolated; we only care about the createAgentSession call.
        disableTools: false,
      }),
    ).rejects.toThrow("TEST_ABORT_CREATE_AGENT_SESSION");

    expect(mockedCreateAgentSession).toHaveBeenCalledTimes(1);
    const opts = mockedCreateAgentSession.mock.calls[0]?.[0] as unknown as {
      tools?: Array<{ name?: string }>;
      customTools?: Array<{ name?: string }>;
    };

    const toolNames = (opts.tools ?? []).map((t) => t.name).filter(Boolean);
    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames).toContain("read");
    expect(opts.customTools ?? []).toEqual([]);
  });

  it("defaults to customTools when compat.openaiCompletionsTools is not enabled", async () => {
    const mockedCreateAgentSession = vi.mocked(createAgentSession);
    mockedCreateAgentSession.mockClear();

    const agentDir = await makeTempDir("moltbot-agent");
    const workspaceDir = await makeTempDir("moltbot-workspace");
    const sessionFile = path.join(agentDir, "sessions", "session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });

    const authStorage = discoverAuthStorage(agentDir);
    const modelRegistry = discoverModels(authStorage, agentDir);
    const model = createVllmModel({ enableCompatFlag: false });

    await expect(
      runEmbeddedAttempt({
        sessionId: "session:test",
        sessionKey: "main:session:test",
        sessionFile,
        workspaceDir,
        agentDir,
        config: {} satisfies OpenClawConfig,
        prompt: "hi",
        provider: "vllm",
        modelId: model.id,
        model,
        authStorage,
        modelRegistry,
        thinkLevel: "off",
        timeoutMs: 1000,
        runId: "run:test",
        disableTools: false,
      }),
    ).rejects.toThrow("TEST_ABORT_CREATE_AGENT_SESSION");

    expect(mockedCreateAgentSession).toHaveBeenCalledTimes(1);
    const opts = mockedCreateAgentSession.mock.calls[0]?.[0] as unknown as {
      tools?: Array<{ name?: string }>;
      customTools?: Array<{ name?: string }>;
    };
    expect(opts.tools ?? []).toEqual([]);

    const customToolNames = (opts.customTools ?? []).map((t) => t.name).filter(Boolean);
    expect(customToolNames.length).toBeGreaterThan(0);
    expect(customToolNames).toContain("read");
  });
});
