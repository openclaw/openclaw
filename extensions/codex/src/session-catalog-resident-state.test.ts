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
import type { CodexThreadListParams } from "./app-server/protocol.js";
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

describe("resident Codex catalog SQLite durability", () => {
  it("prunes obsolete cached rows in background before native hydration without deleting fresh replacements", async () => {
    const state = createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
      namespace: "resident-obsolete-authority-test",
      maxEntries: 20_001,
    });
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
    const openState = () =>
      createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
        namespace: "selected-rollout-test",
        maxEntries: 20_001,
      });
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
    const openState = () =>
      createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
        namespace: "resident-restart-test",
        maxEntries: 20_001,
      });
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
    const openState = () =>
      createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
        namespace: "resident-offline-title-test",
        maxEntries: 20_001,
      });
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
    const openState = () =>
      createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
        namespace: "resident-mutations-test",
        maxEntries: 20_001,
      });
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
