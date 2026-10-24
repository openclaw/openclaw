import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createChannelIngressQueueForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, expect, it } from "vitest";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";
import {
  deleteMatrixSyncStoreCursor,
  rewriteMatrixSyncStoreCursor,
  waitForMatrixIngressCompletion,
  waitForMatrixSyncStoreWithCursor,
} from "./scenario-runtime-state-files.js";

const tempDirs: string[] = [];
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

async function createStateDir() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-sync-"));
  tempDirs.push(stateDir);
  return stateDir;
}

const syncDefaults = { metadata: identity, cursor: "other-cursor" };
async function seedSyncStore(root: string, options: Partial<typeof syncDefaults> = {}) {
  const { metadata, cursor } = { ...syncDefaults, ...options };
  await mkdir(root, { recursive: true });
  openStore(root, "storage-meta").register("current", metadata);
  const savedSync = { nextBatch: cursor };
  // Persist the rows read by the probe; omit metadata it never reads.
  const data = JSON.stringify(savedSync);
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

afterEach(async () => {
  resetPluginStateStoreForTests();
  await closeOpenClawStateDatabaseAsync();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

it.each(["accountId", "userId"] as const)(
  "selects the requested SQLite identity and preserves unrelated state when %s differs",
  async (field) => {
    const stateDir = await createStateDir();
    const other = path.join(stateDir, "matrix", "accounts", "aa-other");
    const target = path.join(stateDir, "matrix", "accounts", "zz-target");
    await seedSyncStore(other, { metadata: { ...identity, [field]: "other" } });
    await seedSyncStore(target, { cursor: "target-cursor" });
    for (const root of [other, target]) {
      openStore(root, "idb-snapshot").register("sentinel", { preserved: root });
    }
    resetPluginStateStoreForTests();
    await closeOpenClawStateDatabaseAsync();

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

it.each(["accountId", "userId"] as const)(
  "rejects mismatched %s despite stale sidecar identity",
  async (field) => {
    const stateDir = await createStateDir();
    const root = path.join(stateDir, "matrix", "accounts", "other");
    await seedSyncStore(root, {
      metadata: { ...identity, [field]: "other" },
    });
    await writeFile(path.join(root, "storage-meta.json"), JSON.stringify(identity));
    resetPluginStateStoreForTests();
    await closeOpenClawStateDatabaseAsync();
    await expectNoCursor(stateDir);
  },
);

it("finds a boundary-depth cursor after deeper subtrees and skips linked state", async () => {
  const stateDir = await createStateDir();
  const levels = Array.from({ length: 8 }, (_, index) => `d${index}`);
  const target = path.join(stateDir, "zz-target", ...levels);
  const linked = await createStateDir();
  for (const root of [path.join(stateDir, "aa-too-deep", ...levels, "extra"), linked]) {
    await seedSyncStore(root, { cursor: "excluded-cursor" });
  }
  await symlink(linked, path.join(stateDir, "aa-linked"), "junction");
  await seedSyncStore(target, { cursor: "target-cursor" });
  resetPluginStateStoreForTests();
  await closeOpenClawStateDatabaseAsync();
  await expect(waitCursor(stateDir)).resolves.toMatchObject({
    cursor: "target-cursor",
    pathname: path.join(target, "state/openclaw.sqlite"),
  });
});

it("observes only the requested account's completed ingress event", async () => {
  const stateDir = await createStateDir();
  const eventId = "$event";
  const accountId = "sut";
  const queue = createChannelIngressQueueForTests({ channelId: "matrix", accountId, stateDir });
  const otherQueue = createChannelIngressQueueForTests({
    channelId: "matrix",
    accountId: "other",
    stateDir,
  });
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
