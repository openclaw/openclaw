// Exercises CLI preparation, auth, prompt hooks, MCP setup, and session reuse.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { LegacyContextEngine } from "../../context-engine/legacy.js";
import {
  registerContextEngineForOwner,
  registerContextEngineInRegistry,
} from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { resolveMcpLoopbackScopedTools as resolveLoopbackTools } from "../../gateway/mcp-http.runtime.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { labelRuntimeContextText } from "../../llm/types.js";
import { CliBackendAuthProfilePreparationError } from "../../plugins/cli-backend-errors.js";
import type {
  CliBackendExecute,
  CliBackendExecuteContext,
  CliBackendPlugin,
} from "../../plugins/cli-backend.types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createHookRunner } from "../../plugins/hooks.js";
import {
  clearMemoryPluginState,
  registerTestMemoryPromptBuilder,
} from "../../plugins/memory-state.test-fixtures.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import {
  createReplyOperation,
  type ReplyOperation,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import type { SkillSnapshot } from "../../skills/types.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseByPathAsync,
} from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { connectUserModelAccount } from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  withTestRunAdmission,
  wrapRunWithTestPreparedAdmission,
} from "../admitted-run-context.test-support.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../auth-profiles/credential-fixtures.test-support.js";
import { resolveApiKeyForProfile as resolveApiKeyForProfileImpl } from "../auth-profiles/oauth.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../auth-profiles/store-runtime.js";
import { resolveBootstrapContextForRun as loadBootstrapContext } from "../bootstrap-files.js";
import { CLI_AUTH_EPOCH_VERSION, resolveCliAuthEpoch } from "../cli-auth-epoch.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
  createContextEngineCustodyFixture,
  createCliRepositorySkillFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
  createWeatherSkillFixture,
  wrappedPluginSystemContext,
  type TestCliBackendParams,
} from "../cli-runner.test-helpers.js";
import {
  applyCliSessionBindingResult,
  clearCliSession,
  getCliSessionBinding,
  hashCliSessionText,
} from "../cli-session.js";
import { resetContextWindowCacheForTest } from "../context.test-support.js";
import { createContextEngineLogicalTurnLease } from "../harness/context-engine-logical-turn.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../harness/gateway-question.js";
import { withQuestionGateway } from "../harness/gateway-question.test-support.js";
import { buildMediaTaskRuntimeContext } from "../media-generation-task-status.js";
import { createAgentCleanupScope } from "../run-cleanup-timeout.js";
import type { SandboxWorkspaceInfo } from "../sandbox/types.js";
import {
  beginForegroundSessionMaintenance,
  waitForSessionMaintenance,
} from "../session-maintenance/coordinator.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  captureRoutingDecisionWork,
  createModelRoutingTestAdmission,
} from "../test-helpers/model-routing-decision-e2e-fixtures.js";
import type { SystemAgentToolOptions } from "../tools/system-agent-tool.js";
import { prepareCliBundleMcpCaptureAttempt } from "./bundle-mcp.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";
import { finalizeCliContextEngineTurn } from "./cli-run-transcript.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import {
  createCliMcpTool,
  createJsonlStdinBackendConfig,
  registerCliMcpPreparationTests,
  setRawCliBackendForPrepareTest,
} from "./prepare-mcp.test-support.js";
import { registerCliThinkingPreparationTests } from "./prepare-thinking.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";
import type { RunCliAgentParams } from "./types.js";

function expectCall(mock: unknown, fields: object) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

function expectText(
  text: string | undefined,
  includes: readonly string[],
  excludes: readonly string[] = [],
) {
  for (const part of includes) {
    expect(text).toContain(part);
  }
  for (const part of excludes) {
    expect(text).not.toContain(part);
  }
}

function promptHook<T extends object>(result: T) {
  return {
    hasHooks: vi.fn((name: string) => name === "before_prompt_build"),
    runBeforePromptBuild: vi.fn(async () => ({ ...result })),
  };
}

function catalogModel(
  id: string,
  name: string,
  contextTokens: number,
  maxTokens: number,
  contextWindow: number,
) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    contextTokens,
  };
}

function setBackend(overrides: Partial<CliBackendPlugin> & { pluginId?: string } = {}) {
  const id = overrides.id ?? "test-cli";
  setRawCliBackendForPrepareTest({
    id,
    pluginId: "test-plugin",
    bundleMcp: false,
    config: createJsonlStdinBackendConfig(id),
    ...overrides,
  });
}

function sessionBinding(context: Awaited<ReturnType<typeof prepareCliRunContext>>) {
  return {
    sessionId: "cli-session",
    extraSystemPromptHash: context.extraSystemPromptHash,
    messageToolPolicyHash: context.messageToolPolicyHash,
    promptToolNamesHash: context.promptToolNamesHash,
    cwdHash: context.cwdHash,
    mcpConfigHash: context.preparedBackend.mcpConfigHash,
    mcpResumeHash: context.preparedBackend.mcpResumeHash,
  };
}

function setGeminiBackend(overrides: Partial<CliBackendPlugin>) {
  setRawCliBackendForPrepareTest({
    id: "google-gemini-cli",
    pluginId: "google",
    bundleMcp: false,
    config: createArgBackendConfig("gemini", ["--prompt", "{prompt}"], "json"),
    ...overrides,
  });
}

function registerTestContextEngine(
  id: string,
  factory: Parameters<typeof registerContextEngineForOwner>[1],
) {
  return registerContextEngineForOwner(id, factory, `test:${id}`, {
    allowSameOwnerRefresh: true,
  });
}

function installTestPluginRegistry() {
  const builder = createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: true,
  });
  setActivePluginRegistry(builder.registry);
  return builder;
}

type McpProjectionParams = Parameters<typeof resolveLoopbackTools>[0];

const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({})));
const ensureSandboxWorkspaceForSessionMock = vi.hoisted(() =>
  vi.fn<() => Promise<SandboxWorkspaceInfo | null>>(async () => null),
);
vi.mock("../../config/config.js", async () => ({
  getRuntimeConfig: getRuntimeConfigMock,
  resolveGatewayPort: (await import("../../config/paths.js")).resolveGatewayPort,
}));

