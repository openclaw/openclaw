import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import { createPiToolsSandboxContext } from "../../test-helpers/pi-tools-sandbox-context.js";

const hoisted = vi.hoisted(() => {
  const createAgentSessionMock = vi.fn();
  const sessionManagerOpenMock = vi.fn();
  const resolveSandboxContextMock = vi.fn();
  const subscribeEmbeddedPiSessionMock = vi.fn();
  const acquireSessionWriteLockMock = vi.fn();
  const sessionManager = {
    getLeafEntry: vi.fn(() => null),
    branch: vi.fn(),
    resetLeaf: vi.fn(),
    buildSessionContext: vi.fn(() => ({ messages: [] })),
    appendCustomEntry: vi.fn(),
  };
  return {
    createAgentSessionMock,
    sessionManagerOpenMock,
    resolveSandboxContextMock,
    subscribeEmbeddedPiSessionMock,
    acquireSessionWriteLockMock,
    sessionManager,
  };
});

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();

  return {
    ...actual,
    createAgentSession: (...args: unknown[]) => hoisted.createAgentSessionMock(...args),
    DefaultResourceLoader: class {
      async reload() {}
    },
    SessionManager: {
      open: (...args: unknown[]) => hoisted.sessionManagerOpenMock(...args),
    } as unknown as typeof actual.SessionManager,
  };
});

vi.mock("../../sandbox.js", () => ({
  resolveSandboxContext: (...args: unknown[]) => hoisted.resolveSandboxContextMock(...args),
}));

vi.mock("../../session-tool-result-guard-wrapper.js", () => ({
  guardSessionManager: () => hoisted.sessionManager,
}));

vi.mock("../../pi-embedded-subscribe.js", () => ({
  subscribeEmbeddedPiSession: (...args: unknown[]) =>
    hoisted.subscribeEmbeddedPiSessionMock(...args),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => undefined,
}));

vi.mock("../../../infra/machine-name.js", () => ({
  getMachineDisplayName: async () => "test-host",
}));

vi.mock("../../../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: () => {},
  ensureGlobalUndiciStreamTimeouts: () => {},
}));

vi.mock("../../bootstrap-files.js", () => ({
  makeBootstrapWarn: () => () => {},
  resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
}));

vi.mock("../../skills.js", () => ({
  applySkillEnvOverrides: () => () => {},
  applySkillEnvOverridesFromSnapshot: () => () => {},
  resolveSkillsPromptForRun: () => "",
}));

vi.mock("../skills-runtime.js", () => ({
  resolveEmbeddedRunSkillEntries: () => ({
    shouldLoadSkillEntries: false,
    skillEntries: undefined,
  }),
}));

vi.mock("../../docs-path.js", () => ({
  resolveOpenClawDocsPath: async () => undefined,
}));

vi.mock("../../pi-project-settings.js", () => ({
  createPreparedEmbeddedPiSettingsManager: () => ({}),
}));

vi.mock("../../pi-settings.js", () => ({
  applyPiAutoCompactionGuard: () => {},
}));

vi.mock("../extensions.js", () => ({
  buildEmbeddedExtensionFactories: () => [],
}));

vi.mock("../google.js", () => ({
  logToolSchemasForGoogle: () => {},
  sanitizeSessionHistory: async ({ messages }: { messages: unknown[] }) => messages,
  sanitizeToolsForGoogle: ({ tools }: { tools: unknown[] }) => tools,
}));

vi.mock("../../session-file-repair.js", () => ({
  repairSessionFileIfNeeded: async () => {},
}));

vi.mock("../session-manager-cache.js", () => ({
  prewarmSessionFile: async () => {},
  trackSessionManagerAccess: () => {},
}));

vi.mock("../session-manager-init.js", () => ({
  prepareSessionManagerForRun: async () => {},
}));

vi.mock("../../session-write-lock.js", () => ({
  acquireSessionWriteLock: (...args: unknown[]) => hoisted.acquireSessionWriteLockMock(...args),
  resolveSessionLockMaxHoldFromTimeout: () => 1,
}));

vi.mock("../tool-result-context-guard.js", () => ({
  installToolResultContextGuard: () => () => {},
}));

vi.mock("../wait-for-idle-before-flush.js", () => ({
  flushPendingToolResultsAfterIdle: async () => {},
}));

vi.mock("../runs.js", () => ({
  setActiveEmbeddedRun: () => {},
  updateActiveEmbeddedRunSnapshot: () => {},
  clearActiveEmbeddedRun: () => {},
}));

