import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexThread } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import type { CodexCatalogIndexOptions } from "./session-catalog-index-contract.js";
import { CodexCatalogPersistence, type CodexCatalogState } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { completeCatalogState } from "./session-catalog-index.test-support.js";
import { CodexCatalogProjections } from "./session-catalog-projection.js";
import { projectNativeCatalogFixture as projectCodexCatalogPage } from "./session-catalog-projection.test-support.js";
import { writeCatalogRollout } from "./session-catalog-resident.test-support.js";
import { idleThread } from "./session-catalog.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const indexes: CodexCatalogIndex[] = [];
afterEach(async () => {
  for (const index of indexes.splice(0)) {
    await index.close();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const project = (data: CodexThread[]) => projectCodexCatalogPage({ data });
const firstSession = async (index: CodexCatalogIndex) => (await index.list({})).sessions[0];
const ids = async (index: CodexCatalogIndex) =>
  (await index.list({})).sessions.map((row) => row.threadId);

function catalog(
  root: string,
  readNative: CodexCatalogIndexOptions["readNative"],
  options: { homeId?: string; local?: boolean; state?: CodexCatalogState } = {},
) {
  const index = new CodexCatalogIndex({
    homeId: options.homeId ?? root,
    ...(options.local === false ? {} : { localSessionsRoot: root }),
    state: options.state,
    readNative,
    assertCurrent: () => {},
  });
  indexes.push(index);
  return index;
}

async function rollout(id: string, fields: Partial<CodexThread> = {}) {
  const home = tempDirs.make(`codex-resident-${id}-`);
  const root = path.join(home, "sessions");
  const original = idleThread({ id, source: "cli", ...fields });
  const file = await writeCatalogRollout(root, original);
  original.path = file;
  return { home, root, file, original };
}

async function provisional(id: string, fields: Partial<CodexThread> = {}) {
  const value = await rollout(id, {
    cwd: "/workspace/original",
    originator: "codex_cli_rs",
    ...fields,
  });
  const readNative = vi.fn(async () => project([]));
  return { ...value, readNative };
}

async function compress(file: string) {
  const compressed = `${file}.zst`;
  await fs.writeFile(compressed, zstdCompressSync(await fs.readFile(file)));
  await fs.unlink(file);
  return compressed;
}

it("serves a remote restart snapshot immediately and reconciles offline changes in the background", async () => {
  const original = idleThread({ id: "archived-while-offline", source: "cli" });
  const replacement = idleThread({ id: "created-while-offline", source: "cli" });
  const saved = await project([original]);
  const state = completeCatalogState([saved.rows[0]!]);
  const native = createDeferred<void>();
  const readNative = vi.fn(async () => {
    await native.promise;
    return project([replacement]);
  });
  const index = catalog("remote-restart", readNative, { state, local: false });
  try {
    expect(await ids(index)).toEqual([original.id]);
    expect(readNative).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(readNative).toHaveBeenCalledOnce());
    native.resolve();
    await vi.waitFor(async () => {
      expect(await ids(index)).toEqual([replacement.id]);
    });
    expect(readNative).toHaveBeenCalledOnce();
  } finally {
    native.resolve();
  }
});

it.each([false, true])(
  "removes compressed rollouts archived during hydration: %s",
  async (duringHydration) => {
    const { root, file, original } = await rollout(
      "compressed",
      duringHydration ? { originator: "codex_cli_rs" } : {},
    );
    const physicalPath = await compress(file);
    const readNative = vi.fn(async () => {
      const projected = await project([original]);
      // Delete after the hydration stat snapshot, before any currency read.
      if (duringHydration) {
        await fs.unlink(physicalPath);
      }
      return projected;
    });
    const index = catalog(root, readNative);
    await index.initialize();
    await index.reconcile();
    if (!duringHydration) {
      await index.upsertThread({ ...original, name: "Updated native title" });
      await index.reconcile();
      expect((await firstSession(index))?.name).toBe("Updated native title");
      await fs.unlink(physicalPath);
      await index.reconcile();
    }
    expect((await index.list({})).sessions).toEqual([]);
    expect(readNative).toHaveBeenCalledOnce();
  },
);

it("publishes changed provisional rollout metadata alongside a concurrent native rename", async () => {
  const { home, root, file, original, readNative } = await provisional("changing-thread");
  const startOptions: CodexAppServerStartOptions = {
    transport: "stdio",
    command: "codex",
    args: ["app-server"],
    env: { CODEX_HOME: home },
    homeScope: "user",
    headers: {},
  };
  const homeId = await codexCatalogResidentHomeKey({ startOptions });
  const index = catalog(root, readNative, { homeId });
  const harness = createClientHarness();
  const opened = createDeferred<void>();
  const readAllowed = createDeferred<void>();
  try {
    await index.initialize();
    await index.reconcile();
    readNative.mockClear();
    await observeCodexCatalogClient(harness.client, { startOptions });
    const realOpen = fs.open;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === file) {
        opened.resolve();
        await readAllowed.promise;
      }
      return handle;
    });
    await writeCatalogRollout(root, { ...original, cwd: "/workspace/changed" });
    // Exercise metadata authority independently of asynchronous watcher delivery.
    const changedAt = new Date("2030-01-01T00:00:00.000Z");
    await fs.utimes(path.dirname(file), changedAt, changedAt);
    const reconciling = index.reconcile();
    await opened.promise;
    harness.send({
      method: "thread/name/updated",
      params: { threadId: original.id, threadName: "New native title" },
    });
    readAllowed.resolve();
    await reconciling;
    const renamed = { name: "New native title", cwd: "/workspace/changed" };
    expect(await firstSession(index)).toMatchObject(renamed);
    await index.reconcile();
    expect(await firstSession(index)).toMatchObject(renamed);
    expect(open.mock.calls.filter(([value]) => value === file)).toHaveLength(1);
    expect(harness.writes).toEqual([]);
    expect(readNative).not.toHaveBeenCalled();
  } finally {
    readAllowed.resolve();
    await harness.client.closeAndWait();
  }
});

