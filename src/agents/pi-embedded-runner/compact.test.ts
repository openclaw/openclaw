import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock all heavy dependencies before imports
vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  estimateTokens: vi.fn(() => 100),
  SessionManager: {
    open: vi.fn(() => ({ flushPendingToolResults: vi.fn() })),
  },
  SettingsManager: { create: vi.fn() },
}));

vi.mock("node:fs/promises", () => ({
  default: { mkdir: vi.fn(async () => {}), readFile: vi.fn(async () => "{}") },
}));

vi.mock("./model.js", () => ({
  resolveModel: vi.fn(() => ({
    model: {
      id: "test-model",
      provider: "anthropic",
      api: "messages",
      contextWindow: 200000,
    },
    error: null,
    authStorage: { setRuntimeApiKey: vi.fn() },
    modelRegistry: {},
  })),
  buildModelAliasLines: vi.fn(() => []),
}));

vi.mock("../model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-key",
    profileId: "test",
    source: "test",
    mode: "key",
  })),
  resolveModelAuthMode: vi.fn(() => "key"),
}));

vi.mock("../models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => {}),
}));

vi.mock("../model-selection.js", () => ({
  parseModelRef: vi.fn((raw: string, defaultProvider: string) => {
    const slash = raw.indexOf("/");
    if (slash === -1) return { provider: defaultProvider, model: raw };
    return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
  }),
}));

vi.mock("../../config/channel-capabilities.js", () => ({
  resolveChannelCapabilities: vi.fn(() => []),
}));

vi.mock("../../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "test-host"),
}));

vi.mock("../../utils.js", () => ({
  resolveUserPath: vi.fn((p: string) => p),
}));

vi.mock("../../utils/message-channel.js", () => ({
  normalizeMessageChannel: vi.fn(() => undefined),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn(() => false),
}));

vi.mock("../agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agent-dir"),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentIds: vi.fn(() => ({
    defaultAgentId: "default",
    sessionAgentId: "default",
  })),
}));

vi.mock("../bootstrap-files.js", () => ({
  resolveBootstrapContextForRun: vi.fn(async () => ({ contextFiles: [] })),
  makeBootstrapWarn: vi.fn(() => vi.fn()),
}));

vi.mock("../channel-tools.js", () => ({
  listChannelSupportedActions: vi.fn(() => undefined),
  resolveChannelMessageToolHints: vi.fn(() => undefined),
}));

vi.mock("../date-time.js", () => ({
  formatUserTime: vi.fn(() => "2025-01-01"),
  resolveUserTimeFormat: vi.fn(() => undefined),
  resolveUserTimezone: vi.fn(() => "UTC"),
}));

vi.mock("../defaults.js", () => ({
  DEFAULT_MODEL: "test-model",
  DEFAULT_PROVIDER: "anthropic",
}));

vi.mock("../docs-path.js", () => ({
  resolveOpenClawDocsPath: vi.fn(async () => "/tmp/docs"),
}));

vi.mock("../pi-embedded-helpers.js", () => ({
  ensureSessionHeader: vi.fn(async () => {}),
  validateAnthropicTurns: vi.fn((m: unknown) => m),
  validateGeminiTurns: vi.fn((m: unknown) => m),
}));

vi.mock("../pi-settings.js", () => ({
  ensurePiCompactionReserveTokens: vi.fn(),
  resolveCompactionReserveTokensFloor: vi.fn(() => 0),
}));

vi.mock("../pi-tools.js", () => ({
  createOpenClawCodingTools: vi.fn(() => []),
}));

vi.mock("../sandbox.js", () => ({
  resolveSandboxContext: vi.fn(async () => null),
}));

vi.mock("../session-file-repair.js", () => ({
  repairSessionFileIfNeeded: vi.fn(async () => {}),
}));

vi.mock("../session-tool-result-guard-wrapper.js", () => ({
  guardSessionManager: vi.fn((sm: unknown) => ({
    ...(sm as Record<string, unknown>),
    flushPendingToolResults: vi.fn(),
  })),
}));

vi.mock("../session-write-lock.js", () => ({
  acquireSessionWriteLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
}));

vi.mock("../skills.js", () => ({
  applySkillEnvOverrides: vi.fn(() => vi.fn()),
  applySkillEnvOverridesFromSnapshot: vi.fn(() => vi.fn()),
  loadWorkspaceSkillEntries: vi.fn(() => []),
  resolveSkillsPromptForRun: vi.fn(() => ""),
}));

vi.mock("../transcript-policy.js", () => ({
  resolveTranscriptPolicy: vi.fn(() => ({
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
    allowSyntheticToolResults: false,
  })),
}));

vi.mock("./extensions.js", () => ({
  buildEmbeddedExtensionPaths: vi.fn(() => ({})),
}));

vi.mock("./google.js", () => ({
  logToolSchemasForGoogle: vi.fn(),
  sanitizeSessionHistory: vi.fn(async () => []),
  sanitizeToolsForGoogle: vi.fn(({ tools }: { tools: unknown }) => tools),
}));

vi.mock("./history.js", () => ({
  getDmHistoryLimitFromSessionKey: vi.fn(() => undefined),
  limitHistoryTurns: vi.fn((m: unknown) => m),
}));

