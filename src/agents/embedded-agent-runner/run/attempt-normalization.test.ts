import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import * as sessionEntryWriter from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { normalizeEmbeddedRunAttempt } from "./attempt-normalization.js";
import { applyEmbeddedAttemptSessionIdentity } from "./attempt-session-identity.js";
import { loadAttemptSessionEntryAfterQuotaMaintenance } from "./attempt-transcript-helpers.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import {
  assertAgentHarnessRunAdmission,
  buildContextEngineCompactionSessionTarget,
  resetNoRealConversationTokenSnapshot,
} from "./session-bootstrap.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

type SessionReader = typeof import("../../../config/sessions/session-entry-read-runtime.js");
const fixedStoreConfig = {
  agents: {
    ownership: "explicit" as const,
    defaults: { sessionStore: { agentId: "ops" } },
    entries: { ops: {}, research: {} },
  },
  session: { store: "/tmp/shared-sessions.json" },
};
const sessionKey = "agent:main:main";
const markerAfter = "sqlite:main:session-after:/tmp/sessions.json";
const successor = { sessionIdUsed: "session-after", sessionFileUsed: markerAfter };
const fixedStoreTarget = {
  agentId: "ops",
  sessionKey: "global",
  storePath: fixedStoreConfig.session.store,
};

function makeSessionTarget(sessionId = "session-before", storePath = "/tmp/sessions.json") {
  return { agentId: "main", sessionId, sessionKey, storePath };
}

const reads = vi.hoisted(() => ({
  summaries: vi.fn<SessionReader["readSessionEntrySummariesInWorker"]>(),
  entry: vi.fn<SessionReader["readSessionEntryInWorker"]>(),
  withEntry: vi.fn<SessionReader["withSessionEntryReadOnlyInWorker"]>(),
}));

vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntrySummariesInWorker: reads.summaries,
  readSessionEntryInWorker: reads.entry,
  withSessionEntryReadOnlyInWorker: reads.withEntry,
}));

beforeEach(() => {
  reads.summaries.mockReset().mockResolvedValue([]);
  reads.entry.mockReset().mockResolvedValue(undefined);
  reads.withEntry.mockReset();
});

it.each([0, 2])("keeps compaction facts across Stop (%s)", async (recordedCompactionCount) => {
  const persistence = createDeferred();
  const controller = new AbortController();
  const generation = getAgentEventLifecycleGeneration();
  const params = {
    abortSignal: controller.signal,
    prompt: "Stop while persisting",
    runId: "normalization-stop",
    sessionId: "normalization-stop",
    sessionFile: "agent:main:normalization-stop",
    timeoutMs: 30_000,
    workspaceDir: "/tmp",
  };
  const laneController = createEmbeddedRunLaneController({
    getParams: () => params,
    getLifecycleGeneration: () => generation,
    initialQueuedLifecycleGeneration: generation,
    globalLane: "normalization-stop-global",
    sessionLane: "normalization-stop-session",
    setParams: vi.fn(),
    setLifecycleGeneration: vi.fn(),
  });
  const cancelled = new Error("cancelled while user persistence was pending");
  const contextRecoveryState = createEmbeddedRunContextRecoveryState();
  contextRecoveryState.autoCompactionCount = recordedCompactionCount;
  contextRecoveryState.lastCompactionTokensAfter = recordedCompactionCount > 0 ? 60 : undefined;
  // Cancellation exits before model normalization; only the completed-attempt boundary is live.
  const normalization = normalizeEmbeddedRunAttempt({
    runInput: { runParams: params, laneController },
    preparedRuntime: { snapshot: () => ({}) },
    recordedCompactionCount,
    dispatchedAttempt: { rawAttempt: { compactionCount: 2, compactionTokensAfter: 40.9 } },
    sessionPromptState: {
      activePrompt: { persisted: true },
      waitForCurrentUserMessagePersistence: () => persistence.promise,
    },
    contextRecoveryState,
  } as never);

  controller.abort(cancelled);
  persistence.resolve();
  await expect(normalization).rejects.toBe(cancelled);
  expect(contextRecoveryState).toMatchObject({
    autoCompactionCount: 2,
    lastCompactionTokensAfter: recordedCompactionCount > 0 ? 60 : 40,
  });
});