it("retries a failed rollout read after access recovers without a fingerprint change", async () => {
  const { root, file, original, readNative } = await provisional("unreadable-thread");
  const index = catalog(root, readNative);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  await index.initialize();
  // Drain the startup scan before changing the rollout and arranging its read failure.
  await vi.advanceTimersByTimeAsync(0);
  await index.reconcile();
  await writeCatalogRollout(root, { ...original, cwd: "/workspace/changed" });
  const changed = await fs.stat(file);
  const realOpen = fs.open;
  let readable = false;
  const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (args[0] === file && !readable) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return realOpen(...args);
  });
  await expect(index.reconcile()).resolves.toBeUndefined();
  expect(open.mock.calls.some(([candidate]) => candidate === file)).toBe(true);
  expect((await firstSession(index))?.cwd).toBe("/workspace/original");
  readable = true;
  await index.reconcile();
  expect((await firstSession(index))?.cwd).toBe("/workspace/changed");
  expect(await fs.stat(file)).toMatchObject({ mtimeMs: changed.mtimeMs, size: changed.size });
  expect(readNative).toHaveBeenCalledOnce();
});

it.each(["covered", "flat", "outside"])(
  "verifies missing unfingerprinted native rollouts only in %s scan layout",
  async (layout) => {
    const home = tempDirs.make("codex-resident-missing-new-rollout-");
    const root = path.join(home, "sessions");
    await fs.mkdir(root);
    const original = idleThread({
      id: "created-after-scan",
      source: "cli",
      originator: "codex_cli_rs",
    });
    const readNative = vi.fn(async () => {
      const written = await writeCatalogRollout(
        layout === "outside" ? path.join(home, "other") : root,
        original,
      );
      const file = layout === "flat" ? path.join(root, path.basename(written)) : written;
      if (file !== written) {
        await fs.rename(written, file);
      }
      original.path = file;
      const projected = await project([original]);
      await fs.unlink(file);
      return projected;
    });
    const index = catalog(root, readNative);
    await index.initialize();
    await index.reconcile();
    expect(await ids(index)).toEqual(layout === "covered" ? [] : [original.id]);
    expect(readNative).toHaveBeenCalledOnce();
  },
);

