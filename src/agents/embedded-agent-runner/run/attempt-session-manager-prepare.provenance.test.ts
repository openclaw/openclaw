import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  resolveTranscriptState: vi.fn(),
}));

vi.mock("../../session-tool-result-guard-wrapper.js", () => ({
  guardSessionManager: <T>(manager: T) => manager,
}));
vi.mock("../context-engine-maintenance.js", () => ({
  runContextEngineMaintenance: vi.fn(),
}));
vi.mock("../logger.js", () => ({
  log: { warn: vi.fn() },
}));
vi.mock("./attempt-transcript-helpers.js", () => ({
  resolveExistingAttemptTranscriptState: mocks.resolveTranscriptState,
}));
vi.mock("./attempt.context-engine-helpers.js", () => ({
  runAttemptContextEngineBootstrap: mocks.bootstrap,
}));
vi.mock("./attempt.prompt-helpers.js", () => ({
  buildAfterTurnRuntimeContext: vi.fn(() => ({})),
}));
vi.mock("./attempt.transcript-policy.js", () => ({
  resolveAttemptTranscriptPolicy: vi.fn(() => ({
    allowSyntheticToolResults: false,
    repairToolUseResultPairing: false,
  })),
}));
vi.mock("./attempt.user-transcript-context-registry.js", () => ({
  createUserTranscriptContextRegistry: vi.fn(() => ({
    clear: vi.fn(),
    list: vi.fn(() => []),
    record: vi.fn(),
  })),
}));
vi.mock("./session-boundary-prompt-cache-key.js", () => ({
  resolveSessionBoundaryPromptCacheKey: vi.fn(() => "cache-key"),
}));

import { SessionManager } from "../../sessions/index.js";
import { prepareEmbeddedAttemptSessionManager } from "./attempt-session-manager-prepare.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTranscriptState.mockResolvedValue({ hasBootstrapTranscriptState: false });
});

describe("prepareEmbeddedAttemptSessionManager prompt provenance", () => {
  it("establishes a fresh mutation baseline for each attempt on a reused manager", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "before retry", timestamp: 1 });
    const consume = vi.spyOn(sessionManager, "consumePromptContextMutation");
    mocks.bootstrap
      .mockImplementationOnce(async ({ sessionManager: prepared }) => {
        prepared.appendMessage({ role: "assistant", content: [], timestamp: 2 });
      })
      .mockResolvedValueOnce(undefined);

    const prepare = async () =>
      await prepareEmbeddedAttemptSessionManager({
        attempt: {
          config: {},
          contextTokenBudget: 128_000,
          model: {
            api: "openai-responses",
            contextWindow: 128_000,
            id: "gpt-5",
            name: "gpt-5",
            provider: "openai",
          },
          modelId: "gpt-5",
          operation: "agent",
          provider: "openai",
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          sessionManager,
          skipPreparedUserTurnMessage: true,
        } as never,
        agentDir: "/agent",
        effectiveCwd: "/workspace",
        effectiveWorkspace: "/workspace",
        onSessionManagerCreated: vi.fn(),
        replayAllowedToolNames: new Set(),
        resolveActiveContextEnginePluginId: () => undefined,
        sessionAgentId: "main",
        sessionLockController: {
          refreshAfterOwnedSessionWrite: vi.fn(),
        } as never,
        withOwnedSessionWriteLock: async (operation) => await operation(),
      });

    await prepare();
    expect(sessionManager.consumePromptContextMutation()).toBe("changed");
    await prepare();
    expect(sessionManager.consumePromptContextMutation()).toBe("unchanged");
    expect(consume.mock.results.map((result) => result.value)).toEqual([
      "changed",
      "changed",
      "unchanged",
      "unchanged",
    ]);
  });
});
