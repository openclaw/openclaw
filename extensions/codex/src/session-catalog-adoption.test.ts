import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { SessionCatalogEntrySnapshot } from "openclaw/plugin-sdk/session-catalog";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods, not unbound class methods. */
import { describe, expect, it, vi } from "vitest";
import { createLazyCodexAppServerBindingStore } from "./app-server/session-binding-store.js";
import { createCodexAppServerBindingStore, bindingStoreKey } from "./app-server/session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./app-server/session-binding.sqlite.test-helpers.js";
import { listAdoptedSessionEntries } from "./session-catalog-adoption.js";
import * as adoptionKeys from "./session-catalog-node-adoption.js";
import {
  pinnedConnectionMocks,
  createCodexSessionCatalogControlFactory,
  fs,
  os,
  path,
  tempDirs,
  transcriptMirrorMocks,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  listCodexSessionCatalog,
  continueLocalCodexSession,
  config,
  compatibilityOwnerConfig,
  idleThread,
  createControl,
  createEligibleControl,
  adoptedEntry,
  supervisionSessionInputKey,
  supervisionSessionKey,
  seedSupervisionBinding,
  supervisionBinding,
  interruptedAdoptionEntry,
  createRuntime,
  archiveTestSession,
  createGatewayApi,
  sessionBindingIdentity,
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

const importHistory = transcriptMirrorMocks.importCodexThreadHistoryToTranscript;
type ContinueOptions = Partial<Parameters<typeof continueLocalCodexSession>[0]>;
type ListOptions = Partial<Parameters<typeof listCodexSessionCatalog>[0]>;
type SessionSummary = ReturnType<typeof createRuntime>["entries"][number];
const THREAD_ID = "thread-1";
const SESSION_KEY = supervisionSessionKey(THREAD_ID);

function bulkState(namespace: string) {
  const state = createCodexSqliteTestBindingStateStore({
    namespace,
    maxEntries: 10,
    env: { ...process.env },
  });
  return { state, bindingStore: createLazyCodexAppServerBindingStore(state) };
}

function bindingIdentity(summary: SessionSummary, cfg = config) {
  return sessionBindingIdentity({
    sessionId: summary.entry.sessionId,
    sessionKey: summary.sessionKey,
    config: cfg,
  });
}

function seedSummary(
  bindingStore: ReturnType<typeof createCodexTestBindingStore>,
  summary: SessionSummary,
  sourceThreadId: string,
) {
  return seedSupervisionBinding({
    bindingStore,
    sessionId: summary.entry.sessionId,
    sessionKey: summary.sessionKey,
    sourceThreadId,
  });
}

function adoptionFixture(
  options: Parameters<typeof createRuntime>[0] = {},
  control = createEligibleControl(),
) {
  const fixture = createRuntime(options);
  const { runtime } = fixture;
  const { api } = createGatewayApi(runtime);
  const common = { bindingStore: createCodexTestBindingStore(), config, control };
  return {
    ...fixture,
    api,
    ...common,
    continue: (overrides: ContinueOptions = {}) =>
      continueLocalCodexSession({ api, threadId: "thread-1", ...common, ...overrides }),
    list: (overrides: ListOptions = {}) =>
      listCodexSessionCatalog({ runtime, ...common, ...overrides }),
    archive: () => archiveTestSession({ runtime, ...common }),
    identity: (sessionKey: string) =>
      sessionBindingIdentity({
        sessionId: runtime.agent.session.getSessionEntry({ sessionKey })!.sessionId,
        sessionKey,
        config,
      }),
  };
}

function recoveryFixture(entry?: ReturnType<typeof adoptedEntry>) {
  const f = adoptionFixture({ entries: entry ? [{ sessionKey: SESSION_KEY, entry }] : [] });
  const identity = sessionBindingIdentity({
    sessionId: entry?.sessionId ?? "openclaw-session-existing",
    sessionKey: SESSION_KEY,
    config,
  });
  return {
    ...f,
    identity,
    seed: (binding = supervisionBinding(THREAD_ID)) =>
      f.bindingStore.mutate(identity, { kind: "set", if: { kind: "absent" }, binding }),
  };
}

function sessionRows(result: Awaited<ReturnType<typeof listCodexSessionCatalog>>, host = 0) {
  return result.hosts[host]?.sessions;
}

function baseline(turnId: string) {
  return { connectionFingerprint: "catalog-connection", turnId, userMessageCount: 0 };
}

function catalogRow(threadId: string, status = "idle") {
  return { threadId, status, archived: false as const };
}

function catalogControl(threadIds: string[], status = "idle") {
  return createControl({
    listPage: vi.fn(async () => ({ sessions: threadIds.map((id) => catalogRow(id, status)) })),
  });
}

async function adoptedSource(
  sourceThreadId: string,
  entry = adoptedEntry({ sourceThreadId }),
  options: Parameters<typeof createRuntime>[0] = {},
) {
  const sessionKey = supervisionSessionKey(sourceThreadId);
  const fixture = adoptionFixture(
    { ...options, entries: [{ sessionKey, entry }] },
    catalogControl([sourceThreadId]),
  );
  await seedSummary(fixture.bindingStore, fixture.entries[0]!, sourceThreadId);
  return { ...fixture, sessionKey };
}

async function duringHistoryImport(
  run: (
    fixture: ReturnType<typeof adoptionFixture>,
    resume: () => void,
    continuing: ReturnType<ReturnType<typeof adoptionFixture>["continue"]>,
    pending: Promise<unknown>[],
  ) => Promise<void>,
) {
  const entered = createDeferred<void>();
  const gate = createDeferred<void>();
  importHistory.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
  });
  const fixture = adoptionFixture();
  const continuing = fixture.continue();
  const pending: Promise<unknown>[] = [continuing];
  try {
    await Promise.race([
      entered.promise,
      continuing.then(() => {
        throw new Error("Continue finished without entering the paused history import");
      }),
    ]);
    await run(fixture, () => gate.resolve(), continuing, pending);
    await continuing;
  } finally {
    gate.resolve();
    await Promise.allSettled(pending);
  }
}

