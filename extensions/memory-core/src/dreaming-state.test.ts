import path from "node:path";
import { setImmediate } from "node:timers";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, test } from "vitest";
import {
  clearMemoryCoreWorkspaceNamespace,
  configureMemoryCoreDreamingState,
  memoryCoreWorkspaceStateKey,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    configureMemoryCoreDreamingState(() => {
      throw new Error("memory workspace test store is closed");
    });
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

function createFixture(onMutation?: (operation: "register" | "delete") => void, rangeReads = true) {
  const root = tempDirs.make("memory-workspace-state-");
  const env = { OPENCLAW_STATE_DIR: root };
  configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
    const store = createPluginStateKeyedStoreForTests<T>("memory-core", { ...options, env });
    return {
      ...store,
      entriesInKeyRange: rangeReads ? store.entriesInKeyRange : undefined,
      async register(...args: Parameters<typeof store.register>) {
        await store.register(...args);
        onMutation?.("register");
      },
      async delete(key: string) {
        const deleted = await store.delete(key);
        if (deleted) {
          onMutation?.("delete");
        }
        return deleted;
      },
    };
  });
  const scope = { namespace: "workspace-progress", workspaceDir: path.join(root, "workspace") };
  return {
    scope,
    foreignWorkspace: { ...scope, workspaceDir: path.join(root, "foreign-workspace") },
    foreignNamespace: { ...scope, namespace: "workspace-other" },
    database: openOpenClawStateDatabase({ env }),
  };
}

async function readValues(scope: ReturnType<typeof createFixture>["scope"]) {
  return Object.fromEntries(
    (await readMemoryCoreWorkspaceEntries(scope)).map(({ key, value }) => [key, value]),
  );
}

test("workspace enumeration isolates corrupt neighbors while preserving order and expiry", async () => {
  const { scope, foreignWorkspace, foreignNamespace, database } = createFixture();
  await writeMemoryCoreWorkspaceEntries({
    ...scope,
    entries: ["a", "b", "c", "expired"].map((key) => ({ key, value: key })),
  });
  await writeMemoryCoreWorkspaceEntry({ ...foreignWorkspace, key: "foreign", value: "foreign" });
  await writeMemoryCoreWorkspaceEntry({ ...foreignNamespace, key: "other", value: "other" });
  const prefix = `${memoryCoreWorkspaceStateKey(scope.workspaceDir)}:`;
  const foreignPrefix = `${memoryCoreWorkspaceStateKey(foreignWorkspace.workspaceDir)}:`;
  database.db
    .prepare(
      `UPDATE plugin_state_entries
       SET created_at = CASE json_extract(value_json, '$.key') WHEN 'a' THEN 30 ELSE 10 END,
           expires_at = CASE json_extract(value_json, '$.key') WHEN 'expired' THEN 0 ELSE NULL END
       WHERE plugin_id = 'memory-core' AND namespace = ? AND entry_key LIKE ?`,
    )
    .run(scope.namespace, `${prefix}%`);
  const corrupt = database.db.prepare(
    `UPDATE plugin_state_entries SET value_json = '{'
     WHERE plugin_id = 'memory-core' AND namespace = ? AND entry_key LIKE ?`,
  );
  corrupt.run(scope.namespace, `${foreignPrefix}%`);

  // Equal timestamps retain stored-key order: SHA-256(c) sorts before SHA-256(b).
  expect(await readMemoryCoreWorkspaceEntries(scope)).toEqual([
    { key: "c", value: "c" },
    { key: "b", value: "b" },
    { key: "a", value: "a" },
  ]);
  await writeMemoryCoreWorkspaceEntries({
    ...scope,
    entries: [{ key: "replacement", value: "new" }],
  });
  expect(await readValues(scope)).toEqual({ replacement: "new" });
  await clearMemoryCoreWorkspaceNamespace(scope);
  expect(await readValues(scope)).toEqual({});
  expect(await readValues(foreignNamespace)).toEqual({ other: "other" });
  expect(
    database.db
      .prepare(
        `SELECT value_json FROM plugin_state_entries
         WHERE plugin_id = 'memory-core' AND namespace = ? AND entry_key LIKE ?`,
      )
      .get(scope.namespace, `${foreignPrefix}%`),
  ).toEqual({ value_json: "{" });

  await writeMemoryCoreWorkspaceEntry({ ...scope, key: "corrupt", value: "selected" });
  corrupt.run(scope.namespace, `${prefix}%`);
  for (const operation of [
    () => readMemoryCoreWorkspaceEntries(scope),
    () => writeMemoryCoreWorkspaceEntries({ ...scope, entries: [] }),
    () => clearMemoryCoreWorkspaceNamespace(scope),
  ]) {
    await expect(operation()).rejects.toMatchObject({
      code: "PLUGIN_STATE_CORRUPT",
      operation: "entries",
    });
  }
});

