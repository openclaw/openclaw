import { beforeEach, describe, expect, it, vi } from "vitest";

const hookRunner = {
  hasHooks: vi.fn(() => true),
  runBeforeCompaction: vi.fn(),
  runAfterCompaction: vi.fn(),
};

const sessionState = {
  messages: [
    {
      role: "user",
      content: "before",
      nested: { count: 1 },
    },
    {
      role: "assistant",
      content: "after",
    },
  ],
  compactResult: {
    summary: "compacted",
    firstKeptEntryId: "keep-1",
    tokensBefore: 10_000,
  },
};

const hookEvents: {
  before?: { messageCount: number; messages: unknown[] };
  after?: { messageCount: number; messages: unknown[] };
} = {};

type Deferred = Promise<void> & { resolve: () => void };
const createDeferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  }) as Deferred;
  promise.resolve = resolve;
  return promise;
};

let beforeGate: Deferred;
let afterGate: Deferred;

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn(async () => ({
    session: {
      messages: sessionState.messages,
      agent: { replaceMessages: vi.fn() },
      compact: vi.fn(async () => sessionState.compactResult),
      dispose: vi.fn(),
    },
  })),
  estimateTokens: vi.fn(() => 1234),
  SessionManager: {
    open: vi.fn(() => ({ flushPendingToolResults: vi.fn() })),
  },
  SettingsManager: {
    create: vi.fn(() => ({})),
  },
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => {}),
  },
  mkdir: vi.fn(async () => {}),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunner,
}));

vi.mock("../../auto-reply/heartbeat.js", () => ({
  resolveHeartbeatPrompt: vi.fn(() => undefined),
}));

vi.mock("../../config/channel-capabilities.js", () => ({
  resolveChannelCapabilities: vi.fn(() => []),
}));

vi.mock("../../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "agent-machine"),
}));

vi.mock("../../process/command-queue.js", () => ({
  enqueueCommand: vi.fn(),
  enqueueCommandInLane: vi.fn(async (_lane: string, task: () => Promise<unknown>) => task()),
}));

vi.mock("../../routing/session-key.js", () => ({
  isCronSessionKey: vi.fn(() => false),
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

vi.mock("../../utils.js", () => ({
  resolveUserPath: vi.fn((value: string) => value),
}));

vi.mock("../../utils/message-channel.js", () => ({
  normalizeMessageChannel: vi.fn((value: string | undefined) => value),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn(() => false),
}));

vi.mock("../agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agent"),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "agent", sessionAgentId: "agent" })),
}));

vi.mock("../bootstrap-files.js", () => ({
  makeBootstrapWarn: vi.fn(() => ({ message: "warn" })),
  resolveBootstrapContextForRun: vi.fn(async () => ({ contextFiles: [] })),
}));

vi.mock("../channel-tools.js", () => ({
  listChannelSupportedActions: vi.fn(() => []),
  resolveChannelMessageToolHints: vi.fn(() => []),
}));

vi.mock("../date-time.js", () => ({
  formatUserTime: vi.fn(() => "2026-02-14T00:00:00.000Z"),
  resolveUserTimeFormat: vi.fn(() => undefined),
  resolveUserTimezone: vi.fn(() => undefined),
}));

vi.mock("../defaults.js", () => ({
  DEFAULT_MODEL: "test-model",
  DEFAULT_PROVIDER: "test-provider",
}));

vi.mock("../docs-path.js", () => ({
  resolveOpenClawDocsPath: vi.fn(async () => "/tmp/docs"),
}));

vi.mock("../model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({ apiKey: "api-key", mode: "env" })),
  resolveModelAuthMode: vi.fn(() => "env"),
}));

vi.mock("../models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => {}),
}));

vi.mock("../pi-embedded-helpers.js", () => ({
  ensureSessionHeader: vi.fn(async () => {}),
  validateAnthropicTurns: vi.fn((messages) => messages),
  validateGeminiTurns: vi.fn((messages) => messages),
}));

