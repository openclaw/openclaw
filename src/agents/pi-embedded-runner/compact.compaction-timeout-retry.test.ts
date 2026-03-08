import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks for compaction-safety-timeout and tool-result-truncation so they can be
// configured per-test before the module under test is imported.
const { compactWithSafetyTimeoutMock, truncateOversizedToolResultsMock } = vi.hoisted(() => ({
  compactWithSafetyTimeoutMock: vi.fn(),
  truncateOversizedToolResultsMock: vi.fn(),
}));

vi.mock("./compaction-safety-timeout.js", () => ({
  EMBEDDED_COMPACTION_TIMEOUT_MS: 300_000,
  EMBEDDED_COMPACTION_RETRY_TIMEOUT_MS: 120_000,
  compactWithSafetyTimeout: compactWithSafetyTimeoutMock,
}));

vi.mock("./tool-result-truncation.js", () => ({
  truncateOversizedToolResultsInMessages: truncateOversizedToolResultsMock,
}));

// ---- session/compact mock (shared state per test) ----
let sessionMessages: unknown[];
let _compactCallCount: number;
const replaceMessagesMock = vi.fn((msgs: unknown[]) => {
  sessionMessages = [...msgs];
});
const compactMock = vi.fn(async () => {
  _compactCallCount++;
  // Simulate compaction trimming to a single message
  sessionMessages = sessionMessages.slice(0, 1);
  return { summary: "summary", firstKeptEntryId: "e1", tokensBefore: 100, details: { ok: true } };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn(async () => ({
    session: {
      get sessionId() {
        return "session-1";
      },
      get messages() {
        return sessionMessages;
      },
      agent: { replaceMessages: replaceMessagesMock, streamFn: vi.fn() },
      compact: compactMock,
      dispose: vi.fn(),
    },
  })),
  SessionManager: { open: vi.fn(() => ({})) },
  SettingsManager: { create: vi.fn(() => ({})) },
  estimateTokens: vi.fn(() => 10),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({ hasHooks: vi.fn(() => false) }),
}));
vi.mock("../../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../../hooks/internal-hooks.js")>(
    "../../hooks/internal-hooks.js",
  );
  return { ...actual, triggerInternalHook: vi.fn() };
});
vi.mock("../session-tool-result-guard-wrapper.js", () => ({
  guardSessionManager: vi.fn(() => ({ flushPendingToolResults: vi.fn() })),
}));
vi.mock("../pi-settings.js", () => ({
  ensurePiCompactionReserveTokens: vi.fn(),
  resolveCompactionReserveTokensFloor: vi.fn(() => 0),
}));
vi.mock("../models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => {}),
}));
vi.mock("../model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({ apiKey: "test", mode: "env" })),
  resolveModelAuthMode: vi.fn(() => "env"),
}));
vi.mock("../sandbox.js", () => ({
  resolveSandboxContext: vi.fn(async () => null),
}));
vi.mock("../session-file-repair.js", () => ({
  repairSessionFileIfNeeded: vi.fn(async () => {}),
}));
vi.mock("../session-write-lock.js", () => ({
  acquireSessionWriteLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
  resolveSessionLockMaxHoldFromTimeout: vi.fn(() => 0),
}));
vi.mock("../bootstrap-files.js", () => ({
  makeBootstrapWarn: vi.fn(() => () => {}),
  resolveBootstrapContextForRun: vi.fn(async () => ({ contextFiles: [] })),
}));
vi.mock("../docs-path.js", () => ({
  resolveOpenClawDocsPath: vi.fn(async () => undefined),
}));
vi.mock("../channel-tools.js", () => ({
  listChannelSupportedActions: vi.fn(() => undefined),
  resolveChannelMessageToolHints: vi.fn(() => undefined),
}));
vi.mock("../pi-tools.js", () => ({
  createOpenClawCodingTools: vi.fn(() => []),
}));
vi.mock("./google.js", () => ({
  logToolSchemasForGoogle: vi.fn(),
  sanitizeSessionHistory: vi.fn(async (p: { messages: unknown[] }) => p.messages),
  sanitizeToolsForGoogle: vi.fn(({ tools }: { tools: unknown[] }) => tools),
}));
vi.mock("./tool-split.js", () => ({
  splitSdkTools: vi.fn(() => ({ builtInTools: [], customTools: [] })),
}));
vi.mock("../transcript-policy.js", () => ({
  resolveTranscriptPolicy: vi.fn(() => ({
    allowSyntheticToolResults: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
  })),
}));
vi.mock("./extensions.js", () => ({
  buildEmbeddedExtensionFactories: vi.fn(() => []),
}));
vi.mock("./history.js", () => ({
  getDmHistoryLimitFromSessionKey: vi.fn(() => undefined),
  limitHistoryTurns: vi.fn((msgs: unknown[]) => msgs),
}));
vi.mock("../skills.js", () => ({
  applySkillEnvOverrides: vi.fn(() => () => {}),
  applySkillEnvOverridesFromSnapshot: vi.fn(() => () => {}),
  loadWorkspaceSkillEntries: vi.fn(() => []),
  resolveSkillsPromptForRun: vi.fn(() => undefined),
}));
vi.mock("../agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp"),
}));
vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
}));
vi.mock("../date-time.js", () => ({
  formatUserTime: vi.fn(() => ""),
  resolveUserTimeFormat: vi.fn(() => ""),
  resolveUserTimezone: vi.fn(() => ""),
}));
vi.mock("../defaults.js", () => ({
  DEFAULT_MODEL: "fake-model",
  DEFAULT_PROVIDER: "openai",
  DEFAULT_CONTEXT_TOKENS: 200_000,
}));
vi.mock("../utils.js", () => ({
  resolveUserPath: vi.fn((p: string) => p),
}));
vi.mock("../../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "machine"),
}));
vi.mock("../../config/channel-capabilities.js", () => ({
  resolveChannelCapabilities: vi.fn(() => undefined),
}));
vi.mock("../../utils/message-channel.js", () => ({
  normalizeMessageChannel: vi.fn(() => undefined),
}));
vi.mock("../pi-embedded-helpers.js", () => ({
  ensureSessionHeader: vi.fn(async () => {}),
  validateAnthropicTurns: vi.fn((m: unknown[]) => m),
  validateGeminiTurns: vi.fn((m: unknown[]) => m),
}));
vi.mock("../pi-project-settings.js", () => ({
  createPreparedEmbeddedPiSettingsManager: vi.fn(() => ({
    getGlobalSettings: vi.fn(() => ({})),
  })),
}));
vi.mock("./sandbox-info.js", () => ({
  buildEmbeddedSandboxInfo: vi.fn(() => undefined),
}));
vi.mock("./model.js", () => ({
  buildModelAliasLines: vi.fn(() => []),
  resolveModel: vi.fn(() => ({
    model: { provider: "openai", api: "responses", id: "fake", contextWindow: 200_000, input: [] },
    error: null,
    authStorage: { setRuntimeApiKey: vi.fn() },
    modelRegistry: {},
  })),
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
vi.mock("./utils.js", () => ({
  describeUnknownError: vi.fn((err: unknown) => String(err)),
  mapThinkingLevel: vi.fn(() => "off"),
  resolveExecToolDefaults: vi.fn(() => undefined),
}));

import { compactEmbeddedPiSessionDirect } from "./compact.js";

const COMPACT_PARAMS = {
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  sessionFile: "/tmp/session.jsonl",
  workspaceDir: "/tmp",
  customInstructions: "be concise",
} as const;

const TOOL_RESULT_MSG = {
  role: "toolResult",
  toolCallId: "t1",
  toolName: "web_search",
  content: [{ type: "text", text: "x".repeat(50_000) }],
  isError: false,
  timestamp: 3,
};

const COMPACT_SUCCESS = {
  summary: "summary",
  firstKeptEntryId: "e1",
  tokensBefore: 100,
  details: { ok: true },
};

function makeTimeoutError(): Error {
  return new Error("Compaction timed out");
}

describe("compactEmbeddedPiSessionDirect — compaction timeout retry", () => {
  beforeEach(() => {
    compactCallCount = 0;
    sessionMessages = [
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
      { ...TOOL_RESULT_MSG },
    ];
    compactWithSafetyTimeoutMock.mockReset();
    truncateOversizedToolResultsMock.mockReset();
    replaceMessagesMock.mockClear();
    compactMock.mockClear();

    // Default: truncation returns messages with one tool result truncated
    truncateOversizedToolResultsMock.mockImplementation((msgs: unknown[]) => ({
      messages: msgs,
      truncatedCount: 1,
    }));
  });

  it("retries with reduced context after initial timeout and returns success", async () => {
    // First call times out; second (retry) succeeds.
    compactWithSafetyTimeoutMock
      .mockRejectedValueOnce(makeTimeoutError())
      .mockImplementationOnce(async (fn: () => Promise<typeof COMPACT_SUCCESS>) => fn());

    const result = await compactEmbeddedPiSessionDirect(COMPACT_PARAMS);

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);

    // truncateOversizedToolResultsInMessages was called once (before retry)
    expect(truncateOversizedToolResultsMock).toHaveBeenCalledTimes(1);
    // compactWithSafetyTimeout was called twice: initial + retry
    expect(compactWithSafetyTimeoutMock).toHaveBeenCalledTimes(2);
    // The retry uses the shorter EMBEDDED_COMPACTION_RETRY_TIMEOUT_MS (120_000)
    expect(compactWithSafetyTimeoutMock.mock.calls[1][1]).toBe(120_000);
    // replaceMessages: 2 pre-existing calls (validate + limit-history) + 1 from retry truncation
    expect(replaceMessagesMock).toHaveBeenCalledTimes(3);
  });

  it("returns failure when both initial and retry timeout", async () => {
    compactWithSafetyTimeoutMock
      .mockRejectedValueOnce(makeTimeoutError())
      .mockRejectedValueOnce(makeTimeoutError());

    const result = await compactEmbeddedPiSessionDirect(COMPACT_PARAMS);

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    // The reason should mention the timeout
    expect((result as { reason?: string }).reason).toMatch(/timed out/i);
    // truncation was still attempted before the retry
    expect(truncateOversizedToolResultsMock).toHaveBeenCalledTimes(1);
    expect(compactWithSafetyTimeoutMock).toHaveBeenCalledTimes(2);
    // replaceMessages: 2 pre-existing + 1 from retry truncation
    expect(replaceMessagesMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-timeout errors and propagates them as failure", async () => {
    const networkErr = new Error("Network connection refused");
    compactWithSafetyTimeoutMock.mockRejectedValueOnce(networkErr);

    const result = await compactEmbeddedPiSessionDirect(COMPACT_PARAMS);

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    // No retry attempted
    expect(compactWithSafetyTimeoutMock).toHaveBeenCalledTimes(1);
    // No truncation attempted
    expect(truncateOversizedToolResultsMock).not.toHaveBeenCalled();
    // replaceMessages: only the 2 pre-existing calls (validate + limit-history), none from retry
    expect(replaceMessagesMock).toHaveBeenCalledTimes(2);
  });

  it("skips replaceMessages when truncation finds no oversized results", async () => {
    compactWithSafetyTimeoutMock
      .mockRejectedValueOnce(makeTimeoutError())
      .mockImplementationOnce(async (fn: () => Promise<typeof COMPACT_SUCCESS>) => fn());
    // Nothing to truncate
    truncateOversizedToolResultsMock.mockReturnValueOnce({
      messages: sessionMessages,
      truncatedCount: 0,
    });

    const result = await compactEmbeddedPiSessionDirect(COMPACT_PARAMS);

    expect(result.ok).toBe(true);
    expect(truncateOversizedToolResultsMock).toHaveBeenCalledTimes(1);
    // replaceMessages: only the 2 pre-existing calls; our retry code skips it when truncatedCount=0
    expect(replaceMessagesMock).toHaveBeenCalledTimes(2);
  });
});