vi.mock("./images.js", () => ({
  detectAndLoadPromptImages: async () => ({ images: [] }),
}));

vi.mock("../../system-prompt-params.js", () => ({
  buildSystemPromptParams: () => ({
    runtimeInfo: {},
    userTimezone: "UTC",
    userTime: "00:00",
    userTimeFormat: "24h",
  }),
}));

vi.mock("../../system-prompt-report.js", () => ({
  buildSystemPromptReport: () => undefined,
}));

vi.mock("../system-prompt.js", () => ({
  applySystemPromptOverrideToSession: () => {},
  buildEmbeddedSystemPrompt: () => "system prompt",
  createSystemPromptOverride: (prompt: string) => () => prompt,
}));

vi.mock("../extra-params.js", () => ({
  applyExtraParamsToAgent: () => {},
}));

vi.mock("../../openai-ws-stream.js", () => ({
  createOpenAIWebSocketStreamFn: vi.fn(),
  releaseWsSession: () => {},
}));

vi.mock("../../anthropic-payload-log.js", () => ({
  createAnthropicPayloadLogger: () => undefined,
}));

vi.mock("../../cache-trace.js", () => ({
  createCacheTrace: () => undefined,
}));

vi.mock("../../model-selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../model-selection.js")>();

  return {
    ...actual,
    normalizeProviderId: (providerId?: string) => providerId?.trim().toLowerCase() ?? "",
    resolveDefaultModelForAgent: () => ({ provider: "openai", model: "gpt-test" }),
  };
});

const { runEmbeddedAttempt } = await import("./attempt.js");

type MutableSession = {
  sessionId: string;
  messages: unknown[];
  isCompacting: boolean;
  isStreaming: boolean;
  agent: {
    streamFn?: unknown;
    replaceMessages: (messages: unknown[]) => void;
  };
  prompt: (prompt: string, options?: { images?: unknown[] }) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
  steer: (text: string) => Promise<void>;
};

function createSubscriptionMock() {
  return {
    assistantTexts: [] as string[],
    assistantOutputs: [] as Array<{ segmentId: string; text: string; phase?: string | null }>,
    toolMetas: [] as Array<{ toolName: string; meta?: string }>,
    unsubscribe: () => {},
    deliveredCommentarySegmentIds: () => [] as string[],
    getPendingCommentaryDeliveryCount: () => 1,
    waitForCommentaryDeliveryRound: async () => true,
    waitForCommentaryDelivery: async () => {},
    abortCommentaryDelivery: () => {},
    waitForCompactionRetry: async () => {},
    getMessagingToolSentTexts: () => [] as string[],
    getMessagingToolSentMediaUrls: () => [] as string[],
    getMessagingToolSentTargets: () => [] as unknown[],
    getSuccessfulCronAdds: () => 0,
    didSendViaMessagingTool: () => false,
    didSendDeterministicApprovalPrompt: () => false,
    getLastToolError: () => undefined,
    getUsageTotals: () => undefined,
    getCompactionCount: () => 0,
    isCompacting: () => false,
  };
}