it("refreshes bulk adoption authority after a generation changes or a binding disappears", async () => {
  const { state, bindingStore } = bulkState("adoption-cohort");
  const entries = ["first", "second"].map((sourceThreadId) => ({
    sessionKey: supervisionSessionKey(sourceThreadId),
    entry: adoptedEntry({ sourceThreadId, sessionId: `session-${sourceThreadId}` }),
  }));
  const { runtime } = createRuntime({ entries });
  const sessionEntries: SessionCatalogEntrySnapshot = {
    revision: {},
    entriesForAgent: () => entries,
  };
  try {
    for (const [index, sourceThreadId] of ["first", "second"].entries()) {
      await seedSummary(bindingStore, entries[index]!, sourceThreadId);
    }
    const syncLookupMany = vi.spyOn(state, "lookupMany");
    const lookup = vi.spyOn(state, "lookup");
    const list = async () =>
      (
        await listCodexSessionCatalog({
          bindingStore,
          config,
          runtime,
          sessionEntries,
          control: catalogControl(["first", "second"]),
        })
      ).hosts[0]?.sessions.map((entry) => entry.sessionKey);
    expect(await list()).toEqual(entries.map((entry) => entry.sessionKey));
    entries[0]!.entry.sessionId = "successor";
    sessionEntries.revision = {};
    expect(await list()).toEqual([undefined, entries[1]!.sessionKey]);
    state.update(
      bindingStoreKey(bindingIdentity(entries[0]!)),
      (row) => row && { ...row, sessionId: "successor" },
    );
    state.delete(bindingStoreKey(bindingIdentity(entries[1]!)));
    expect(await list()).toEqual([entries[0]!.sessionKey, undefined]);
    expect(syncLookupMany).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }
});

it("reuses adoption preparation across catalog lists until the entry revision changes", async () => {
  const sourceThreadId = "adopted-source";
  const f = await adoptedSource(sourceThreadId);
  const { entries, sessionKey } = f;
  const adopted = entries[0]!;
  entries.unshift(
    ...Array.from({ length: 3_000 }, (_, index) => ({
      sessionKey: `agent:main:unrelated-${index}`,
      entry: { sessionId: `unrelated-${index}`, updatedAt: 1 },
    })),
  );
  let inspectedEntries = 0;
  const catalogEntries = entries.map((summary) => ({
    agentId: "main",
    sessionKey: summary.sessionKey,
    get entry() {
      inspectedEntries++;
      return summary.entry;
    },
  }));
  const sessionEntries: SessionCatalogEntrySnapshot = {
    revision: {},
    entriesForAgent: () => entries,
    entriesForCatalog: () => catalogEntries,
  };
  const list = async () => sessionRows(await f.list({ sessionEntries }))?.[0];
  const parseKey = vi.spyOn(adoptionKeys, "adoptionSessionKeyRest");
  expect((await list())?.sessionKey).toBe(sessionKey);
  expect(parseKey).toHaveBeenCalledExactlyOnceWith(sessionKey);
  const coldInspections = inspectedEntries;
  const result = await list();
  const warmInspections = inspectedEntries - coldInspections;
  expect(result?.sessionKey).toBe(sessionKey);
  expect(warmInspections).toBe(0);
  expect(parseKey).toHaveBeenCalledTimes(1);

  adopted.entry = { ...adopted.entry, initializationPending: true };
  sessionEntries.revision = {};
  expect(await list()).not.toHaveProperty("sessionKey");
  expect(inspectedEntries).toBeGreaterThan(coldInspections);
  expect(parseKey).toHaveBeenCalledTimes(1);
});

