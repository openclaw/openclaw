// Covers agent harness selection, fallback behavior, and compaction routing.
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  listSessionPendingInputs,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import {
  claimHeartbeatOutcomeForRun,
  persistHeartbeatOutcome,
} from "../../infra/heartbeat-outcome-store.js";
import { createOpenClawCodingTools } from "../../plugin-sdk/agent-harness.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { mintSecretSentinel } from "../../secrets/sentinel.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder } from "../../trajectory/runtime.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { isHostScopedAgentToolActive } from "../agent-tools.ring-zero-context.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../auth-profiles/credential-fixtures.test-support.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "../embedded-agent-runner/model.generation-scope.test-support.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../embedded-agent-runner/run/types.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../embedded-agent-runner/runs.test-support.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { attachToolAllowlistIntersection } from "../tool-policy.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import type { SystemAgentToolOptions } from "../tools/system-agent-tool.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import { resolveAgentHarnessNativeToolPolicyRestricted } from "./execution-environment.js";
import { resolveAgentHarnessPolicy } from "./policy.js";
import {
  clearAgentHarnesses,
  getRegisteredAgentHarness,
  registerAgentHarness,
} from "./registry.js";
import { ensureSelectedAgentHarnessPlugin } from "./runtime-plugin.js";
import {
  resolveAvailableAgentHarnessPolicy,
  runAgentHarnessAttempt,
  runAgentHarnessSettledTurnFinalization,
  selectAgentHarness,
  selectAgentHarnessForPreparedModelProviders,
} from "./selection.js";
import {
  createHarnessAttemptParams,
  createHarnessCompactionFixture,
  privateHarnessParamCases,
  withOwnedHarnessGeneration,
} from "./selection.test-support.js";
import { buildAgentHarnessSupportContext } from "./support.js";
import type {
  AgentHarness,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
} from "./types.js";

type TestNativeCompactionParams = AgentHarnessCompactParams & {
  nativeCompactionRequest: "required_preflight" | "after_context_engine";
};

const agentRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
  createAttemptResult("openclaw"),
);
const compactAuthMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  getApiKeyForModelCore: vi.fn(),
  prepareAgentRuntimeAuth: vi.fn(),
  resolveModelAsync: vi.fn(),
}));
const providerOwnerMocks = vi.hoisted(() => ({
  resolveProviderRefOwnership: vi.fn(),
}));
const contextEngineTurnAttemptMocks = vi.hoisted(() => ({
  drainPendingContextEngineTurnsBeforeRun: vi.fn(async (_params: unknown) => {}),
}));
const builtInHarnesses = vi.hoisted(() => new WeakSet<object>());

function createTranscriptRecorder(
  admission: ReturnType<typeof createTranscriptAnchor> & {
    logicalTurnId: string;
    role: "user";
  },
): UserTurnTranscriptRecorder {
  const message = { role: "user" as const, content: "hello", timestamp: 1 };
  return {
    message,
    resolveMessage: async () => message,
    getAdmissionReceipt: () => admission,
    markRuntimePersistencePending: () => {},
    markRuntimePersisted: () => {},
    markBlocked: () => {},
    hasPersisted: () => true,
    isBlocked: () => false,
    hasRuntimePersistencePending: () => false,
    waitForRuntimePersistence: async () => {},
    persistApproved: async () => undefined,
    persistBlocked: async () => undefined,
    persistFallback: async () => undefined,
  };
}

vi.mock("./builtin-openclaw.js", () => ({
  createOpenClawAgentHarness: (): AgentHarness => {
    const harness: AgentHarness = {
      id: "openclaw",
      label: "OpenClaw embedded agent",
      contextEngineHostCapabilities: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.capabilities,
      supports: () => ({ supported: true, priority: 0 }),
      runAttempt: agentRunAttempt,
    };
    builtInHarnesses.add(harness);
    return harness;
  },
  isBuiltInOpenClawAgentHarness: (harness: AgentHarness) => builtInHarnesses.has(harness),
}));
vi.mock("../model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-auth.js")>()),
  applySecretRefHeaderSentinels: (model: unknown) => model,
  ensureAuthProfileStore: compactAuthMocks.ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles:
    compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles,
  getApiKeyForModelCore: compactAuthMocks.getApiKeyForModelCore,
}));
vi.mock("../embedded-agent-runner/model.js", () => ({
  resolveModelAsync: compactAuthMocks.resolveModelAsync,
}));
vi.mock("../runtime-plan/prepare-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-plan/prepare-auth.js")>();
  compactAuthMocks.prepareAgentRuntimeAuth.mockImplementation(actual.prepareAgentRuntimeAuth);
  return {
    ...actual,
    prepareAgentRuntimeAuth: compactAuthMocks.prepareAgentRuntimeAuth,
  };
});
vi.mock("../../plugins/providers.js", () => ({
  resolveProviderRefOwnership: providerOwnerMocks.resolveProviderRefOwnership,
}));
vi.mock("./context-engine-turn-attempt.js", () => ({
  drainPendingContextEngineTurnsBeforeRun:
    contextEngineTurnAttemptMocks.drainPendingContextEngineTurnsBeforeRun,
}));
vi.mock("../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

const originalRuntime = process.env.OPENCLAW_AGENT_RUNTIME;
const trajectoryTempDirs = createTempDirTracker();
let generationState: OpenClawTestState;
let selectionAdmission: PreparedAgentRunAdmission;
let selectionAdmittedRunContext: AdmittedRunContext;

beforeEach(async () => {
  generationState = await createOpenClawTestState({
    label: "harness-model-generation",
    applyEnv: false,
  });
  resetAgentRunRegistryForTest();
  resetModelGenerationFixtureState();
  selectionAdmission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: "run-1",
      agentId: "main",
      ingress: { kind: "system", boundary: "harness-selection-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef("run-1"),
  });
  selectionAdmittedRunContext = await selectionAdmission.admit(
    "plugin-harness",
    "harness-selection-test",
  );
  clearAgentHarnesses();
  compactAuthMocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
  compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
    createAuthProfileStoreFixture({}),
  );
  compactAuthMocks.resolveModelAsync.mockResolvedValue({
    model: { id: "gpt-5.5", provider: "openai" },
  });
  compactAuthMocks.getApiKeyForModelCore.mockResolvedValue({ apiKey: "test-key" });
  providerOwnerMocks.resolveProviderRefOwnership.mockReset();
  providerOwnerMocks.resolveProviderRefOwnership.mockReturnValue({ status: "unowned" });
  contextEngineTurnAttemptMocks.drainPendingContextEngineTurnsBeforeRun
    .mockReset()
    .mockResolvedValue(undefined);
  mockCallGatewayTool.mockReset();
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
      },
      {
        id: "google-gemini-cli",
        modelProvider: "google",
        pluginId: "google",
        config: { command: "gemini" },
      },
    ],
  });
});

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  vi.unstubAllEnvs();
  await closeStateDatabaseForTest();
  trajectoryTempDirs.cleanup();
  selectionAdmission.close();
  resetAgentRunRegistryForTest();
  clearAgentHarnesses();
  resetModelGenerationFixtureState();
  cliBackendsTesting.resetDepsForTest();
  agentRunAttempt.mockClear();
  compactAuthMocks.prepareAgentRuntimeAuth.mockClear();
  compactAuthMocks.resolveModelAsync.mockReset();
  compactAuthMocks.getApiKeyForModelCore.mockReset();
  compactAuthMocks.ensureAuthProfileStore.mockReset();
  compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReset();
  providerOwnerMocks.resolveProviderRefOwnership.mockReset();
  contextEngineTurnAttemptMocks.drainPendingContextEngineTurnsBeforeRun.mockReset();
  if (originalRuntime == null) {
    delete process.env.OPENCLAW_AGENT_RUNTIME;
  } else {
    process.env.OPENCLAW_AGENT_RUNTIME = originalRuntime;
  }
  await generationState.cleanup();
});

function createAttemptParams(config?: OpenClawConfig): EmbeddedRunAttemptParams {
  return createHarnessAttemptParams(selectionAdmittedRunContext, config);
}

function createAttemptResult(sessionIdUsed: string): EmbeddedRunAttemptResult {
  return {
    terminal: { kind: "ok" },
    sessionIdUsed,
    messagesSnapshot: [],
    assistantTexts: [`${sessionIdUsed} ok`],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}

function createTranscriptAnchor(
  entryId: string,
  rawSeq: number,
  activeMessagePosition: number,
): TranscriptEntryAnchor {
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    storePath: "/tmp/openclaw-agent.sqlite",
    generation: "generation-1",
    entryId,
    effectiveParentId: rawSeq === 1 ? null : "user-1",
    rawSeq,
    activeMessagePosition,
  };
}

function createFinalAssistant(): NonNullable<EmbeddedRunAttemptResult["lastAssistant"]> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "final answer" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: createZeroUsageFixture(),
    stopReason: "stop",
    timestamp: 0,
  };
}

