import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultEmbeddedSession,
  createSubscriptionMock,
  getHoisted,
  resetEmbeddedAttemptHarness,
  testModel,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt websocket transport wiring", () => {
  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    hoisted.createOpenAIWebSocketStreamFnMock.mockReturnValue(vi.fn());
    hoisted.createAgentSessionMock.mockImplementation(async () => ({
      session: createDefaultEmbeddedSession(),
    }));
    hoisted.sessionManagerOpenMock.mockReset().mockResolvedValue(hoisted.sessionManager);
    hoisted.subscribeEmbeddedPiSessionMock.mockReset().mockReturnValue(createSubscriptionMock());
    hoisted.acquireSessionWriteLockMock.mockReset().mockResolvedValue({
      release: async () => {},
    });
    hoisted.resolveSandboxContextMock.mockReset().mockResolvedValue(undefined);
  });

  it("uses websocket transport for openai-codex responses models", async () => {
    const { runEmbeddedAttempt } = await import("./attempt.js");
    const getApiKey = vi.fn(async () => "codex-api-key");
    const authStorage = {
      getApiKey,
    } as unknown as AuthStorage;

    await runEmbeddedAttempt({
      sessionId: "embedded-session",
      sessionKey: "agent:main:discord:direct:test",
      sessionFile: "/tmp/openclaw-session.jsonl",
      workspaceDir: "/tmp/openclaw-workspace",
      agentDir: "/tmp/openclaw-agent",
      config: {},
      prompt: "hello",
      timeoutMs: 10_000,
      runId: "run-openai-codex-ws",
      provider: "openai-codex",
      modelId: "gpt-5.4",
      model: {
        ...testModel,
        provider: "openai-codex",
        api: "openai-codex-responses" as Api,
      } as Model<Api>,
      authStorage,
      modelRegistry: {} as ModelRegistry,
      thinkLevel: "off",
      senderIsOwner: true,
      disableMessageTool: true,
    });

    expect(getApiKey).toHaveBeenCalledWith("openai-codex");
    expect(hoisted.createOpenAIWebSocketStreamFnMock).toHaveBeenCalledTimes(1);
    expect(hoisted.createOpenAIWebSocketStreamFnMock).toHaveBeenCalledWith(
      "codex-api-key",
      "embedded-session",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