it("reports duplicate adoption across agents before decoding a later malformed bulk row", async () => {
  const { state, bindingStore } = bulkState("adoption-order");
  const cohortConfig: OpenClawConfig = {
    agents: { entries: { main: {}, beta: {}, gamma: {} } },
  };
  const duplicates = ["main", "beta"].map((agentId) => ({
    sessionKey: `agent:${agentId}:${supervisionSessionInputKey("duplicate")}`,
    entry: adoptedEntry({ sourceThreadId: "duplicate", sessionId: `${agentId}-session` }),
  }));
  const malformed = {
    sessionKey: `agent:gamma:${supervisionSessionInputKey("malformed")}`,
    entry: adoptedEntry({ sourceThreadId: "malformed", sessionId: "malformed-session" }),
  };
  const { runtime, entries } = createRuntime({ entries: [...duplicates, malformed] });
  try {
    for (const duplicate of duplicates) {
      await seedSummary(bindingStore, duplicate, "duplicate");
    }
    const key = bindingStoreKey(bindingIdentity(malformed, cohortConfig));
    state.register(key, { version: 1, state: "active", binding: { threadId: "", cwd: "/repo" } });
    await expect(
      listAdoptedSessionEntries({ agentId: "main", bindingStore, config: cohortConfig, runtime }),
    ).rejects.toThrow("multiple OpenClaw sessions adopt Codex thread duplicate from the same home");
    entries.splice(1, 1);
    await expect(
      listAdoptedSessionEntries({ agentId: "main", bindingStore, config: cohortConfig, runtime }),
    ).rejects.toThrow(`Invalid Codex app-server binding row: ${key}`);
  } finally {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }
});

it("enriches only the local source row with its adopted OpenClaw session", async () => {
  const control = catalogControl(["source-thread"], "active");
  const f = await adoptedSource("source-thread", undefined, {
    nodes: [
      { nodeId: "devbox", connected: true, commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND] },
    ],
    invoke: vi.fn(async () => ({
      payloadJSON: JSON.stringify({ sessions: [catalogRow("source-thread")] }),
    })),
  });
  const result = await f.list({ control });

  expect(sessionRows(result)?.[0]).toMatchObject({
    threadId: "source-thread",
    sessionKey: f.sessionKey,
  });
  expect(sessionRows(result, 1)).toEqual([catalogRow("source-thread")]);
});

it("ignores a public marker retarget and trusts the private source binding", async () => {
  const control = catalogControl(["source-thread", "forged-thread"]);
  const f = await adoptedSource("source-thread", adoptedEntry({ sourceThreadId: "forged-thread" }));

  const result = await f.list({ control });

  expect(sessionRows(result)).toEqual([
    { ...catalogRow("source-thread"), sessionKey: f.sessionKey },
    catalogRow("forged-thread"),
  ]);
});