function createContextEngineRequiringAssembly(): ContextEngine {
  // Selection tests use this to prove fallback cannot cross into a harness
  // that lacks required context-engine host capabilities.
  return {
    info: {
      id: "lossless-claw",
      name: "Lossless",
      hostRequirements: {
        "agent-run": {
          requiredCapabilities: ["assemble-before-prompt"],
        },
      },
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  };
}

function registerHarness(overrides: Partial<AgentHarness> = {}) {
  const id = overrides.id ?? "codex";
  const harness: AgentHarness = {
    id,
    label: id,
    supports: () => ({ supported: true, priority: 100 }),
    runAttempt: async () => createAttemptResult(id),
    ...overrides,
  };
  registerAgentHarness(harness, { ownerPluginId: id });
  return harness;
}

function registerFailingCodexHarness(): void {
  // Forces the selected plugin runtime to throw so fallback behavior is
  // exercised through runAgentHarnessAttempt, not only selectAgentHarness.
  registerAgentHarness(
    {
      id: "codex",
      label: "Failing Codex",
      supports: (ctx) =>
        ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: vi.fn(async () => {
        throw new Error("codex startup failed");
      }),
    },
    { ownerPluginId: "codex" },
  );
}

function registerSuccessfulCodexHarness(): void {
  registerHarness({
    supports: (ctx) =>
      ctx.provider === "codex" || ctx.provider === "openai"
        ? { supported: true, priority: 100 }
        : { supported: false },
    runAttempt: vi.fn(async () => createAttemptResult("codex")),
  });
}

function groupSenderDenyAllConfig(): OpenClawConfig {
  // Mirrors Telegram sender policy shape used when selection must preserve
  // channel/group sender tool constraints across fallback attempts.
  return {
    channels: {
      telegram: {
        groups: {
          "test-deny-room": {
            toolsBySender: {
              "id:test-denied-sender": { deny: ["*"] },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function groupDenyAllConfig(): OpenClawConfig {
  return {
    channels: {
      telegram: {
        groups: {
          "test-deny-room": {
            tools: { deny: ["*"] },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function providerRuntimeConfig(provider: string, runtime: string): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://api.openai.com/v1",
          agentRuntime: { id: runtime },
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}

function agentModelRuntimeConfig(
  modelRef: string,
  runtime: string,
  agentId?: string,
): OpenClawConfig {
  if (agentId) {
    return {
      agents: {
        entries: {
          main: {},
          [agentId]: { models: { [modelRef]: { agentRuntime: { id: runtime } } } },
        },
      },
    } as OpenClawConfig;
  }
  return {
    agents: {
      defaults: {
        models: {
          [modelRef]: { agentRuntime: { id: runtime } },
        },
      },
    },
  } as OpenClawConfig;
}

const maybeCompactAgentHarnessSession = createHarnessCompactionFixture(() => ({
  state: generationState,
  admittedRunContext: selectionAdmittedRunContext,
}));

type CompactSessionParams = Parameters<typeof maybeCompactAgentHarnessSession>[0];

const OPENAI_PLATFORM_ROUTE = {
  provider: "openai",
  modelId: "gpt-5.5",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
} as const;

const OPENAI_CHATGPT_ROUTE = {
  provider: "openai",
  modelId: "gpt-5.5",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
} as const;

function compactSession(
  overrides: Partial<CompactSessionParams> = {},
  options: Parameters<typeof maybeCompactAgentHarnessSession>[1] = {},
) {
  return maybeCompactAgentHarnessSession(
    {
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-5.5",
      ...overrides,
    },
    options,
  );
}

function registerTestCompactor(
  options: {
    id?: string;
    provider?: string;
    authBootstrap?: AgentHarness["authBootstrap"];
    supports?: AgentHarness["supports"];
    result?: AgentHarnessCompactResult;
  } = {},
) {
  const id = options.id ?? "codex";
  const provider = options.provider ?? "openai";
  const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(
    async () => options.result ?? { ok: true, compacted: false },
  );
  registerAgentHarness(
    {
      id,
      label: id,
      supports:
        options.supports ??
        ((ctx) =>
          ctx.provider === provider ? { supported: true, priority: 100 } : { supported: false }),
      runAttempt: vi.fn(async () => createAttemptResult(id)),
      compact,
      ...(options.authBootstrap ? { authBootstrap: options.authBootstrap } : {}),
    },
    { ownerPluginId: id },
  );
  return compact;
}

describe("runAgentHarnessAttempt", () => {
  it("carries silent heartbeat outcome into the plugin host boundary exactly once per retry", async () => {
    const harnessId = "codex";
    const root = trajectoryTempDirs.make("harness-heartbeat-outcome-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const target = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: path.join(root, "agent.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await persistHeartbeatOutcome({
      ...target,
      runSessionKey: "agent:main:main:heartbeat",
      occurredAt: 1,
      response: { outcome: "done", notify: false, summary: "ISOLATED_OUTCOME_731" },
    });
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("native"));
    registerHarness({ runAttempt });
    const currentInboundContext = {
      text: "Current quoted reply",
      resumableText: "Current room delta",
      promptJoiner: "\n" as const,
      fragments: [{ kind: "conversation-data" as const, text: "Current quoted reply" }],
    };
    const params = {
      ...createAttemptParams(),
      ...target,
      sessionTarget: target,
      trigger: "user" as const,
      agentHarnessId: harnessId,
      currentInboundContext,
    };
    for (let retry = 0; retry < 2; retry++) {
      await runAgentHarnessAttempt(params);
      const received = runAttempt.mock.calls.at(-1)?.[0];
      expect(received?.currentInboundContext?.text.match(/ISOLATED_OUTCOME_731/g)).toHaveLength(1);
      expect(
        received?.currentInboundContext?.resumableText?.match(/ISOLATED_OUTCOME_731/g),
      ).toHaveLength(1);
      expect(received?.currentInboundContext?.promptJoiner).toBe("\n");
      const fragments = received?.currentInboundContext?.fragments;
      expect(fragments).toEqual([
        ...currentInboundContext.fragments,
        { kind: "heartbeat-outcome", text: expect.stringContaining("ISOLATED_OUTCOME_731") },
      ]);
      expect(JSON.stringify(fragments)).toContain("ISOLATED_OUTCOME_731");
      expect(received?.prompt).toBe("hello");
      expect(params.currentInboundContext).toEqual(currentInboundContext);
      expect(currentInboundContext.text).toBe("Current quoted reply");
    }
    expect(JSON.stringify(await loadTranscriptEvents(target))).not.toContain(
      "ISOLATED_OUTCOME_731",
    );
    expect(
      await claimHeartbeatOutcomeForRun({ ...target, runId: "later-user-run" }),
    ).toBeUndefined();
  });

  it("does not consume silent heartbeat context for an aborted host attempt", async () => {
    const root = trajectoryTempDirs.make("harness-heartbeat-control-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const target = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: path.join(root, "agent.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await persistHeartbeatOutcome({
      ...target,
      runSessionKey: "agent:main:main:heartbeat",
      occurredAt: 1,
      response: { outcome: "done", notify: false, summary: "Retained outcome" },
    });
    const params = {
      ...createAttemptParams(),
      ...target,
      sessionTarget: target,
      trigger: "user" as const,
      abortSignal: AbortSignal.abort(),
    };
    await expect(runAgentHarnessAttempt(params)).rejects.toThrow();
    expect((await claimHeartbeatOutcomeForRun({ ...target, runId: "next-user" }))?.summary).toBe(
      "Retained outcome",
    );
  });

  it.each(["workspace", "explicit cwd"] as const)(
    "binds native provenance to staged input before dispatch and preserves it on a suppressed retry (%s)",
    async (directorySource) => {
      const root = trajectoryTempDirs.make("openclaw-harness-staged-annotation-");
      const workspaceDir = path.join(root, "workspace");
      const cwd = directorySource === "explicit cwd" ? path.join(root, "worktree") : undefined;
      const target = {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
      };
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        activeWriterRunId: "run-1",
      });
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "hello", idempotencyKey: "run-1:user", timestamp: 1 },
        target: { ...target, sessionEntry: undefined },
      });
      expect(await recorder.stageApproved?.({ runId: "run-1", assertCurrent: () => {} })).toBe(
        true,
      );
      expect(recorder.getAdmissionReceipt()).toBeUndefined();
      const annotation = {
        mirrorIdentity: "native-turn:prompt",
        upstreamUserText: "native prompt",
        mirrorOrigin: "native-harness",
        mirrorSourceFingerprint: sha256HexPrefixCore(
          JSON.stringify({ role: "user", content: "hello", upstreamUserText: "native prompt" }),
          32,
        ),
      };
      registerAgentHarness(
        {
          id: "native",
          label: "Native",
          supports: () => ({ supported: true, priority: 100 }),
          runAttempt: async (attempt) => {
            expect((await loadTranscriptEvents(target))[0]).toMatchObject({
              type: "session",
              cwd: cwd ?? workspaceDir,
            });
            if (attempt.suppressNextUserMessagePersistence) {
              expect(attempt.hostCapabilities?.annotateCurrentUserTurn).toBeUndefined();
            } else {
              const annotate = attempt.hostCapabilities?.annotateCurrentUserTurn;
              expect(annotate).toBeTypeOf("function");
              await annotate?.(annotation);
            }
            return createAttemptResult(target.sessionId);
          },
        },
        { ownerPluginId: "native" },
      );
      const params = {
        ...createAttemptParams(providerRuntimeConfig("codex", "native")),
        ...target,
        workspaceDir,
        cwd,
        sessionTarget: target,
        userTurnTranscriptRecorder: recorder,
      };
      try {
        await recorder.withPendingInput?.(() => runAgentHarnessAttempt(params));
        const admission = recorder.getAdmissionReceipt();
        expect(admission).toBeDefined();
        const committed = await loadTranscriptEvents(target);
        expect(
          committed.filter((event) => asOptionalRecord(event)?.type === "message"),
        ).toHaveLength(1);
        expect(committed).toContainEqual(
          expect.objectContaining({
            id: admission?.entryId,
            message: expect.objectContaining({
              role: "user",
              content: "hello",
              idempotencyKey: "run-1:user",
              __openclaw: expect.objectContaining({ ...annotation, runId: "run-1" }),
            }),
          }),
        );
        expect(await listSessionPendingInputs(target)).toEqual({ items: [], total: 0 });
        await runAgentHarnessAttempt({ ...params, suppressNextUserMessagePersistence: true });
        expect(await loadTranscriptEvents(target)).toEqual(committed);
      } finally {
        recorder.finishPendingInput?.("interrupted");
      }
    },
  );

  it("uses registry ownership rather than declared harness metadata for approvals", async () => {
    let observedApprovalOwner: string | undefined;
    mockCallGatewayTool.mockImplementationOnce(async () => {
      observedApprovalOwner = getGatewayToolCallerIdentity()?.approvalOwnerPluginId;
      return undefined;
    });
    registerAgentHarness(
      {
        id: "spoofed",
        label: "Spoofed",
        pluginId: "codex",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: async (attempt) => {
          await attempt.hostCapabilities?.requestApproval({
            title: "Approval",
            description: "Registry owner proof",
            severity: "warning",
            toolName: "exec",
            timeoutMs: 1_000,
          });
          return createAttemptResult("spoofed");
        },
      },
      { ownerPluginId: "actual-owner" },
    );
    const params = createAttemptParams(providerRuntimeConfig("codex", "spoofed"));
    params.agentId = "main";
    params.sessionKey = "agent:main:session-1";

    await runAgentHarnessAttempt(params);

    expect(observedApprovalOwner).toBe("actual-owner");
  });

  it.each(["declared", "missing", "expanded"] as const)(
    "limits selected harness Full authority to its captured node commands (%s)",
    async (descriptor) => {
      const root = trajectoryTempDirs.make("openclaw-harness-node-authority-");
      const sessionTarget = {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
      };
      await replaceSessionEntry(sessionTarget, {
        sessionId: sessionTarget.sessionId,
        updatedAt: 10,
        permissionMode: "full",
      });
      const workspace = {
        workspaceDir: path.join(root, "workspace"),
        sessionId: sessionTarget.sessionId,
        sessionKey: sessionTarget.sessionKey,
        environmentId: "environment-1",
        ownerEpoch: 1,
      };
      const launchCommand = "fixture.exec.launch";
      const unrelatedCommand = "fixture.maintenance.apply";
      const requiredNodeCommands = [launchCommand];
      const command = descriptor === "expanded" ? unrelatedCommand : launchCommand;
      const effect = vi.fn(async (assertCurrent: () => void) => {
        assertCurrent();
        return "launched";
      });
      registerAgentHarness(
        {
          id: "node-harness",
          label: "Node harness",
          cloudPlacement: {
            mode: "remote-exec",
            ...(descriptor !== "missing"
              ? { devicePlacement: { requiredNodeCommands, consumesWorkerSlot: false } }
              : {}),
          },
          supports: () => ({ supported: true, priority: 100 }),
          runAttempt: async () => {
            const invoke = getPluginRuntimeGatewayRequestScope()?.invokeWithSessionNodeAuthority;
            if (!invoke) {
              throw new Error("Expected the selected harness's admitted node invocation scope");
            }
            // Plugin initialization cannot widen the descriptor captured before its handoff.
            if (descriptor === "expanded") {
              requiredNodeCommands.push(unrelatedCommand);
            }
            const result = await invoke(
              { source: "session-full", pluginId: "fixture", nodeId: "node-1", command, workspace },
              effect,
            );
            expect(result).toBe(descriptor === "declared" ? "launched" : undefined);
            return createAttemptResult("node-harness");
          },
        },
        { ownerPluginId: "fixture" },
      );
      const registry = getActivePluginRegistry();
      if (!registry) {
        throw new Error("Expected the registered harness's plugin registry");
      }
      const record = createPluginRecord({
        id: "fixture",
        source: "fixture",
        origin: "bundled",
        enabled: true,
        configSchema: true,
      });
      registry.plugins.push(record);
      const context = {} as GatewayRequestContext;
      bindGatewayContextResolver(selectionAdmittedRunContext, () => context);
      try {
        const params = createAttemptParams(providerRuntimeConfig("codex", "node-harness"));
        params.agentId = sessionTarget.agentId;
        params.sessionKey = sessionTarget.sessionKey;
        params.sessionTarget = sessionTarget;
        params.permissionMode = "full";
        await withPluginRuntimeGatewayRequestScope(
          {
            isWebchatConnect: () => false,
            assertNodeExecutionCurrent: (request) => {
              expect(request).toMatchObject({
                runId: params.runId,
                agentId: sessionTarget.agentId,
                nodeId: "node-1",
                workspace,
              });
            },
          },
          () => runAgentHarnessAttempt(params),
        );
        expect(effect).toHaveBeenCalledTimes(descriptor === "declared" ? 1 : 0);
      } finally {
        clearGatewayContextResolver(selectionAdmittedRunContext);
        registry.plugins.splice(registry.plugins.indexOf(record), 1);
      }
    },
  );

  it("routes settled turns through an explicit finalizer without private state", async () => {
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("run"));
    let hostAuthorityActive = true;
    const finalizeSettledTurn = vi.fn<NonNullable<AgentHarness["finalizeSettledTurn"]>>(
      async ({ attempt, settledAttempt: _settledAttempt }) => {
        hostAuthorityActive = isHostScopedAgentToolActive("openclaw");
        expect(attempt.operation).toBe("settled-tool-finalization");
        expect(attempt).not.toHaveProperty("hostCapabilities");
        for (const { field } of privateHarnessParamCases) {
          expect(attempt).not.toHaveProperty(field);
        }
        return {
          assistant: createFinalAssistant(),
        };
      },
    );
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt,
      finalizeSettledTurn,
    };
    registerAgentHarness(harness, { ownerPluginId: "codex" });
    const params = Object.assign(
      createAttemptParams(providerRuntimeConfig("codex", "codex")),
      Object.fromEntries(privateHarnessParamCases.map(({ field, value }) => [field, value])),
    );
    const settledAttempt = createAttemptResult("settled");

    await expect(
      runAgentHarnessSettledTurnFinalization(params, settledAttempt, harness),
    ).resolves.toMatchObject({
      outcome: "answered",
      result: {
        assistant: { content: [{ type: "text", text: "final answer" }] },
      },
    });
    expect(runAttempt).not.toHaveBeenCalled();
    expect(hostAuthorityActive).toBe(false);
    for (const { field, value } of privateHarnessParamCases) {
      expect(params).toHaveProperty(field, value);
    }
    expect(finalizeSettledTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        settledAttempt,
        attempt: expect.objectContaining({ provider: "codex" }),
      }),
    );
  });

  it("fails closed when the selected harness has no settled-turn finalizer", async () => {
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: async () => createAttemptResult("run"),
    };
    registerAgentHarness(harness, { ownerPluginId: "codex" });

    await expect(
      runAgentHarnessSettledTurnFinalization(
        createAttemptParams(providerRuntimeConfig("codex", "codex")),
        createAttemptResult("settled"),
        harness,
      ),
    ).rejects.toThrow("Agent harness codex cannot safely finalize a settled tool turn");
  });

  it("binds the host OpenClaw tool to the SDK construction path without leaking authority", async () => {
    const harnessId = "codex";
    let receivedPrivateAuthority = true;
    let hostScopeActive = false;
    let toolNames: string[] = [];
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async (attemptParams) => {
      receivedPrivateAuthority = "systemAgentTool" in attemptParams;
      await Promise.resolve();
      hostScopeActive = isHostScopedAgentToolActive("openclaw");
      toolNames = createOpenClawCodingTools({
        config: { tools: { allow: ["read"], deny: ["openclaw"], toolSearch: true } },
        runtimeToolAllowlist: ["openclaw"],
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: false,
        },
      }).map((tool) => tool.name);
      return createAttemptResult(harnessId);
    });
    registerAgentHarness(
      {
        id: harnessId,
        label: harnessId,
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: pluginRunAttempt,
      },
      { ownerPluginId: harnessId },
    );
    const params = createAttemptParams(
      providerRuntimeConfig("codex", harnessId),
    ) as EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions };
    params.toolsAllow = ["openclaw"];
    params.systemAgentTool = { surface: "cli", proposalRef: {}, directiveRef: {} };

    await runAgentHarnessAttempt(params);

    expect(pluginRunAttempt).toHaveBeenCalledTimes(1);
    expect(receivedPrivateAuthority).toBe(false);
    expect(hostScopeActive).toBe(true);
    expect(toolNames).toEqual(["openclaw"]);
    expect(isHostScopedAgentToolActive("openclaw")).toBe(false);
  });

  it("strips private state at the plugin harness handoff without mutating its owner", async () => {
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("codex"));
    registerHarness({
      runAttempt,
    });
    const params = Object.assign(
      createAttemptParams(providerRuntimeConfig("codex", "codex")),
      Object.fromEntries(privateHarnessParamCases.map(({ field, value }) => [field, value])),
    );

    await runAgentHarnessAttempt(params);

    for (const { field, value } of privateHarnessParamCases) {
      expect(params).toHaveProperty(field, value);
    }
    expect(runAttempt).toHaveBeenCalledOnce();
    for (const { field } of privateHarnessParamCases) {
      expect(runAttempt.mock.calls[0]?.[0]).not.toHaveProperty(field);
    }
  });

  it("persists plugin trajectory events through the selected harness host capability", async () => {
    const tempDir = trajectoryTempDirs.make("openclaw-harness-trajectory-");
    const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId: "session-1", updatedAt: 10 });
    const trajectoryRecorder = await createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionKey,
      sessionTarget: { agentId: "main", sessionId: "session-1", sessionKey, storePath },
    });
    if (!trajectoryRecorder) {
      throw new Error("Expected SQLite trajectory recorder");
    }
    registerHarness({
      runAttempt: async (attempt) => {
        const trajectory = attempt.hostCapabilities?.trajectory;
        if (!trajectory) {
          throw new Error("Expected host trajectory capability");
        }
        trajectory.recordEvent("plugin.selected");
        await trajectory.flush();
        return createAttemptResult("codex");
      },
    });
    const params = createAttemptParams(providerRuntimeConfig("codex", "codex"));
    params.sessionKey = sessionKey;
    params.trajectoryRecorder = trajectoryRecorder;

    await runAgentHarnessAttempt(params);

    expect(await loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath })).toEqual([
      expect.objectContaining({ source: "runtime", type: "plugin.selected" }),
    ]);
  });

  it.each([
    { boundary: "missing admission", selection: "host", ownership: "none" },
    { boundary: "missing terminal", selection: "host", ownership: "none" },
    { boundary: "complete", selection: "native different", ownership: "native" },
    { boundary: "complete", selection: "native different", ownership: "host" },
    { boundary: "complete", selection: "host", ownership: "native" },
  ] as const)(
    "records terminal context for $selection with $ownership ownership only with complete anchors: $boundary",
    async ({ boundary, selection, ownership }) => {
      const admission = {
        ...createTranscriptAnchor("user-1", 1, 0),
        logicalTurnId: "heartbeat-turn",
        role: "user" as const,
      };
      const terminal = createTranscriptAnchor("assistant-1", 2, 1);
      const onContextEngineTurnCandidate = vi.fn();
      const params = createAttemptParams(providerRuntimeConfig("codex", "codex"));
      const runtimeModelSelection =
        selection === "host" ? undefined : { provider: "native-provider", model: "native-model" };
      registerHarness({
        runAttempt: async () => ({
          ...createAttemptResult("session-1"),
          ...(runtimeModelSelection ? { runtimeModelSelection } : {}),
          contextEngineTerminalAnchor: boundary === "missing terminal" ? undefined : terminal,
        }),
      });
      const registration = getRegisteredAgentHarness("codex");
      if (!registration) {
        throw new Error("expected registered Codex harness");
      }
      params.agentHarnessRuntimeOverride = "codex";
      params.sessionKey = admission.sessionKey;
      params.sessionTarget = {
        agentId: admission.agentId,
        sessionId: admission.sessionId,
        sessionKey: admission.sessionKey,
        storePath: admission.storePath,
      };
      params.bootstrapContextRunKind = "heartbeat";
      params.model = { ...params.model, contextWindow: 180_000 };
      params.modelContextWindow = 200_000;
      params.contextTokenBudget = 180_000;
      params.userTurnTranscriptRecorder =
        boundary === "missing admission" ? undefined : createTranscriptRecorder(admission);
      params.onContextEngineTurnCandidate = onContextEngineTurnCandidate;

      const nativeSessionRuntime =
        ownership === "none"
          ? undefined
          : {
              harness: registration.harness,
              ...(ownership === "native"
                ? { auth: "native" as const }
                : {
                    auth: "host" as const,
                    modelRef: { provider: params.provider, model: params.modelId },
                  }),
              assertCurrent: async () => {},
            };
      await runAgentHarnessAttempt(params, nativeSessionRuntime);

      if (boundary === "complete") {
        expect(onContextEngineTurnCandidate).toHaveBeenCalledOnce();
        expect(onContextEngineTurnCandidate).toHaveBeenCalledWith(
          expect.objectContaining({
            boundary: { admission, terminal },
            isHeartbeat: true,
            promptError: false,
            aborted: false,
            yieldAborted: false,
            runtimeContext:
              nativeSessionRuntime && runtimeModelSelection
                ? {
                    provider: runtimeModelSelection.provider,
                    modelId: runtimeModelSelection.model,
                  }
                : {
                    provider: params.provider,
                    modelId: params.modelId,
                    modelContextWindow: 200_000,
                    tokenBudget: 180_000,
                  },
          }),
        );
      } else {
        expect(onContextEngineTurnCandidate).not.toHaveBeenCalled();
      }
    },
  );

  it("drains pending context-engine turns before pinning a plugin harness", async () => {
    const order: string[] = [];
    const configuredEngine = createContextEngineRequiringAssembly();
    const fallbackEngine = {
      ...configuredEngine,
      info: { id: "legacy", name: "Legacy" },
    } satisfies ContextEngine;
    let effectiveEngine = configuredEngine;
    let degradedReason: string | undefined;
    const asEffective = (): ReturnType<ContextEngineLogicalTurnLease["begin"]> => ({
      engine: effectiveEngine,
      registeredId: effectiveEngine.info.id,
      mode: degradedReason ? "legacy-degraded" : "configured",
      ...(degradedReason ? { reason: degradedReason } : {}),
    });
    const lease = {
      get engine() {
        return effectiveEngine;
      },
      get effectiveEngine() {
        return effectiveEngine;
      },
      get effectiveEngineId() {
        return effectiveEngine.info.id;
      },
      effectiveEnginePluginId: undefined,
      get degraded() {
        return degradedReason !== undefined;
      },
      get degradedReason() {
        return degradedReason;
      },
      selectForHost: vi.fn(() => asEffective()),
      degradeBeforeStart: vi.fn((reason: string) => {
        degradedReason = reason;
        effectiveEngine = fallbackEngine;
        return asEffective();
      }),
      begin: vi.fn(() => {
        order.push("begin");
        return asEffective();
      }),
      deferDisposalUntil: vi.fn(),
      disposed: false,
      onDispose: vi.fn(),
      dispose: vi.fn(async () => {}),
    } satisfies ContextEngineLogicalTurnLease;
    contextEngineTurnAttemptMocks.drainPendingContextEngineTurnsBeforeRun.mockImplementationOnce(
      async (params) => {
        const { lease: drainLease } = params as { lease: ContextEngineLogicalTurnLease };
        order.push("drain");
        drainLease.degradeBeforeStart("pending durable turn advancement is blocked");
      },
    );
    const receivedContextEngines: Array<ContextEngine | undefined> = [];
    registerHarness({
      runAttempt: async (attemptParams) => {
        order.push("run");
        receivedContextEngines.push(attemptParams.contextEngine);
        return createAttemptResult("session-1");
      },
    });
    const admission = {
      ...createTranscriptAnchor("user-1", 1, 0),
      logicalTurnId: "turn-1",
      role: "user" as const,
    };
    const params = createAttemptParams(providerRuntimeConfig("codex", "codex"));
    params.agentHarnessRuntimeOverride = "codex";
    params.contextEngineLogicalTurnLease = lease;
    params.userTurnTranscriptRecorder = createTranscriptRecorder(admission);

    await runAgentHarnessAttempt(params);

    expect(
      contextEngineTurnAttemptMocks.drainPendingContextEngineTurnsBeforeRun,
    ).toHaveBeenCalledWith({
      admission,
      isHeartbeat: false,
      lease,
      recorder: params.userTurnTranscriptRecorder,
      sessionTarget: undefined,
    });
    expect(order).toEqual(["drain", "begin", "run"]);
    expect(receivedContextEngines).toEqual([undefined]);
  });

  it("rejects broad allowlists for private OpenClaw authority", async () => {
    const toolsAllow = ["openclaw", "read"];
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      createAttemptResult("codex"),
    );
    registerHarness({
      runAttempt: pluginRunAttempt,
    });
    const params = createAttemptParams(
      providerRuntimeConfig("codex", "codex"),
    ) as EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions };
    params.toolsAllow = toolsAllow;
    params.systemAgentTool = { surface: "cli", proposalRef: {}, directiveRef: {} };

    await expect(runAgentHarnessAttempt(params)).rejects.toThrow(
      'OpenClaw host authority requires toolsAllow: ["openclaw"]',
    );
    expect(pluginRunAttempt).not.toHaveBeenCalled();
    expect(isHostScopedAgentToolActive("openclaw")).toBe(false);
  });

  it("keeps the host OpenClaw allowlist across global, agent, and sandbox deny-all policy", async () => {
    const received: Array<{
      toolsAllow: string[] | undefined;
      extraSystemPrompt: string | undefined;
      hostScopeActive: boolean;
    }> = [];
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async (attemptParams) => {
      received.push({
        toolsAllow: attemptParams.toolsAllow,
        extraSystemPrompt: attemptParams.extraSystemPrompt,
        hostScopeActive: isHostScopedAgentToolActive("openclaw"),
      });
      return createAttemptResult("codex");
    });
    registerHarness({
      runAttempt: pluginRunAttempt,
    });
    const cases: Array<{
      config: OpenClawConfig;
      agentId?: string;
      sessionKey?: string;
    }> = [
      { config: { tools: { deny: ["*"] } } as OpenClawConfig },
      {
        config: {
          agents: { entries: { worker: { tools: { deny: ["*"] } } } },
        } as OpenClawConfig,
        agentId: "worker",
      },
      {
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { sandbox: { tools: { deny: ["*"] } } },
        } as OpenClawConfig,
        sessionKey: "agent:main:session-1",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const params = createAttemptParams(testCase.config) as EmbeddedRunAttemptParams & {
        systemAgentTool?: SystemAgentToolOptions;
      };
      params.sessionId = `session-${index}`;
      params.agentHarnessRuntimeOverride = "codex";
      params.agentId = testCase.agentId;
      params.sessionKey = testCase.sessionKey;
      params.toolsAllow = ["openclaw"];
      params.systemAgentTool = { surface: "cli", proposalRef: {}, directiveRef: {} };
      await runAgentHarnessAttempt(params);
    }

    expect(received).toEqual([
      { toolsAllow: ["openclaw"], extraSystemPrompt: undefined, hostScopeActive: true },
      { toolsAllow: ["openclaw"], extraSystemPrompt: undefined, hostScopeActive: true },
      { toolsAllow: ["openclaw"], extraSystemPrompt: undefined, hostScopeActive: true },
    ]);
    expect(isHostScopedAgentToolActive("openclaw")).toBe(false);
  });

  it("binds the same host OpenClaw scope to the built-in OpenClaw harness", async () => {
    let toolNames: string[] = [];
    agentRunAttempt.mockImplementationOnce(async () => {
      await Promise.resolve();
      toolNames = createOpenClawCodingTools({
        config: { tools: { allow: ["read"], deny: ["openclaw"], toolSearch: true } },
        runtimeToolAllowlist: ["openclaw"],
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: false,
        },
      }).map((tool) => tool.name);
      return createAttemptResult("openclaw");
    });
    const params = createAttemptParams(
      providerRuntimeConfig("codex", "openclaw"),
    ) as EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions };
    params.toolsAllow = ["openclaw"];
    params.systemAgentTool = { surface: "gateway", proposalRef: {}, directiveRef: {} };
    const onContextAccountingEvent = vi.fn();
    const onCompactionRequestBudget = vi.fn();
    Object.assign(params, {
      compactionCountOwner: "caller",
      onContextAccountingEvent,
      onCompactionRequestBudget,
    });

    const result = await runAgentHarnessAttempt(params);

    expect(result.sessionIdUsed).toBe("openclaw");
    expect(agentRunAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionCountOwner: "caller",
        onContextAccountingEvent,
        onCompactionRequestBudget,
      }),
    );
    expect(toolNames).toEqual(["openclaw"]);
    expect(isHostScopedAgentToolActive("openclaw")).toBe(false);
  });

  it("unwraps sentinels only at the plugin harness handoff", async () => {
    const pluginRunAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
      createAttemptResult("codex"),
    );
    registerHarness({
      runAttempt: pluginRunAttempt,
    });
    const secret = "plugin-provider-secret";
    const sentinel = mintSecretSentinel(secret, { label: "model-auth:codex" });
    const params = createAttemptParams(providerRuntimeConfig("codex", "codex"));
    params.resolvedApiKey = sentinel;
    params.model = {
      ...params.model,
      headers: { Authorization: `Bearer ${sentinel}`, "X-Optional": null } as never,
    };

    await runAgentHarnessAttempt(params);

    const handedOff = pluginRunAttempt.mock.calls[0]?.[0];
    expect(handedOff?.resolvedApiKey).toBe(secret);
    expect(handedOff?.model.headers?.Authorization).toBe(`Bearer ${secret}`);
    expect(handedOff?.model.headers?.["X-Optional"]).toBeNull();
    expect(params.resolvedApiKey).toBe(sentinel);
  });

  it("annotates non-ok harness result classifications for outer model fallback", async () => {
    const classify = vi.fn<NonNullable<AgentHarness["classify"]>>(() => "empty" as const);
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("codex"));
    registerAgentHarness(
      {
        id: "codex",
        label: "Classifying Codex",
        supports: (ctx) =>
          ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt,
        classify,
      },
      { ownerPluginId: "codex" },
    );

    const params = createAttemptParams();
    const result = await runAgentHarnessAttempt(params);

    const classifyCall = classify.mock.calls.at(0);
    expect(classifyCall?.[0].sessionIdUsed).toBe("codex");
    expect(classifyCall?.[1]).toEqual(
      expect.objectContaining({
        hostCapabilities: expect.objectContaining({ kind: "agent-harness-host-capability" }),
        pluginHarnessToolPolicyRestricted: false,
        runId: params.runId,
        sessionId: params.sessionId,
      }),
    );
    expect(classifyCall?.[1]).not.toHaveProperty("admittedRunContext");
    expect(classifyCall?.[1]).not.toHaveProperty("operationalRunInstance");
    expect(result.agentHarnessId).toBe("codex");
    expect(result.agentHarnessResultClassification).toBe("empty");
  });

  it("surfaces an auto-selected plugin harness failure instead of replaying through OpenClaw", async () => {
    registerFailingCodexHarness();

    await expect(runAgentHarnessAttempt(createAttemptParams())).rejects.toThrow(
      "codex startup failed",
    );
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("projects deferred route support into the final attempt selection", async () => {
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) =>
      ctx.modelProvider?.preparedAuth?.source === "harness" &&
      ctx.modelProvider.requestTransportOverrides === "none" &&
      ctx.modelProvider.runtimePolicy?.compatibleIds.includes("codex")
        ? { supported: true as const, priority: 100 }
        : { supported: false as const, reason: "prepared route support is missing" },
    );
    registerHarness({
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });
    const params = createAttemptParams();
    params.provider = "openai";
    params.modelId = "gpt-5.5";
    params.model = {
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as Model;
    params.agentHarnessRuntimeOverride = "codex";
    params.runtimePlan = {
      auth: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        harnessAuthProvider: "openai",
        deferredRouteSupport: {
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      },
    } as never;

    await expect(runAgentHarnessAttempt(params)).resolves.toMatchObject({
      sessionIdUsed: "codex",
    });
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
          preparedAuth: { source: "harness" },
        }),
      }),
    );
  });

  it("rejects the candidate when the forced plugin harness does not support its provider", async () => {
    registerFailingCodexHarness();

    const params = createAttemptParams(
      agentModelRuntimeConfig("9router/cc/claude-opus-4-6", "codex"),
    );
    params.provider = "9router";
    params.modelId = "cc/claude-opus-4-6";
    params.agentHarnessRuntimeOverride = "codex";

    await expect(runAgentHarnessAttempt(params)).rejects.toThrow(
      /Requested agent harness "codex" does not support 9router\/cc\/claude-opus-4-6/,
    );
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("keeps a session-pinned Codex harness across outer provider overrides", async () => {
    registerSuccessfulCodexHarness();

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(),
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentHarnessId: "codex",
    });

    expect(result.sessionIdUsed).toBe("codex");
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("fails closed when a session-pinned Codex harness is unavailable", async () => {
    await expect(
      runAgentHarnessAttempt({
        ...createAttemptParams(),
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        agentHarnessId: "codex",
      }),
    ).rejects.toThrow('Requested agent harness "codex" is not registered');
    expect(agentRunAttempt).not.toHaveBeenCalled();
  });

  it("falls back to OpenClaw when the implicit OpenAI Codex harness is unavailable", async () => {
    expect(resolveAgentHarnessPolicy({ provider: "openai", modelId: "gpt-5.4" })).toEqual({
      runtime: "codex",
      runtimeSource: "implicit",
    });
    expect(resolveAvailableAgentHarnessPolicy({ provider: "openai", modelId: "gpt-5.4" })).toEqual({
      runtime: "openclaw",
      runtimeSource: "implicit",
    });

    await ensureSelectedAgentHarnessPlugin({
      provider: "openai",
      modelId: "gpt-5.4",
      workspaceDir: "/tmp/workspace",
      pluginRegistry: getActivePluginRegistry() ?? undefined,
    });

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(),
      provider: "openai",
      modelId: "gpt-5.4",
    });

    expect(result.sessionIdUsed).toBe("openclaw");
    expect(agentRunAttempt).toHaveBeenCalledTimes(1);
  });

  it("collapses channel group sender deny-all to empty toolsAllow for plugin harnesses", async () => {
    const delivered = vi.fn(async () => {});
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (prepared) => {
      const handle = createEmbeddedRunHandle({
        runId: prepared.runId,
        toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
        queueMessage: delivered,
      });
      setActiveEmbeddedRun(prepared.sessionId, handle, prepared.sessionKey, prepared.sessionFile);
      try {
        await expect(
          queueEmbeddedAgentMessageWithOutcomeAsync(prepared.sessionId, "Continue", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: {
              senderIsOwner: false,
              disableTools: false,
              traceAuthorized: false,
              messageProvider: "telegram",
              groupId: "test-deny-room",
              senderId: "test-denied-sender",
            },
          }),
        ).resolves.toMatchObject({ queued: true });
        expect(delivered).toHaveBeenCalledOnce();
      } finally {
        clearActiveEmbeddedRun(prepared.sessionId, handle, prepared.sessionKey);
      }
      return createAttemptResult("codex");
    });
    registerHarness({
      conversationToolPolicySupport: "exact",
      supports: (ctx) =>
        ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt,
    });

    await runAgentHarnessAttempt({
      ...createAttemptParams(groupSenderDenyAllConfig()),
      agentId: "main",
      sessionKey: "agent:main:telegram:group:test-deny-room",
      messageProvider: "telegram",
      groupId: "test-deny-room",
      senderId: "test-denied-sender",
      extraSystemPrompt: "Existing operator note.",
    });

    expect(runAttempt).toHaveBeenCalledTimes(1);
    const attempt = runAttempt.mock.calls[0]?.[0];
    expect(attempt?.toolsAllow).toEqual([]);
    expect(attempt?.extraSystemPrompt).toContain("Existing operator note.");
    expect(attempt?.extraSystemPrompt).toContain("this sender is not allowed by policy");
  });

  it("passes partial conversation policy to harnesses that enforce it exactly", async () => {
    const received: Array<{
      conversationToolPolicy: EmbeddedRunAttemptParams["conversationToolPolicy"];
      pluginHarnessToolPolicyRestricted: boolean | undefined;
      toolsAllow: string[] | undefined;
    }> = [];
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (attempt) => {
      received.push({
        conversationToolPolicy: attempt.conversationToolPolicy,
        pluginHarnessToolPolicyRestricted: attempt.pluginHarnessToolPolicyRestricted,
        toolsAllow: attempt.toolsAllow,
      });
      return createAttemptResult("codex");
    });
    registerHarness({
      conversationToolPolicySupport: "exact",
      supports: (ctx) =>
        ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt,
    });

    for (const toolsAllow of [undefined, ["Read", "Bash"]]) {
      await runAgentHarnessAttempt({
        ...createAttemptParams(),
        conversationToolPolicy: { deny: ["exec"] },
        toolsAllow,
      });
    }

    expect(received).toEqual([
      {
        conversationToolPolicy: { deny: ["exec"] },
        pluginHarnessToolPolicyRestricted: true,
        toolsAllow: undefined,
      },
      {
        conversationToolPolicy: { deny: ["exec"] },
        pluginHarnessToolPolicyRestricted: true,
        toolsAllow: ["Read", "Bash"],
      },
    ]);
  });

  it("isolates native tools unless every exact deny is explicitly safe", async () => {
    const received: Array<{
      restricted: boolean;
      safeDeniedTools?: readonly string[];
    }> = [];
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (attempt) => {
      received.push({
        restricted: attempt.pluginHarnessToolPolicyRestricted === true,
        safeDeniedTools: attempt.pluginHarnessToolPolicySafeDeniedTools,
      });
      return createAttemptResult("codex");
    });
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      conversationToolPolicySupport: "exact",
      conversationToolPolicySafeDenyTools: [
        "tts",
        "music_generate",
        "image_generate",
        "browser",
        "unknown_native_tool",
      ],
      supports: (ctx) =>
        ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt,
    };
    registerAgentHarness(harness, { ownerPluginId: "codex" });

    const policies = [
      { deny: ["image_generate"] },
      { deny: ["tts", "music_generate"] },
      { deny: ["browser"] },
      { deny: ["exec"] },
      { deny: ["video_generate"] },
      { deny: ["unknown_native_tool"] },
      { deny: ["group:runtime"] },
      { deny: ["*"] },
      { allow: ["tts"] },
    ];
    for (const conversationToolPolicy of policies) {
      await runAgentHarnessAttempt({
        ...createAttemptParams(),
        conversationToolPolicy,
      });
    }

    expect(received.map((attempt) => attempt.restricted)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(received[0]?.safeDeniedTools).toEqual(["image_generate"]);
  });

  it("isolates native capabilities restricted by effective profiles or explicit policy", async () => {
    const received: boolean[] = [];
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (attempt) => {
      received.push(attempt.pluginHarnessToolPolicyRestricted === true);
      return createAttemptResult("codex");
    });
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      conversationToolPolicySupport: "exact",
      conversationToolPolicyNativeTools: [
        "exec",
        "process",
        "read",
        "write",
        "edit",
        "apply_patch",
      ],
      supports: (ctx) =>
        ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt,
    };
    registerAgentHarness(harness, { ownerPluginId: "codex" });

    const cases: Array<{
      config?: OpenClawConfig;
      conversationToolPolicy?: EmbeddedRunAttemptParams["conversationToolPolicy"];
      agentId?: string;
      sessionKey?: string;
      swarmCollector?: boolean;
    }> = [
      {},
      { config: { tools: { profile: "coding" } } as OpenClawConfig },
      { config: { tools: { profile: "full" } } },
      { config: { tools: { profile: "messaging" } } },
      { config: { tools: { profile: "minimal" } } },
      {
        config: {
          tools: { profile: "coding" },
          agents: { entries: { worker: { tools: { profile: "messaging" } } } },
        },
        agentId: "worker",
        sessionKey: "agent:worker:session-1",
      },
      {
        config: {
          tools: { profile: "messaging" },
          agents: { entries: { worker: { tools: { profile: "coding" } } } },
        },
        agentId: "worker",
        sessionKey: "agent:worker:session-1",
      },
      { config: { tools: { profile: "coding", byProvider: { codex: { profile: "messaging" } } } } },
      {
        config: {
          tools: { profile: "full" },
          agents: {
            entries: { worker: { tools: { byProvider: { codex: { profile: "minimal" } } } } },
          },
        },
        agentId: "worker",
        sessionKey: "agent:worker:session-1",
      },
      { config: { tools: { profile: "messaging", alsoAllow: ["group:fs", "group:runtime"] } } },
      { config: { tools: { profile: "minimal", alsoAllow: ["exec"] } } },
      { conversationToolPolicy: {} },
      { conversationToolPolicy: { allow: ["*"] } },
      { swarmCollector: false },
      { swarmCollector: true },
      { conversationToolPolicy: { deny: ["exec"] } },
      { config: { tools: { deny: ["exec"] } } as OpenClawConfig },
      {
        config: {
          agents: { entries: { worker: { tools: { deny: ["exec"] } } } },
        } as OpenClawConfig,
        agentId: "worker",
        sessionKey: "agent:worker:session-1",
      },
      {
        config: { tools: { deny: ["exec"] } } as OpenClawConfig,
        conversationToolPolicy: {},
      },
    ];
    const nativeRestrictions: boolean[] = [];

    for (const testCase of cases) {
      const params = {
        ...createAttemptParams(testCase.config),
        conversationToolPolicy: testCase.conversationToolPolicy,
        agentId: testCase.agentId,
        sessionKey: testCase.sessionKey,
        swarmCollector: testCase.swarmCollector,
      };
      nativeRestrictions.push(resolveAgentHarnessNativeToolPolicyRestricted(params, harness));
      await runAgentHarnessAttempt(params);
    }

    expect(received).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(nativeRestrictions).toEqual(received);
  });

  it("rejects restrictive policy before an unsupported plugin harness runs", async () => {
    const policy = { conversationToolPolicy: { deny: ["exec"] } };
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("other"));
    registerAgentHarness(
      {
        id: "other",
        label: "Other runtime",
        supports: (ctx) =>
          ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt,
      },
      { ownerPluginId: "other" },
    );

    await expect(
      runAgentHarnessAttempt({
        ...createAttemptParams(),
        ...policy,
      }),
    ).rejects.toThrow(
      "Other runtime cannot enforce this conversation's tool policy. Use the embedded runtime",
    );
    expect(runAttempt).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "empty runtime allowlist",
      policy: { toolsAllow: [] },
      restricted: true,
      tools: [],
      denyAll: true,
    },

    {
      name: "disabled tools with wildcard",
      policy: { disableTools: true, toolsAllow: ["*"] },
      restricted: true,
      tools: [],
      denyAll: true,
    },

    {
      name: "overlapping runtime globs",
      policy: { toolsAllow: attachToolAllowlistIntersection([], [["web_*"], ["*_search"]]) },
      restricted: true,
      tools: [],
      denyAll: false,
    },
    {
      name: "wildcard runtime allowlist",
      policy: { toolsAllow: ["*"] },
      restricted: false,
      tools: ["*"],
      denyAll: false,
    },
  ])(
    "preserves $name semantics at plugin handoff",
    async ({ policy, restricted, tools, denyAll }) => {
      const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
        createAttemptResult("codex"),
      );
      registerHarness({
        conversationToolPolicySupport: "exact",
        conversationToolPolicySafeDenyTools: ["image_generate"],
        supports: (ctx) =>
          ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
        runAttempt,
      });

      await runAgentHarnessAttempt({
        ...createAttemptParams(),
        ...policy,
        extraSystemPrompt: "Existing operator note.",
      });

      expect(runAttempt).toHaveBeenCalledTimes(1);
      const attempt = runAttempt.mock.calls[0]?.[0];
      expect(attempt?.pluginHarnessToolPolicyRestricted).toBe(restricted);
      expect(attempt?.toolsAllow).toEqual(tools);
      expect(attempt?.extraSystemPrompt).toContain("Existing operator note.");
      if (denyAll) {
        expect(attempt?.extraSystemPrompt).toContain(
          "Tool and file actions are disabled by runtime policy.",
        );
      } else {
        expect(attempt?.extraSystemPrompt).not.toContain(
          "Tool and file actions are disabled by runtime policy.",
        );
      }
    },
  );

  it("adds chat policy wording for plugin harness group deny-all", async () => {
    const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => createAttemptResult("codex"));
    registerHarness({
      conversationToolPolicySupport: "exact",
      supports: (ctx) =>
        ctx.provider === "codex" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt,
    });

    await runAgentHarnessAttempt({
      ...createAttemptParams(groupDenyAllConfig()),
      sessionKey: "agent:main:telegram:group:test-deny-room",
      messageProvider: "telegram",
      groupId: "test-deny-room",
      senderId: "test-denied-sender",
    });

    expect(runAttempt).toHaveBeenCalledTimes(1);
    const attempt = runAttempt.mock.calls[0]?.[0];
    expect(attempt?.toolsAllow).toEqual([]);
    expect(attempt?.extraSystemPrompt).toContain("this chat is not allowed by policy");
  });
});

