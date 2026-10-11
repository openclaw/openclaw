import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import type { StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";
import { writeCatalogRollout } from "./session-catalog-resident.test-support.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
  config,
  idleThread,
  pinnedConnectionMocks,
} from "./session-catalog.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function catalogState(namespace: string) {
  return createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
    namespace,
    maxEntries: 20_001,
  });
}

function createSnapshotFixture(namespace: string, rows: CodexThread[], homeId = namespace) {
  const native = { rows };
  const openState = () => catalogState(namespace);
  const readNative = vi.fn(async () =>
    projectCodexCatalogPage({ data: native.rows }, { sanitize: sanitizeTerminalText }),
  );
  const createIndex = (state = openState()) =>
    new CodexCatalogIndex({ homeId, state, readNative, assertCurrent: () => {} });
  return { native, openState, readNative, createIndex };
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

describe("resident Codex catalog SQLite durability", () => {
  it("prunes obsolete cached rows in background before native hydration without deleting fresh replacements", async () => {
    const state = catalogState("resident-obsolete-authority-test");
    const native = idleThread({ id: "fresh", source: "cli", preview: "Current native request" });
    const projected = await projectCodexCatalogPage(
      { data: [native] },
      { sanitize: sanitizeTerminalText },
    );
    const legacy = structuredClone(projected.rows[0]!);
    Reflect.deleteProperty(legacy, "nativeMetadata");
    await state.register("obsolete-cache-key", { version: 1, kind: "row", row: legacy });
    const freshKey = `thread:${createHash("sha256").update(native.id).digest("hex")}`;
    await state.register(freshKey, { version: 1, kind: "row", row: legacy });
    await state.register("complete", { version: 1, kind: "complete" });
    const deletes = vi.spyOn(state, "delete");
    const restoreEntered = createDeferred<void>();
    const restoreAllowed = createDeferred<void>();
    const readNative = vi.fn(async () => {
      expect(await state.entries()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ key: "obsolete-cache-key" })]),
      );
      return projected;
    });
    const index = new CodexCatalogIndex({
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
    try {
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
      const persisted = (await state.entries()).flatMap((entry) =>
        entry.value.kind === "row" ? [entry.value.row] : [],
      );
      expect(persisted).toMatchObject([{ threadId: "fresh", nativeMetadata: true }]);
    } finally {
      restoreAllowed.resolve();
      await listed;
      await index.close();
    }
  });

  it("keeps the persisted selected rollout eligible while older files and a native revert reconcile", async () => {
    const home = tempDirs.make("codex-selected-rollout-");
    const root = path.join(home, "sessions");
    let current = idleThread({
      id: "selected-thread",
      name: "Selected native thread",
      preview: "Selected first user request",
      cwd: "/workspace/selected",
      source: "cli",
      originator: "codex_cli_rs",
      turns: [],
    });
    current.path = await writeCatalogRollout(root, current);
    const openState = () => catalogState("selected-rollout-test");
    const createFactory = () =>
      createCodexSessionCatalogControlFactory({
        env: { CODEX_HOME: home },
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => config,
        openResidentState: openState,
      });
    const factory = createFactory();
    const source = (await factory.homesForAgent("main"))[0]!;
    const first = new CodexCatalogIndex({
      homeId: source.sourceHomeId,
      localSessionsRoot: root,
      state: openState(),
      readNative: async () =>
        projectCodexCatalogPage({ data: [current] }, { sanitize: sanitizeTerminalText }),
      assertCurrent: () => {},
    });
    try {
      await first.initialize();
    } finally {
      await first.close();
    }
    await closeOpenClawStateDatabaseAsync();
    const writeMetadata = (file: string, cwd: string, padding = 0) =>
      fs.writeFile(
        file,
        [
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: current.id,
              timestamp: "2026-09-16T12:00:00.000Z",
              cwd,
              source: "cli",
              originator: "codex_cli_rs",
              history_mode: "paginated",
              base_instructions: { text: "x".repeat(padding) },
            },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "user_message", message: "Older request" },
          }),
          "",
        ].join("\n"),
      );
    const retiredPath = path.join(path.dirname(current.path), "rollout-retired.jsonl");
    await writeMetadata(retiredPath, "/workspace/retired");
    const future = new Date("2030-01-01T00:00:00.000Z");
    await fs.utimes(retiredPath, future, future);
    const requested = createDeferred<void>();
    const released = createDeferred<void>();
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
    try {
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
      try {
        const selected = reverted.forRequest("main", (await reverted.homesForAgent("main"))[0]);
        await selected.initialize();
        await expect(selected.requireEligibleThread(current.id)).resolves.toMatchObject({
          path: replacementPath,
          cwd: "/workspace/replacement",
        });
        expect((await selected.listPage({})).sessions[0]?.cwd).toBe("/workspace/replacement");
      } finally {
        await reverted.stop();
      }
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
      expect(pinnedConnectionMocks.request.mock.calls.map(([request]) => request.method)).toEqual([
        "thread/read",
        "thread/read",
      ]);
      commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
      const unavailable = createFactory();
      try {
        const retained = unavailable.forRequest(
          "main",
          (await unavailable.homesForAgent("main"))[0],
        );
        await retained.initialize();
        await expect(retained.requireEligibleThread(current.id)).resolves.toMatchObject({
          path: replacementPath,
        });
        expect((await retained.listPage({})).sessions[0]?.cwd).toBe("/workspace/replacement");
      } finally {
        await unavailable.stop();
      }
    } finally {
      released.resolve();
      await initializing.catch(() => undefined);
      await factory.stop();
    }
  });

  it("serves a restart from SQLite before reconciling only the changed rollout", async () => {
    const root = path.join(tempDirs.make("openclaw-resident-restart-"), "sessions");
    const native = ["changed", "untouched"].map((id) =>
      idleThread({
        id,
        name: null,
        source: "cli",
        originator: "codex_cli_rs",
        preview: `Original ${id}`,
      }),
    );
    for (const thread of native) {
      thread.path = await writeCatalogRollout(root, thread);
    }
    const openState = () => catalogState("resident-restart-test");
    const nativeAllowed = createDeferred<void>();
    let paused = false;
    const readNative = vi.fn(async () => {
      if (paused) {
        await nativeAllowed.promise;
      }
      return projectCodexCatalogPage(
        { data: structuredClone(native) },
        { sanitize: sanitizeTerminalText },
      );
    });
    const createIndex = () =>
      new CodexCatalogIndex({
        homeId: "restart",
        localSessionsRoot: root,
        state: openState(),
        readNative,
        assertCurrent: () => {},
      });
    const first = createIndex();
    let initial;
    try {
      await first.initialize();
      initial = await first.list({});
      const persisted = (await openState().entries()).map((entry) => entry.value);
      expect(persisted).toHaveLength(3);
      expect(persisted).toContainEqual({ version: 1, kind: "complete" });
      expect(persisted.filter((entry) => entry.kind === "row")).toEqual([
        expect.objectContaining({ row: expect.objectContaining({ nativeMetadata: true }) }),
        expect.objectContaining({ row: expect.objectContaining({ nativeMetadata: true }) }),
      ]);
      expect(
        persisted.flatMap((entry) => (entry.kind === "row" ? [entry.row.threadId] : [])).toSorted(),
      ).toEqual(["changed", "untouched"]);
    } finally {
      await first.close();
    }
    await closeOpenClawStateDatabaseAsync();
    native[0]!.preview = "Changed while the Gateway was stopped";
    const changedFile = await writeCatalogRollout(root, {
      ...native[0]!,
      cwd: "/workspace/stale-rollout-header",
    });
    paused = true;
    readNative.mockClear();
    const open = vi.spyOn(fs, "open");
    const readFile = vi.spyOn(fs, "readFile");
    const restarted = createIndex();
    try {
      expect(await restarted.list({})).toEqual({
        ...initial,
        sessions: initial.sessions.map((session) =>
          Object.assign({}, session, { status: "notLoaded" }),
        ),
      });
      expect(readNative).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
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
      expect(open.mock.calls.map((call) => call[0])).toEqual([changedFile]);
      expect(readNative).toHaveBeenCalledOnce();
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      nativeAllowed.resolve();
      await restarted.close();
    }
  });

  it("refreshes an offline native rename after returning the persisted list without reading unchanged rollouts", async () => {
    const root = path.join(tempDirs.make("openclaw-resident-offline-title-"), "sessions");
    const native = idleThread({
      id: "renamed",
      name: "Previous title",
      preview: "Original user request",
      source: "cli",
      originator: "codex_cli_rs",
    });
    const rollout = await writeCatalogRollout(root, native);
    native.path = rollout;
    const originalBytes = await fs.readFile(rollout);
    const originalStat = await fs.stat(rollout);
    const openState = () => catalogState("resident-offline-title-test");
    const metadata = createDeferred<void>();
    let offline = false;
    const readNative = vi.fn(async (_params: CodexThreadListParams) => {
      if (offline) {
        await metadata.promise;
      }
      return projectCodexCatalogPage(
        { data: [structuredClone(native)] },
        { sanitize: sanitizeTerminalText },
      );
    });
    const createIndex = () =>
      new CodexCatalogIndex({
        homeId: "offline-title",
        localSessionsRoot: root,
        state: openState(),
        readNative,
        assertCurrent: () => {},
      });
    const first = createIndex();
    try {
      await first.initialize();
      expect((await first.list({})).sessions[0]?.name).toBe("Previous title");
    } finally {
      await first.close();
    }
    await closeOpenClawStateDatabaseAsync();
    offline = true;
    native.name = "Renamed while offline";
    expect(await fs.readFile(rollout)).toEqual(originalBytes);
    expect(await fs.stat(rollout)).toMatchObject({
      mtimeMs: originalStat.mtimeMs,
      size: originalStat.size,
    });
    readNative.mockClear();
    const open = vi.spyOn(fs, "open");
    const readFile = vi.spyOn(fs, "readFile");
    const restarted = createIndex();
    try {
      expect((await restarted.list({})).sessions[0]?.name).toBe("Previous title");
      expect(readNative).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(readNative).toHaveBeenCalledOnce());
      expect(readNative.mock.calls[0]?.[0]).toMatchObject({ useStateDbOnly: true });
      expect((await restarted.list({ searchTerm: "previous" })).sessions).toHaveLength(1);
      metadata.resolve();
      await vi.waitFor(async () => {
        expect((await restarted.list({ searchTerm: "renamed" })).sessions).toMatchObject([
          { threadId: "renamed", name: "Renamed while offline" },
        ]);
      });
      expect((await restarted.list({ searchTerm: "previous" })).sessions).toEqual([]);
      expect(readNative).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      metadata.resolve();
      await restarted.close();
    }
  });

  it("drains title, status, and archive changes to SQLite before closing", async () => {
    const startOptions: CodexAppServerStartOptions = {
      transport: "websocket",
      command: "codex",
      args: ["app-server"],
      url: "wss://resident-state.example.test/codex",
      headers: {},
    };
    const homeId = await codexCatalogResidentHomeKey({ startOptions });
    const native = [
      idleThread({
        id: "visible",
        name: "Original title",
        preview: "Original request",
        source: "cli",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      }),
      idleThread({ id: "archived", name: "Archived title", source: "cli" }),
    ];
    const openState = () => catalogState("resident-mutations-test");
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage(
        { data: structuredClone(native) },
        { sanitize: sanitizeTerminalText },
      ),
    );
    const createIndex = () =>
      new CodexCatalogIndex({
        homeId,
        state: openState(),
        readNative,
        assertCurrent: () => {},
      });
    const first = createIndex();
    const harness = createClientHarness();
    try {
      await first.initialize();
      await observeCodexCatalogClient(harness.client, { startOptions });
      harness.send({
        method: "thread/name/updated",
        params: { threadId: "visible", threadName: null },
      });
      harness.send({
        method: "thread/status/changed",
        params: { threadId: "visible", status: { type: "idle" } },
      });
      harness.send({ method: "thread/archived", params: { threadId: "archived" } });
      harness.send({
        method: "thread/settings/updated",
        params: {
          threadId: "visible",
          threadSettings: { cwd: "/workspace/live", modelProvider: "live-provider" },
        },
      });
      const page = await first.list({});
      expect(page.sessions).toHaveLength(1);
      expect(page.sessions[0]).toMatchObject({
        threadId: "visible",
        name: null,
        fallbackName: "Original request",
        status: "idle",
        cwd: "/workspace/live",
        modelProvider: "live-provider",
      });
      expect(page.sessions[0]?.activeFlags).toBeUndefined();
      expect(harness.writes).toEqual([]);
    } finally {
      await first.close();
      await harness.client.closeAndWait();
    }
    await closeOpenClawStateDatabaseAsync();
    const persisted = (await openState().entries()).flatMap((entry) =>
      entry.value.kind === "row" ? [entry.value.row] : [],
    );
    expect(persisted.find((row) => row.threadId === "archived")?.archived).toBe(true);
    expect(persisted.find((row) => row.threadId === "visible")?.page.sessions[0]).toMatchObject({
      name: null,
      fallbackName: "Original request",
      status: "notLoaded",
      cwd: "/workspace/project",
    });
    expect(
      persisted.find((row) => row.threadId === "visible")?.page.sessions[0],
    ).not.toHaveProperty("activeFlags");
    readNative.mockClear();
    const restarted = createIndex();
    try {
      const page = await restarted.list({});
      expect(page.sessions).toHaveLength(1);
      expect(page.sessions[0]).toMatchObject({
        threadId: "visible",
        name: null,
        fallbackName: "Original request",
        status: "notLoaded",
        cwd: "/workspace/project",
      });
      expect(page.sessions[0]).not.toHaveProperty("activeFlags");
      expect(readNative).not.toHaveBeenCalled();
    } finally {
      await restarted.close();
    }
  });
});

