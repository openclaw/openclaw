import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  AuthStorage,
  ExtensionContext,
  ModelRegistry,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngineInfo,
  IngestBatchResult,
  IngestResult,
} from "../../../context-engine/types.js";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import { createPiToolsSandboxContext } from "../../test-helpers/pi-tools-sandbox-context.js";

const hoisted = vi.hoisted(() => {
  const spawnSubagentDirectMock = vi.fn();
  const createAgentSessionMock = vi.fn();
  const sessionManagerOpenMock = vi.fn();
  const resolveSandboxContextMock = vi.fn();
  const subscribeEmbeddedPiSessionMock = vi.fn();
  const acquireSessionWriteLockMock = vi.fn();
  const sessionManager = {
    getLeafEntry: vi.fn(() => null),
    branch: vi.fn(),
    resetLeaf: vi.fn(),
    buildSessionContext: vi.fn<() => { messages: AgentMessage[] }>(() => ({ messages: [] })),
    appendCustomEntry: vi.fn(),
  };
  return {
    spawnSubagentDirectMock,
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

vi.mock("../../subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

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
    toolMetas: [] as Array<{ toolName: string; meta?: string }>,
    unsubscribe: () => {},
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

const testModel = {
  api: "openai-completions",
  provider: "openai",
  compat: {},
  contextWindow: 8192,
  input: ["text"],
} as unknown as Model<Api>;

const cacheTtlEligibleModel = {
  api: "anthropic",
  provider: "anthropic",
  compat: {},
  contextWindow: 8192,
  input: ["text"],
} as unknown as Model<Api>;

describe("runEmbeddedAttempt sessions_spawn workspace inheritance", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:child",
      runId: "run-child",
    });
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

  it("passes the real workspace to sessions_spawn when workspaceAccess is ro", async () => {
    const realWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-real-workspace-"));
    const sandboxWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-sandbox-workspace-"),
    );
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-dir-"));
    tempPaths.push(realWorkspace, sandboxWorkspace, agentDir);

    hoisted.resolveSandboxContextMock.mockResolvedValue(
      createPiToolsSandboxContext({
        workspaceDir: sandboxWorkspace,
        agentWorkspaceDir: realWorkspace,
        workspaceAccess: "ro",
        fsBridge: createHostSandboxFsBridge(sandboxWorkspace),
        tools: { allow: ["sessions_spawn"], deny: [] },
        sessionKey: "agent:main:main",
      }),
    );

    hoisted.createAgentSessionMock.mockImplementation(
      async (params: { customTools: ToolDefinition[] }) => {
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
          prompt: async () => {
            const spawnTool = params.customTools.find((tool) => tool.name === "sessions_spawn");
            expect(spawnTool).toBeDefined();
            if (!spawnTool) {
              throw new Error("missing sessions_spawn tool");
            }
            await spawnTool.execute(
              "call-sessions-spawn",
              { task: "inspect workspace" },
              undefined,
              undefined,
              {} as unknown as ExtensionContext,
            );
          },
          abort: async () => {},
          dispose: () => {},
          steer: async () => {},
        };

        return { session };
      },
    );

    const result = await runEmbeddedAttempt({
      sessionId: "embedded-session",
      sessionKey: "agent:main:main",
      sessionFile: path.join(realWorkspace, "session.jsonl"),
      workspaceDir: realWorkspace,
      agentDir,
      config: {},
      prompt: "spawn a child session",
      timeoutMs: 10_000,
      runId: "run-1",
      provider: "openai",
      modelId: "gpt-test",
      model: testModel,
      authStorage: {} as AuthStorage,
      modelRegistry: {} as ModelRegistry,
      thinkLevel: "off",
      senderIsOwner: true,
      disableMessageTool: true,
    });

    expect(result.promptError).toBeNull();
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "inspect workspace",
      }),
      expect.objectContaining({
        workspaceDir: realWorkspace,
      }),
    );
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceDir: sandboxWorkspace,
      }),
    );
  });
});

