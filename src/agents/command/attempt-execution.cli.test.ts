import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGeneratedMediaTaskActivity } from "../../agents/media-generation-activity.js";
import { persistAcpDispatchTranscript } from "../../auto-reply/reply/dispatch-acp-transcript.runtime.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  McpLoopbackToolCache,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agent-run-terminal-outcome.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "../auth-profiles/credential-fixtures.test-support.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import { closeAuthProfileReadPool } from "../auth-profiles/sqlite.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { buildCliRunResult } from "../cli-runner/cli-run-settlement.js";
import { buildCliMcpGrantContext } from "../cli-runner/mcp-grant-context.js";
import { prepareCliRunTerminalReply } from "../cli-runner/terminal-reply.js";
import type { RunCliAgentParams } from "../cli-runner/types.js";
import { createCronCreatorAuthorityCapability } from "../cron-creator-authority-context.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../embedded-agent-runner/result-fallback-classifier.js";
import type { RunEmbeddedAgentInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { FailoverError } from "../failover-error.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../failover/user-copy.js";
import { LiveSessionModelSwitchError } from "../live-model-switch-error.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import { buildConfiguredModelCatalog } from "../model-selection-shared.js";
import { installSessionPlacementAdmissionProvider } from "../session-placement-admission.js";
import {
  createSubagentAnnounceConfig,
  createCompletionHandoff,
  createSubagentAnnounceHandoffOptions,
  createSubagentAnnounceSessionStore,
  SUBAGENT_ANNOUNCE_CLAUDE_CLI_DELIVERY_CASES,
  SUBAGENT_ANNOUNCE_EMBEDDED_DELIVERY_CASES,
} from "./attempt-execution.announce.test-support.js";
import {
  cliRuntimeConfig,
  registerCommandCliAdmissionTests,
  createCliImageCapabilityPlugins,
  makeCliResult,
  makeRunAgentAttemptParams,
  makeSessionEntry,
  resetCliAttemptFixtureDatabases,
  runTrustedClaudeCompletionForTest,
  type RunAgentAttemptOverrides,
  type RunAgentAttemptParams,
  saveTestAuthProfiles,
} from "./attempt-execution.cli.test-support.js";
import { runAgentAttempt as runAgentAttemptImpl } from "./attempt-execution.js";
import { registerCommandReplyPolicyTests } from "./attempt-execution.reply-policy.test-support.js";
import {
  restrictedCompletionCases,
  type RestrictedCompletion,
} from "./attempt-execution.restricted-completion.test-fixtures.js";
import { registerSandboxedDelegatedCliTests } from "./attempt-execution.sandbox-cli.test-support.js";
import { resolveClaudeCliProjectDirForWorkspace } from "./claude-cli-project-dir.js";
import { resolveEmbeddedModelSelection } from "./model-selection.js";
import { persistAcpTurnTranscript, persistCliTurnTranscript } from "./transcript-persistence.js";

const runAgentAttempt = (params: RunAgentAttemptOverrides) => {
  const prepared = makeRunAgentAttemptParams(params);
  setRuntimeConfigSnapshot(prepared.cfg);
  return runAgentAttemptImpl(prepared);
};

const runCliAgentMock = vi.hoisted(() => vi.fn());
const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());
const executePreparedCliRunMock = vi.hoisted(() => vi.fn());
const hasClaudeSessionMock = vi.hoisted(() => vi.fn(() => false));
vi.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("../cli-runner/execute.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli-runner/execute.runtime.js")>()),
  executePreparedCliRun: executePreparedCliRunMock,
}));

vi.mock("../cli-runner/cli-live-session-registry.js", () => ({
  getCliLiveSessionGeneration: vi.fn(() => undefined),
  hasCliLiveSession: hasClaudeSessionMock,
}));

vi.mock("../model-selection.js", async () => ({
  ...(await vi.importActual<typeof import("../model-selection.js")>("../model-selection.js")),
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) => {
    const normalized = provider.trim().toLowerCase();
    return ["claude-cli", "codex-cli", "google-gemini-cli"].includes(normalized);
  },
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../model-runtime-aliases.js", async () => {
  const actual = await vi.importActual<typeof import("../model-runtime-aliases.js")>(
    "../model-runtime-aliases.js",
  );
  return {
    ...actual,
    resolveCliRuntimeExecutionProvider: ({
      provider,
      cfg,
      modelId,
    }: {
      provider?: string;
      cfg?: OpenClawConfig;
      modelId?: string;
    }) => {
      const key = provider && modelId ? `${provider}/${modelId}` : undefined;
      // Runtime alias tests only need the model-level runtime override path;
      // keeping the mock narrow avoids loading provider catalogs here.
      const runtime = key
        ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
        : undefined;
      return runtime || provider;
    },
  };
});

