import { describe, expect, it, vi } from "vitest";

const { hookRunner, triggerInternalHook } = vi.hoisted(() => ({
  hookRunner: {
    hasHooks: vi.fn(),
    runBeforeCompaction: vi.fn(),
    runAfterCompaction: vi.fn(),
  },
  triggerInternalHook: vi.fn(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunner,
}));

vi.mock("../../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../../hooks/internal-hooks.js")>(
    "../../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook,
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => {
  return {
    createAgentSession: vi.fn(async () => {
      const session = {
        sessionId: "session-1",
        messages: [
          { role: "user", content: "hello", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
          {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "exec",
            content: [{ type: "text", text: "output" }],
            isError: false,
            timestamp: 3,
          },
        ],
        agent: { replaceMessages: vi.fn(), streamFn: vi.fn() },
        compact: vi.fn(async () => {
          // simulate compaction trimming to a single message
          session.messages.splice(1);
          return {
            summary: "summary",
            firstKeptEntryId: "entry-1",
            tokensBefore: 120,
            details: { ok: true },
          };
        }),
        dispose: vi.fn(),
      };
      return { session };
    }),
    SessionManager: {
      open: vi.fn(() => ({})),
    },
    SettingsManager: {
      create: vi.fn(() => ({})),
    },
    estimateTokens: vi.fn(() => 10),
  };
});

vi.mock("../session-tool-result-guard-wrapper.js", () => ({
  guardSessionManager: vi.fn(() => ({
    flushPendingToolResults: vi.fn(),
  })),
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
  sanitizeSessionHistory: vi.fn(async (params: { messages: unknown[] }) => params.messages),
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
  buildEmbeddedExtensionPaths: vi.fn(),
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

vi.mock("./sandbox-info.js", () => ({
  buildEmbeddedSandboxInfo: vi.fn(() => undefined),
}));

vi.mock("./model.js", () => ({
  buildModelAliasLines: vi.fn(() => []),
  resolveModel: vi.fn(() => ({
    model: { provider: "openai", api: "responses", id: "fake", input: [] },
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

const sessionHook = (action: string) =>
  triggerInternalHook.mock.calls.find(
    (call) => call[0]?.type === "session" && call[0]?.action === action,
  )?.[0];

describe("compactEmbeddedPiSessionDirect hooks", () => {
  it("emits internal + plugin compaction hooks with counts", async () => {
    hookRunner.hasHooks.mockReturnValue(true);

    const result = await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      customInstructions: "focus on decisions",
    });

    expect(result.ok).toBe(true);
    expect(sessionHook("compact:before")).toMatchObject({
      type: "session",
      action: "compact:before",
    });
    expect(sessionHook("compact:after")?.context).toMatchObject({
      messageCount: 1,
      compactedCount: 2,
    });

    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageCount: 3,
        tokenCount: 30,
      }),
      expect.objectContaining({ sessionKey: "agent:main:session-1" }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      {
        messageCount: 1,
        tokenCount: 10,
        compactedCount: 2,
      },
      expect.objectContaining({ sessionKey: "agent:main:session-1" }),
    );
  });
});
