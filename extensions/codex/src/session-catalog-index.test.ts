import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import { CodexCatalogCurrency } from "./session-catalog-currency.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectNativeCatalogFixture as projectCodexCatalogPage } from "./session-catalog-projection.test-support.js";
import {
  measureCatalogLists,
  nativeCatalogFixture as fixture,
  writeCatalogRollout,
} from "./session-catalog-resident.test-support.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControl,
  idleThread,
} from "./session-catalog.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resident Codex catalog", () => {
  it("runs due local file scans while a demand-triggered native walk is blocked", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcileFiles = vi.fn(async () => {});
    const reconcileNative = vi.fn(async () => blocked);
    const currency = new CodexCatalogCurrency({
      local: true,
      reconcileFiles,
      reconcileNative,
      report: () => {},
    });
    try {
      currency.start();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(reconcileFiles).toHaveBeenCalledTimes(2);
      const walk = currency.refreshNativeIfDue();
      await vi.waitFor(() => expect(reconcileNative).toHaveBeenCalledExactlyOnceWith(true));
      currency.requestNativeRefresh();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(reconcileFiles).toHaveBeenCalledTimes(3);
      expect(reconcileNative).toHaveBeenCalledTimes(1);
      expect(currency.hasActiveWork()).toBe(true);
      release();
      await walk;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reconcileNative).toHaveBeenNthCalledWith(2, false);
    } finally {
      release();
      await currency.close();
    }
  });

  it("defers full native safety reconciliation until a catalog read after idle", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const recent = Array.from({ length: 64 }, (_, index) =>
      idleThread({
        id: `recent-${index}`,
        source: "cli",
        recencyAt: 100 - index,
      }),
    );
    const missed = idleThread({ id: "missed", source: "cli", recencyAt: 1 });
    let nativeRows = recent;
    const readNative = vi.fn(async (params: CodexThreadListParams) => {
      const offset = Number(params.cursor ?? 0);
      const limit = params.limit ?? 64;
      return projectCodexCatalogPage({
        data: nativeRows.slice(offset, offset + limit),
        nextCursor: offset + limit < nativeRows.length ? String(offset + limit) : null,
      });
    });
    const index = new CodexCatalogIndex({
      homeId: "idle-safety-reconcile",
      readNative,
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      expect(readNative).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(readNative).toHaveBeenCalledTimes(4);

      // A missed native notification changes an older thread beyond an unchanged prefix.
      nativeRows = [...recent, missed];
      readNative.mockRejectedValueOnce(new Error("native unavailable"));
      const page = await index.list({ limit: 100 });
      expect(page.sessions).toHaveLength(64);
      await vi.waitFor(() => expect(readNative).toHaveBeenCalledTimes(5));

      // A failed walk preserves cached rows and does not retry on a busy reader.
      await index.list({ limit: 100 });
      expect(readNative).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(readNative).toHaveBeenCalledTimes(5);

      const stale = await index.list({ limit: 100 });
      expect(stale.sessions).toHaveLength(64);
      await vi.waitFor(() => expect(readNative).toHaveBeenCalledTimes(10));
      const refreshed = await index.list({ limit: 100 });
      expect(refreshed.sessions).toHaveLength(64);
      const tail = await index.list({ limit: 100, cursor: refreshed.nextCursor });
      expect(tail.sessions.map((session) => session.threadId)).toEqual(["missed"]);
      expect(readNative).toHaveBeenCalledTimes(10);
    } finally {
      await index.close();
    }
  });

  it("serves a cached page while a due full native walk is blocked", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const native = idleThread({ id: "cached", source: "cli" });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readNative = vi.fn(async () => {
      if (readNative.mock.calls.length > 1) {
        await blocked;
      }
      return projectCodexCatalogPage({ data: [native] });
    });
    const index = new CodexCatalogIndex({
      homeId: "blocked-safety-reconcile",
      readNative,
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      const page = await index.list({ limit: 1 });
      expect(page.sessions[0]?.threadId).toBe("cached");
      await vi.waitFor(() => expect(readNative).toHaveBeenCalledTimes(2));
    } finally {
      release();
      await index.close();
    }
  });

  it("preserves native sub-second order when exposed timestamps tie", async () => {
    const native = ["alpha", "bravo", "zulu"].map((id) =>
      idleThread({
        id,
        source: "cli",
        originator: "codex_cli_rs",
        recencyAt: id === "zulu" ? 99 : 100,
      }),
    );
    const index = new CodexCatalogIndex({
      homeId: "native-order",
      assertCurrent: () => {},
      readNative: async () => projectCodexCatalogPage({ data: native }),
    });
    try {
      await index.initialize();
      const first = await index.list({ limit: 1 });
      expect(first.sessions[0]?.threadId).toBe("alpha");
      const second = await index.list({ limit: 1, cursor: first.nextCursor });
      expect(second.sessions[0]?.threadId).toBe("bravo");
      expect((await index.list({ limit: 1, cursor: second.backwardsCursor })).sessions).toEqual(
        first.sessions,
      );
      await index.upsertThread({ ...native[2]!, recencyAt: 100 });
      let current = await index.list({ limit: 1 });
      const ids = current.sessions.map((session) => session.threadId);
      while (current.nextCursor) {
        current = await index.list({ limit: 1, cursor: current.nextCursor });
        ids.push(...current.sessions.map((session) => session.threadId));
      }
      expect(ids).toEqual(["zulu", "alpha", "bravo"]);
    } finally {
      await index.close();
    }
  });

  it.each(["removed rows"])("ends a backward page before its anchor after %s", async (change) => {
    const f = fixture(90);
    const control = await f.make();
    const limit = change === "larger limit" ? 20 : 64;
    const first = await control.listPage({ limit });
    const second = await control.listPage({ limit, cursor: first.nextCursor });
    f.fetched.length = 0;
    const removed = change === "removed rows" ? first.sessions.slice(0, 24) : [];
    for (const session of removed) {
      await control.archiveThread(session.threadId);
    }
    const previous = await control.listPage({ limit: 64, cursor: second.backwardsCursor });
    expect(previous.sessions.map((session) => session.threadId)).toEqual(
      first.sessions.slice(removed.length).map((session) => session.threadId),
    );
    expect(f.fetched).toEqual([]);
    expect(
      commandRpcMocks.codexControlRequest.mock.calls.filter((call) => call[1] === "thread/archive"),
    ).toHaveLength(removed.length);
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
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const root = path.join(tempDirs.make("openclaw-resident-currency-"), "sessions");
    const existing = idleThread({ id: "existing", source: "cli", originator: "codex_cli_rs" });
    existing.path = await writeCatalogRollout(root, existing);
    const readNative = vi.fn(async () => projectCodexCatalogPage({ data: [existing] }));
    const index = new CodexCatalogIndex({
      homeId: "currency",
      localSessionsRoot: root,
      readNative,
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      await vi.advanceTimersByTimeAsync(0);
      await index.reconcile();
      const stat = vi.spyOn(fs, "lstat");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(stat).not.toHaveBeenCalled();
      expect(readNative).toHaveBeenCalledOnce();
      const added = await writeCatalogRollout(
        root,
        idleThread({ id: "new-thread", preview: "A new native request" }),
        2 * 1024 * 1024,
      );
      const reads: Array<() => Promise<number[]>> = [];
      const realOpen = fs.open;
      const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        const read = vi.spyOn(handle, "read");
        reads.push(async () =>
          Promise.all(read.mock.results.map(async (result) => (await result.value).bytesRead)),
        );
        return handle;
      });
      const readFile = vi.spyOn(fs, "readFile");
      await vi.advanceTimersByTimeAsync(14 * 60_000 + 30_000);
      await index.reconcile();
      await vi.waitFor(async () => {
        expect((await index.list({})).sessions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              threadId: "new-thread",
              fallbackName: "A new native request",
            }),
            expect.objectContaining({ threadId: "existing" }),
          ]),
        );
      });
      expect(open.mock.calls.map((call) => call[0])).toEqual([added]);
      const bytesRead = (await Promise.all(reads.map((read) => read()))).flat();
      expect(bytesRead.reduce((sum, value) => sum + value, 0)).toBe(256 * 1024);
      expect(readFile).not.toHaveBeenCalled();
      expect(readNative).toHaveBeenCalledTimes(2);
      open.mockClear();
      await index.list({});
      expect(open).not.toHaveBeenCalled();
    } finally {
      await index.close();
    }
  });

  it("does not reread unchanged incomplete rollouts during currency scans", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const root = path.join(tempDirs.make("openclaw-resident-incomplete-"), "sessions");
    const file = await writeCatalogRollout(root, idleThread({ id: "partial" }));
    await fs.writeFile(file, '{"type":"session_meta","payload":');
    const index = new CodexCatalogIndex({
      homeId: "incomplete",
      localSessionsRoot: root,
      readNative: async () => ({ rows: [] }),
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      await vi.advanceTimersByTimeAsync(0);
      await index.reconcile();
      const open = vi.spyOn(fs, "open");
      await index.reconcile();
      expect(open).not.toHaveBeenCalled();
      await writeCatalogRollout(
        root,
        idleThread({ id: "partial", preview: "Completed native request" }),
      );
      await index.reconcile();
      expect(open.mock.calls.map(([opened]) => opened)).toEqual([file]);
      expect((await index.list({})).sessions[0]?.fallbackName).toBe("Completed native request");
    } finally {
      await index.close();
    }
  });

  it("keeps file scans on their own safety cadence through native outages and recovery", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const root = path.join(tempDirs.make("openclaw-catalog-outage-"), "sessions");
    const existing = idleThread({ id: "existing", source: "cli" });
    existing.path = await writeCatalogRollout(root, existing);
    const page = await projectCodexCatalogPage({ data: [existing] });
    const readNative = vi.fn(async () => page);
    const index = new CodexCatalogIndex({
      homeId: "file-scan-outage",
      localSessionsRoot: root,
      readNative,
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      await vi.advanceTimersByTimeAsync(0);
      await index.reconcile();
      readNative.mockRejectedValueOnce(new Error("native unavailable"));
      readNative.mockRejectedValueOnce(new Error("native retry unavailable"));
      const stat = vi.spyOn(fs, "lstat");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
      expect(stat).toHaveBeenCalled();
      expect(readNative).toHaveBeenCalledOnce();
      stat.mockClear();
      await index.upsertThread(existing);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
      expect(readNative).toHaveBeenCalledTimes(2);
      expect(stat).not.toHaveBeenCalled();
      await index.upsertThread(existing);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
      expect(readNative).toHaveBeenCalledTimes(3);
      expect(stat).not.toHaveBeenCalled();

      await writeCatalogRollout(root, idleThread({ id: "external", preview: "External request" }));
      await vi.advanceTimersByTimeAsync(14 * 60_000);
      await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
      expect(stat).toHaveBeenCalled();
      expect(index.get("external")?.preview).toBe("External request");
    } finally {
      await index.close();
    }
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
