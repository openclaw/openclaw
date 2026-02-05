import { describe, expect, it, vi } from "vitest";

let shouldEmitResponseStart = false;
const { triggerInternalHook } = vi.hoisted(() => ({
  triggerInternalHook: vi.fn(),
}));

vi.mock("../../../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../../../hooks/internal-hooks.js")>(
    "../../../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook,
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => {
  return {
    createAgentSession: vi.fn(async () => {
      return {
        session: {
          sessionId: "session-1",
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
          agent: {
            replaceMessages: vi.fn(),
            streamFn: vi.fn(),
          },
          prompt: vi.fn(async () => {}),
          steer: vi.fn(async () => {}),
          abort: vi.fn(async () => {}),
          isStreaming: false,
          dispose: vi.fn(),
        },
      };
    }),
    SessionManager: {
      open: vi.fn(() => ({})),
    },
    SettingsManager: {
      create: vi.fn(() => ({})),
    },
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ isFile: () => true })),
  },
}));

vi.mock("../../sandbox.js", () => ({
  resolveSandboxContext: vi.fn(async () => null),
}));

vi.mock("../../sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ mode: "off", sandboxed: false })),
}));

vi.mock("../../skills.js", () => ({
  applySkillEnvOverrides: vi.fn(() => () => {}),
  applySkillEnvOverridesFromSnapshot: vi.fn(() => () => {}),
  loadWorkspaceSkillEntries: vi.fn(() => []),
  resolveSkillsPromptForRun: vi.fn(() => undefined),
}));

vi.mock("../../bootstrap-files.js", () => ({
  makeBootstrapWarn: vi.fn(() => () => {}),
  resolveBootstrapContextForRun: vi.fn(async () => ({
    bootstrapFiles: [],
    contextFiles: [],
  })),
}));

vi.mock("../../docs-path.js", () => ({
  resolveOpenClawDocsPath: vi.fn(async () => undefined),
}));

vi.mock("../../agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp"),
}));

vi.mock("../../agent-scope.js", () => ({
  resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
}));

vi.mock("../../date-time.js", () => ({
  resolveUserTimezone: vi.fn(() => "UTC"),
  resolveUserTimeFormat: vi.fn(() => ""),
  formatUserTime: vi.fn(() => ""),
}));

vi.mock("../../channel-tools.js", () => ({
  listChannelSupportedActions: vi.fn(() => undefined),
  resolveChannelMessageToolHints: vi.fn(() => undefined),
}));

vi.mock("../../../telegram/inline-buttons.js", () => ({
  resolveTelegramInlineButtonsScope: vi.fn(() => "off"),
}));

vi.mock("../../../telegram/reaction-level.js", () => ({
  resolveTelegramReactionLevel: vi.fn(() => ({ agentReactionGuidance: null })),
}));

vi.mock("../../../signal/reaction-level.js", () => ({
  resolveSignalReactionLevel: vi.fn(() => ({ agentReactionGuidance: null })),
}));

vi.mock("../../pi-tools.js", () => ({
  createOpenClawCodingTools: vi.fn(() => []),
}));

vi.mock("../session-manager-init.js", () => ({
  prepareSessionManagerForRun: vi.fn(async () => {}),
}));

vi.mock("../../session-file-repair.js", () => ({
  repairSessionFileIfNeeded: vi.fn(async () => {}),
}));

vi.mock("../../session-write-lock.js", () => ({
  acquireSessionWriteLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
}));

vi.mock("../../../auto-reply/heartbeat.js", () => ({
  resolveHeartbeatPrompt: vi.fn(() => undefined),
}));

vi.mock("../../pi-embedded-helpers.js", () => ({
  resolveBootstrapMaxChars: vi.fn(() => 0),
  validateAnthropicTurns: vi.fn((m: unknown[]) => m),
  validateGeminiTurns: vi.fn((m: unknown[]) => m),
  isCloudCodeAssistFormatError: vi.fn(() => false),
}));