it("does not restore offline-deleted rows after repeated failed snapshot enumerations", async () => {
  const deleted = idleThread({ id: "deleted-while-offline", source: "cli" });
  const current = idleThread({ id: "still-current", source: "cli" });
  const { native, openState, createIndex } = createSnapshotFixture("snapshot-read-recovery", [
    deleted,
    current,
  ]);
  const original = createIndex();
  try {
    await original.initialize();
    expect((await original.list({})).sessions).toHaveLength(2);
  } finally {
    await original.close();
  }
  await closeOpenClawStateDatabaseAsync();
  native.rows = [current];

  for (let restart = 0; restart < 3; restart++) {
    const state = openState();
    vi.spyOn(state, "entries").mockRejectedValue(new Error("snapshot enumeration unavailable"));
    const recovering = createIndex(state);
    try {
      // A snapshot outage must not prevent native hydration or memory serving.
      expect((await recovering.list({})).sessions.map((row) => row.threadId)).toEqual([current.id]);
      await recovering.initialize();
      await recovering.upsertThread({ ...current, name: `Changed during outage ${restart}` });
    } finally {
      await recovering.close();
    }
    await closeOpenClawStateDatabaseAsync();
  }

  const recovered = createIndex();
  try {
    // Check the first list before a saved snapshot's background refresh could repair it.
    expect((await recovered.list({})).sessions.map((row) => row.threadId)).toEqual([current.id]);
    await recovered.initialize();
    const saved = await openState().entries();
    expect(
      saved.flatMap((entry) => (entry.value.kind === "row" ? [entry.value.row.threadId] : [])),
    ).toEqual([current.id]);
    expect(saved.some((entry) => entry.key === "complete")).toBe(true);
  } finally {
    await recovered.close();
  }
});

