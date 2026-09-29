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

function createSnapshotFixture(namespace: string, rows: CodexThread[], homeId = namespace) {
  const native = { rows };
  const openState = () =>
    createPluginStateKeyedStoreForTests<StoredCodexCatalogEntry>("codex", {
      namespace,
      maxEntries: 20_001,
    });
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

it.each(["before", "during"])(
  "persists archives received %s saved snapshot restoration",
  async (phase) => {
    const startOptions = localStartOptions(`codex-catalog-archive-${phase}-restore-`);
    const homeId = await codexCatalogResidentHomeKey({ startOptions });
    const archived = idleThread({ id: "archived-during-restore", source: "cli" });
    const current = idleThread({ id: "still-current", source: "cli" });
    const { native, openState, readNative, createIndex } = createSnapshotFixture(
      `archive-${phase}-snapshot-restore`,
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
