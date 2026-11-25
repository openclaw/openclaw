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

// mock-isolation: A synthetic agent session stands in; the bounded SQLite manager stays real.
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
// mock-isolation: The synthetic session has no provider stream to wrap.
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

it("restarts a legacy series once, then keeps it when the boundary returns", async () => {
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
    { prepared: { seriesStatus: "pinned" }, compaction: true },
    { prepared: { seriesStatus: "pinned" }, compaction: false },
    { prepared: { seriesStatus: "pinned" }, compaction: true },
  ]);
});

it("keeps an unknown history when its checkpoint and the boundary return to the window", async () => {
  const session = await openCompactedSession("history-boundary-eviction");
  await session.run("P1", 65_536);
  // A stable prompt writes no new checkpoint, so the old one leaves the window with the compaction.
  for (const turn of [2, 3]) {
    await (await session.open()).appendMessageAsync(makeUserMessage("y".repeat(4_000), turn));
  }
  const runs = [];
  for (const maxBytes of [8_192, 16_384, 8_192]) {
    const { prepared, manager } = await session.run("P1", maxBytes);
    runs.push({ prepared, compaction: hasCompaction(manager) });
  }
  expect(runs).toMatchObject([
    // Nothing in the window names the history: the series restarts once as unknown:1.
    { prepared: { restart: true }, compaction: false },
    // The boundary fits again beside the unknown:1 checkpoint of the same count.
    { prepared: { restart: false, seriesStatus: "pinned" }, compaction: true },
    { prepared: { restart: false, seriesStatus: "pinned" }, compaction: false },
  ]);
});

it("records the boundary count on a legacy checkpoint that names the visible boundary", async () => {
  const session = await openCompactedSession("history-boundary-legacy-count");
  const first = await session.run("P1", 65_536);
  const checkpoint = first.manager.getBranch().findLast(isCheckpoint);
  if (checkpoint?.type !== "custom") {
    throw new Error("Missing prompt checkpoint");
  }
  // Written before the count existed, while the window held the compaction.
  const { boundaryCount: _count, ...data } = checkpoint.data as Record<string, unknown>;
  await (await session.open()).appendCustomEntryAsync(checkpoint.customType, data);
  const statuses = [];
  for (const maxBytes of [65_536, 8_192, 65_536]) {
    if (maxBytes === 8_192) {
      await session.pushOut();
    }
    statuses.push((await session.run("P1", maxBytes)).prepared);
  }
  expect(statuses).toMatchObject([
    { seriesStatus: "pinned" },
    { seriesStatus: "pinned" },
    { seriesStatus: "pinned" },
  ]);
});

it("keeps the first history's series after a rewind past a later compaction", async () => {
  const session = await openCompactedSession("history-boundary-rewind");
  await session.pushOut();
  // Count 1 with the compaction outside the window: the series is named unknown:1.
  const first = await session.run("P1");
  expect(hasCompaction(first.manager)).toBe(false);
  const checkpoint = first.manager.getBranch().findLast(isCheckpoint);
  expect(checkpoint).toMatchObject({ data: { historyId: "unknown:1", boundaryCount: 1 } });
  const rewindTo = expectDefined(checkpoint?.id, "checkpoint");
  const writer = await session.open();
  await writer.appendCompactionAsync("Later summary.", rewindTo, 1_000);
  expect((await session.run("P2")).prepared).toMatchObject({ restart: true, systemPrompt: "P2" });
  // Rewind to P1's checkpoint and continue there. The abandoned compaction is still stored, but
  // the active path has one boundary again, so the unknown:1 series of P1 still applies.
  const rewound = await session.open();
  await rewound.branchAsync(rewindTo);
  await rewound.appendMessageAsync(makeUserMessage("Rewound turn", 3));
  const third = await session.run("P3");
  expect(third.manager.getBoundaryCount()).toBe(1);
  expect(third.prepared).toMatchObject({ restart: false, systemPrompt: "P1" });
});

it("restarts at a reset even though the window holds a checkpoint of the earlier history", async () => {
  const session = await openCompactedSession("history-boundary-reset");
  await session.run("P1", 65_536);
  // The reset is counted, so the checkpoint written at count 1 no longer names the history.
  await (await session.open()).appendResetBoundaryAsync("reset");
  const next = await session.run("P2", 65_536);
  expect(next.manager.getBoundaryCount()).toBe(2);
  expect(next.prepared).toMatchObject({
    restart: true,
    seriesStatus: "restarted:history",
    systemPrompt: "P2",
  });
});

it("restarts at a visible compaction after a counted checkpoint", async () => {
  const session = await openCompactedSession("history-boundary-new-compaction");
  await session.run("P1", 65_536);
  const writer = await session.open();
  const kept = await writer.appendMessageAsync(makeUserMessage("Later turn", 2));
  await writer.appendCompactionAsync("Later summary.", kept!, 1_000);
  const next = await session.run("P2", 65_536);
  expect(next.manager.getBoundaryCount()).toBe(2);
  expect(next.prepared).toMatchObject({
    restart: true,
    seriesStatus: "restarted:history",
    systemPrompt: "P2",
  });
});
