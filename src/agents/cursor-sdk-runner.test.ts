import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "./failover-error.js";
import { isCursorSdkProvider } from "./model-selection.js";

vi.mock("./model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(),
}));

vi.mock("./workspace-run.js", () => ({
  resolveRunWorkspaceDir: vi.fn(() => ({
    workspaceDir: "/tmp/test-workspace",
    usedFallback: false,
  })),
  redactRunIdentifier: vi.fn((v: string) => v.slice(0, 4) + "***"),
}));

vi.mock("@cursor/sdk", () => {
  class AuthenticationError extends Error {}
  class RateLimitError extends Error {}
  class CursorAgentError extends Error {}
  const mockCreate = vi.fn();
  return {
    Agent: { create: mockCreate },
    AuthenticationError,
    RateLimitError,
    CursorAgentError,
    __mocks: { mockCreate, AuthenticationError, RateLimitError },
  };
});

describe("isCursorSdkProvider", () => {
  it("returns true for cursor-sdk", () => {
    expect(isCursorSdkProvider("cursor-sdk")).toBe(true);
  });

  it("returns true for Cursor-SDK (case-insensitive normalization)", () => {
    expect(isCursorSdkProvider("Cursor-SDK")).toBe(true);
  });

  it("returns false for other providers", () => {
    expect(isCursorSdkProvider("openai")).toBe(false);
    expect(isCursorSdkProvider("anthropic")).toBe(false);
    expect(isCursorSdkProvider("claude-cli")).toBe(false);
    expect(isCursorSdkProvider("codex-cli")).toBe(false);
  });
});

