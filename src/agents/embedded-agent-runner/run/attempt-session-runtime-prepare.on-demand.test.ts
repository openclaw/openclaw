// An on-demand tool joins the session's sent tools after its first direct call, across restarts.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../../config/sessions/session-actor-storage-acquisition.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { createOpenClawCodingToolsInternal } from "../../agent-tools.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../harness/tool-surface-bridge.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  clearEmbeddedSessionPromptStates,
  persistSessionSystemPrompt,
} from "../session-prompt-state.js";
import { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";
import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";

const mocks = vi.hoisted(() => ({
  prepareSessionManager: vi.fn(),
  prepareAgentSession: vi.fn(),
  prepareTransport: vi.fn(),
}));

// mock-isolation: A synthetic agent session stands in; the real client-tool surface is built from its input.
vi.mock("./attempt-session-prepare.js", () => ({
  prepareEmbeddedAttemptAgentSession: mocks.prepareAgentSession,
  prepareEmbeddedAttemptSessionBoundary: () => ({}),
  prepareEmbeddedAttemptSessionManager: mocks.prepareSessionManager,
}));
// mock-isolation: The synthetic session has no provider stream; capture the transport facts.
vi.mock("./attempt-stream-settle.js", () => ({
  prepareEmbeddedAttemptTransport: mocks.prepareTransport,
}));
// mock-isolation: Trajectory recording is outside the tool surface contract.
vi.mock("../../../trajectory/runtime.js", () => ({ createTrajectoryRuntimeRecorder: () => null }));
// mock-isolation: Supply a synthetic transcript path without opening the session store.
vi.mock("./attempt-transcript-helpers.js", () => ({
  resolveAttemptTrajectorySessionFile: async () => "/tmp/trajectory.jsonl",
}));

type PrepareInput = Parameters<typeof prepareEmbeddedAttemptSessionRuntime>[0];
const sessionIds = new Set<string>();
afterEach(() => {
  clearEmbeddedSessionPromptStates([...sessionIds]);
  clearRuntimeConfigSnapshot();
});

/** One SQLite-backed session; every turn opens its own manager and prompt state, like a restart. */
async function openSession(sessionId: string, codeMode: boolean) {
  sessionIds.add(sessionId);
  const env = { OPENCLAW_STATE_DIR: `/synthetic/on-demand/${sessionId}` };
  const scope = {
    agentId: "main",
    env,
    sessionId,
    sessionKey: `agent:main:dashboard:incognito-${sessionId}`,
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const admission = prepareSystemAgentRunAdmission({}, `run-${sessionId}`, "main", "on-demand");
  onTestFinished(() => admission.close());
  const admittedRunContext = await admission.admit("embedded");
  const authority = { assertCurrent() {}, authorize() {} };
  const binding = await acquireSessionActorStorage(scope, {
    authority,
    lifetime: { assertCurrent() {}, assertReadable() {} },
    create: true,
  });
  if (!binding) {
    throw new Error("Missing incognito fixture actor");
  }
  onTestFinished(async () => {
    await binding.actor.release();
    memorySessionActorOwners.closeDatabase(binding);
  });
  await binding.actor.storage.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: { sessionId, lifecycleRevision: "initial", updatedAt: 1 },
        cwd: "/synthetic",
      },
    },
    authority,
  );
  const config = {
    agents: { entries: { main: {} } },
    tools: codeMode
      ? { codeMode: true, toolSearch: false as const }
      : { codeMode: false, toolSearch: { mode: "tools" as const } },
  };
  setRuntimeConfigSnapshot(config);
  const turn = async () => {
    // Process memory does not survive a Gateway restart; only the transcript does.
    clearEmbeddedSessionPromptStates([sessionId]);
    const manager = await SessionManager.openAsync(scope);
    mocks.prepareSessionManager.mockImplementation(async (input) => {
      input.onSessionManagerCreated(manager);
      return {
        isOpenAIResponsesApi: true,
        preparedUserTurnMessage: { role: "user", content: "hello" },
        sessionManager: manager,
        transcriptPolicy: { inHistorySystemUpdates: true },
        userMessageBoundary: { getUserTranscriptContexts: () => [] },
      };
    });
    let sent: string[] = [];
    let promote: ((tool: AnyAgentTool) => void) | undefined;
    mocks.prepareAgentSession.mockImplementation(async (input) => {
      const surface = prepareEmbeddedAttemptClientTools({
        attempt: input.attempt,
        ...input.clientToolPreparation,
      });
      sent = surface.allCustomTools.map((tool) => tool.name);
      promote = input.clientToolPreparation.onPromoteTool;
      const activeSession = { messages: [], sessionId, agent: { state: { messages: [] } } };
      input.onSessionCreated(activeSession);
      return { activeSession, clientToolDefs: [], setActiveSessionSystemPrompt: vi.fn() };
    });
    let deferredNames: string[] | undefined;
    mocks.prepareTransport.mockImplementation(async (input) => {
      deferredNames = input
        .getDeferredToolEntries?.()
        ?.map((entry: { name: string }) => entry.name);
      return { compactionReplayEnabled: true };
    });
    // The embedded attempt's real tool surface: construction, catalog compaction and pin.
    const runtime = createAgentHarnessToolSurfaceRuntimeCore({
      config,
      agentId: "main",
      sessionKey: scope.sessionKey,
      modelToolsEnabled: true,
      loadsOnDemandTools: true,
    });
    onTestFinished(runtime.cleanup);
    const attempt = {
      config,
      admittedRunContext,
      workspaceDir: "/tmp/workspace",
      sessionKey: scope.sessionKey,
      model: makeProviderModelFixture({
        provider: "openai",
        id: "on-demand-proof",
        baseUrl: "http://127.0.0.1:1",
        api: "openai-responses",
      }),
      modelId: "on-demand-proof",
      provider: "openai",
      runId: `run-${sessionId}`,
      sessionId,
      trigger: "user",
    } as unknown as PrepareInput["attempt"];
    const setup = createAttemptSetupFixture({ sandbox: null });
    const bundleTools = {
      clientTools: [],
      uncompactedEffectiveTools: createOpenClawCodingToolsInternal({
        config,
        sessionKey: scope.sessionKey,
        githubPublicationAvailable: true,
        wrapBeforeToolCallHook: false,
      }).filter((tool) => tool.name === "github_publish" || tool.name === "read"),
    };
    const toolBase = {
      toolSurfaceRuntime: runtime,
      toolsEnabled: true,
      codeModeControlsEnabledForRun: runtime.codeModeControlsEnabled,
      toolSearchControlsEnabledForRun: runtime.toolSearchControlsEnabled,
      toolSearchConfig: runtime.plan.toolSearchConfig,
      toolSearchRuntimeConfig: config,
      toolSearchCatalogRef: runtime.toolSearchCatalogRef,
      localModelLeanPreserveToolNames: [],
      runtimeCapabilityProfile: resolveConversationCapabilityProfile({ config, agentId: "main" }),
    } as unknown as PrepareInput["toolBase"];
    const abort = new AbortController();
    const toolCatalog = await prepareEmbeddedAttemptToolCatalog({
      attempt,
      setup,
      preparedToolBase: toolBase,
      bundleTools,
      abortSignal: abort.signal,
      executeCodeModeTool: async () => ({ content: [], details: {} }),
    });
    const resources = { trajectoryRecorder: null, buildAbortSettlePromise: () => null };
    try {
      const prepared = await prepareEmbeddedAttemptSessionRuntime({
        attempt,
        agentDir: "/agent",
        isRawModelRun: false,
        resolveActiveContextEnginePluginId: vi.fn(),
        setup,
        toolBase,
        toolCatalog,
        bundleTools,
        prepareSystemPrompt: async () => ({
          systemPromptText: "initial prompt",
          prepareToolPrompt: async () => (prompt: string) => prompt,
        }),
        sessionLock: {
          ownedTranscriptWriteContext: {},
          withOwnedTranscriptWrite: async (operation: () => unknown) => await operation(),
        },
        runAbortSignal: abort.signal,
        externalAbortController: { setActiveSessionAbort: vi.fn() },
        resources,
        onSessionYieldReady: vi.fn(),
      } as unknown as PrepareInput);
      const catalog = runtime.toolSearchCatalogRef?.current?.entries ?? [];
      const checkpoint = async () => {
        expectDefined(
          (await prepared.prepareSystemPromptUpdate!("on-demand proof")).commit,
          "prompt commit",
        )();
        await persistSessionSystemPrompt(prepared.sessionPromptState, (customType, data) =>
          manager.appendCustomEntryAsync(customType, data),
        );
      };
      return {
        sent,
        promote: expectDefined(promote, "promotion callback"),
        catalog: catalog.map((entry) => entry.name),
        entry: catalog.find((entry) => entry.name === "github_publish"),
        deferredNames,
        checkpoint,
      };
    } finally {
      (resources as PrepareInput["resources"]).promptStateLease?.[Symbol.dispose]();
    }
  };
  return { turn, open: () => SessionManager.openAsync(scope) };
}