describe("buildContextEngineCompactionSessionTarget", () => {
  it.each([
    {
      name: "explicit owner",
      input: {
        agentId: "worker",
        config: {
          agents: { ownership: "explicit" as const, entries: { main: {}, worker: {} } },
          session: { store: "/tmp/{agentId}/sessions.json" },
        },
        sessionFile: "compat",
        sessionId: "compat",
      },
      expected: { agentId: "worker", sessionId: "compat", storePath: "/tmp/worker/sessions.json" },
    },
    {
      name: "adopted session id",
      input: {
        sessionFile: "",
        sessionId: "previous-session",
        sessionTarget: { agentId: "main", sessionId: "adopted", storePath: "/tmp/sessions.json" },
      },
      expected: { agentId: "main", sessionId: "adopted", storePath: "/tmp/sessions.json" },
    },
    {
      name: "marker over stale outer id",
      input: {
        sessionFile: "sqlite:main:marker:/tmp/sessions.json",
        sessionId: "stale-outer",
      },
      expected: { agentId: "main", sessionId: "marker", storePath: "/tmp/sessions.json" },
    },
  ])("resolves $name without inventing a session key", async ({ input, expected }) => {
    expect(await buildContextEngineCompactionSessionTarget(input)).toEqual(expected);
  });

  it("rejects a partial target that conflicts with the fixed-store owner", async () => {
    await expect(
      buildContextEngineCompactionSessionTarget({
        config: fixedStoreConfig,
        sessionFile: "global",
        sessionId: "ops-session",
        sessionKey: "global",
        sessionTarget: { agentId: "research", sessionId: "ops-session", sessionKey: "global" },
      }),
    ).rejects.toThrow(/belongs to "ops"/u);
  });
});

describe("fixed-store session bootstrap", () => {
  it.each([false, true])(
    "keeps the prepared reset target and its commit owner (closed=%s)",
    async (closeBeforeCommit) => {
      const sessionTarget = {
        agentId: "ops",
        sessionId: "ops-session",
        sessionKey: "global",
        storePath: "/tmp/explicit-openclaw-agent.sqlite",
      };
      const callerError = new Error("reset owner closed while waiting for commit");
      let closed = false;
      let commitGuardAccepted = false;
      const assertActive = () => {
        if (closed) {
          throw callerError;
        }
      };
      const applyOperation = vi
        .spyOn(sessionEntryWriter, "applySessionEntryOperation")
        .mockImplementationOnce(async (_scope, _operation, options) => {
          closed = closeBeforeCommit;
          options?.workerGuard?.source?.();
          commitGuardAccepted = true;
          return null;
        });
      onTestFinished(() => applyOperation.mockRestore());

      const reset = resetNoRealConversationTokenSnapshot({ sessionTarget, assertActive });
      if (closeBeforeCommit) {
        await expect(reset).rejects.toBe(callerError);
      } else {
        await reset;
      }
      expect(applyOperation).toHaveBeenCalledWith(
        sessionTarget,
        expect.any(Object),
        expect.objectContaining({
          skipMaintenance: true,
          workerGuard: expect.objectContaining({ source: assertActive }),
        }),
      );
      expect(commitGuardAccepted).toBe(!closeBeforeCommit);
    },
  );

  it("carries the persisted owner into harness admission", async () => {
    await assertAgentHarnessRunAdmission({
      config: fixedStoreConfig,
      sessionId: "ops-session",
      sessionKey: "global",
    } as never);

    expect(reads.entry).toHaveBeenCalledWith(
      expect.objectContaining(fixedStoreTarget),
      expect.any(Function),
    );
  });

  it("carries the resolved owner and authority into quota-maintenance reads", async () => {
    reads.entry.mockResolvedValueOnce({ sessionId: "ops-session", updatedAt: 1 });
    const assertCurrent = vi.fn();
    await loadAttemptSessionEntryAfterQuotaMaintenance(fixedStoreTarget, assertCurrent);
    expect(reads.entry).toHaveBeenCalledWith(fixedStoreTarget, assertCurrent);
  });
});

it("keeps the admitted writer fence private across context-engine target adoption", async () => {
  const fence = { expectedLifecycleRevision: "revision-a", expectedWriterRunId: "run-b" };
  await using state = await createEmbeddedRunSessionPromptState({
    runParams: {
      sessionFile: sessionKey,
      sessionId: "session-before",
      sessionTarget: { ...makeSessionTarget(), ...fence },
    } as never,
    lifecycleGeneration: "generation-a",
    onInterrupt: () => {},
    resolvedSessionKey: "agent:main:main",
    sessionAgentId: "main",
  });

  state.sessionTarget = makeSessionTarget("session-after");

  expect(state.sessionTarget).not.toHaveProperty("expectedWriterRunId");
  expect(state.sessionWriterFence).toEqual(fence);
});

function promptState(storePath = "/tmp/sessions.json") {
  return {
    sessionId: "session-before",
    sessionFile: "agent:main:main",
    sessionTarget: makeSessionTarget("session-before", storePath),
    adoptSessionId: vi.fn(),
  };
}

function applyIdentity(state = promptState(), sessionFileUsed: string | undefined = markerAfter) {
  return applyEmbeddedAttemptSessionIdentity({
    assertCurrent: vi.fn(),
    sessionPromptState: state,
    sessionIdUsed: "session-after",
    sessionFileUsed,
  });
}