vi.mock("../embedded-agent.js", () => ({
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

type TranscriptReadTarget =
  | string
  | { agentId: string; sessionId: string; sessionKey: string; storePath: string };

async function readSessionMessages(target: TranscriptReadTarget) {
  return (await readTranscriptEntries(target))
    .filter((entry) => entry.type === "message")
    .map((entry) => requireRecord(entry.message, "transcript message"));
}

async function readTranscriptEntries(target: TranscriptReadTarget) {
  const scope =
    typeof target === "string"
      ? expectDefined(parseSqliteSessionFileMarker(target), "SQLite transcript marker")
      : target;
  return (await loadTranscriptEvents(scope)).map((entry) =>
    requireRecord(entry, "transcript entry"),
  );
}

const requireRecord = createRequireRecord("object", "label-not-object");

function requireMockArg(mock: ReturnType<typeof vi.fn>, callIndex: number, label: string) {
  return requireRecord(expectDefined(mock.mock.calls[callIndex]?.[0], label), label);
}

function expectMockArgFields(
  mock: ReturnType<typeof vi.fn>,
  fields: Record<string, unknown>,
  callIndex = 0,
) {
  expect(requireMockArg(mock, callIndex, "mock call argument")).toEqual(
    expect.objectContaining(fields),
  );
}

function firstRunCliAgentArg(callIndex = 0) {
  return requireMockArg(runCliAgentMock, callIndex, "run CLI agent argument");
}

function firstEmbeddedAgentArg(callIndex = 0) {
  return requireMockArg(runEmbeddedAgentMock, callIndex, "embedded OpenClaw agent argument");
}

function cliRetry(run: RunCliAgentParams, sessionId: string, fork = false) {
  return expectDefined(
    fork ? run.onBeforeForkedCliSessionRetry : run.onBeforeFreshCliSessionRetry,
    fork ? "fork recovery" : "fresh recovery",
  )({ provider: "claude-cli", reason: "timeout", sessionId });
}

async function persistFork(run: RunCliAgentParams, sessionId: string) {
  await expectDefined(run.claimCliSessionFork, "fork claim")();
  await expectDefined(run.persistCliSessionForkSuccessor, "fork persistence")(sessionId);
}

function settledCliResult(
  context: Parameters<typeof buildCliRunResult>[0]["context"],
  output: Parameters<typeof buildCliRunResult>[0]["output"],
  effectiveCliSessionId: string,
  bindingFlushOk = true,
) {
  return buildCliRunResult({
    context,
    output,
    preparedReply: prepareCliRunTerminalReply(context, output),
    effectiveCliSessionId,
    bindingFlushOk,
    usedHistoryPrompt: false,
    userTurnHandled: true,
    sessionBindingDisabled: false,
    preparedContextAgentMeta: {},
  });
}

describe("CLI attempt execution", () => {
  const fixtureRoot = createSuiteTempRootTracker({ prefix: "openclaw-cli-attempt-suite-" });
  let suiteRoot: string;
  let agentDir: string;
  let tmpDir: string;
  let storePath: string;
  let homeEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeAll(async () => {
    suiteRoot = await fixtureRoot.setup();
    agentDir = path.join(suiteRoot, "agents", "main", "agent");
    storePath = path.join(suiteRoot, "sessions.json");
    await fs.mkdir(agentDir, { recursive: true });
  });

  async function runOpenClawEmbeddedAttemptForTest(
    overrides: Omit<
      Partial<RunAgentAttemptOverrides>,
      "agentDir" | "workspaceDir" | "sessionEntry"
    > & {
      config?: OpenClawConfig;
      sessionEntry?: Partial<SessionEntry>;
      additionalSessionEntries?: Record<string, Partial<SessionEntry>>;
    } = {},
  ) {
    const {
      runId = "run-embedded-live-stream-gate",
      sessionKey = `agent:main:direct:${runId}`,
      sessionEntry: entry,
      additionalSessionEntries = {},
      config = { session: { store: storePath } },
      opts,
      ...attempt
    } = overrides;
    const sessionEntry = makeSessionEntry(`session-${runId}`, entry);
    const sessionStore = { [sessionKey]: sessionEntry };
    for (const [additionalSessionKey, additionalEntry] of Object.entries(
      additionalSessionEntries,
    )) {
      sessionStore[additionalSessionKey] = makeSessionEntry(
        `${additionalSessionKey}-session`,
        additionalEntry,
      );
    }
    await writeSessionStoreSeed(sessionStore);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);
    await runStoredAttempt({
      originalProvider: "openai",
      cfg: config,
      sessionEntry,
      sessionKey,
      sessionFile: path.join(tmpDir, `${runId}.jsonl`),
      body: "stream gate",
      runId,
      opts: {
        message: "stream gate",
        ...opts,
      },
      messageChannel: "telegram",
      sessionStore,
      ...attempt,
    });

    return firstEmbeddedAgentArg(runEmbeddedAgentMock.mock.calls.length - 1);
  }

  beforeEach(async () => {
    homeEnvSnapshot = captureEnv(["HOME", "OPENCLAW_STATE_DIR", "CLAUDE_CONFIG_DIR"]);
    deleteTestEnvValue("CLAUDE_CONFIG_DIR");
    setTestEnvValue("OPENCLAW_STATE_DIR", suiteRoot);
    setRuntimeConfigSnapshot({ session: { store: storePath } });
    tmpDir = await fixtureRoot.make();
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock.mockReset();
    executePreparedCliRunMock.mockReset();
    resetGeneratedMediaTaskActivityForTests();
    hasClaudeSessionMock.mockReset();
    hasClaudeSessionMock.mockReturnValue(false);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolvePluginSetupRegistry: () => ({ cliBackends: [] }) as never,
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude", forkArg: "--fork-session" },
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

  async function writeSessionStoreSeed(sessionStore: Record<string, SessionEntry>): Promise<void> {
    for (const [sessionKey, entry] of Object.entries(sessionStore)) {
      await replaceSessionEntry({ sessionKey, storePath }, entry);
    }
  }

  async function seedSessionStore(sessionKey: string, sessionEntry: SessionEntry) {
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed(sessionStore);
    return sessionStore;
  }

  function runStoredAttempt(
    overrides: Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">,
  ) {
    return runAgentAttempt({ workspaceDir: tmpDir, agentDir, storePath, ...overrides });
  }

  function transcriptContext(sessionKey: string, sessionEntry: SessionEntry) {
    return {
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionEntry,
      storePath,
      sessionAgentId: "main",
      sessionCwd: tmpDir,
      config: {},
    };
  }

  function transcriptTarget(sessionKey: string, sessionEntry: SessionEntry) {
    return { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath };
  }

  function transcriptFixture(sessionKey: string, sessionEntry = makeSessionEntry("transcript")) {
    const context = transcriptContext(sessionKey, sessionEntry);
    const target = transcriptTarget(sessionKey, sessionEntry);
    const sessionStore = { [sessionKey]: sessionEntry };
    return {
      sessionEntry,
      sessionStore,
      target,
      seed: () => writeSessionStoreSeed(sessionStore),
      messages: () => readSessionMessages(target),
      persist: (
        params: Omit<Parameters<typeof persistCliTurnTranscript>[0], keyof typeof context>,
      ) => persistCliTurnTranscript({ ...context, ...params }),
    };
  }

  function claudeBinding(entry: SessionEntry | undefined) {
    return entry?.cliSessionBindings?.["claude-cli"];
  }

  function expectBindings(store: Record<string, SessionEntry>, key: string, expected: unknown) {
    for (const entry of [store[key], readSessionStore()[key]]) {
      expect(claudeBinding(entry)).toEqual(expected);
    }
  }

  function expectBindingIds(store: Record<string, SessionEntry>, key: string, id: string) {
    for (const entry of [store[key], readSessionStore()[key]]) {
      expect(claudeBinding(entry)?.sessionId).toBe(id);
    }
  }

  function readSessionStore(): Record<string, SessionEntry> {
    return Object.fromEntries(
      listSessionEntriesCore({ storePath }).map(({ entry, sessionKey }) => [sessionKey, entry]),
    );
  }

  afterEach(async () => {
    vi.useRealTimers();
    cliBackendsTesting.resetDepsForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    clearSessionStoreCacheForTest();
    resetCliAttemptFixtureDatabases(suiteRoot);
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(storePath, { force: true });
    clearRuntimeConfigSnapshot();
    homeEnvSnapshot?.restore();
    homeEnvSnapshot = undefined;
  });

  afterAll(async () => {
    await cleanupSessionStateForTest({ stateDir: suiteRoot });
    await fixtureRoot.cleanup();
  });

  async function createCliSession(
    sessionKey: string,
    sessionEntry = makeSessionEntry(`session-${sessionKey.split(":").at(-1)}`),
  ) {
    const sessionStore = await seedSessionStore(sessionKey, sessionEntry);
    let attemptNumber = 0;
    const runCli = (
      params: Omit<
        Partial<RunAgentAttemptOverrides>,
        "agentDir" | "workspaceDir" | "sessionKey" | "storePath"
      > & {
        cwd?: string;
        abortSignal?: AbortSignal;
        onExecutionStarted?: () => void;
        onAgentEvent?: RunAgentAttemptParams["onAgentEvent"];
        classifyResult?: RunAgentAttemptParams["classifyResult"];
      } = {},
    ) => {
      const { abortSignal, onExecutionStarted, opts, ...attempt } = params;
      return runStoredAttempt({
        providerOverride: "claude-cli",
        modelOverride: "opus",
        body: "continue",
        runId: `run-${sessionEntry.sessionId}-${++attemptNumber}`,
        sessionEntry,
        sessionKey,
        sessionStore,
        opts: { onExecutionStarted, abortSignal, ...opts },
        ...attempt,
      });
    };
    return { sessionKey, sessionEntry, sessionStore, runCli };
  }

  async function createBoundSession(
    sessionKey: string,
    cliSessionId: string,
    options: {
      fork?: boolean;
      cwd?: string;
      homeDir?: string;
      transcript?: boolean;
      binding?: NonNullable<SessionEntry["cliSessionBindings"]>[string];
    } = {},
  ) {
    if (options.transcript !== false) {
      await writeClaudeCliAssistantTranscript(cliSessionId, options.homeDir, options.cwd);
    }
    const sessionEntry = makeClaudeCliSessionEntry(
      `session-${sessionKey.split(":").at(-1)}`,
      cliSessionId,
    );
    if (options.fork) {
      sessionEntry.cliSessionBindings!["claude-cli"]!.forkNextResume = true;
    }
    if (options.binding) {
      sessionEntry.cliSessionBindings!["claude-cli"] = options.binding;
    }
    return createCliSession(sessionKey, sessionEntry);
  }

  registerCommandCliAdmissionTests({
    runStoredAttempt,
    seedSessionStore,
    runCliAgentMock,
    createCliSession,
    firstRunCliAgentArg,
  });

  it.each(["updated", "replaced", "revised"])(
    "refreshes a %s session after CLI placement admission",
    async (change) => {
      const sessionKey = "agent:main:cli-admission";
      const sessionEntry = {
        ...makeClaudeCliSessionEntry("admitted-session", "old-native-session"),
        lifecycleRevision: "admitted-revision",
      };
      const { runCli } = await createCliSession(sessionKey, sessionEntry);
      hasClaudeSessionMock.mockReturnValue(true);
      runCliAgentMock.mockResolvedValueOnce(makeCliResult("completion delivered"));
      const admittedEntry: SessionEntry = {
        ...sessionEntry,
        sessionId: change === "replaced" ? "replacement-session" : sessionEntry.sessionId,
        lifecycleRevision:
          change === "revised" ? "replacement-revision" : sessionEntry.lifecycleRevision,
        permissionMode: "read-only",
        cliSessionBindings: {
          "claude-cli": { sessionId: "new-native-session", authProfileId: "anthropic:claude-cli" },
        },
      };
      const uninstall = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed: () => {},
        executeLocalTurn: async (_claim, runLocal) => {
          await replaceSessionEntry({ sessionKey, storePath }, admittedEntry);
          return await runLocal();
        },
        executeTurn: async (_claim, _params, runLocal) => await runLocal(),
      });
      try {
        const run = runCli();
        if (change !== "updated") {
          await expect(run).rejects.toMatchObject({ code: "AGENT_RUN_SUPERSEDED_ABORT" });
          expect(runCliAgentMock).not.toHaveBeenCalled();
          return;
        }
        await run;
        expect(firstRunCliAgentArg()).toMatchObject({
          cliSessionId: "new-native-session",
          cliSessionBinding: { sessionId: "new-native-session" },
          sessionEntry: { permissionMode: "read-only" },
        });
      } finally {
        uninstall();
      }
    },
  );

  async function writeClaudeCliAssistantTranscript(
    cliSessionId: string,
    homeDir = path.join(tmpDir, `home-${cliSessionId}`),
    workspaceDir = tmpDir,
    text = "old reply",
  ) {
    // Claude stores resumable sessions under a workspace-derived project dir,
    // so stale-session tests must create the same on-disk shape.
    const projectsDir = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir,
      homeDir,
    });
    setTestEnvValue("HOME", homeDir);
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, `${cliSessionId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
      })}\n`,
      "utf-8",
    );
  }

  async function runOuterCliFallback(params: {
    suppression?: "preserved-state";
    sessionKey: string;
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    runId: string;
    configuredSelection?: {
      cfg: OpenClawConfig;
      opts: RunAgentAttemptParams["opts"];
      metadataSnapshot: PluginMetadataSnapshot;
    };
  }) {
    const [
      { getAcpSessionManager },
      { prepareAgentCommandExecutionIdentity },
      { runEmbeddedAgentAttempt },
    ] = await Promise.all([
      import("../../acp/control-plane/manager.js"),
      import("../agent-command-execution-identity.js"),
      import("./run-embedded-attempt.js"),
    ]);
    const cfg: OpenClawConfig = params.configuredSelection?.cfg ?? {
      agents: {
        defaults: { model: { primary: "claude-cli/sonnet", fallbacks: ["claude-cli/opus"] } },
      },
    };
    const opts =
      params.configuredSelection?.opts ??
      ({
        message: "outer fallback",
        modelFallbacksOverride: ["claude-cli/opus"],
      } satisfies RunAgentAttemptParams["opts"]);
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const manifestMetadataSnapshot = params.configuredSelection?.metadataSnapshot;
    const modelManifestContext = { manifestPlugins: manifestMetadataSnapshot ?? [] };
    const configuredThinkingCatalog = params.configuredSelection
      ? buildConfiguredModelCatalog({ cfg, ...modelManifestContext })
      : [];
    const prepared: Parameters<typeof runEmbeddedAgentAttempt>[0]["prepared"] = {
      ...params,
      opts,
      cfg,
      body: opts.message,
      transcriptBody: opts.message,
      configuredThinkingCatalog,
      normalizedSpawned: {},
      agentCfg: undefined,
      thinkOverride: undefined,
      thinkOnce: undefined,
      verboseOverride: undefined,
      timeoutMs: 10_000,
      runTimeoutOverrideMs: undefined,
      sessionId: params.sessionEntry.sessionId,
      storePath,
      isNewSession: false,
      previousSessionId: undefined,
      persistedThinking: undefined,
      persistedVerbose: undefined,
      sessionAgentId: "main",
      outboundSession: undefined,
      workspaceDir: tmpDir,
      cwd: undefined,
      agentDir,
      pluginsEnabled: params.configuredSelection !== undefined,
      manifestMetadataSnapshot,
      modelManifestContext,
      isSubagentLane: isSubagentSessionKey(params.sessionKey),
      acpManager: getAcpSessionManager(),
      acpResolution: null,
      runLease: undefined,
    };
    const modelSelection: Parameters<typeof runEmbeddedAgentAttempt>[0]["modelSelection"] =
      params.configuredSelection
        ? await resolveEmbeddedModelSelection({
            ...prepared,
            requestedThinkLevel: "off",
            isSubagentLane: isSubagentSessionKey(params.sessionKey),
            suppressVisibleSessionEffects: false,
            runContext: {},
          })
        : {
            sessionEntry: params.sessionEntry,
            provider: "claude-cli",
            model: "sonnet",
            requestedRouteResolution: "resolved",
            defaultProvider: "claude-cli",
            defaultModel: "sonnet",
            configuredDefaultAuthProfileId: undefined,
            providerForAuthProfileValidation: "claude-cli",
            hasExplicitRunOverride: false,
            storedProviderOverride: undefined,
            storedModelOverride: undefined,
            storedModelOverrideSource: undefined,
            hasStoredAutoFallbackProvenance: false,
            autoFallbackPrimaryProbe: undefined,
            sessionEntryForAttempt: params.sessionEntry,
            thinkingCatalog: [],
            immutableThinkLevel: "off",
            effectiveTurnThinkLevel: "off",
            sessionFile: path.join(tmpDir, "session.jsonl"),
          };
    const selectedPrepared = {
      ...prepared,
      sessionEntry: modelSelection.sessionEntry,
    };
    const admission = prepareAgentCommandExecutionIdentity({
      opts,
      prepared: selectedPrepared,
      ingress: { kind: "system", boundary: "cold-cli-fallback-test", state: "present" },
      lifecycleGeneration,
    });
    try {
      return await withSessionTurn(
        {
          sessionKey: params.sessionKey,
          sessionId: selectedPrepared.sessionId,
          agentId: selectedPrepared.sessionAgentId,
          storePath,
          abortSignal: opts.abortSignal,
        },
        async (replyOperation) => {
          const admittedOpts = {
            ...opts,
            replyOperation,
            abortSignal: replyOperation?.abortSignal ?? opts.abortSignal,
          };
          const attempt = await runEmbeddedAgentAttempt({
            preparedRunAdmission: admission,
            prepared: { ...selectedPrepared, opts: admittedOpts },
            opts: admittedOpts,
            sessionEntry: selectedPrepared.sessionEntry,
            lifecycleGeneration,
            onLifecycleGenerationChanged: () => {},
            suppressVisibleSessionEffects: false,
            preserveUserFacingSessionModelState: params.suppression === "preserved-state",
            trackInternalModelRunTarget: () => {},
            embeddedSessionState: {
              sessionEntry: selectedPrepared.sessionEntry,
              requestedThinkLevel: "off",
              resolvedVerboseLevel: undefined,
              skillsSnapshot: { prompt: "", skills: [] },
              runContext: {},
            },
            modelSelection,
          });
          try {
            await attempt.fallbackTrajectoryRecorder?.flush();
            return attempt;
          } finally {
            await attempt.deferredLifecycle.complete();
          }
        },
      );
    } finally {
      await admission.finish();
    }
  }

  it.each([
    "implicit configured primary",
    "live model switch",
    "canonical override repair",
  ] as const)("retains CLI image capability after a thinking-off %s", async (transition) => {
    const canonicalRepair = transition === "canonical override repair";
    const model = canonicalRepair ? "custom/child" : "claude-sonnet-4-6";
    const modelRef = `anthropic/${model}`;
    const implicitPrimary = transition === "implicit configured primary";
    const sessionKey = implicitPrimary
      ? "agent:main:discord:channel:vision-fixture"
      : "agent:main:subagent:vision-fixture";
    const sessionEntry = makeSessionEntry(
      `vision-${transition}`,
      implicitPrimary
        ? { groupId: "vision-fixture", chatType: "group" }
        : {
            providerOverride: "custom",
            modelOverride: "child",
            modelOverrideSource: "auto",
            modelOverrideRouteResolution: "resolved",
            modelOverrideFallbackOriginProvider: "custom",
            modelOverrideFallbackOriginModel: "child",
          },
    );
    const sessionStore = { [sessionKey]: sessionEntry };
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        entries: { main: { workspace: tmpDir } },
        defaults: {
          model: {
            primary: implicitPrimary || canonicalRepair ? modelRef : "custom/base",
          },
          modelPolicy: {
            allow: canonicalRepair ? [modelRef] : ["custom/base", "custom/child", modelRef],
          },
          models: { [modelRef]: { agentRuntime: { id: "claude-cli" } } },
          thinkingDefault: "off",
        },
      },
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://custom.invalid/v1",
            apiKey: "synthetic-fixture-key",
            agentRuntime: { id: "openclaw" },
            models: ["base", "child"].map((id): ModelDefinitionConfig => ({
              id,
              name: id,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 1024,
            })),
          },
        },
      },
      ...(implicitPrimary
        ? { channels: { modelByChannel: { discord: { "vision-fixture": "custom/child" } } } }
        : {}),
    };
    const { metadataSnapshot, pluginRegistry } = createCliImageCapabilityPlugins(model);
    setActivePluginRegistry(pluginRegistry);
    const opts: RunAgentAttemptParams["opts"] = {
      message: "Inspect the image after switching models",
      thinking: "off",
      toolsAllow: ["read"],
      ...(implicitPrimary ? { channel: "discord" } : {}),
    };
    const imagePath = path.join(tmpDir, "capability-pixel.png");
    await fs.writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      ),
    );
    await writeSessionStoreSeed(sessionStore);
    if (!canonicalRepair) {
      runEmbeddedAgentMock.mockRejectedValueOnce(
        transition === "live model switch"
          ? new LiveSessionModelSwitchError({ provider: "anthropic", model })
          : new FailoverError("Configured child capacity", {
              reason: "rate_limit",
              provider: "custom",
              model: "child",
            }),
      );
    }
    runCliAgentMock.mockImplementationOnce(async (run: RunCliAgentParams) => {
      expect(run).toMatchObject({
        provider: "claude-cli",
        modelProvider: "anthropic",
        model,
        thinkLevel: "off",
      });
      if (canonicalRepair) {
        expect(run.modelRoutingProvenance).toMatchObject({ stage: "initial" });
      }
      const context = buildCliMcpGrantContext({
        run,
        config: cfg,
        requireExplicitMessageTarget: false,
        agentId: "main",
        modelProvider: expectDefined(run.modelProvider, "CLI model provider"),
        modelId: expectDefined(run.model, "CLI model"),
        toolsAllow: ["read"],
      });
      const scoped = await resolveMcpLoopbackScopedTools({
        cfg,
        context,
        authProfileStore: createAuthProfileStoreFixture({}),
        authProfileStoreAgentDir: agentDir,
      });
      const read = expectDefined(
        scoped.tools.find((tool) => tool.name === "read"),
        "CLI MCP read tool",
      );
      const result = await read.execute("read-fallback-image", { path: imagePath });
      expect(result.content.filter((part) => part.type === "image")).toHaveLength(1);
      expect(context.modelHasVision).toBe(true);
      return makeCliResult("Image inspected", "");
    });
    await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () =>
      runOuterCliFallback({
        sessionKey,
        sessionEntry,
        sessionStore,
        runId: `run-vision-${transition}`,
        configuredSelection: { cfg, opts, metadataSnapshot },
      }),
    );
    if (canonicalRepair) {
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      const repaired = expectDefined(readSessionStore()[sessionKey], "repaired session");
      for (const field of [
        "providerOverride",
        "modelOverride",
        "modelOverrideSource",
        "modelOverrideRouteResolution",
        "modelOverrideFallbackOriginProvider",
        "modelOverrideFallbackOriginModel",
      ]) {
        expect(repaired).not.toHaveProperty(field);
      }
    } else {
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(firstEmbeddedAgentArg()).toMatchObject({ provider: "custom", model: "child" });
    }
    expect(runCliAgentMock).toHaveBeenCalledOnce();
  });

  it.each(["rejected", "rejected-clear", "outer-fallback", "preserved-state"])(
    "settles a cold %s CLI binding before the next queued command starts",
    async (outcome) => {
      const suppression = outcome === "preserved-state" ? outcome : undefined;
      const outerFallback = outcome === "outer-fallback" || suppression !== undefined;
      const accepted = outcome === "accepted" || outerFallback;
      const previousBinding = { sessionId: "previous-native-session" };
      const sessionKey = "agent:main:cli-binding-settlement";
      const sessionEntry = makeSessionEntry("binding-settlement-session");
      if (outcome === "rejected-clear" || suppression) {
        sessionEntry.cliSessionBindings = { "claude-cli": previousBinding };
        await writeClaudeCliAssistantTranscript(
          "previous-native-session",
          path.join(tmpDir, "cold-home"),
        );
      }
      const { sessionStore, runCli } = await createCliSession(sessionKey, sessionEntry);
      await writeClaudeCliAssistantTranscript(
        "settled-native-session",
        path.join(tmpDir, "cold-home"),
      );
      const firstStarted = createDeferredCore();
      const finishFirst = createDeferredCore();
      const binding = {
        sessionId: "settled-native-session",
        authProfileId: "anthropic:claude-cli",
      };
      if (outerFallback) {
        runCliAgentMock.mockRejectedValueOnce(
          new FailoverError("primary capacity", {
            reason: "rate_limit",
            provider: "claude-cli",
            model: "sonnet",
          }),
        );
      }
      runCliAgentMock
        .mockImplementationOnce(async () => {
          firstStarted.resolve();
          await finishFirst.promise;
          const result = makeCliResult("parent completed");
          if (!accepted) {
            result.payloads = [{ text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT }];
            result.meta.finalAssistantVisibleText = GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
          }
          if (outcome === "rejected-clear") {
            result.meta.agentMeta!.clearCliSessionBinding = true;
          }
          result.meta.agentMeta!.cliSessionBinding = binding;
          result.meta.agentMeta!.sessionId = binding.sessionId;
          return result;
        })
        .mockResolvedValueOnce(makeCliResult("follow-up completed"));
      const run = (runId: string) =>
        runCli({
          body: runId,
          runId,
          classifyResult: (result) =>
            classifyEmbeddedAgentRunResultForModelFallback({
              result,
              provider: "claude-cli",
              model: "opus",
            }),
        });
      const first = outerFallback
        ? runOuterCliFallback({
            sessionKey,
            sessionEntry,
            sessionStore,
            runId: "binding-parent",
            suppression,
          })
        : run("binding-parent");
      await Promise.race([
        firstStarted.promise,
        first.then(() => {
          throw new Error("first command settled before its CLI started");
        }),
      ]);
      if (outcome === "rejected-clear") {
        expect(firstRunCliAgentArg().cliSessionId).toBe("previous-native-session");
      }
      const second = run("binding-follow-up");
      finishFirst.resolve();
      await Promise.all([first, second]);

      if (outerFallback) {
        expect(firstRunCliAgentArg(0).model).toBe("sonnet");
        expect(firstRunCliAgentArg(1).model).toBe("opus");
      }
      const expectedBinding = suppression ? previousBinding : accepted ? binding : undefined;
      expect(firstRunCliAgentArg(outerFallback ? 2 : 1)).toMatchObject({
        cliSessionId: expectedBinding?.sessionId,
        cliSessionBinding: expectedBinding,
      });
    },
  );

  it("retains rejected-clear CLI output without replay when continuity settlement loses its owner", async () => {
    const { sessionKey, sessionEntry, sessionStore } = await createCliSession(
      "agent:main:cli-settlement-owner-loss",
    );
    const runId = "cli-settlement-owner-loss-run";
    const output = {
      text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      rawText: "Captured raw action result",
      sessionId: "captured-native-session",
      usage: { input: 71, output: 9, total: 80 },
    };
    const context = buildPreparedCliRunContext({
      sessionId: sessionEntry.sessionId,
      sessionKey,
      runId,
      workspaceDir: tmpDir,
    });
    const cliResult = settledCliResult(context, output, output.sessionId, false);
    const provider: Parameters<typeof installSessionPlacementAdmissionProvider>[0] = {
      assertCompactionSuccessorAllowed: () => {},
      executeLocalTurn: async (_claim, runLocal) => await runLocal(),
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    };
    const uninstallOriginal = installSessionPlacementAdmissionProvider(provider);
    let uninstallReplacement: (() => void) | undefined;
    runCliAgentMock
      .mockImplementationOnce(async (runParams: RunCliAgentParams) => {
        // Replace the placement owner after effects, without aborting the turn.
        uninstallReplacement = installSessionPlacementAdmissionProvider({ ...provider });
        expect(runParams.abortSignal?.aborted).toBe(false);
        return cliResult;
      })
      .mockResolvedValueOnce(makeCliResult("Unexpected replay"));
    try {
      const attempt = await runOuterCliFallback({ sessionKey, sessionEntry, sessionStore, runId });
      expect.soft(runCliAgentMock).toHaveBeenCalledOnce();
      expect.soft(attempt.result.payloads).toContainEqual({ text: output.text });
      expect.soft(attempt.result.meta).toMatchObject({
        replayInvalid: true,
        finalAssistantVisibleText: output.text,
        finalAssistantRawText: output.rawText,
        agentMeta: { usage: output.usage, lastCallUsage: output.usage },
        error: {
          message: expect.stringContaining("CLI session continuity could not be saved"),
          fallbackSafe: false,
        },
      });
      expect.soft(attempt.terminal.outcome.status).toBe("error");
      expect
        .soft(claudeBinding(readSessionStore()[sessionKey])?.sessionId)
        .not.toBe(output.sessionId);
    } finally {
      uninstallReplacement?.();
      uninstallOriginal();
    }
  });

  function makeClaudeCliSessionEntry(
    openclawSessionId: string,
    cliSessionId: string,
  ): SessionEntry {
    return {
      sessionId: openclawSessionId,
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: cliSessionId,
          authProfileId: "anthropic:claude-cli",
        },
      },
      cliSessionIds: { "claude-cli": cliSessionId },
      claudeCliSessionId: cliSessionId,
    };
  }

  it("preserves and resumes a valid Claude CLI binding after format failover", async () => {
    const sessionKey = "agent:main:subagent:cli-format";
    const cliSessionId = "format-retry-session";
    const cwd = path.join(tmpDir, "task");
    const { sessionStore, runCli } = await createBoundSession(sessionKey, cliSessionId, { cwd });

    runCliAgentMock.mockImplementationOnce(async () => {
      expectBindingIds(sessionStore, sessionKey, cliSessionId);
      throw new FailoverError("Claude CLI returned an unusable result", {
        reason: "format",
        code: "cli_synthetic_no_response",
        provider: "claude-cli",
        model: "opus",
      });
    });

    await expect(runCli({ cwd })).rejects.toMatchObject({
      name: "FailoverError",
      reason: "format",
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(firstRunCliAgentArg()).toMatchObject({ cwd, cliSessionId });
    runCliAgentMock.mockResolvedValueOnce(
      makeCliResult("hello after retained resume", cliSessionId),
    );

    await runCli({ cwd });

    expect(runCliAgentMock).toHaveBeenCalledTimes(2);
    expect(firstRunCliAgentArg(1).cliSessionId).toBe(cliSessionId);
    expectBindingIds(sessionStore, sessionKey, cliSessionId);
  });

  it.each([
    { reason: "aborted", replacement: false },
    { reason: "timeout", replacement: true },
  ] as const)(
    "settles returned $reason partial output with replacement=$replacement before the next turn",
    async ({ reason, replacement }) => {
      const sessionKey = "agent:main:direct:cli-partial-interruption";
      const cliSessionId = "established-session";
      const successorCliSessionId = "unfinished-successor";
      const homeDir = path.join(tmpDir, "home");
      await writeClaudeCliAssistantTranscript(successorCliSessionId, homeDir);
      const { sessionEntry, sessionStore, runCli } = await createBoundSession(
        sessionKey,
        cliSessionId,
        {
          homeDir,
          fork: replacement,
        },
      );
      const controller = new AbortController();
      runCliAgentMock.mockImplementationOnce(async (runParams: RunCliAgentParams) => {
        expect(runParams.cliSessionId).toBe(cliSessionId);
        if (replacement) {
          expect(await runParams.claimCliSessionFork?.()).toBe(true);
          await runParams.persistCliSessionForkSuccessor?.(successorCliSessionId);
          expect(claudeBinding(readSessionStore()[sessionKey])).toEqual({
            sessionId: successorCliSessionId,
            authProfileId: "anthropic:claude-cli",
          });
        }
        controller.abort(
          new DOMException(reason, reason === "timeout" ? "TimeoutError" : "AbortError"),
        );
        expect(runParams.abortSignal?.aborted).toBe(true);
        const context = buildPreparedCliRunContext({
          provider: "claude-cli",
          sessionId: sessionEntry.sessionId,
          sessionKey,
          workspaceDir: tmpDir,
        });
        context.reusableCliSession = { mode: "reuse", sessionId: cliSessionId };
        return settledCliResult(
          context,
          { text: "partial reply", terminalInterruption: { reason } },
          replacement ? successorCliSessionId : cliSessionId,
        );
      });

      await runCli({
        abortSignal: controller.signal,
      });

      const expectedSessionId = replacement ? undefined : cliSessionId;
      const persisted = readSessionStore()[sessionKey];
      expect.soft(claudeBinding(persisted)?.sessionId).toBe(expectedSessionId);
      expect.soft(claudeBinding(persisted)?.forceReuse).toBeUndefined();
      expect.soft(claudeBinding(sessionStore[sessionKey])?.sessionId).toBe(expectedSessionId);
      runCliAgentMock.mockResolvedValueOnce(makeCliResult("continued after interruption"));
      await runCli({
        sessionEntry: sessionStore[sessionKey],
      });

      expect(runCliAgentMock).toHaveBeenCalledTimes(2);
      expect(firstRunCliAgentArg(1).cliSessionId).toBe(expectedSessionId);
    },
  );

  it("clears a fork-marked Claude CLI session after terminal failover", async () => {
    const sessionKey = "agent:main:direct:cli-fork-expired";
    const cliSessionId = "expired-fork-source";
    const { sessionStore, runCli } = await createBoundSession(sessionKey, cliSessionId, {
      fork: true,
    });
    runCliAgentMock.mockRejectedValueOnce(
      new FailoverError("fork source expired", {
        reason: "session_expired",
        provider: "claude-cli",
        model: "opus",
      }),
    );

    await expect(runCli()).rejects.toMatchObject({
      name: "FailoverError",
      reason: "session_expired",
    });

    expect(firstRunCliAgentArg().forkCliSessionOnResume).toBe(true);
    expectBindings(sessionStore, sessionKey, undefined);
  });

  it("refuses fresh CLI recovery when detached media starts during the session read", async () => {
    const sessionKey = "agent:main:direct:cli-retry-media-read";
    const cliSessionId = "media-continuation-session";
    const { sessionStore, runCli } = await createBoundSession(sessionKey, cliSessionId, {
      transcript: false,
    });
    hasClaudeSessionMock.mockReturnValue(true);
    const abortError = Object.assign(new Error("aborted after media admission"), {
      name: "AbortError",
    });
    let retryAllowed: boolean | undefined;
    runCliAgentMock.mockImplementationOnce(async (runArgs: RunCliAgentParams) => {
      const retry = cliRetry(runArgs, cliSessionId);
      // The real session read yields after the initial media check.
      registerGeneratedMediaTaskActivity("tool:image_generate:retry-read", sessionKey);
      retryAllowed = await retry;
      throw abortError;
    });

    await expect(runCli()).rejects.toBe(abortError);

    expect(retryAllowed).toBe(false);
    expectBindingIds(sessionStore, sessionKey, cliSessionId);
  });

  it.each(["fresh recovery", "finalization failure"])(
    "clears a persisted fork successor after %s",
    async (outcome) => {
      const recover = outcome === "fresh recovery";
      const sessionKey = "agent:main:direct:cli-fork-recovery";
      const cliSessionId = "recovery-parent-session";
      const forkedCliSessionId = "recovery-fork-session";
      const { sessionStore, runCli } = await createBoundSession(sessionKey, cliSessionId, {
        fork: true,
      });
      const finalizationError = Object.assign(new Error("fork finalization failed"), {
        name: "AbortError",
      });
      runCliAgentMock.mockImplementationOnce(async (runArgs: RunCliAgentParams) => {
        if (recover) {
          expect(runArgs.forkCliSessionOnResume).toBe(true);
          expect(runArgs.onBeforeForkedCliSessionRetry).toBeUndefined();
          expect(runArgs.onBeforeFreshCliSessionRetry).toBeTypeOf("function");
        }
        await persistFork(runArgs, forkedCliSessionId);
        if (!recover) {
          throw finalizationError;
        }
        await expect(cliRetry(runArgs, forkedCliSessionId)).resolves.toBe(true);
        expect(claudeBinding(sessionStore[sessionKey])).toBeUndefined();
        return makeCliResult("hello after fork timeout");
      });

      if (recover) {
        await runCli();
        expectBindings(sessionStore, sessionKey, { sessionId: "session-cli" });
      } else {
        await expect(runCli()).rejects.toBe(finalizationError);
        expectBindings(sessionStore, sessionKey, undefined);
      }
    },
  );

  it("preserves a restored fork marker before a successor after catalog cancellation", async () => {
    const sessionKey = "agent:main:direct:cli-fork-before-successor-failure";
    const cliSessionId = "recovery-source-session";
    const { sessionStore, runCli } = await createBoundSession(sessionKey, cliSessionId, {
      binding: {
        sessionId: cliSessionId,
        forceReuse: true,
        forkNextResume: true,
        resumeCheckpointId: "source-checkpoint",
      },
    });
    const recoveryError = Object.assign(new Error("fork process died before init"), {
      name: "AbortError",
    });
    const controller = new AbortController();
    runCliAgentMock.mockImplementationOnce(async (runArgs: RunCliAgentParams) => {
      expect(await expectDefined(runArgs.claimCliSessionFork, "fork claim")()).toBe(true);
      expect(claudeBinding(readSessionStore()[sessionKey])?.forkNextResume).toBeUndefined();
      controller.abort(recoveryError);
      expect(runArgs.abortSignal?.aborted).toBe(true);
      await runArgs.restoreCliSessionFork?.();
      throw recoveryError;
    });

    await expect(
      runCli({
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(recoveryError);

    expect.soft(claudeBinding(sessionStore[sessionKey])).toMatchObject({
      sessionId: cliSessionId,
      forkNextResume: true,
    });
    expect.soft(claudeBinding(readSessionStore()[sessionKey])).toMatchObject({
      sessionId: cliSessionId,
      forkNextResume: true,
      forceReuse: true,
      resumeCheckpointId: "source-checkpoint",
    });
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("continued in fork", "fork-successor"));
    await runCli();
    expect(runCliAgentMock).toHaveBeenCalledTimes(2);
    expect(firstRunCliAgentArg(1)).toMatchObject({
      cliSessionId,
      forkCliSessionOnResume: true,
    });
  });

  it("does not clear a concurrent rebind after failed fork recovery", async () => {
    const sessionKey = "agent:main:direct:cli-fork-concurrent-rebind";
    const cliSessionId = "concurrent-parent-session";
    const forkedCliSessionId = "failed-fork-successor";
    const concurrentCliSessionId = "newer-concurrent-session";
    const { sessionEntry, sessionStore, runCli } = await createBoundSession(
      sessionKey,
      cliSessionId,
    );
    const recoveryError = Object.assign(new Error("fork recovery aborted"), {
      name: "AbortError",
    });
    runCliAgentMock.mockImplementationOnce(async (runArgs: RunCliAgentParams) => {
      await cliRetry(runArgs, cliSessionId, true);
      await persistFork(runArgs, forkedCliSessionId);

      const concurrentEntry = makeClaudeCliSessionEntry(
        sessionEntry.sessionId,
        concurrentCliSessionId,
      );
      await replaceSessionEntry({ sessionKey, storePath }, concurrentEntry);
      sessionStore[sessionKey] = concurrentEntry;
      expect(runArgs.onBeforeFreshCliSessionRetry).toBeTypeOf("function");
      await expect(cliRetry(runArgs, forkedCliSessionId)).resolves.toBe(false);
      throw recoveryError;
    });

    await expect(runCli()).rejects.toBe(recoveryError);

    expectBindingIds(sessionStore, sessionKey, concurrentCliSessionId);
  });

  it("preserves a stopped Claude session whose transcript is in CLAUDE_CONFIG_DIR", async () => {
    const sessionKey = "agent:main:direct:claude-config-root";
    const cliSessionId = "configured-root-session";
    const configDir = path.join(tmpDir, "claude-config");
    setTestEnvValue("HOME", path.join(tmpDir, "home"));
    setTestEnvValue("CLAUDE_CONFIG_DIR", configDir);
    const workspaceKey = (await fs.realpath(tmpDir)).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = path.join(configDir, "projects", workspaceKey);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, `${cliSessionId}.jsonl`),
      `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "prior answer" } })}\n`,
    );
    const sessionEntry = makeClaudeCliSessionEntry("configured-root-chat", cliSessionId);
    const { sessionStore, runCli } = await createCliSession(sessionKey, sessionEntry);
    runCliAgentMock.mockImplementationOnce(async () => {
      expectBindingIds(sessionStore, sessionKey, cliSessionId);
      return makeCliResult("continued answer", cliSessionId);
    });

    await runCli();

    expect(firstRunCliAgentArg().cliSessionId).toBe(cliSessionId);
    expect(claudeBinding(readSessionStore()[sessionKey])?.sessionId).toBe(cliSessionId);
  });

  it("clears the persisted Claude CLI binding but still forwards the candidate when the stored transcript is missing", async () => {
    const sessionKey = "agent:main:direct:claude-missing-transcript";
    const homeDir = path.join(tmpDir, "home");
    setTestEnvValue("HOME", homeDir);
    const { sessionStore, runCli } = await createBoundSession(
      sessionKey,
      "phantom-claude-session",
      {
        transcript: false,
      },
    );
    runCliAgentMock.mockImplementationOnce(async () => {
      expectBindings(sessionStore, sessionKey, undefined);
      return makeCliResult("fresh cli response");
    });

    await runCli();

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    // Clear stale continuity without losing the candidate needed by transcript reseeding.
    expectMockArgFields(runCliAgentMock, {
      cliSessionId: "phantom-claude-session",
      cliSessionBinding: {
        sessionId: "phantom-claude-session",
        authProfileId: "anthropic:claude-cli",
      },
    });
    for (const entry of [sessionStore[sessionKey], readSessionStore()[sessionKey]]) {
      expect(claudeBinding(entry)).toEqual({ sessionId: "session-cli" });
      expect(entry?.cliSessionIds?.["claude-cli"]).toBe("session-cli");
      expect(entry?.claudeCliSessionId).toBeUndefined();
    }
  });

  it("keeps the bound claude-cli session id as the reuse candidate when the native transcript is missing (so reseed can recover)", async () => {
    const sessionKey = "agent:main:direct:claude-missing-transcript-reseed";
    const cliSessionId = "cli-sid-abc";
    // A live child keeps both continuity and its candidate despite a missing transcript.
    const homeDir = path.join(tmpDir, "home-missing-transcript");
    const projectsDir = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir: tmpDir,
      homeDir,
    });
    setTestEnvValue("HOME", homeDir);
    await fs.mkdir(projectsDir, { recursive: true });
    const sessionEntry = makeClaudeCliSessionEntry("openclaw-sid", cliSessionId);
    const { sessionStore, runCli } = await createCliSession(sessionKey, sessionEntry);
    hasClaudeSessionMock.mockReturnValue(true);
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("ok", cliSessionId));

    await runCli();

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(runCliAgentMock, {
      cliSessionId,
      cliSessionBinding: { sessionId: cliSessionId, authProfileId: "anthropic:claude-cli" },
    });
    expect(hasClaudeSessionMock).toHaveBeenCalledWith({
      backendId: "claude-cli",
      agentId: "main",
      sessionId: "openclaw-sid",
      sessionKey,
    });
    expectBindingIds(sessionStore, sessionKey, cliSessionId);
  });

  it.each<{
    name: string;
    entry?: Partial<SessionEntry>;
    profiles: () => Parameters<typeof saveTestAuthProfiles>[1];
    order?: NonNullable<OpenClawConfig["auth"]>["order"];
    expectedProfile?: string;
    error?: RegExp;
  }>([
    {
      name: "selects a google-gemini-cli auth profile for canonical Google models routed through Gemini CLI",
      profiles: () => ({
        "google-gemini-cli:user@example.test": createOAuthRefreshCredential({
          provider: "google-gemini-cli",
          expires: Date.now() + 3_600_000,
          email: "user@example.test",
        }),
      }),
      order: { "google-gemini-cli": ["google-gemini-cli:user@example.test"] },
      expectedProfile: "google-gemini-cli:user@example.test",
    },
    {
      name: "forwards pinned canonical Google API-key profiles to Google models routed through Gemini CLI",
      entry: { authProfileOverride: "google:api-key", authProfileOverrideSource: "user" },
      profiles: () => ({
        "google:api-key": createApiKeyCredential("google", "gemini-api-key"),
      }),
      expectedProfile: "google:api-key",
    },
    {
      name: "rejects incompatible pinned profiles before selecting another CLI identity",
      entry: {
        authProfileOverride: "vercel-ai-gateway:default",
        authProfileOverrideSource: "user",
      },
      profiles: () => ({
        "vercel-ai-gateway:default": createApiKeyCredential("vercel-ai-gateway", "vercel-key"),
      }),
      error: /cannot use auth profile "vercel-ai-gateway:default"/,
    },
    {
      name: "ignores stale auto-selected profiles when resolving Gemini CLI auth order",
      entry: { authProfileOverride: "openai:work", authProfileOverrideSource: "auto" },
      profiles: () => ({
        "openai:work": createOAuthRefreshCredential({
          access: "openai-access",
          refresh: "openai-refresh",
        }),
        "google:api-key": createApiKeyCredential("google", "gemini-api-key"),
      }),
      order: { google: ["google:api-key"] },
      expectedProfile: "google:api-key",
    },
  ])("$name", async ({ entry, profiles, order, expectedProfile, error }) => {
    const sessionKey = "agent:main:direct:gemini-cli-auth";
    const sessionEntry = makeSessionEntry("openclaw-session-gemini", entry);
    const sessionStore = error
      ? { [sessionKey]: sessionEntry }
      : await seedSessionStore(sessionKey, sessionEntry);
    saveTestAuthProfiles(agentDir, profiles());
    if (!error) {
      runCliAgentMock.mockResolvedValueOnce(makeCliResult("gemini cli response"));
    }
    const run = () =>
      runStoredAttempt({
        providerOverride: "google",
        modelOverride: "gemini-3.1-pro-preview",
        cfg: {
          ...(order ? { auth: { order } } : {}),
          ...cliRuntimeConfig("google/gemini-3.1-pro-preview", "google-gemini-cli"),
        },
        sessionEntry,
        sessionKey,
        runId: "run-gemini-cli-auth",
        sessionStore,
      });
    if (error) {
      await expect(run()).rejects.toThrow(error);
      expect(runCliAgentMock).not.toHaveBeenCalled();
    } else {
      await run();
      expect(runCliAgentMock).toHaveBeenCalledTimes(1);
      expect(firstRunCliAgentArg()).toMatchObject({
        provider: "google-gemini-cli",
        authProfileId: expectedProfile,
      });
    }
  });

  it("keeps an explicit internal CLI transcript out of the visible session path", async () => {
    const visibleSessionId = "session-explicit-internal-cli";
    const sessionId = `internal-${visibleSessionId}`;
    const sessionKey = `agent:main:internal-session-effects:${visibleSessionId}`;
    setTestEnvValue("HOME", tmpDir);
    const internalSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    await persistCliTurnTranscript({
      body: "internal prompt",
      result: makeCliResult("internal reply"),
      ...transcriptContext(sessionKey, makeSessionEntry(sessionId)),
      sessionFile: internalSessionFile,
    });
    expect(await readSessionMessages(internalSessionFile)).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "internal reply" }],
      }),
    );
    expect(
      await loadTranscriptEvents({ agentId: "main", sessionId: visibleSessionId, storePath }),
    ).toEqual([]);
  });

  it.each([false, true])("persists CLI replies with diagnostic usage=%s", async (diagnostic) => {
    const sessionKey = "agent:main:subagent:cli-transcript";
    const sessionEntry: SessionEntry = {
      sessionId: "session-cli-transcript",
      updatedAt: 1,
      startedAt: 2,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await writeSessionStoreSeed({
      [sessionKey]: {
        ...sessionEntry,
        updatedAt: 5,
        status: "done",
        endedAt: 4,
      },
    });
    clearSessionStoreCacheForTest();

    const result = makeCliResult("hello from cli");
    Object.assign(expectDefined(result.meta.agentMeta, "agent metadata"), {
      usage: { input: 12, output: 4, cacheRead: 3, total: 19 },
      lastCallUsage: { input: 7, output: 4, cacheRead: 2, total: 13 },
      ...(diagnostic
        ? { diagnosticUsage: { input: 6, output: 77, cacheRead: 54_631, total: 54_714 } }
        : {}),
    });
    const beforePersist = Date.now();
    const persistedResult = await persistCliTurnTranscript({
      body: "persist this",
      result,
      ...transcriptContext(sessionKey, sessionEntry),
      sessionStore,
    });
    const afterPersist = Date.now();

    expect(persistedResult.kind).toBe("persisted");
    expect(persistedResult.sessionEntry).not.toHaveProperty("sessionFile");
    const target = transcriptTarget(sessionKey, sessionEntry);
    const entries = await readTranscriptEntries(target);
    expect(entries.slice(0, 3)).toMatchObject([
      { type: "session", id: sessionEntry.sessionId, cwd: tmpDir },
      { type: "message", parentId: null },
      { type: "message", parentId: entries[1]?.id },
    ]);
    const messages = await readSessionMessages(target);
    expect(messages).toHaveLength(2);
    expect(messages).toMatchObject([
      { role: "user", content: "persist this" },
      {
        role: "assistant",
        api: "cli",
        provider: "claude-cli",
        model: "opus",
        content: [{ type: "text", text: "hello from cli" }],
        usage: {
          ...(diagnostic
            ? { input: 6, output: 77, cacheRead: 54_631, totalTokens: 54_714 }
            : { input: 7, output: 4, cacheRead: 2, totalTokens: 13 }),
          contextUsage: { state: "available", promptTokens: 9, totalTokens: 13 },
        },
      },
    ]);

    const persisted = readSessionStore();
    expect(persisted[sessionKey]).not.toHaveProperty("sessionFile");
    expect(persisted[sessionKey]?.updatedAt).toBeGreaterThan(sessionEntry.updatedAt);
    expect(persisted[sessionKey]?.updatedAt).toBeGreaterThanOrEqual(beforePersist);
    expect(persisted[sessionKey]?.updatedAt).toBeLessThanOrEqual(afterPersist);
    expect(sessionStore[sessionKey]?.updatedAt).toBe(persisted[sessionKey]?.updatedAt);
  });

  it("marks CLI transcript context unavailable when only cumulative usage exists", async () => {
    const transcript = transcriptFixture("agent:main:subagent:cli-cumulative-only");
    const result = makeCliResult("cumulative reply");
    expectDefined(result.meta.agentMeta, "agent metadata").lastCallUsage = undefined;
    await transcript.persist({ body: "run tools", result });
    expect((await transcript.messages()).at(-1)?.usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      contextUsage: { state: "unavailable" },
    });
  });

  it("mirrors only the CLI reply when the shared recorder already persisted the user turn", async () => {
    const transcript = transcriptFixture("agent:main:direct:cli-recorder-owned-user");
    await transcript.seed();
    await appendTranscriptMessage(transcript.target, {
      message: {
        role: "user",
        content: "canonical current ask",
        timestamp: Date.now(),
      },
      cwd: tmpDir,
    });

    await transcript.persist({
      body: "canonical current ask",
      result: makeCliResult("hello from cli"),
      sessionStore: transcript.sessionStore,
      userMessage: {
        role: "user",
        content: "duplicate custom ask",
        timestamp: Date.now(),
      },
      skipUserTurn: true,
    });

    const messages = await transcript.messages();
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "hello from cli" }],
      }),
    );
  });

  it("does not append a CLI assistant already owned by the runtime", async () => {
    const transcript = transcriptFixture("agent:main:direct:runtime-owned-assistant");
    await appendTranscriptMessage(transcript.target, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "runtime answer" }],
        timestamp: Date.now(),
      },
      cwd: tmpDir,
    });

    await transcript.persist({
      body: "ignored prompt",
      result: makeCliResult("runtime answer"),
      skipUserTurn: true,
      skipAssistantTurn: true,
    });

    expect(await transcript.messages()).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "runtime answer" }] },
    ]);
  });

  it.each([
    ["error", "failed", "error"],
    ["end", "cancelled", "aborted"],
  ] as const)(
    "persists ACP assistant media ownership for %s/%s as %s",
    async (phase, status, stopReason) => {
      const sessionKey = "agent:main:direct:acp-media-ownership";
      const sessionEntry = makeSessionEntry("session-acp-media-ownership");
      await writeSessionStoreSeed({ [sessionKey]: sessionEntry });
      const finalText = "Artifacts ready\nMEDIA:./report.png";

      await persistAcpDispatchTranscript({
        cfg: { session: { store: storePath } },
        agentId: "main",
        sessionKey,
        expectedSessionId: sessionEntry.sessionId,
        promptText: "Prepare the report",
        finalText,
        terminalOutcome: buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase,
          data: { status, stopReason: phase === "error" ? "error" : "stop" },
        }),
        prepareAssistantTranscriptMessage: (message, sourceText) => {
          expect(sourceText).toBe(finalText);
          expect(message.stopReason).toBe(stopReason);
          return applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./report.png"] });
        },
      });

      const messages = await readSessionMessages(transcriptTarget(sessionKey, sessionEntry));
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
        stopReason,
      });
      expect(messages[1]).toHaveProperty("openclawDelivery.mediaUrls", ["./report.png"]);
    },
  );

  it("persists a media-only ACP user turn when the reply is empty", async () => {
    const sessionKey = "agent:main:direct:acp-media-only";
    const sessionEntry = makeSessionEntry("session-acp-media-only");
    const sessionStore = await seedSessionStore(sessionKey, sessionEntry);

    await persistAcpTurnTranscript({
      body: "[media attached: media://inbound/image-1]",
      terminalOutcome: { reason: "completed", status: "ok" },
      transcriptBody: "",
      userInput: {
        text: "",
        media: [{ path: "/media/inbound/image-1.png", contentType: "image/png" }],
      },
      finalText: "",
      ...transcriptContext(sessionKey, sessionEntry),
      sessionStore,
    });

    expect(await readSessionMessages(transcriptTarget(sessionKey, sessionEntry))).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: "",
        __openclaw: {
          media: [
            expect.objectContaining({
              path: "/media/inbound/image-1.png",
              contentType: "image/png",
            }),
          ],
        },
      }),
    );
  });

  it("does not append a CLI transcript after the session is deleted", async () => {
    const sessionKey = "agent:main:subagent:cli-transcript-deleted";
    const transcript = transcriptFixture(sessionKey, makeSessionEntry("session-cli-stale"));
    clearSessionStoreCacheForTest();
    const result = await transcript.persist({
      body: "late prompt",
      result: makeCliResult("late reply"),
      sessionStore: transcript.sessionStore,
    });
    expect(result).toEqual({ kind: "session-rebound", sessionEntry: undefined });
    expect(await loadTranscriptEvents(transcript.target)).toEqual([]);
    expect(readSessionStore()[sessionKey]).toBeUndefined();
  });

  it("persists the transcript body instead of runtime-only CLI prompt context", async () => {
    const transcript = transcriptFixture("agent:main:subagent:cli-transcript-clean");
    await transcript.seed();
    const result = await transcript.persist({
      body: [
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "secret runtime context",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        "",
        "visible ask",
      ].join("\n"),
      transcriptBody: "visible ask",
      result: makeCliResult("hello from cli"),
      sessionStore: transcript.sessionStore,
    });
    expect(result.kind).toBe("persisted");
    expect((await transcript.messages())[0]).toMatchObject({
      role: "user",
      content: "visible ask",
    });
  });

  it("merges the collector result transport into a restricted CLI toolsAllow", async () => {
    const { runCli } = await createCliSession("agent:main:direct:claude-collector-tools-allow");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("restricted collector cli"));

    await runCli({
      body: "collect this",
      runId: "run-cli-collector-tools-allow",
      opts: {
        toolsAllow: ["read"],
        swarmCollector: true,
        swarmOutputSchema: { type: "object", properties: { answer: { type: "string" } } },
      },
      messageChannel: "discord",
    });

    expectMockArgFields(runCliAgentMock, {
      provider: "claude-cli",
      toolsAllow: ["read", "structured_output"],
    });
  });

  it.each([
    ...SUBAGENT_ANNOUNCE_CLAUDE_CLI_DELIVERY_CASES.map((testCase) =>
      Object.assign({ provider: "claude-cli" }, testCase),
    ),
    ...SUBAGENT_ANNOUNCE_EMBEDDED_DELIVERY_CASES.map((testCase) =>
      Object.assign({ provider: "openai" }, testCase),
    ),
  ])("bounds $provider subagent completion handoff tools for $name", async (testCase) => {
    const { provider } = testCase;
    const cli = provider === "claude-cli";
    const model = cli ? "opus" : "gpt-5.4";
    const sessionKey = `agent:main:direct:${provider}-announce`;
    const sessionEntry = makeSessionEntry(`openclaw-session-${provider}-announce`);
    const sessionStore = createSubagentAnnounceSessionStore(sessionKey, sessionEntry, testCase);
    await writeSessionStoreSeed(sessionStore);
    const selectedRunner = cli ? runCliAgentMock : runEmbeddedAgentMock;
    selectedRunner.mockResolvedValueOnce(
      cli ? makeCliResult("completion announce") : { meta: { durationMs: 1 } },
    );

    await runStoredAttempt({
      providerOverride: provider,
      modelOverride: model,
      cfg: createSubagentAnnounceConfig(testCase, storePath),
      sessionEntry,
      sessionKey,
      body: "A background task finished. Process the completion update now.",
      runId: `run-${provider}-announce`,
      opts: createSubagentAnnounceHandoffOptions({
        ...testCase,
        targetSessionKey: sessionKey,
        targetSessionId: sessionEntry.sessionId,
        provider,
        model,
      }),
      messageChannel: "telegram",
      sessionStore,
    });

    expectMockArgFields(selectedRunner, {
      provider,
      sourceReplyDeliveryMode: testCase.sourceReplyDeliveryMode,
      requireExplicitMessageTarget: cli
        ? testCase.requireExplicitMessageTarget === true
        : testCase.requireExplicitMessageTarget,
      toolsAllow: testCase.expectedToolsAllow,
      disableTools: testCase.expectedDisableTools,
      terminalReplyExpectation: "required",
      ...(!cli
        ? {
            disableMessageTool: testCase.disableMessageTool || undefined,
            modelRun: testCase.modelRun || undefined,
            promptMode: testCase.promptMode,
          }
        : {}),
    });
    expect(cli ? runEmbeddedAgentMock : runCliAgentMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a fallback completion report", true, "inter_session", "report_only"],
    ["a fallback answering ordinary user input", true, "external_user", undefined],
    ["a primary completion report", false, "inter_session", undefined],
  ] as const)(
    "stamps the command-fallback CLI grant delegation capability for %s",
    async (_label, isFallbackRetry, kind, expected) => {
      const runId = `run-command-fallback-delegation-${String(isFallbackRetry)}-${expected}`;
      const sessionKey = `agent:main:direct:${runId}`;
      const { runCli } = await createCliSession(sessionKey, makeSessionEntry(`session-${runId}`));
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        ...cliRuntimeConfig("anthropic/claude-opus-4-7", "claude-cli"),
      };
      runCliAgentMock.mockResolvedValueOnce(makeCliResult("delegation gate"));

      await runCli({
        providerOverride: "anthropic",
        originalProvider: "anthropic",
        modelOverride: "claude-opus-4-7",
        cfg,
        sessionFile: path.join(tmpDir, `${runId}.jsonl`),
        body: "report the completion",
        isFallbackRetry,
        runId,
        opts: {
          message: "report the completion",
          inputProvenance:
            kind === "inter_session" ? { kind, sourceTool: "subagent_announce" } : { kind },
        } as RunAgentAttemptParams["opts"],
        messageChannel: "telegram",
      });

      // The command loop is a second fallback entry point; its CLI grant must
      // carry the same gate as the auto-reply candidate or the loopback surface
      // resolves to full.
      const grantContext = buildCliMcpGrantContext({
        run: firstRunCliAgentArg() as unknown as Parameters<
          typeof buildCliMcpGrantContext
        >[0]["run"],
        config: cfg,
        requireExplicitMessageTarget: false,
        agentId: "main",
        modelProvider: "anthropic",
        modelId: "claude-opus-4-7",
      });
      expect(grantContext.delegationCapability).toBe(expected);
    },
  );

  it("keeps a plugin-owned CLI request on the CLI path after usage records its runtime", async () => {
    const sessionEntry = makeSessionEntry("plugin-cli-session", {
      pluginOwnerId: "cli-owner",
      modelSelectionLocked: true,
      agentRuntimeOverride: "claude-cli",
      agentHarnessId: "claude-cli",
    });
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("continued"));

    await runAgentAttempt({
      sessionKey: "agent:main:main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      sessionEntry,
      agentHarnessRuntimeOverride: "claude-cli",
      runId: "plugin-cli-continuation",
    });

    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runCliAgentMock, {
      provider: "claude-cli",
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it.each([undefined, "lightweight"] as const)(
    "routes canonical Anthropic models through CLI with %s bootstrap context",
    async (bootstrapContextMode) => {
      const sessionKey = "agent:main:direct:canonical-claude-cli";
      const { runCli } = await createCliSession(sessionKey);
      runCliAgentMock.mockResolvedValueOnce(makeCliResult("canonical cli"));
      const fallbackRuntimeState: NonNullable<RunAgentAttemptParams["fallbackRuntimeState"]> = {};
      const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];

      await runCli({
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        cfg: cliRuntimeConfig("anthropic/claude-opus-4-7", "claude-cli"),
        body: "route this",
        isFallbackRetry: true,
        opts: { images, imageOrder: ["inline"], bootstrapContextMode },
        fallbackRuntimeState,
      });

      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expectMockArgFields(runCliAgentMock, {
        provider: "claude-cli",
        model: "claude-opus-4-7",
        imagePrompt: "route this",
        images,
        imageOrder: ["inline"],
        bootstrapContextMode,
      });
      expect(fallbackRuntimeState.originRuntime).toBe("cli");

      const fallbackArg = await runOpenClawEmbeddedAttemptForTest({
        isFallbackRetry: true,
        fallbackRuntimeState,
        opts: { images, bootstrapContextMode },
      });
      expect(fallbackArg.images).toEqual(images);
      expect(fallbackArg.bootstrapContextMode).toBe(bootstrapContextMode);
    },
  );

  it("publishes logical cancellation before an embedded-to-CLI fallback starts", async () => {
    const { runCli } = await createCliSession("agent:main:direct:cli-lifecycle-handoff");
    runCliAgentMock.mockResolvedValueOnce(makeCliResult("fallback complete"));
    const controller = new AbortController();
    const handoffToCli = vi.fn();
    const deferredLifecycle: NonNullable<RunAgentAttemptParams["deferredLifecycle"]> = {
      signal: controller.signal,
      beginRetryWait: () => undefined,
      abort: vi.fn(),
      adopt: vi.fn(),
      handoffToCli,
      complete: vi.fn(async () => undefined),
    };

    await runCli({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: cliRuntimeConfig("anthropic/claude-opus-4-7", "claude-cli"),
      body: "continue after overload",
      isFallbackRetry: true,
      runId: "run-cli-lifecycle-handoff",
      messageChannel: "telegram",
      deferredLifecycle,
    });

    expect(handoffToCli).toHaveBeenCalledOnce();
    expect(handoffToCli.mock.invocationCallOrder[0]).toBeLessThan(
      runCliAgentMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expectMockArgFields(runCliAgentMock, { abortSignal: controller.signal });
  });

  registerCommandReplyPolicyTests({
    runStoredAttempt,
    seedSessionStore,
    runEmbeddedAgentMock,
    runCliAgentMock,
    executePreparedCliRunMock,
  });

  registerSandboxedDelegatedCliTests({
    runStoredAttempt,
    seedSessionStore,
    runEmbeddedAgentMock,
    runCliAgentMock,
    executePreparedCliRunMock,
  });

  it("suppresses live stream output for hidden internal runs", async () => {
    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      opts: { lane: "subagent", sessionEffects: "internal" },
      runId: "internal-subagent-stream",
    });

    expect(embeddedArg.suppressLiveStreamOutput).toBe(true);
  });

  it("preserves embedded tools for a verified nested subagent completion", async () => {
    const runId = "trusted-nested-glm-completion";
    const onExecutionStarted = vi.fn();
    const capability = createCronCreatorAuthorityCapability(runId);
    if (!capability) {
      throw new Error("expected cron creator authority capability");
    }
    const requesterSessionKey = "agent:main:subagent:parent-child";
    const childSessionKey = "agent:main:subagent:leaf";
    const requesterSessionId = "parent-child-session";
    const childSessionId = "leaf-session";
    const opts = createCompletionHandoff({
      targetSessionKey: requesterSessionKey,
      targetSessionId: requesterSessionId,
      sourceSessionKey: childSessionKey,
      sourceSessionId: childSessionId,
      provider: "openai",
      model: "glm-4.5",
    });
    if (opts.inputProvenance?.kind === "inter_session") {
      delete opts.inputProvenance.sourceChannel;
    }
    opts.internalEvents = opts.internalEvents?.map((event) => ({
      ...event,
      replyInstruction: "Review and continue.",
    }));

    const embeddedArg = await runOpenClawEmbeddedAttemptForTest({
      runId,
      sessionKey: requesterSessionKey,
      modelOverride: "glm-4.5",
      sessionEntry: {
        sessionId: requesterSessionId,
        spawnedBy: "agent:main:direct:root",
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: ["exec"],
      },
      additionalSessionEntries: {
        [childSessionKey]: {
          sessionId: childSessionId,
          spawnedBy: requesterSessionKey,
          spawnDepth: 2,
          subagentRole: "leaf",
          subagentControlScope: "none",
          inheritedToolPolicyVersion: 1,
          inheritedToolDeny: ["exec", "read"],
        },
      },
      opts: {
        ...opts,
        lane: "subagent",
        onExecutionStarted,
        cronCreatorAuthorityCapability: capability,
      },
    });

    expect(embeddedArg.suppressLiveStreamOutput).toBe(false);
    expect(embeddedArg.terminalReplyExpectation).toBe("result-required");
    expect(embeddedArg.cronCreatorAuthorityCapability).toBe(capability);
    const callback = embeddedArg.onExecutionStarted;
    if (typeof callback !== "function") {
      throw new Error("execution admission callback is missing");
    }
    await callback({ lifecycleGeneration: "next-generation" });
    expect(onExecutionStarted).toHaveBeenCalledOnce();
    expect(embeddedArg.disableTools).toBe(false);
    expect(embeddedArg.trustedInternalHandoff).toEqual(opts.trustedInternalHandoff);
  });

  it("records raw CLI-shaped model runs as embedded origins", async () => {
    const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
    const fallbackRuntimeState: NonNullable<RunAgentAttemptParams["fallbackRuntimeState"]> = {};

    const firstArg = await runOpenClawEmbeddedAttemptForTest({
      runId: "raw-cli-shaped-origin",
      providerOverride: "claude-cli",
      modelOverride: "claude-opus-4-7",
      fallbackRuntimeState,
      opts: { modelRun: true, images },
    });
    expect(fallbackRuntimeState.originRuntime).toBe("embedded");
    expect(firstArg.images).toEqual(images);

    const retryArg = await runOpenClawEmbeddedAttemptForTest({
      runId: "raw-cli-shaped-origin-retry",
      providerOverride: "claude-cli",
      modelOverride: "claude-opus-4-7",
      isFallbackRetry: true,
      fallbackRuntimeState,
      opts: { modelRun: true, images },
    });
    expect(retryArg.images).toBeUndefined();
  });

  it.each([
    { reportedId: "openai:configured", source: "user" },
    { reportedId: "openai:rotated", source: "auto" },
    { reportedId: undefined, source: undefined },
  ] as const)(
    "reports successful maintenance auth $reportedId without artifact capture",
    async ({ reportedId, source }) => {
      const onSuccessfulAuthProfile = vi.fn();
      runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
          expect(params.onSuccessfulAuthBinding).toBeUndefined();
          params.onSuccessfulAuthProfile?.(reportedId);
          return { meta: { durationMs: 1 } } satisfies EmbeddedAgentRunResult;
        },
      );

      await runStoredAttempt({
        sessionEntry: makeSessionEntry("maintenance-auth", {
          authProfileOverride: "openai:stale",
          authProfileOverrideSource: "auto",
        }),
        sessionKey: "agent:main:direct:maintenance-auth",
        modelOverride: "gpt-5.6-luna",
        configuredAuthProfileId: "openai:configured",
        onSuccessfulAuthProfile,
      });

      expect(onSuccessfulAuthProfile).toHaveBeenCalledExactlyOnceWith({
        authProfileId: reportedId,
        authProfileIdSource: source,
      });
    },
  );
  it.each(restrictedCompletionCases)(
    "restricts completion tools for $name",
    async ({
      providerName = "claude-cli",
      execHost,
      seedChildLineage = true,
      forge,
    }: RestrictedCompletion) => {
      const sessionKey = "agent:main:direct:claude-announce-unverified";
      const sessionEntry = makeSessionEntry(
        "openclaw-session-cli-announce-unverified",
        execHost ? { execHost } : {},
      );
      const sessionStore = seedChildLineage
        ? createSubagentAnnounceSessionStore(sessionKey, sessionEntry, {})
        : { [sessionKey]: sessionEntry };
      await writeSessionStoreSeed(sessionStore);
      runCliAgentMock.mockResolvedValue(makeCliResult("completion announce"));

      for (const sourceReplyDeliveryMode of ["automatic", "message_tool_only"] as const) {
        runCliAgentMock.mockClear();
        const opts = createSubagentAnnounceHandoffOptions({
          sourceReplyDeliveryMode,
          targetSessionKey: sessionKey,
          targetSessionId: sessionEntry.sessionId,
          provider: providerName,
          model: "opus",
        });
        const { trustedInternalHandoff, ...unverifiedOpts } = opts;
        const forged =
          trustedInternalHandoff && forge ? forge(trustedInternalHandoff) : trustedInternalHandoff;
        await runStoredAttempt({
          providerOverride: providerName,
          modelOverride: "opus",
          cfg: { session: { store: storePath } },
          sessionEntry,
          sessionKey,
          body: "A background task finished. Process the completion update now.",
          runId: `run-cli-announce-unverified-${sourceReplyDeliveryMode}`,
          opts: { ...unverifiedOpts, ...(forged ? { trustedInternalHandoff: forged } : {}) },
          messageChannel: "telegram",
          sessionStore,
        });

        const messageOnly = !forge && sourceReplyDeliveryMode === "message_tool_only";
        expectMockArgFields(runCliAgentMock, {
          provider: providerName,
          disableTools: !messageOnly,
          toolsAllow: messageOnly ? ["message"] : undefined,
          trustedInternalHandoff: undefined,
        });
      }
    },
  );

  it.each(["direct", "cached", "awaiting cache"])(
    "preserves inherited denies and rechecks lineage for a %s lookup",
    async (mode) => {
      const { context, childSessionKey, childEntry } = await runTrustedClaudeCompletionForTest({
        storePath,
        writeSessionStoreSeed,
        runStoredAttempt,
        runCliAgentMock,
        runEmbeddedAgentMock,
      });
      const cfg = { session: { store: storePath } };
      const cache = new McpLoopbackToolCache();
      const resolve = () =>
        mode === "direct"
          ? resolveMcpLoopbackScopedTools({ cfg, context })
          : cache.resolve({ cfg, context, grantToken: "completion-grant" });
      const first = await resolve();
      expect(first.tools.map((tool) => tool.name)).toEqual(["read"]);
      const replacement = {
        ...childEntry,
        spawnedBy: "agent:main:direct:another-requester",
      };
      // The awaiting lookup must observe revocation after yielding, even on a cache hit.
      const pending = mode === "awaiting cache" ? resolve() : undefined;
      if (pending) {
        replaceSessionEntrySync({ sessionKey: childSessionKey, storePath }, replacement);
      } else {
        await replaceSessionEntry({ sessionKey: childSessionKey, storePath }, replacement);
      }
      clearSessionStoreCacheForTest();
      await expect(pending ?? resolve()).rejects.toThrow(
        "CLI completion tool grant no longer matches its requester policy",
      );
    },
  );
});

