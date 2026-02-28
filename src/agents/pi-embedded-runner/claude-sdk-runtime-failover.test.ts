import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isProfileInCooldown } from "../auth-profiles.js";
import { getApiKeyForModel } from "../model-auth.js";
import { runEmbeddedPiAgent } from "./run.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedGetApiKeyForModel = vi.mocked(getApiKeyForModel);
const mockedIsProfileInCooldown = vi.mocked(isProfileInCooldown);

const successfulAttemptResult = {
  aborted: false,
  promptError: null,
  timedOut: false,
  sessionIdUsed: "test-session",
  assistantTexts: ["Response 1"],
  lastAssistant: {
    usage: { input: 10, output: 5, total: 15 },
    stopReason: "end_turn",
  },
  attemptUsage: { input: 10, output: 5, total: 15 },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("claude-sdk runtime failover parity flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsProfileInCooldown.mockReturnValue(false);
  });

  it("uses claude-sdk runtime for system-keychain provider (claude-pro)", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successfulAttemptResult);
    mockedGetApiKeyForModel.mockResolvedValueOnce({
      apiKey: undefined,
      profileId: "claude-pro:system-keychain",
      source: "Claude Pro (system keychain)",
      mode: "system-keychain",
    } as never);

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-sdk-keychain",
      provider: "claude-pro",
      config: {
        agents: {
          defaults: {
            claudeSdk: {},
          },
        },
      },
    });

    const firstAttemptCall = mockedRunEmbeddedAttempt.mock.calls[0]?.[0];
    expect(firstAttemptCall?.runtimeOverride).toBe("claude-sdk");
  });

  it("falls back from claude-sdk to pi runtime when system-keychain auth fails", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successfulAttemptResult);
    mockedGetApiKeyForModel
      .mockRejectedValueOnce(new Error("claude-pro keychain expired"))
      .mockResolvedValueOnce({
        apiKey: "sk-pi-fallback",
        profileId: "pi-profile",
        source: "test",
        mode: "api-key",
      });

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-sdk-to-pi",
      provider: "claude-pro",
      config: {
        agents: {
          defaults: {
            claudeSdk: {},
          },
        },
      },
    });

    const firstAttemptCall = mockedRunEmbeddedAttempt.mock.calls[0]?.[0];
    expect(firstAttemptCall?.runtimeOverride).toBe("pi");
    expect(firstAttemptCall?.resolvedProviderAuth?.apiKey).toBe("sk-pi-fallback");
  });
});
