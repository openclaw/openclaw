import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./run/attempt.js", () => ({
  runEmbeddedAttempt: vi.fn(),
}));

vi.mock("./compact.js", () => ({
  compactEmbeddedPiSessionDirect: vi.fn(),
}));

vi.mock("./model.js", () => ({
  resolveModel: vi.fn(() => ({
    model: {
      id: "test-model",
      provider: "anthropic",
      contextWindow: 200000,
      api: "messages",
    },
    error: null,
    authStorage: {
      setRuntimeApiKey: vi.fn(),
    },
    modelRegistry: {},
  })),
}));

vi.mock("../model-auth.js", () => ({
  ensureAuthProfileStore: vi.fn(() => ({})),
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-key",
    profileId: "test-profile",
    source: "test",
  })),
  resolveAuthProfileOrder: vi.fn(() => []),
}));

vi.mock("../models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => {}),
}));

vi.mock("../context-window-guard.js", () => ({
  CONTEXT_WINDOW_HARD_MIN_TOKENS: 1000,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS: 5000,
  evaluateContextWindowGuard: vi.fn(() => ({
    shouldWarn: false,
    shouldBlock: false,
    tokens: 200000,
    source: "model",
  })),
  resolveContextWindowInfo: vi.fn(() => ({
    tokens: 200000,
    source: "model",
  })),
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

vi.mock("../auth-profiles.js", () => ({
  isProfileInCooldown: vi.fn(() => false),
  markAuthProfileFailure: vi.fn(async () => {}),
  markAuthProfileGood: vi.fn(async () => {}),
  markAuthProfileUsed: vi.fn(async () => {}),
}));

vi.mock("../defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200000,
  DEFAULT_MODEL: "test-model",
  DEFAULT_PROVIDER: "anthropic",
}));

vi.mock("../failover-error.js", () => ({
  FailoverError: class extends Error {},
  resolveFailoverStatus: vi.fn(),
}));

vi.mock("../usage.js", () => ({
  normalizeUsage: vi.fn((usage?: unknown) =>
    usage && typeof usage === "object" ? usage : undefined,
  ),
  derivePromptTokens: vi.fn(
    (usage?: { input?: number; cacheRead?: number; cacheWrite?: number }) => {
      if (!usage) {
        return undefined;
      }
      const input = usage.input ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      const sum = input + cacheRead + cacheWrite;
      return sum > 0 ? sum : undefined;
    },
  ),
}));

vi.mock("../workspace-run.js", () => ({
  resolveRunWorkspaceDir: vi.fn((params: { workspaceDir: string }) => ({
    workspaceDir: params.workspaceDir,
    usedFallback: false,
    fallbackReason: undefined,
    agentId: "main",
  })),
  redactRunIdentifier: vi.fn((value?: string) => value ?? ""),
}));

vi.mock("./lanes.js", () => ({
  resolveSessionLane: vi.fn(() => "session-lane"),
  resolveGlobalLane: vi.fn(() => "global-lane"),
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

vi.mock("./run/payloads.js", () => ({
  buildEmbeddedRunPayloads: vi.fn(() => []),
}));

vi.mock("./tool-result-truncation.js", () => ({
  truncateOversizedToolResultsInSession: vi.fn(async () => ({
    truncated: false,
    truncatedCount: 0,
    reason: "no oversized tool results",
  })),
  sessionLikelyHasOversizedToolResults: vi.fn(() => false),
}));

vi.mock("./utils.js", () => ({
  describeUnknownError: vi.fn((err: unknown) => {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }),
}));

vi.mock("../pi-embedded-helpers.js", () => ({
  formatBillingErrorMessage: vi.fn(() => ""),
  classifyFailoverReason: vi.fn(() => null),
  formatAssistantErrorText: vi.fn(() => ""),
  isAuthAssistantError: vi.fn(() => false),
  isBillingAssistantError: vi.fn(() => false),
  isCompactionFailureError: vi.fn(() => false),
  isLikelyContextOverflowError: vi.fn((msg?: string) => {
    const lower = (msg ?? "").toLowerCase();
    return lower.includes("request_too_large") || lower.includes("context window exceeded");
  }),
  isFailoverAssistantError: vi.fn(() => false),
  isFailoverErrorMessage: vi.fn(() => false),
  parseImageSizeError: vi.fn(() => null),
  parseImageDimensionError: vi.fn(() => null),
  isRateLimitAssistantError: vi.fn(() => false),
  isTimeoutErrorMessage: vi.fn(() => false),
  pickFallbackThinkingLevel: vi.fn(() => null),
}));

import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { runEmbeddedPiAgent } from "./run.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedCompactDirect = vi.mocked(compactEmbeddedPiSessionDirect);

function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    timedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    sessionIdUsed: "test-session",
    assistantTexts: ["Hello!"],
    toolMetas: [],
    lastAssistant: undefined,
    messagesSnapshot: [],
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    ...overrides,
  };
}

describe("runEmbeddedPiAgent overflow compaction trigger routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes trigger=overflow when retrying compaction after context overflow", async () => {
    const overflowError = new Error("request_too_large: Request size exceeds model context window");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      },
    });

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "overflow",
        authProfileId: "test-profile",
      }),
    );
  });
});