it("invalidates saved completeness when an admitted deletion fails during shutdown", async () => {
  const startOptions = localStartOptions("codex-catalog-shutdown-failure-");
  const homeId = await codexCatalogResidentHomeKey({ startOptions });
  const deleted = idleThread({ id: "deleted-before-shutdown", source: "cli" });
  const current = idleThread({ id: "still-current", source: "cli" });
  const { native, openState, createIndex } = createSnapshotFixture(
    "snapshot-shutdown-failure",
    [deleted, current],
    homeId,
  );
  const state = openState();
  const index = createIndex(state);
  const harness = createClientHarness();
  const deletionStarted = createDeferred<void>();
  const deletionAllowed = createDeferred<void>();
  let closing: Promise<void> | undefined;
  try {
    await index.initialize();
    expect((await index.list({})).sessions).toHaveLength(2);
    await observeCodexCatalogClient(harness.client, { startOptions });
    const realDelete = state.delete;
    vi.spyOn(state, "delete").mockImplementation(async (key) => {
      if (key !== "complete") {
        deletionStarted.resolve();
        await deletionAllowed.promise;
        throw new Error("admitted deletion failed during shutdown");
      }
      return realDelete(key);
    });
    native.rows = [current];
    harness.send({ method: "thread/deleted", params: { threadId: deleted.id } });
    await deletionStarted.promise;
    expect((await index.list({})).sessions.map((row) => row.threadId)).toEqual([current.id]);
    closing = index.close();
    deletionAllowed.resolve();
    await closing;
  } finally {
    deletionAllowed.resolve();
    await (closing ?? index.close());
    await harness.client.closeAndWait();
  }
  const savedAfterShutdown = await openState().entries();
  await closeOpenClawStateDatabaseAsync();

  const recovered = createIndex();
  try {
    expect((await recovered.list({})).sessions.map((row) => row.threadId)).toEqual([current.id]);
    expect(savedAfterShutdown.some((entry) => entry.key === "complete")).toBe(false);
    await recovered.initialize();
    const saved = await openState().entries();
    expect(
      saved.flatMap((entry) => (entry.value.kind === "row" ? [entry.value.row.threadId] : [])),
    ).toEqual([current.id]);
    expect(saved.some((entry) => entry.key === "complete")).toBe(true);
  } finally {
    await recovered.close();
  }
});