it.each([
  ["unlocked-thread", { modelSelectionLocked: false }],
  ["wrong-harness-thread", { agentHarnessId: "other-harness" }],
] as const)("requires the Codex harness owner and model lock (%s)", async (threadId, patch) => {
  const f = await adoptedSource(threadId, {
    ...adoptedEntry({ sourceThreadId: threadId }),
    ...patch,
  });
  const control = createControl({
    listPage: vi.fn(async () => ({ sessions: [{ ...catalogRow(threadId), source: "cli" }] })),
    readThread: vi.fn(async (id: string) => idleThread({ id, source: "cli" })),
  });
  const result = await f.list({ control });
  expect(sessionRows(result)).toHaveLength(1);
  expect(sessionRows(result)?.[0]).not.toHaveProperty("sessionKey");
  await expect(f.continue({ control, threadId })).rejects.toThrow(
    "does not match its trusted recovery state",
  );
  expect(importHistory).not.toHaveBeenCalled();
});
it("imports an exact local source when broad native listing times out", async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-exact-import-")));
  tempDirs.push(home);
  const sessionsRoot = path.join(home, "sessions");
  await fs.mkdir(sessionsRoot);
  const rollout = path.join(sessionsRoot, "source.jsonl");
  const payload = { id: "thread-source", source: "cli", originator: "codex_cli_rs" };
  await fs.writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload })}\n`);
  const sourceThread = idleThread({ id: "thread-source", source: "cli", path: rollout, turns: [] });
  let indexed = false;
  pinnedConnectionMocks.request.mockImplementation(async ({ method, requestParams }) => {
    if (method === "thread/read") {
      indexed = true;
      return { thread: sourceThread };
    }
    if (method === "thread/list" && requestParams.useStateDbOnly === true) {
      return { data: indexed ? [sourceThread] : [] };
    }
    throw new Error("thread/list timed out");
  });
  const factory = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({}),
    getRuntimeConfig: () => config,
    env: { CODEX_HOME: home },
  });
  const source = (await factory.homesForAgent("main"))[0]!;
  const f = adoptionFixture({}, factory.forRequest("main", source));
  await expect(
    f.continue({ threadId: sourceThread.id, sourceHomeId: source.sourceHomeId }),
  ).resolves.toMatchObject({ disposition: "forked" });
  expect(importHistory).toHaveBeenCalledWith(expect.objectContaining({ thread: sourceThread }));
});

it("creates one pending locked branch and reuses its source mapping", async () => {
  const sourceThread = idleThread({
    modelProvider: "openai",
    turns: [
      { id: "turn-completed", status: "completed", items: [] },
      { id: "turn-failed", status: "failed", items: [] },
      { id: "turn-active", status: "inProgress", items: [] },
    ],
  });
  const f = adoptionFixture(
    {},
    createEligibleControl({ readThread: vi.fn(async () => sourceThread) }),
  );
  const onContinued = vi.fn();

  const first = await f.continue({ onContinued });
  const second = await f.continue({ onContinued });

  expect(first).toEqual({
    sessionKey: expect.stringMatching(/^agent:main:harness:codex:supervision:[0-9a-f]{64}$/),
    disposition: "forked",
  });
  expect(second).toEqual({ sessionKey: first.sessionKey, disposition: "existing" });
  // Baselines include the active turn; history import stops at the last terminal turn.
  expect(onContinued.mock.calls).toEqual([[baseline("turn-active")], [baseline("turn-active")]]);
  expect(f.createSessionEntry).toHaveBeenCalledOnce();
  expect(f.entries[0]?.entry).toMatchObject({
    displayName: "Continue native task",
    spawnedCwd: "/workspace/project",
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    pluginExtensions: { codex: { supervision: { sourceThreadId: "thread-1", modelLocked: true } } },
  });
  expect(f.createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("label");
  const identity = f.identity(first.sessionKey);
  expect(importHistory).toHaveBeenCalledWith(
    expect.objectContaining({
      thread: sourceThread,
      throughTurnId: "turn-failed",
      sessionId: identity.sessionId,
      sessionKey: first.sessionKey,
      modelProvider: "openai",
    }),
  );
  expect(f.bindingStore.read(identity)).toMatchObject({
    threadId: "thread-1",
    connectionScope: "supervision",
    supervisionSourceThreadId: "thread-1",
    cwd: "/workspace/project",
    historyCoveredThrough: expect.any(String),
    conversationSourceTransferComplete: true,
    preserveNativeModel: true,
    pendingSupervisionBranch: {
      sourceThreadId: "thread-1",
      connectionFingerprint: "catalog-connection",
      lastTurnId: "turn-failed",
    },
  });
});

it("does not join concurrent local continues across explicit agent owners", async () => {
  const runtimeConfig = {
    agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
  } as OpenClawConfig;
  const f = adoptionFixture();
  const { api } = createGatewayApi(f.runtime, runtimeConfig);

  const [alpha, beta] = await Promise.all([
    f.continue({ agentId: "alpha", api, config: runtimeConfig }),
    f.continue({ agentId: "beta", api, config: runtimeConfig }),
  ]);

  if (!alpha || !beta) {
    throw new Error("Expected both agent-owned sessions to be created");
  }
  expect(alpha.sessionKey).toMatch(/^agent:alpha:harness:codex:supervision:/);
  expect(beta.sessionKey).toMatch(/^agent:beta:harness:codex:supervision:/);
  expect(alpha.sessionKey).not.toBe(beta.sessionKey);
  expect(f.createSessionEntry).toHaveBeenCalledTimes(2);
});

it("keeps adopted sessions discoverable when the configured system agent changes", async () => {
  const originalConfig = compatibilityOwnerConfig("alpha");
  const changedConfig = compatibilityOwnerConfig("beta");
  const f = adoptionFixture();

  const created = await f.continue({ agentId: "alpha", config: originalConfig });
  const reopened = await f.continue({ agentId: "alpha", config: changedConfig });
  const catalog = await f.list({ agentId: "alpha", config: changedConfig });

  expect(created.sessionKey).toMatch(/^agent:alpha:harness:codex:supervision:/);
  expect(reopened).toEqual({ sessionKey: created.sessionKey, disposition: "existing" });
  expect(sessionRows(catalog)?.[0]).toMatchObject({
    threadId: "thread-1",
    sessionKey: created.sessionKey,
  });
});

it("does not expose or reuse an initializing session while history import is paused", async () => {
  await duringHistoryImport(async (f, resume, continuing, pending) => {
    const duringImport = await f.list();
    expect(duringImport.hosts[0]?.sessions[0]).not.toHaveProperty("sessionKey");
    expect(f.entries[0]?.entry.initializationPending).toBe(true);
    let secondSettled = false;
    const secondContinue = f.continue().then((result) => {
      secondSettled = true;
      return result;
    });
    pending.push(secondContinue);
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(f.createSessionEntry).toHaveBeenCalledOnce();

    resume();
    const [first, second] = await Promise.all([continuing, secondContinue]);
    expect(second).toEqual(first);
    expect(f.createSessionEntry).toHaveBeenCalledOnce();
    expect(f.entries[0]?.entry.initializationPending).toBeUndefined();
  });
});

it("does not archive a source with an interrupted initializing branch", async () => {
  const f = recoveryFixture(
    interruptedAdoptionEntry({
      sourceThreadId: THREAD_ID,
      sessionId: "openclaw-session-initializing",
    }),
  );
  await expect(f.archive()).rejects.toThrow(
    "cannot be archived while its OpenClaw branch is initializing",
  );
  expect(f.control.archiveThread).not.toHaveBeenCalled();
});

it("does not archive a source until its supervised branch materializes", async () => {
  const f = adoptionFixture();
  const continued = await f.continue();

  await expect(f.archive()).rejects.toThrow("cannot be archived until its OpenClaw branch starts");
  expect(f.control.archiveThread).not.toHaveBeenCalled();

  const identity = f.identity(continued.sessionKey);
  const pending = f.bindingStore.read(identity)?.pendingSupervisionBranch;
  if (!pending) {
    throw new Error("expected a pending supervision branch");
  }
  await expect(
    f.bindingStore.mutate(identity, {
      kind: "commit-pending-supervision-branch",
      expected: pending,
      threadId: "thread-1-branch",
      patch: { model: "gpt-5.4", modelProvider: "openai" },
    }),
  ).resolves.toBe(true);

  await expect(f.archive()).resolves.toEqual({
    archived: true,
  });
  expect(f.control.archiveThread).toHaveBeenCalledExactlyOnceWith("thread-1");
});

it("serializes archive behind an in-flight Continue and rejects the pending branch", async () => {
  await duringHistoryImport(async (f, resume, continuing, pending) => {
    let archiveSettled = false;
    const archiving = Promise.allSettled([f.archive()]).then(([result]) => {
      archiveSettled = true;
      return result!;
    });
    pending.push(archiving);
    await Promise.resolve();
    await Promise.resolve();
    expect(archiveSettled).toBe(false);
    expect(f.control.archiveThread).not.toHaveBeenCalled();

    resume();
    await expect(continuing).resolves.toMatchObject({ disposition: "forked" });
    expect(await archiving).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("cannot be archived until its OpenClaw branch starts"),
      }),
    });
    expect(await archiving).toHaveProperty("reason", expect.any(Error));
    expect(f.control.archiveThread).not.toHaveBeenCalled();
  });
});

describe("adoption recovery", () => {
  const sourceThreadId = THREAD_ID;
  const sessionKey = SESSION_KEY;
  it("recovers the same pending session after a restart following binding commit", async () => {
    const f = recoveryFixture(
      interruptedAdoptionEntry({ sourceThreadId, sessionId: "interrupted-after-binding" }),
    );
    await f.seed(supervisionBinding(sourceThreadId, true));
    const mutate = vi.fn(f.bindingStore.mutate);
    const bindingStore: CodexAppServerBindingStore = { ...f.bindingStore, mutate };
    await expect(f.continue({ bindingStore })).resolves.toEqual({
      sessionKey,
      disposition: "forked",
    });
    expect(f.createSessionEntry).toHaveBeenCalledOnce();
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]?.entry.sessionId).toBe(f.identity.sessionId);
    expect(f.entries[0]?.entry.initializationPending).toBeUndefined();
    expect(mutate).not.toHaveBeenCalled();
    expect(bindingStore.read(f.identity)?.pendingSupervisionBranch?.sourceThreadId).toBe(
      sourceThreadId,
    );
  });

  it.each([
    ["a different working directory", { cwd: "/workspace/other" }],
    [
      "pending cleanup artifacts",
      { pendingSupervisionBranch: { sourceThreadId, cleanupThreadIds: ["thread-orphan"] } },
    ],
  ] satisfies Array<[string, Partial<CodexAppServerThreadBinding>]>)(
    "rejects recovery against %s in a same-thread binding",
    async (_name, patch) => {
      const f = recoveryFixture(
        interruptedAdoptionEntry({ sourceThreadId, sessionId: "interrupted-invalid-binding" }),
      );
      await f.seed(
        supervisionBinding(sourceThreadId, true, {
          pendingSupervisionBranch: { sourceThreadId },
          ...patch,
        }),
      );
      await expect(f.continue()).rejects.toThrow("guarded rollback did not complete");
      expect(f.entries[0]?.entry.initializationPending).toBe(true);
    },
  );

  it.each([true, false])(
    "rejects a Continue when the fresh read returns a different thread (mapped=%s)",
    async (mapped) => {
      const f = recoveryFixture(mapped ? adoptedEntry({ sourceThreadId }) : undefined);
      if (mapped) {
        await f.seed();
      }
      const control = createEligibleControl({
        readThread: vi.fn(async () => idleThread({ id: "different-thread", source: "cli" })),
      });
      await expect(f.continue({ control })).rejects.toThrow(
        "returned a different thread than requested",
      );
      expect(control.readThread).toHaveBeenCalledWith(
        mapped ? "thread-1-branch" : sourceThreadId,
        true,
      );
      expect(f.createSessionEntry).not.toHaveBeenCalled();
      expect(f.patchSessionEntry).not.toHaveBeenCalled();
      expect(importHistory).not.toHaveBeenCalled();
    },
  );

  it("fails closed when a mapped session generation changes before restore", async () => {
    const f = recoveryFixture({
      ...adoptedEntry({ sourceThreadId, sessionId: "openclaw-session-stale" }),
      archivedAt: 123,
    });
    await f.seed();
    const control = createEligibleControl({
      readThread: vi.fn(async () => {
        f.entries[0]!.entry.sessionId = "openclaw-session-replacement";
        return idleThread({ id: "thread-1-branch" });
      }),
    });
    await expect(f.continue({ control })).rejects.toThrow("changed before it could be opened");
    expect(f.entries[0]?.entry).toMatchObject({ archivedAt: 123, modelSelectionLocked: true });
    expect(f.createSessionEntry).not.toHaveBeenCalled();
  });

  it("rolls back the session when its pending binding cannot be committed", async () => {
    const f = recoveryFixture();
    const inner = createCodexAppServerBindingStore(
      createCodexSqliteTestBindingStateStore({
        namespace: "adoption-rollback",
        maxEntries: 10,
        env: { ...process.env },
      }),
    );
    let rejectBinding = true;
    const mutate = vi.fn(async (...args: Parameters<CodexAppServerBindingStore["mutate"]>) => {
      if (rejectBinding && args[1].kind === "set") {
        rejectBinding = false;
        return false;
      }
      return await inner.mutate(...args);
    });
    const control = createEligibleControl();
    await expect(f.continue({ control, bindingStore: { ...inner, mutate } })).rejects.toThrow(
      "Codex session binding changed during initialization",
    );
    expect(f.entries).toEqual([]);
    expect(f.createSessionEntry).toHaveBeenCalledOnce();
    expect(importHistory).toHaveBeenCalledOnce();
    expect(control.archiveThread).not.toHaveBeenCalled();
  });
});
