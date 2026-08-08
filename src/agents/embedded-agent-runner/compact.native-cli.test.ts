import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";

const { runCliAgentMock } = vi.hoisted(() => ({
  runCliAgentMock: vi.fn(async () => ({
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "native-session", provider: "claude-cli", model: "opus" },
    },
  })),
}));

vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));

const { testing } = await import("./compact.js");

function registerBackend(overrides: Partial<CliBackendPlugin> = {}) {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () =>
      [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          config: {
            command: "claude",
            args: ["-p"],
            resumeArgs: ["-p", "--resume", "{sessionId}"],
            input: "stdin",
            output: "jsonl",
            sessionMode: "existing",
          },
          bundleMcp: false,
          pluginId: "anthropic",
          ownsNativeCompaction: true,
          buildManualCompactionPrompt: (instructions?: string) =>
            instructions ? `/compact ${instructions}` : "/compact",
          ...overrides,
        },
      ] as never,
    resolvePluginSetupCliBackend: () => undefined,
  });
}

function compactParams(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "openclaw-session",
    sessionKey: "agent:main:main",
    sessionTarget: {
      agentId: "main",
      sessionId: "openclaw-session",
      sessionKey: "agent:main:main",
      storePath: "/tmp/openclaw.sqlite",
    },
    sessionFile: "agent:main:main",
    agentId: "main",
    workspaceDir: "/tmp/workspace",
    agentDir: "/tmp/agent",
    config: {},
    provider: "anthropic",
    model: "opus",
    trigger: "manual",
    cliSessionId: "native-session",
    customInstructions: "keep decisions",
    preparedModelRuntime: {},
    ...overrides,
  } as never;
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  runCliAgentMock.mockClear();
});

describe("native CLI manual compaction", () => {
  it("resumes the bound backend session with the backend-owned command", async () => {
    registerBackend();

    const result = await testing.compactNativeCliSession({
      runtime: "claude-cli",
      compactParams: compactParams(),
    });

    expect(result).toEqual({
      ok: true,
      compacted: true,
      reason: 'CLI backend "claude-cli" compacted its native session.',
    });
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "/compact keep decisions",
        provider: "claude-cli",
        modelProvider: "anthropic",
        cliSessionId: "native-session",
        controlOperation: "compact",
        disableCliLiveSession: true,
        disableTools: true,
        allowEmptyAssistantReplyAsSilent: true,
      }),
    );
  });

  it("fails explicitly when an owning backend has no resumable session", async () => {
    registerBackend();

    const result = await testing.compactNativeCliSession({
      runtime: "claude-cli",
      compactParams: compactParams({ cliSessionId: undefined }),
    });

    expect(result).toMatchObject({ ok: false, compacted: false });
    expect(result?.reason).toContain("without a resumable native session");
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("leaves non-owning runtimes on the existing compaction path", async () => {
    registerBackend({ ownsNativeCompaction: false });

    await expect(
      testing.compactNativeCliSession({
        runtime: "claude-cli",
        compactParams: compactParams(),
      }),
    ).resolves.toBeUndefined();
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });
});