vi.mock("./lanes.js", () => ({
  resolveSessionLane: vi.fn(() => "session-lane"),
  resolveGlobalLane: vi.fn(() => "global-lane"),
}));

vi.mock("./logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./sandbox-info.js", () => ({
  buildEmbeddedSandboxInfo: vi.fn(() => null),
}));

vi.mock("./session-manager-cache.js", () => ({
  prewarmSessionFile: vi.fn(async () => {}),
  trackSessionManagerAccess: vi.fn(),
}));

vi.mock("./system-prompt.js", () => ({
  applySystemPromptOverrideToSession: vi.fn(),
  buildEmbeddedSystemPrompt: vi.fn(() => ""),
  createSystemPromptOverride: vi.fn(() => () => ""),
}));

vi.mock("./tool-split.js", () => ({
  splitSdkTools: vi.fn(() => ({ builtInTools: [], customTools: [] })),
}));

vi.mock("./utils.js", () => ({
  describeUnknownError: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
  mapThinkingLevel: vi.fn(() => undefined),
  resolveExecToolDefaults: vi.fn(() => ({})),
}));

vi.mock("../../auto-reply/heartbeat.js", () => ({
  resolveHeartbeatPrompt: vi.fn(() => undefined),
}));

vi.mock("../../process/command-queue.js", () => ({
  enqueueCommandInLane: vi.fn((_lane: string, task: () => unknown) => task()),
}));

vi.mock("../../routing/session-key.js", () => ({
  isSubagentSessionKey: vi.fn(() => false),
}));

vi.mock("../../signal/reaction-level.js", () => ({
  resolveSignalReactionLevel: vi.fn(() => ({})),
}));

vi.mock("../../telegram/inline-buttons.js", () => ({
  resolveTelegramInlineButtonsScope: vi.fn(() => "off"),
}));

vi.mock("../../telegram/reaction-level.js", () => ({
  resolveTelegramReactionLevel: vi.fn(() => ({})),
}));

vi.mock("../../tts/tts.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { log } from "./logger.js";
import { resolveModel } from "./model.js";

const mockedCreateAgentSession = vi.mocked(createAgentSession);
const mockedResolveModel = vi.mocked(resolveModel);

// Prevent process.chdir from failing on non-existent dirs
const originalChdir = process.chdir.bind(process);
vi.spyOn(process, "chdir").mockImplementation(() => {});

function mockSession(compactImpl?: () => Promise<unknown>) {
  const abortCompaction = vi.fn();
  const dispose = vi.fn();
  const compact =
    compactImpl ??
    vi.fn(async () => ({
      summary: "Test summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 100000,
    }));
  const session = {
    compact,
    abortCompaction,
    dispose,
    messages: [],
    agent: { replaceMessages: vi.fn() },
  };
  mockedCreateAgentSession.mockResolvedValue({ session } as never);
  return session;
}

const baseParams = {
  sessionId: "test-session",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
};

describe("compactEmbeddedPiSessionDirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok on successful compaction", async () => {
    mockSession();

    const result = await compactEmbeddedPiSessionDirect(baseParams);

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toBe("Test summary");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("compaction: start"));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("compaction: done"));
  });

  it("aborts and returns timeout error when compaction exceeds timeoutMs", async () => {
    // compact() blocks until abortCompaction is called, then rejects
    let rejectCompact: (err: Error) => void;
    const session = mockSession(
      () =>
        new Promise((_resolve, reject) => {
          rejectCompact = reject;
        }),
    );
    // When abortCompaction is called (by the timeout), reject the pending compact()
    session.abortCompaction.mockImplementation(() => {
      rejectCompact(new Error("aborted"));
    });

    const result = await compactEmbeddedPiSessionDirect({
      ...baseParams,
      config: {
        agents: { defaults: { compaction: { timeoutMs: 50 } } },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("compaction_timeout (50ms)");
    expect(session.abortCompaction).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("compaction: timeout"));
  });

  it("uses compaction model override when configured", async () => {
    mockSession();

    await compactEmbeddedPiSessionDirect({
      ...baseParams,
      config: {
        agents: {
          defaults: { compaction: { model: "openai/gpt-4o-mini" } },
        },
      },
    });

    expect(mockedResolveModel).toHaveBeenCalledWith(
      "openai",
      "gpt-4o-mini",
      expect.any(String),
      expect.anything(),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("compaction: using override model"),
    );
  });

  it("returns error for unknown model override", async () => {
    mockedResolveModel.mockReturnValueOnce({
      model: null,
      error: "Unknown model: bad-provider/bad-model",
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    } as never);

    const result = await compactEmbeddedPiSessionDirect({
      ...baseParams,
      config: {
        agents: {
          defaults: { compaction: { model: "bad-provider/bad-model" } },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("Unknown model");
  });

  it("re-throws non-timeout errors from compact()", async () => {
    mockSession(async () => {
      throw new Error("LLM API error");
    });

    const result = await compactEmbeddedPiSessionDirect(baseParams);

    // The error is caught by the outer catch and returned as reason
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("LLM API error");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("compaction: error"));
  });
});
