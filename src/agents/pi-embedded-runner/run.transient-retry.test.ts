import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
} from "../../plugins/types.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: vi.fn((_hookName: string) => false),
    runBeforeAgentStart: vi.fn(
      async (
        _event: { prompt: string; messages?: unknown[] },
        _ctx: PluginHookAgentContext,
      ): Promise<PluginHookBeforeAgentStartResult | undefined> => undefined,
    ),
    runBeforePromptBuild: vi.fn(
      async (
        _event: { prompt: string; messages: unknown[] },
        _ctx: PluginHookAgentContext,
      ): Promise<PluginHookBeforePromptBuildResult | undefined> => undefined,
    ),
    runBeforeModelResolve: vi.fn(
      async (
        _event: { prompt: string },
        _ctx: PluginHookAgentContext,
      ): Promise<PluginHookBeforeModelResolveResult | undefined> => undefined,
    ),
  })),
}));

vi.mock("../auth-profiles.js", () => ({
  isProfileInCooldown: vi.fn(() => false),
  markAuthProfileFailure: vi.fn(async () => {}),
  markAuthProfileGood: vi.fn(async () => {}),
  markAuthProfileUsed: vi.fn(async () => {}),
}));

vi.mock("../usage.js", () => ({
  normalizeUsage: vi.fn((usage?: unknown) =>
    usage && typeof usage === "object" ? usage : undefined,
  ),
  derivePromptTokens: vi.fn(() => undefined),
  hasNonzeroUsage: vi.fn(() => false),
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
    authStorage: { setRuntimeApiKey: vi.fn() },
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
  resolveContextWindowInfo: vi.fn(() => ({ tokens: 200000, source: "model" })),
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

vi.mock("../defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200000,
  DEFAULT_MODEL: "test-model",
  DEFAULT_PROVIDER: "anthropic",
}));

vi.mock("../failover-error.js", () => ({
  FailoverError: class extends Error {},
  resolveFailoverStatus: vi.fn(),
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
  describeUnknownError: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
}));

vi.mock("../model-fallback.js", () => ({
  isTransientLlmCallError: vi.fn(),
}));

vi.mock("../../utils.js", () => ({
  resolveUserPath: vi.fn((p: string) => p),
  sleep: vi.fn(async (_ms: number) => {}),
}));

import { sleep } from "../../utils.js";
import { isTransientLlmCallError } from "../model-fallback.js";
import { log } from "./logger.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedIsTransient = vi.mocked(isTransientLlmCallError);
const mockedSleep = vi.mocked(sleep);

const baseParams = {
  sessionId: "test-session",
  sessionKey: "test-key",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30_000,
  runId: "run-1",
} as const;

function makeAssistantError(errorMessage: string): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    lastAssistant: {
      stopReason: "error",
      errorMessage,
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
  });
}

describe("pi-embedded runner — transient network retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries the same provider on transient promptError then succeeds", async () => {
    const transient = Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" });
    mockedIsTransient.mockImplementation((err: unknown) => err === transient);

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: transient }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedSleep).toHaveBeenCalledWith(1_000);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("transient LLM network error from anthropic/test-model"),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("source=promptError"));
    expect(result.meta.error).toBeUndefined();
  });

  it("retries on transient assistant error (streaming drop) then succeeds", async () => {
    mockedIsTransient.mockImplementation((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return /ECONNRESET|socket hang up/.test(message);
    });

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAssistantError("read ECONNRESET"))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
    expect(mockedSleep).toHaveBeenCalledWith(1_000);
    expect(result.meta.error).toBeUndefined();
  });

  it("applies 1s / 3s / 5s backoff schedule across up to 3 retries", async () => {
    const transient = Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" });
    mockedIsTransient.mockImplementation((err: unknown) => err === transient);

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: transient }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: transient }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: transient }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(mockedSleep.mock.calls.map((c) => c[0])).toEqual([1_000, 3_000, 5_000]);
  });

  it("stops retrying after MAX_TRANSIENT_NETWORK_RETRIES and falls through to failover", async () => {
    const transient = Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" });
    mockedIsTransient.mockImplementation((err: unknown) => err === transient);

    // 4 transient responses, 4th attempt still failing — should fall through to
    // the existing promptError handling rather than retry a 5th time.
    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError: transient }));

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toBeDefined();
    // 1 initial attempt + 3 retries = 4 total calls to runEmbeddedAttempt.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(mockedSleep).toHaveBeenCalledTimes(3);
  });

  it("does not retry when neither error is transient", async () => {
    const rateLimit = Object.assign(new Error("429 rate limited"), { status: 429 });
    mockedIsTransient.mockReturnValue(false);

    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError: rateLimit }));

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toBeDefined();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedSleep).not.toHaveBeenCalled();
  });

  it("does not retry when the attempt was aborted", async () => {
    const transient = Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" });
    mockedIsTransient.mockReturnValue(true);

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ aborted: true, promptError: transient }),
    );

    await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedSleep).not.toHaveBeenCalled();
  });

  it("does not retry when the compaction pipeline timed out", async () => {
    mockedIsTransient.mockReturnValue(true);

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        timedOutDuringCompaction: true,
        promptError: new Error("compaction timeout"),
      }),
    );

    // The runner falls through to existing promptError handling (which throws
    // for unrecognised errors); the point here is that no transient retry was
    // scheduled before we got there.
    await expect(runEmbeddedPiAgent(baseParams)).rejects.toThrow(/compaction timeout/);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedSleep).not.toHaveBeenCalled();
  });
});
