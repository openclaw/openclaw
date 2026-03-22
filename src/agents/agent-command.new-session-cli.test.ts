import { beforeEach, describe, expect, it, vi } from "vitest";

type TestSessionEntry = {
  sessionId: string;
  updatedAt: number;
  cliSessionIds?: Record<string, string>;
  claudeCliSessionId?: string;
  systemPromptReport?: {
    bootstrapTruncation?: {
      warningMode?: "off" | "once" | "always";
      warningSignaturesSeen?: string[];
      promptWarningSignature?: string;
    };
  };
  skillsSnapshot?: { prompt: string; skills: unknown[] };
};

const hoisted = vi.hoisted(() => ({
  config: {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    agents: {
      defaults: {},
      list: [{ id: "main" }],
    },
  } as Record<string, unknown>,
  sessionStore: {} as Record<string, TestSessionEntry>,
  resolveSessionMock: vi.fn(),
  runCliAgentMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  updateSessionStoreAfterAgentRunMock: vi.fn(),
  deliverAgentCommandResultMock: vi.fn(),
  resolveBootstrapWarningSignaturesSeenMock: vi.fn(),
  sendPolicy: "allow" as "allow" | "deny",
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => null,
  }),
}));

vi.mock("../acp/policy.js", () => ({
  resolveAcpAgentPolicyError: () => null,
  resolveAcpDispatchPolicyError: () => null,
}));

vi.mock("../acp/runtime/errors.js", () => ({
  toAcpRuntimeError: ({ error }: { error: unknown }) => error,
}));

vi.mock("../acp/runtime/session-identifiers.js", () => ({
  resolveAcpSessionCwd: () => undefined,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: vi.fn(),
  }),
}));

vi.mock("../auto-reply/reply/normalize-reply.js", () => ({
  normalizeReplyPayload: ({ text }: { text?: string }) => (text ? { type: "text", text } : null),
}));

vi.mock("../auto-reply/thinking.js", () => ({
  formatThinkingLevels: () => "low, medium, high",
  formatXHighModelHint: () => "supported models",
  normalizeThinkLevel: (value: string | undefined) => value,
  normalizeVerboseLevel: (value: string | undefined) => value,
  supportsXHighThinking: () => true,
}));

vi.mock("../auto-reply/tokens.js", () => ({
  isSilentReplyPrefixText: () => false,
  isSilentReplyText: () => false,
  SILENT_REPLY_TOKEN: "<silent>",
}));

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: (value: string) => value,
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: Record<string, unknown> }) => ({
    resolvedConfig: config,
    diagnostics: [] as string[],
  }),
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => [],
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => hoisted.config,
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: {
      valid: false,
      resolved: hoisted.config,
    },
  }),
  setRuntimeConfigSnapshot: () => {},
}));

vi.mock("../config/sessions.js", () => ({
  mergeSessionEntry: (
    existing: TestSessionEntry | undefined,
    patch: Partial<TestSessionEntry>,
  ): TestSessionEntry =>
    ({
      ...existing,
      ...patch,
    }) as TestSessionEntry,
  resolveAgentIdFromSessionKey: () => "main",
  updateSessionStore: async (
    storePath: string,
    updater: (store: Record<string, TestSessionEntry>) => TestSessionEntry,
  ) => await hoisted.updateSessionStoreMock(storePath, updater),
}));

vi.mock("../config/sessions/transcript.js", () => ({
  resolveSessionTranscriptFile: async ({ sessionEntry }: { sessionEntry?: TestSessionEntry }) => ({
    sessionFile: "/tmp/session.jsonl",
    sessionEntry,
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  clearAgentRunContext: () => {},
  emitAgentEvent: () => {},
  registerAgentRunContext: () => {},
}));

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: () => ({}),
}));

vi.mock("../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: () => ({}),
}));

vi.mock("../routing/session-key.js", () => ({
  normalizeAgentId: (value: string) => value.trim().toLowerCase(),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: () => {},
  },
}));

vi.mock("../sessions/level-overrides.js", () => ({
  applyVerboseOverride: () => {},
}));

