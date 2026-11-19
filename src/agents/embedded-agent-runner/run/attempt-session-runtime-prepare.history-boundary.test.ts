// Prompt series identity across runs whose bounded transcript window omits an old compaction.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../../config/sessions/session-actor-storage-acquisition.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  clearEmbeddedSessionPromptStates,
  persistSessionSystemPrompt,
} from "../session-prompt-state.js";
import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";

const mocks = vi.hoisted(() => ({ prepareSessionManager: vi.fn() }));

vi.mock("../../anthropic-payload-log.js", () => ({ createAnthropicPayloadLogger: () => ({}) }));
vi.mock("../../cache-trace.js", () => ({ createCacheTrace: () => ({}) }));
vi.mock("../tool-result-truncation.js", () => ({ restoreCacheTtlToolResultProjections: vi.fn() }));
vi.mock("./attempt-setup.js", () => ({
  installEmbeddedAttemptContextGuards: () => ({ remove: vi.fn() }),
}));
vi.mock("./attempt-session-prepare.js", () => ({
  prepareEmbeddedAttemptAgentSession: async (input: {
    onSessionCreated: (session: unknown) => void;
  }) => {
    const activeSession = { messages: [], sessionId: "active", agent: { state: { messages: [] } } };
    input.onSessionCreated(activeSession);
    return { activeSession, clientToolDefs: [], setActiveSessionSystemPrompt: vi.fn() };
  },
  prepareEmbeddedAttemptSessionBoundary: () => ({}),
  prepareEmbeddedAttemptSessionManager: mocks.prepareSessionManager,
}));
vi.mock("./attempt-session-settle.js", () => ({
  createEmbeddedAttemptSessionSettleTracker: () => ({
    abortActiveSession: vi.fn(),
    buildAbortSettlePromise: () => null,
  }),
}));
vi.mock("./attempt-stream-settle.js", () => ({
  prepareEmbeddedAttemptTransport: async () => ({ compactionReplayEnabled: true }),
}));
// mock-isolation: Trajectory recording is outside the prompt series contract.
vi.mock("../../../trajectory/runtime.js", () => ({ createTrajectoryRuntimeRecorder: () => null }));
// mock-isolation: Supply a synthetic transcript path without opening the session store.
vi.mock("./attempt-transcript-helpers.js", () => ({
  resolveAttemptTrajectorySessionFile: async () => "/tmp/trajectory.jsonl",
}));

type PrepareInput = Parameters<typeof prepareEmbeddedAttemptSessionRuntime>[0];
const sessionId = "history-boundary-window";
afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));

it("keeps the series across runs when the bounded window drops an old compaction", async () => {
  const env = { OPENCLAW_STATE_DIR: "/synthetic/prompt-history-boundary" };
  const scope = {
    agentId: "main",
    env,
    sessionId,
    sessionKey: `agent:main:dashboard:incognito-${sessionId}`,
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const admission = prepareSystemAgentRunAdmission({}, "run-1", "main", "history-boundary");
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
  try {
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
    const source = await SessionManager.openAsync(scope);
    const kept = await source.appendMessageAsync(makeUserMessage("Earlier turn", 1));
    await source.appendCompactionAsync("Summary. ".repeat(550), kept!, 10_000);
    // Each run hydrates its own bounded view and prompt state, as the Gateway does.
    const run = async (maxBytes = 8_192) => {
      const manager = await SessionManager.openBoundedAsync(scope, { maxBytes, maxEvents: 100 });
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
      const resources = { trajectoryRecorder: null, buildAbortSettlePromise: () => null };
      const runtime = await prepareEmbeddedAttemptSessionRuntime({
        attempt: {
          config: {},
          admittedRunContext,
          workspaceDir: "/tmp/workspace",
          sessionKey: scope.sessionKey,
          model: { api: "openai-responses" },
          modelId: "gpt-5",
          provider: "openai",
          runId: "run-1",
          sessionId,
        },
        agentDir: "/agent",
        isRawModelRun: false,
        resolveActiveContextEnginePluginId: vi.fn(),
        setup: { prepStages: { mark: vi.fn() }, sessionAgentId: "main" },
        toolBase: { codeModeControlsEnabledForRun: false },
        toolCatalog: { installToolListingPin: async () => false, effectiveTools: [] },
        bundleTools: { clientTools: [], uncompactedEffectiveTools: [] },
        prepareSystemPrompt: async () => ({ systemPromptText: "initial prompt" }),
        sessionLock: {
          ownedTranscriptWriteContext: {},
          withOwnedTranscriptWrite: async (operation: () => unknown) => await operation(),
        },
        runAbortSignal: new AbortController().signal,
        externalAbortController: { setActiveSessionAbort: vi.fn() },
        resources,
        onSessionYieldReady: vi.fn(),
      } as unknown as PrepareInput);
      try {
        const prepared = await runtime.prepareSystemPromptUpdate!("## Skills\nPinned skills");
        expectDefined(prepared.commit, "prompt commit")();
        await persistSessionSystemPrompt(runtime.sessionPromptState, (customType, data) =>
          manager.appendCustomEntryAsync(customType, data),
        );
        return { prepared, manager };
      } finally {
        (resources as PrepareInput["resources"]).promptStateLease?.[Symbol.dispose]();
      }
    };
    const first = await run();
    expect(first.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
    // A later large turn pushes the compaction summary out of the next run's byte window.
    const writer = await SessionManager.openAsync(scope);
    await writer.appendMessageAsync(makeUserMessage("x".repeat(5_000), 2));
    const second = await run();
    expect(second.manager.getBoundaryCount()).toBe(1);
    expect(second.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    expect(second.prepared).toMatchObject({
      restart: false,
      seriesStatus: "pinned",
      systemPrompt: first.prepared.systemPrompt,
    });
    // A run with a larger window sees the compaction again; the series still holds.
    const third = await run(65_536);
    expect(third.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
    expect(third.prepared).toMatchObject({ restart: false, seriesStatus: "pinned" });
  } finally {
    await binding.actor.release();
    memorySessionActorOwners.closeDatabase(binding);
  }
});