describe("runEmbeddedAttempt live commentary forwarding", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    hoisted.createAgentSessionMock.mockReset();
    hoisted.sessionManagerOpenMock.mockReset().mockReturnValue(hoisted.sessionManager);
    hoisted.resolveSandboxContextMock.mockReset();
    hoisted.subscribeEmbeddedPiSessionMock.mockReset().mockImplementation(createSubscriptionMock);
    hoisted.acquireSessionWriteLockMock.mockReset().mockResolvedValue({
      release: async () => {},
    });
    hoisted.sessionManager.getLeafEntry.mockReset().mockReturnValue(null);
    hoisted.sessionManager.branch.mockReset();
    hoisted.sessionManager.resetLeaf.mockReset();
    hoisted.sessionManager.buildSessionContext.mockReset().mockReturnValue({ messages: [] });
    hoisted.sessionManager.appendCustomEntry.mockReset();
  });

  afterEach(async () => {
    while (tempPaths.length > 0) {
      const target = tempPaths.pop();
      if (target) {
        await fs.rm(target, { recursive: true, force: true });
      }
    }
  });

  it("passes onCommentaryReply into subscribeEmbeddedPiSession", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commentary-workspace-"));
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commentary-agent-"));
    tempPaths.push(workspaceDir, agentDir);

    hoisted.resolveSandboxContextMock.mockResolvedValue(
      createPiToolsSandboxContext({
        workspaceDir,
        fsBridge: createHostSandboxFsBridge(workspaceDir),
        tools: { allow: [], deny: [] },
        sessionKey: "agent:main:main",
      }),
    );

    hoisted.createAgentSessionMock.mockImplementation(
      async (_params: { customTools: ToolDefinition[] }) => {
        const session: MutableSession = {
          sessionId: "embedded-session",
          messages: [],
          isCompacting: false,
          isStreaming: false,
          agent: {
            replaceMessages: (messages: unknown[]) => {
              session.messages = [...messages];
            },
          },
          prompt: async () => {},
          abort: async () => {},
          dispose: () => {},
          steer: async () => {},
        };

        return { session };
      },
    );

    const model = {
      api: "openai-completions",
      provider: "openai",
      compat: {},
      contextWindow: 8192,
      input: ["text"],
    } as unknown as Model<Api>;
    const onCommentaryReply = vi.fn();

    const result = await runEmbeddedAttempt({
      sessionId: "embedded-session",
      sessionKey: "agent:main:main",
      sessionFile: path.join(workspaceDir, "session.jsonl"),
      workspaceDir,
      agentDir,
      config: {},
      prompt: "check live commentary forwarding",
      timeoutMs: 10_000,
      runId: "run-commentary",
      provider: "openai",
      modelId: "gpt-test",
      model,
      authStorage: {} as AuthStorage,
      modelRegistry: {} as ModelRegistry,
      thinkLevel: "off",
      senderIsOwner: true,
      disableMessageTool: true,
      onCommentaryReply,
    });

    expect(result.promptError).toBeNull();
    expect(hoisted.subscribeEmbeddedPiSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onCommentaryReply,
      }),
    );
  });

  it("bounds the final commentary delivery wait and aborts stalled commentary sends", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commentary-timeout-"));
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commentary-timeout-agent-"));
    tempPaths.push(workspaceDir, agentDir);

    hoisted.resolveSandboxContextMock.mockResolvedValue(
      createPiToolsSandboxContext({
        workspaceDir,
        fsBridge: createHostSandboxFsBridge(workspaceDir),
        tools: { allow: [], deny: [] },
        sessionKey: "agent:main:main",
      }),
    );

    hoisted.createAgentSessionMock.mockImplementation(async () => {
      const session: MutableSession = {
        sessionId: "embedded-session",
        messages: [],
        isCompacting: false,
        isStreaming: false,
        agent: {
          replaceMessages: (messages: unknown[]) => {
            session.messages = [...messages];
          },
        },
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        steer: async () => {},
      };

      return { session };
    });

    const abortCommentaryDelivery = vi.fn();
    hoisted.subscribeEmbeddedPiSessionMock.mockImplementation(() => ({
      ...createSubscriptionMock(),
      waitForCommentaryDeliveryRound: () => new Promise<boolean>(() => {}),
      abortCommentaryDelivery,
    }));

    const model = {
      api: "openai-completions",
      provider: "openai",
      compat: {},
      contextWindow: 8192,
      input: ["text"],
    } as unknown as Model<Api>;

    const result = await runEmbeddedAttempt({
      sessionId: "embedded-session",
      sessionKey: "agent:main:main",
      sessionFile: path.join(workspaceDir, "session.jsonl"),
      workspaceDir,
      agentDir,
      config: {},
      prompt: "wait for commentary timeout",
      timeoutMs: 10_000,
      blockReplyTimeoutMs: 1,
      runId: "run-commentary-timeout",
      provider: "openai",
      modelId: "gpt-test",
      model,
      authStorage: {} as AuthStorage,
      modelRegistry: {} as ModelRegistry,
      thinkLevel: "off",
      senderIsOwner: true,
      disableMessageTool: true,
      onCommentaryReply: vi.fn(),
    });

    expect(result.promptError).toBeNull();
    expect(abortCommentaryDelivery).toHaveBeenCalledTimes(1);
  });

  it("retries commentary wait rounds when late commentary is enqueued", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commentary-queue-"));
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commentary-queue-agent-"));
    tempPaths.push(workspaceDir, agentDir);

    hoisted.resolveSandboxContextMock.mockResolvedValue(
      createPiToolsSandboxContext({
        workspaceDir,
        fsBridge: createHostSandboxFsBridge(workspaceDir),
        tools: { allow: [], deny: [] },
        sessionKey: "agent:main:main",
      }),
    );

    hoisted.createAgentSessionMock.mockImplementation(async () => {
      const session: MutableSession = {
        sessionId: "embedded-session",
        messages: [],
        isCompacting: false,
        isStreaming: false,
        agent: {
          replaceMessages: (messages: unknown[]) => {
            session.messages = [...messages];
          },
        },
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        steer: async () => {},
      };

      return { session };
    });

    const abortCommentaryDelivery = vi.fn();
    const waitForCommentaryDeliveryRound = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
        return false;
      })
      .mockResolvedValueOnce(true);
    const getPendingCommentaryDeliveryCount = vi
      .fn<() => number>()
      .mockReturnValueOnce(3)
      .mockReturnValueOnce(1);
    hoisted.subscribeEmbeddedPiSessionMock.mockImplementation(() => ({
      ...createSubscriptionMock(),
      getPendingCommentaryDeliveryCount,
      waitForCommentaryDeliveryRound,
      abortCommentaryDelivery,
    }));

    const model = {
      api: "openai-completions",
      provider: "openai",
      compat: {},
      contextWindow: 8192,
      input: ["text"],
    } as unknown as Model<Api>;

    const result = await runEmbeddedAttempt({
      sessionId: "embedded-session",
      sessionKey: "agent:main:main",
      sessionFile: path.join(workspaceDir, "session.jsonl"),
      workspaceDir,
      agentDir,
      config: {},
      prompt: "wait for queued commentary",
      timeoutMs: 10_000,
      blockReplyTimeoutMs: 5,
      runId: "run-commentary-queue",
      provider: "openai",
      modelId: "gpt-test",
      model,
      authStorage: {} as AuthStorage,
      modelRegistry: {} as ModelRegistry,
      thinkLevel: "off",
      senderIsOwner: true,
      disableMessageTool: true,
      onCommentaryReply: vi.fn(),
    });

    expect(result.promptError).toBeNull();
    expect(waitForCommentaryDeliveryRound).toHaveBeenCalledTimes(2);
    expect(getPendingCommentaryDeliveryCount).toHaveBeenCalledTimes(2);
    expect(abortCommentaryDelivery).not.toHaveBeenCalled();
  });

  it("aborts commentary delivery promptly when the run abort signal fires", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commentary-abort-"));
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commentary-abort-agent-"));
    tempPaths.push(workspaceDir, agentDir);

    hoisted.resolveSandboxContextMock.mockResolvedValue(
      createPiToolsSandboxContext({
        workspaceDir,
        fsBridge: createHostSandboxFsBridge(workspaceDir),
        tools: { allow: [], deny: [] },
        sessionKey: "agent:main:main",
      }),
    );

    hoisted.createAgentSessionMock.mockImplementation(async () => {
      const session: MutableSession = {
        sessionId: "embedded-session",
        messages: [],
        isCompacting: false,
        isStreaming: false,
        agent: {
          replaceMessages: (messages: unknown[]) => {
            session.messages = [...messages];
          },
        },
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        steer: async () => {},
      };

      return { session };
    });

    const abortCommentaryDelivery = vi.fn();
    const abortController = new AbortController();
    hoisted.subscribeEmbeddedPiSessionMock.mockImplementation(() => ({
      ...createSubscriptionMock(),
      waitForCommentaryDeliveryRound: () => {
        abortController.abort(new Error("user abort"));
        return new Promise<boolean>(() => {});
      },
      abortCommentaryDelivery,
    }));

    const model = {
      api: "openai-completions",
      provider: "openai",
      compat: {},
      contextWindow: 8192,
      input: ["text"],
    } as unknown as Model<Api>;

    const result = await runEmbeddedAttempt({
      sessionId: "embedded-session",
      sessionKey: "agent:main:main",
      sessionFile: path.join(workspaceDir, "session.jsonl"),
      workspaceDir,
      agentDir,
      config: {},
      prompt: "wait for commentary abort",
      timeoutMs: 10_000,
      runId: "run-commentary-abort",
      provider: "openai",
      modelId: "gpt-test",
      model,
      authStorage: {} as AuthStorage,
      modelRegistry: {} as ModelRegistry,
      thinkLevel: "off",
      senderIsOwner: true,
      disableMessageTool: true,
      abortSignal: abortController.signal,
      onCommentaryReply: vi.fn(),
    });

    expect(result.promptError).toBeNull();
    expect(abortCommentaryDelivery).toHaveBeenCalledTimes(1);
  });
});