vi.mock("../sessions/model-overrides.js", () => ({
  applyModelOverrideToSessionEntry: () => ({ updated: false }),
}));

vi.mock("../sessions/send-policy.js", () => ({
  resolveSendPolicy: () => hoisted.sendPolicy,
}));

vi.mock("../sessions/transcript-events.js", () => ({
  emitSessionTranscriptUpdate: () => {},
}));

vi.mock("../terminal/ansi.js", () => ({
  sanitizeForLog: (value: unknown) => String(value),
}));

vi.mock("../utils/message-channel.js", () => ({
  resolveMessageChannel: () => "cli",
}));

vi.mock("./agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveAgentDir: () => "/tmp/agent",
  resolveEffectiveModelFallbacks: () => undefined,
  resolveSessionAgentId: () => "main",
  resolveAgentSkillsFilter: () => undefined,
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
}));

vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
}));

vi.mock("./auth-profiles/session-override.js", () => ({
  clearSessionAuthProfileOverride: async () => {},
}));

vi.mock("./bootstrap-budget.js", () => ({
  resolveBootstrapWarningSignaturesSeen: (report?: TestSessionEntry["systemPromptReport"]) =>
    hoisted.resolveBootstrapWarningSignaturesSeenMock(report),
}));

vi.mock("./cli-runner.js", () => ({
  runCliAgent: (params: Record<string, unknown>) => hoisted.runCliAgentMock(params),
}));

vi.mock("./command/delivery.js", () => ({
  deliverAgentCommandResult: (params: Record<string, unknown>) =>
    hoisted.deliverAgentCommandResultMock(params),
}));

vi.mock("./command/run-context.js", () => ({
  resolveAgentRunContext: () => ({
    messageChannel: "cli",
  }),
}));

vi.mock("./command/session-store.js", () => ({
  updateSessionStoreAfterAgentRun: (params: Record<string, unknown>) =>
    hoisted.updateSessionStoreAfterAgentRunMock(params),
}));

vi.mock("./command/session.js", () => ({
  resolveSession: (params: Record<string, unknown>) => hoisted.resolveSessionMock(params),
}));

vi.mock("./defaults.js", () => ({
  DEFAULT_MODEL: "gpt-5.2-codex",
  DEFAULT_PROVIDER: "codex-cli",
}));

vi.mock("./failover-error.js", () => ({
  FailoverError: class FailoverError extends Error {
    reason?: string;
  },
}));

vi.mock("./internal-events.js", () => ({
  formatAgentInternalEventsForPrompt: () => "",
}));

vi.mock("./lanes.js", () => ({
  AGENT_LANE_SUBAGENT: "subagent",
}));

vi.mock("./model-catalog.js", () => ({
  loadModelCatalog: async () => [],
}));

vi.mock("./model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (
      providerOverride: string,
      modelOverride: string,
      runOptions?: Record<string, unknown>,
    ) => Promise<unknown>;
  }) => ({
    provider,
    model,
    result: await run(provider, model, {}),
  }),
}));

vi.mock("./model-selection.js", () => ({
  buildAllowedModelSet: () => ({
    allowedKeys: new Set<string>(),
    allowedCatalog: [],
    allowAny: false,
  }),
  isCliProvider: (provider: string) => provider.trim().toLowerCase().endsWith("-cli"),
  modelKey: (provider: string, model: string) => `${provider}/${model}`,
  normalizeModelRef: (provider: string, model: string) => ({ provider, model }),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
  parseModelRef: (raw: string, defaultProvider: string) => {
    const trimmed = raw.trim();
    const slash = trimmed.indexOf("/");
    if (slash === -1) {
      return { provider: defaultProvider, model: trimmed };
    }
    return {
      provider: trimmed.slice(0, slash),
      model: trimmed.slice(slash + 1),
    };
  },
  resolveConfiguredModelRef: () => ({
    provider: "codex-cli",
    model: "gpt-5.2-codex",
  }),
  resolveDefaultModelForAgent: () => ({
    provider: "codex-cli",
    model: "gpt-5.2-codex",
  }),
  resolveThinkingDefault: () => "low",
}));