it("retains a known preview when a bounded rollout read cannot reach the first user message", async () => {
  const preview = "A durable searchable preview from the first user request";
  const { root, file, original, readNative } = await provisional("bounded-preview", {
    cwd: "/workspace/project",
    name: null,
    preview,
  });
  const index = catalog(root, readNative);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  await index.initialize();
  const initialScan = index.reconcile();
  await vi.advanceTimersByTimeAsync(0);
  await initialScan;
  const readCalls: Array<() => Promise<number[]>> = [];
  const realOpen = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (args[0] === file) {
      const read = vi.spyOn(handle, "read");
      readCalls.push(async () =>
        Promise.all(
          read.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value.then((value) => value.bytesRead)] : [],
          ),
        ),
      );
    }
    return handle;
  });
  const timestamp = "2026-09-16T12:00:00.000Z";
  const record = (type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload });
  const replacement = `${file}.pending`;
  await fs.writeFile(
    replacement,
    [
      record("session_meta", {
        id: original.id,
        timestamp,
        cwd: "/workspace/changed",
        source: "cli",
        originator: "codex_cli_rs",
      }),
      record("response_item", {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "x".repeat(512 * 1024) }],
      }),
      record("event_msg", { type: "user_message", message: preview }),
      "",
    ].join("\n"),
  );
  await fs.rename(replacement, file);
  await index.reconcile();
  expect(await firstSession(index)).toMatchObject({
    threadId: original.id,
    cwd: "/workspace/changed",
    fallbackName: preview,
  });
  expect(
    (await index.list({ searchTerm: "durable searchable preview" })).sessions.map(
      (session) => session.threadId,
    ),
  ).toEqual([original.id]);
  const reads = (await Promise.all(readCalls.map((calls) => calls()))).flat();
  expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBe(256 * 1024);
  expect(Math.max(...reads)).toBeLessThanOrEqual(128 * 1024);
  expect(readNative).toHaveBeenCalledOnce();
});
it("settles admitted projections and restores capacity after rejecting overflow", async () => {
  const projections = new CodexCatalogProjections();
  const gate = createDeferred<void>();
  const admitted = Array.from({ length: 20_000 }, () => projections.run(() => gate.promise));
  const overflow = vi.fn(async () => {});
  await expect(projections.run(overflow)).rejects.toThrow("resident row limit");
  expect(overflow).not.toHaveBeenCalled();
  gate.resolve();
  await Promise.all(admitted);
  await expect(projections.run(overflow)).resolves.toBeUndefined();
  expect(overflow).toHaveBeenCalledOnce();
});

it("rejects oversized notification rollout paths before retaining a catalog row", async () => {
  const thread = idleThread({
    id: "oversized-path",
    path: "/" + "p".repeat(4096),
    source: "cli",
  });
  const index = catalog("oversized-notification-path", async () => ({ rows: [] }), {
    local: false,
  });
  await expect(index.upsertThread(thread)).rejects.toThrow("rollout path");
});

it("invalidates an overflowing persistence backlog without dropping admitted writes", async () => {
  const gate = createDeferred<void>();
  const started = createDeferred<void>();
  const deleted: string[] = [];
  const state: CodexCatalogState = {
    entries: async () => [],
    register: async () => {},
    delete: async (key) => {
      started.resolve();
      await gate.promise;
      deleted.push(key);
      return true;
    },
  };
  const report = vi.fn();
  const persistence = new CodexCatalogPersistence(state, report);
  persistence.remove("in-flight");
  await started.promise;
  for (let i = 0; i < 20_002; i++) {
    persistence.remove(`pending-${i}`);
  }
  gate.resolve();
  await persistence.retire();
  expect(deleted).toHaveLength(20_002);
  const key = (id: string) => `thread:${createHash("sha256").update(id).digest("hex")}`;
  expect(deleted).toEqual(
    expect.arrayContaining(["complete", key("in-flight"), key("pending-0"), key("pending-19999")]),
  );
  expect(deleted).not.toContain(key("pending-20000"));
  expect(deleted).not.toContain(key("pending-20001"));
  expect(report).toHaveBeenCalledOnce();
});
