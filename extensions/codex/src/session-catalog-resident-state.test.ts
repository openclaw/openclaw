import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import type { StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { catalogWebSocketOptions } from "./session-catalog-index.test-support.js";
import { projectNativeCatalogFixture as projectCodexCatalogPage } from "./session-catalog-projection.test-support.js";
import { catalogFactory, writeCatalogRollout } from "./session-catalog-resident.test-support.js";
import {
  commandRpcMocks,
  config,
  idleThread,
  pinnedConnectionMocks,
} from "./session-catalog.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const indexes = new Set<CodexCatalogIndex>();
const clients = new Set<ReturnType<typeof createClientHarness>["client"]>();
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  await Promise.all([...indexes].map((index) => index.close()));
  await Promise.all([...clients].map((client) => client.closeAndWait()));
  indexes.clear();
  clients.clear();
  vi.restoreAllMocks();
});

function gate() {
  const deferred = createDeferred<void>();
  releases.push(deferred.resolve);
  return deferred;
}

function residentIndex(options: ConstructorParameters<typeof CodexCatalogIndex>[0]) {
  const index = new CodexCatalogIndex(options);
  indexes.add(index);
  return index;
}

async function observe(startOptions: CodexAppServerStartOptions) {
  const harness = createClientHarness();
  clients.add(harness.client);
  await observeCodexCatalogClient(harness.client, { startOptions });
  return harness;
}

function catalogState(namespace: string) {
  return createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
    namespace,
    maxEntries: 20_001,
  });
}

const thread = (id: string, overrides: Partial<CodexThread> = {}) =>
  idleThread({ id, source: "cli", ...overrides });
const threadIds = async (index: CodexCatalogIndex) =>
  (await index.list({})).sessions.map((row) => row.threadId);
const storedRows = async (state: ReturnType<typeof catalogState>) =>
  (await state.entries()).flatMap((entry) => (entry.value.kind === "row" ? [entry.value.row] : []));
const closeState = async (index: CodexCatalogIndex) => {
  await index.close();
  await closeOpenClawStateDatabaseAsync();
};
function rolloutReads() {
  const open = vi.spyOn(fs, "open");
  const readFile = vi.spyOn(fs, "readFile");
  return {
    open,
    readFile,
    expectUnread: () => {
      expect(open).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    },
  };
}

let snapshotId = 0;
function createSnapshotFixture(
  rows: CodexThread[],
  { root, homeId }: { root?: string; homeId?: string } = {},
) {
  const namespace = `snapshot-${++snapshotId}`;
  const native = { rows };
  const openState = () => catalogState(namespace);
  let blocked: Promise<void> | undefined;
  const readNative = vi.fn(async (_params: CodexThreadListParams) => {
    if (blocked) {
      await blocked;
    }
    return projectCodexCatalogPage({ data: structuredClone(native.rows) });
  });
  const createIndex = (state = openState()) =>
    residentIndex({
      homeId: homeId ?? namespace,
      localSessionsRoot: root,
      state,
      readNative,
      assertCurrent: () => {},
    });
  const seed = async <T>(inspect: (index: CodexCatalogIndex) => Promise<T>) => {
    const index = createIndex();
    await index.initialize();
    const result = await inspect(index);
    await closeState(index);
    return result;
  };
  const pause = () => {
    const deferred = gate();
    blocked = deferred.promise;
    readNative.mockClear();
    return deferred;
  };
  const expectRecovered = async (id: string) => {
    const index = createIndex();
    expect(await threadIds(index)).toEqual([id]);
    await index.initialize();
    const saved = await openState().entries();
    expect(
      saved.flatMap(({ value }) => (value.kind === "row" ? [value.row.threadId] : [])),
    ).toEqual([id]);
    expect(saved.some((entry) => entry.key === "complete")).toBe(true);
  };
  const seedCount = (count: number) =>
    seed(async (index) => {
      expect((await index.list({})).sessions).toHaveLength(count);
    });
  return { native, openState, readNative, createIndex, seed, seedCount, pause, expectRecovered };
}

