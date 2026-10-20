import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { SessionCatalogEntrySnapshot } from "openclaw/plugin-sdk/session-catalog";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods, not unbound class methods. */
import { expect, it, vi } from "vitest";
import { createLazyCodexAppServerBindingStore } from "./app-server/session-binding-store.js";
import { bindingStoreKey } from "./app-server/session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./app-server/session-binding.sqlite.test-helpers.js";
import { listAdoptedSessionEntries } from "./session-catalog-adoption.js";
import {
  commandRpcMocks,
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
  interruptedAdoptionEntry,
  createRuntime,
  archiveTestSession,
  createGatewayApi,
  resolveStorePath,
  sessionBindingIdentity,
  createCodexTestBindingStore,
  type CodexThread,
  type OpenClawConfig,
  type PluginRuntime,
} from "./session-catalog.test-helpers.js";

const importHistory = transcriptMirrorMocks.importCodexThreadHistoryToTranscript;
type ContinueOptions = Partial<Parameters<typeof continueLocalCodexSession>[0]>;
type ListOptions = Partial<Parameters<typeof listCodexSessionCatalog>[0]>;
type SessionSummary = ReturnType<typeof createRuntime>["entries"][number];

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
  pending = false,
) {
  return seedSupervisionBinding({
    bindingStore,
    sessionId: summary.entry.sessionId,
    sessionKey: summary.sessionKey,
    sourceThreadId,
    pending,
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
  pending = false,
  options: Parameters<typeof createRuntime>[0] = {},
) {
  const sessionKey = supervisionSessionKey(sourceThreadId);
  const fixture = adoptionFixture(
    { ...options, entries: [{ sessionKey, entry }] },
    catalogControl([sourceThreadId]),
  );
  await seedSummary(fixture.bindingStore, fixture.entries[0]!, sourceThreadId, pending);
  return { ...fixture, sessionKey };
}

function pauseHistoryImport() {
  const entered = createDeferred<void>();
  const gate = createDeferred<void>();
  importHistory.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
  });
  return {
    gate,
    wait: (continuing: Promise<unknown>) =>
      Promise.race([
        entered.promise,
        continuing.then(() => {
          throw new Error("Continue finished without entering the paused history import");
        }),
      ]),
  };
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
    const lookupMany = vi.spyOn(state.asyncReads, "lookupMany");
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
    expect(lookupMany).toHaveBeenCalled();
    expect(syncLookupMany).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }
});

it("reuses adoption preparation across catalog lists until the entry revision changes", async () => {
  const sourceThreadId = "adopted-source";
  const f = await adoptedSource(
    sourceThreadId,
    adoptedEntry({ sourceThreadId, sessionId: "adopted-session" }),
  );
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
  const list = () => f.list({ sessionEntries });
  expect((await list()).hosts[0]?.sessions[0]?.sessionKey).toBe(sessionKey);
  const coldInspections = inspectedEntries;
  let result: Awaited<ReturnType<typeof list>> | undefined;
  for (let listIndex = 0; listIndex < 100; listIndex++) {
    result = await list();
  }
  const warmInspections = inspectedEntries - coldInspections;
  expect(result?.hosts[0]?.sessions[0]?.sessionKey).toBe(sessionKey);
  expect(warmInspections).toBe(0);

  adopted.entry = { ...adopted.entry, initializationPending: true };
  sessionEntries.revision = {};
  expect((await list()).hosts[0]?.sessions[0]).not.toHaveProperty("sessionKey");
  expect(inspectedEntries).toBeGreaterThan(coldInspections);
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
    const lookupMany = vi.spyOn(state.asyncReads, "lookupMany");
    await expect(
      listAdoptedSessionEntries({ agentId: "main", bindingStore, config: cohortConfig, runtime }),
    ).rejects.toThrow("multiple OpenClaw sessions adopt Codex thread duplicate from the same home");
    entries.splice(1, 1);
    await expect(
      listAdoptedSessionEntries({ agentId: "main", bindingStore, config: cohortConfig, runtime }),
    ).rejects.toThrow(`Invalid Codex app-server binding row: ${key}`);
    expect(lookupMany).toHaveBeenCalledTimes(2);
  } finally {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }
});

it("enriches only the local source row with its adopted OpenClaw session", async () => {
  const control = catalogControl(["source-thread"], "active");
  const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => ({
    payloadJSON: JSON.stringify({
      sessions: [catalogRow("source-thread")],
    }),
  }));
  const f = await adoptedSource("source-thread", undefined, false, {
    nodes: [
      {
        nodeId: "devbox",
        connected: true,
        commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
      },
    ],
    invoke,
  });
  const result = await f.list({ control });

  expect(result.hosts[0]?.sessions[0]).toMatchObject({
    threadId: "source-thread",
    sessionKey: f.sessionKey,
  });
  expect(result.hosts[1]?.sessions[0]).toEqual({
    threadId: "source-thread",
    status: "idle",
    archived: false,
  });
});

