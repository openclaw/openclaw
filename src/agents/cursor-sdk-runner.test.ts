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
  const mockWait = vi.fn();
  const mockStream = vi.fn();
  const mockSend = vi.fn();
  const mockDispose = vi.fn();
  const mockCreate = vi.fn();

  return {
    Agent: {
      create: mockCreate,
    },
    __mocks: { mockWait, mockStream, mockSend, mockDispose, mockCreate },
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
  });

  it("returns EmbeddedPiRunResult with text payload on success", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env: CURSOR_API_KEY",
    });

    const { Agent, __mocks } = await import("@cursor/sdk");
    const { mockCreate } = __mocks as {
      mockCreate: ReturnType<typeof vi.fn>;
    };

    const fakeRun = {
      id: "cursor-run-123",
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Hello from Cursor!" }],
            },
          };
        },
      }),
      wait: vi.fn().mockResolvedValue({ result: "Hello from Cursor!" }),
    };

    const fakeAgent = {
      send: vi.fn().mockResolvedValue(fakeRun),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    };

    mockCreate.mockResolvedValue(fakeAgent);

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
    expect(fakeAgent[Symbol.asyncDispose]).toHaveBeenCalled();
  });

  it("creates local agent by default", async () => {
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env: CURSOR_API_KEY",
    });

    const { __mocks } = await import("@cursor/sdk");
    const { mockCreate } = __mocks as { mockCreate: ReturnType<typeof vi.fn> };

    const fakeRun = {
      id: "run-id",
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "ok" }] },
          };
        },
      }),
      wait: vi.fn().mockResolvedValue({}),
    };
    const fakeAgent = {
      send: vi.fn().mockResolvedValue(fakeRun),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(fakeAgent);

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

    const { __mocks } = await import("@cursor/sdk");
    const { mockCreate } = __mocks as { mockCreate: ReturnType<typeof vi.fn> };

    const fakeRun = {
      id: "run-id",
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "cloud response" }] },
          };
        },
      }),
      wait: vi.fn().mockResolvedValue({}),
    };
    const fakeAgent = {
      send: vi.fn().mockResolvedValue(fakeRun),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(fakeAgent);

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

    const { __mocks } = await import("@cursor/sdk");
    const { mockCreate } = __mocks as { mockCreate: ReturnType<typeof vi.fn> };

    const fakeAgent = {
      send: vi.fn().mockRejectedValue(new Error("SDK error")),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    };
    mockCreate.mockResolvedValue(fakeAgent);

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

    expect(fakeAgent[Symbol.asyncDispose]).toHaveBeenCalled();
  });
});