test("supports existing keyed-store adapters without range reads", async () => {
  const { scope, foreignWorkspace } = createFixture(undefined, false);
  await writeMemoryCoreWorkspaceEntry({ ...foreignWorkspace, key: "foreign", value: "foreign" });
  await writeMemoryCoreWorkspaceEntry({ ...scope, key: "old", value: "old" });
  expect(await readValues(scope)).toEqual({ old: "old" });
  await writeMemoryCoreWorkspaceEntries({ ...scope, entries: [{ key: "new", value: "new" }] });
  expect(await readValues(scope)).toEqual({ new: "new" });
  await clearMemoryCoreWorkspaceNamespace(scope);
  expect(await readValues(scope)).toEqual({});
  expect(await readValues(foreignWorkspace)).toEqual({ foreign: "foreign" });
});

test.each(["replacement", "cleanup", "clear"] as const)(
  "workspace %s lets queued event-loop work observe committed progress",
  async (phase) => {
    let observeMutation: (() => void) | undefined;
    const { scope, foreignWorkspace, foreignNamespace, database } = createFixture((operation) => {
      if (phase === "replacement" || operation === "delete") {
        observeMutation?.();
      }
    });
    const originals = Array.from({ length: 64 }, (_, index) => ({
      key: `entry-${index}`,
      value: "old",
    }));
    const initial =
      phase === "replacement" ? [...originals, { key: "stale", value: "old" }] : originals;
    await writeMemoryCoreWorkspaceEntries({ ...scope, entries: initial });
    await writeMemoryCoreWorkspaceEntry({ ...foreignWorkspace, key: "entry-0", value: "foreign" });
    await writeMemoryCoreWorkspaceEntry({ ...foreignNamespace, key: "stale", value: "other" });
    const entries =
      phase === "clear"
        ? []
        : phase === "replacement"
          ? originals.map(({ key }) => ({ key, value: "new" }))
          : [{ key: "retained", value: "new" }];
    let completed = false;
    const observation = new Promise<{
      completed: boolean;
      transactionOpen: boolean;
      entries: Array<{ key: string; value: string }>;
    }>((resolve, reject) => {
      // Queue after the first durable mutation; initial worker reads can yield before progress.
      observeMutation = () => {
        observeMutation = undefined;
        setImmediate(() => {
          const completedAtCallback = completed;
          const transactionOpen = database.db.isTransaction;
          void readMemoryCoreWorkspaceEntries<string>(scope).then(
            (current) =>
              resolve({ completed: completedAtCallback, transactionOpen, entries: current }),
            reject,
          );
        });
      };
    });
    const operation = (
      phase === "clear"
        ? clearMemoryCoreWorkspaceNamespace(scope)
        : writeMemoryCoreWorkspaceEntries({ ...scope, entries })
    ).finally(() => {
      completed = true;
      observeMutation?.();
    });
    try {
      const [, observed] = await Promise.all([operation, observation]);
      expect(await readValues(scope)).toEqual(
        Object.fromEntries(entries.map(({ key, value }) => [key, value])),
      );
      expect(await readValues(foreignWorkspace)).toEqual({ "entry-0": "foreign" });
      expect(await readValues(foreignNamespace)).toEqual({ stale: "other" });

      expect(observed).toMatchObject({ completed: false, transactionOpen: false });
      if (phase === "replacement") {
        const updated = observed.entries.filter((entry) => entry.value === "new");
        expect(updated.length).toBeGreaterThan(0);
        expect(updated.length).toBeLessThan(entries.length);
        // Obsolete rows cannot disappear before every replacement write commits.
        expect(observed.entries).toContainEqual({ key: "stale", value: "old" });
      } else {
        const remaining = observed.entries.filter((entry) => entry.value === "old");
        expect(remaining.length).toBeGreaterThan(0);
        expect(remaining.length).toBeLessThan(originals.length);
        if (phase === "cleanup") {
          expect(observed.entries).toContainEqual({ key: "retained", value: "new" });
        }
      }
    } finally {
      await Promise.allSettled([operation, observation]);
    }
  },
);

test("a rejected replacement preserves its committed prefix and skips cleanup", async () => {
  const { scope, foreignWorkspace, foreignNamespace } = createFixture();
  await writeMemoryCoreWorkspaceEntries({
    ...scope,
    entries: [
      { key: "first", value: "old" },
      { key: "tail", value: "old" },
      { key: "stale", value: "old" },
    ],
  });
  await writeMemoryCoreWorkspaceEntry({ ...foreignWorkspace, key: "first", value: "foreign" });
  await writeMemoryCoreWorkspaceEntry({ ...foreignNamespace, key: "stale", value: "other" });

  await expect(
    writeMemoryCoreWorkspaceEntries<unknown>({
      ...scope,
      entries: [
        { key: "first", value: "new" },
        { key: "invalid", value: 1n },
        { key: "tail", value: "unreached" },
      ],
    }),
  ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT", operation: "register" });
  expect(await readValues(scope)).toEqual({ first: "new", tail: "old", stale: "old" });
  expect(await readValues(foreignWorkspace)).toEqual({ first: "foreign" });
  expect(await readValues(foreignNamespace)).toEqual({ stale: "other" });

  await writeMemoryCoreWorkspaceEntry({ ...scope, key: "tail", value: "scalar" });
  expect(await readValues(scope)).toEqual({ first: "new", tail: "scalar", stale: "old" });
});
