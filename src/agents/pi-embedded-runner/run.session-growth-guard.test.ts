import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./run/attempt.js", () => ({
  runEmbeddedAttempt: vi.fn(),
}));

vi.mock("./compact.js", () => ({
  compactEmbeddedPiSessionDirect: vi.fn(),
  estimateSessionFileTokens: vi.fn(),
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

vi.mock("../../utils.js", () => ({
  resolveUserPath: vi.fn((p: string) => p),
}));

vi.mock("../../utils/message-channel.js", () => ({
  isMarkdownCapableMessageChannel: vi.fn(() => true),
}));

vi.mock("../agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agent-dir"),
}));

vi.mock("../auth-profiles.js", () => ({
  markAuthProfileFailure: vi.fn(async () => {}),
  markAuthProfileGood: vi.fn(async () => {}),
  markAuthProfileUsed: vi.fn(async () => {}),
  isProfileInCooldown: vi.fn(() => false),
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
  normalizeUsage: vi.fn(() => undefined),
  hasNonzeroUsage: vi.fn(() => false),
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

vi.mock("../pi-embedded-helpers.js", async () => {
  return {
    isCompactionFailureError: () => false,
    isContextOverflowError: () => false,
    isFailoverAssistantError: vi.fn(() => false),
    isFailoverErrorMessage: vi.fn(() => false),
    isAuthAssistantError: vi.fn(() => false),
    isRateLimitAssistantError: vi.fn(() => false),
    isBillingAssistantError: vi.fn(() => false),
    classifyFailoverReason: vi.fn(() => null),
    formatAssistantErrorText: vi.fn(() => ""),
    parseImageSizeError: vi.fn(() => null),
    pickFallbackThinkingLevel: vi.fn(() => null),
    isTimeoutErrorMessage: vi.fn(() => false),
    parseImageDimensionError: vi.fn(() => null),
  };
});

import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { compactEmbeddedPiSessionDirect, estimateSessionFileTokens } from "./compact.js";
import { log } from "./logger.js";
import { runEmbeddedPiAgent } from "./run.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedCompactDirect = vi.mocked(compactEmbeddedPiSessionDirect);
const mockedEstimateTokens = vi.mocked(estimateSessionFileTokens);

function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    timedOut: false,
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

const baseParams = {
  sessionId: "test-session",
  sessionKey: "test-key",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30000,
  runId: "run-1",
};

describe("session-growth guard (#11971)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: session is small, no guard action needed
    mockedEstimateTokens.mockResolvedValue(0);
  });

  it("forces pre-prompt compaction when session store exceeds threshold", async () => {
    // Session store has 180k tokens (90% of 200k context window, above 80% threshold)
    mockedEstimateTokens.mockResolvedValue(180_000);

    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "Compacted bloated session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 180_000,
        tokensAfter: 30_000,
      },
    });

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    const result = await runEmbeddedPiAgent(baseParams);

    // Guard should have fired compaction before the attempt
    expect(mockedEstimateTokens).toHaveBeenCalledWith("/tmp/session.json");
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: "/tmp/session.json" }),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("[session-growth-guard]"));
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("Pre-prompt compaction succeeded"),
    );
    // Attempt should proceed normally after compaction
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error).toBeUndefined();
  });

  it("does not compact when session store is below threshold", async () => {
    // Session store has 100k tokens (50% of 200k, below 80% threshold)
    mockedEstimateTokens.mockResolvedValue(100_000);

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    const result = await runEmbeddedPiAgent(baseParams);

    // Guard should have checked but not compacted
    expect(mockedEstimateTokens).toHaveBeenCalledWith("/tmp/session.json");
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error).toBeUndefined();
  });

  it("proceeds normally when pre-prompt compaction fails", async () => {
    // Session is bloated
    mockedEstimateTokens.mockResolvedValue(180_000);

    // Compaction fails
    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    // Attempt still succeeds (provider may have large context or pruning helps)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("did not compact"));
    // Should still attempt the run
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error).toBeUndefined();
  });

  it("skips guard when session file path is empty", async () => {
    const paramsNoFile = { ...baseParams, sessionFile: "" };

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    await runEmbeddedPiAgent(paramsNoFile);

    expect(mockedEstimateTokens).not.toHaveBeenCalled();
    expect(mockedCompactDirect).not.toHaveBeenCalled();
  });

  it("skips compaction when session file does not exist on disk", async () => {
    const paramsNonexistent = { ...baseParams, sessionFile: "/tmp/nonexistent-session.json" };

    // estimateSessionFileTokens returns 0 for missing files
    mockedEstimateTokens.mockResolvedValue(0);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    const result = await runEmbeddedPiAgent(paramsNonexistent);

    expect(mockedEstimateTokens).toHaveBeenCalledWith("/tmp/nonexistent-session.json");
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.meta.error).toBeUndefined();
  });

  it("counts pre-prompt compaction in autoCompactionCount", async () => {
    mockedEstimateTokens.mockResolvedValue(180_000);

    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "Compacted",
        firstKeptEntryId: "entry-3",
        tokensBefore: 180_000,
        tokensAfter: 25_000,
      },
    });

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    const result = await runEmbeddedPiAgent(baseParams);

    // The compaction count should be reflected in the result
    expect(result.meta.agentMeta?.compactionCount).toBe(1);
  });

  it("handles estimateSessionFileTokens errors gracefully", async () => {
    // Estimation throws (e.g., corrupt session file)
    mockedEstimateTokens.mockRejectedValue(new Error("file corrupt"));

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    // Should not crash — guard is best-effort
    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error).toBeUndefined();
  });
});