describe("runEmbeddedAttempt cache-ttl tracking after compaction", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    hoisted.createAgentSessionMock.mockReset();
    hoisted.sessionManagerOpenMock.mockReset().mockReturnValue(hoisted.sessionManager);
    hoisted.resolveSandboxContextMock.mockReset();
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

  async function runAttemptWithCacheTtl(compactionCount: number) {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cache-ttl-workspace-"));
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cache-ttl-agent-"));
    const sessionFile = path.join(workspaceDir, "session.jsonl");
    tempPaths.push(workspaceDir, agentDir);
    await fs.writeFile(sessionFile, "", "utf8");

    hoisted.subscribeEmbeddedPiSessionMock.mockReset().mockImplementation(() => ({
      ...createSubscriptionMock(),
      getCompactionCount: () => compactionCount,
    }));

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
        prompt: async () => {
          session.messages = [
            ...session.messages,
            { role: "assistant", content: "done", timestamp: 2 },
          ];
        },
        abort: async () => {},
        dispose: () => {},
        steer: async () => {},
      };

      return { session };
    });

    return await runEmbeddedAttempt({
      sessionId: "embedded-session",
      sessionKey: "agent:main:test-cache-ttl",
      sessionFile,
      workspaceDir,
      agentDir,
      config: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      },
      prompt: "hello",
      timeoutMs: 10_000,
      runId: `run-cache-ttl-${compactionCount}`,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      model: cacheTtlEligibleModel,
      authStorage: {} as AuthStorage,
      modelRegistry: {} as ModelRegistry,
      thinkLevel: "off",
      senderIsOwner: true,
      disableMessageTool: true,
    });
  }

  it("skips cache-ttl append when compaction completed during the attempt", async () => {
    const result = await runAttemptWithCacheTtl(1);

    expect(result.promptError).toBeNull();
    expect(hoisted.sessionManager.appendCustomEntry).not.toHaveBeenCalledWith(
      "openclaw.cache-ttl",
      expect.anything(),
    );
  });

  it("appends cache-ttl when no compaction completed during the attempt", async () => {
    const result = await runAttemptWithCacheTtl(0);

    expect(result.promptError).toBeNull();
    expect(hoisted.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "openclaw.cache-ttl",
      expect.objectContaining({
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        timestamp: expect.any(Number),
      }),
    );
  });
});