function localStartOptions(prefix: string): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    args: ["app-server"],
    env: { CODEX_HOME: tempDirs.make(prefix) },
    headers: {},
  };
}

async function removalFixture() {
  const current = thread("still-current");
  const removed = thread("removed");
  const startOptions = localStartOptions("codex-catalog-removal-");
  const homeId = await codexCatalogResidentHomeKey({ startOptions });
  return {
    ...createSnapshotFixture([removed, current], { homeId }),
    current,
    removed,
    observe: () => observe(startOptions),
  };
}

it("prunes obsolete cached rows in background before native hydration without deleting fresh replacements", async () => {
  const state = catalogState("resident-obsolete-authority-test");
  const native = thread("fresh", { preview: "Current native request" });
  const projected = await projectCodexCatalogPage({ data: [native] });
  const legacy = structuredClone(projected.rows[0]!);
  Reflect.deleteProperty(legacy, "nativeMetadata");
  await state.register("obsolete-cache-key", { version: 1, kind: "row", row: legacy });
  const freshKey = `thread:${createHash("sha256").update(native.id).digest("hex")}`;
  await state.register(freshKey, { version: 1, kind: "row", row: legacy });
  await state.register("complete", { version: 1, kind: "complete" });
  const deletes = vi.spyOn(state, "delete");
  const restoreEntered = gate();
  const restoreAllowed = gate();
  const readNative = vi.fn(async () => {
    expect(await state.entries()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "obsolete-cache-key" })]),
    );
    return projected;
  });
  const index = residentIndex({
    homeId: "obsolete-authority",
    state: {
      ...state,
      entries: async () => {
        const entries = await state.entries();
        restoreEntered.resolve();
        await restoreAllowed.promise;
        return entries;
      },
    },
    readNative,
    assertCurrent: () => {},
  });
  const listed = index.list({});
  void listed.catch(() => undefined);
  await restoreEntered.promise;
  expect(deletes).not.toHaveBeenCalled();
  expect(readNative).not.toHaveBeenCalled();
  await index.upsertThread(native);
  restoreAllowed.resolve();
  expect((await listed).sessions[0]?.threadId).toBe("fresh");
  await index.initialize();
  expect(deletes).toHaveBeenCalledWith("obsolete-cache-key");
  expect(deletes).not.toHaveBeenCalledWith(freshKey);
  expect((await index.list({})).sessions[0]?.threadId).toBe("fresh");
  expect(await storedRows(state)).toMatchObject([{ threadId: "fresh", nativeMetadata: true }]);
});

