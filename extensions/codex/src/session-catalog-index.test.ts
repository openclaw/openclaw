import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import {
  freezeCatalogDirectoryClocks,
  watchWithControlledEvents,
} from "./session-catalog-index.test-support.js";
import { projectNativeCatalogFixture as projectCodexCatalogPage } from "./session-catalog-projection.test-support.js";
import {
  measureCatalogLists,
  nativeCatalogFixture as fixture,
  writeCatalogRollout,
} from "./session-catalog-resident.test-support.js";
import { createCodexSessionCatalogControl, idleThread } from "./session-catalog.test-helpers.js";

const indexes: CodexCatalogIndex[] = [];
const fakeClock = () =>
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
async function initializedIndex(
  homeId: string,
  readNative: ConstructorParameters<typeof CodexCatalogIndex>[0]["readNative"],
  localSessionsRoot?: string,
) {
  const index = new CodexCatalogIndex({
    homeId,
    readNative,
    localSessionsRoot,
    assertCurrent: () => {},
  });
  indexes.push(index);
  await index.initialize();
  return index;
}

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    try {
      await Promise.all(indexes.splice(0).map((index) => index.close()));
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      cleanup();
    }
  });
});

async function advance(index: CodexCatalogIndex, ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
}

const listedIds = async (index: CodexCatalogIndex) =>
  (await index.list({})).sessions.map((session) => session.threadId);

function localRoot() {
  fakeClock();
  return path.join(tempDirs.make("openclaw-catalog-"), "sessions");
}

