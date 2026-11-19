// Prompt series identity across runs whose bounded transcript window omits an old compaction.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../../config/sessions/session-actor-storage-acquisition.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import type { SessionEntry } from "../../sessions/session-manager-types.js";
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
const sessionIds = new Set<string>();
afterEach(() => clearEmbeddedSessionPromptStates([...sessionIds]));

const isCheckpoint = (entry: SessionEntry) =>
  entry.type === "custom" && entry.customType === "openclaw.system-prompt";
const hasCompaction = (manager: SessionManager) =>
  manager.getBranch().some((entry) => entry.type === "compaction");

/** One SQLite-backed session. Each run hydrates its own bounded view and prompt state, as the Gateway does. */
async function openSession(sessionId: string) {
  sessionIds.add(sessionId);
  const env = { OPENCLAW_STATE_DIR: `/synthetic/prompt-history-boundary/${sessionId}` };
  const scope = {
    agentId: "main",
    env,
    sessionId,
    sessionKey: `agent:main:dashboard:incognito-${sessionId}`,
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const admission = prepareSystemAgentRunAdmission(
    {},
    `run-${sessionId}`,
    "main",
    "history-boundary",
  );
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
  const run = async (prompt = "## Skills\nPinned skills", maxBytes = 8_192) => {
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
        runId: `run-${sessionId}`,
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
      const prepared = await runtime.prepareSystemPromptUpdate!(prompt);
      expectDefined(prepared.commit, "prompt commit")();
      await persistSessionSystemPrompt(runtime.sessionPromptState, (customType, data) =>
        manager.appendCustomEntryAsync(customType, data),
      );
      return { prepared, manager };
    } finally {
      (resources as PrepareInput["resources"]).promptStateLease?.[Symbol.dispose]();
    }
  };
  return { run, open: () => SessionManager.openAsync(scope) };
}

/** A session whose one compaction summary (about 5 KB) fits an 8 KB window until a large turn follows. */
async function openCompactedSession(sessionId: string) {
  const session = await openSession(sessionId);
  const source = await session.open();
  const kept = await source.appendMessageAsync(makeUserMessage("Earlier turn", 1));
  await source.appendCompactionAsync("Summary. ".repeat(550), kept!, 10_000);
  const pushOut = async () =>
    await (await session.open()).appendMessageAsync(makeUserMessage("x".repeat(5_000), 2));
  return { ...session, pushOut };
}

it("keeps the series across runs when the bounded window drops an old compaction", async () => {
  const session = await openCompactedSession("history-boundary-window");
  const first = await session.run();
  expect(hasCompaction(first.manager)).toBe(true);
  // A later large turn pushes the compaction summary out of the next run's byte window.
  await session.pushOut();
  const second = await session.run();
  expect(second.manager.getBoundaryCount()).toBe(1);
  expect(hasCompaction(second.manager)).toBe(false);
  expect(second.prepared).toMatchObject({
    restart: false,
    seriesStatus: "pinned",
    systemPrompt: first.prepared.systemPrompt,
  });
  // A run with a larger window sees the compaction again; the series still holds.
  const third = await session.run(undefined, 65_536);
  expect(hasCompaction(third.manager)).toBe(true);
  expect(third.prepared).toMatchObject({ restart: false, seriesStatus: "pinned" });
});

it("restarts a legacy series at most twice: unknown history, then the boundary id", async () => {
  const session = await openCompactedSession("history-boundary-legacy");
  const first = await session.run("P1", 65_536);
  // Before the boundary count was recorded, a window without the compaction wrote historyId null.
  const legacy = first.manager.getBranch().findLast(isCheckpoint);
  if (legacy?.type !== "custom") {
    throw new Error("Missing prompt checkpoint");
  }
  const { boundaryCount: _count, ...data } = legacy.data as Record<string, unknown>;
  await (
    await session.open()
  ).appendCustomEntryAsync(legacy.customType, {
    ...data,
    historyId: null,
  });
  await session.pushOut();
  const runs = [];
  for (const maxBytes of [8_192, 65_536, 8_192, 65_536]) {
    const { prepared, manager } = await session.run(`P${runs.length + 2}`, maxBytes);
    runs.push({ prepared, compaction: hasCompaction(manager) });
  }
  expect(runs).toMatchObject([
    { prepared: { seriesStatus: "restarted:history" }, compaction: false },
    { prepared: { seriesStatus: "restarted:history" }, compaction: true },
    { prepared: { seriesStatus: "pinned" }, compaction: false },
    { prepared: { seriesStatus: "pinned" }, compaction: true },
  ]);
});

