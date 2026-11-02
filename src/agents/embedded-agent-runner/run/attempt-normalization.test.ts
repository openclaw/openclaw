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

type SessionReaders = typeof import("../../../config/sessions/session-entry-read-runtime.js");
const sessionReaderMocks = vi.hoisted(() => ({
  readSessionEntrySummariesInWorker: vi.fn<SessionReaders["readSessionEntrySummariesInWorker"]>(),
  readSessionEntryInWorker: vi.fn<SessionReaders["readSessionEntryInWorker"]>(),
  readSessionEntryReadOnlyInWorker: vi.fn<SessionReaders["readSessionEntryReadOnlyInWorker"]>(),
}));

// mock-isolation: Keep normalization entry fixtures outside the session database.
vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => sessionReaderMocks);

// mock-isolation: Normalization fixtures control transcript lookup and persistence without starting storage.
vi.mock("../../../config/sessions/session-accessor.js", () => ({
  findTranscriptEvent: vi.fn(async () => undefined),
  patchSessionEntryCore: vi.fn(async () => null),
  updateSessionEntry: vi.fn(async () => undefined),
}));

beforeEach(() => {
  sessionReaderMocks.readSessionEntrySummariesInWorker.mockReset().mockResolvedValue([]);
  sessionReaderMocks.readSessionEntryInWorker.mockReset().mockResolvedValue(undefined);
  sessionReaderMocks.readSessionEntryReadOnlyInWorker.mockReset().mockResolvedValue(undefined);
});

it.each([
  { available: true, compactions: 0, tokens: 123 },
  { available: false, compactions: 0, tokens: undefined },
  { available: true, compactions: 1, tokens: 123 },
])(
  "records the native producer's ordered terminal context: %j",
  async ({ available, compactions, tokens }) => {
    const input = makeNormalizationInput(
      makeAttempt(undefined, {
        compactionCount: compactions,
        attemptUsage: {
          input: 9000,
          output: 500,
          contextUsage: available
            ? { state: "available", promptTokens: 100, totalTokens: 123 }
            : { state: "unavailable" },
        },
      }),
    );
    vi.spyOn(input.preparedRuntime, "snapshot").mockReturnValue({
      ...input.preparedRuntime.snapshot(),
      pluginHarnessOwnsTransport: true,
    });
    await normalizeEmbeddedRunAttempt(input);
    expect(input.contextRecoveryState.currentContextSnapshot).toEqual({ tokens });
  },
);

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
    const input = makeNormalizationInput(
      makeAttempt(undefined, { compactionCount: 2, compactionTokensAfter: 40.9 }),
      makePromptState(() => persistence.promise),
    );
    input.runInput.runParams = params;
    input.runInput.laneController = laneController;
    input.recordedCompactionCount = recordedCompactionCount;
    input.sessionPromptState.activePrompt.persisted = true;
    const contextRecoveryState = input.contextRecoveryState;
    contextRecoveryState.autoCompactionCount = recordedCompactionCount;
    contextRecoveryState.lastCompactionTokensAfter = recordedCompactionCount > 0 ? 60 : undefined;
    const normalization = normalizeEmbeddedRunAttempt(input);

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
  it.each([
    {
      sessionFile: "sqlite:main:marker-session:/tmp/sessions.json",
      sessionId: "stale-outer-session",
      expected: { agentId: "main", sessionId: "marker-session", storePath: "/tmp/sessions.json" },
    },
    {
      agentId: "worker",
      config: {
        agents: { ownership: "explicit" as const, entries: { main: {}, worker: {} } },
        session: { store: "/tmp/{agentId}/sessions.json" },
      },
      sessionFile: "compat-session",
      sessionId: "compat-session",
      expected: {
        agentId: "worker",
        sessionId: "compat-session",
        storePath: "/tmp/worker/sessions.json",
      },
    },
    {
      sessionFile: "",
      sessionId: "previous-session",
      sessionTarget: {
        agentId: "main",
        sessionId: "adopted-session",
        storePath: "/tmp/sessions.json",
      },
      expected: { agentId: "main", sessionId: "adopted-session", storePath: "/tmp/sessions.json" },
    },
  ])("resolves target without inventing a session key: %j", async ({ expected, ...input }) => {
    expect(await buildContextEngineCompactionSessionTarget(input)).toEqual(expected);
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
        const controller = new AbortController();
        const assertCurrent = () => controller.signal.throwIfAborted();
        state.activePrompt.persisted = true;
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
          controller.abort(failure);
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

  it("rebinds a legacy SQLite marker successor over the retained active entry", async () => {
    sessionReaderMocks.readSessionEntrySummariesInWorker.mockResolvedValue([
      { sessionKey: "agent:main:main", entry: { sessionId: "session-before", updatedAt: 1 } },
    ]);
    const state = promptState();

    await adopt(state, "sqlite:main:session-after:/tmp/sessions.json");

    expect(state.sessionTarget).toEqual(mainTarget("session-after"));
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
