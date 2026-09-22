import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexThread } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import type { StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";
import { idleThread } from "./session-catalog.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([1, 3])(
  "does not restore offline-deleted rows after %i failed snapshot enumerations",
  async (failedRestarts) => {
    const namespace = `snapshot-read-recovery-${failedRestarts}`;
    const openState = () =>
      createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
        namespace,
        maxEntries: 20_001,
      });
    const deleted = idleThread({ id: "deleted-while-offline", source: "cli" });
    const current = idleThread({ id: "still-current", source: "cli" });
    let nativeRows: CodexThread[] = [deleted, current];
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage({ data: nativeRows }, { sanitize: sanitizeTerminalText }),
    );
    const createIndex = (failSnapshot = false) => {
      const state = openState();
      if (failSnapshot) {
        vi.spyOn(state, "entries").mockRejectedValue(new Error("snapshot enumeration unavailable"));
      }
      return new CodexCatalogIndex({
        homeId: namespace,
        state,
        readNative,
        assertCurrent: () => {},
      });
    };
    const original = createIndex();
    try {
      await original.initialize();
      expect((await original.list({})).sessions).toHaveLength(2);
    } finally {
      await original.close();
    }
    await closeOpenClawStateDatabaseAsync();
    nativeRows = [current];

    for (let restart = 0; restart < failedRestarts; restart++) {
      const recovering = createIndex(true);
      try {
        // A snapshot outage must not prevent native hydration or memory serving.
        expect((await recovering.list({})).sessions.map((row) => row.threadId)).toEqual([
          current.id,
        ]);
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
  },
);

it("invalidates saved completeness when an admitted deletion fails during shutdown", async () => {
  const home = tempDirs.make("codex-catalog-shutdown-failure-");
  const startOptions: CodexAppServerStartOptions = {
    transport: "stdio",
    command: "codex",
    args: ["app-server"],
    env: { CODEX_HOME: home },
    headers: {},
  };
  const homeId = await codexCatalogResidentHomeKey({ startOptions });
  const openState = () =>
    createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
      namespace: "snapshot-shutdown-failure",
      maxEntries: 20_001,
    });
  const deleted = idleThread({ id: "deleted-before-shutdown", source: "cli" });
  const current = idleThread({ id: "still-current", source: "cli" });
  let nativeRows: CodexThread[] = [deleted, current];
  const readNative = async () =>
    projectCodexCatalogPage({ data: nativeRows }, { sanitize: sanitizeTerminalText });
  const state = openState();
  const index = new CodexCatalogIndex({ homeId, state, readNative, assertCurrent: () => {} });
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
    nativeRows = [current];
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

  const recovered = new CodexCatalogIndex({
    homeId,
    state: openState(),
    readNative,
    assertCurrent: () => {},
  });
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

it.each(["before", "during"])(
  "persists archives received %s saved snapshot restoration",
  async (phase) => {
    const home = tempDirs.make(`codex-catalog-archive-${phase}-restore-`);
    const startOptions: CodexAppServerStartOptions = {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      env: { CODEX_HOME: home },
      headers: {},
    };
    const homeId = await codexCatalogResidentHomeKey({ startOptions });
    const openState = () =>
      createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
        namespace: `archive-${phase}-snapshot-restore`,
        maxEntries: 20_001,
      });
    const archived = idleThread({ id: "archived-during-restore", source: "cli" });
    const current = idleThread({ id: "still-current", source: "cli" });
    let nativeRows: CodexThread[] = [archived, current];
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage({ data: nativeRows }, { sanitize: sanitizeTerminalText }),
    );
    const createIndex = (state = openState()) =>
      new CodexCatalogIndex({ homeId, state, readNative, assertCurrent: () => {} });
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
        nativeRows = [current];
        harness.send({ method: "thread/archived", params: { threadId: archived.id } });
      };
      if (phase === "before") {
        archive();
      }
      listed = restoring.list({});
      void listed.catch(() => undefined);
      await captured.promise;
      if (phase === "during") {
        archive();
      }
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
  },
);