it("does not keep a later history's series after a rewind to before its compaction", async () => {
  const session = await openSession("history-boundary-rewind");
  const writer = await session.open();
  const kept = await writer.appendMessageAsync(makeUserMessage("First turn", 1));
  await writer.appendCompactionAsync("First summary.", kept!, 1_000);
  const first = await session.run("P1");
  const rewindTo = expectDefined(
    first.manager.getBranch().findLast(isCheckpoint)?.id,
    "checkpoint",
  );
  const later = await session.open();
  const keptLater = await later.appendMessageAsync(makeUserMessage("Second turn", 2));
  await later.appendCompactionAsync("Second summary.", keptLater!, 1_000);
  const second = await session.run("P2");
  expect(second.manager.getBoundaryCount()).toBe(2);
  expect(second.prepared).toMatchObject({ restart: true, systemPrompt: "P2" });
  // Rewind to the checkpoint before the second compaction and continue from there.
  const rewound = await session.open();
  await rewound.branchAsync(rewindTo);
  await rewound.appendMessageAsync(makeUserMessage("Rewound turn", 3));
  const third = await session.run("P3");
  expect(third.manager.getBoundaryCount()).toBe(1);
  expect(third.prepared).toMatchObject({ restart: false, systemPrompt: "P1" });
});

it("keeps the series when an earlier message is edited without a compaction", async () => {
  const session = await openSession("history-boundary-edit");
  await (await session.open()).appendMessageAsync(makeUserMessage("First turn", 1));
  await session.run("P1");
  const edited = expectDefined(
    await (await session.open()).appendMessageAsync(makeUserMessage("Second turn", 2)),
    "message",
  );
  expect((await session.run("P2")).prepared).toMatchObject({ restart: false, systemPrompt: "P1" });
  const editor = await session.open();
  await editor.branchAsync(expectDefined(editor.getEntry(edited)?.parentId, "parent"));
  await editor.appendMessageAsync(makeUserMessage("Second turn, edited", 3));
  const third = await session.run("P3");
  expect(third.manager.getBoundaryCount()).toBe(0);
  expect(third.prepared).toMatchObject({
    restart: false,
    seriesStatus: "pinned",
    systemPrompt: "P1",
  });
});

it("restarts the series at a reset", async () => {
  const session = await openCompactedSession("history-boundary-reset");
  expect((await session.run("P1")).manager.getBoundaryCount()).toBe(1);
  await (await session.open()).appendResetBoundaryAsync("reset");
  const next = await session.run("P2");
  expect(next.manager.getBoundaryCount()).toBe(2);
  expect(next.prepared).toMatchObject({
    restart: true,
    seriesStatus: "restarted:history",
    systemPrompt: "P2",
  });
});

it("keeps unknown histories with the same boundary count per session", async () => {
  const sessions = [
    await openCompactedSession("history-boundary-session-a"),
    await openCompactedSession("history-boundary-session-b"),
  ];
  const firstRuns = [];
  for (const [index, session] of sessions.entries()) {
    await session.pushOut();
    const { prepared, manager } = await session.run(`P-${index}`);
    expect(hasCompaction(manager)).toBe(false);
    expect(manager.getBranch().findLast(isCheckpoint)).toMatchObject({
      data: { historyId: "unknown:1", boundaryCount: 1 },
    });
    firstRuns.push(prepared.systemPrompt);
  }
  expect(firstRuns).toEqual(["P-0", "P-1"]);
  for (const [index, session] of sessions.entries()) {
    expect((await session.run("P-next")).prepared).toMatchObject({
      restart: false,
      systemPrompt: `P-${index}`,
    });
  }
});
