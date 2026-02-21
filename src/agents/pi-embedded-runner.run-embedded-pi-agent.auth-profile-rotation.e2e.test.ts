import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedRunAttemptResult } from "./pi-embedded-runner/run/types.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();

vi.mock("./pi-embedded-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: (params: unknown) => runEmbeddedAttemptMock(params),
}));

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner.js").runEmbeddedPiAgent;

beforeAll(async () => {
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner.js"));
});

beforeEach(() => {
  vi.useRealTimers();
  runEmbeddedAttemptMock.mockReset();
});

const baseUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const buildAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-responses",
  provider: "openai",
  model: "mock-1",
  usage: baseUsage,
  stopReason: "stop",
  timestamp: Date.now(),
  ...overrides,
});

const makeAttempt = (overrides: Partial<EmbeddedRunAttemptResult>): EmbeddedRunAttemptResult => ({
  aborted: false,
  timedOut: false,
  timedOutDuringCompaction: false,
  promptError: null,
  sessionIdUsed: "session:test",
  systemPromptReport: undefined,
  messagesSnapshot: [],
  assistantTexts: [],
  toolMetas: [],
  lastAssistant: undefined,
  didSendViaMessagingTool: false,
  messagingToolSentTexts: [],
  messagingToolSentMediaUrls: [],
  messagingToolSentTargets: [],
  cloudCodeAssistFormatError: false,
  ...overrides,
});

const makeConfig = (opts?: { fallbacks?: string[]; apiKey?: string }): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        model: {
          fallbacks: opts?.fallbacks ?? [],
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: opts?.apiKey ?? "sk-test",
          baseUrl: "https://example.com",
          models: [
            {
              id: "mock-1",
              name: "Mock 1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  }) satisfies OpenClawConfig;

const writeAuthStore = async (
  agentDir: string,
  opts?: {
    includeAnthropic?: boolean;
    usageStats?: Record<string, { lastUsed?: number; cooldownUntil?: number }>;
  },
) => {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "openai:p1": { type: "api_key", provider: "openai", key: "sk-one" },
      "openai:p2": { type: "api_key", provider: "openai", key: "sk-two" },
      ...(opts?.includeAnthropic
        ? { "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-anth" } }
        : {}),
    },
    usageStats:
      opts?.usageStats ??
      ({
        "openai:p1": { lastUsed: 1 },
        "openai:p2": { lastUsed: 2 },
      } as Record<string, { lastUsed?: number }>),
  };
  await fs.writeFile(authPath, JSON.stringify(payload));
};

const mockFailedThenSuccessfulAttempt = (errorMessage = "rate limit") => {
  runEmbeddedAttemptMock
    .mockResolvedValueOnce(
      makeAttempt({
        assistantTexts: [],
        lastAssistant: buildAssistant({
          stopReason: "error",
          errorMessage,
        }),
      }),
    )
    .mockResolvedValueOnce(
      makeAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildAssistant({
          stopReason: "stop",
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );
};

async function runAutoPinnedOpenAiTurn(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
  authProfileId?: string;
}) {
  await runEmbeddedPiAgent({
    sessionId: "session:test",
    sessionKey: params.sessionKey,
    sessionFile: path.join(params.workspaceDir, "session.jsonl"),
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: makeConfig(),
    prompt: "hello",
    provider: "openai",
    model: "mock-1",
    authProfileId: params.authProfileId ?? "openai:p1",
    authProfileIdSource: "auto",
    timeoutMs: 5_000,
    runId: params.runId,
  });
}

async function readUsageStats(agentDir: string) {
  const stored = JSON.parse(
    await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf-8"),
  ) as { usageStats?: Record<string, { lastUsed?: number; cooldownUntil?: number }> };
  return stored.usageStats ?? {};
}

async function expectProfileP2UsageUpdated(agentDir: string) {
  const usageStats = await readUsageStats(agentDir);
  expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
}

async function expectProfileP2UsageUnchanged(agentDir: string) {
  const usageStats = await readUsageStats(agentDir);
  expect(usageStats["openai:p2"]?.lastUsed).toBe(2);
}

function mockSingleSuccessfulAttempt() {
  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildAssistant({
        stopReason: "stop",
        content: [{ type: "text", text: "ok" }],
      }),
    }),
  );
}