describe("resident Codex catalog", () => {
  it("does not snapshot resident rows when a local DB-only walk cannot remove them", async () => {
    const root = localRoot();
    const native = idleThread({ id: "local-omission", source: "cli" });
    const readNative = vi.fn(async (_params: CodexThreadListParams) =>
      projectCodexCatalogPage({ data: [native] }),
    );
    const index = await initializedIndex("local-omission", readNative, root);
    await advance(index, 0);
    const resident = index.get(native.id)!;
    const iterate = Map.prototype[Symbol.iterator];
    let residentIterations = 0;
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>,
    ) {
      if (this.get(native.id) === resident) {
        residentIterations++;
      }
      return iterate.call(this);
    });
    readNative.mockImplementation(async () => projectCodexCatalogPage({ data: [] }));
    await advance(index, 15 * 60_000);
    await index.list({});
    await advance(index, 0);
    expect(readNative).toHaveBeenCalledTimes(2);
    expect(readNative.mock.calls[1]?.[0]).toMatchObject({ useStateDbOnly: true });
    expect(await listedIds(index)).toEqual([native.id]);
    expect(index.get(native.id)).toBe(resident);
    expect(residentIterations).toBe(0);
  });

  it("runs due local file scans while a demand-triggered native walk is blocked", async () => {
    const root = localRoot();
    await fs.mkdir(root, { recursive: true });
    const existing = idleThread({ id: "existing", source: "cli", recencyAt: 100 });
    const older = idleThread({ id: "older", source: "cli", recencyAt: 99 });
    const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
    const readNative = vi.fn(async (params: CodexThreadListParams) => {
      if (readNative.mock.calls.length === 3) {
        await blocked;
      }
      return projectCodexCatalogPage({
        data: params.cursor ? [older] : [existing],
        nextCursor: params.cursor ? null : "older-page",
      });
    });
    const index = await initializedIndex("blocked-local-currency", readNative, root);
    try {
      expect(readNative).toHaveBeenCalledTimes(2);
      const stat = vi.spyOn(fs, "lstat");
      await advance(index, 0);
      expect(stat.mock.calls.filter(([file]) => file === root)).toHaveLength(1);

      await advance(index, 15 * 60_000);
      expect(stat.mock.calls.filter(([file]) => file === root)).toHaveLength(2);
      expect(readNative).toHaveBeenCalledTimes(2);
      expect(await listedIds(index)).toEqual(["existing", "older"]);
      await vi.waitFor(() => expect(readNative).toHaveBeenCalledTimes(3));
      expect(readNative.mock.calls[2]?.[0]).toMatchObject({ useStateDbOnly: true });

      await index.upsertThread(existing);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await vi.waitFor(() =>
        expect(stat.mock.calls.filter(([file]) => file === root)).toHaveLength(3),
      );
      expect(readNative).toHaveBeenCalledTimes(3);
      expect(index.hasActiveWork()).toBe(true);
      expect(await listedIds(index)).toEqual(["existing", "older"]);
      expect(readNative).toHaveBeenCalledTimes(3);

      release();
      await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
      expect(readNative).toHaveBeenCalledTimes(4);
      expect(readNative.mock.calls[3]?.[0]).toMatchObject({ cursor: "older-page" });
      await advance(index, 30_000);
      expect(readNative).toHaveBeenCalledTimes(5);
      expect(readNative.mock.calls[4]?.[0]).toMatchObject({ useStateDbOnly: true });
      expect(readNative.mock.calls[4]?.[0].cursor).toBeUndefined();
      expect(stat.mock.calls.filter(([file]) => file === root)).toHaveLength(3);
    } finally {
      release();
      await index.close();
    }
  });

  it("serves cached rows without retrying a failed demand refresh on every read", async () => {
    fakeClock();
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage({ data: [idleThread({ id: "cached", source: "cli" })] }),
    );
    const index = await initializedIndex("failed-demand", readNative);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    readNative.mockRejectedValueOnce(new Error("native unavailable"));
    expect(await listedIds(index)).toEqual(["cached"]);
    await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
    expect(await listedIds(index)).toEqual(["cached"]);
    expect(readNative).toHaveBeenCalledTimes(2);
  });

  it("preserves native ties and promotes a newer observation into the tied group", async () => {
    const native = ["alpha", "bravo", "zulu"].map((id) =>
      idleThread({ id, source: "cli", recencyAt: id === "zulu" ? 99 : 100 }),
    );
    const index = await initializedIndex("native-order", async () =>
      projectCodexCatalogPage({ data: native }),
    );
    expect(await listedIds(index)).toEqual(["alpha", "bravo", "zulu"]);
    await index.upsertThread({ ...native[2]!, recencyAt: 100 });
    expect(await listedIds(index)).toEqual(["zulu", "alpha", "bravo"]);
  });

  it("requests small native pages without losing threads or retaining large previews", async () => {
    const f = fixture(33, 128 * 1024);
    for (const row of f.rows) {
      row.name = null;
    }
    const page = await (await f.make()).listPage({ limit: 100 });
    expect(f.fetched.every((batch) => batch.length <= 16)).toBe(true);
    expect(f.fetched.flat()).toEqual(f.rows.map((row) => row.id));
    expect(page.sessions.every((row) => row.fallbackName?.length === 500)).toBe(true);
    expect(JSON.stringify(page).length).toBeLessThan(64 * 4_096);
  });

  it("reconciles a new rollout with only bounded reads of that file", async () => {
    const { notifyRename } = watchWithControlledEvents("linux");
    freezeCatalogDirectoryClocks();
    const root = localRoot();
    const existing = idleThread({ id: "existing", source: "cli", originator: "codex_cli_rs" });
    existing.path = await writeCatalogRollout(root, existing);
    const readNative = vi.fn(async () => projectCodexCatalogPage({ data: [existing] }));
    const index = await initializedIndex("currency", readNative, root);
    await vi.advanceTimersByTimeAsync(0);
    await index.reconcile();
    const stat = vi.spyOn(fs, "lstat").mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stat).not.toHaveBeenCalled();
    expect(readNative).toHaveBeenCalledOnce();
    const added = await writeCatalogRollout(
      root,
      idleThread({ id: "new-thread", preview: "New request" }),
    );
    // Filesystem completion does not acknowledge the scanner's watcher delivery.
    notifyRename(added);
    const open = vi.spyOn(fs, "open");
    await vi.advanceTimersByTimeAsync(14 * 60_000 + 30_000);
    await index.reconcile();
    await vi.waitFor(async () => {
      const sessions = (await index.list({})).sessions;
      expect(sessions.map((session) => session.threadId).toSorted()).toEqual([
        "existing",
        "new-thread",
      ]);
      expect(sessions.find((session) => session.threadId === "new-thread")?.fallbackName).toBe(
        "New request",
      );
    });
    expect(open.mock.calls.map((call) => call[0])).toEqual([added]);
    expect(readNative).toHaveBeenCalledTimes(2);
    open.mockClear();
    await index.list({});
    expect(open).not.toHaveBeenCalled();
  });

  it("does not reread unchanged incomplete rollouts during currency scans", async () => {
    const root = localRoot();
    const file = await writeCatalogRollout(root, idleThread({ id: "partial" }));
    await fs.writeFile(file, '{"type":"session_meta","payload":');
    const index = await initializedIndex("incomplete", async () => ({ rows: [] }), root);
    await vi.advanceTimersByTimeAsync(0);
    await index.reconcile();
    const open = vi.spyOn(fs, "open");
    await index.reconcile();
    expect(open).not.toHaveBeenCalled();
    await writeCatalogRollout(
      root,
      idleThread({ id: "partial", preview: "Completed native request" }),
    );
    await vi.waitFor(async () => {
      await index.reconcile();
      expect(open.mock.calls.map(([opened]) => opened)).toEqual([file]);
    });
    expect((await index.list({})).sessions[0]?.fallbackName).toBe("Completed native request");
  });

  it("keeps file scans on their own safety cadence through native outages and recovery", async () => {
    const root = localRoot();
    const existing = idleThread({ id: "existing", source: "cli" });
    existing.path = await writeCatalogRollout(root, existing);
    const page = await projectCodexCatalogPage({ data: [existing] });
    const readNative = vi.fn(async () => page);
    const index = await initializedIndex("file-scan-outage", readNative, root);
    await vi.advanceTimersByTimeAsync(0);
    await index.reconcile();
    readNative.mockRejectedValueOnce(new Error("native unavailable"));
    readNative.mockRejectedValueOnce(new Error("native retry unavailable"));
    const stat = vi.spyOn(fs, "lstat");
    await advance(index, 15 * 60_000);
    expect(stat).toHaveBeenCalled();
    expect(readNative).toHaveBeenCalledOnce();
    stat.mockClear();
    for (const calls of [2, 3]) {
      await index.upsertThread(existing);
      await advance(index, 30_000);
      expect(readNative).toHaveBeenCalledTimes(calls);
      expect(stat).not.toHaveBeenCalled();
    }

    await writeCatalogRollout(root, idleThread({ id: "external", preview: "External request" }));
    await advance(index, 14 * 60_000);
    expect(stat).toHaveBeenCalled();
    expect(index.get("external")?.preview).toBe("External request");
  });

  it("rejects malformed cursors before native reads", async () => {
    const f = fixture();
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => undefined,
    });
    await expect(control.listPage({ cursor: "x".repeat(4097), limit: 100 })).rejects.toThrow(
      /cursor/,
    );
    expect(f.fetched).toEqual([]);
  });

  it("serves 100 warm 3,000-thread queries within the resident latency budget", async () => {
    const f = fixture(3_000, 512);
    const metrics = await measureCatalogLists(await f.make(), f.expire);
    console.info("resident catalog fixture", JSON.stringify(metrics));
    expect(metrics.threadListCalls).toBe(0);
    expect(metrics.p50Ms).toBeLessThan(20);
  });
});