vi.mock("../../model-auth.js", () => ({
  resolveModelAuthMode: vi.fn(() => "env"),
}));

vi.mock("../../model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "mock" })),
}));

vi.mock("../../pi-settings.js", () => ({
  ensurePiCompactionReserveTokens: vi.fn(),
  resolveCompactionReserveTokensFloor: vi.fn(() => 0),
}));

vi.mock("../../cache-ttl.js", () => ({
  appendCacheTtlTimestamp: vi.fn(),
  isCacheTtlEligibleProvider: vi.fn(() => false),
}));

vi.mock("../../transcript-policy.js", () => ({
  resolveTranscriptPolicy: vi.fn(() => ({
    allowSyntheticToolResults: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
  })),
}));

vi.mock("../../session-tool-result-guard-wrapper.js", () => ({
  guardSessionManager: vi.fn(() => ({
    getLeafEntry: vi.fn(() => null),
    flushPendingToolResults: vi.fn(),
  })),
}));

vi.mock("../../pi-embedded-runner/extensions.js", () => ({
  buildEmbeddedExtensionPaths: vi.fn(),
}));

vi.mock("../../pi-embedded-runner/tool-split.js", () => ({
  splitSdkTools: vi.fn(() => ({ builtInTools: [], customTools: [] })),
}));

vi.mock("../../pi-embedded-runner/system-prompt.js", () => ({
  applySystemPromptOverrideToSession: vi.fn(),
  buildEmbeddedSystemPrompt: vi.fn(() => ""),
  createSystemPromptOverride: vi.fn(() => () => ""),
}));

vi.mock("../../pi-embedded-runner/google.js", () => ({
  sanitizeSessionHistory: vi.fn(async (params: { messages: unknown[] }) => params.messages),
  sanitizeToolsForGoogle: vi.fn(({ tools }: { tools: unknown[] }) => tools),
  logToolSchemasForGoogle: vi.fn(),
}));

vi.mock("../../pi-embedded-runner/history.js", () => ({
  getDmHistoryLimitFromSessionKey: vi.fn(() => undefined),
  limitHistoryTurns: vi.fn((m: unknown[]) => m),
}));

vi.mock("../../pi-embedded-runner/session-manager-cache.js", () => ({
  prewarmSessionFile: vi.fn(async () => {}),
  trackSessionManagerAccess: vi.fn(),
}));

vi.mock("../../system-prompt-params.js", () => ({
  buildSystemPromptParams: vi.fn(() => ({
    runtimeInfo: {},
    userTimezone: undefined,
    userTime: undefined,
    userTimeFormat: undefined,
  })),
}));

vi.mock("../../pi-embedded-runner/logger.js", () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../pi-tool-definition-adapter.js", () => ({
  toClientToolDefinitions: vi.fn(() => []),
}));

vi.mock("../extra-params.js", () => ({
  applyExtraParamsToAgent: vi.fn(),
}));

vi.mock("../../pi-embedded-runner/sandbox-info.js", () => ({
  buildEmbeddedSandboxInfo: vi.fn(() => undefined),
}));

vi.mock("../runs.js", () => ({
  setActiveEmbeddedRun: vi.fn(),
  clearActiveEmbeddedRun: vi.fn(),
}));

vi.mock("./images.js", () => ({
  detectAndLoadPromptImages: vi.fn(async () => ({
    images: [],
    historyImagesByIndex: new Map(),
  })),
}));

vi.mock("../../pi-embedded-runner/utils.js", () => ({
  describeUnknownError: vi.fn((err: unknown) => String(err)),
  mapThinkingLevel: vi.fn(() => "off"),
}));

vi.mock("../../pi-embedded-subscribe.js", () => ({
  subscribeEmbeddedPiSession: vi.fn((params: { onAssistantMessageStart?: () => void }) => {
    if (shouldEmitResponseStart) {
      params.onAssistantMessageStart?.();
    }
    return {
      assistantTexts: [],
      toolMetas: [],
      unsubscribe: vi.fn(),
      waitForCompactionRetry: vi.fn(async () => {}),
      getMessagingToolSentTexts: vi.fn(() => []),
      getMessagingToolSentTargets: vi.fn(() => []),
      didSendViaMessagingTool: vi.fn(() => false),
      getLastToolError: vi.fn(() => undefined),
      isCompacting: vi.fn(() => false),
    };
  }),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "machine"),
}));