async function withTimedAgentWorkspace<T>(
  run: (ctx: { agentDir: string; workspaceDir: string; now: number }) => Promise<T>,
) {
  vi.useFakeTimers();
  try {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const now = Date.now();
    vi.setSystemTime(now);

    try {
      return await run({ agentDir, workspaceDir, now });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  } finally {
    vi.useRealTimers();
  }
}

async function runTurnWithCooldownSeed(params: {
  sessionKey: string;
  runId: string;
  authProfileId: string | undefined;
  authProfileIdSource: "auto" | "user";
}) {
  return await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
    await writeAuthStore(agentDir, {
      usageStats: {
        "openai:p1": { lastUsed: 1, cooldownUntil: now + 60 * 60 * 1000 },
        "openai:p2": { lastUsed: 2 },
      },
    });
    mockSingleSuccessfulAttempt();

    await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: params.sessionKey,
      sessionFile: path.join(workspaceDir, "session.jsonl"),
      workspaceDir,
      agentDir,
      config: makeConfig(),
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      authProfileId: params.authProfileId,
      authProfileIdSource: params.authProfileIdSource,
      timeoutMs: 5_000,
      runId: params.runId,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    return { usageStats: await readUsageStats(agentDir), now };
  });
}

describe("runEmbeddedPiAgent auth profile rotation", () => {
  it("rotates for auto-pinned profiles", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    try {
      await writeAuthStore(agentDir);
      mockFailedThenSuccessfulAttempt("rate limit");
      await runAutoPinnedOpenAiTurn({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:auto",
        runId: "run:auto",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      await expectProfileP2UsageUpdated(agentDir);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rotates when stream ends without sending chunks", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    try {
      await writeAuthStore(agentDir);
      mockFailedThenSuccessfulAttempt("request ended without sending any chunks");
      await runAutoPinnedOpenAiTurn({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:empty-chunk-stream",
        runId: "run:empty-chunk-stream",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      await expectProfileP2UsageUpdated(agentDir);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not rotate for compaction timeouts", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    try {
      await writeAuthStore(agentDir);

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          aborted: true,
          timedOut: true,
          timedOutDuringCompaction: true,
          assistantTexts: ["partial"],
          lastAssistant: buildAssistant({
            stopReason: "stop",
            content: [{ type: "text", text: "partial" }],
          }),
        }),
      );

      const result = await runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey: "agent:test:compaction-timeout",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig(),
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        authProfileId: "openai:p1",
        authProfileIdSource: "auto",
        timeoutMs: 5_000,
        runId: "run:compaction-timeout",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.meta.aborted).toBe(true);

      await expectProfileP2UsageUnchanged(agentDir);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not rotate for user-pinned profiles", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    try {
      await writeAuthStore(agentDir);

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: [],
          lastAssistant: buildAssistant({
            stopReason: "error",
            errorMessage: "rate limit",
          }),
        }),
      );

      await runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey: "agent:test:user",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig(),
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        authProfileId: "openai:p1",
        authProfileIdSource: "user",
        timeoutMs: 5_000,
        runId: "run:user",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      await expectProfileP2UsageUnchanged(agentDir);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("honors user-pinned profiles even when in cooldown", async () => {
    const { usageStats } = await runTurnWithCooldownSeed({
      sessionKey: "agent:test:user-cooldown",
      runId: "run:user-cooldown",
      authProfileId: "openai:p1",
      authProfileIdSource: "user",
    });

    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    expect(usageStats["openai:p1"]?.lastUsed).not.toBe(1);
    expect(usageStats["openai:p2"]?.lastUsed).toBe(2);
  });

  it("ignores user-locked profile when provider mismatches", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    try {
      await writeAuthStore(agentDir, { includeAnthropic: true });

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildAssistant({
            stopReason: "stop",
            content: [{ type: "text", text: "ok" }],
          }),
        }),
      );

      await runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey: "agent:test:mismatch",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: makeConfig(),
        prompt: "hello",
        provider: "openai",
        model: "mock-1",
        authProfileId: "anthropic:default",
        authProfileIdSource: "user",
        timeoutMs: 5_000,
        runId: "run:mismatch",
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("skips profiles in cooldown during initial selection", async () => {
    const { usageStats, now } = await runTurnWithCooldownSeed({
      sessionKey: "agent:test:skip-cooldown",
      runId: "run:skip-cooldown",
      authProfileId: undefined,
      authProfileIdSource: "auto",
    });

    expect(usageStats["openai:p1"]?.cooldownUntil).toBe(now + 60 * 60 * 1000);
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
  });

  it("fails over when all profiles are in cooldown and fallbacks are configured", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": { lastUsed: 1, cooldownUntil: now + 60 * 60 * 1000 },
          "openai:p2": { lastUsed: 2, cooldownUntil: now + 60 * 60 * 1000 },
        },
      });

      await expect(
        runEmbeddedPiAgent({
          sessionId: "session:test",
          sessionKey: "agent:test:cooldown-failover",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          workspaceDir,
          agentDir,
          config: makeConfig({ fallbacks: ["openai/mock-2"] }),
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          authProfileIdSource: "auto",
          timeoutMs: 5_000,
          runId: "run:cooldown-failover",
        }),
      ).rejects.toMatchObject({
        name: "FailoverError",
        reason: "rate_limit",
        provider: "openai",
        model: "mock-1",
      });

      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    });
  });

  it("fails over when auth is unavailable and fallbacks are configured", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const authPath = path.join(agentDir, "auth-profiles.json");
      await fs.writeFile(authPath, JSON.stringify({ version: 1, profiles: {}, usageStats: {} }));

      await expect(
        runEmbeddedPiAgent({
          sessionId: "session:test",
          sessionKey: "agent:test:auth-unavailable",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          workspaceDir,
          agentDir,
          config: makeConfig({ fallbacks: ["openai/mock-2"], apiKey: "" }),
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          authProfileIdSource: "auto",
          timeoutMs: 5_000,
          runId: "run:auth-unavailable",
        }),
      ).rejects.toMatchObject({ name: "FailoverError", reason: "auth" });

      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("uses the active erroring model in billing failover errors", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    try {
      await writeAuthStore(agentDir);
      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: [],
          lastAssistant: buildAssistant({
            stopReason: "error",
            errorMessage: "insufficient credits",
            provider: "openai",
            model: "mock-rotated",
          }),
        }),
      );

      let thrown: unknown;
      try {
        await runEmbeddedPiAgent({
          sessionId: "session:test",
          sessionKey: "agent:test:billing-failover-active-model",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          workspaceDir,
          agentDir,
          config: makeConfig({ fallbacks: ["openai/mock-2"] }),
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          authProfileId: "openai:p1",
          authProfileIdSource: "user",
          timeoutMs: 5_000,
          runId: "run:billing-failover-active-model",
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toMatchObject({
        name: "FailoverError",
        reason: "billing",
        provider: "openai",
        model: "mock-rotated",
      });
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("openai (mock-rotated) returned a billing error");
      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("skips profiles in cooldown when rotating after failure", async () => {
    vi.useFakeTimers();
    try {
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
      const now = Date.now();
      vi.setSystemTime(now);

      try {
        const authPath = path.join(agentDir, "auth-profiles.json");
        const payload = {
          version: 1,
          profiles: {
            "openai:p1": { type: "api_key", provider: "openai", key: "sk-one" },
            "openai:p2": { type: "api_key", provider: "openai", key: "sk-two" },
            "openai:p3": { type: "api_key", provider: "openai", key: "sk-three" },
          },
          usageStats: {
            "openai:p1": { lastUsed: 1 },
            "openai:p2": { cooldownUntil: now + 60 * 60 * 1000 }, // p2 in cooldown
            "openai:p3": { lastUsed: 3 },
          },
        };
        await fs.writeFile(authPath, JSON.stringify(payload));

        mockFailedThenSuccessfulAttempt("rate limit");
        await runAutoPinnedOpenAiTurn({
          agentDir,
          workspaceDir,
          sessionKey: "agent:test:rotate-skip-cooldown",
          runId: "run:rotate-skip-cooldown",
        });

        expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
        const usageStats = await readUsageStats(agentDir);
        expect(typeof usageStats["openai:p1"]?.lastUsed).toBe("number");
        expect(typeof usageStats["openai:p3"]?.lastUsed).toBe("number");
        expect(usageStats["openai:p2"]?.cooldownUntil).toBe(now + 60 * 60 * 1000);
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