it("persists archives received before saved snapshot restoration", async () => {
  const startOptions = localStartOptions("codex-catalog-archive-before-restore-");
  const homeId = await codexCatalogResidentHomeKey({ startOptions });
  const archived = idleThread({ id: "archived-during-restore", source: "cli" });
  const current = idleThread({ id: "still-current", source: "cli" });
  const { native, openState, readNative, createIndex } = createSnapshotFixture(
    "archive-before-snapshot-restore",
    [archived, current],
    homeId,
  );
  const original = createIndex();
  try {
    await original.initialize();
    expect((await original.list({})).sessions).toHaveLength(2);
  } finally {
    await original.close();
  }
  await closeOpenClawStateDatabaseAsync();

  const captured = createDeferred<void>();
  const release = createDeferred<void>();
  const state = openState();
  const realEntries = state.entries;
  vi.spyOn(state, "entries").mockImplementation(async () => {
    const entries = await realEntries();
    captured.resolve();
    await release.promise;
    return entries;
  });
  const restoring = createIndex(state);
  const harness = createClientHarness();
  let listed: ReturnType<CodexCatalogIndex["list"]> | undefined;
  try {
    await observeCodexCatalogClient(harness.client, { startOptions });
    const archive = () => {
      native.rows = [current];
      harness.send({ method: "thread/archived", params: { threadId: archived.id } });
    };
    archive();
    listed = restoring.list({});
    void listed.catch(() => undefined);
    await captured.promise;
    release.resolve();
    expect((await listed).sessions.map((row) => row.threadId)).toEqual([current.id]);
    await restoring.initialize();
  } finally {
    release.resolve();
    await listed?.catch(() => undefined);
    await restoring.close();
    await harness.client.closeAndWait();
  }
  await closeOpenClawStateDatabaseAsync();

  readNative.mockClear();
  const recovered = createIndex();
  try {
    expect((await recovered.list({})).sessions.map((row) => row.threadId)).toEqual([current.id]);
    expect(readNative).not.toHaveBeenCalled();
  } finally {
    await recovered.close();
  }
});
