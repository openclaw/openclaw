import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
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

const sessionAccessorMocks = vi.hoisted(() => ({
  listSessionEntriesReadOnly: vi.fn(() => []),
  loadSessionEntry: vi.fn(),
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
  withSessionEntryReadOnlyInWorker:
    vi.fn<
      typeof import("../../../config/sessions/session-entry-read-runtime.js").withSessionEntryReadOnlyInWorker
    >(),
}));

vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => sessionReaderMocks);

vi.mock("../../../config/sessions/session-accessor.js", () => ({
  findTranscriptEvent: vi.fn(async () => undefined),
  ...sessionAccessorMocks,
  loadSessionEntryReadOnly: sessionAccessorMocks.loadSessionEntry,
}));

beforeEach(() => {
  sessionAccessorMocks.listSessionEntriesReadOnly.mockReset().mockReturnValue([]);
  sessionAccessorMocks.loadSessionEntry.mockReset();
  sessionAccessorMocks.patchSessionEntryCore.mockReset().mockResolvedValue(null);
  sessionAccessorMocks.updateSessionEntry.mockReset().mockResolvedValue(undefined);
  sessionReaderMocks.readSessionEntrySummariesInWorker.mockReset().mockResolvedValue([]);
  sessionReaderMocks.readSessionEntryInWorker.mockReset().mockResolvedValue(undefined);
  sessionReaderMocks.withSessionEntryReadOnlyInWorker
    .mockReset()
    .mockImplementation(async (_scope, assertCurrent, consume) =>
      consume({ ok: true, value: undefined }, { kind: "file", assertCurrent }),
    );
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
  it("leaves the key absent when a marker has no stored mapping", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
        sessionFile: "sqlite:main:marker-session:/tmp/sessions.json",
        sessionId: "stale-outer-session",
      }),
    ).toEqual({
      agentId: "main",
      sessionId: "marker-session",
      storePath: "/tmp/sessions.json",
    });
  });

  it("uses the explicit agent owner without inventing a session key", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
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

  it("uses the persisted fixed-store owner for a bare compaction key", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
        config: {
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { ops: {}, research: {} },
          },
          session: { store: "/tmp/shared-sessions.json" },
        },
        sessionFile: "global",
        sessionId: "ops-session",
        sessionKey: "global",
      }),
    ).toMatchObject({
      agentId: "ops",
      sessionKey: "global",
      storePath: "/tmp/shared-sessions.json",
    });
  });

  it("rejects a partial target that conflicts with the fixed-store owner", () => {
    expect(() =>
      buildContextEngineCompactionSessionTarget({
        config: {
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { ops: {}, research: {} },
          },
          session: { store: "/tmp/shared-sessions.json" },
        },
        sessionFile: "global",
        sessionId: "ops-session",
        sessionKey: "global",
        sessionTarget: {
          agentId: "research",
          sessionId: "ops-session",
          sessionKey: "global",
        },
      }),
    ).toThrow(/belongs to "ops"/u);
  });

  it("preserves an adopted session id without inventing a session key", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
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
  const config = {
    agents: {
      ownership: "explicit" as const,
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
    session: { store: "/tmp/shared-sessions.json" },
  };

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
      const assertActive = () => {
        if (closed) {
          throw callerError;
        }
      };
      sessionAccessorMocks.patchSessionEntryCore.mockImplementationOnce(
        async (_scope, _update, options) => {
          closed = closeBeforeCommit;
          options?.assertCommitAllowed?.();
          return null;
        },
      );

      const reset = resetNoRealConversationTokenSnapshot({ sessionTarget, assertActive });
      if (closeBeforeCommit) {
        await expect(reset).rejects.toBe(callerError);
      } else {
        await reset;
      }
      expect(sessionAccessorMocks.patchSessionEntryCore).toHaveBeenCalledWith(
        sessionTarget,
        expect.any(Function),
        expect.objectContaining({ skipMaintenance: true, assertCommitAllowed: assertActive }),
      );
    },
  );

  it("carries the persisted owner into harness admission", async () => {
    await assertAgentHarnessRunAdmission({
      config,
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

  it("carries the resolved owner into quota-maintenance reads", async () => {
    sessionReaderMocks.readSessionEntryInWorker.mockResolvedValueOnce({
      sessionId: "ops-session",
      updatedAt: 1,
    });

    const assertCurrent = vi.fn();
    const scope = {
      agentId: "ops",
      sessionKey: "global",
      storePath: "/tmp/shared-sessions.json",
    };
    await loadAttemptSessionEntryAfterQuotaMaintenance(scope, assertCurrent);

    expect(sessionReaderMocks.readSessionEntryInWorker).toHaveBeenCalledWith(scope, assertCurrent);
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
          agentId: "main",
          expectedLifecycleRevision: "revision-a",
          expectedWriterRunId: "run-b",
          sessionId: "session-before",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
        timeoutMs: 30_000,
        workspaceDir: "/tmp",
      } as never,
      lifecycleGeneration: "generation-a",
      onInterrupt: () => {},
      resolvedSessionKey: "agent:main:main",
      sessionAgentId: "main",
    });

    state.sessionTarget = {
      agentId: "main",
      sessionId: "session-after",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    };

    expect(state.sessionTarget).not.toHaveProperty("expectedWriterRunId");
    expect(state.sessionWriterFence).toEqual({
      expectedLifecycleRevision: "revision-a",
      expectedWriterRunId: "run-b",
    });
  });
});