vi.mock("./pi-embedded-runner/session-manager-init.js", () => ({
  prepareSessionManagerForRun: async () => {},
}));

vi.mock("./pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(),
}));

vi.mock("./skills.js", () => ({
  buildWorkspaceSkillSnapshot: () => ({
    prompt: "",
    skills: [],
  }),
}));

vi.mock("./skills/refresh.js", () => ({
  getSkillsSnapshotVersion: () => 1,
}));

vi.mock("./spawned-context.js", () => ({
  normalizeSpawnedRunMetadata: (value: Record<string, unknown>) => value,
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: () => 1_000,
}));

vi.mock("./workspace.js", () => ({
  ensureAgentWorkspace: async ({ dir }: { dir: string }) => ({ dir }),
}));

import { agentCommand } from "./agent-command.js";

function createSessionResolution(params?: {
  isNewSession?: boolean;
  cliSessionId?: string;
  cliSessionIds?: Record<string, string>;
  claudeCliSessionId?: string;
  systemPromptReport?: TestSessionEntry["systemPromptReport"];
  skillsSnapshot?: TestSessionEntry["skillsSnapshot"];
}): {
  sessionId: string;
  sessionKey: string;
  sessionEntry: TestSessionEntry;
  sessionStore: Record<string, TestSessionEntry>;
  storePath: string;
  isNewSession: boolean;
  persistedThinking: undefined;
  persistedVerbose: undefined;
} {
  const sessionKey = "agent:main:main";
  const cliSessionId = params?.cliSessionId ?? "thread-stale";
  const cliSessionIds = params?.cliSessionIds ?? {
    "codex-cli": cliSessionId,
  };
  const sessionEntry: TestSessionEntry = {
    sessionId: "session-old",
    updatedAt: 1,
    cliSessionIds,
    claudeCliSessionId: params?.claudeCliSessionId,
    systemPromptReport: params?.systemPromptReport,
    skillsSnapshot: params?.skillsSnapshot,
  };
  hoisted.sessionStore[sessionKey] = sessionEntry;
  return {
    sessionId: "session-new",
    sessionKey,
    sessionEntry,
    sessionStore: hoisted.sessionStore,
    storePath: "/tmp/sessions.json",
    isNewSession: params?.isNewSession ?? true,
    persistedThinking: undefined,
    persistedVerbose: undefined,
  };
}

