import { beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import { prepareEmbeddedAttemptHistory } from "./attempt-history-prepare.js";

const mocks = vi.hoisted(() => ({
  readEntry:
    vi.fn<
      typeof import("../../../config/sessions/session-entry-read-runtime.js").readSessionEntryInWorker
    >(),
  readSummaries:
    vi.fn<
      typeof import("../../../config/sessions/session-entry-read-runtime.js").readSessionEntrySummariesInWorker
    >(),
  updateEntry:
    vi.fn<typeof import("../../../config/sessions/session-accessor.js").patchSessionEntryCore>(),
}));

vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryInWorker: mocks.readEntry,
  readSessionEntrySummariesInWorker: mocks.readSummaries,
}));
vi.mock("../../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: mocks.updateEntry,
  loadSessionEntry: () => {
    throw new Error("main-thread entry read");
  },
  listSessionEntriesReadOnly: () => {
    throw new Error("main-thread hierarchy read");
  },
}));
vi.mock("../replay-history.js", () => ({
  sanitizeSessionHistory: async ({ messages }: { messages: AgentMessage[] }) => [...messages],
  validateReplayTurns: async ({ messages }: { messages: AgentMessage[] }) => messages,
}));

function createFixture() {
  const messages: AgentMessage[] = [{ role: "user", content: "Continue", timestamp: 1 }];
  const agent = { state: { messages } };
  const entry: SessionEntry = {
    sessionId: "parent-session",
    updatedAt: 1,
    quotaSuspension: {
      schemaVersion: 1,
      suspendedAt: Date.now(),
      state: "resuming",
      reason: "quota_exhausted",
      failedProvider: "test-provider",
      failedModel: "test-model",
      summary: "Delegate the remaining work",
    },
  };
  const input = {
    attempt: {
      model: { api: "test", id: "test-model" },
      modelId: "test-model",
      provider: "test-provider",
      sessionId: entry.sessionId,
      sessionKey: "agent:main:main",
      config: { session: { store: "/tmp/s11-hierarchy/sessions.json" } },
    },
    prepared: {
      sessionRuntime: {
        agentSession: {
          activeSession: {
            agent,
            get messages() {
              return agent.state.messages;
            },
          },
          settingsManager: SettingsManager.inMemory(),
        },
        boundary: {},
        sessionManager: {},
        transcriptPolicy: {},
        transport: {},
        state: { systemPromptText: "System prompt" },
      },
      toolCatalog: { toolSearchRunPlan: {} },
    },
    setup: { sessionAgentId: "main", effectiveWorkspace: "/tmp/s11-hierarchy" },
  } as Parameters<typeof prepareEmbeddedAttemptHistory>[0];
  const controller = new AbortController();
  const assertActive = () => controller.signal.throwIfAborted();
  mocks.readEntry.mockResolvedValue(entry);
  const summaries = [
    {
      sessionKey: "agent:main:subagent:child",
      entry: {
        sessionId: "child-session",
        updatedAt: 1,
        spawnedBy: entry.sessionId,
        subagentRole: "orchestrator" as const,
        status: "done" as const,
      },
    },
    {
      sessionKey: "agent:main:subagent:other",
      entry: { sessionId: "unrelated", updatedAt: 1, spawnedBy: "another-parent" },
    },
  ];
  mocks.readSummaries.mockResolvedValue(summaries);
  mocks.updateEntry.mockResolvedValue(entry);
  return { input, entry, summaries, agent, messages, controller, assertActive };
}

beforeEach(() => {
  vi.resetAllMocks();
});

it("awaits descriptive worker rows before publishing the recovery briefing", async () => {
  const fixture = createFixture();
  const entered = createDeferred();
  const rows = createDeferred<Awaited<ReturnType<typeof mocks.readSummaries>>>();
  mocks.readSummaries.mockImplementationOnce(() => {
    entered.resolve();
    return rows.promise;
  });
  const preparation = prepareEmbeddedAttemptHistory(fixture.input, fixture.assertActive);
  await awaitGateBeforeSettlement(entered.promise, preparation, "hierarchy reader was not reached");
  expect(fixture.agent.state.messages).toBe(fixture.messages);
  expect(mocks.updateEntry).not.toHaveBeenCalled();
  rows.resolve(fixture.summaries);
  await preparation;
  expect(fixture.agent.state.messages.at(-1)).toMatchObject({
    role: "user",
    content: expect.stringContaining("Subagent child-session (orchestrator): done"),
  });
  expect(fixture.agent.state.messages.at(-1)).toMatchObject({
    content: expect.not.stringContaining("unrelated"),
  });
  const [, update, options] = mocks.updateEntry.mock.calls[0]!;
  expect(options?.assertCommitAllowed).toBe(fixture.assertActive);
  expect(await update(fixture.entry, {})).toMatchObject({ quotaSuspension: { state: "active" } });
  expect(await update({ ...fixture.entry, sessionId: "replacement" }, {})).toBeNull();
});

it.each([
  { stage: "entry", rejected: false },
  { stage: "hierarchy", rejected: false },
  { stage: "settlement", rejected: false },
  { stage: "hierarchy", rejected: true },
])(
  "refuses publication after $stage revocation or rejection ($rejected)",
  async ({ stage, rejected }) => {
    const fixture = createFixture();
    const entered = createDeferred();
    const resume = createDeferred();
    const wait = async () => {
      entered.resolve();
      await resume.promise;
      if (rejected) {
        throw new Error("reader unavailable");
      }
    };
    if (stage === "entry") {
      mocks.readEntry.mockImplementationOnce(async () => {
        await wait();
        return fixture.entry;
      });
    } else if (stage === "hierarchy") {
      mocks.readSummaries.mockImplementationOnce(async () => {
        await wait();
        return [];
      });
    } else {
      mocks.updateEntry.mockImplementationOnce(async () => {
        await wait();
        return fixture.entry;
      });
    }
    const preparation = prepareEmbeddedAttemptHistory(fixture.input, fixture.assertActive);
    await awaitGateBeforeSettlement(
      entered.promise,
      preparation,
      "read/settlement was not reached",
    );
    if (!rejected) {
      fixture.controller.abort(new Error("attempt retired"));
    }
    resume.resolve();
    await expect(preparation).rejects.toThrow(rejected ? "reader unavailable" : "attempt retired");
    expect(fixture.agent.state.messages).toBe(fixture.messages);
    if (stage !== "settlement") {
      expect(mocks.updateEntry).not.toHaveBeenCalled();
    }
  },
);