vi.mock("../../../config/channel-capabilities.js", () => ({
  resolveChannelCapabilities: vi.fn(() => undefined),
}));

vi.mock("../../../utils/message-channel.js", () => ({
  normalizeMessageChannel: vi.fn(() => undefined),
}));

vi.mock("../../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn(() => false),
}));

vi.mock("../../../tts/tts.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

vi.mock("../../cache-trace.js", () => ({
  createCacheTrace: vi.fn(() => null),
}));

vi.mock("../../anthropic-payload-log.js", () => ({
  createAnthropicPayloadLogger: vi.fn(() => null),
}));

vi.mock("../../failover-error.js", () => ({
  isTimeoutError: vi.fn(() => false),
}));

vi.mock("../../../media/constants.js", () => ({
  MAX_IMAGE_BYTES: 1024,
}));

vi.mock("../../providers/github-copilot-token.js", () => ({}));

vi.mock("../../pi-embedded-runner/model.js", () => ({
  buildModelAliasLines: vi.fn(() => []),
}));

vi.mock("../../system-prompt-report.js", () => ({
  buildSystemPromptReport: vi.fn(() => ({
    source: "run",
    generatedAt: Date.now(),
  })),
}));

import { runEmbeddedAttempt } from "./attempt.js";

const baseParams = {
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  workspaceDir: "/tmp",
  sessionFile: "/tmp/session.jsonl",
  prompt: "hello",
  provider: "openai",
  modelId: "mock",
  model: { provider: "openai", api: "responses", id: "mock", input: [] },
  authStorage: { setRuntimeApiKey: vi.fn() },
  modelRegistry: {},
  thinkLevel: "off",
  verboseLevel: "off",
  reasoningLevel: "off",
  toolResultFormat: "text",
  timeoutMs: 1000,
  runId: "run-1",
};

describe("runEmbeddedAttempt hook lifecycle", () => {
  it("fires thinking hooks even without response output", async () => {
    shouldEmitResponseStart = false;
    triggerInternalHook.mockClear();

    await runEmbeddedAttempt({
      ...baseParams,
    } as never);

    const thinkingStart = triggerInternalHook.mock.calls.find(
      (call) => call[0]?.type === "agent" && call[0]?.action === "thinking:start",
    )?.[0];
    const thinkingEnd = triggerInternalHook.mock.calls.find(
      (call) => call[0]?.type === "agent" && call[0]?.action === "thinking:end",
    )?.[0];

    expect(thinkingStart).toBeTruthy();
    expect(thinkingEnd).toBeTruthy();
    const responseStart = triggerInternalHook.mock.calls.find(
      (call) => call[0]?.type === "agent" && call[0]?.action === "response:start",
    )?.[0];
    const responseEnd = triggerInternalHook.mock.calls.find(
      (call) => call[0]?.type === "agent" && call[0]?.action === "response:end",
    )?.[0];
    expect(responseStart).toBeUndefined();
    expect(responseEnd).toBeUndefined();
  });

  it("fires response hooks when assistant output begins", async () => {
    shouldEmitResponseStart = true;
    triggerInternalHook.mockClear();

    await runEmbeddedAttempt({
      ...baseParams,
    } as never);

    const responseStart = triggerInternalHook.mock.calls.find(
      (call) => call[0]?.type === "agent" && call[0]?.action === "response:start",
    )?.[0];
    const responseEnd = triggerInternalHook.mock.calls.find(
      (call) => call[0]?.type === "agent" && call[0]?.action === "response:end",
    )?.[0];

    expect(responseStart).toBeTruthy();
    expect(responseEnd).toBeTruthy();
  });
});