describe("agentCommand CLI session rollover", () => {
  beforeEach(() => {
    hoisted.sessionStore = {};
    hoisted.resolveSessionMock.mockReset();
    hoisted.runCliAgentMock.mockReset().mockResolvedValue({
      payloads: [{ type: "text", text: "ok" }],
      meta: {
        agentMeta: {
          sessionId: "thread-fresh",
          provider: "codex-cli",
          model: "gpt-5.2-codex",
        },
      },
    });
    hoisted.updateSessionStoreMock
      .mockReset()
      .mockImplementation(
        async (
          _storePath: string,
          updater: (store: Record<string, TestSessionEntry>) => TestSessionEntry,
        ) => updater(hoisted.sessionStore),
      );
    hoisted.updateSessionStoreAfterAgentRunMock.mockReset().mockResolvedValue(undefined);
    hoisted.deliverAgentCommandResultMock
      .mockReset()
      .mockImplementation(async ({ result }: { result: unknown }) => result);
    hoisted.resolveBootstrapWarningSignaturesSeenMock.mockReset().mockImplementation((report) => {
      const seen = report?.bootstrapTruncation?.warningSignaturesSeen;
      return Array.isArray(seen) ? seen : [];
    });
    hoisted.sendPolicy = "allow";
  });

  it("does not resume stale CLI backend sessions after a new session rollover", async () => {
    hoisted.resolveSessionMock.mockReturnValue(createSessionResolution({ isNewSession: true }));

    await agentCommand({
      message: "hello",
      agentId: "main",
    });

    expect(hoisted.runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(hoisted.runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-new",
      cliSessionId: undefined,
      provider: "codex-cli",
      model: "gpt-5.2-codex",
    });
  });

  it("clears stale CLI backend ids when a new session starts on a different CLI provider", async () => {
    const sessionResolution = createSessionResolution({
      isNewSession: true,
      cliSessionIds: {
        "claude-cli": "thread-stale-claude",
        "codex-cli": "thread-stale-codex",
      },
      claudeCliSessionId: "thread-stale-claude",
    });
    hoisted.resolveSessionMock.mockReturnValue(sessionResolution);

    await agentCommand({
      message: "hello",
      agentId: "main",
      provider: "claude-cli",
    });

    expect(hoisted.runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(hoisted.runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-new",
      cliSessionId: undefined,
      provider: "claude-cli",
    });
    expect(hoisted.sessionStore[sessionResolution.sessionKey]).toMatchObject({
      sessionId: "session-new",
    });
    expect(hoisted.sessionStore[sessionResolution.sessionKey]?.cliSessionIds).toBeUndefined();
    expect(hoisted.sessionStore[sessionResolution.sessionKey]?.claudeCliSessionId).toBeUndefined();
  });

  it("keeps the new outer session id when the first post-reset turn fails early", async () => {
    const sessionResolution = createSessionResolution({
      isNewSession: true,
      cliSessionIds: {
        "codex-cli": "thread-stale-codex",
      },
    });
    hoisted.resolveSessionMock.mockReturnValue(sessionResolution);
    hoisted.sendPolicy = "deny";

    await expect(
      agentCommand({
        message: "hello",
        agentId: "main",
        deliver: true,
      }),
    ).rejects.toThrow("send blocked by session policy");

    expect(hoisted.sessionStore[sessionResolution.sessionKey]).toMatchObject({
      sessionId: "session-new",
    });
    expect(hoisted.sessionStore[sessionResolution.sessionKey]?.cliSessionIds).toBeUndefined();
  });

  it("drops stale skills snapshots when the first post-reset turn fails before startup", async () => {
    const sessionResolution = createSessionResolution({
      isNewSession: true,
      skillsSnapshot: {
        prompt: "stale snapshot",
        skills: [{ id: "old-skill" }],
      },
    });
    hoisted.resolveSessionMock.mockReturnValue(sessionResolution);
    hoisted.sendPolicy = "deny";

    await expect(
      agentCommand({
        message: "hello",
        agentId: "main",
        deliver: true,
      }),
    ).rejects.toThrow("send blocked by session policy");

    expect(hoisted.sessionStore[sessionResolution.sessionKey]).toMatchObject({
      sessionId: "session-new",
    });
    expect(hoisted.sessionStore[sessionResolution.sessionKey]?.skillsSnapshot).toBeUndefined();
  });

  it("resets stale bootstrap warning state for the first turn in a new CLI session", async () => {
    const sessionResolution = createSessionResolution({
      isNewSession: true,
      systemPromptReport: {
        bootstrapTruncation: {
          warningMode: "once",
          warningSignaturesSeen: ["stale-bootstrap-warning"],
          promptWarningSignature: "stale-bootstrap-warning",
        },
      },
    });
    hoisted.resolveSessionMock.mockReturnValue(sessionResolution);

    await agentCommand({
      message: "hello",
      agentId: "main",
    });

    expect(hoisted.resolveBootstrapWarningSignaturesSeenMock).toHaveBeenCalledWith(undefined);
    expect(hoisted.runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
      bootstrapPromptWarningSignaturesSeen: [],
      bootstrapPromptWarningSignature: undefined,
    });
    expect(hoisted.sessionStore[sessionResolution.sessionKey]?.systemPromptReport).toBeUndefined();
  });

  it("keeps resuming the stored CLI backend session for fresh sessions", async () => {
    hoisted.resolveSessionMock.mockReturnValue(createSessionResolution({ isNewSession: false }));

    await agentCommand({
      message: "hello",
      agentId: "main",
    });

    expect(hoisted.runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(hoisted.runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "session-new",
      cliSessionId: "thread-stale",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
    });
  });
});