it("does not expose an adopted marker while generic initialization remains pending", async () => {
  const f = await adoptedSource(
    "source-thread",
    {
      ...adoptedEntry({ sourceThreadId: "source-thread", sessionId: "openclaw-session-pending" }),
      initializationPending: true,
    },
    true,
  );

  const result = await f.list();

  expect(result.hosts[0]?.sessions[0]).not.toHaveProperty("sessionKey");
});

it("ignores a public marker retarget and trusts the private source binding", async () => {
  const control = catalogControl(["source-thread", "forged-thread"]);
  const f = await adoptedSource(
    "source-thread",
    adoptedEntry({
      sourceThreadId: "forged-thread",
      sessionId: "openclaw-session-forged-marker",
    }),
  );

  const result = await f.list({ control });

  expect(result.hosts[0]?.sessions).toEqual([
    { threadId: "source-thread", status: "idle", archived: false, sessionKey: f.sessionKey },
    { threadId: "forged-thread", status: "idle", archived: false },
  ]);
  expect(f.entries[0]?.entry.pluginExtensions).toMatchObject({
    codex: { supervision: { sourceThreadId: "forged-thread" } },
  });
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
  expect(result.hosts[0]?.sessions).toHaveLength(1);
  expect(result.hosts[0]?.sessions[0]).toBeDefined();
  expect(result.hosts[0]?.sessions[0]).not.toHaveProperty("sessionKey");
  await expect(f.continue({ control, threadId })).rejects.toThrow(
    "does not match its trusted recovery state",
  );
  expect(f.createSessionEntry).toHaveBeenCalledOnce();
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
  const sourceThread = idleThread({
    id: "thread-source",
    source: "cli",
    path: rollout,
    turns: [],
  });
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
    f.continue({
      threadId: sourceThread.id,
      sourceHomeId: source.sourceHomeId,
    }),
  ).resolves.toMatchObject({ disposition: "forked" });
  expect(f.createSessionEntry).toHaveBeenCalledOnce();
  expect(importHistory).toHaveBeenCalledWith(expect.objectContaining({ thread: sourceThread }));
  expect(pinnedConnectionMocks.request.mock.calls.map(([request]) => request.method)).toEqual([
    "thread/read",
    "thread/read",
  ]);
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
  const baselines: Parameters<NonNullable<ContinueOptions["onContinued"]>>[0][] = [];
  const onContinued: NonNullable<ContinueOptions["onContinued"]> = (baseline) => {
    baselines.push(baseline);
  };

  const first = await f.continue({ onContinued });
  const second = await f.continue({ onContinued });

  expect(first).toEqual({
    sessionKey: expect.stringMatching(/^agent:main:harness:codex:supervision:[0-9a-f]{64}$/),
    disposition: "forked",
  });
  expect(second).toEqual({ sessionKey: first.sessionKey, disposition: "existing" });
  // Baselines include the active turn; history import stops at the last terminal turn.
  expect(baselines).toEqual(
    Array.from({ length: 2 }, () => ({
      connectionFingerprint: "catalog-connection",
      turnId: "turn-active",
      userMessageCount: 0,
    })),
  );
  expect(f.control.withPinnedConnection).toHaveBeenCalledTimes(2);
  expect(f.createSessionEntry).toHaveBeenCalledOnce();
  expect(f.createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("label");
  expect(f.createSessionEntry).toHaveBeenCalledWith(
    expect.objectContaining({
      cfg: config,
      key: supervisionSessionInputKey("thread-1"),
      displayName: "Continue native task",
      spawnedCwd: "/workspace/project",
      afterCreate: expect.any(Function),
      initialEntry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: {
            supervision: {
              sourceThreadId: "thread-1",
              initializing: true,
              modelLocked: true,
            },
          },
        },
      },
    }),
  );
  const identity = f.identity(first.sessionKey);
  expect(importHistory).toHaveBeenCalledWith({
    assertCurrent: expect.any(Function),
    thread: sourceThread,
    storePath: resolveStorePath(undefined, { agentId: "main" }),
    sessionId: identity.sessionId,
    sessionKey: first.sessionKey,
    agentId: "main",
    cwd: "/workspace/project",
    throughTurnId: "turn-failed",
    modelProvider: "openai",
    config,
  });
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
  expect(f.control.readThread).toHaveBeenCalledTimes(2);
  expect(f.control.readThread).toHaveBeenNthCalledWith(1, "thread-1", true);
  expect(f.control.readThread).toHaveBeenNthCalledWith(2, "thread-1", true);
  expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
});