describe("applyEmbeddedAttemptSessionIdentity", () => {
  it.each(["marker", "key"] as const)(
    "waits for a %s lookup and preserves caller authority and the active binding",
    async (kind) => {
      for (const outcome of ["ready", "revoked", "binding-changed", "rejected"] as const) {
        const state = promptState();
        if (kind === "key") {
          state.sessionFile = "sqlite:main:session-before:/tmp/sessions.json";
        }
        const previousFile = state.sessionFile;
        const gate = createDeferred();
        const failure = new Error(`identity read ${outcome}`);
        let active = true;
        const assertCurrent = () => {
          if (!active) {
            throw failure;
          }
        };
        const entry = { sessionId: "session-after", updatedAt: 2 };
        reads.summaries.mockImplementationOnce(async () => {
          await gate.promise;
          return [{ sessionKey: "agent:main:main", entry }];
        });
        reads.withEntry.mockImplementationOnce(async (_scope, _assertCurrent, consume) => {
          await gate.promise;
          return consume({ ok: true, value: entry }, { kind: "file", assertCurrent });
        });
        const pending = applyEmbeddedAttemptSessionIdentity({
          sessionPromptState: state,
          sessionIdUsed: "session-after",
          sessionFileUsed: kind === "marker" ? markerAfter : sessionKey,
          assertCurrent,
        });
        expect(state.adoptSessionId).not.toHaveBeenCalled();
        expect(state.sessionFile).toBe(previousFile);
        if (outcome === "revoked") {
          active = false;
        } else if (outcome === "binding-changed") {
          state.sessionTarget.sessionKey = "agent:main:replacement";
        }
        if (outcome === "rejected") {
          gate.reject(failure);
        } else {
          gate.resolve();
        }
        if (outcome === "ready") {
          await pending;
          expect(state.adoptSessionId).toHaveBeenCalledWith("session-after");
          expect(state.sessionTarget.sessionId).toBe("session-after");
        } else {
          if (outcome === "binding-changed") {
            await expect(pending).rejects.toThrow("changed the active session binding");
          } else {
            await expect(pending).rejects.toBe(failure);
          }
          expect(state.adoptSessionId).not.toHaveBeenCalled();
          expect(state.sessionFile).toBe(previousFile);
          expect(state.sessionTarget.sessionId).toBe("session-before");
        }
        reads.summaries.mockReset();
        reads.withEntry.mockReset();
      }
    },
  );

  it("normalization rechecks lane cancellation before adopting a delayed successor", async () => {
    const state = {
      ...promptState(),
      activePrompt: { persisted: true },
      waitForCurrentUserMessagePersistence: async () => {},
    };
    const started = createDeferred();
    const read = createDeferred<[]>();
    reads.summaries.mockImplementationOnce(() => {
      started.resolve();
      return read.promise;
    });
    const controller = new AbortController();
    const cancelled = new Error("lane cancelled during identity lookup");
    const normalization = normalizeEmbeddedRunAttempt({
      runInput: {
        runParams: { abortSignal: controller.signal },
        laneController: { throwIfAborted: () => controller.signal.throwIfAborted() },
      },
      preparedRuntime: { snapshot: () => ({}) },
      dispatchedAttempt: {
        rawAttempt: { terminal: { kind: "ok" }, ...successor },
      },
      sessionPromptState: state,
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
    } as never);
    await awaitGateBeforeSettlement(started.promise, normalization, "identity read was skipped");
    controller.abort(cancelled);
    read.resolve([]);
    await expect(normalization).rejects.toBe(cancelled);
    expect(state.adoptSessionId).not.toHaveBeenCalled();
    expect(state.sessionTarget.sessionId).toBe("session-before");
  });

  it("rebinds a legacy SQLite marker successor over the retained active entry", async () => {
    reads.summaries.mockResolvedValue([
      { sessionKey: "agent:main:main", entry: { sessionId: "session-before", updatedAt: 1 } },
    ]);
    const state = promptState();

    await applyIdentity(state);
    expect(state.sessionTarget).toEqual(makeSessionTarget("session-after"));
  });

  it.each([markerAfter, "sqlite:main:session-after:/tmp/other-sessions.json"])(
    "rejects a successor mapped to another key or store: %s",
    async (file) => {
      if (file === markerAfter) {
        reads.summaries.mockResolvedValue([
          { sessionKey, entry: { sessionId: "session-before", updatedAt: 1 } },
          { sessionKey: "agent:main:other", entry: { sessionId: "session-after", updatedAt: 2 } },
        ]);
      }
      await expect(applyIdentity(promptState(), file)).rejects.toThrow(
        "successor target changed the active session binding",
      );
    },
  );

  it.each(["sqlite:other:session-after:/tmp/sessions.json", "agent:other:main"])(
    "rejects a cross-agent legacy successor identity: %s",
    async (sessionFileUsed) => {
      await expect(applyIdentity(promptState(), sessionFileUsed)).rejects.toThrow(
        /successor (identity is inconsistent|files are unsupported)/u,
      );
    },
  );

  it("refreshes a legacy marker for an id-only successor", async () => {
    const state = promptState();
    state.sessionFile = "sqlite:main:session-before:/tmp/sessions.json";

    await applyEmbeddedAttemptSessionIdentity({
      assertCurrent: vi.fn(),
      sessionPromptState: state,
      sessionIdUsed: "session-after",
    });

    expect(state.sessionFile).toBe("sqlite:main:session-after:/tmp/sessions.json");
    expect(state.sessionTarget).toMatchObject({ sessionId: "session-after" });
  });
});