it("keeps the persisted selected rollout eligible while older files and a native revert reconcile", async () => {
  const home = tempDirs.make("codex-selected-rollout-");
  const root = path.join(home, "sessions");
  let current = thread("selected-thread", {
    originator: "codex_cli_rs",
    name: "Selected native thread",
    preview: "Selected first user request",
    cwd: "/workspace/selected",
    turns: [],
  });
  current.path = await writeCatalogRollout(root, current);
  const openState = () => catalogState("selected-rollout-test");
  const createFactory = () =>
    catalogFactory({
      env: { CODEX_HOME: home },
      getRuntimeConfig: () => config,
      openResidentState: openState,
    });
  const factory = createFactory();
  const source = (await factory.homesForAgent("main"))[0]!;
  const first = createSnapshotFixture([current], { homeId: source.sourceHomeId, root }).createIndex(
    openState(),
  );
  await first.initialize();
  await closeState(first);
  const line = (type: string, payload: unknown) => JSON.stringify({ type, payload });
  const writeMetadata = (file: string, cwd: string, padding = 0) =>
    fs.writeFile(
      file,
      [
        line("session_meta", {
          id: current.id,
          timestamp: "2026-09-16T12:00:00.000Z",
          cwd,
          source: "cli",
          originator: "codex_cli_rs",
          history_mode: "paginated",
          base_instructions: { text: "x".repeat(padding) },
        }),
        line("event_msg", { type: "user_message", message: "Older request" }),
        "",
      ].join("\n"),
    );
  const retiredPath = path.join(path.dirname(current.path), "rollout-retired.jsonl");
  await writeMetadata(retiredPath, "/workspace/retired");
  const future = new Date("2030-01-01T00:00:00.000Z");
  await fs.utimes(retiredPath, future, future);
  const requested = gate();
  const released = gate();
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params) => {
    expect(method).toBe("thread/list");
    expect(params.useStateDbOnly).toBe(true);
    requested.resolve();
    await released.promise;
    return { data: [current] };
  });
  pinnedConnectionMocks.request.mockImplementation(async ({ method }) => {
    expect(method).toBe("thread/read");
    return { thread: current };
  });
  const control = factory.forRequest("main", source);
  const initializing = control.initialize();
  void initializing.catch(() => undefined);
  await requested.promise;
  await expect(control.requireEligibleThread(current.id)).resolves.toMatchObject({
    path: current.path,
    cwd: "/workspace/selected",
  });
  released.resolve();
  await initializing;
  await factory.stop();
  const replacementPath = path.join(path.dirname(current.path), "rollout-replacement.jsonl");
  await writeMetadata(replacementPath, "/workspace/replacement", 160 * 1024);
  current = { ...current, path: replacementPath, cwd: "/workspace/replacement" };
  const reverted = createFactory();
  const selected = reverted.forRequest("main", (await reverted.homesForAgent("main"))[0]);
  await selected.initialize();
  await expect(selected.requireEligibleThread(current.id)).resolves.toMatchObject({
    path: replacementPath,
    cwd: "/workspace/replacement",
  });
  expect((await selected.listPage({})).sessions[0]?.cwd).toBe("/workspace/replacement");
  await reverted.stop();
  expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  expect(pinnedConnectionMocks.request.mock.calls.map(([request]) => request.method)).toEqual([
    "thread/read",
    "thread/read",
  ]);
  commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
  const unavailable = createFactory();
  const retained = unavailable.forRequest("main", (await unavailable.homesForAgent("main"))[0]);
  await retained.initialize();
  await expect(retained.requireEligibleThread(current.id)).resolves.toMatchObject({
    path: replacementPath,
  });
  expect((await retained.listPage({})).sessions[0]?.cwd).toBe("/workspace/replacement");
  await unavailable.stop();
});

it("serves a restart from SQLite before reconciling only the changed rollout", async () => {
  const root = path.join(tempDirs.make("openclaw-resident-restart-"), "sessions");
  const native = ["changed", "untouched"].map((id) =>
    thread(id, { name: null, originator: "codex_cli_rs", preview: `Original ${id}` }),
  );
  for (const row of native) {
    row.path = await writeCatalogRollout(root, row);
  }
  const f = createSnapshotFixture(native, { root });
  const initial = await f.seed(async (first) => {
    const persisted = (await f.openState().entries()).map((entry) => entry.value);
    expect(persisted).toHaveLength(3);
    expect(persisted).toContainEqual({ version: 1, kind: "complete" });
    expect(persisted.filter((entry) => entry.kind === "row")).toMatchObject([
      { row: { nativeMetadata: true } },
      { row: { nativeMetadata: true } },
    ]);
    expect(
      persisted.flatMap((entry) => (entry.kind === "row" ? [entry.row.threadId] : [])).toSorted(),
    ).toEqual(["changed", "untouched"]);
    return first.list({});
  });
  native[0]!.preview = "Changed while the Gateway was stopped";
  const changedFile = await writeCatalogRollout(root, {
    ...native[0]!,
    cwd: "/workspace/stale-rollout-header",
  });
  const nativeAllowed = f.pause();
  const reads = rolloutReads();
  const restarted = f.createIndex();
  expect(await restarted.list({})).toEqual({
    ...initial,
    sessions: initial.sessions.map((session) =>
      Object.assign({}, session, { status: "notLoaded" }),
    ),
  });
  expect(f.readNative).not.toHaveBeenCalled();
  reads.expectUnread();
  await restarted.reconcile();
  expect(
    (await restarted.list({})).sessions.find((row) => row.threadId === "changed"),
  ).toMatchObject({
    cwd: native[0]!.cwd,
    fallbackName: "Changed while the Gateway was stopped",
  });
  nativeAllowed.resolve();
  await restarted.initialize();
  expect((await restarted.list({})).sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        threadId: "changed",
        fallbackName: "Changed while the Gateway was stopped",
      }),
      expect.objectContaining({ threadId: "untouched", fallbackName: "Original untouched" }),
    ]),
  );
  expect(reads.open.mock.calls.map((call) => call[0])).toEqual([changedFile]);
  expect(f.readNative).toHaveBeenCalledOnce();
  expect(reads.readFile).not.toHaveBeenCalled();
});