describe("runEmbeddedAttempt context engine sessionKey forwarding", () => {
  const tempPaths: string[] = [];
  const sessionKey = "agent:main:discord:channel:test-ctx-engine";

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

  // Build a minimal real attempt harness so lifecycle hooks run against
  // the actual runner flow instead of a hand-written wrapper.
  async function runAttemptWithContextEngine(contextEngine: {
    bootstrap?: (params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
    }) => Promise<BootstrapResult>;
    assemble: (params: {
      sessionId: string;
      sessionKey?: string;
      messages: AgentMessage[];
      tokenBudget?: number;
    }) => Promise<AssembleResult>;
    afterTurn?: (params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      messages: AgentMessage[];
      prePromptMessageCount: number;
      tokenBudget?: number;
      runtimeContext?: Record<string, unknown>;
    }) => Promise<void>;
    ingestBatch?: (params: {
      sessionId: string;
      sessionKey?: string;
      messages: AgentMessage[];
    }) => Promise<IngestBatchResult>;
    ingest?: (params: {
      sessionId: string;
      sessionKey?: string;
      message: AgentMessage;
    }) => Promise<IngestResult>;
    compact?: (params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      tokenBudget?: number;
    }) => Promise<CompactResult>;
    info?: Partial<ContextEngineInfo>;
  }) {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ctx-engine-workspace-"));
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ctx-engine-agent-"));
    const sessionFile = path.join(workspaceDir, "session.jsonl");
    tempPaths.push(workspaceDir, agentDir);
    await fs.writeFile(sessionFile, "", "utf8");
    const seedMessages: AgentMessage[] = [
      { role: "user", content: "seed", timestamp: 1 } as AgentMessage,
    ];
    const infoId = contextEngine.info?.id ?? "test-context-engine";
    const infoName = contextEngine.info?.name ?? "Test Context Engine";
    const infoVersion = contextEngine.info?.version ?? "0.0.1";

    hoisted.sessionManager.buildSessionContext
      .mockReset()
      .mockReturnValue({ messages: seedMessages });

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
        prompt: async () => {
          session.messages = [
            ...session.messages,
            { role: "assistant", content: "done", timestamp: 2 },
          ];
        },
        abort: async () => {},
        dispose: () => {},
        steer: async () => {},
      };

      return { session };
    });

    return await runEmbeddedAttempt({
      sessionId: "embedded-session",
      sessionKey,
      sessionFile,
      workspaceDir,
      agentDir,
      config: {},
      prompt: "hello",
      timeoutMs: 10_000,
      runId: "run-context-engine-forwarding",
      provider: "openai",
      modelId: "gpt-test",
      model: testModel,
      authStorage: {} as AuthStorage,
      modelRegistry: {} as ModelRegistry,
      thinkLevel: "off",
      senderIsOwner: true,
      disableMessageTool: true,
      contextTokenBudget: 2048,
      contextEngine: {
        ...contextEngine,
        ingest:
          contextEngine.ingest ??
          (async () => ({
            ingested: true,
          })),
        compact:
          contextEngine.compact ??
          (async () => ({
            ok: false,
            compacted: false,
            reason: "not used in this test",
          })),
        info: {
          id: infoId,
          name: infoName,
          version: infoVersion,
        },
      },
    });
  }

  it("forwards sessionKey to bootstrap, assemble, and afterTurn", async () => {
    const bootstrap = vi.fn(async (_params: { sessionKey?: string }) => ({ bootstrapped: true }));
    const assemble = vi.fn(
      async ({ messages }: { messages: AgentMessage[]; sessionKey?: string }) => ({
        messages,
        estimatedTokens: 1,
      }),
    );
    const afterTurn = vi.fn(async (_params: { sessionKey?: string }) => {});

    const result = await runAttemptWithContextEngine({
      bootstrap,
      assemble,
      afterTurn,
    });

    expect(result.promptError).toBeNull();
    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
      }),
    );
    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
      }),
    );
    expect(afterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
      }),
    );
  });

  it("forwards sessionKey to ingestBatch when afterTurn is absent", async () => {
    const bootstrap = vi.fn(async (_params: { sessionKey?: string }) => ({ bootstrapped: true }));
    const assemble = vi.fn(
      async ({ messages }: { messages: AgentMessage[]; sessionKey?: string }) => ({
        messages,
        estimatedTokens: 1,
      }),
    );
    const ingestBatch = vi.fn(
      async (_params: { sessionKey?: string; messages: AgentMessage[] }) => ({ ingestedCount: 1 }),
    );

    const result = await runAttemptWithContextEngine({
      bootstrap,
      assemble,
      ingestBatch,
    });

    expect(result.promptError).toBeNull();
    expect(ingestBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
      }),
    );
  });

  it("forwards sessionKey to per-message ingest when ingestBatch is absent", async () => {
    const bootstrap = vi.fn(async (_params: { sessionKey?: string }) => ({ bootstrapped: true }));
    const assemble = vi.fn(
      async ({ messages }: { messages: AgentMessage[]; sessionKey?: string }) => ({
        messages,
        estimatedTokens: 1,
      }),
    );
    const ingest = vi.fn(async (_params: { sessionKey?: string; message: AgentMessage }) => ({
      ingested: true,
    }));

    const result = await runAttemptWithContextEngine({
      bootstrap,
      assemble,
      ingest,
    });

    expect(result.promptError).toBeNull();
    expect(ingest).toHaveBeenCalled();
    expect(
      ingest.mock.calls.every((call) => {
        const params = call[0];
        return params.sessionKey === sessionKey;
      }),
    ).toBe(true);
  });
});