describe("embedded attempt harness pinning", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-embedded-attempt-"));
    runCliAgentMock.mockReset();
    runEmbeddedAgentMock
      .mockReset()
      .mockResolvedValueOnce({ meta: { durationMs: 1 } } satisfies EmbeddedAgentRunResult);
  });

  afterEach(async () => {
    closeAuthProfileReadPool({ kind: "root", rootPath: tmpDir });
    await cleanupSessionStateForTest({ stateDir: tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true });
    clearRuntimeConfigSnapshot();
  });

  function runHarnessAttempt(
    overrides: Omit<RunAgentAttemptOverrides, "agentDir" | "sessionKey" | "workspaceDir">,
  ) {
    return runAgentAttempt({
      sessionKey: "agent:main:main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      sessionHasHistory: true,
      ...overrides,
    });
  }

  it("keeps a catalog-adopted Codex harness pinned for direct command attempts", async () => {
    const sessionEntry = makeSessionEntry("mixed-provider-session", {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: {
          supervision: {
            sourceThreadId: "019f-codex-thread",
            modelLocked: true,
          },
        },
      },
    });
    await runHarnessAttempt({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: cliRuntimeConfig("anthropic/claude-opus-4-7", "claude-cli"),
      sessionEntry,
      agentHarnessRuntimeOverride: "codex",
      body: "switch to minimax",
      opts: { toolsAllow: ["read", "web_search"], codeModeOverride: false },
      runId: "run-mixed-provider-auto-runtime",
    });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "anthropic",
      model: "claude-opus-4-7",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      modelSelectionLocked: true,
      toolsAllow: ["read", "web_search"],
      codeModeOverride: false,
    });
  });

  it("auto-forwards OpenAI Codex auth profiles to default Codex harness runs", async () => {
    const { clearAgentHarnesses, registerAgentHarness } = await import("../harness/registry.js");
    const sessionEntry = makeSessionEntry("codex-auth-session");
    saveTestAuthProfiles(tmpDir, {
      "openai:work": createOAuthRefreshCredential(),
    });
    clearAgentHarnesses();
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(),
    });

    try {
      await runHarnessAttempt({
        sessionEntry,
        runId: "run-codex-auto-auth-profile",
      });
    } finally {
      clearAgentHarnesses();
    }

    expectMockArgFields(runEmbeddedAgentMock, {
      agentHarnessId: undefined,
      authProfileId: "openai:work",
      authProfileIdSource: "auto",
    });
  });

  it("honors a runtime request without promoting observations to a pin (owner model-owner)", async () => {
    const sessionEntry = makeSessionEntry("explicit-openclaw-session", {
      agentRuntimeOverride: "openclaw",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginOwnerId: "model-owner",
    });
    const modelThinkingCapability = {
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "openclaw",
      route: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
      compat: {
        thinkingFormat: "openai",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    } as const;
    await runHarnessAttempt({
      modelOverride: "gpt-5.6-sol",
      modelThinkingCapability,
      sessionEntry,
      agentHarnessRuntimeOverride: "openclaw",
      resolvedThinkLevel: "max",
      runId: "run-explicit-openclaw-runtime",
    });

    expectMockArgFields(runEmbeddedAgentMock, {
      provider: "openai",
      model: "gpt-5.6-sol",
      modelThinkingCapability,
      agentHarnessId: undefined,
      agentHarnessRuntimeOverride: "openclaw",
      thinkLevel: "max",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