describe("selectAgentHarness", () => {
  it("rejects statically unrelated auto harnesses before provider discovery", () => {
    const supports = vi.fn(() => ({ supported: true as const, priority: 100 }));
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      autoSelection: { providerIds: ["openai", "codex"] },
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    expect(selectAgentHarness({ provider: "deepseek", modelId: "deepseek-v4-pro" }).id).toBe(
      "openclaw",
    );
    expect(supports).not.toHaveBeenCalled();
    expect(providerOwnerMocks.resolveProviderRefOwnership).not.toHaveBeenCalled();
  });

  it("auto-selects the highest-priority plugin harness without duplicate support probes", () => {
    const lowPrioritySupports = vi.fn(() => ({
      supported: true as const,
      priority: 10,
      reason: "generic codex support",
    }));
    const highPrioritySupports = vi.fn(() => ({
      supported: true as const,
      priority: 100,
      reason: "native codex app-server",
    }));
    const unsupportedSupports = vi.fn(() => ({
      supported: false as const,
      reason: "provider mismatch",
    }));
    registerAgentHarness(
      {
        id: "codex-low",
        label: "Low Codex",
        supports: lowPrioritySupports,
        runAttempt: vi.fn(async () => createAttemptResult("codex-low")),
      },
      { ownerPluginId: "codex-low" },
    );
    registerAgentHarness(
      {
        id: "codex-high",
        label: "High Codex",
        supports: highPrioritySupports,
        runAttempt: vi.fn(async () => createAttemptResult("codex-high")),
      },
      { ownerPluginId: "codex-high" },
    );
    registerAgentHarness(
      {
        id: "other",
        label: "Other Harness",
        supports: unsupportedSupports,
        runAttempt: vi.fn(async () => createAttemptResult("other")),
      },
      { ownerPluginId: "other" },
    );

    const harness = selectAgentHarness({
      provider: "codex",
      modelId: "gpt-5.4",
    });

    expect(harness.id).toBe("codex-high");
    expect(lowPrioritySupports).toHaveBeenCalledTimes(1);
    expect(highPrioritySupports).toHaveBeenCalledTimes(1);
    expect(unsupportedSupports).toHaveBeenCalledTimes(1);
  });

  it("rejects a harness replaced during its support probe", () => {
    const replacement: AgentHarness = {
      id: "codex",
      label: "Replacement",
      supports: () => ({ supported: true }),
      runAttempt: async () => createAttemptResult("replacement"),
    };
    registerAgentHarness({
      ...replacement,
      supports: () => {
        registerAgentHarness(replacement);
        return { supported: true };
      },
    });

    expect(() =>
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        agentHarnessRuntimeOverride: "codex",
      }),
    ).toThrow("changed during owner resolution");
  });

  it.each([
    ["Platform", "openai-responses", "https://api.openai.com/v1", ["agentsapi"]],
    ["ChatGPT", "openai-chatgpt-responses", "https://chatgpt.com/backend-api/codex", []],
  ] as const)(
    "keeps authored reasoning metadata and native controls on %s Codex",
    (_label, api, baseUrl, additionalRuntimes) => {
      const config: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.6-sol",
                  name: "Sol",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 8192,
                  api,
                  baseUrl,
                  compat: {
                    supportsReasoningEffort: true,
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
                  },
                },
              ],
            },
          },
        },
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-sol": {
                params: { thinking: "xhigh", fastMode: true, fastAutoOnSeconds: 30 },
              },
            },
          },
        },
      };
      registerAgentHarness({
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.modelProvider?.requestTransportOverrides === "present"
            ? { supported: false, fallbackRuntime: "openclaw" }
            : { supported: true },
        runAttempt: async () => createAttemptResult("codex"),
      });
      for (const runtime of [undefined, "codex", "openclaw"]) {
        expect(
          selectAgentHarness({
            provider: "openai",
            modelId: "gpt-5.6-sol",
            config,
            agentHarnessRuntimeOverride: runtime,
          }).id,
        ).toBe(runtime ?? "codex");
      }
      expect(
        buildAgentHarnessSupportContext({
          provider: "openai",
          modelId: "gpt-5.6-sol",
          requestedRuntime: "codex",
          config,
        }).modelProvider,
      ).toMatchObject({
        requestTransportOverrides: "none",
        runtimePolicy: { compatibleIds: ["openclaw", "codex", ...additionalRuntimes] },
      });
    },
  );

  it("falls back only for implicitly selected Codex transport rejection", () => {
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) =>
      ctx.modelProvider?.requestTransportOverrides === "present"
        ? {
            supported: false as const,
            reason: "custom provider request transport",
          }
        : { supported: true as const },
    );
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports,
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });
    const config = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            headers: { "x-route": "custom" },
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveAvailableAgentHarnessPolicy({ provider: "openai", modelId: "gpt-5.5", config }),
    ).toEqual({ runtime: "openclaw", runtimeSource: "implicit" });
    expect(selectAgentHarness({ provider: "openai", modelId: "gpt-5.5", config }).id).toBe(
      "openclaw",
    );
    expect(() =>
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        config,
        agentHarnessRuntimeOverride: "codex",
      }),
    ).toThrow("custom provider request transport");
  });

  it("fails closed when a pinned harness cannot own every prepared route", () => {
    const pin = { agentHarnessId: "codex" };
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.modelProvider?.runtimePolicy?.compatibleIds.includes("codex")
          ? { supported: true }
          : { supported: false, reason: "prepared retry route is incompatible" },
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    expect(() =>
      selectAgentHarnessForPreparedModelProviders({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProviders: [
          {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            requestTransportOverrides: "none",
            runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
          },
          {
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            requestTransportOverrides: "none",
            runtimePolicy: { compatibleIds: ["openclaw"] },
          },
        ],
        ...pin,
      }),
    ).toThrow("prepared retry route is incompatible");
  });

  it("uses a declared fallback for an explicit harness across prepared routes", () => {
    const pin = { agentHarnessRuntimeOverride: "codex" };
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.modelProvider?.requestTransportOverrides === "present"
          ? { supported: false, fallbackRuntime: "openclaw" }
          : { supported: true },
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    expect(
      selectAgentHarnessForPreparedModelProviders({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        modelProviders: [
          { requestTransportOverrides: "none" },
          { requestTransportOverrides: "present" },
        ],
        ...pin,
      }).id,
    ).toBe("openclaw");
  });

  it("keeps private-QA forced Codex across prepared routes that declare fallback", () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    vi.stubEnv("OPENCLAW_QA_FORCE_RUNTIME", "codex");
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.modelProvider?.requestTransportOverrides === "present"
          ? { supported: false, fallbackRuntime: "openclaw" }
          : { supported: true },
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
    });

    expect(
      selectAgentHarnessForPreparedModelProviders({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        modelProviders: [
          { requestTransportOverrides: "none" },
          { requestTransportOverrides: "present" },
        ],
      }).id,
    ).toBe("codex");
  });

  it("honors explicit OpenClaw runtime overrides when selecting a harness", async () => {
    registerSuccessfulCodexHarness();

    const harness = selectAgentHarness({
      provider: "openai",
      modelId: "gpt-5.4",
      agentHarnessRuntimeOverride: "openclaw",
    });

    expect(harness.id).toBe("openclaw");
    expect(providerOwnerMocks.resolveProviderRefOwnership).not.toHaveBeenCalled();

    const result = await runAgentHarnessAttempt({
      ...createAttemptParams(),
      provider: "openai",
      modelId: "gpt-5.4",
      agentHarnessRuntimeOverride: "openclaw",
    });
    expect(result.sessionIdUsed).toBe("openclaw");
  });

  it("skips harness compaction preflight for claude-cli runtime sessions", async () => {
    await expect(
      compactSession({
        provider: "anthropic",
        model: "claude-opus-4-7",
        config: agentModelRuntimeConfig("anthropic/claude-opus-4-7", "claude-cli"),
      }),
    ).resolves.toBeUndefined();
  });

  it("skips harness compaction preflight for claude-cli provider sessions", async () => {
    await expect(
      compactSession({
        provider: "claude-cli",
        model: "claude-opus-4-7",
        config: providerRuntimeConfig("claude-cli", "claude-cli"),
      }),
    ).resolves.toBeUndefined();
  });

  it("uses the concrete prepared route without replacing harness auth bootstrap", async () => {
    const compact = registerTestCompactor({
      authBootstrap: "harness",
      supports: (ctx) =>
        ctx.modelProvider?.api === OPENAI_CHATGPT_ROUTE.api &&
        ctx.modelProvider.baseUrl === OPENAI_CHATGPT_ROUTE.baseUrl
          ? { supported: true, priority: 100 }
          : { supported: false },
    });

    await expect(
      compactSession({
        runtimeAuthPlan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          harnessAuthProvider: "openai",
          modelRoute: OPENAI_CHATGPT_ROUTE,
        },
      }),
    ).resolves.toEqual({ ok: true, compacted: false });

    expect(compactAuthMocks.resolveModelAsync).not.toHaveBeenCalled();
    expect(compactAuthMocks.getApiKeyForModelCore).not.toHaveBeenCalled();
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeAuthPlan: expect.objectContaining({
          modelRoute: OPENAI_CHATGPT_ROUTE,
        }),
      }),
    );
  });

  it("forwards the prepared Platform key through harness-owned compaction", async () => {
    const compact = registerTestCompactor({ authBootstrap: "harness" });

    await expect(
      compactSession({
        resolvedApiKey: "test-key",
        runtimeAuthPlan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          harnessAuthProvider: "openai",
          selectedAuthMode: "api-key",
          modelRoute: OPENAI_PLATFORM_ROUTE,
        },
      }),
    ).resolves.toEqual({ ok: true, compacted: false });

    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedApiKey: "test-key",
        runtimeAuthPlan: expect.objectContaining({ modelRoute: OPENAI_PLATFORM_ROUTE }),
      }),
    );
  });

  it("honors selected plugin harness pins during compaction preflight", async () => {
    const compact = registerTestCompactor();
    await expect(
      compactSession({
        authProfileId: "main-profile",
        resolvedApiKey: "test-key",
        agentHarnessId: "codex",
        config: {
          agents: {
            entries: { main: { agentDir: "/tmp/main-agent" } },
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        } as OpenClawConfig,
      }),
    ).resolves.toEqual({ ok: true, compacted: false });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]?.[0]).toMatchObject({
      agentDir: "/tmp/main-agent",
      agentId: "main",
      resolvedApiKey: "test-key",
      runtimeModel: {
        id: "gpt-5.5",
        provider: "openai",
      },
    });
  });

  it("skips internal post-context-engine compaction when the harness lacks the private capability", async () => {
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: true,
    }));
    registerHarness({
      supports: (ctx) =>
        ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
      compact,
    });

    await expect(
      compactSession(
        {
          agentHarnessId: "codex",
        },
        { nativeCompactionRequest: "after_context_engine" },
      ),
    ).resolves.toBeUndefined();
    expect(compact).not.toHaveBeenCalled();
  });

  it("routes required-preflight compaction through the harness private capability", async () => {
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: true,
    }));
    const compactNative = vi.fn(
      async (params: TestNativeCompactionParams): Promise<AgentHarnessCompactResult> => ({
        ok: true,
        compacted: false,
        result: {
          summary: "codex owns automatic compaction",
          firstKeptEntryId: "entry-1",
          tokensBefore: 10,
          details: {
            request: params.nativeCompactionRequest,
          },
        },
      }),
    );
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: vi.fn(async () => createAttemptResult("codex")),
      compact,
    };
    registerAgentHarness(harness, { ownerPluginId: "codex", nativeCompaction: compactNative });
    const onNativeCompactionCapabilityUsed = vi.fn();

    await expect(
      compactSession(
        {
          agentHarnessId: "codex",
          preflightRequired: true,
        },
        { nativeCompactionRequest: "required_preflight", onNativeCompactionCapabilityUsed },
      ),
    ).resolves.toEqual({
      ok: true,
      compacted: false,
      result: {
        summary: "codex owns automatic compaction",
        firstKeptEntryId: "entry-1",
        tokensBefore: 10,
        details: { request: "required_preflight" },
      },
    });
    expect(compact).not.toHaveBeenCalled();
    expect(onNativeCompactionCapabilityUsed).toHaveBeenCalledTimes(1);
    expect(compactNative).toHaveBeenCalledTimes(1);
    expect(compactNative).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeCompactionRequest: "required_preflight",
        preflightRequired: true,
      }),
    );
  });

  it("ignores a forged native-compaction property on a non-Codex harness", async () => {
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: true,
    }));
    const compactNative = vi.fn(
      async (_params: TestNativeCompactionParams): Promise<AgentHarnessCompactResult> => ({
        ok: false,
        compacted: false,
        reason: "no copilot app-server thread binding",
        failure: { reason: "missing_thread_binding" },
      }),
    );
    const harness: AgentHarness & {
      compactNative(
        params: TestNativeCompactionParams,
      ): Promise<AgentHarnessCompactResult | undefined>;
    } = {
      id: "copilot",
      label: "Copilot",
      supports: (ctx) =>
        ctx.provider === "openai" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: vi.fn(async () => createAttemptResult("copilot")),
      compact,
      compactNative,
    };
    registerAgentHarness(harness, { ownerPluginId: "copilot" });
    const onNativeCompactionCapabilityUsed = vi.fn();

    await expect(
      compactSession(
        {
          agentHarnessId: "copilot",
          preflightRequired: true,
        },
        { nativeCompactionRequest: "required_preflight", onNativeCompactionCapabilityUsed },
      ),
    ).resolves.toEqual({ ok: true, compacted: true });
    expect(onNativeCompactionCapabilityUsed).not.toHaveBeenCalled();
    expect(compactNative).not.toHaveBeenCalled();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("keeps compaction recoverable when auth profile lookup fails", async () => {
    compactAuthMocks.getApiKeyForModelCore.mockRejectedValue(new Error("missing auth profile"));
    const compact = registerTestCompactor();

    await expect(
      compactSession({
        authProfileId: "deleted-profile",
        agentHarnessId: "codex",
        config: agentModelRuntimeConfig("openai/gpt-5.5", "openclaw"),
      }),
    ).resolves.toEqual({ ok: true, compacted: false });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]?.[0]).not.toHaveProperty("resolvedApiKey");
    expect(compactAuthMocks.resolveModelAsync).toHaveBeenCalledWith(
      "openai",
      "gpt-5.5",
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        authProfileId: "deleted-profile",
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("preserves resolved compaction credentials when model lookup fails", async () => {
    compactAuthMocks.resolveModelAsync.mockRejectedValue(new Error("model lookup unavailable"));
    const compact = registerTestCompactor({ id: "copilot", provider: "local-proxy" });

    await expect(
      compactSession({
        provider: "local-proxy",
        model: "proxy-model",
        resolvedApiKey: "already-resolved",
        agentHarnessId: "copilot",
      }),
    ).resolves.toEqual({ ok: true, compacted: false });

    expect(compactAuthMocks.getApiKeyForModelCore).not.toHaveBeenCalled();
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedApiKey: "already-resolved",
      }),
    );
  });

  it("fails closed when route preparation cannot protect harness-owned compaction auth", async () => {
    compactAuthMocks.resolveModelAsync.mockRejectedValue(new Error("model lookup unavailable"));
    const compact = registerTestCompactor({ authBootstrap: "harness" });

    await expect(
      compactSession({
        agentHarnessId: "codex",
        resolvedApiKey: "must-not-reach-ambient-auth",
      }),
    ).rejects.toThrow("refusing harness-owned ambient auth");
    expect(compact).not.toHaveBeenCalled();
  });

  it("lets harness-owned compaction proceed without ambient auth when model lookup fails", async () => {
    compactAuthMocks.resolveModelAsync.mockRejectedValue(new Error("model lookup unavailable"));
    const result = { ok: true, compacted: false, reason: "harness result" } as const;
    const compact = registerTestCompactor({ authBootstrap: "harness", result });

    await expect(compactSession({ agentHarnessId: "codex" })).resolves.toEqual(result);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]?.[0]).not.toHaveProperty("resolvedApiKey");
    expect(compact.mock.calls[0]?.[0]).not.toHaveProperty("runtimeModel");
  });

  it("lets harness-owned compaction proceed without ambient auth when auth preparation fails", async () => {
    // Model resolution must succeed so this test exercises the auth-preparation
    // catch, not the model-resolution fallback covered above.
    compactAuthMocks.resolveModelAsync.mockResolvedValue({
      model: {
        id: "proxy-model",
        provider: "local-proxy",
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
      },
    });
    compactAuthMocks.prepareAgentRuntimeAuth.mockImplementationOnce(() => {
      throw new Error("auth preparation unavailable");
    });
    const result = { ok: true, compacted: false, reason: "harness result" } as const;
    const compact = registerTestCompactor({ authBootstrap: "harness", result });

    await expect(compactSession({ agentHarnessId: "codex" })).resolves.toEqual(result);
    expect(compactAuthMocks.prepareAgentRuntimeAuth).toHaveBeenCalled();
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]?.[0]).not.toHaveProperty("resolvedApiKey");
    expect(compact.mock.calls[0]?.[0]).not.toHaveProperty("runtimeModel");
  });

  it("passes runtime model and default credentials to compaction when auth profile id is absent", async () => {
    compactAuthMocks.resolveModelAsync.mockResolvedValue({
      model: {
        id: "proxy-model",
        provider: "local-proxy",
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
      },
    });
    const compact = registerTestCompactor({ id: "copilot", provider: "local-proxy" });

    await expect(
      compactSession({
        provider: "local-proxy",
        model: "proxy-model",
        agentHarnessId: "copilot",
      }),
    ).resolves.toEqual({ ok: true, compacted: false });

    expect(compactAuthMocks.resolveModelAsync).toHaveBeenCalledWith(
      "local-proxy",
      "proxy-model",
      expect.any(String),
      undefined,
      expect.objectContaining({
        authProfileId: undefined,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(compactAuthMocks.getApiKeyForModelCore).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: expect.any(String),
        model: expect.objectContaining({
          baseUrl: "https://proxy.example/v1",
          id: "proxy-model",
        }),
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedApiKey: "test-key",
        runtimeModel: expect.objectContaining({
          baseUrl: "https://proxy.example/v1",
          id: "proxy-model",
        }),
      }),
    );
  });

  it("keeps auth-route rematerialization on the caller-owned prepared generation", async () => {
    const cfg = {} as OpenClawConfig;
    const createStores = () => ({ authStorage: {} as never, modelRegistry: {} as never });
    const generationA = createModelGenerationFixture({
      agentDir: generationState.agentDir(),
      workspaceDir: generationState.workspaceDir,
      config: cfg,
      createStores,
      label: "compact-a",
      provider: "local-proxy",
      requestProvider: "local-proxy",
      modelId: "proxy-model",
      runtimeApi: "openai-responses",
    });
    const generationB = createModelGenerationFixture({
      agentDir: generationState.agentDir(),
      workspaceDir: generationState.workspaceDir,
      config: cfg,
      createStores,
      label: "compact-b",
      provider: "local-proxy",
      requestProvider: "local-proxy",
      modelId: "proxy-model",
      runtimeApi: "openai-responses",
    });
    compactAuthMocks.resolveModelAsync.mockImplementation(
      async (_provider, _modelId, _agentDir, _config, options) => {
        const registry = options?.preparedModelRuntime?.pluginRegistry ?? getActivePluginRegistry();
        const label = registry === generationA.pluginRegistry ? "A" : "B";
        return {
          model: {
            provider: "local-proxy",
            id: "proxy-model",
            name: `Runtime ${label}`,
            api: "openai-responses",
            baseUrl: `https://generation-${label.toLowerCase()}.example.test/v1`,
          },
        };
      },
    );
    compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      createAuthProfileStoreFixture({
        "local-proxy:stale": createApiKeyCredential("local-proxy", "stale-key"),
      }),
    );
    const profilePlan = {
      providerForAuth: "local-proxy",
      authProfileProviderForAuth: "local-proxy",
      forwardedAuthProfileId: "local-proxy:stale",
      forwardedAuthProfileSource: "auto" as const,
      selectedAuthMode: "api_key" as const,
    };
    const directPlan = {
      providerForAuth: "local-proxy",
      authProfileProviderForAuth: "local-proxy",
      selectedAuthMode: "api_key" as const,
    };
    compactAuthMocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
      plan: profilePlan,
      attempts: [
        {
          kind: "profile" as const,
          profileId: "local-proxy:stale",
          plan: profilePlan,
          allowAuthProfileFallback: false,
        },
        { kind: "direct" as const, plan: directPlan, requiresPriorProfileAttempt: true },
      ],
    });
    compactAuthMocks.getApiKeyForModelCore.mockImplementation(async (params) => {
      if (params.profileId === "local-proxy:stale") {
        publishCurrentModelGeneration(generationB);
        throw new Error("stale profile");
      }
      return { apiKey: "direct-key", source: "direct", mode: "api-key" };
    });
    await withOwnedHarnessGeneration(
      generationA,
      () => registerTestCompactor({ id: "copilot", provider: "local-proxy" }),
      async (compact) => {
        const options = { preparedModelRuntime: generationA.preparedModelRuntime };
        await expect(
          compactSession(
            {
              config: cfg,
              provider: "local-proxy",
              model: "proxy-model",
              agentHarnessId: "copilot",
            },
            options,
          ),
        ).resolves.toEqual({ ok: true, compacted: false });

        expect(getActivePluginRegistry()).toBe(generationB.pluginRegistry);
        expect(compactAuthMocks.resolveModelAsync).toHaveBeenCalledTimes(2);
        expect(compact).toHaveBeenCalledWith(
          expect.objectContaining({
            runtimeModel: expect.objectContaining({
              name: "Runtime A",
              api: "openai-responses",
              baseUrl: "https://generation-a.example.test/v1",
            }),
          }),
        );
      },
    );
  });

  it("does not compact a selected plugin harness through OpenClaw when the plugin has no compactor", async () => {
    registerFailingCodexHarness();

    await expect(
      compactSession({
        provider: "codex",
        agentHarnessId: "codex",
      }),
    ).resolves.toEqual({
      ok: false,
      compacted: false,
      reason: 'Agent harness "codex" does not support compaction.',
      failure: { reason: "unsupported_harness_compaction" },
    });
  });

  it("keeps compaction policy separate from an omitted execution key", async () => {
    const sessionKey = undefined;
    const compact = registerTestCompactor();

    await expect(
      compactSession({
        sessionKey,
        sandboxSessionKey: "agent:strict:main",
        agentId: "main",
        config: agentModelRuntimeConfig("openai/gpt-5.5", "codex", "strict"),
      }),
    ).resolves.toEqual({ ok: true, compacted: false });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]?.[0]).toMatchObject({ agentId: "main" });
  });

  it("keeps explicit agent id for non-agent sandbox policy keys during compaction preflight", async () => {
    const compact = registerTestCompactor();

    await expect(
      compactSession({
        sessionKey: "agent:strict:main",
        sandboxSessionKey: "global",
        agentId: "strict",
        config: agentModelRuntimeConfig("openai/gpt-5.5", "codex", "strict"),
      }),
    ).resolves.toEqual({ ok: true, compacted: false });
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("returns OpenClaw for an explicit provider-owned CLI runtime alias", () => {
    const provider = "anthropic",
      modelId = "sonnet-4.6",
      alias = "claude-cli";
    expect(
      selectAgentHarness({
        provider,
        modelId,
        agentHarnessRuntimeOverride: alias,
      }).id,
    ).toBe("openclaw");
  });

  it("still throws MissingAgentHarnessError for an explicit CLI alias owned by another provider", () => {
    expect(() =>
      selectAgentHarness({
        provider: "anthropic",
        modelId: "sonnet-4.6",
        agentHarnessRuntimeOverride: "google-gemini-cli",
      }),
    ).toThrow('Requested agent harness "google-gemini-cli" is not registered');
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
