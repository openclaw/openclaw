import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

vi.mock("./run/attempt.js", () => ({
  runEmbeddedAttempt: vi.fn(),
}));

vi.mock("../workspace-run.js", () => ({
  redactRunIdentifier: (s: string) => s,
  resolveRunWorkspaceDir: vi.fn(() => ({
    workspaceDir: "/tmp/workspace",
    usedFallback: false,
    fallbackReason: "",
    agentId: "main",
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

vi.mock("../defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200000,
  DEFAULT_MODEL: "test-model",
  DEFAULT_PROVIDER: "opencode",
}));

vi.mock("../failover-error.js", () => ({
  FailoverError: class FailoverError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "FailoverError";
    }
  },
  resolveFailoverStatus: vi.fn(() => 429),
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

vi.mock("./model.js", () => ({
  resolveModel: vi.fn(() => ({
    model: {
      id: "test-model",
      provider: "opencode",
      contextWindow: 200000,
      api: "openai-completions",
    },
    error: null,
    authStorage: {
      setRuntimeApiKey: vi.fn(),
    },
    modelRegistry: {},
  })),
}));

vi.mock("../model-auth.js", () => ({
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {} })),
  // Force API key resolution to fail so we go through throwAuthProfileFailover.
  getApiKeyForModel: vi.fn(async () => {
    throw new Error("no api key");
  }),
  resolveAuthProfileOrder: vi.fn(() => []),
}));

vi.mock("../model-selection.js", () => ({
  normalizeProviderId: (p: string) => p,
}));

vi.mock("../auth-profiles.js", () => ({
  isProfileInCooldown: vi.fn(() => false),
  markAuthProfileFailure: vi.fn(async () => {}),
  markAuthProfileGood: vi.fn(async () => {}),
  markAuthProfileUsed: vi.fn(async () => {}),
}));

vi.mock("../usage.js", () => ({
  normalizeUsage: vi.fn(() => undefined),
}));

vi.mock("./run/payloads.js", () => ({
  buildEmbeddedRunPayloads: vi.fn(() => []),
}));

vi.mock("./compact.js", () => ({
  compactEmbeddedPiSessionDirect: vi.fn(async () => ({
    compacted: false,
    compactedCount: 0,
    durationMs: 0,
  })),
}));

vi.mock("./tool-result-truncation.js", () => ({
  truncateOversizedToolResultsInSession: vi.fn(async () => ({
    truncated: false,
    truncatedCount: 0,
    reason: "none",
  })),
  sessionLikelyHasOversizedToolResults: vi.fn(() => false),
}));

vi.mock("./utils.js", () => ({
  describeUnknownError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock("../pi-embedded-helpers.js", async () => ({
  BILLING_ERROR_USER_MESSAGE: "billing",
  classifyFailoverReason: vi.fn(() => "rate_limit"),
  formatAssistantErrorText: vi.fn(() => ""),
  isAuthAssistantError: vi.fn(() => false),
  isBillingAssistantError: vi.fn(() => false),
  isCompactionFailureError: vi.fn(() => false),
  isContextOverflowError: vi.fn(() => false),
  isFailoverAssistantError: vi.fn(() => false),
  isFailoverErrorMessage: vi.fn(() => true),
  isRateLimitAssistantError: vi.fn(() => true),
  isTimeoutErrorMessage: vi.fn(() => false),
  parseImageSizeError: vi.fn(() => null),
  parseImageDimensionError: vi.fn(() => null),
  pickFallbackThinkingLevel: vi.fn(() => null),
}));

import { runEmbeddedPiAgent } from "./run.js";

const baseParams = {
  sessionId: "test-session",
  sessionKey: "agent:main:main",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30000,
  runId: "run-1",
  provider: "opencode",
  model: "kimi-k2.5-free",
};

describe("runEmbeddedPiAgent fallback gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats per-agent fallbacks as enabling failover (even when defaults are empty)", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: null,
        },
        list: [
          {
            id: "main",
            model: {
              primary: "opencode/kimi-k2.5-free",
              fallbacks: ["openai-codex/gpt-5.3-codex"],
            },
          },
        ],
      },
    };

    await expect(
      runEmbeddedPiAgent({ ...baseParams, config: cfg as unknown as OpenClawConfig }),
    ).rejects.toMatchObject({
      name: "FailoverError",
    });
  });

  it("does NOT enable failover when per-agent fallbacks are explicitly disabled", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: null,
        },
        list: [
          {
            id: "main",
            model: {
              primary: "opencode/kimi-k2.5-free",
              fallbacks: [],
            },
          },
        ],
      },
    };

    try {
      await runEmbeddedPiAgent({ ...baseParams, config: cfg as unknown as OpenClawConfig });
      throw new Error("expected runEmbeddedPiAgent to throw");
    } catch (err) {
      expect(err).not.toMatchObject({ name: "FailoverError" });
    }
  });
});