it("refreshes an offline native rename after returning the persisted list without reading unchanged rollouts", async () => {
  const root = path.join(tempDirs.make("openclaw-resident-offline-title-"), "sessions");
  const native = thread("renamed", {
    originator: "codex_cli_rs",
    name: "Previous title",
    preview: "Original user request",
  });
  const rollout = await writeCatalogRollout(root, native);
  native.path = rollout;
  const originalBytes = await fs.readFile(rollout);
  const originalStat = await fs.stat(rollout);
  const f = createSnapshotFixture([native], { root });
  await f.seed(async (first) => {
    expect((await first.list({})).sessions[0]?.name).toBe("Previous title");
  });
  const metadata = f.pause();
  native.name = "Renamed while offline";
  expect(await fs.readFile(rollout)).toEqual(originalBytes);
  expect(await fs.stat(rollout)).toMatchObject({
    mtimeMs: originalStat.mtimeMs,
    size: originalStat.size,
  });
  const reads = rolloutReads();
  const restarted = f.createIndex();
  expect((await restarted.list({})).sessions[0]?.name).toBe("Previous title");
  expect(f.readNative).not.toHaveBeenCalled();
  reads.expectUnread();
  await vi.waitFor(() => expect(f.readNative).toHaveBeenCalledOnce());
  expect(f.readNative.mock.calls[0]?.[0]).toMatchObject({ useStateDbOnly: true });
  expect((await restarted.list({ searchTerm: "previous" })).sessions).toHaveLength(1);
  metadata.resolve();
  await vi.waitFor(async () => {
    expect((await restarted.list({ searchTerm: "renamed" })).sessions).toMatchObject([
      { threadId: "renamed", name: "Renamed while offline" },
    ]);
  });
  expect((await restarted.list({ searchTerm: "previous" })).sessions).toEqual([]);
  expect(f.readNative).toHaveBeenCalledOnce();
  reads.expectUnread();
});