it.each([false, true])(
  "sends github_publish only after its first direct call, then on later turns and restarts until compaction (codeMode=%s)",
  async (codeMode) => {
    const session = await openSession(`on-demand-${codeMode}`, codeMode);
    const first = await session.turn();
    expect(first.sent).not.toContain("github_publish");
    expect(first.catalog).toContain("github_publish");
    // The transport keeps an undeclared call to it native for this run's later requests.
    expect(first.deferredNames).toEqual(["github_publish"]);
    // The model called github_publish by name; the run's deferred-tool resolver records it.
    first.promote(expectDefined(first.entry, "catalog github_publish").tool as AnyAgentTool);
    await first.checkpoint();
    for (const label of ["next turn", "after another restart"]) {
      const later = await session.turn();
      expect(later.sent, label).toEqual([...first.sent, "github_publish"]);
      expect(later.catalog, label).not.toContain("github_publish");
      await later.checkpoint();
    }
    // Compaction starts a new series; the tool is deferred again until its next use.
    const history = await session.open();
    const kept = await history.appendMessageAsync(makeUserMessage("Earlier turn", 1));
    await history.appendCompactionAsync("Summary.", expectDefined(kept, "kept entry"), 1_000);
    const afterCompaction = await session.turn();
    expect(afterCompaction.sent).not.toContain("github_publish");
    expect(afterCompaction.catalog).toContain("github_publish");
  },
);
