import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createChannelIngressQueueForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import {
  deleteMatrixSyncStoreCursor,
  rewriteMatrixSyncStoreCursor,
  waitForMatrixIngressCompletion,
  waitForMatrixSyncStoreWithCursor,
} from "./scenario-runtime-state-files.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStores();
    cleanup();
  }),
);
const identity = { accountId: "target", userId: "@target:matrix-qa.test" };
const context = createMatrixQaE2eeTestContext({
  sutAccountId: identity.accountId,
  sutUserId: identity.userId,
});

const openStore = (root: string, namespace: string) =>
  createPluginStateSyncKeyedStoreForTests<unknown>("matrix", {
    namespace,
    maxEntries: 20,
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  });

const createStateDir = () => tempDirs.make("matrix-qa-sync-");

const syncDefaults = { metadata: identity, cursor: "other-cursor" };
async function closeStores() {
  resetPluginStateStoreForTests();
  await closeOpenClawStateDatabaseAsync();
}
async function seedSyncStore(root: string, options: Partial<typeof syncDefaults> = {}) {
  const { metadata, cursor } = { ...syncDefaults, ...options };
  await mkdir(root, { recursive: true });
  openStore(root, "storage-meta").register("current", metadata);
  const data = JSON.stringify({ nextBatch: cursor });
  const store = openStore(root, "sync-cache");
  store.register("current:sync:fixture:0", { kind: "sync-chunk", index: 0, data });
  store.register("current:meta", { kind: "meta", generation: "fixture", chunkCount: 1 });
}

const waitCursor = (
  stateDir: string,
  options: Partial<Parameters<typeof waitForMatrixSyncStoreWithCursor>[0]> = {},
) => waitForMatrixSyncStoreWithCursor({ context, stateDir, timeoutMs: 1_000, ...options });
const expectNoCursor = (stateDir: string) =>
  expect(waitCursor(stateDir, { timeoutMs: 20 })).rejects.toThrow(
    "timed out waiting for Matrix sync store cursor",
  );

it.each(["accountId", "userId"] as const)(
  "ignores stale sidecar %s and selects only the requested SQLite identity",
  async (field) => {
    const stateDir = createStateDir();
    const other = path.join(stateDir, "matrix", "accounts", "aa-other");
    const target = path.join(stateDir, "matrix", "accounts", "zz-target");
    await seedSyncStore(other, { metadata: { ...identity, [field]: "other" } });
    await writeFile(path.join(other, "storage-meta.json"), JSON.stringify(identity));
    await closeStores();
    await expectNoCursor(stateDir);
    await seedSyncStore(target, { cursor: "target-cursor" });
    for (const root of [other, target]) {
      openStore(root, "idb-snapshot").register("sentinel", { preserved: root });
    }
    await closeStores();

    const defaults = createMatrixQaE2eeTestContext();
    const selected = await waitCursor(stateDir, { context: defaults, ...identity });
    expect(selected).toMatchObject({
      pathname: path.join(target, "state", "openclaw.sqlite"),
      cursor: "target-cursor",
      stateKey: "current",
    });
    const unrelatedSyncRows = openStore(other, "sync-cache").entries();
    const rewritten = { ...selected, cursor: "rewritten-cursor" };
    await rewriteMatrixSyncStoreCursor(rewritten);
    await expect(waitCursor(stateDir)).resolves.toEqual(rewritten);
    expect(openStore(other, "sync-cache").entries()).toEqual(unrelatedSyncRows);
    await deleteMatrixSyncStoreCursor(selected);
    expect(openStore(target, "sync-cache").entries()).toEqual([]);
    expect(openStore(other, "sync-cache").entries()).toEqual(unrelatedSyncRows);
    for (const root of [other, target]) {
      expect(openStore(root, "idb-snapshot").lookup("sentinel")).toEqual({ preserved: root });
    }
  },
);

it("finds a boundary-depth cursor after deeper subtrees and skips linked state", async () => {
  const stateDir = createStateDir();
  const levels = Array.from({ length: 8 }, (_, index) => `d${index}`);
  const target = path.join(stateDir, "zz-target", ...levels);
  const linked = createStateDir();
  for (const root of [path.join(stateDir, "aa-too-deep", ...levels, "extra"), linked]) {
    await seedSyncStore(root, { cursor: "excluded-cursor" });
  }
  await symlink(linked, path.join(stateDir, "aa-linked"), "junction");
  await seedSyncStore(target, { cursor: "target-cursor" });
  await closeStores();
  await expect(waitCursor(stateDir)).resolves.toMatchObject({
    cursor: "target-cursor",
    pathname: path.join(target, "state/openclaw.sqlite"),
  });
});

it("observes only the requested account's completed ingress event", async () => {
  const stateDir = createStateDir();
  const eventId = "$event";
  const accountId = "sut";
  const makeQueue = (id: string) =>
    createChannelIngressQueueForTests({ channelId: "matrix", accountId: id, stateDir });
  const queue = makeQueue(accountId);
  const otherQueue = makeQueue("other");
  await otherQueue.complete(eventId);
  await queue.enqueue(eventId, { roomId: "!room:matrix-qa.test" });
  await expect(
    waitForMatrixIngressCompletion({ accountId, eventId, stateDir, timeoutMs: 20 }),
  ).rejects.toThrow("timed out waiting for Matrix ingress completion");

  const claimed = await queue.claim(eventId, { ownerId: "qa-probe" });
  expect(claimed).toBeDefined();
  await queue.complete(claimed!);
  await expect(
    waitForMatrixIngressCompletion({ accountId, eventId, stateDir, timeoutMs: 1_000 }),
  ).resolves.toBe(path.join(stateDir, "state", "openclaw.sqlite"));
});