it("does not join concurrent local continues across explicit agent owners", async () => {
  const runtimeConfig = {
    agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
  } as OpenClawConfig;
  const f = adoptionFixture();
  const { api } = createGatewayApi(f.runtime, runtimeConfig);

  const [alpha, beta] = await Promise.all(
    ["alpha", "beta"].map((agentId) => f.continue({ agentId, api, config: runtimeConfig })),
  );

  if (!alpha || !beta) {
    throw new Error("expected both explicit owners to continue independently");
  }

  expect(alpha.sessionKey).toMatch(/^agent:alpha:harness:codex:supervision:/);
  expect(beta.sessionKey).toMatch(/^agent:beta:harness:codex:supervision:/);
  expect(alpha.sessionKey).not.toBe(beta.sessionKey);
  expect(f.createSessionEntry).toHaveBeenCalledTimes(2);
});

it("baselines a re-continued adoption from its bound canonical thread", async () => {
  const canonicalTurn = {
    id: "turn-canonical",
    status: "completed",
    startedAt: 200,
    items: [
      { id: "user-1", type: "userMessage", text: "first" },
      { id: "user-2", type: "userMessage", text: "second" },
    ],
  } as NonNullable<CodexThread["turns"]>[number];
  const canonicalThread = idleThread({
    id: "thread-1-branch",
    turns: [canonicalTurn],
  });
  const f = await adoptedSource("thread-1");
  const control = createEligibleControl({
    readThread: vi.fn(async (threadId: string) =>
      threadId === canonicalThread.id ? canonicalThread : idleThread({ id: threadId }),
    ),
  });
  const baselines: Parameters<NonNullable<ContinueOptions["onContinued"]>>[0][] = [];

  await f.continue({
    control,
    onContinued: (baseline) => baselines.push(baseline),
  });

  expect(control.readThread).toHaveBeenCalledWith("thread-1-branch", true);
  expect(baselines).toEqual([
    {
      connectionFingerprint: "catalog-connection",
      turnId: "turn-canonical",
      userMessageCount: 2,
    },
  ]);
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
  expect(f.createSessionEntry).toHaveBeenCalledOnce();
  expect(f.createSessionEntry).toHaveBeenCalledWith(expect.objectContaining({ agentId: "alpha" }));
  expect(catalog.hosts[0]?.sessions[0]).toMatchObject({
    threadId: "thread-1",
    sessionKey: created.sessionKey,
  });
});

it("does not expose or reuse an initializing session while history import is paused", async () => {
  const { gate: importGate, wait } = pauseHistoryImport();
  const f = adoptionFixture();

  const firstContinue = f.continue();
  const pending: Promise<unknown>[] = [firstContinue];
  try {
    await wait(firstContinue);
    expect(importHistory).toHaveBeenCalledOnce();

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

    importGate.resolve();
    const [first, second] = await Promise.all([firstContinue, secondContinue]);
    expect(second).toEqual(first);
    expect(f.entries[0]?.entry.pluginExtensions).toEqual({
      codex: {
        supervision: { sourceThreadId: "thread-1", modelLocked: true },
      },
    });
    expect(f.entries[0]?.entry.initializationPending).toBeUndefined();
  } finally {
    importGate.resolve();
    await Promise.allSettled(pending);
  }
});

it("does not archive a source with an interrupted initializing branch", async () => {
  const f = adoptionFixture({
    entries: [
      {
        sessionKey: supervisionSessionKey("thread-1"),
        entry: interruptedAdoptionEntry({
          sourceThreadId: "thread-1",
          sessionId: "openclaw-session-initializing",
        }),
      },
    ],
  });
  await expect(f.archive()).rejects.toThrow(
    "cannot be archived while its OpenClaw branch is initializing",
  );
  expect(f.control.readThread).not.toHaveBeenCalled();
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
  const { gate: importGate, wait } = pauseHistoryImport();
  const f = adoptionFixture();
  const continuing = f.continue();
  const pending: Promise<unknown>[] = [continuing];
  try {
    await wait(continuing);
    expect(importHistory).toHaveBeenCalledOnce();

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

    importGate.resolve();
    await expect(continuing).resolves.toMatchObject({ disposition: "forked" });
    const archiveResult = await archiving;
    expect(archiveResult.status).toBe("rejected");
    if (archiveResult.status !== "rejected") {
      throw new Error("archive unexpectedly succeeded");
    }
    expect(archiveResult.reason).toBeInstanceOf(Error);
    expect(archiveResult.reason).toMatchObject({
      message: expect.stringContaining("cannot be archived until its OpenClaw branch starts"),
    });
    expect(f.control.archiveThread).not.toHaveBeenCalled();
  } finally {
    importGate.resolve();
    await Promise.allSettled(pending);
  }
});