it("drains title, status, and archive changes to SQLite before closing", async () => {
  const startOptions = catalogWebSocketOptions("wss://resident-state.example.test/codex");
  const homeId = await codexCatalogResidentHomeKey({ startOptions });
  const native = [
    thread("visible", {
      name: "Original title",
      preview: "Original request",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    }),
    thread("archived", { name: "Archived title" }),
  ];
  const f = createSnapshotFixture(native, { homeId });
  const first = f.createIndex();
  await first.initialize();
  const harness = await observe(startOptions);
  const send = (method: string, params: Record<string, unknown>, threadId = "visible") =>
    harness.send({ method, params: { threadId, ...params } });
  send("thread/name/updated", { threadName: null });
  send("thread/status/changed", { status: { type: "idle" } });
  send("thread/archived", {}, "archived");
  send("thread/settings/updated", {
    threadSettings: { cwd: "/workspace/live", modelProvider: "live-provider" },
  });
  const page = await first.list({});
  expect(page.sessions).toMatchObject([
    {
      threadId: "visible",
      name: null,
      fallbackName: "Original request",
      status: "idle",
      cwd: "/workspace/live",
      modelProvider: "live-provider",
    },
  ]);
  expect(page.sessions[0]?.activeFlags).toBeUndefined();
  expect(harness.writes).toEqual([]);
  await first.close();
  await harness.client.closeAndWait();
  await closeOpenClawStateDatabaseAsync();
  const persisted = await storedRows(f.openState());
  expect(persisted.find((row) => row.threadId === "archived")?.archived).toBe(true);
  const durable = {
    name: null,
    fallbackName: "Original request",
    status: "notLoaded",
    cwd: "/workspace/project",
  };
  const savedVisible = persisted.find((row) => row.threadId === "visible")?.page.sessions[0];
  expect(savedVisible).toMatchObject(durable);
  expect(savedVisible).not.toHaveProperty("activeFlags");
  f.readNative.mockClear();
  const restarted = f.createIndex();
  const restored = await restarted.list({});
  expect(restored.sessions).toMatchObject([{ threadId: "visible", ...durable }]);
  expect(restored.sessions[0]).not.toHaveProperty("activeFlags");
  expect(f.readNative).not.toHaveBeenCalled();
});
it("does not restore offline-deleted rows after repeated failed snapshot enumerations", async () => {
  const f = await removalFixture();
  await f.seedCount(2);
  f.native.rows = [f.current];

  for (let restart = 0; restart < 3; restart++) {
    const state = f.openState();
    vi.spyOn(state, "entries").mockRejectedValue(new Error("snapshot enumeration unavailable"));
    const recovering = f.createIndex(state);
    expect(await threadIds(recovering)).toEqual([f.current.id]);
    await recovering.initialize();
    await recovering.upsertThread({ ...f.current, name: `Changed during outage ${restart}` });
    await closeState(recovering);
  }

  await f.expectRecovered(f.current.id);
});

it("invalidates saved completeness when an admitted deletion fails during shutdown", async () => {
  const f = await removalFixture();
  const state = f.openState();
  const index = f.createIndex(state);
  const deletionStarted = gate();
  const deletionAllowed = gate();
  await index.initialize();
  expect((await index.list({})).sessions).toHaveLength(2);
  const harness = await f.observe();
  const realDelete = state.delete;
  vi.spyOn(state, "delete").mockImplementation(async (key) => {
    if (key !== "complete") {
      deletionStarted.resolve();
      await deletionAllowed.promise;
      throw new Error("admitted deletion failed during shutdown");
    }
    return realDelete(key);
  });
  f.native.rows = [f.current];
  harness.send({ method: "thread/deleted", params: { threadId: f.removed.id } });
  await deletionStarted.promise;
  expect(await threadIds(index)).toEqual([f.current.id]);
  const closing = index.close();
  deletionAllowed.resolve();
  await closing;
  await harness.client.closeAndWait();
  const savedAfterShutdown = await f.openState().entries();
  await closeOpenClawStateDatabaseAsync();

  expect(savedAfterShutdown.some((entry) => entry.key === "complete")).toBe(false);
  await f.expectRecovered(f.current.id);
});

it("persists archives received before saved snapshot restoration", async () => {
  const f = await removalFixture();
  await f.seedCount(2);

  const captured = gate();
  const release = gate();
  const state = f.openState();
  const realEntries = state.entries;
  vi.spyOn(state, "entries").mockImplementation(async () => {
    const entries = await realEntries();
    captured.resolve();
    await release.promise;
    return entries;
  });
  const restoring = f.createIndex(state);
  const harness = await f.observe();
  f.native.rows = [f.current];
  harness.send({ method: "thread/archived", params: { threadId: f.removed.id } });
  const listed = restoring.list({});
  void listed.catch(() => undefined);
  await captured.promise;
  release.resolve();
  expect((await listed).sessions.map((row) => row.threadId)).toEqual([f.current.id]);
  await restoring.initialize();
  await restoring.close();
  await harness.client.closeAndWait();
  await closeOpenClawStateDatabaseAsync();

  f.readNative.mockClear();
  const recovered = f.createIndex();
  expect(await threadIds(recovered)).toEqual([f.current.id]);
  expect(f.readNative).not.toHaveBeenCalled();
});
