import { vi } from "vitest";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
} from "../../plugins/types.js";

type MockCompactionResult =
  | {
      ok: true;
      compacted: true;
      result: {
        summary: string;
        firstKeptEntryId?: string;
        tokensBefore?: number;
        tokensAfter?: number;
      };
      reason?: string;
    }
  | {
      ok: false;
      compacted: false;
      reason: string;
      result?: undefined;
    };

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
  runBeforeCompaction: vi.fn(async () => undefined),
  runAfterCompaction: vi.fn(async () => undefined),
};

export const mockedContextEngine = {
  info: { ownsCompaction: false as boolean },
  compact: vi.fn<(params: unknown) => Promise<MockCompactionResult>>(async () => ({
    ok: false as const,
    compacted: false as const,
    reason: "nothing to compact",
  })),
};

export const mockedContextEngineCompact = vi.mocked(mockedContextEngine.compact);
export const mockedEnsureRuntimePluginsLoaded: (...args: unknown[]) => void = vi.fn();

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => mockedGlobalHookRunner),
}));

vi.mock("../../context-engine/index.js", () => ({
  ensureContextEnginesInitialized: vi.fn(),
  resolveContextEngine: vi.fn(async () => mockedContextEngine),
}));

vi.mock("../runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: mockedEnsureRuntimePluginsLoaded,
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

vi.mock("../pi-embedded-helpers.js", () => ({
  formatBillingErrorMessage: vi.fn(() => ""),
  classifyFailoverReason: vi.fn(() => null),
  extractObservedOverflowTokenCount: vi.fn((msg?: string) => {
    const match = msg?.match(/prompt is too long:\s*([\d,]+)\s+tokens\s*>\s*[\d,]+\s+maximum/i);
    return match?.[1] ? Number(match[1].replaceAll(",", "")) : undefined;
  }),
  formatAssistantErrorText: vi.fn(() => ""),
  isAuthAssistantError: vi.fn(() => false),
  isBillingAssistantError: vi.fn(() => false),
  isCompactionFailureError: vi.fn(() => false),
  isLikelyContextOverflowError: vi.fn((msg?: string) => {
    const lower = (msg ?? "").toLowerCase();
    return (
      lower.includes("request_too_large") ||
      lower.includes("context window exceeded") ||
      lower.includes("prompt is too long")
    );
  }),
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

vi.mock(import("../../utils/message-channel.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isMarkdownCapableMessageChannel: vi.fn(() => true),
  };
});

vi.mock("../agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agent-dir"),
}));

vi.mock("../defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200000,
  DEFAULT_MODEL: "test-model",
  DEFAULT_PROVIDER: "anthropic",
}));

export const mockedCoerceToFailoverError = vi.fn();
export const mockedDescribeFailoverError = vi.fn((err: unknown) => ({
  message: err instanceof Error ? err.message : String(err),
  reason: undefined,
  status: undefined,
  code: undefined,
}));
export const mockedResolveFailoverStatus = vi.fn();

vi.mock("../failover-error.js", () => ({
  FailoverError: class extends Error {},
  coerceToFailoverError: mockedCoerceToFailoverError,
  describeFailoverError: mockedDescribeFailoverError,
  resolveFailoverStatus: mockedResolveFailoverStatus,
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