function promptState(storePath = "/tmp/sessions.json") {
  return {
    sessionId: "session-before",
    sessionFile: "agent:main:main",
    sessionTarget: {
      agentId: "main",
      sessionId: "session-before",
      sessionKey: "agent:main:main",
      storePath,
    },
    adoptSessionId: vi.fn(),
  };
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
        sessionReaderMocks.readSessionEntrySummariesInWorker.mockImplementationOnce(async () => {
          await gate.promise;
          return [{ sessionKey: "agent:main:main", entry }];
        });
        sessionReaderMocks.withSessionEntryReadOnlyInWorker.mockImplementationOnce(
          async (_scope, _assertCurrent, consume) => {
            await gate.promise;
            return consume({ ok: true, value: entry }, { kind: "file", assertCurrent });
          },
        );
        const pending = applyEmbeddedAttemptSessionIdentity({
          sessionPromptState: state,
          sessionIdUsed: "session-after",
          sessionFileUsed:
            kind === "marker" ? "sqlite:main:session-after:/tmp/sessions.json" : "agent:main:main",
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
        sessionReaderMocks.readSessionEntrySummariesInWorker.mockReset();
        sessionReaderMocks.withSessionEntryReadOnlyInWorker.mockReset();
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

  it("rejects a legacy successor file that cannot map to SQLite", async () => {
    const state = promptState();

    await expect(
      applyEmbeddedAttemptSessionIdentity({
        assertCurrent: vi.fn(),
        sessionPromptState: state,
        sessionIdUsed: "session-after",
        sessionFileUsed: "/tmp/session-after.jsonl",
      }),
    ).rejects.toThrow("successor files are unsupported");
    expect(state.adoptSessionId).not.toHaveBeenCalled();
    expect(state.sessionTarget).toMatchObject({ sessionId: "session-before" });
  });

  it.each([
    { key: "agent:main:main", mapped: false },
    { key: "agent:main:main", mapped: true },
    { key: "main", mapped: true },
  ])("resolves a marker successor retaining $key (mapped: $mapped)", async ({ key, mapped }) => {
    const state = promptState();
    state.sessionTarget.sessionKey = key;
    sessionReaderMocks.readSessionEntrySummariesInWorker.mockResolvedValue(
      mapped
        ? [{ sessionKey: "agent:main:main", entry: { sessionId: "session-after", updatedAt: 1 } }]
        : [],
    );

    await applyEmbeddedAttemptSessionIdentity({
      assertCurrent: vi.fn(),
      sessionPromptState: state,
      sessionIdUsed: "session-after",
      sessionFileUsed: "sqlite:main:session-after:/tmp/sessions.json",
    });

    expect(state.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: "session-after",
      sessionKey: key,
      storePath: "/tmp/sessions.json",
    });
  });

  it("rebinds a legacy SQLite marker successor over the retained active entry", async () => {
    sessionReaderMocks.readSessionEntrySummariesInWorker.mockResolvedValue([
      { sessionKey: "agent:main:main", entry: { sessionId: "session-before", updatedAt: 1 } },
    ]);
    const state = promptState();

    await applyEmbeddedAttemptSessionIdentity({
      assertCurrent: vi.fn(),
      sessionPromptState: state,
      sessionIdUsed: "session-after",
      sessionFileUsed: "sqlite:main:session-after:/tmp/sessions.json",
    });

    expect(state.sessionTarget).toEqual({
      agentId: "main",
      sessionId: "session-after",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    });
  });

  it("rejects a legacy marker successor already mapped to another key", async () => {
    sessionReaderMocks.readSessionEntrySummariesInWorker.mockResolvedValue([
      { sessionKey: "agent:main:main", entry: { sessionId: "session-before", updatedAt: 1 } },
      {
        sessionKey: "agent:main:other",
        entry: { sessionId: "session-after", updatedAt: 2 },
      },
    ]);
    const state = promptState();

    await expect(
      applyEmbeddedAttemptSessionIdentity({
        assertCurrent: vi.fn(),
        sessionPromptState: state,
        sessionIdUsed: "session-after",
        sessionFileUsed: "sqlite:main:session-after:/tmp/sessions.json",
      }),
    ).rejects.toThrow("successor target changed the active session binding");
  });

  it("rejects a legacy SQLite marker outside the active store", async () => {
    const state = promptState();

    await expect(
      applyEmbeddedAttemptSessionIdentity({
        assertCurrent: vi.fn(),
        sessionPromptState: state,
        sessionIdUsed: "session-after",
        sessionFileUsed: "sqlite:main:session-after:/tmp/other-sessions.json",
      }),
    ).rejects.toThrow("successor target changed the active session binding");
  });

  it.each(["sqlite:other:session-after:/tmp/sessions.json", "agent:other:main"])(
    "rejects a cross-agent legacy successor identity: %s",
    async (sessionFileUsed) => {
      const state = promptState();

      await expect(
        applyEmbeddedAttemptSessionIdentity({
          assertCurrent: vi.fn(),
          sessionPromptState: state,
          sessionIdUsed: "session-after",
          sessionFileUsed,
        }),
      ).rejects.toThrow(/successor (identity is inconsistent|files are unsupported)/u);
    },
  );

  it("retargets an id-only successor without discarding its SQLite identity", async () => {
    const state = promptState();

    await applyEmbeddedAttemptSessionIdentity({
      assertCurrent: vi.fn(),
      sessionPromptState: state,
      sessionIdUsed: "session-after",
    });

    expect(state.sessionTarget).toMatchObject({ sessionId: "session-after" });
  });

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