vi.mock("../sandbox/context.js", async () => ({
  ...(await vi.importActual<typeof import("../sandbox/context.js")>("../sandbox/context.js")),
  ensureSandboxWorkspaceForSession: ensureSandboxWorkspaceForSessionMock,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

vi.mock("../media-generation-task-status.js", () => ({
  buildMediaTaskRuntimeContext: vi.fn(() => undefined),
  VIDEO_GENERATION_TASK_KIND: "video_generation",
  buildVideoGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildVideoGenerationTaskStatusText: vi.fn(() => ""),
  findActiveVideoGenerationTaskForSession: vi.fn(() => undefined),
  IMAGE_GENERATION_TASK_KIND: "image_generation",
  buildImageGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildImageGenerationTaskStatusText: vi.fn(() => ""),
  MUSIC_GENERATION_TASK_KIND: "music_generation",
  buildMusicGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildMusicGenerationTaskStatusText: vi.fn(() => ""),
  findActiveMusicGenerationTaskForSession: vi.fn(() => undefined),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockBuildMediaTaskRuntimeContext = vi.mocked(buildMediaTaskRuntimeContext);

let defaultTestCliBackend = buildDefaultTestCliBackend();

function createCliBackendConfig(params: TestCliBackendParams = {}): OpenClawConfig {
  defaultTestCliBackend = buildDefaultTestCliBackend(params);
  return {};
}

const SHARED_CHAT_MESSAGE_TOOL_ETIQUETTE =
  "- Group/channel: stale/joke/light ack/low-value chatter => reaction or silence. Needed text reply => `message(action=send)`; final text private.";

function createLoopbackRuntime() {
  return {
    port: 31783,
    ownerToken: "loopback-owner-token",
    nonOwnerToken: "loopback-non-owner-token",
  };
}

function createBundledMessageToolConfig(): OpenClawConfig {
  setCliRunnerPrepareTestDeps({
    getActiveMcpLoopbackRuntime: vi.fn(createLoopbackRuntime),
    resolveMcpLoopbackScopedTools: vi.fn(() => ({
      agentId: "main",
      tools: [createCliMcpTool("message", "Message", "Send a message")],
    })),
  });
  return createCliBackendConfig({ bundleMcp: true });
}

function setCliBackendForPrepareTest(
  params: {
    authEpochMode?: CliBackendPlugin["authEpochMode"];
    autoSelectAuthProfile?: boolean;
    bundleMcp?: boolean;
    command?: string;
    id?: string;
    liveSession?: boolean;
    modelAliases?: Record<string, string>;
    modelProvider?: string;
    pluginId?: string;
    prepareExecution?: CliBackendPlugin["prepareExecution"];
    sessionMode?: "always" | "existing" | "none";
    reseedFromRawTranscriptWhenUncompacted?: boolean;
  } = {},
) {
  const id = params.id ?? "claude-cli";
  // Keep preparation behind the same runtime resolver seam that production
  // uses; direct backend constants would bypass provider ownership.
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        id,
        pluginId: params.pluginId ?? "anthropic",
        modelProvider: params.modelProvider ?? "anthropic",
        bundleMcp: params.bundleMcp ?? false,
        ...(params.authEpochMode ? { authEpochMode: params.authEpochMode } : {}),
        ...(params.bundleMcp ? { bundleMcpMode: "claude-config-file" as const } : {}),
        ...(params.autoSelectAuthProfile !== undefined
          ? { autoSelectAuthProfile: params.autoSelectAuthProfile }
          : {}),
        ...(params.prepareExecution ? { prepareExecution: params.prepareExecution } : {}),
        config: {
          ...createJsonlStdinBackendConfig(params.command ?? "claude"),
          systemPromptFileArg: "--append-system-prompt-file",
          systemPromptWhen: "always",
          resumeArgs: ["--resume", "{sessionId}"],
          sessionMode: params.sessionMode ?? "existing",
          ...(params.modelAliases ? { modelAliases: params.modelAliases } : {}),
          ...(params.liveSession ? { liveSession: "claude-stdio" as const } : {}),
          ...(params.reseedFromRawTranscriptWhenUncompacted
            ? { reseedFromRawTranscriptWhenUncompacted: true }
            : {}),
        },
      },
    ],
  });
}

function createArgBackendConfig(
  command: string,
  args = ["--print"],
  output: "text" | "json" = "text",
): CliBackendPlugin["config"] {
  return { command, args, output, input: "arg", sessionMode: "existing" };
}

function createNativeArgMcpBackend(): CliBackendPlugin & { pluginId: string } {
  return {
    id: "native-cli",
    pluginId: "native-plugin",
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    config: {
      ...createArgBackendConfig("native-cli"),
      systemPromptArg: "--system-prompt",
      systemPromptWhen: "first",
    },
  };
}

describe("prepareCliRunContext", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-prepare-");
  const retainedStateDirs: string[] = [];
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

  function saveProfiles(profiles: Parameters<typeof saveAuthProfileStore>[0]["profiles"]) {
    const agentDir = path.join(fixture.session.dir, "agents", "main", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(createAuthProfileStoreFixture(profiles), agentDir);
    return agentDir;
  }

  async function withAuthenticatedHistory(
    provider: string,
    run: (
      prepare: (
        overrides: NonNullable<Parameters<typeof fixture.prepare>[0]>,
      ) => ReturnType<typeof fixture.prepare>,
    ) => Promise<void>,
  ) {
    const { dir, sessionTarget } = fixture.session;

    const authProfileId = "history-test:account";
    const credential = {
      type: "token" as const,
      provider: provider === "claude-cli" ? "anthropic" : provider,
      token: "synthetic-history-account",
    };
    const agentDir = saveProfiles({ [authProfileId]: credential });
    const authEpoch = await resolveCliAuthEpoch({ provider, agentDir, authProfileId });
    const runId = "authenticated-history-fixture";
    await patchSessionEntryCore(sessionTarget, (entry) => ({ ...entry, activeWriterRunId: runId }));
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "history-fixture");
    try {
      const admittedRunContext = await admission.admit("embedded");
      const writer = await prepareCliHistoryBoundary(
        {
          admittedRunContext,
          runId,
          agentDir,
          provider,
          model: "test-model",
          prompt: "seed",
          workspaceDir: dir,
          timeoutMs: 1000,
          sessionId: sessionTarget.sessionId,
          sessionKey: sessionTarget.sessionKey,
          sessionFile: sessionTarget.sessionKey,
          sessionTarget,
        },
        { credential },
      );
      expect(writer).toBeDefined();
      await runWithCliHistoryWriter(writer, () =>
        run((overrides) =>
          fixture.prepare({
            ...overrides,
            provider,
            agentDir,
            authProfileId,
            runId,
            preparedRunAdmission: admission,
            sessionKey: sessionTarget.sessionKey,
            ...(overrides.cliSessionBinding
              ? {
                  cliSessionBinding: {
                    ...overrides.cliSessionBinding,
                    authProfileId,
                    authEpoch,
                    authEpochVersion: CLI_AUTH_EPOCH_VERSION,
                  },
                }
              : {}),
          }),
        ),
      );
    } finally {
      admission.close();
    }
  }

  async function prepareNativeAuthority(
    capabilities: readonly string[],
    overrides: Parameters<typeof fixture.prepare>[0] = {},
  ) {
    const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);
    const projectNativeToolAuthority = vi.fn((_tools: readonly string[]) => capabilities);
    const captureNativeToolAuthority = vi.fn((_names: readonly string[] | null) => true);
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime: vi.fn(createLoopbackRuntime),
      mintMcpLoopbackClientGrant,
      activateMcpLoopbackClientGrantCapture: vi.fn(() => ({ captureNativeToolAuthority })),
    });
    setBackend({
      id: "native-cli",
      pluginId: "native-plugin",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "execution-args",
      resolveExecutionArgs: ({ baseArgs }) => baseArgs,
      projectNativeToolAuthority,
    });
    const context = await fixture.prepare({ provider: "native-cli", ...overrides });
    const capture = expectDefined(context.preparedBackend.mcpClientGrantCapture, "native capture");
    const observe = expectDefined(capture.captureNativeTools, "native tools observer");
    return {
      capture,
      observe,
      mintMcpLoopbackClientGrant,
      projectNativeToolAuthority,
      captureNativeToolAuthority,
    };
  }

  it("preserves outer fallback route provenance through CLI admission", async () => {
    const runId = "run-cli-model-fallback-receipt";
    const cfg = { logging: { audit: { executionIdentity: true } } } satisfies OpenClawConfig;
    const preparedRunAdmission = createModelRoutingTestAdmission({
      cfg,
      runId,
      agentId: "main",
      boundary: "cli-prepare-test",
    });

    const { decisionWork } = await captureRoutingDecisionWork(() =>
      fixture.prepare({
        runId,
        config: cfg,
        preparedRunAdmission,
        model: "mock-2",
        modelRoutingProvenance: {
          requestedProvider: "openai",
          requestedModel: "mock-1",
          stage: "fallback",
          fallbackReason: "rate_limit",
        },
      }),
    ).finally(preparedRunAdmission.close);

    expect(decisionWork).toHaveLength(1);
    expect(decisionWork[0]?.receipt).toMatchObject({
      action: { summary: "Requested openai/mock-1; selected test-cli/mock-2." },
      decision: { reasonCode: "rate_limit" },
    });
  });

  registerCliThinkingPreparationTests({
    getFixture: () => fixture,
    setBackend: setCliBackendForPrepareTest,
  });

  it.each<[string, Record<string, string>]>([
    ["large", { large: "claude-opus-4-7" }],
    ["claude-opus-4-7", { "claude-opus-4-7": "deployment-large" }],
  ])("resolves canonical model budgets for alias %s", async (model, modelAliases) => {
    const prepareExecution = vi.fn(async () => undefined);
    setCliBackendForPrepareTest({
      modelProvider: "fixture-anthropic",
      pluginId: "fixture-plugin",
      prepareExecution,
      modelAliases,
    });
    const context = await fixture.prepare({
      provider: "claude-cli",
      model,
      config: {
        models: {
          providers: {
            "fixture-anthropic": {
              baseUrl: "https://api.anthropic.com",
              models: [catalogModel("claude-opus-4-7", "Claude Opus 4.7", 100_000, 8_192, 200_000)],
            },
            "collision-provider": {
              baseUrl: "https://collision.invalid",
              models: [catalogModel("large", "Unrelated Large", 32_000, 4_096, 32_000)],
            },
            "claude-cli": {
              baseUrl: "https://runtime.invalid",
              models: [catalogModel("large", "Configured Alias Source", 200_000, 8_192, 200_000)],
            },
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(context.backendResolved.modelProvider).toBe("fixture-anthropic");
    expect(context.contextWindowInfo?.tokens).toBe(100_000);
    expectCall(prepareExecution, { contextTokenBudget: 100_000 });
  });

  it.each([
    ["200k", 200_000],
    [undefined, 1_000_000],
  ] as const)("caps the catalog context budget with selection %s", async (selection, expected) => {
    const prepareExecution = vi.fn(async () => undefined);
    setCliBackendForPrepareTest({ prepareExecution });
    setCliRunnerPrepareTestDeps({
      loadManifestModelCatalog: vi.fn(() => [
        {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "anthropic",
          contextWindow: 1_000_000,
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
          contextWindowDefault: "1m",
        },
      ]),
    });

    const context = await fixture.prepare({
      provider: "claude-cli",
      model: "claude-fable-5",
      config: {},
      // The run owner carries the selection as a prepared fact; a session entry
      // alone must not drive it (reply-path regression: selection dropped when
      // prepare read sessionEntry directly).
      ...(selection ? { contextWindow: selection } : {}),
      sessionEntry: {
        sessionId: "cli-session",
        updatedAt: 0,
        ...(selection ? {} : { contextWindow: "200k" }),
      },
    });

    expect(context.contextWindowInfo?.tokens).toBe(expected);
    expectCall(prepareExecution, { contextTokenBudget: expected });
  });

  beforeEach(() => {
    // Install narrow test doubles for external runtime seams so preparation
    // remains about data flow, not bundled plugin or loopback startup cost.
    defaultTestCliBackend = buildDefaultTestCliBackend();
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [defaultTestCliBackend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      makeBootstrapWarn: vi.fn(() => () => undefined),
      resolveBootstrapContextForRun: vi.fn(async () => ({
        bootstrapFiles: [],
        contextFiles: [],
      })),
      getActiveMcpLoopbackRuntime: vi.fn(() => undefined),
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      bindMcpLoopbackClientGrantAdmission: vi.fn(() => true),
      revokeMcpLoopbackClientGrant: vi.fn(() => true),
      resolveMcpLoopbackPolicyTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveOpenClawReferencePaths: vi.fn(async () => ({ docsPath: null, sourcePath: null })),
      prepareClaudeCliSkillsPlugin: vi.fn(async () => ({
        args: [],
        cleanup: vi.fn(async () => undefined),
      })),
      getCliLiveSessionGeneration: vi.fn(() => undefined),
      resolveApiKeyForProfile: resolveApiKeyForProfileImpl,
      // Keep preparation off the real plugin-metadata snapshot; catalog-driven
      // cases inject their own rows.
      loadManifestModelCatalog: vi.fn(() => []),
    });
    mockGetGlobalHookRunner.mockReturnValue(null);
    const config: OpenClawConfig = {};
    getRuntimeConfigMock.mockReturnValue(config);
    setRuntimeConfigSnapshot(config);
    mockBuildMediaTaskRuntimeContext.mockResolvedValue(undefined);
    ensureSandboxWorkspaceForSessionMock.mockReset();
    ensureSandboxWorkspaceForSessionMock.mockResolvedValue(null);
    // Discovery cases explicitly opt out of the prepared empty catalog.
    fixture = createCliRunnerPrepareFixture(
      (params) => {
        setRuntimeConfigSnapshot(params.config ?? {});
        return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
      },
      {
        make() {
          const dir = sessionDirs.make();
          retainedStateDirs.push(dir);
          return dir;
        },
      },
    );
  });

  afterEach(async () => {
    await fixture.settle();
    setActiveNodeContexts([]);
    cliBackendsTesting.resetDepsForTest();
    resetCliRunnerPrepareTestDeps();
    getRuntimeConfigMock.mockReset();
    mockGetGlobalHookRunner.mockReset();
    mockBuildMediaTaskRuntimeContext.mockReset();
    ensureSandboxWorkspaceForSessionMock.mockReset();
    resetContextWindowCacheForTest();
    clearMemoryPluginState();
    setActivePluginRegistry(createTestRegistry());
    setActiveDegradedSecretOwners([]);
    vi.unstubAllEnvs();
    await fixture.cleanup();
    // A few retained cases keep both broker workers warm below their store capacity.
    for (const dir of retainedStateDirs.splice(0, retainedStateDirs.length - 4)) {
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: dir }),
      );
    }
    clearRuntimeConfigSnapshot();
  });

  it("does not renew an explicitly revoked CLI owner during preparation", async () => {
    const { sessionTarget } = fixture.session;
    const admission = prepareSystemAgentRunAdmission(
      {},
      "revoked-user",
      "main",
      "revoked-context-test",
    );
    const admittedRunContext = await admission.admit("embedded");
    admission.close();
    await expect(
      fixture.prepare({
        admittedRunContext,
        runId: "revoked-user",
        trigger: "user",
        sessionKey: sessionTarget.sessionKey,
      }),
    ).rejects.toThrow("authority");
  });

  it("honors an explicit auth agent directory independently of session identity", async () => {
    const { dir } = fixture.session;
    const modelOwnerAgentDir = path.join(dir, "ops-agent");
    const systemAgentDir = path.join(dir, "openclaw-agent");
    const prepareExecution = vi.fn(async () => undefined);
    fs.mkdirSync(modelOwnerAgentDir, { recursive: true });
    setBackend({
      prepareExecution,
      config: createArgBackendConfig("test-cli"),
    });

    const context = await fixture.prepare({
      sessionKey: "agent:openclaw:main",
      agentId: "openclaw",
      agentDir: modelOwnerAgentDir,
      authProfileId: "test-cli:ops",
      config: {
        agents: {
          entries: {
            ops: { agentDir: modelOwnerAgentDir },
            openclaw: { agentDir: systemAgentDir },
          },
        },
      },
    });

    expect(context.effectiveAuthProfileId).toBe("test-cli:ops");
    expectCall(prepareExecution, {
      agentDir: modelOwnerAgentDir,
      authProfileId: "test-cli:ops",
    });
  });

  it.each([
    "gemini-refresh",
    "gemini-error",
    "third-party",
    "managed-refresh",
    "native-login",
    "missing",
    "different-profile",
    "implicit",
    "environment-only",
  ] as const)("prepares the selected auth account: %s", async (scenario) => {
    const gemini = scenario.startsWith("gemini-");
    const implicit = scenario === "implicit" || scenario === "environment-only";
    const provider = gemini
      ? "google-gemini-cli"
      : scenario === "third-party"
        ? "test-cli"
        : "claude-cli";
    const authProfileId =
      scenario === "native-login"
        ? "anthropic:claude-cli"
        : implicit
          ? "claude-cli:stored"
          : `${provider}:selected`;
    const fallbackProfileId = "anthropic:account-b";
    const refreshedCredential = {
      type: "oauth" as const,
      provider: "anthropic",
      access: "refreshed-access-token",
      refresh: "refreshed-refresh-token",
      expires: Date.now() + 60 * 60_000,
    };
    const credential = implicit
      ? createApiKeyCredential("claude-cli", "stored-key")
      : scenario === "third-party"
        ? createApiKeyCredential("test-cli", "secret-key")
        : {
            type: "oauth" as const,
            provider: gemini ? provider : scenario === "native-login" ? "claude-cli" : "anthropic",
            access: "expired-access-token",
            refresh: scenario === "gemini-error" ? "" : "stored-refresh-token",
            expires: 1,
            ...(gemini ? { projectId: "project-1", email: "user@example.test" } : {}),
          };
    const agentDir = saveProfiles({
      [authProfileId]: credential,
      ...(scenario === "different-profile" ? { [fallbackProfileId]: refreshedCredential } : {}),
    });
    const backendError = new CliBackendAuthProfilePreparationError(
      "Gemini CLI OAuth profile is incomplete.",
    );
    const prepareExecution = vi.fn<NonNullable<CliBackendPlugin["prepareExecution"]>>(async () => {
      if (scenario === "gemini-error") {
        throw backendError;
      }
      return gemini
        ? { env: { GEMINI_CLI_HOME: path.join(agentDir, "gemini-home") } }
        : implicit
          ? { env: { TEST_PREPARED_ENV: "1" } }
          : undefined;
    });
    const resolveApiKeyForProfile = vi.fn<typeof resolveApiKeyForProfileImpl>(async () => {
      if (gemini) {
        throw new Error("Gemini CLI OAuth must not enter core refresh");
      }
      if (scenario === "missing" || scenario === "native-login") {
        return null;
      }
      return {
        apiKey: refreshedCredential.access,
        provider: refreshedCredential.provider,
        profileId: scenario === "different-profile" ? fallbackProfileId : authProfileId,
        profileType: refreshedCredential.type,
        credential: refreshedCredential,
        readCurrentCredential: null,
      };
    });
    if (!implicit && scenario !== "third-party") {
      setCliRunnerPrepareTestDeps({ resolveApiKeyForProfile });
    }
    if (gemini) {
      setGeminiBackend({ prepareExecution, authEpochMode: "profile-only" });
    } else if (scenario === "third-party") {
      setBackend({
        id: provider,
        prepareExecution,
        config: createArgBackendConfig("test-cli", ["--prompt", "{prompt}"], "json"),
      });
    } else {
      setCliBackendForPrepareTest({
        prepareExecution,
        authEpochMode: "profile-only",
        ...(scenario === "environment-only" ? { autoSelectAuthProfile: false } : {}),
      });
    }
    const pending = fixture.prepare({
      sessionKey: "agent:main:main",
      agentDir,
      provider,
      model: gemini ? "gemini-3.1-pro-preview" : "sonnet",
      ...(implicit ? {} : { authProfileId }),
      ...(scenario === "gemini-refresh" ? { onSuccessfulAuthBinding: () => {} } : {}),
      config: implicit
        ? { auth: { profiles: { [authProfileId]: { provider: "claude-cli", mode: "api_key" } } } }
        : {},
    });
    if (scenario === "gemini-error") {
      await expect(pending).rejects.toMatchObject({
        name: "CliAuthProfilePreparationError",
        reason: "auth",
        profileId: authProfileId,
        provider,
        agentDir,
        cause: backendError,
      });
    } else if (scenario === "missing" || scenario === "different-profile") {
      await expect(pending).rejects.toThrow(
        scenario === "missing"
          ? `could not materialize selected auth profile "${authProfileId}"`
          : `resolved as "${fallbackProfileId}"`,
      );
      await expect(pending).rejects.toMatchObject({
        name: "CliAuthProfilePreparationError",
        reason: "auth",
        profileId: authProfileId,
        provider: "anthropic",
        agentDir,
      });
      await expect(pending).rejects.toThrow("openclaw models auth login --provider anthropic");
      expect(prepareExecution).not.toHaveBeenCalled();
    } else {
      const context = await pending;
      if (scenario === "third-party") {
        expectCall(prepareExecution, { authProfileId });
        expect(prepareExecution.mock.calls[0]?.[0]).not.toHaveProperty("authCredential");
      } else if (scenario === "native-login") {
        expect(prepareExecution).toHaveBeenCalledOnce();
        expectCall(prepareExecution, { authProfileId: undefined, authCredential: undefined });
        expect(resolveApiKeyForProfile).not.toHaveBeenCalled();
      } else if (implicit) {
        const selected = scenario === "implicit" ? authProfileId : undefined;
        expect(context.effectiveAuthProfileId).toBe(selected);
        expectCall(prepareExecution, { authProfileId: selected });
      } else {
        expectCall(prepareExecution, {
          authProfileId,
          authCredential: scenario === "managed-refresh" ? refreshedCredential : credential,
        });
        if (gemini) {
          expect(resolveApiKeyForProfile).not.toHaveBeenCalled();
          expect(context.authBindingFingerprint).toMatch(/^[a-f0-9]{64}$/);
          expect(context.authBindingSkipsLocalCredential).toBe(true);
        } else {
          expectCall(resolveApiKeyForProfile, {
            profileId: authProfileId,
            agentDir,
            allowProfileFallback: false,
          });
        }
      }
    }
  });

  it.each(["connected", "missing"] as const)(
    "requires the exact selected personal CLI credential when its account is %s",
    async (accountState) => {
      const { dir } = fixture.session;
      const agentDir = path.join(dir, "agents", "main", "agent");
      const databasePath = resolveOpenClawStateSqlitePath();
      try {
        const owner = ensureProfileForEmail("cli-owner@example.test");
        const credential = {
          type: "token" as const,
          provider: "anthropic",
          token: "synthetic-personal-cli-token",
        };
        const connected = connectUserModelAccount({
          ownerProfileId: owner.id,
          credential,
          assertCurrent: () => undefined,
        });
        const authProfileId =
          accountState === "connected"
            ? connected.authProfileId
            : `personal:${owner.id}:${randomUUID()}`;
        const prepareExecution = vi.fn(async () => undefined);
        setCliBackendForPrepareTest({ prepareExecution, authEpochMode: "profile-only" });

        const preparation = fixture.prepare({
          agentDir,
          provider: "claude-cli",
          model: "sonnet",
          authProfileId,
        });
        if (accountState === "connected") {
          await preparation;
          expectCall(prepareExecution, { authProfileId, authCredential: credential });
        } else {
          await expect(preparation).rejects.toThrow(
            `could not materialize selected auth profile "${authProfileId}"`,
          );
          expect(prepareExecution).not.toHaveBeenCalled();
        }
        expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).not.toHaveProperty(
          connected.authProfileId,
        );
      } finally {
        closeOpenClawStateDatabaseByPath(databasePath);
      }
    },
  );

  it("lets Gemini CLI preparation override generated MCP system settings auth", async () => {
    const { dir } = fixture.session;
    const profileSystemSettingsPath = path.join(dir, "profile-system-settings.json");
    const getActiveMcpLoopbackRuntime = vi.fn(createLoopbackRuntime);
    const prepareExecution = vi.fn(async (_ctx: unknown) => ({
      env: {
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: profileSystemSettingsPath,
      },
    }));
    setGeminiBackend({
      bundleMcp: true,
      bundleMcpMode: "gemini-system-settings",
      prepareExecution,
    });
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
    });

    let cleanup: (() => Promise<void>) | undefined;
    try {
      const context = await fixture.prepare({
        sessionKey: "agent:main:main",
        provider: "google-gemini-cli",
        model: "gemini-3.1-pro-preview",
        config: {},
      });
      cleanup = context.preparedBackend.cleanup;

      const prepareExecutionArg = prepareExecution.mock.calls[0]?.[0] as
        | { env?: Record<string, string> }
        | undefined;
      const generatedSystemSettingsPath = prepareExecutionArg?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      expect(typeof generatedSystemSettingsPath).toBe("string");
      expect(generatedSystemSettingsPath).not.toBe(profileSystemSettingsPath);
      const generatedSettings = JSON.parse(
        fs.readFileSync(generatedSystemSettingsPath ?? "", "utf8"),
      ) as {
        mcp?: { allowed?: string[] };
        mcpServers?: Record<string, { url?: string }>;
      };
      expect(generatedSettings.mcp?.allowed).toEqual(["openclaw"]);
      expect(generatedSettings.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:31783/mcp");
      expect(context.preparedBackend.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(
        profileSystemSettingsPath,
      );
    } finally {
      await cleanup?.();
    }
  });

  it("cleans generated Gemini MCP settings when auth preparation fails", async () => {
    let generatedSystemSettingsPath: string | undefined;
    const getActiveMcpLoopbackRuntime = vi.fn(createLoopbackRuntime);
    const prepareExecution = vi.fn(async (ctx: unknown) => {
      generatedSystemSettingsPath = (ctx as { env?: Record<string, string> }).env
        ?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      throw new Error("Gemini auth profile was selected but no credential material was found");
    });
    const revokeMcpLoopbackClientGrant = vi.fn(() => true);
    setGeminiBackend({
      bundleMcp: true,
      bundleMcpMode: "gemini-system-settings",
      prepareExecution,
    });
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      revokeMcpLoopbackClientGrant,
    });

    await expect(
      fixture.prepare({
        sessionKey: "agent:main:main",
        provider: "google-gemini-cli",
        model: "gemini-3.1-pro-preview",
        config: {},
      }),
    ).rejects.toThrow(/no credential material/);

    expect(generatedSystemSettingsPath).toBeTruthy();
    expect(fs.existsSync(generatedSystemSettingsPath ?? "")).toBe(false);
    expect(revokeMcpLoopbackClientGrant).toHaveBeenCalledExactlyOnceWith("loopback-token");
  });

  it("cleans prepared MCP and skills plugin dirs when mid-prepare reference lookup fails", async () => {
    const { dir } = fixture.session;
    const tempEnvSnapshot = captureEnv(["TMPDIR", "TMP", "TEMP"]);
    const tempRoot = path.join(dir, "tmp");
    const skillsPluginDir = path.join(dir, "claude-skills-plugin");
    const skillsCleanup = vi.fn(async () => {
      fs.rmSync(skillsPluginDir, { recursive: true, force: true });
    });
    const revokeMcpLoopbackClientGrant = vi.fn(() => true);
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.mkdirSync(skillsPluginDir, { recursive: true });
    setTestEnvValue("TMPDIR", tempRoot);
    setTestEnvValue("TMP", tempRoot);
    setTestEnvValue("TEMP", tempRoot);
    const getActiveMcpLoopbackRuntime = vi.fn(createLoopbackRuntime);
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      revokeMcpLoopbackClientGrant,
      prepareClaudeCliSkillsPlugin: vi.fn(async () => ({
        args: ["--plugin-dir", skillsPluginDir],
        cleanup: skillsCleanup,
      })),
      resolveOpenClawReferencePaths: vi.fn(async () => {
        throw new Error("reference path lookup failed");
      }),
    });

    try {
      await expect(
        fixture.prepare({
          sessionKey: "agent:main:main",
          config: createCliBackendConfig({ bundleMcp: true }),
        }),
      ).rejects.toThrow("reference path lookup failed");

      expect(skillsCleanup).toHaveBeenCalledOnce();
      expect(revokeMcpLoopbackClientGrant).toHaveBeenCalledExactlyOnceWith("loopback-token");
      expect(fs.existsSync(skillsPluginDir)).toBe(false);
      expect(
        fs.readdirSync(tempRoot).filter((entry) => entry.startsWith("openclaw-cli-mcp-")),
      ).toEqual([]);
    } finally {
      tempEnvSnapshot.restore();
    }
  });

  it("prepares side questions without agent-turn context, tools, hooks, or reusable sessions", async () => {
    setActiveNodeContexts([{ nodeId: "active-mac" }]);
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "prior user text", timestamp: 1 },
    });
    const agentTurnPreparation = vi.fn(() => {
      throw new Error("Side question entered agent-turn preparation");
    });
    const prepareExecution = vi.fn(async () => undefined);
    setBackend({
      pluginId: "test",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      nativeToolMode: "always-on",
      sideQuestionToolMode: "disabled",
      prepareExecution,
      config: {
        ...createJsonlStdinBackendConfig("test-cli"),
        liveSession: "claude-stdio",
        sessionMode: "always",
      },
    });
    setCliRunnerPrepareTestDeps({
      resolveBootstrapContextForRun: agentTurnPreparation,
      ensureMcpLoopbackServer: agentTurnPreparation,
      prepareClaudeCliSkillsPlugin: agentTurnPreparation,
      resolveMcpLoopbackScopedTools: agentTurnPreparation,
      resolveOpenClawReferencePaths: agentTurnPreparation,
    });
    const context = await fixture.prepare({
      sessionKey: "agent:main:main",
      prompt: "side question prompt",
      executionMode: "side-question",
      timeoutMs: 120_000,
      extraSystemPrompt: "BTW system prompt",
      disableTools: true,
      cliSessionId: "existing-cli-session",
    });
    expect(agentTurnPreparation).not.toHaveBeenCalled();
    expect(mockGetGlobalHookRunner).not.toHaveBeenCalled();
    expectCall(prepareExecution, { executionMode: "side-question" });
    expect(context.systemPrompt).toBe("BTW system prompt");
    expect(context.params.prompt).toBe("side question prompt");
    expect([
      context.openClawHistoryPrompt,
      context.contextEngine,
      context.contextEngineTurnPrompt,
    ]).toEqual([undefined, undefined, undefined]);
    expect(context.hadSessionFile).toBe(false);
    expect(context.claudeSkillsPluginArgs).toEqual([]);
    expect(context.preparedBackend.backend.sessionMode).toBe("none");
    expect(context.preparedBackend.backend.liveSession).toBeUndefined();
    expect(context.systemPromptReport.injectedWorkspaceFiles).toEqual([]);
    expect(context.systemPromptReport.tools.entries).toEqual([]);
  });

  it.each(["always-on", undefined] as const)(
    "renders bootstrap guidance with nativeToolMode=%s",
    async (nativeToolMode) => {
      const { dir } = fixture.session;
      const bootstrapPath = path.join(dir, "BOOTSTRAP.md");
      const file = {
        name: "BOOTSTRAP.md" as const,
        path: bootstrapPath,
        content: "Complete the first-run ritual, then delete this file.",
        missing: false,
      };
      setBackend({
        pluginId: "test",
        nativeToolMode,
        config: {
          ...createArgBackendConfig("test-cli"),
          systemPromptArg: "--system-prompt",
          systemPromptWhen: "first",
        },
      });
      setCliRunnerPrepareTestDeps({
        isWorkspaceBootstrapPending: vi.fn(async () => true),
        resolveBootstrapContextForRun: vi.fn(async () => ({
          bootstrapFiles: [file],
          contextFiles: [file],
        })),
      });
      const context = await fixture.prepare({
        sessionKey: "agent:main:main",
        trigger: "user",
        config: { agents: { defaults: { workspace: dir } } },
        extraSystemPrompt: "stable prompt",
        cliSessionBinding: {
          sessionId: "cli-session",
          extraSystemPromptHash: hashCliSessionText("stable prompt"),
          cwdHash: hashCliSessionText(dir),
        },
      });
      expect(context.systemPrompt).toContain("## Bootstrap Pending");
      if (nativeToolMode === "always-on") {
        expectText(context.systemPrompt, [
          "BOOTSTRAP.md below; follow before normal reply.",
          "## " + bootstrapPath,
          "Complete the first-run ritual",
        ]);

        expect(context.systemPromptReport.injectedWorkspaceFiles).toEqual([
          expect.objectContaining({
            name: "BOOTSTRAP.md",
            injectedChars: expect.any(Number),
            truncated: false,
          }),
        ]);
      } else {
        expectText(
          context.systemPrompt,
          ["this run cannot safely finish full BOOTSTRAP.md"],
          ["## " + bootstrapPath, "Complete the first-run ritual"],
        );

        expect(context.systemPromptReport.injectedWorkspaceFiles).toEqual([]);
      }
      expect(context.reusableCliSession).toEqual({
        mode: "reuse-with-drift",
        sessionId: "cli-session",
        drift: { reasons: ["system-prompt"] },
      });
    },
  );

  it("drifts a resumed first-only session when truncation starts mid-session", async () => {
    const { dir } = fixture.session;
    const agentsPath = path.join(dir, "AGENTS.md");
    const bootstrapContextFor = (injected: string) => ({
      bootstrapFiles: [
        {
          name: "AGENTS.md" as const,
          path: agentsPath,
          content: "policy ".repeat(100),
          missing: false,
        },
      ],
      contextFiles: [{ path: agentsPath, content: injected }],
    });
    setBackend({
      pluginId: "test",
      nativeToolMode: "always-on",
      config: {
        ...createArgBackendConfig("test-cli"),
        systemPromptArg: "--system-prompt",
        systemPromptWhen: "first",
      },
    });
    setCliRunnerPrepareTestDeps({
      resolveBootstrapContextForRun: vi.fn(async () => bootstrapContextFor("policy ".repeat(100))),
    });
    const firstTurn = await fixture.prepare({
      sessionKey: "agent:main:main",
      config: createCliBackendConfig(),
      prompt: "turn one",
      runId: "run-truncation-drift-1",
      trigger: "user",
      extraSystemPrompt: "stable prompt",
    });
    expect(firstTurn.systemPrompt).not.toContain("[Bootstrap truncation warning]");
    const untruncatedBinding = {
      sessionId: "cli-session",
      extraSystemPromptHash: firstTurn.extraSystemPromptHash,
      cwdHash: hashCliSessionText(dir),
    };

    // AGENTS.md grows past the bootstrap cap between turns of the same session.
    setCliRunnerPrepareTestDeps({
      resolveBootstrapContextForRun: vi.fn(async () => bootstrapContextFor("policy ".repeat(10))),
    });
    const secondTurn = await fixture.prepare({
      sessionKey: "agent:main:main",
      config: createCliBackendConfig(),
      prompt: "turn two",
      runId: "run-truncation-drift-2",
      trigger: "user",
      extraSystemPrompt: "stable prompt",
      cliSessionBinding: untruncatedBinding,
    });

    expect(secondTurn.systemPrompt).toContain("[Bootstrap truncation warning]");
    expect(secondTurn.reusableCliSession).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session",
      drift: { reasons: ["system-prompt"] },
    });
  });

  it("uses compact current-turn context when a room event resumes a CLI session", async () => {
    await withAuthenticatedHistory("test-cli", async (prepare) => {
      fixture.appendTranscript({
        id: "msg-1",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: makeUserMessage("prior room event", 1),
      });
      // Room resumes carry compact event text into the CLI prompt but keep the
      // richer room context in OpenClaw history for reseed and audits.
      const context = await prepare({
        sessionKey: "agent:main:test",
        agentId: "main",
        trigger: "user",
        prompt: "[OpenClaw room event]",
        currentInboundEventKind: "room_event",
        currentInboundContext: {
          text: "Room context:\nAlice: lunch?\n\nCurrent event:\nBob: yes",
          resumableText: "Current event:\nBob: yes",
        },
        cliSessionBinding: {
          sessionId: "cli-session",
        },
        config: createCliBackendConfig({
          reseedFromRawTranscriptWhenUncompacted: true,
        }),
      });

      expect(context.reusableCliSession).toEqual({ mode: "reuse", sessionId: "cli-session" });
      expect(context.params.prompt).toMatch(
        /^Current event:\nBob: yes\n\n\[OpenClaw room event\]\n\nThis turn has no current conversation\./,
      );
      expect(context.params.prompt).toMatch(
        /\n\nCurrent active computer .*active_node=unknown active_node_identity=unknown$/,
      );
      expect(context.params.transcriptPrompt).toBe("[OpenClaw room event]");
      expect(context.openClawHistoryPrompt).toContain("Room context:\nAlice: lunch?");
      expect(context.openClawHistoryPrompt).toContain("Current event:\nBob: yes");
    });
  });

  it("marks inter-session prompts after CLI prompt-build hook context is applied", async () => {
    const hookRunner = promptHook({
      prependContext: "trusted hook context",
    });
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

    const context = await fixture.prepare({
      sessionKey: "agent:main:test",
      agentId: "main",
      trigger: "user",
      prompt: "foreign reply text",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:slack:dm:U123",
        sourceChannel: "slack",
        sourceTool: "sessions_send",
      },
      runId: "run-test",
    });

    expect(context.params.prompt).toMatch(/^\[Inter-session message/);
    expectText(context.params.prompt, [
      "sourceSession=agent:main:slack:dm:U123",
      "isUser=false",
      "trusted hook context",
      "foreign reply text",
    ]);
  });

  it("applies turn-authorized prompt enrichment after CLI tool preparation", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => undefined),
      runAuthorizedPromptBuild: vi.fn(async () => ({
        prependContext: "authorized memory context",
      })),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);
    const preparedRunAdmission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("run-test"),
      facts: {
        runId: "run-test",
        agentId: "main",
        ingress: { kind: "system", boundary: "test", state: "present" },
      },
    });

    const context = await fixture
      .prepare({
        toolAuthorityFingerprint: "turn-authority",
        preparedRunAdmission,
      })
      .finally(preparedRunAdmission.close);

    expect(context.params.prompt).toMatch(
      /^authorized memory context\n\nlatest ask\n\nThis turn has no current conversation\./,
    );
    expect(context.params.transcriptPrompt).toBe("latest ask");
    expect(hookRunner.runAuthorizedPromptBuild).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "latest ask" }),
      expect.any(Object),
      {
        toolAuthorityFingerprint: "turn-authority",
        activeToolNames: [],
        assertHostActive: expect.any(Function),
      },
    );
  });

  it.each(["legacy", "incompatible-cleanup-failed", "cleanup-failed", "retired"] as const)(
    "settles directly resolved CLI context-engine custody (%s)",
    async (scenario) => {
      const custody = createContextEngineCustodyFixture();
      const engineId = `cli-custody-${scenario}`;
      const incompatible = scenario.startsWith("incompatible");
      const cleanupFailure = new Error("CLI engine cleanup failed");
      const backendCleanup = vi.fn(async () => {});
      setBackend({
        ...buildDefaultTestCliBackend(),
        prepareExecution: async () => ({ cleanup: backendCleanup }),
      });
      let current = true;
      class Engine extends LegacyContextEngine {
        override readonly info: ContextEngine["info"] = {
          id: scenario === "legacy" ? "legacy" : engineId,
          name: "CLI custody fixture",
          ...(incompatible
            ? {
                hostRequirements: {
                  "agent-run": {
                    requiredCapabilities: ["assemble-before-prompt"],
                    unsupportedMessage: "CLI engine host unsupported",
                  },
                },
              }
            : {}),
        };
        async dispose() {
          expect(custody.read()).toBe(42);
          if (scenario.endsWith("cleanup-failed")) {
            throw cleanupFailure;
          }
        }
      }
      registerContextEngineInRegistry(
        custody.registry,
        engineId,
        async () => {
          current = scenario !== "retired";
          return new Engine();
        },
        "plugin:fixture",
      );
      try {
        const preparation = withPluginRuntimeRegistryScope(custody.registry, () =>
          fixture.prepare({
            config: { plugins: { allow: ["fixture"], slots: { contextEngine: engineId } } },
            assertCurrent: () => {
              if (!current) {
                throw new Error("CLI owner retired after engine acquisition");
              }
            },
          }),
        );
        if (incompatible || scenario === "retired") {
          await expect(preparation).rejects.toThrow(
            incompatible
              ? "CLI engine host unsupported"
              : "CLI owner retired after engine acquisition",
          );
          await custody.resources.release();
        } else {
          const context = await preparation;
          expect(context.contextEngine?.info.id).toBe(scenario === "legacy" ? undefined : engineId);
          await custody.resources.release();
          expect(custody.retired).not.toHaveBeenCalled();
          if (scenario === "cleanup-failed") {
            await expect(context.preparedBackend.cleanup?.()).rejects.toBe(cleanupFailure);
          } else {
            await context.preparedBackend.cleanup?.();
          }
        }
        expect(backendCleanup).toHaveBeenCalledOnce();
        expect(custody.retired).toHaveBeenCalledOnce();
        expect(() => custody.read()).toThrow();
      } finally {
        await custody.cleanup();
      }
    },
  );

  it("releases prepared CLI context-engine custody when hook history cannot be read", async () => {
    const custody = createContextEngineCustodyFixture();
    const engineId = "cli-custody-history-failure";
    const historyFailure = new Error("synthetic hook-history read failed");
    const backendCleanup = vi.fn(async () => {});
    const execute = vi.fn<CliBackendExecute>(async function* () {
      yield { type: "result", subtype: "success", result: "unexpected answer" };
    });
    setBackend({
      ...buildDefaultTestCliBackend(),
      prepareExecution: async () => ({ cleanup: backendCleanup, execute }),
    });
    let engineAcquired = false;
    class Engine extends LegacyContextEngine {
      override readonly info = { id: engineId, name: "CLI failed-history custody fixture" };
      async dispose() {
        expect(custody.read()).toBe(42);
      }
    }
    const factory = vi.fn(() => {
      engineAcquired = true;
      return new Engine();
    });
    registerContextEngineInRegistry(custody.registry, engineId, factory, "plugin:fixture");
    custody.registry.typedHooks.push({
      pluginId: "fixture",
      hookName: "llm_input",
      handler: () => {},
      source: "test",
    });
    mockGetGlobalHookRunner.mockReturnValue(createHookRunner(custody.registry));
    const history = await import("./session-history.js");
    const readHistory = history.loadCliSessionHistoryMessages;
    const historyRead = vi
      .spyOn(history, "loadCliSessionHistoryMessages")
      .mockImplementation(async (params) => {
        if (engineAcquired) {
          throw historyFailure;
        }
        return await readHistory(params);
      });
    try {
      const { runCliAgent } = await import("../cli-runner.js");
      const { dir, sessionTarget } = fixture.session;
      await expect(
        withPluginRuntimeRegistryScope(custody.registry, () =>
          wrapRunWithTestPreparedAdmission(runCliAgent)({
            sessionId: sessionTarget.sessionId,
            sessionKey: sessionTarget.sessionKey,
            sessionTarget,
            sessionFile: sessionTarget.sessionKey,
            workspaceDir: dir,
            prompt: "synthetic question",
            provider: "test-cli",
            model: "test-model",
            runId: "cli-custody-history-failure",
            timeoutMs: 1_000,
            config: { plugins: { allow: ["fixture"], slots: { contextEngine: engineId } } },
          }),
        ),
      ).rejects.toBe(historyFailure);
      expect(factory).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(backendCleanup).toHaveBeenCalledOnce();
      await custody.resources.release();
      expect(custody.retired).toHaveBeenCalledOnce();
    } finally {
      historyRead.mockRestore();
      await custody.cleanup();
    }
  });

  it.each(["direct", "borrowed"] as const)(
    "retains %s CLI context-engine custody through queued turn maintenance",
    async (ownership) => {
      const custody = createContextEngineCustodyFixture();
      const engineId = `cli-maintenance-custody-${ownership}`;
      const maintenanceStarted = createDeferred();
      const maintenanceGate = createDeferred();
      const work = new AsyncWorkScope();
      const { sessionTarget } = fixture.session;
      const sessionKey = sessionTarget.sessionKey;
      const releaseForeground = await beginForegroundSessionMaintenance(sessionKey);
      let lease: Awaited<ReturnType<typeof createContextEngineLogicalTurnLease>> | undefined;
      class Engine extends LegacyContextEngine {
        override readonly info: ContextEngine["info"] = {
          id: engineId,
          name: "CLI maintenance custody fixture",
          turnMaintenanceMode: "background",
        };
        async maintain() {
          maintenanceStarted.resolve();
          await maintenanceGate.promise;
          expect(custody.read()).toBe(42);
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
        }
        async dispose() {
          expect(custody.read()).toBe(42);
        }
      }
      registerContextEngineInRegistry(
        custody.registry,
        engineId,
        () => new Engine(),
        "plugin:fixture",
      );
      try {
        const config = { plugins: { allow: ["fixture"], slots: { contextEngine: engineId } } };
        const context = await work.run(() =>
          withPluginRuntimeRegistryScope(custody.registry, async () => {
            if (ownership === "borrowed") {
              lease = await createContextEngineLogicalTurnLease({
                identity: { runId: "run-test", sessionId: sessionTarget.sessionId },
                config,
              });
            }
            return await fixture.prepare({
              config,
              sessionKey,
              contextEngineLogicalTurnLease: lease,
            });
          }),
        );
        await custody.resources.release();
        await finalizeCliContextEngineTurn({
          context,
          historyMessages: [],
          assistantText: "synthetic answer",
          output: { text: "synthetic answer" },
        });
        await context.preparedBackend.cleanup?.();
        expect(custody.retired).not.toHaveBeenCalled();
        await lease?.dispose();
        expect(custody.retired).not.toHaveBeenCalled();
        releaseForeground();
        await maintenanceStarted.promise;
        expect(custody.read()).toBe(42);
        maintenanceGate.resolve();
        await waitForSessionMaintenance(sessionKey);
        if (lease) {
          await custody.retirement;
        }
        await work.drain();
        expect(custody.retired).toHaveBeenCalledOnce();
        expect(() => custody.read()).toThrow();
      } finally {
        releaseForeground();
        maintenanceGate.resolve();
        await waitForSessionMaintenance(sessionKey);
        await lease?.dispose();
        if (lease) {
          await custody.retirement;
        }
        await work.drain();
        await custody.cleanup();
      }
    },
  );

  it.each(["cancelled", "retired", "lookup-failed"] as const)(
    "rechecks CLI ownership after a delayed media lookup is %s",
    async (scenario) => {
      const lookupStarted = createDeferred();
      const lookup = createDeferred<string | undefined>();
      const abort = new AbortController();
      let current = true;
      const engineId = `cli-media-lookup-${scenario}`;
      const factory = vi.fn((): ContextEngine => ({
        info: { id: engineId, name: "CLI media lookup" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
      }));
      await registerTestContextEngine(engineId, factory);
      const config = createCliBackendConfig({ bundleMcp: true });
      setCliRunnerPrepareTestDeps({
        getActiveMcpLoopbackRuntime: vi.fn(createLoopbackRuntime),
        resolveMcpLoopbackScopedTools: vi.fn(() => ({
          agentId: "main",
          tools: [
            {
              name: "image_generate",
              label: "image_generate",
              description: "image_generate",
              parameters: Type.Object({}),
              execute: vi.fn(),
            },
          ],
        })),
      });
      mockBuildMediaTaskRuntimeContext.mockImplementation(() => {
        lookupStarted.resolve();
        return lookup.promise;
      });
      const preparation = fixture.prepare({
        config: { ...config, plugins: { slots: { contextEngine: engineId } } },
        sessionKey: "agent:main:test",
        abortSignal: abort.signal,
        sourceReplyDeliveryMode: "message_tool_only",
        assertCurrent: () => {
          if (!current) {
            throw new Error("CLI owner retired");
          }
        },
      });
      const outcome = preparation.then(
        (context) => context.params,
        (error: unknown) => error,
      );
      await lookupStarted.promise;
      expect(factory).not.toHaveBeenCalled();
      if (scenario === "cancelled") {
        abort.abort(new Error("CLI lookup cancelled"));
      } else if (scenario === "retired") {
        current = false;
      }
      if (scenario === "lookup-failed") {
        lookup.reject(new Error("optional media lookup failed"));
        expect(await outcome).toMatchObject({
          prompt: expect.stringMatching(/^latest ask\n\nThis turn has no current conversation\./),
          transcriptPrompt: "latest ask",
        });
        expect(factory).toHaveBeenCalledOnce();
      } else {
        lookup.resolve("active image task");
        expect(await outcome).toEqual(
          new Error(scenario === "cancelled" ? "CLI lookup cancelled" : "CLI owner retired"),
        );
        expect(factory).not.toHaveBeenCalled();
      }
    },
  );

  it("invalidates a stable CLI binding when explicit message-target policy changes", async () => {
    const context = await fixture.prepare({
      sourceReplyDeliveryMode: "message_tool_only",
      requireExplicitMessageTarget: true,
      cliSessionBindingFacts: {
        sourceReplyDeliveryMode: "message_tool_only" as const,
        requireExplicitMessageTarget: true,
      },
      cliSessionBinding: {
        sessionId: "cli-session",
        messageToolPolicyHash: hashCliSessionText(
          JSON.stringify({
            sourceReplyDeliveryMode: "message_tool_only",
            requireExplicitMessageTarget: false,
          }),
        ),
      },
    });

    expect(context.messageToolPolicyHash).toBeDefined();
    expect(context.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "message-policy",
    });
  });

  it("reuses normal/event/normal CLI bindings for a subagent", async () => {
    const trigger = "event";
    const sessionKey = "agent:main:subagent:child";
    const cliSessionBindingFacts = { extraSystemPromptStatic: "" };
    const first = await fixture.prepare({ sessionKey, cliSessionBindingFacts });
    expect(first.params.requireExplicitMessageTarget).toBe(true);
    const binding = sessionBinding(first);
    const background = await fixture.prepare({
      sessionKey,
      cliSessionBindingFacts,
      trigger,
      requireExplicitMessageTarget: true,
      cliSessionBinding: binding,
    });
    const normal = await fixture.prepare({
      sessionKey,
      cliSessionBindingFacts,
      cliSessionBinding: binding,
    });
    expect(background.params.requireExplicitMessageTarget).toBe(true);
    expect(background.messageToolPolicyHash).toBe(first.messageToolPolicyHash);
    expect(background.reusableCliSession).toEqual({ mode: "reuse", sessionId: "cli-session" });
    expect(normal.reusableCliSession).toEqual({ mode: "reuse", sessionId: "cli-session" });
  });

  it.each([false, true])(
    "keeps agent bootstrap and layers only execution AGENTS (explicit root: %s)",
    async (explicitRoot) => {
      setCliRunnerPrepareTestDeps({ resolveBootstrapContextForRun: loadBootstrapContext });
      const { dir } = fixture.session;
      const executionDir = path.join(dir, "execution");
      const bootstrapDir = explicitRoot ? path.join(dir, "bootstrap-override") : dir;
      fs.mkdirSync(executionDir);
      fs.mkdirSync(bootstrapDir, { recursive: true });
      fs.writeFileSync(path.join(dir, "AGENTS.md"), "UNSELECTED-WORKSPACE");
      for (const [name, content] of Object.entries({
        "AGENTS.md": "CANONICAL-AGENT-RULE",
        "SOUL.md": "CANONICAL-SOUL-MARKER",
        "USER.md": "CANONICAL-USER-MARKER",
        "MEMORY.md": "CANONICAL-MEMORY-MARKER",
      })) {
        fs.writeFileSync(path.join(bootstrapDir, name), content);
      }
      fs.writeFileSync(path.join(executionDir, "AGENTS.md"), "EXECUTION-PROJECT-RULE");
      fs.writeFileSync(path.join(executionDir, "USER.md"), "EXECUTION-USER-MUST-NOT-OVERRIDE");
      fs.writeFileSync(path.join(executionDir, "MEMORY.md"), "EXECUTION-MEMORY-MUST-NOT-OVERRIDE");

      const context = await fixture.prepare({
        config: { agents: { defaults: { workspace: dir }, entries: { main: {} } } },
        sessionKey: "agent:main:main",
        workspaceDir: executionDir,
        cwd: executionDir,
        ...(explicitRoot ? { bootstrapWorkspaceDir: bootstrapDir } : {}),
      });

      expect(context.cwd).toBe(executionDir);
      expectText(
        context.systemPrompt,
        [
          "CANONICAL-AGENT-RULE",
          "CANONICAL-SOUL-MARKER",
          "CANONICAL-USER-MARKER",
          "CANONICAL-MEMORY-MARKER",
          "EXECUTION-PROJECT-RULE",
        ],
        [
          "EXECUTION-USER-MUST-NOT-OVERRIDE",
          "EXECUTION-MEMORY-MUST-NOT-OVERRIDE",
          "UNSELECTED-WORKSPACE",
        ],
      );

      expect(context.systemPromptReport.injectedWorkspaceFiles.at(-1)).toMatchObject({
        path: path.join(executionDir, "AGENTS.md"),
        origin: { kind: "execution-project", rootPath: executionDir },
      });
    },
  );

  it("uses canonical repository skills for a managed worktree", async () => {
    const { dir } = fixture.session;
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-task-"));
    const { canonicalDir, skillDir } = createCliRepositorySkillFixture(dir, taskDir, true);
    try {
      const context = await fixture.prepare({
        config: { agents: { defaults: { workspace: dir } } },
        workspaceDir: taskDir,
        cwd: taskDir,
        skillsSnapshot: undefined,
        sessionEntry: {
          sessionId: fixture.session.sessionTarget.sessionId,
          updatedAt: Date.now(),
          worktree: {
            id: "task",
            branch: "task",
            repoRoot: path.join(dir, "canonical"),
            canonicalWorkspaceDir: canonicalDir,
          },
        },
      });

      expect(context.cwd).toBe(taskDir);
      expectText(
        context.systemPrompt,
        [
          `Working directory: ${taskDir}`,
          "<name>task-proof</name>",
          path.join(skillDir, "SKILL.md"),
        ],
        [`Working directory: ${dir}`, "Worktree copy"],
      );
    } finally {
      fs.rmSync(taskDir, { recursive: true, force: true });
    }
  });

  it("keeps per-run helper session identities out of the reusable system prompt", async () => {
    const prepareRun = (runId: string, runtimeFactsInTurn?: true) =>
      fixture.prepare({
        runId,
        sessionId: runId,
        sessionKey: `agent:main:main:active-memory:${runId}`,
        messageChannel: "webchat",
        ...(runtimeFactsInTurn ? { runtimeFactsInTurn } : {}),
      });

    const first = await prepareRun("recall-a", true);
    const second = await prepareRun("recall-b", true);

    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(first.systemPrompt).not.toContain("Runtime: ");
    expect(first.params.prompt).toContain("session=agent:main:main:active-memory:recall-a");
    expect(second.params.prompt).toContain("session=agent:main:main:active-memory:recall-b");
    expect(second.params.prompt).toContain("channel=webchat");

    // Resumable turns keep Runtime facts in the prompt they share across turns.
    const resumable = await prepareRun("turn-c");
    expect(resumable.systemPrompt).toContain("session=agent:main:main:active-memory:turn-c");
    expect(resumable.params.prompt).not.toContain("Runtime: ");
  });

  it.each([
    ["group", "direct", "group"],
    [undefined, "channel", "channel"],
  ] as const)("uses current chat type %s before stored %s", async (chatType, stored, expected) => {
    const resolveBootstrapContextForRun = vi.fn(async () => ({
      bootstrapFiles: [],
      contextFiles: [],
    }));
    setCliRunnerPrepareTestDeps({ resolveBootstrapContextForRun });

    const context = await fixture.prepare({
      config: createBundledMessageToolConfig(),
      sessionKey: "agent:main:opaque:binding",
      chatType,
      sessionEntry: {
        sessionId: "stored-session",
        updatedAt: 0,
        chatType: stored,
      },
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expectCall(resolveBootstrapContextForRun, { chatType: expected });
    expect(context.systemPrompt).toContain(SHARED_CHAT_MESSAGE_TOOL_ETIQUETTE);
  });

  it("invalidates content drift when the backend cannot receive a resumed system prompt", async () => {
    const { dir } = fixture.session;
    const context = await fixture.prepare({
      extraSystemPrompt: "new stable prompt",
      extraSystemPromptStatic: "new stable prompt",
      cliSessionBinding: {
        sessionId: "cli-session",
        extraSystemPromptHash: hashCliSessionText("old stable prompt"),
        cwdHash: hashCliSessionText(dir),
      },
      config: createCliBackendConfig({ systemPromptWhen: "never" }),
    });

    expect(context.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "system-prompt",
    });
    expect(context.params.prompt).not.toContain(
      "OpenClaw resumed this CLI session after prompt content changed.",
    );
  });

  it("invalidates CLI session bindings when owner policy changes prompt tool scope", async () => {
    const getActiveMcpLoopbackRuntime = vi.fn(createLoopbackRuntime);
    const resolveMcpLoopbackScopedTools = vi.fn((scope: McpProjectionParams) => ({
      agentId: "main",
      tools: [
        createCliMcpTool("message", "Message", "Send a message"),
        ...(scope.context.senderIsOwner === false
          ? []
          : [createCliMcpTool("gateway", "Gateway", "Manage the gateway")]),
      ],
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      resolveMcpLoopbackScopedTools,
    });
    setRawCliBackendForPrepareTest(createNativeArgMcpBackend());
    const cliSessionBindingFacts = {
      extraSystemPromptStatic: "group:telegram:group:message_tool_only",
      sourceReplyDeliveryMode: "message_tool_only" as const,
    };
    const first = await fixture.prepare({
      sessionKey: "agent:main:telegram:group:chat123",
      prompt: "first ask",
      provider: "native-cli",
      extraSystemPrompt: "volatile owner turn",
      currentMessageId: "owner-message",
      senderIsOwner: true,
      cliSessionBindingFacts,
      config: createCliBackendConfig({ bundleMcp: true }),
    });
    const second = await fixture.prepare({
      sessionKey: "agent:main:telegram:group:chat123",
      prompt: "second ask",
      provider: "native-cli",
      extraSystemPrompt: "volatile non-owner turn",
      currentMessageId: "non-owner-message",
      senderIsOwner: false,
      cliSessionBindingFacts,
      cliSessionBinding: sessionBinding(first),
      config: createCliBackendConfig({ bundleMcp: true }),
    });

    expect(second.promptToolNamesHash).not.toBe(first.promptToolNamesHash);
    expect(second.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "prompt-tools",
    });
  });

  it("keeps media progress in private plugin turn context", async () => {
    const config = createCliBackendConfig({ bundleMcp: true });
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime: vi.fn(createLoopbackRuntime),
      resolveMcpLoopbackScopedTools: vi.fn(() => ({
        agentId: "main",
        tools: ["image_generate", "video_generate"].map((name) => ({
          name,
          label: name,
          description: name,
          parameters: Type.Object({}),
          execute: vi.fn(),
        })),
      })),
    });

    setCliBackendForPrepareTest({
      id: "test-cli",
      bundleMcp: true,
      prepareExecution: () => ({
        async *execute() {
          yield { type: "result" };
        },
      }),
    });

    const hookRunner = promptHook({
      systemPrompt: "hook system",
      prependSystemContext: "hook prepend system",
    });
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

    const prepareTurn = () =>
      fixture.prepare({
        sessionKey: "agent:main:test",
        trigger: "user",
        config,
        prompt: "latest ask",
        transcriptPrompt: "latest ask",
      });
    mockBuildMediaTaskRuntimeContext.mockResolvedValue(
      "## Media Generation Tasks\nimage task queued\nactive video task",
    );
    const first = await prepareTurn();
    mockBuildMediaTaskRuntimeContext.mockResolvedValue(
      "## Media Generation Tasks\nimage task running\nactive video task",
    );
    const second = await prepareTurn();

    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.systemPrompt).toBe(
      `${wrappedPluginSystemContext("hook prepend system")}\n\nhook system${SYSTEM_PROMPT_CACHE_BOUNDARY}\nCurrent model identity: test-cli/test-model. If asked what model you are, answer with this value for the current run.`,
    );
    const carrier = ["## Media Generation Tasks", "image task running", "active video task"].join(
      "\n",
    );
    expect(second.params.prompt).toBe("latest ask");
    expect(second.promptContext).toEqual({
      appendContext: expect.stringMatching(/^This turn has no current conversation\./),
    });
    expect(
      second.promptContext?.appendContext?.endsWith(`\n\n${labelRuntimeContextText(carrier)}`),
    ).toBe(true);
    expect(second.params.transcriptPrompt).toBe("latest ask");
    expect(second.contextEngineTurnPrompt).toBe("latest ask");
    expect(mockBuildMediaTaskRuntimeContext).toHaveBeenCalledWith({
      sessionKey: "agent:main:test",
      agentId: "main",
      capabilityToolNames: new Set(["image_generate", "video_generate"]),
      includeEmptySnapshots: true,
    });
  });

  registerCliMcpPreparationTests({
    getFixture: () => fixture,
    createConfig: () => createCliBackendConfig({ bundleMcp: true }),
  });

  it("uses loopback-scoped tools when building bundled MCP CLI prompts", async () => {
    const skillLibraryAuthoring: SkillLibraryAuthoringCapability = {
      target: "personal",
      defaultTarget: "workspace",
      multipleProfiles: true,
      bind: vi.fn(),
      invoke: vi.fn(),
    };
    const scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:worker:discord:group:ops",
      ownerAccountId: "default",
    } as const;
    registerTestMemoryPromptBuilder(({ availableTools }) =>
      availableTools.has("memory_search")
        ? ["## Memory Recall", `tools=${[...availableTools].toSorted().join(",")}`, ""]
        : [],
    );
    const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);
    const resolveMcpLoopbackScopedTools = vi.fn((_scope: McpProjectionParams) => ({
      agentId: "main",
      tools: [
        createCliMcpTool("memory_search", "Memory Search", "Search memory"),
        {
          name: "fake_web_tool",
          label: "Fake web tool",
          description: "Test network content capability",
          parameters: Type.Object({}, { additionalProperties: false }),
          resultContentSource: "network" as const,
          execute: vi.fn(async () => ({ content: [] })),
        },
      ],
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime: vi.fn(createLoopbackRuntime),
      mintMcpLoopbackClientGrant,
      resolveMcpLoopbackScopedTools,
    });
    setRawCliBackendForPrepareTest(createNativeArgMcpBackend());
    const run = { sessionKey: "main", agentId: "worker", provider: "native-cli" };
    const baseline = await fixture.prepare(run);
    const context = await fixture.prepare({
      ...run,
      runId: "run-test-loopback-prompt-tools",
      skillLibraryAuthoring,
      scheduledToolPolicy,
      cliSessionBinding: {
        sessionId: "cli-session",
        promptToolNamesHash: "old-tool-surface",
        mcpConfigHash: baseline.preparedBackend.mcpConfigHash,
        mcpResumeHash: baseline.preparedBackend.mcpResumeHash,
      },
    });
    const projected = expectDefined(
      resolveMcpLoopbackScopedTools.mock.calls.at(-1)?.[0],
      "projection",
    );
    const minted = mintMcpLoopbackClientGrant.mock.calls.at(-1)?.[0];
    expect(projected.context).toEqual(minted?.context);
    expect(projected.context.scheduledToolPolicy).toEqual(scheduledToolPolicy);
    expect(projected.skillLibraryAuthoring).toBe(skillLibraryAuthoring);
    expectCall(mintMcpLoopbackClientGrant, { skillLibraryAuthoring });
    expect(projected.context).not.toHaveProperty("skillWorkshop.libraryAuthoring");
    expect(context.resultContentSourceByToolName?.get("fake_web_tool")).toBe("network");
    expect(context.resultContentSourceByToolName?.get("memory_search")).toBeUndefined();
    expect(context.systemPrompt).toContain("## Memory Recall");
    expect(context.systemPrompt).toContain("tools=fake_web_tool,memory_search");
    expect(context.systemPromptReport.tools.entries.map((entry) => entry.name)).toEqual([
      "memory_search",
      "fake_web_tool",
    ]);
    expect(context.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "prompt-tools",
    });
  });

  it("fails bundled MCP preparation when the loopback runtime is unavailable", async () => {
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime: () => undefined,
      ensureMcpLoopbackServer: async () => {
        throw new Error("loopback unavailable");
      },
    });
    setRawCliBackendForPrepareTest(createNativeArgMcpBackend());
    await expect(
      fixture.prepare({ provider: "native-cli", sessionKey: "agent:main:test" }),
    ).rejects.toThrow(/loopback unavailable/);
  });

  it.each([
    {
      name: "host selection",
      observed: ["Read", "Bash", "Write"],
      selected: ["Read"],
      projected: ["Read"],
      capabilities: ["read"],
    },
    {
      name: "observed empty surface",
      observed: [],
      selected: undefined,
      projected: [],
      capabilities: [],
    },
  ])(
    "bounds native authority by $name",
    async ({ observed, selected, projected, capabilities }) => {
      const { capture, observe, projectNativeToolAuthority, captureNativeToolAuthority } =
        await prepareNativeAuthority(
          capabilities,
          selected === undefined
            ? {}
            : { cliToolAvailability: { native: selected, openClaw: ["message"] } },
        );
      capture.activate("native-capture", () => {});
      observe(observed);

      expect(projectNativeToolAuthority).toHaveBeenCalledExactlyOnceWith(projected);
      expect(captureNativeToolAuthority).toHaveBeenLastCalledWith(capabilities);
    },
  );

  it.each([
    {
      name: "missing runtime snapshot",
      tools: undefined,
      invalidProjection: false,
      error: "invalid tool list",
    },
    {
      name: "mixed runtime snapshot",
      tools: ["Read", 7],
      invalidProjection: false,
      error: "invalid tool list",
    },
    {
      name: "non-canonical backend projection",
      tools: ["Read", "Bash"],
      invalidProjection: true,
      error: 'non-canonical native capability "Bash"',
    },
  ])(
    "clears native authority before rejecting a $name",
    async ({ tools, invalidProjection, error }) => {
      const {
        capture,
        observe,
        mintMcpLoopbackClientGrant,
        projectNativeToolAuthority,
        captureNativeToolAuthority,
      } = await prepareNativeAuthority(["read"]);
      expect(
        mintMcpLoopbackClientGrant.mock.calls[0]?.[0]?.context.nativeCronCreatorToolAllowlist,
      ).toBeNull();
      expect(projectNativeToolAuthority).not.toHaveBeenCalled();
      expect(captureNativeToolAuthority).not.toHaveBeenCalled();
      capture.activate("native-capture", () => {});
      observe(["Read"]);
      expect(projectNativeToolAuthority).toHaveBeenCalledExactlyOnceWith(["Read"]);
      expect(captureNativeToolAuthority.mock.calls).toEqual([[null], [["read"]]]);
      projectNativeToolAuthority.mockClear();

      if (invalidProjection) {
        projectNativeToolAuthority.mockReturnValue(["Bash"]);
      }
      expect(() => observe(tools)).toThrow(error);
      expect(captureNativeToolAuthority).toHaveBeenLastCalledWith(null);
      if (invalidProjection) {
        expect(projectNativeToolAuthority).toHaveBeenCalledExactlyOnceWith(["Read", "Bash"]);
      } else {
        expect(projectNativeToolAuthority).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["unactivated", "stale"] as const)(
    "rejects native authority updates while capture is %s",
    async (state) => {
      const { capture, observe, projectNativeToolAuthority, captureNativeToolAuthority } =
        await prepareNativeAuthority(["read"]);
      if (state === "stale") {
        capture.activate("native-capture", () => {});
        observe(["Read"]);
        captureNativeToolAuthority.mockReturnValue(false);
        projectNativeToolAuthority.mockClear();
      }

      expect(() => observe(["Read", "Bash"])).toThrow("capture is no longer active");
      expect(projectNativeToolAuthority).not.toHaveBeenCalled();
    },
  );

  it("fails closed with upgrade guidance when a backend cannot enforce a runtime toolsAllow", async () => {
    const getActiveMcpLoopbackRuntime = vi.fn(createLoopbackRuntime);
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
    });

    const run = fixture.prepare({
      config: createCliBackendConfig({ bundleMcp: true }),
      toolsAllow: ["read", "web_search"],
    });
    await expect(run).rejects.toThrow(
      `CLI backend "test-cli" cannot enforce this run's tool cap. Upgrade its plugin and retry; if current, ask its maintainer to add exact-cap support. OpenClaw did not start the run.`,
    );

    expect(getActiveMcpLoopbackRuntime).not.toHaveBeenCalled();
  });

  it("materializes runtime toolsAllow for selectable backends without bundle MCP", async () => {
    const resolveExecutionArgs = vi.fn((context: { baseArgs: readonly string[] }) => [
      ...context.baseArgs,
    ]);
    const resolveMcpLoopbackPolicyTools = vi.fn((_scope: McpProjectionParams) => ({
      agentId: "main",
      tools: ["write", "apply_patch"].map((name) => ({ name })),
    }));
    setBackend({
      id: "selectable-cli",
      pluginId: "selectable-plugin",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "execution-args",
      resolveExecutionArgs,
    });
    setCliRunnerPrepareTestDeps({ resolveMcpLoopbackPolicyTools });

    const originalToolsAllow = ["write"];
    const context = await fixture.prepare({
      provider: "selectable-cli",
      sessionKey: "agent:main:main",
      modelProvider: "policy-provider",
      model: "policy-model",
      messageProvider: "telegram",
      senderId: "tools-owner",
      senderIsOwner: false,
      clientCaps: ["original-client"],
      toolsAllow: originalToolsAllow,
    });
    const bindQuestionAuthority = expectDefined(
      context.bindQuestionAnswerAuthority,
      "question authority",
    );
    const questionAuthority = bindQuestionAuthority(() => {});
    originalToolsAllow.push("exec");
    const caller = {
      messageProvider: "telegram",
      senderId: "tools-owner",
      senderIsOwner: false,
      disableTools: false,
      clientCaps: ["original-client"],
      toolsAllow: ["write"],
      traceAuthorized: false,
    };
    expect(context.params.toolsAllow).toBeUndefined();
    expect(() => questionAuthority.assertCaller(caller)).not.toThrow();
    expect(() => questionAuthority.assertCaller({ ...caller, toolsAllow: undefined })).toThrow(
      "caller policy",
    );
    expect(() => questionAuthority.assertCaller({ ...caller, clientCaps: [] })).toThrow(
      "caller policy",
    );

    expect(context.params.cliToolAvailability).toEqual({
      native: [],
      openClaw: ["write", "apply_patch"],
    });
    expectCall(resolveMcpLoopbackPolicyTools, {
      context: expect.objectContaining({ toolsAllow: ["write"] }),
    });
  });

  it.each([
    "direct-with-placeholder",
    "reply-owned",
    "creator-closed",
    "caller-retired",
    "request-cancelled",
    "retained-after-exit",
  ] as const)("binds prepared %s native questions to the actual CLI creator", async (mode) => {
    const config = { tools: { exec: { security: "full", ask: "off" } } } satisfies OpenClawConfig;
    const runId = `native-question-${mode}`;
    const admission = prepareSystemAgentRunAdmission(
      config,
      runId,
      "main",
      "native-question-proof",
    );
    const sourceAbort = new AbortController();
    const requestAbort = new AbortController();
    let callerCurrent = true;
    const promptDelivered = createDeferred();
    const nativeToolCallId = `native-input-${mode}`;
    const questionId = `${nativeToolCallId}:0`;
    const request = {
      toolName: "AskUserQuestion",
      toolCallId: nativeToolCallId,
      abortSignal: requestAbort.signal,
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Continue?",
          isOther: true,
          options: [{ label: "Continue" }, { label: "Stop" }],
        },
      ],
    };
    let retainedRequest: CliBackendExecuteContext["requestUserInput"] | undefined;
    let nativeAnswer: Awaited<ReturnType<CliBackendExecuteContext["requestUserInput"]>> | undefined;
    const execute: CliBackendExecute = async function* (execution) {
      retainedRequest = execution.requestUserInput;
      expect(execution.modelId).toBe("creator-model");
      if (mode !== "retained-after-exit") {
        nativeAnswer = await execution.requestUserInput(request);
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed",
        session_id: "native-session",
      };
    };
    setBackend({
      id: "native-question-cli",
      pluginId: "native-question-plugin",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "execution-args",
      resolveExecutionArgs: ({ baseArgs }) => [...baseArgs],
      prepareExecution: async () => ({ execute }),
      config: {
        command: "/bin/sh",
        args: [],
        input: "stdin",
        output: "jsonl",
        sessionMode: "existing",
      },
    });
    const { sessionTarget, sessionFile, dir } = fixture.session;
    const origin = {
      senderIsOwner: false,
      messageProvider: "telegram",
      senderId: "question-owner",
      clientCaps: ["creator-client"],
      approvalReviewerDeviceId: "creator-reviewer",
    };
    const caller = { ...origin, traceAuthorized: mode === "reply-owned" };
    const original = {
      ...origin,
      sessionId: sessionTarget.sessionId,
      sessionKey: sessionTarget.sessionKey,
      sessionFile,
      workspaceDir: dir,
      cwd: dir,
      agentId: "main",
      provider: "native-question-cli",
      modelProvider: "question-policy",
      model: "creator-model",
      config,
      cliToolAvailability: { native: ["AskUserQuestion"], openClaw: [] },
    };
    const sourceRoute = { provider: original.modelProvider, model: original.model };
    let sourceOperation: ReplyOperation | undefined;
    let answeringPlaceholder: ReplyOperation | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      if (mode === "reply-owned") {
        sourceOperation = createReplyOperation({
          sessionId: original.sessionId,
          sessionKey: original.sessionKey,
          resetTriggered: false,
        });
        await sourceOperation.bindToolAuthoritySnapshotAsync(
          prepareReplyToolAuthority({
            run: { ...original, provider: sourceRoute.provider, traceAuthorized: true },
          }),
        );
      }
      const toolAuthorityFingerprint =
        await sourceOperation?.bindToolAuthorityRouteAsync(sourceRoute);
      const context = await fixture.prepare({
        ...original,
        runId,
        timeoutMs: 10_000,
        preparedRunAdmission: admission,
        abortSignal: sourceAbort.signal,
        assertCurrent: () => {
          if (!callerCurrent) {
            throw new Error("original CLI caller retired");
          }
        },
        replyOperation: sourceOperation,
        toolAuthorityFingerprint,
        onPartialReply: async () => promptDelivered.resolve(),
      });
      cleanup = context.preparedBackend.cleanup;
      sourceOperation?.setPhase("running");
      const target = context.executionTarget;
      if (target.kind !== "plugin") {
        throw new Error("Expected the prepared native plugin execution target");
      }
      await withQuestionGateway(async (gateway) => {
        // This suite normally stubs runtime config; the shared peer owns the exact test port.
        getRuntimeConfigMock.mockImplementation(() =>
          expectDefined(getRuntimeConfigSnapshot(), "isolated question Gateway config"),
        );
        const processRun = executePluginOwnedProcess({
          context,
          execute: target.execute,
          executionCommand: "/bin/sh",
          executionArgs: [],
          env: { PATH: "/bin:/usr/bin" },
          prompt: context.params.prompt,
          useResume: false,
          noOutputTimeoutMs: 5_000,
          consumeStdout: () => {},
        });
        void processRun.catch(() => undefined);
        try {
          if (mode === "retained-after-exit") {
            await processRun;
            const invoke = expectDefined(retainedRequest, "retained native input callback");
            await expect(invoke(request)).resolves.toMatchObject({ status: "cancelled" });
            expect(gateway.requests).toHaveLength(0);
            return;
          }
          await Promise.race([
            promptDelivered.promise,
            processRun.then(() => {
              throw new Error("Native process ended before its question was presented");
            }),
          ]);
          if (mode === "direct-with-placeholder") {
            // A later answer can own a different next-turn model; it is not this question's creator.
            answeringPlaceholder = createReplyOperation({
              sessionId: original.sessionId,
              sessionKey: original.sessionKey,
              resetTriggered: false,
            });
            const nextRoute = { provider: "next-policy", model: "next-model" };
            await answeringPlaceholder.bindToolAuthoritySnapshotAsync(
              prepareReplyToolAuthority({
                run: { ...original, ...nextRoute, clientCaps: [] },
              }),
            );
            await answeringPlaceholder.bindToolAuthorityRouteAsync(nextRoute);
            expect(getSessionControllerOperation(original.sessionKey)).toBe(answeringPlaceholder);
          }
          const answer = (clientCaps = caller.clientCaps) =>
            claimPendingAgentQuestionAnswerFromCaller({
              sessionKey: original.sessionKey,
              text: "Continue",
              caller: { ...caller, disableTools: false, clientCaps },
              assertSourceCurrent: () => {},
            });
          const expectUnresolved = () =>
            expect(
              gateway.requests.filter((frame) => frame.method === "question.resolve"),
            ).toHaveLength(0);
          if (mode === "creator-closed") {
            admission.close();
            await expect(answer()).rejects.toThrow("no longer active");
            expectUnresolved();
            requestAbort.abort();
            await processRun;
            expect(nativeAnswer).toMatchObject({ status: "cancelled" });
          } else if (mode === "caller-retired") {
            callerCurrent = false;
            await expect(answer()).rejects.toThrow("original CLI caller retired");
            expectUnresolved();
            // A late Gateway answer cannot revive the retired native caller.
            gateway.manager.resolve(questionId, { answers: { choice: ["Continue"] } });
            await processRun;
            expect(nativeAnswer).toMatchObject({ status: "cancelled" });
            expect(sourceAbort.signal.aborted).toBe(false);
            expect(requestAbort.signal.aborted).toBe(false);
            expect(
              getAdmittedRunDelegatedAuthority(context.params.admittedRunContext),
            ).toBeDefined();
          } else if (mode === "request-cancelled") {
            requestAbort.abort();
            await processRun;
            expect(nativeAnswer).toMatchObject({ status: "cancelled" });
            await expect(answer()).resolves.toBe(false);
            await expect(gateway.manager.waitAnswer(questionId)).resolves.toMatchObject({
              status: "cancelled",
            });
          } else {
            await expect(answer([])).rejects.toThrow("caller policy");
            expectUnresolved();
            await expect(answer()).resolves.toBe(true);
            await processRun;
            expect(nativeAnswer).toEqual({ status: "answered", answers: { choice: ["Continue"] } });
            if (sourceOperation) {
              expect(sourceOperation.toolAuthorityRoute).toEqual(sourceRoute);
            }
          }
        } finally {
          requestAbort.abort();
          sourceAbort.abort();
          await processRun.catch(() => undefined);
        }
      });
    } finally {
      requestAbort.abort();
      sourceAbort.abort();
      answeringPlaceholder?.complete();
      sourceOperation?.complete();
      admission.close();
      await cleanup?.();
    }
  });

  it("preserves preparation refusal when cleanup fails", async () => {
    const cleanup = vi.fn(async () => {
      throw new Error("preparation cleanup failed");
    });
    const prepareExecution = vi.fn(async () => ({ cleanup }));
    setBackend({
      id: "settings-cli",
      pluginId: "settings-plugin",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "prepare-execution",
      prepareExecution,
    });

    const cleanupScope = createAgentCleanupScope();
    await expect(
      cleanupScope.run(() =>
        fixture.prepare({
          provider: "settings-cli",
          disableTools: true,
          oneShotCliRun: true,
        }),
      ),
    ).rejects.toThrow(
      "did not enforce exact per-run tool availability during execution preparation",
    );
    expectCall(prepareExecution, { toolAvailability: { native: [], openClaw: [] } });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanupScope.outcome).toBe("uncertain");
  });

  it.each(["selectable", "always-on"] as const)(
    "rejects disableTools before initializing MCP when a %s backend cannot disable native tools",
    async (nativeToolMode) => {
      const getActiveMcpLoopbackRuntime = vi.fn(() => ({
        port: 31783,
        ownerToken: "synthetic-loopback-owner",
        nonOwnerToken: "synthetic-loopback-non-owner",
      }));
      setCliRunnerPrepareTestDeps({ getActiveMcpLoopbackRuntime });
      setBackend({
        id: "native-cli",
        pluginId: "native-plugin",
        bundleMcp: true,
        bundleMcpMode: "codex-config-overrides",
        nativeToolMode,
      });

      await expect(
        fixture.prepare({
          provider: "native-cli",
          disableTools: true,
        }),
      ).rejects.toThrow(
        "CLI backend native-cli cannot run with tools disabled because it exposes native tools",
      );
      expect(getActiveMcpLoopbackRuntime).not.toHaveBeenCalled();
    },
  );

  it("privately forwards isolated-completion system prompts to bundled preparation", async () => {
    const { dir } = fixture.session;
    const prepareExecution = vi.fn(async () => ({
      isolatedCompletionEnforced: true as const,
      toolAvailabilityEnforced: true as const,
    }));
    setBackend({
      id: "google-gemini-cli",
      pluginId: "google",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "prepare-execution",
      prepareExecution,
      config: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
        output: "jsonl",
        input: "arg",
        sessionMode: "existing",
      },
    });

    await fixture.prepare({
      provider: "google-gemini-cli",
      executionMode: "side-question",
      isolatedCompletion: true,
      extraSystemPrompt: "Return only valid JSON.",
      cliToolAvailability: { native: [], openClaw: [] },
    });

    expectCall(prepareExecution, {
      isolatedCompletionCwd: dir,
      isolatedCompletionModelId: "test-model",
      isolatedCompletionPrompt: "latest ask",
      isolatedCompletionSystemPrompt: "Return only valid JSON.",
    });
  });

  it("rejects a CLI backend that does not adopt isolated completion", async () => {
    const cleanup = vi.fn(async () => {});
    const prepareExecution = vi.fn(async () => ({
      cleanup,
      toolAvailabilityEnforced: true as const,
    }));
    setBackend({
      id: "external-cli",
      pluginId: "external",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "prepare-execution",
      prepareExecution,
      config: {
        command: "external-cli",
        args: ["--print"],
        output: "jsonl",
        input: "stdin",
        sessionMode: "none",
      },
    });

    await expect(
      fixture.prepare({
        provider: "external-cli",
        executionMode: "side-question",
        isolatedCompletion: true,
        cliToolAvailability: { native: [], openClaw: [] },
      }),
    ).rejects.toMatchObject({
      code: "unsupported",
      message:
        'CLI backend "external-cli" does not support isolated completion; OpenClaw did not start the run.',
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("projects only the personal Workshop for node-placed Claude", async () => {
    const skillLibraryAuthoring: SkillLibraryAuthoringCapability = {
      target: "personal",
      defaultTarget: "workspace",
      multipleProfiles: true,
      bind: vi.fn(),
      invoke: vi.fn(),
    };
    const resolveMcpLoopbackScopedTools = vi.fn(() => ({
      agentId: "main",
      tools: [createCliMcpTool("skill_workshop", "Skill Workshop", "Manage skills")],
    }));
    setCliRunnerPrepareTestDeps({ resolveMcpLoopbackScopedTools });
    const prepareExecution = vi.fn(async () => ({ toolAvailabilityEnforced: true as const }));
    setBackend({
      id: "claude-cli",
      pluginId: "anthropic",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "prepare-execution",
      prepareExecution,
      config: createJsonlStdinBackendConfig("claude"),
    });

    const context = await fixture.prepare({
      provider: "claude-cli",
      sessionEntry: { execHost: "node", execNode: "node-a" } as never,
      cliToolAvailability: { native: ["Read"], openClaw: ["message", "skill_workshop"] },
      skillLibraryAuthoring,
    });

    expectCall(prepareExecution, {
      toolAvailability: { native: ["Read"], openClaw: ["skill_workshop"] },
    });
    expect(context.params.cliToolAvailability).toEqual({
      native: ["Read"],
      openClaw: ["skill_workshop"],
    });

    expectCall(resolveMcpLoopbackScopedTools, {
      skillLibraryAuthoring: { ...skillLibraryAuthoring, defaultTarget: "personal" },
    });
    expect(context.nodeSkillWorkshop?.name).toBe("skill_workshop");
    expect(context.systemPromptReport.tools.entries.map((tool) => tool.name)).toContain(
      "skill_workshop",
    );

    await context.preparedBackend.cleanup?.();
  });

  it.each([
    {
      name: "materializes exact availability when the caller did not provide it",
      cliToolAvailability: undefined,
      hookToolsAllow: ["read"],
      projectedToolNames: ["read", "message"],
    },
    {
      name: "keeps existing CLI availability as the upper bound",
      cliToolAvailability: { native: [], openClaw: ["read", "message"] },
      hookToolsAllow: ["read", "write"],
      projectedToolNames: ["read", "message", "write"],
    },
  ])(
    "applies before_prompt_build tool filtering before CLI guidance and submission: $name",
    async ({ cliToolAvailability, hookToolsAllow, projectedToolNames }) => {
      const prepareExecution = vi.fn(async () => ({ toolAvailabilityEnforced: true as const }));
      const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);
      const hookRunner = promptHook({ toolsAllow: hookToolsAllow });
      mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);
      setBackend({
        id: "claude-cli",
        pluginId: "anthropic",
        bundleMcp: true,
        bundleMcpMode: "claude-config-file",
        nativeToolMode: "selectable",
        toolAvailabilityEnforcement: "prepare-execution",
        prepareExecution,
        config: createJsonlStdinBackendConfig("claude"),
      });
      setCliRunnerPrepareTestDeps({
        getActiveMcpLoopbackRuntime: vi.fn(createLoopbackRuntime),
        mintMcpLoopbackClientGrant,
        resolveMcpLoopbackPolicyTools: vi.fn(() => ({
          agentId: "main",
          tools: projectedToolNames.map((name) => ({ name })),
        })),
        resolveMcpLoopbackScopedTools: vi.fn(() => ({
          agentId: "main",
          tools: projectedToolNames.map((name) => ({ name })),
        })),
      });
      const finalizePromptForResolvedTools = vi.fn(
        ({ prompt, messageToolAvailable }: { prompt: string; messageToolAvailable: boolean }) =>
          `${prompt}\nmessage-tool-available:${messageToolAvailable}`,
      );

      const context = await fixture.prepare({
        provider: "claude-cli",
        ...(cliToolAvailability ? { cliToolAvailability } : {}),
        finalizePromptForResolvedTools,
      });

      expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledTimes(1);
      expect(hookRunner.runBeforePromptBuild.mock.invocationCallOrder[0]).toBeLessThan(
        prepareExecution.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(context.params.cliToolAvailability).toEqual({
        native: [],
        openClaw: ["read"],
      });
      expectCall(prepareExecution, {
        toolAvailability: { native: [], openClaw: ["read"] },
      });
      expect(mintMcpLoopbackClientGrant.mock.calls[0]?.[0]?.context.toolsAllow).toEqual(["read"]);
      expect(context.systemPromptReport.tools.entries.map((entry) => entry.name)).toEqual(["read"]);
      expect(finalizePromptForResolvedTools).toHaveBeenCalledWith({
        prompt: "latest ask",
        messageToolAvailable: false,
      });
      expectText(
        context.params.prompt,
        [
          "message-tool-available:false",
          "This turn has no current conversation. Reply normally in your final assistant message",
        ],
        ["message(action=send)", "target required this turn"],
      );

      expect(context.params.transcriptPrompt).toBe("latest ask");
      await context.preparedBackend.cleanup?.();
    },
  );

  it("fails closed when a prompt hook restricts an always-on CLI backend", async () => {
    const hookRunner = promptHook({ toolsAllow: ["read"] });
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);
    setBackend({
      nativeToolMode: "always-on",
      config: createArgBackendConfig("test-cli"),
    });

    await expect(fixture.prepare({ provider: "test-cli" })).rejects.toThrow(
      'CLI backend "test-cli" cannot enforce before_prompt_build tool restrictions',
    );
  });

  it("preserves user MCP timeouts beside the generated Claude loopback", async () => {
    const userMcpConfigPath = path.join(fixture.session.dir, "user-mcp.json");
    fs.writeFileSync(
      userMcpConfigPath,
      JSON.stringify({
        mcpServers: {
          localUser: { type: "http", url: "http://127.0.0.1:43119/mcp", timeout: 12_345 },
        },
      }),
    );
    setBackend({
      id: "claude-cli",
      pluginId: "anthropic",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      config: {
        ...createJsonlStdinBackendConfig("claude"),
        args: ["--print", "--mcp-config", userMcpConfigPath],
        resumeArgs: ["--resume", "{sessionId}", "--mcp-config", userMcpConfigPath],
        jsonlDialect: "claude-stream-json",
      },
    });
    setCliRunnerPrepareTestDeps({ getActiveMcpLoopbackRuntime: vi.fn(createLoopbackRuntime) });
    const context = await fixture.prepare({
      provider: "claude-cli",
      sessionKey: "agent:main:main",
    });
    try {
      expect(context.managedMcpToolTimeoutMs).toBe(3_610_000);
      const args = context.preparedBackend.backend.args ?? [];
      const configPath = expectDefined(args[args.indexOf("--mcp-config") + 1], "merged MCP config");
      const readServers = () => JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers;
      expect(readServers()).toMatchObject({
        openclaw: { timeout: 3_610_000 },
        localUser: { timeout: 12_345 },
      });
      await prepareCliBundleMcpCaptureAttempt({
        preparedBackend: context.preparedBackend,
        captureKey: "attempt-timeout-proof",
      });
      expect(readServers()).toMatchObject({
        openclaw: {
          timeout: 3_610_000,
          headers: { "x-openclaw-cli-capture-key": "attempt-timeout-proof" },
        },
        localUser: { timeout: 12_345 },
      });
    } finally {
      await context.preparedBackend.cleanup?.();
    }
  });

  it("serves only the openclaw MCP server for ring-zero runs", async () => {
    const { dir, sessionFile, sessionTarget } = fixture.session;
    const getActiveMcpLoopbackRuntime = vi.fn(() => undefined);
    const resolveExecutionArgs = vi.fn(
      (context: {
        baseArgs: readonly string[];
        toolAvailability?: { native: readonly string[]; openClaw: readonly string[] };
      }) => [
        ...context.baseArgs,
        "--tools",
        context.toolAvailability?.native.join(",") ?? "default",
        "--allowedTools",
        context.toolAvailability?.openClaw.join(",") ?? "",
      ],
    );
    setCliRunnerPrepareTestDeps({ getActiveMcpLoopbackRuntime });
    setBackend({
      id: "claude-cli",
      pluginId: "anthropic",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "execution-args",
      resolveExecutionArgs,
      config: {
        command: "claude",
        args: ["--print"],
        resumeArgs: ["--print", "--resume", "{sessionId}"],
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        input: "stdin",
        sessionMode: "existing",
      },
    });

    const config = createCliBackendConfig();
    const runId = "run-test-openclaw-mcp";
    const admission = prepareSystemAgentRunAdmission(config, runId, "main", "cli-ring-zero-test");
    const params: RunCliAgentParams & { systemAgentTool: SystemAgentToolOptions } = {
      preparedRunAdmission: admission,
      sessionId: "session-test",
      sessionFile,
      sessionTarget,
      workspaceDir: dir,
      prompt: "latest ask",
      provider: "claude-cli",
      model: "test-model",
      timeoutMs: 1_000,
      runId,
      config,
      systemAgentTool: { surface: "cli" },
      cliToolAvailability: {
        native: [],
        openClaw: ["openclaw"],
      },
    };
    try {
      const context = await prepareCliRunContext(params);
      try {
        // Ring-zero runs never touch the loopback surface (no message tools).
        expect(getActiveMcpLoopbackRuntime).not.toHaveBeenCalled();
        expect(context.mcpDeliveryCapture).toBeUndefined();
        const args = context.preparedBackend.backend.args ?? [];
        expect(args).toContain("--strict-mcp-config");
        expect(args).not.toContain("--tools");
        expect(args).not.toContain("--allowedTools");
        expect(context.preparedBackend.backend.resumeArgs).toEqual(
          expect.arrayContaining(["--strict-mcp-config"]),
        );
        expect(resolveExecutionArgs).not.toHaveBeenCalled();
        expect(context.params.cliToolAvailability).toEqual({
          native: [],
          openClaw: ["openclaw"],
        });
        const mcpConfigPath = expectDefined(
          args[args.indexOf("--mcp-config") + 1],
          'args[args.indexOf("--mcp-config") + 1] test invariant',
        );
        const raw = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8")) as {
          mcpServers?: Record<string, { env?: Record<string, string> }>;
        };
        expect(Object.keys(raw.mcpServers ?? {})).toEqual(["openclaw"]);
        expect(raw.mcpServers?.openclaw?.env).toMatchObject({
          OPENCLAW_TOOLS_MCP_TOOLS: "openclaw",
          OPENCLAW_TOOLS_MCP_SYSTEM_AGENT_SURFACE: "cli",
        });
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    } finally {
      admission.close();
    }
  });

  it.each([
    ["orphaned", { mode: "invalidate", invalidatedReason: "orphaned-tool-use" }],
    ["auth-boundary", { mode: "invalidate", invalidatedReason: "auth-profile" }],
    ["native-control", { mode: "reuse", sessionId: "native-claude-session" }],
    ["sessions-disabled", { mode: "none" }],
  ] as const)("resolves the %s Claude session branch", async (scenario, expected) => {
    const controlOperation = scenario === "native-control" ? "compact" : undefined;
    const disabled = scenario === "sessions-disabled";
    const hasContent = !controlOperation && !disabled;
    const sessionId = controlOperation
      ? "native-claude-session"
      : disabled
        ? "stale-claude-sid"
        : "orphaned-claude-sid";
    if (controlOperation) {
      setActiveNodeContexts([{ nodeId: "active-mac" }]);
    }
    setCliBackendForPrepareTest({
      ...(disabled ? { sessionMode: "none" } : {}),
      reseedFromRawTranscriptWhenUncompacted: disabled,
    });
    const transcriptCheck = vi.fn(async () => hasContent);
    const orphanCheck = vi.fn(async () => !disabled);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
      claudeCliSessionTranscriptHasOrphanedToolUse: orphanCheck,
    });
    const context = await fixture.prepare({
      sessionKey: "agent:main:telegram:direct:peer",
      prompt: controlOperation ? "/compact" : "follow-up",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: {
        sessionId,
        ...(hasContent ? { cwdHash: hashCliSessionText(fixture.session.dir) } : {}),
        ...(scenario === "auth-boundary" ? { authProfileId: "anthropic:old-profile" } : {}),
      },
      cliSessionId: sessionId,
      controlOperation,
    });
    for (const check of [transcriptCheck, orphanCheck]) {
      if (scenario === "orphaned") {
        expect(check).toHaveBeenCalledWith({ sessionId, workspaceDir: fixture.session.dir });
      } else {
        expect(check).not.toHaveBeenCalled();
      }
    }
    expect(context.reusableCliSession).toEqual(expected);
    if (controlOperation) {
      expect(context.params.prompt).toBe("/compact");
      expect(context.systemPrompt).toBe("");
    }
  });

  it("keeps old-account history private after replacement and native-session clear", async () => {
    const account = "test:b";
    const { sessionTarget } = fixture.session;

    const agentDir = saveProfiles({
      "test:a": { type: "token", provider: "test-cli", token: "synthetic-account-a" },
      "test:b": { type: "token", provider: "test-cli", token: "synthetic-account-b" },
    });
    const inputs: string[] = [];
    let turn = 0;
    const execute: CliBackendExecute = async function* (execution) {
      inputs.push(execution.prompt);
      const sessionId = "native-" + ++turn;
      yield { type: "system", subtype: "init", session_id: sessionId };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed",
        session_id: sessionId,
      };
    };
    setBackend({
      authEpochMode: "profile-only",
      autoSelectAuthProfile: false,
      prepareExecution: async () => ({ execute }),
      parseJsonlEvent: (line) => {
        const event = JSON.parse(line);
        return event.type === "result"
          ? { kind: "result", text: event.result, sessionId: event.session_id }
          : null;
      },
      config: {
        ...createJsonlStdinBackendConfig("/bin/sh"),
        args: [],
        resumeArgs: ["--resume", "{sessionId}"],
        sessionIdFields: ["session_id"],
        reseedFromRawTranscriptWhenUncompacted: true,
      },
    });
    const runTurn = async (authProfileId: string, prompt: string) => {
      const entry = expectDefined(loadSessionEntryReadOnly(sessionTarget), "session");
      const binding = getCliSessionBinding(entry, "test-cli");
      const runId = "history-proof-" + turn;
      await patchSessionEntryCore(sessionTarget, (current) => ({
        ...current,
        activeWriterRunId: runId,
      }));
      const admission = prepareSystemAgentRunAdmission({}, runId, "main", "history-proof");
      try {
        const recorder = createUserTurnTranscriptRecorder({
          input: { text: prompt, idempotencyKey: runId },
          target: { ...sessionTarget, sessionEntry: loadSessionEntryReadOnly(sessionTarget) },
        });
        const context = await fixture.prepare({
          agentDir,
          authProfileId,
          prompt,
          runId,
          preparedRunAdmission: admission,
          userTurnTranscriptRecorder: recorder,
          persistAssistantTranscript: true,
          storePath: sessionTarget.storePath,
          expectedWriterRunId: runId,
          sessionKey: sessionTarget.sessionKey,
          cliSessionBinding: binding,
        });
        const { runPreparedCliAgent } = await import("../cli-runner.js");
        const result = await runPreparedCliAgent(context);
        expect(result.meta.agentMeta?.cliSessionBinding?.sessionId).toBeDefined();
        expect(context.effectiveAuthProfileId).toBe(authProfileId);
        expect(recorder.hasPersisted()).toBe(true);
        await patchSessionEntryCore(sessionTarget, (current) => {
          applyCliSessionBindingResult(current, "test-cli", result.meta.agentMeta);
          return current;
        });
      } finally {
        admission.close();
      }
    };
    await runTurn("test:a", "account A private history");
    await runTurn(account, "replacement turn");
    expect(inputs.at(-1)).not.toContain("account A private history");
    const entry = expectDefined(loadSessionEntryReadOnly(sessionTarget), "replacement");
    expect(getCliSessionBinding(entry, "test-cli")?.authProfileId).toBe(account);
    clearCliSession(entry, "test-cli");
    replaceSessionEntrySync(sessionTarget, entry);
    await runTurn(account, "recovery");
    expect(inputs.at(-1)).toContain("recovery");

    expect(inputs.at(-1)).not.toContain("account A private history");
  });

  it.each([false, true])(
    "recovers Claude history when native transcript is absent (live=%s)",
    async (live) => {
      await withAuthenticatedHistory("claude-cli", async (prepare) => {
        fixture.appendTranscript({
          id: "msg-1",
          parentId: null,
          timestamp: "2020-01-02T03:04:05.000Z",
          message: makeUserMessage("prior claude-cli ask", 1),
        });
        for (const [index, text] of [
          "Archive created at /tmp/example-backup.tar",
          "Upload failed: destination unavailable",
        ].entries()) {
          fixture.appendTranscript({
            id: `result-${index + 1}`,
            parentId: index === 0 ? "msg-1" : "result-1",
            timestamp: `2020-01-02T03:04:0${index + 6}.000Z`,
            message: {
              role: "toolResult",
              toolCallId: `call-${index + 1}`,
              toolName: "exec",
              isError: index === 1,
              content: [{ type: "text", text }],
              timestamp: index + 2,
            },
          });
        }
        setCliBackendForPrepareTest({
          liveSession: live,
          reseedFromRawTranscriptWhenUncompacted: true,
        });
        const orphanCheck = vi.fn(async () => live);
        setCliRunnerPrepareTestDeps({
          claudeCliSessionTranscriptHasContent: async () => false,
          claudeCliSessionTranscriptHasOrphanedToolUse: orphanCheck,
          ...(live ? { getCliLiveSessionGeneration: () => "warm-live-generation" } : {}),
        });

        const context = await prepare({
          sessionKey: "agent:main:telegram:direct:peer",
          provider: "claude-cli",
          model: "opus",
          cliSessionBinding: { sessionId: "stale-claude-sid" },
          cliSessionId: "stale-claude-sid",
        });

        expect(context.reusableCliSession).toEqual(
          live
            ? { mode: "reuse", sessionId: "stale-claude-sid" }
            : { mode: "invalidate", invalidatedReason: "missing-transcript" },
        );
        if (live) {
          expect(orphanCheck).not.toHaveBeenCalled();
          expect(context.params.agentId).toBe("main");
          expect(context.requiredClaudeLiveSessionGeneration).toBe("warm-live-generation");
          expect(context.openClawHistoryPrompt).toContain("latest ask");
        } else {
          expect(context.openClawHistoryPrompt).toMatch(
            /<next_user_message>\nlatest ask\n\nThis turn has no current conversation\.[\s\S]*\n<\/next_user_message>$/,
          );
        }
        expectText(context.openClawHistoryPrompt, [
          "User: prior claude-cli ask",
          "Tool result (exec): Archive created at /tmp/example-backup.tar",
          "Tool result (exec) [error]: Upload failed: destination unavailable",
        ]);

        expect(context.params.transcriptPrompt).toBe("latest ask");
      });
    },
  );

  it("prepares node-placed Claude resumes without Gateway MCP, skills, or transcript checks", async () => {
    fixture.appendTranscript({
      id: "msg-node-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "gateway-only history", timestamp: 1 },
    });
    const prepareExecution = vi.fn(async () => ({
      env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" },
      secretInput: {
        fd: 3,
        fingerprint: "selected-node-token-fingerprint",
        createData: () => Buffer.from("selected-node-token"),
      },
      clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    }));
    setCliBackendForPrepareTest({
      bundleMcp: true,
      liveSession: true,
      prepareExecution,
      reseedFromRawTranscriptWhenUncompacted: true,
    });
    const forbiddenGatewaySetup = vi.fn(() => {
      throw new Error("node placement must not perform Gateway setup");
    });
    setCliRunnerPrepareTestDeps({
      ensureMcpLoopbackServer: forbiddenGatewaySetup,
      prepareClaudeCliSkillsPlugin: forbiddenGatewaySetup,
      claudeCliSessionTranscriptHasContent: forbiddenGatewaySetup,
      claudeCliSessionTranscriptHasOrphanedToolUse: forbiddenGatewaySetup,
    });

    await expect(
      fixture.prepare({
        provider: "claude-cli",
        model: "opus",
        sessionEntry: { execHost: "node" } as never,
      }),
    ).rejects.toThrow("node-placed Claude CLI session is missing execNode");
    expect(forbiddenGatewaySetup).not.toHaveBeenCalled();

    const context = await fixture.prepare({
      sessionKey: "agent:main:catalog-adopt:claude:node",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: {
        sessionId: "node-source-session",
        forceReuse: true,
        forkNextResume: true,
      },
      cliSessionId: "node-source-session",
      sessionEntry: {
        execHost: "node",
        execNode: "node-a",
        execCwd: "/work/on-node",
      } as never,
      skillsSnapshot: {
        prompt: "GATEWAY_ONLY_SKILL_PATH=/tmp/gateway-skill/SKILL.md",
        skills: [],
        resolvedSkills: [],
      },
    });

    expect(context.reusableCliSession).toEqual({
      mode: "reuse",
      sessionId: "node-source-session",
    });
    // A borrowed native handle cannot authorize unverified durable history.
    expect(context.openClawHistoryPrompt).toBeUndefined();
    expect(context.claudeSkillsPluginArgs).toEqual([]);
    expect(context.systemPrompt).not.toContain("GATEWAY_ONLY_SKILL_PATH");
    expect(context.mcpDeliveryCapture).toBeUndefined();
    expect(forbiddenGatewaySetup).not.toHaveBeenCalled();
    expect(context.preparedBackend).toMatchObject({
      env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" },
      secretInput: { fingerprint: "selected-node-token-fingerprint" },
      backend: {
        clearEnv: expect.arrayContaining(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]),
      },
    });
  });

  it.each(["prepared", "admitted"] as const)(
    "stops CLI skill preparation before sandbox materialization when %s authority is revoked",
    async (phase) => {
      const { dir } = fixture.session;
      const skillDir = path.join(dir, "skills", "awaited-probe");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        '---\nname: awaited-probe\ndescription: Probe before sandbox setup\nmetadata: {"openclaw":{"requires":{"bins":["cli-preparation-fixture-tool"]}}}\n---\n',
      );
      const started = createDeferred();
      const release = createDeferred();
      const originalAccess = fs.promises.access;
      const access = vi.spyOn(fs.promises, "access").mockImplementation(async (file, mode) => {
        if (String(file).includes("cli-preparation-fixture-tool")) {
          started.resolve();
          await release.promise;
          throw new Error("fixture executable is absent");
        }
        return originalAccess(file, mode);
      });
      const revoked = new Error("skill preparation source revoked");
      let current = true;
      const admission = prepareAgentRunAdmission({
        cfg: {},
        facts: {
          runId: "cli-skills-revocation",
          agentId: "main",
          ingress: { kind: "system", boundary: "skills-test", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef("cli-skills-revocation"),
        assertSourceCurrent: () => {
          if (!current) {
            throw revoked;
          }
        },
      });
      try {
        const pending = fixture.prepare({
          runId: "cli-skills-revocation",
          skillsSnapshot: undefined,
          ...(phase === "prepared"
            ? { preparedRunAdmission: admission }
            : { admittedRunContext: await admission.admit("embedded") }),
          workspaceDir: dir,
          config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
        });
        const rejected = expect(pending).rejects.toThrow(/revoked|authority/);
        await started.promise;
        current = false;
        release.resolve();
        await rejected;
        expect(ensureSandboxWorkspaceForSessionMock).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        admission.close();
        access.mockRestore();
      }
    },
  );

  it("renders sandbox-readable CLI skills for the explicit global-session owner", async () => {
    const sessionKey = "global";
    const { dir } = fixture.session;
    const host = createWeatherSkillFixture(
      "/home/tzdai/.npm-global/lib/node_modules/openclaw",
      false,
    );
    const hostSkillPath = host.skillFilePath;
    const materializedWorkspace = path.join(dir, "state", "sandbox-skills");
    createWeatherSkillFixture(materializedWorkspace, true);
    ensureSandboxWorkspaceForSessionMock.mockResolvedValue({
      workspaceDir: dir,
      containerWorkdir: "/workspace",
      skillsWorkspaceDir: materializedWorkspace,
      workspaceAccess: "rw",
    });

    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, worker: {} } },
    };
    const skillsSnapshot: SkillSnapshot = host.snapshot;
    for (const skill of host.snapshot.resolvedSkills) {
      skill.source = "openclaw-bundled";
      Object.assign(skill.sourceInfo, { path: hostSkillPath, source: "openclaw-bundled" });
    }
    const context = await fixture.prepare({
      config,
      sessionKey,
      agentId: "main",
      prompt: "what is the forecast",
      skillsSnapshot,
    });

    expectCall(ensureSandboxWorkspaceForSessionMock, { agentId: "main", sessionKey });
    expect(context.systemPrompt).toContain(
      "/workspace/.openclaw/sandbox-skills/skills/weather/SKILL.md",
    );
    expect(context.systemPrompt).not.toContain(hostSkillPath);
  });

  it("lazily rebuilds an unsafe modern skills snapshot for a non-sandbox CLI run", async () => {
    const { dir } = fixture.session;
    for (const name of ["cold-skill", "healthy-skill"]) {
      const skillDir = path.join(dir, "skills", name);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n`,
        "utf-8",
      );
    }
    const snapshot = await buildSkillSnapshot(dir, {
      bundledSkillsDir: path.join(dir, "missing-bundled-skills"),
      managedSkillsDir: path.join(dir, "missing-managed-skills"),
    });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "skill:cold-skill",
        state: "unavailable",
        paths: ["skills.entries.cold-skill.apiKey"],
        refKeys: ["env:default:MISSING_SKILL_KEY"],
        reason: "secret provider failed",
      },
    ]);

    const context = await fixture.prepare({
      skillsSnapshot: {
        ...snapshot,
        prompt: `${snapshot.prompt}\n<available_skills></available_skills>`,
      },
    });

    expect(context.systemPrompt).not.toContain("cold-skill/SKILL.md");
    expect(context.systemPrompt).toContain("healthy-skill/SKILL.md");
  });

  it("isolates claimed native skills from later turns while cleaning each turn's MCP and auth", async () => {
    const { dir } = fixture.session;
    const skill = createWeatherSkillFixture(dir, true);
    const preparedExecutionCleanup = vi.fn(async () => undefined);
    const revokeMcpLoopbackClientGrant = vi.fn(() => true);
    setCliBackendForPrepareTest({
      id: "claude-cli",
      pluginId: "anthropic",
      bundleMcp: true,
      prepareExecution: async () => ({ cleanup: preparedExecutionCleanup }),
    });
    setCliRunnerPrepareTestDeps({
      prepareClaudeCliSkillsPlugin,
      getActiveMcpLoopbackRuntime: vi.fn(createLoopbackRuntime),
      revokeMcpLoopbackClientGrant,
    });

    const prepareTurn = (runId: string) =>
      fixture.prepare({
        provider: "claude-cli",
        model: "opus",
        skillsSnapshot: skill.snapshot,
        sessionKey: "agent:main:main",
        runId,
      });
    const context = await prepareTurn("native-skill-turn-one");
    const pluginDir = expectDefined(context.claudeSkillsPluginArgs[1], "materialized skill plugin");
    const skillPath = path.join(pluginDir, "skills", "weather", "SKILL.md");
    expect(fs.readFileSync(skillPath, "utf8")).toContain("Read forecast data before replying.");

    const releaseSkills = context.preparedBackend.claimLiveSessionResources?.();
    expect(releaseSkills).toEqual(expect.any(Function));
    expect(context.preparedBackend.claimLiveSessionResources?.()).toBeUndefined();
    try {
      await context.preparedBackend.cleanup?.();
      expect(fs.existsSync(skillPath)).toBe(true);
      expect(preparedExecutionCleanup).toHaveBeenCalledOnce();
      expect(revokeMcpLoopbackClientGrant).toHaveBeenCalledExactlyOnceWith("loopback-token");

      const nextTurn = await prepareTurn("native-skill-turn-two");
      const unusedPluginDir = nextTurn.claudeSkillsPluginArgs[1];
      expect(unusedPluginDir).toEqual(expect.any(String));
      expect(unusedPluginDir).not.toBe(pluginDir);
      expect(fs.existsSync(unusedPluginDir ?? "")).toBe(true);

      await nextTurn.preparedBackend.cleanup?.();
      expect(fs.existsSync(unusedPluginDir ?? "")).toBe(false);
      expect(fs.existsSync(skillPath)).toBe(true);
      expect(preparedExecutionCleanup).toHaveBeenCalledTimes(2);
      expect(revokeMcpLoopbackClientGrant).toHaveBeenCalledTimes(2);
    } finally {
      await releaseSkills?.();
    }
    expect(fs.existsSync(pluginDir)).toBe(false);
  });

  it.for(["empty", "raw", "compacted", "blocked", "cancelled", "foreign-maintenance"] as const)(
    "isolates %s caller memory through outer normalization and real CLI execution",
    (scenario, { signal }) =>
      fixture.run(async () => {
        const { dir, sessionTarget: fixtureTarget } = fixture.session;
        const sessionTarget = fixtureTarget;
        const durable = SessionManager.open(fixtureTarget, dir);
        const retained = durable.appendMessage(makeUserMessage("BORROWED_RETAINED", 1));
        durable.appendCompaction("BORROWED_SUMMARY", retained, 1000);
        durable.appendMessage({ role: "user", content: "BORROWED_TAIL", timestamp: 2 });
        durable.flushPendingPersistence();
        const eventsBefore = loadTranscriptEventsSync(fixtureTarget);
        const entryBefore = loadSessionEntryReadOnly(fixtureTarget);
        const sessionManager = SessionManager.inMemory(dir);
        if (scenario === "raw" || scenario === "compacted") {
          const kept = sessionManager.appendMessage(makeUserMessage("OWNED_RETAINED", 1));
          if (scenario === "compacted") {
            sessionManager.appendCompaction("OWNED_SUMMARY", kept, 1000);
          }
          sessionManager.appendMessage({ role: "user", content: "OWNED_TAIL", timestamp: 2 });
        }
        const memoryBefore = structuredClone(sessionManager.getEntries());
        const outgoing: CliBackendExecuteContext[] = [];
        const cleanup = vi.fn(async () => undefined);
        const abortController = new AbortController();
        const backend: CliBackendPlugin = {
          ...buildDefaultTestCliBackend(),
          subscriptionAuthDispatch: true,
          nativeToolMode: "selectable",
          toolAvailabilityEnforcement: "execution-args",
          resolveExecutionArgs: ({ baseArgs }) => [...baseArgs],
          autoSelectAuthProfile: false,
          config: {
            command: "/bin/echo",
            args: [],
            resumeArgs: ["--resume", "{sessionId}"],
            output: "jsonl",
            input: "stdin",
            sessionMode: "existing",
            reseedFromRawTranscriptWhenUncompacted: true,
          },
          prepareExecution: async () => ({
            cleanup,
            async *execute(input) {
              outgoing.push(input);
              if (scenario === "cancelled") {
                abortController.abort();
                throw new Error("synthetic cancellation");
              }
              yield {
                type: "result",
                subtype: "success",
                result: "owned answer",
                session_id: "native-owned",
              };
            },
          }),
        };
        const builder = installTestPluginRegistry();
        builder.registry.cliBackends.push({ backend, pluginId: "test-cli-plugin", source: "test" });
        setRawCliBackendForPrepareTest({ ...backend, pluginId: "test-cli-plugin" });
        const engineId = `cli-memory-${scenario}`;
        const bootstrap = vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => ({
          bootstrapped: true,
        }));
        const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => undefined);
        const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () => ({
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
        }));
        await registerTestContextEngine(engineId, () => ({
          info: { id: engineId, name: "Caller memory test" },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
          compact: async () => ({ ok: true, compacted: false }),
          bootstrap,
          afterTurn,
          maintain,
        }));
        signal.throwIfAborted();
        const runBeforePromptBuild = vi.fn(async (_event: { messages: unknown[] }) => undefined);
        const runBeforeAgentRun = vi.fn(async () =>
          scenario === "blocked"
            ? {
                decision: {
                  outcome: "block",
                  reason: "private synthetic reason",
                  message: "synthetic block",
                },
                pluginId: "owner-test",
              }
            : undefined,
        );
        mockGetGlobalHookRunner.mockReturnValue({
          hasHooks: (name: string) => name === "before_prompt_build" || name === "before_agent_run",
          runBeforePromptBuild,
          runBeforeAgentRun,
        } as never);
        const { runEmbeddedAgent: runEmbeddedAgentImpl } =
          await import("../embedded-agent-runner/run.js");
        signal.throwIfAborted();
        const runEmbeddedAgent = wrapRunWithTestPreparedAdmission(runEmbeddedAgentImpl);
        const runId = `memory-cli-${scenario}`;
        const maintenance = await import("../embedded-agent-runner/context-engine-maintenance.js");
        const coordinator = await import("../session-maintenance/coordinator.js");
        const releaseMaintenance = createDeferred();
        const maintenanceStarted = createDeferred();
        const borrowedWait = createDeferred();
        let maintenanceJoined: Promise<void> | undefined;
        let waitSpy: MockInstance<typeof coordinator.waitForSessionMaintenance> | undefined;
        if (scenario === "foreign-maintenance") {
          await maintenance.runContextEngineMaintenance({
            contextEngine: {
              info: {
                id: "foreign-maintenance",
                name: "Foreign durable maintenance",
                turnMaintenanceMode: "background",
              },
              ingest: async () => ({ ingested: true }),
              assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
              compact: async () => ({ ok: true, compacted: false }),
              maintain: async () => {
                maintenanceStarted.resolve();
                await releaseMaintenance.promise;
                return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
              },
            },
            sessionId: fixtureTarget.sessionId,
            sessionKey: fixtureTarget.sessionKey,
            sessionTarget: fixtureTarget,
            sessionFile: fixtureTarget.sessionKey,
            reason: "turn",
            config: {},
            onDeferredMaintenance: (promise) => {
              maintenanceJoined = promise;
            },
          });
          await maintenanceStarted.promise;
          const wait = coordinator.waitForSessionMaintenance;
          waitSpy = vi.spyOn(coordinator, "waitForSessionMaintenance").mockImplementation((key) => {
            borrowedWait.resolve();
            return wait(key);
          });
        }
        let run: ReturnType<typeof runEmbeddedAgent> | undefined;
        try {
          run = runEmbeddedAgent({
            sessionId: sessionTarget.sessionId,
            sessionKey: sessionTarget.sessionKey,
            sessionTarget: {
              ...sessionTarget,
              expectedLifecycleRevision: "borrowed-revision",
              expectedWriterRunId: "borrowed-writer",
            },
            sessionFile: sessionTarget.sessionKey,
            sessionManager,
            sessionPersistence: "detached",
            agentId: "main",
            workspaceDir: dir,
            config: { plugins: { slots: { contextEngine: engineId } } },
            prompt: "owned next ask",
            provider: "test-cli",
            model: "test-model",
            runId,
            timeoutMs: 1000,
            abortSignal: AbortSignal.any([abortController.signal, signal]),
            cliBackendDispatch: "subscription-auth",
            toolsAllow: ["read"],
          });
          if (scenario === "foreign-maintenance") {
            const outcome = await Promise.race([
              run.then(() => "completed"),
              borrowedWait.promise.then(() => "borrowed-wait"),
            ]);
            expect(outcome).toBe("completed");
            expect(waitSpy).not.toHaveBeenCalled();
          }
          if (scenario === "cancelled") {
            await expect(run).rejects.toThrow();
          } else {
            const result = await run;
            expect(result.payloads?.[0]?.text).toContain(
              scenario === "blocked" ? "synthetic block" : "owned answer",
            );
            expect(result.meta.agentMeta?.cliSessionBinding).toBeUndefined();
          }
          expect(cleanup).toHaveBeenCalledOnce();
          expect(runBeforePromptBuild).toHaveBeenCalledOnce();
          expect(JSON.stringify(runBeforePromptBuild.mock.calls)).not.toContain("BORROWED_");
          expect(loadTranscriptEventsSync(fixtureTarget)).toEqual(eventsBefore);
          expect(loadSessionEntryReadOnly(fixtureTarget)).toEqual(entryBefore);
          for (const input of [
            ...bootstrap.mock.calls.map(([event]) => event),
            ...afterTurn.mock.calls.map(([event]) => event),
            ...maintain.mock.calls.map(([event]) => event),
          ]) {
            expect(input.sessionTarget).toBeUndefined();
            expect(input.sessionFile).toBe(`in-memory:${sessionManager.getSessionId()}`);
            expect(input.runtimeContext?.sessionTarget).toBeUndefined();
          }
          if (scenario === "raw" || scenario === "compacted") {
            expect(bootstrap).toHaveBeenCalledOnce();
            const finalized = afterTurn.mock.calls[0]?.[0];
            expect(finalized?.prePromptMessageCount).toBe(scenario === "compacted" ? 3 : 2);
            expectText(
              JSON.stringify(finalized?.messages),
              ["OWNED_RETAINED", "OWNED_TAIL"],
              ["BORROWED_"],
            );
          } else {
            expect(bootstrap).not.toHaveBeenCalled();
          }
          if (scenario === "blocked") {
            expect(outgoing).toHaveLength(0);
            expectText(
              JSON.stringify(sessionManager.getEntries()),
              ["synthetic block"],
              ["private synthetic reason"],
            );
          } else {
            expect(outgoing).toHaveLength(1);
            expect(outgoing[0]?.prompt).not.toContain("BORROWED_");
            expect(outgoing[0]?.useResume).toBe(false);
            expect(sessionManager.getEntries()).toEqual(memoryBefore);
            if (scenario === "raw" || scenario === "compacted") {
              expectText(outgoing[0]?.prompt, [
                "OWNED_RETAINED",
                "OWNED_TAIL",
                ...(scenario === "compacted" ? ["OWNED_SUMMARY"] : []),
              ]);
            } else {
              expect(outgoing[0]?.prompt).toBe("owned next ask");
            }
          }
          if (scenario === "raw") {
            // System-agent callers deliberately retain their own native binding beside memory.
            const context = await fixture.prepare({
              sessionManager,
              cliSessionBinding: { sessionId: "native-owned", cwdHash: hashCliSessionText(dir) },
            });
            expect(context.openClawHistoryPrompt).toContain("OWNED_RETAINED");
            const { runPreparedCliAgent } = await import("../cli-runner.js");
            await withTestRunAdmission(context.params, (admittedRunContext) =>
              runPreparedCliAgent({
                ...context,
                params: { ...context.params, admittedRunContext },
              }),
            );
            expect(outgoing.at(-1)).toMatchObject({
              useResume: true,
              sessionId: "native-owned",
              prompt: "latest ask",
            });
            expect(sessionManager.getEntries()).toEqual(memoryBefore);
          }
        } finally {
          releaseMaintenance.resolve();
          await maintenanceJoined;
          await run?.catch(() => undefined);
          waitSpy?.mockRestore();
        }
      }),
  );

  it.each([
    {
      name: "uses the plan-safe Claude CLI cap before mapping canonical models to CLI aliases",
      provider: "claude-cli",
      model: "claude-opus-4-8",
      modelAliases: { "claude-opus-4-8": "opus" },
      marker: "RESEED_ALIAS_SUMMARY_MARKER_KEEP",
      padding: 40_000,
      expectsTruncation: false,
    },
    {
      name: "keeps the default reseed history cap for non-Claude CLI backends",
      provider: "test-cli",
      model: "test-model",
      marker: "RESEED_SUMMARY_MARKER_DEFAULT",
      padding: 20_000,
      expectsTruncation: true,
    },
  ])("$name", async (testCase) => {
    await withAuthenticatedHistory(testCase.provider, async (prepare) => {
      const { dir, sessionTarget } = fixture.session;
      if (testCase.provider === "claude-cli") {
        setCliBackendForPrepareTest({ modelAliases: testCase.modelAliases });
      }
      const manager = SessionManager.open(sessionTarget, dir);
      const firstKeptEntryId = manager.appendMessage(makeUserMessage("RESEED_RETAINED_PREFIX", 1));
      manager.appendCompaction(
        `${testCase.marker} ${"x".repeat(testCase.padding)}`,
        firstKeptEntryId,
        100_000,
      );
      manager.flushPendingPersistence();

      const context = await prepare({
        provider: testCase.provider,
        model: testCase.model,
      });

      expect(context.openClawHistoryPrompt).toBeDefined();
      expect(context.openClawHistoryPrompt).toContain("RESEED_RETAINED_PREFIX");
      if (testCase.expectsTruncation) {
        expect(context.openClawHistoryPrompt).toContain("OpenClaw reseed history truncated");
      } else {
        expect(context.openClawHistoryPrompt).toContain(testCase.marker);
        expect(context.openClawHistoryPrompt).not.toContain("OpenClaw reseed history truncated");
      }
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
