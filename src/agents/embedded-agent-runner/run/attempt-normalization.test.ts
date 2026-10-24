import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import * as sessionEntryWriter from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { normalizeEmbeddedRunAttempt } from "./attempt-normalization.js";
import {
  makeAttempt,
  makeNormalizationInput,
  makePromptState,
} from "./attempt-normalization.test-support.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import {
  assertAgentHarnessRunAdmission,
  buildContextEngineCompactionSessionTarget,
  resetNoRealConversationTokenSnapshot,
} from "./session-bootstrap.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

const fixedStoreConfig = {
  agents: {
    ownership: "explicit" as const,
    defaults: { sessionStore: { agentId: "ops" } },
    entries: { ops: {}, research: {} },
  },
  session: { store: "/tmp/shared-sessions.json" },
};
const mainTarget = (sessionId = "session-before") => ({
  agentId: "main",
  sessionId,
  sessionKey: "agent:main:main",
  storePath: "/tmp/sessions.json",
});

const sessionAccessorMocks = vi.hoisted(() => ({
  patchSessionEntryCore:
    vi.fn<typeof import("../../../config/sessions/session-accessor.js").patchSessionEntryCore>(),
  updateSessionEntry: vi.fn(async () => undefined),
}));
const sessionReaderMocks = vi.hoisted(() => ({
  readSessionEntrySummariesInWorker:
    vi.fn<
      typeof import("../../../config/sessions/session-entry-read-runtime.js").readSessionEntrySummariesInWorker
    >(),
  readSessionEntryInWorker:
    vi.fn<
      typeof import("../../../config/sessions/session-entry-read-runtime.js").readSessionEntryInWorker
    >(),
  readSessionEntryReadOnlyInWorker:
    vi.fn<
      typeof import("../../../config/sessions/session-entry-read-runtime.js").readSessionEntryReadOnlyInWorker
    >(),
}));

// mock-isolation: Keep normalization entry fixtures outside the session database.
vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => sessionReaderMocks);

// mock-isolation: Normalization fixtures control transcript lookup and persistence without starting storage.
vi.mock("../../../config/sessions/session-accessor.js", () => ({
  findTranscriptEvent: vi.fn(async () => undefined),
  ...sessionAccessorMocks,
}));

beforeEach(() => {
  sessionAccessorMocks.patchSessionEntryCore.mockReset().mockResolvedValue(null);
  sessionAccessorMocks.updateSessionEntry.mockReset().mockResolvedValue(undefined);
  sessionReaderMocks.readSessionEntrySummariesInWorker.mockReset().mockResolvedValue([]);
  sessionReaderMocks.readSessionEntryInWorker.mockReset().mockResolvedValue(undefined);
  sessionReaderMocks.readSessionEntryReadOnlyInWorker.mockReset().mockResolvedValue(undefined);
});

it.each([0, 2])(
  "retains compaction facts when parent Stop arrives during persistence (%s ingress records)",
  async (recordedCompactionCount) => {
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
      setParams: vi.fn(),
      setLifecycleGeneration: vi.fn(),
    });
    const cancelled = new Error("cancelled while user persistence was pending");
    const contextRecoveryState = createEmbeddedRunContextRecoveryState();
    contextRecoveryState.autoCompactionCount = recordedCompactionCount;
    contextRecoveryState.lastCompactionTokensAfter = recordedCompactionCount > 0 ? 60 : undefined;
    // Cancellation exits before model normalization; only the completed-attempt boundary is live.
    const normalization = normalizeEmbeddedRunAttempt({
      runInput: {
        runParams: params,
        laneController,
      },
      preparedRuntime: { snapshot: () => ({}) },
      recordedCompactionCount,
      dispatchedAttempt: {
        rawAttempt: { compactionCount: 2, compactionTokensAfter: 40.9 },
      },
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
  },
);

