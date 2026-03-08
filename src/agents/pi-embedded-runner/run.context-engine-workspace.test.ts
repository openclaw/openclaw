import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadOpenClawPluginsMock,
  ensureContextEnginesInitializedMock,
  resolveContextEngineMock,
  runEmbeddedAttemptMock,
} = vi.hoisted(() => ({
  loadOpenClawPluginsMock: vi.fn(),
  ensureContextEnginesInitializedMock: vi.fn(),
  resolveContextEngineMock: vi.fn(async () => ({
    compact: vi.fn(async () => ({
      compacted: false,
      reason: "not-needed",
    })),
  })),
  runEmbeddedAttemptMock: vi.fn(async () => ({
    aborted: false,
    promptError: null,
    timedOut: false,
    sessionIdUsed: "test-session",
    assistantTexts: ["ok"],
  })),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({ hasHooks: vi.fn(() => false) })),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: loadOpenClawPluginsMock,
}));

vi.mock("../../context-engine/index.js", () => ({
  ensureContextEnginesInitialized: ensureContextEnginesInitializedMock,
  resolveContextEngine: resolveContextEngineMock,
}));

vi.mock("../../process/command-queue.js", () => ({
  enqueueCommandInLane: vi.fn((_lane: string, task: () => unknown) => task()),
}));

vi.mock("../../utils/message-channel.js", () => ({
  isMarkdownCapableMessageChannel: vi.fn(() => true),
}));

vi.mock("../agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agent-dir"),
}));

vi.mock("../agent-scope.js", () => ({
  hasConfiguredModelFallbacks: vi.fn(() => false),
}));

vi.mock("../auth-profiles.js", () => ({
  isProfileInCooldown: vi.fn(() => false),
  markAuthProfileFailure: vi.fn(async () => {}),
  markAuthProfileGood: vi.fn(async () => {}),
  markAuthProfileUsed: vi.fn(async () => {}),
  resolveProfilesUnavailableReason: vi.fn(() => null),
}));

vi.mock("../context-window-guard.js", () => ({
  CONTEXT_WINDOW_HARD_MIN_TOKENS: 1_000,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS: 5_000,
  evaluateContextWindowGuard: vi.fn(() => ({
    shouldWarn: false,
    shouldBlock: false,
    tokens: 128_000,
    source: "model",
  })),
  resolveContextWindowInfo: vi.fn(() => ({
    tokens: 128_000,
    source: "model",
  })),
}));

vi.mock("../defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 128_000,
  DEFAULT_MODEL: "test-model",
  DEFAULT_PROVIDER: "anthropic",
}));

vi.mock("../failover-error.js", () => ({
  FailoverError: class extends Error {},
  resolveFailoverStatus: vi.fn(() => null),
}));

vi.mock("../model-auth.js", () => ({
  ensureAuthProfileStore: vi.fn(() => ({})),
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test", // pragma: allowlist secret
    profileId: "test-profile",
    source: "test",
  })),
  resolveAuthProfileOrder: vi.fn(() => []),
}));

vi.mock("../model-selection.js", () => ({
  normalizeProviderId: vi.fn((value: string) => value),
}));

vi.mock("../models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => {}),
}));

vi.mock("../pi-embedded-helpers.js", () => ({
  formatBillingErrorMessage: vi.fn(() => ""),
  classifyFailoverReason: vi.fn(() => null),
  formatAssistantErrorText: vi.fn(() => ""),
  isAuthAssistantError: vi.fn(() => false),
  isBillingAssistantError: vi.fn(() => false),
  isCompactionFailureError: vi.fn(() => false),
  isLikelyContextOverflowError: vi.fn(() => false),
  isFailoverAssistantError: vi.fn(() => false),
  isFailoverErrorMessage: vi.fn(() => false),
  parseImageSizeError: vi.fn(() => null),
  parseImageDimensionError: vi.fn(() => null),
  isRateLimitAssistantError: vi.fn(() => false),
  isTimeoutErrorMessage: vi.fn(() => false),
  pickFallbackThinkingLevel: vi.fn(() => null),
}));

vi.mock("../usage.js", () => ({
  derivePromptTokens: vi.fn(() => undefined),
  normalizeUsage: vi.fn((value: unknown) => value),
}));

vi.mock("../workspace-run.js", () => ({
  redactRunIdentifier: vi.fn((value?: string) => value ?? ""),
  resolveRunWorkspaceDir: vi.fn((params: { workspaceDir: string; agentId?: string }) => ({
    workspaceDir: params.workspaceDir,
    usedFallback: false,
    fallbackReason: undefined,
    agentId: params.agentId ?? "main",
  })),
}));

vi.mock("./compact.js", () => ({
  compactEmbeddedPiSessionDirect: vi.fn(),
}));

vi.mock("./lanes.js", () => ({
  resolveGlobalLane: vi.fn(() => "global-lane"),
  resolveSessionLane: vi.fn(() => "session-lane"),
}));

vi.mock("./logger.js", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    isEnabled: vi.fn(() => false),
  },
}));

vi.mock("./model.js", () => ({
  resolveModel: vi.fn(() => ({
    model: {
      id: "test-model",
      provider: "anthropic",
      contextWindow: 128_000,
      api: "messages",
    },
    error: null,
    authStorage: { setRuntimeApiKey: vi.fn() },
    modelRegistry: {},
  })),
}));

vi.mock("./run/attempt.js", () => ({
  runEmbeddedAttempt: runEmbeddedAttemptMock,
}));

vi.mock("./run/payloads.js", () => ({
  buildEmbeddedRunPayloads: vi.fn(() => []),
}));

vi.mock("./tool-result-truncation.js", () => ({
  sessionLikelyHasOversizedToolResults: vi.fn(() => false),
  truncateOversizedToolResultsInSession: vi.fn(async () => ({
    truncated: false,
    truncatedCount: 0,
    reason: "none",
  })),
}));

vi.mock("./utils.js", () => ({
  describeUnknownError: vi.fn((err: unknown) => String(err)),
}));

import { runEmbeddedPiAgent } from "./run.js";

describe("runEmbeddedPiAgent context-engine workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads plugins from the resolved workspace before resolving the context engine", async () => {
    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace-local-plugin",
      prompt: "hello",
      timeoutMs: 30_000,
      runId: "run-plugin-workspace",
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace-local-plugin",
    });
    expect(ensureContextEnginesInitializedMock).toHaveBeenCalledTimes(1);
    expect(resolveContextEngineMock).toHaveBeenCalledWith(undefined);
  });
});
