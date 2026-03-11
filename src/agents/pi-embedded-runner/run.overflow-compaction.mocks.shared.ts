import { vi } from "vitest";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
} from "../../plugins/types.js";

export const mockedGlobalHookRunner = {
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
};

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => mockedGlobalHookRunner),
  initializeGlobalHookRunner: vi.fn(),
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
  derivePromptTokens: vi.fn((usage?: { input?: number; cacheRead?: number; cacheWrite?: number }) =>
    usage
      ? (() => {
          const sum = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
          return sum > 0 ? sum : undefined;
        })()
      : undefined,
  ),
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

export const mockedFormatBillingErrorMessage = vi.fn(() => "");
export const mockedClassifyFailoverReason = vi.fn(() => null);
export const mockedFormatAssistantErrorText = vi.fn(() => "");
export const mockedIsAuthAssistantError = vi.fn(() => false);
export const mockedIsBillingAssistantError = vi.fn(() => false);
export const mockedIsCompactionFailureError = vi.fn(() => false);
export const mockedIsLikelyContextOverflowError = vi.fn((msg?: string) => {
  const lower = (msg ?? "").toLowerCase();
  return lower.includes("request_too_large") || lower.includes("context window exceeded");
});
export const mockedIsFailoverAssistantError = vi.fn(() => false);
export const mockedIsFailoverErrorMessage = vi.fn(() => false);
export const mockedParseImageSizeError = vi.fn(() => null);
export const mockedParseImageDimensionError = vi.fn(() => null);
export const mockedIsRateLimitAssistantError = vi.fn(() => false);
export const mockedIsTimeoutErrorMessage = vi.fn(() => false);
export const mockedPickFallbackThinkingLevel = vi.fn(() => null);

vi.mock("../pi-embedded-helpers.js", () => ({
  formatBillingErrorMessage: mockedFormatBillingErrorMessage,
  classifyFailoverReason: mockedClassifyFailoverReason,
  formatAssistantErrorText: mockedFormatAssistantErrorText,
  isAuthAssistantError: mockedIsAuthAssistantError,
  isBillingAssistantError: mockedIsBillingAssistantError,
  isCompactionFailureError: mockedIsCompactionFailureError,
  isLikelyContextOverflowError: mockedIsLikelyContextOverflowError,
  isFailoverAssistantError: mockedIsFailoverAssistantError,
  isFailoverErrorMessage: mockedIsFailoverErrorMessage,
  parseImageSizeError: mockedParseImageSizeError,
  parseImageDimensionError: mockedParseImageDimensionError,
  isRateLimitAssistantError: mockedIsRateLimitAssistantError,
  isTimeoutErrorMessage: mockedIsTimeoutErrorMessage,
  pickFallbackThinkingLevel: mockedPickFallbackThinkingLevel,
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
  INTERNAL_MESSAGE_CHANNEL: "webchat",
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
  describeUnknownError: vi.fn((err: unknown) => {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }),
}));