vi.mock("../pi-settings.js", () => ({
  ensurePiCompactionReserveTokens: vi.fn(),
  resolveCompactionReserveTokensFloor: vi.fn(() => 0),
}));

vi.mock("../pi-tools.js", () => ({
  createOpenClawCodingTools: vi.fn(() => []),
}));

vi.mock("../sandbox.js", () => ({
  resolveSandboxContext: vi.fn(async () => ({ enabled: false })),
}));

vi.mock("../session-file-repair.js", () => ({
  repairSessionFileIfNeeded: vi.fn(async () => {}),
}));

vi.mock("../session-tool-result-guard-wrapper.js", () => ({
  guardSessionManager: vi.fn((manager) => manager),
}));

vi.mock("../session-transcript-repair.js", () => ({
  sanitizeToolUseResultPairing: vi.fn((messages) => messages),
}));

vi.mock("../session-write-lock.js", () => ({
  acquireSessionWriteLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
}));

vi.mock("../shell-utils.js", () => ({
  detectRuntimeShell: vi.fn(() => "bash"),
}));

vi.mock("../skills.js", () => ({
  applySkillEnvOverrides: vi.fn(() => () => {}),
  applySkillEnvOverridesFromSnapshot: vi.fn(() => () => {}),
  loadWorkspaceSkillEntries: vi.fn(() => []),
  resolveSkillsPromptForRun: vi.fn(() => ""),
}));

vi.mock("../transcript-policy.js", () => ({
  resolveTranscriptPolicy: vi.fn(() => ({
    allowSyntheticToolResults: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
    repairToolUseResultPairing: false,
  })),
}));

vi.mock("./extensions.js", () => ({
  buildEmbeddedExtensionPaths: vi.fn(() => {}),
}));

vi.mock("./google.js", () => ({
  logToolSchemasForGoogle: vi.fn(),
  sanitizeSessionHistory: vi.fn((messages) => messages),
  sanitizeToolsForGoogle: vi.fn((tools) => tools),
}));

vi.mock("./history.js", () => ({
  getDmHistoryLimitFromSessionKey: vi.fn(() => undefined),
  limitHistoryTurns: vi.fn((messages) => messages),
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
  buildModelAliasLines: vi.fn(() => ""),
  resolveModel: vi.fn(() => ({
    model: { provider: "test-provider", id: "test-model", contextWindow: 200_000, api: "messages" },
    error: null,
    authStorage: {
      setRuntimeApiKey: vi.fn(),
    },
    modelRegistry: {},
  })),
}));

vi.mock("./sandbox-info.js", () => ({
  buildEmbeddedSandboxInfo: vi.fn(() => ({})),
}));

vi.mock("./session-manager-cache.js", () => ({
  prewarmSessionFile: vi.fn(async () => {}),
  trackSessionManagerAccess: vi.fn(),
}));

vi.mock("./system-prompt.js", () => ({
  applySystemPromptOverrideToSession: vi.fn(),
  buildEmbeddedSystemPrompt: vi.fn(() => ""),
  createSystemPromptOverride: vi.fn(() => vi.fn()),
}));

vi.mock("./tool-split.js", () => ({
  splitSdkTools: vi.fn(() => ({ builtInTools: [], customTools: [] })),
}));

vi.mock("./utils.js", () => ({
  describeUnknownError: vi.fn((err: unknown) => String(err)),
  mapThinkingLevel: vi.fn((level: string | undefined) => level),
}));

vi.mock("./wait-for-idle-before-flush.js", () => ({
  flushPendingToolResultsAfterIdle: vi.fn(async () => {}),
}));

import { COMPACTION_HOOK_TIMEOUT_MS, compactEmbeddedPiSessionDirect } from "./compact.js";