describe("runCursorSdkAgent", () => {
  let resolveApiKeyForProvider: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const modelAuth = await import("./model-auth.js");
    resolveApiKeyForProvider = vi.mocked(modelAuth.resolveApiKeyForProvider);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeFakeAgent(overrides?: {
    sendResult?: unknown;
    sendError?: Error;
    runStatus?: string;
    streamDelay?: number;
  }) {
    const fakeRun = {
      id: "cursor-run-123",
      durationMs: 42,
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          if (overrides?.streamDelay) {
            await new Promise((r) => setTimeout(r, overrides.streamDelay));
          }
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Hello from Cursor!" }],
            },
          };
        },
      }),
      wait: vi.fn().mockResolvedValue({
        id: "r1",
        status: overrides?.runStatus ?? "finished",
        result: "Hello from Cursor!",
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const agent = {
      send: overrides?.sendError
        ? vi.fn().mockRejectedValue(overrides.sendError)
        : vi.fn().mockResolvedValue(overrides?.sendResult ?? fakeRun),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    };

    return { agent, fakeRun };
  }

  async function getMockCreate() {
    const sdk = await import("@cursor/sdk");
    return (sdk as unknown as { __mocks: { mockCreate: ReturnType<typeof vi.fn> } }).__mocks
      .mockCreate;
  }

  it("throws FailoverError when no API key is available", async () => {
    resolveApiKeyForProvider.mockRejectedValue(new Error("No credentials"));

    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    await expect(
      runCursorSdkAgent({
        sessionId: "test-session",
        sessionFile: "/tmp/session.json",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "cursor-sdk",
        timeoutMs: 30000,
        runId: "run-1",
      }),
    ).rejects.toThrow(FailoverError);

    try {
      await runCursorSdkAgent({
        sessionId: "test-session",
        sessionFile: "/tmp/session.json",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "cursor-sdk",
        timeoutMs: 30000,
        runId: "run-1",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
      expect((err as FailoverError).reason).toBe("auth");
    }
  });

  it("returns EmbeddedPiRunResult with text payload on success", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env: CURSOR_API_KEY",
    });

    const { agent } = makeFakeAgent();
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(agent);

    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    const result = await runCursorSdkAgent({
      sessionId: "test-session",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "Say hello",
      provider: "cursor-sdk",
      model: "composer-2",
      timeoutMs: 30000,
      runId: "run-2",
    });

    expect(result.payloads).toBeDefined();
    expect(result.payloads?.[0]?.text).toBe("Hello from Cursor!");
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.meta.agentMeta?.provider).toBe("cursor-sdk");
    expect(result.meta.agentMeta?.model).toBe("composer-2");
    expect(result.meta.agentMeta?.sessionId).toBe("cursor-run-123");
    expect(agent[Symbol.asyncDispose]).toHaveBeenCalled();
  });

  it("creates local agent by default", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env: CURSOR_API_KEY",
    });

    const { agent } = makeFakeAgent();
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(agent);

    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    await runCursorSdkAgent({
      sessionId: "s1",
      sessionFile: "/tmp/s.json",
      workspaceDir: "/tmp/ws",
      prompt: "test",
      provider: "cursor-sdk",
      timeoutMs: 10000,
      runId: "r1",
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        model: { id: "composer-2" },
        local: { cwd: "/tmp/test-workspace" },
      }),
    );
  });

  it("creates cloud agent when config specifies runtime=cloud", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env: CURSOR_API_KEY",
    });

    const { agent } = makeFakeAgent();
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(agent);

    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    await runCursorSdkAgent({
      sessionId: "s2",
      sessionFile: "/tmp/s.json",
      workspaceDir: "/tmp/ws",
      prompt: "test cloud",
      provider: "cursor-sdk",
      timeoutMs: 10000,
      runId: "r2",
      config: {
        agents: {
          defaults: {
            cursorSdk: {
              runtime: "cloud",
              cloud: {
                repos: [{ url: "https://github.com/test/repo" }],
                autoCreatePR: true,
              },
            },
          },
        },
      } as any,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        model: { id: "composer-2" },
        cloud: {
          repos: [{ url: "https://github.com/test/repo" }],
          autoCreatePR: true,
        },
      }),
    );
  });

  it("disposes agent even on error", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env: CURSOR_API_KEY",
    });

    const { agent } = makeFakeAgent({ sendError: new Error("SDK error") });
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(agent);

    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    await expect(
      runCursorSdkAgent({
        sessionId: "s3",
        sessionFile: "/tmp/s.json",
        workspaceDir: "/tmp/ws",
        prompt: "fail",
        provider: "cursor-sdk",
        timeoutMs: 10000,
        runId: "r3",
      }),
    ).rejects.toThrow(FailoverError);

    expect(agent[Symbol.asyncDispose]).toHaveBeenCalled();
  });

  it("classifies RateLimitError as rate_limit failover reason", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env: CURSOR_API_KEY",
    });

    const sdk = await import("@cursor/sdk");
    const { RateLimitError } = (
      sdk as unknown as { __mocks: { RateLimitError: new (msg: string) => Error } }
    ).__mocks;
    const rateLimitErr = new RateLimitError("Too many requests");

    const { agent } = makeFakeAgent({ sendError: rateLimitErr });
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(agent);

    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    try {
      await runCursorSdkAgent({
        sessionId: "s4",
        sessionFile: "/tmp/s.json",
        workspaceDir: "/tmp/ws",
        prompt: "test",
        provider: "cursor-sdk",
        timeoutMs: 10000,
        runId: "r4",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
      expect((err as FailoverError).reason).toBe("rate_limit");
    }
  });

  it("throws FailoverError when run finishes with error status", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env: CURSOR_API_KEY",
    });

    const { agent } = makeFakeAgent({ runStatus: "error" });
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(agent);

    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    try {
      await runCursorSdkAgent({
        sessionId: "s-err",
        sessionFile: "/tmp/s.json",
        workspaceDir: "/tmp/ws",
        prompt: "test",
        provider: "cursor-sdk",
        timeoutMs: 10000,
        runId: "r-err",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
      expect((err as FailoverError).reason).toBe("unclassified");
    }
  });

  it("throws FailoverError when run finishes with cancelled status", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env: CURSOR_API_KEY",
    });

    const { agent } = makeFakeAgent({ runStatus: "cancelled" });
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(agent);

    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    try {
      await runCursorSdkAgent({
        sessionId: "s-cancel",
        sessionFile: "/tmp/s.json",
        workspaceDir: "/tmp/ws",
        prompt: "test",
        provider: "cursor-sdk",
        timeoutMs: 10000,
        runId: "r-cancel",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
    }
  });

  it("builds cloud options when runtime=cloud without a cloud config block", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env: CURSOR_API_KEY",
    });

    const { agent } = makeFakeAgent();
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(agent);

    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    await runCursorSdkAgent({
      sessionId: "s-cloud-bare",
      sessionFile: "/tmp/s.json",
      workspaceDir: "/tmp/ws",
      prompt: "test cloud bare",
      provider: "cursor-sdk",
      timeoutMs: 10000,
      runId: "r-cloud-bare",
      config: {
        agents: {
          defaults: {
            cursorSdk: { runtime: "cloud" },
          },
        },
      } as any,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        cloud: { repos: [], autoCreatePR: undefined },
      }),
    );
    expect(mockCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ local: expect.anything() }),
    );
  });

  it("honors cursorSdk.model from config when params.model is not set", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env: CURSOR_API_KEY",
    });

    const { agent } = makeFakeAgent();
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(agent);

    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    await runCursorSdkAgent({
      sessionId: "s-cfg-model",
      sessionFile: "/tmp/s.json",
      workspaceDir: "/tmp/ws",
      prompt: "test config model",
      provider: "cursor-sdk",
      timeoutMs: 10000,
      runId: "r-cfg-model",
      config: {
        agents: {
          defaults: {
            cursorSdk: { model: "composer-2-fast" },
          },
        },
      } as any,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "composer-2-fast" },
      }),
    );
  });

  it("classifies AuthenticationError as auth failover reason", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "bad-key",
      source: "env: CURSOR_API_KEY",
    });

    const sdk = await import("@cursor/sdk");
    const { AuthenticationError } = (
      sdk as unknown as { __mocks: { AuthenticationError: new (msg: string) => Error } }
    ).__mocks;
    const authErr = new AuthenticationError("Invalid API key");

    const { agent } = makeFakeAgent({ sendError: authErr });
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(agent);

    const { runCursorSdkAgent } = await import("./cursor-sdk-runner.js");

    try {
      await runCursorSdkAgent({
        sessionId: "s5",
        sessionFile: "/tmp/s.json",
        workspaceDir: "/tmp/ws",
        prompt: "test",
        provider: "cursor-sdk",
        timeoutMs: 10000,
        runId: "r5",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
      expect((err as FailoverError).reason).toBe("auth");
    }
  });
});