describe("buildContextEngineCompactionSessionTarget", () => {
  it("leaves the key absent when a marker has no stored mapping", async () => {
    expect(
      await buildContextEngineCompactionSessionTarget({
        sessionFile: "sqlite:main:marker-session:/tmp/sessions.json",
        sessionId: "stale-outer-session",
      }),
    ).toEqual({
      agentId: "main",
      sessionId: "marker-session",
      storePath: "/tmp/sessions.json",
    });
  });

  it("uses the explicit agent owner without inventing a session key", async () => {
    expect(
      await buildContextEngineCompactionSessionTarget({
        agentId: "worker",
        config: {
          agents: { ownership: "explicit", entries: { main: {}, worker: {} } },
          session: { store: "/tmp/{agentId}/sessions.json" },
        },
        sessionFile: "compat-session",
        sessionId: "compat-session",
      }),
    ).toEqual({
      agentId: "worker",
      sessionId: "compat-session",
      storePath: "/tmp/worker/sessions.json",
    });
  });

  it("rejects a partial target that conflicts with the fixed-store owner", async () => {
    await expect(
      buildContextEngineCompactionSessionTarget({
        config: fixedStoreConfig,
        sessionFile: "global",
        sessionId: "ops-session",
        sessionKey: "global",
        sessionTarget: {
          agentId: "research",
          sessionId: "ops-session",
          sessionKey: "global",
        },
      }),
    ).rejects.toThrow(/belongs to "ops"/u);
  });

  it("preserves an adopted session id without inventing a session key", async () => {
    expect(
      await buildContextEngineCompactionSessionTarget({
        sessionFile: "",
        sessionId: "previous-session",
        sessionTarget: {
          agentId: "main",
          sessionId: "adopted-session",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toEqual({
      agentId: "main",
      sessionId: "adopted-session",
      storePath: "/tmp/sessions.json",
    });
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

    expect(sessionReaderMocks.readSessionEntryInWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        sessionKey: "global",
        storePath: "/tmp/shared-sessions.json",
      }),
      expect.any(Function),
    );
  });
});

describe("createEmbeddedRunSessionPromptState", () => {
  it("keeps the admitted writer fence private across context-engine target adoption", async () => {
    await using state = await createEmbeddedRunSessionPromptState({
      runParams: {
        agentId: "main",
        prompt: "hello",
        runId: "run-b",
        sessionFile: "agent:main:main",
        sessionId: "session-before",
        sessionKey: "agent:main:main",
        sessionTarget: {
          ...mainTarget(),
          expectedLifecycleRevision: "revision-a",
          expectedWriterRunId: "run-b",
        },
        timeoutMs: 30_000,
        workspaceDir: "/tmp",
      } as never,
      lifecycleGeneration: "generation-a",
      onInterrupt: () => {},
      resolvedSessionKey: "agent:main:main",
      sessionAgentId: "main",
    });

    state.sessionTarget = mainTarget("session-after");

    expect(state.sessionTarget).not.toHaveProperty("expectedWriterRunId");
    expect(state.sessionWriterFence).toEqual({
      expectedLifecycleRevision: "revision-a",
      expectedWriterRunId: "run-b",
    });
  });
});

function promptState() {
  return {
    ...makePromptState(),
    sessionId: "session-before",
    sessionFile: "agent:main:main",
    sessionTarget: mainTarget(),
    adoptSessionId: vi.fn(),
  };
}

function adopt(
  state: ReturnType<typeof promptState>,
  sessionFileUsed?: string,
  assertCurrent: () => void = vi.fn(),
) {
  const input = makeNormalizationInput(
    makeAttempt(undefined, { sessionIdUsed: "session-after", sessionFileUsed }),
    state,
  );
  input.runInput.laneController.throwIfAborted = assertCurrent;
  return normalizeEmbeddedRunAttempt(input);
}

describe("normalizeEmbeddedRunAttempt session identity", () => {
  const bindingChanged = "successor target changed the active session binding";
  const inconsistent = /successor (identity is inconsistent|files are unsupported)/u;
  it.each(["marker", "key"] as const)(
    "waits for a %s lookup and preserves caller authority and the active binding",
    async (kind) => {
      for (const outcome of ["ready", "revoked", "binding-changed", "rejected"] as const) {
        const state = promptState();
        if (kind === "key") {
          state.sessionFile = "sqlite:main:session-before:/tmp/sessions.json";
        }
        const previousFile = state.sessionFile;
        const started = createDeferred();
        const gate = createDeferred();
        const failure = new Error(`identity read ${outcome}`);
        let active = true;
        const assertCurrent = () => {
          if (!active) {
            throw failure;
          }
        };
        const entry = { sessionId: "session-after", updatedAt: 2 };
        sessionReaderMocks.readSessionEntrySummariesInWorker.mockImplementationOnce(async () => {
          started.resolve();
          await gate.promise;
          return [{ sessionKey: "agent:main:main", entry }];
        });
        sessionReaderMocks.readSessionEntryReadOnlyInWorker.mockImplementationOnce(
          async (_scope, _assertCurrent) => {
            started.resolve();
            await gate.promise;
            return entry;
          },
        );
        const pending = adopt(
          state,
          kind === "marker" ? "sqlite:main:session-after:/tmp/sessions.json" : "agent:main:main",
          assertCurrent,
        );
        await awaitGateBeforeSettlement(started.promise, pending, "identity read was skipped");
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
        sessionReaderMocks.readSessionEntrySummariesInWorker.mockReset();
        sessionReaderMocks.readSessionEntryReadOnlyInWorker.mockReset();
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
    sessionReaderMocks.readSessionEntrySummariesInWorker.mockImplementationOnce(() => {
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
        rawAttempt: {
          terminal: { kind: "ok" },
          sessionIdUsed: "session-after",
          sessionFileUsed: "sqlite:main:session-after:/tmp/sessions.json",
        },
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
    sessionReaderMocks.readSessionEntrySummariesInWorker.mockResolvedValue([
      { sessionKey: "agent:main:main", entry: { sessionId: "session-before", updatedAt: 1 } },
    ]);
    const state = promptState();

    await adopt(state, "sqlite:main:session-after:/tmp/sessions.json");

    expect(state.sessionTarget).toEqual({
      agentId: "main",
      sessionId: "session-after",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    });
  });

  it.each([
    ["sqlite:main:session-after:/tmp/sessions.json", true, bindingChanged],
    ["sqlite:main:session-after:/tmp/other-sessions.json", false, bindingChanged],
    ["sqlite:other:session-after:/tmp/sessions.json", false, inconsistent],
    ["agent:other:main", false, inconsistent],
  ] as const)(
    "rejects an incompatible successor %s (mapped=%s)",
    async (sessionFileUsed, mapped, error) => {
      if (mapped) {
        sessionReaderMocks.readSessionEntrySummariesInWorker.mockResolvedValue([
          { sessionKey: "agent:main:main", entry: { sessionId: "session-before", updatedAt: 1 } },
          { sessionKey: "agent:main:other", entry: { sessionId: "session-after", updatedAt: 2 } },
        ]);
      }
      await expect(adopt(promptState(), sessionFileUsed)).rejects.toThrow(error);
    },
  );

  it("refreshes a legacy marker for an id-only successor", async () => {
    const state = promptState();
    state.sessionFile = "sqlite:main:session-before:/tmp/sessions.json";

    await adopt(state);

    expect(state.sessionFile).toBe("sqlite:main:session-after:/tmp/sessions.json");
    expect(state.sessionTarget).toMatchObject({ sessionId: "session-after" });
  });

  it("does not adopt a foreground successor from a detached attempt", async () => {
    const state = promptState();
    const input = makeNormalizationInput(
      makeAttempt(undefined, {
        sessionIdUsed: "foreground-session",
        sessionFileUsed: "sqlite:main:foreground-session:/tmp/sessions.json",
      }),
      state,
    );
    input.runInput.runParams.sessionPersistence = "detached";

    expect(await normalizeEmbeddedRunAttempt(input)).toMatchObject({ action: "proceed" });

    expect(sessionReaderMocks.readSessionEntrySummariesInWorker).not.toHaveBeenCalled();
    expect(sessionReaderMocks.readSessionEntryReadOnlyInWorker).not.toHaveBeenCalled();
    expect(state.adoptSessionId).not.toHaveBeenCalled();
    expect(state.sessionId).toBe("session-before");
    expect(state.sessionFile).toBe("agent:main:main");
    expect(state.sessionTarget).toEqual(mainTarget());
  });
});
