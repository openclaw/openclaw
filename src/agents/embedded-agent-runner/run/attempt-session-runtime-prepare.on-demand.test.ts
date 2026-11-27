// An on-demand tool joins the session's sent tools after its first direct call, across restarts.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  createTurnSequenceStream,
  makeCall,
} from "../../../../packages/agent-core/src/agent-loop.test-support.js";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
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
import { openSyntheticSqliteSession } from "./attempt-session-runtime-prepare.test-support.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { wrapStreamFnTrimToolCallNames } from "./attempt-tool-call-stream-normalization.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";

const mocks = vi.hoisted(() => ({ agentSession: vi.fn(), manager: vi.fn(), transport: vi.fn() }));
// mock-isolation: A synthetic agent session stands in; the real client-tool surface is built from its input.
vi.mock("./attempt-session-prepare.js", () => ({
  prepareEmbeddedAttemptAgentSession: mocks.agentSession,
  prepareEmbeddedAttemptSessionBoundary: () => ({}),
  prepareEmbeddedAttemptSessionManager: mocks.manager,
}));
// mock-isolation: The synthetic session has no provider stream; capture the transport facts.
vi.mock("./attempt-stream-settle.js", () => ({ prepareEmbeddedAttemptTransport: mocks.transport }));
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

it.each([
  [false, "compaction"],
  [true, "reset"],
] as const)(
  "sends github_publish only after its first direct call, then on later turns and restarts (codeMode=%s) until %s",
  async (codeMode, boundary) => {
    const sessionId = `on-demand-${codeMode}`;
    sessionIds.add(sessionId);
    const { scope, admittedRunContext } = await openSyntheticSqliteSession(sessionId, "on-demand");
    const config = {
      agents: { entries: { main: {} } },
      tools: codeMode
        ? { codeMode: true, toolSearch: false as const }
        : { codeMode: false, toolSearch: { mode: "tools" as const } },
    };
    setRuntimeConfigSnapshot(config);
    // One turn through the embedded attempt's real tool construction, catalog and pin.
    const turn = async (callByName = false) => {
      // Process memory does not survive a Gateway restart; only the transcript does.
      clearEmbeddedSessionPromptStates([sessionId]);
      const manager = await SessionManager.openAsync(scope);
      mocks.manager.mockImplementation(async (input) => {
        input.onSessionManagerCreated(manager);
        return {
          sessionManager: manager,
          transcriptPolicy: { inHistorySystemUpdates: true },
          userMessageBoundary: { getUserTranscriptContexts: () => [] },
        };
      });
      const seen: { sent?: string[]; promote?: (tool: AnyAgentTool) => void; deferred?: string[] } =
        {};
      mocks.agentSession.mockImplementation(async (input) => {
        const tools = input.clientToolPreparation;
        seen.sent = prepareEmbeddedAttemptClientTools({
          attempt: input.attempt,
          ...tools,
        }).allCustomTools.map((tool) => tool.name);
        seen.promote = tools.onPromoteTool;
        const activeSession = { messages: [], sessionId, agent: { state: { messages: [] } } };
        input.onSessionCreated(activeSession);
        return { activeSession, clientToolDefs: [], setActiveSessionSystemPrompt: vi.fn() };
      });
      mocks.transport.mockImplementation(async (input) => {
        seen.deferred = input.getDeferredToolEntries?.()?.map((e: { name: string }) => e.name);
        return {};
      });
      const runtime = createAgentHarnessToolSurfaceRuntimeCore({
        config,
        agentId: "main",
        sessionKey: scope.sessionKey,
        modelToolsEnabled: true,
        loadsOnDemandTools: true,
      });
      onTestFinished(runtime.cleanup);
      const model = makeProviderModelFixture({
        provider: "openai",
        id: "m",
        baseUrl: "http://127.0.0.1:1",
        api: "openai-responses",
      });
      const attempt = {
        config,
        admittedRunContext,
        model,
        provider: "openai",
        modelId: "m",
        sessionId,
        sessionKey: scope.sessionKey,
        runId: `run-${sessionId}`,
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
        toolSearchCatalogRef: runtime.toolSearchCatalogRef,
        localModelLeanPreserveToolNames: [],
        runtimeCapabilityProfile: resolveConversationCapabilityProfile({ config, agentId: "main" }),
      } as unknown as PrepareInput["toolBase"];
      const signal = new AbortController().signal;
      const resources = { trajectoryRecorder: null, buildAbortSettlePromise: () => null };
      const toolCatalog = await prepareEmbeddedAttemptToolCatalog({
        attempt,
        setup,
        bundleTools,
        abortSignal: signal,
        preparedToolBase: toolBase,
        executeCodeModeTool: async () => ({ content: [], details: {} }),
      });
      const prepared = await prepareEmbeddedAttemptSessionRuntime({
        attempt,
        setup,
        toolBase,
        bundleTools,
        resources,
        runAbortSignal: signal,
        toolCatalog,
        prepareSystemPrompt: async () => ({
          systemPromptText: "initial prompt",
          prepareToolPrompt: async () => (prompt: string) => prompt,
        }),
        sessionLock: {
          ownedTranscriptWriteContext: {},
          withOwnedTranscriptWrite: async (run: () => unknown) => await run(),
        },
        externalAbortController: { setActiveSessionAbort: vi.fn() },
        onSessionYieldReady: vi.fn(),
      } as unknown as PrepareInput);
      (resources as PrepareInput["resources"]).promptStateLease?.[Symbol.dispose]();
      const catalog = runtime.toolSearchCatalogRef?.current?.entries ?? [];
      const entry = catalog.find((e) => e.name === "github_publish");
      if (callByName) {
        // The model called github_publish by name; the run's deferred-tool resolver records it.
        seen.promote!(expectDefined(entry, "catalog entry").tool as AnyAgentTool);
      }
      expectDefined((await prepared.prepareSystemPromptUpdate!("proof")).commit, "commit")();
      await persistSessionSystemPrompt(prepared.sessionPromptState, (type, data) =>
        manager.appendCustomEntryAsync(type, data),
      );
      return { ...seen, entry, live: toolCatalog.toolSearchRunPlan.liveAllowedToolNames, model };
    };
    const first = await turn(true);
    expect(first.sent).not.toContain("github_publish");
    // The transport keeps an undeclared call to it native for this run's later requests.
    expect(first.deferred).toEqual(["github_publish"]);
    // Repeated first-use calls stay known to the stream's unknown-tool guard (threshold 10).
    const calls = Array.from({ length: 11 }, (_, n) => [makeCall("github_publish", `c${n}`)]);
    const guarded = wrapStreamFnTrimToolCallNames(createTurnSequenceStream(calls), first.live, {
      unknownToolThreshold: 10,
    });
    for (let call = 0; call < 11; call++) {
      const reply = await (await guarded(first.model, { messages: [] })).result();
      expect(reply.content, `call ${call + 1}`).toMatchObject([{ name: "github_publish" }]);
    }
    for (const label of ["next turn", "after another restart"]) {
      const later = await turn();
      expect(later.sent, label).toEqual([...first.sent!, "github_publish"]);
      expect(later.entry, label).toBeUndefined();
    }
    // Compaction and /new or /reset start a new series; the tool is deferred again until used.
    const history = await SessionManager.openAsync(scope);
    if (boundary === "reset") {
      await history.appendResetBoundaryAsync("reset");
    } else {
      const kept = await history.appendMessageAsync(makeUserMessage("Earlier turn", 1));
      await history.appendCompactionAsync("Summary.", expectDefined(kept, "kept entry"), 1_000);
    }
    const afterCompaction = await turn();
    expect(afterCompaction.sent).not.toContain("github_publish");
    expect(afterCompaction.entry).toBeDefined();
  },
);