describe("compactEmbeddedPiSessionDirect hook handling", () => {
  beforeEach(() => {
    hookEvents.before = undefined;
    hookEvents.after = undefined;
    beforeGate = createDeferred();
    afterGate = createDeferred();
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();

    hookRunner.runBeforeCompaction.mockImplementation(async (event: { messages: unknown[] }) => {
      hookEvents.before = { messageCount: event.messageCount, messages: event.messages };
      (event.messages[0] as { role: string }).role = "mutated-before";
      await beforeGate;
    });
    hookRunner.runAfterCompaction.mockImplementation(async (event: { messages: unknown[] }) => {
      hookEvents.after = { messageCount: event.messageCount, messages: event.messages };
      (event.messages[0] as { role: string }).role = "mutated-after";
      await afterGate;
    });
  });

  it("awaits compaction hooks before restoring process cwd", async () => {
    const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => undefined);
    chdirSpy.mockClear();
    const resultPromise = compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      runId: "run-1",
      model: "test-model",
      provider: "test-provider",
      sessionKey: "session-1",
      messageChannel: "telegram",
      messageProvider: "telegram",
      config: undefined,
      authProfileId: undefined,
      agentAccountId: "agent",
      bashElevated: undefined,
      customInstructions: "custom",
      thinkLevel: undefined,
      reasoningLevel: undefined,
      ownerNumbers: [],
    } as never);

    await vi.waitFor(() => {
      expect(hookEvents.before).toBeDefined();
    });
    expect(chdirSpy.mock.calls).toHaveLength(1);

    beforeGate.resolve();

    await Promise.resolve();
    expect(hookEvents.after).toBeDefined();

    afterGate.resolve();
    await resultPromise;

    expect(chdirSpy.mock.calls).toHaveLength(2);
    expect(chdirSpy.mock.calls[0]?.[0]).toBe("/tmp/workspace");
    expect(chdirSpy.mock.calls[1]?.[0]).toBe(process.cwd());
  });

  it("passes deep-cloned message arrays to compaction hooks", async () => {
    const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => undefined);
    chdirSpy.mockClear();
    beforeGate.resolve();
    afterGate.resolve();

    await compactEmbeddedPiSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      messageChannel: "telegram",
      messageProvider: "telegram",
      sessionKey: "session-1",
      agentAccountId: "agent",
      config: undefined,
      authProfileId: undefined,
      bashElevated: undefined,
      customInstructions: "custom",
      thinkLevel: undefined,
      reasoningLevel: undefined,
      ownerNumbers: [],
    } as never);

    expect(hookEvents.before?.messageCount).toBe(sessionState.messages.length);
    expect(hookEvents.after?.messageCount).toBe(sessionState.messages.length);
    expect(hookEvents.before?.messages).not.toBe(sessionState.messages as never);
    expect(hookEvents.after?.messages).not.toBe(sessionState.messages as never);
    expect((sessionState.messages[0] as { role: string }).role).toBe("user");
    expect((sessionState.messages[0] as { nested: { count: number } }).nested.count).toBe(1);
  });

  it("times out stuck compaction hooks so cleanup can complete", async () => {
    vi.useFakeTimers();
    try {
      hookRunner.runBeforeCompaction.mockImplementation(async () => new Promise<void>(() => {}));
      hookRunner.runAfterCompaction.mockImplementation(async () => new Promise<void>(() => {}));
      const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => undefined);
      chdirSpy.mockClear();

      let resolved = false;
      const resultPromise = compactEmbeddedPiSessionDirect({
        sessionId: "session-1",
        sessionFile: "/tmp/session.json",
        workspaceDir: "/tmp/workspace",
        messageChannel: "telegram",
        messageProvider: "telegram",
        sessionKey: "session-1",
        agentAccountId: "agent",
        config: undefined,
        authProfileId: undefined,
        bashElevated: undefined,
        customInstructions: "custom",
        thinkLevel: undefined,
        reasoningLevel: undefined,
        ownerNumbers: [],
      } as never).then((result) => {
        resolved = true;
        return result;
      });

      await Promise.resolve();
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(2 * COMPACTION_HOOK_TIMEOUT_MS + 10);
      const result = await resultPromise;
      expect(result.ok).toBe(true);
      expect(chdirSpy.mock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
